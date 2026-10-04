// UI + sync orchestration. Wires together dropbox.js and crypto.js.

const LS_KEY_CACHE = "shared_todo_key_cache";
const LS_ACTIVE_BOARD = "shared_todo_active_board"; // last-viewed board id, per device
const LEGACY_TODO_PATH = "/todos.json"; // pre-multi-board data file, migrated into the manifest on first run

// Per-device identity, used later for task assignment. Generated silently on
// first run — no onboarding prompt — so it costs zero friction; a display
// name is opt-in via Settings. Since every device shares one Dropbox
// account/app folder (see docs/spec.md), this id is really "this device",
// not "this person" — the same person on two devices gets two ids. Fine for
// now; can be reconciled later if it matters.
const LS_DEVICE_ID = "shared_todo_device_id";
function ensureDeviceId() {
  let id = localStorage.getItem(LS_DEVICE_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_DEVICE_ID, id);
  }
  return id;
}
const deviceId = ensureDeviceId();

let cryptoKey = null;   // CryptoKey, derived from the passphrase
let boards = [];        // [{ id, label, icon, file }], from the decrypted manifest
let users = [];         // [{ id, name, created_at }], from the decrypted manifest — one entry per device seen
let manifestUpdatedAt = null;
let currentBoard = null; // the board object currently shown
let todos = [];         // in-memory list, includes any not-yet-synced optimistic edits
let loadedUpdatedAt = null; // updated_at of the version we last read from Dropbox
let pendingOps = []; // serializable edit ops applied locally but not yet confirmed on Dropbox (see applyOp)
let syncChain = Promise.resolve(); // serializes background syncs so edits don't race

// Queue is namespaced per board so switching tabs never mixes up two
// boards' unsynced edits.
function queueKey(boardId) {
  return "shared_todo_pending_queue_" + boardId;
}

// Mirrors `todos`/`loadedUpdatedAt`/`pendingOps` into localStorage on every
// edit so an unsynced queue survives the JS process being killed — e.g.
// Android reclaiming a backgrounded PWA tab while offline. Without this, a
// killed-and-reopened app has no memory of pending edits and silently
// overwrites them with a fresh remote fetch on the next load (see
// loadAndRender), which looks like "my offline edits got wiped" even though
// there was no real conflict.
function persistQueue() {
  try {
    localStorage.setItem(queueKey(currentBoard.id), JSON.stringify({ todos, loadedUpdatedAt, pendingOps }));
  } catch (err) {
    console.error(err); // storage full/unavailable — queue just won't survive a reload, not fatal
  }
}

function loadPersistedQueue(boardId) {
  try {
    const raw = localStorage.getItem(queueKey(boardId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

function clearPersistedQueue(boardId) {
  localStorage.removeItem(queueKey(boardId));
}
const assigningIds = new Set(); // todo/sub-todo IDs whose assignee-picker panel is open (local UI state, not synced; opened by swipe-right; ids are UUIDs so one Set covers both levels)
const shownChildrenIds = new Set(); // top-level todo IDs whose sub-todo list + add-sub-todo form is shown (local UI state, not synced)
const searchQueries = new Map(); // board id -> what is typed in the search bar for it (local UI state, not synced or persisted)
const subAddMode = new Map(); // top-level todo ID -> what its add-sub-item form adds, "note" or "counter"; absent means "todo" (local UI state, not synced)

const el = (id) => document.getElementById(id);

const screens = {
  connect: el("screen-connect"),
  passphrase: el("screen-passphrase"),
  loading: el("screen-loading"),
};

function showScreen(name) {
  for (const key in screens) screens[key].hidden = key !== name;
  const isList = name === "list";
  el("todoList").hidden = !isList;
  el("emptyState").hidden = true; // render() decides whether to show this
  el("addForm").hidden = !isList || searchTerms().length > 0;
  el("searchBar").hidden = !isList;
  el("syncStatus").hidden = !isList;
  el("refreshBtn").hidden = !isList;
  el("settingsBtn").hidden = !isList;
  el("tabBar").hidden = !isList;
}

// "system" | "light" | "dark", persisted per device (not synced — it's a
// display preference, not list data). The initial paint is handled by an
// inline script in index.html's <head> (before app.js even loads) so a
// stored "dark" doesn't flash light first; this just keeps it in sync after
// that and on user changes.
const LS_THEME = "shared_todo_theme";

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const isDark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  el("themeColorMeta").setAttribute("content", isDark ? "#3a1d47" : "#8e24aa");
}

function setTheme(theme) {
  localStorage.setItem(LS_THEME, theme);
  applyTheme(theme);
}

// `action` (optional): { label, onClick } — renders an inline button in the
// toast, used for the delete-undo affordance. Left plain for simple messages.
function toast(message, action) {
  const t = el("toast");
  t.innerHTML = "";
  t.appendChild(document.createTextNode(message));
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.onclick = () => { action.onClick(); t.classList.remove("show"); };
    t.appendChild(btn);
  }
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), action ? 5000 : 2800);
}

function updateSyncStatus(date) {
  const text = "Last synced " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  el("syncStatus").textContent = text;
  el("settingsSyncTime").textContent = date.toLocaleString([], { hour12: false });
}

// Reflects the current sync/queue state in the sync line (spinner while
// syncing, error state with retry hint while a pending edit can't reach
// Dropbox — e.g. offline).
function setSyncState(state) {
  const status = el("syncStatus");
  if (state === "syncing") {
    status.innerHTML = '<span class="spinner-sm"></span> Syncing...';
    status.style.color = "";
  } else if (state === "error") {
    status.textContent = "Not synced — tap ↻ to retry";
    status.style.color = "var(--danger)";
  } else {
    status.style.color = "";
    updateSyncStatus(new Date());
  }
}

// --- Display ordering ------------------------------------------------
//
// The `todos` array order is the stored order (drag-to-reorder mutates it
// directly via the "reorder" op). On top of that a board can opt into one
// or both sorting options from its settings page; those are *display only*
// and never rewrite the array, so turning them back off restores the
// manual order exactly. They live in the manifest, next to the board's
// label and icon, so the choice is shared by everyone on the passphrase.

function boardSortFlags() {
  // saveManifest replaces `boards` wholesale after every write, which can
  // leave `currentBoard` pointing at a superseded object — look the live
  // one up by id and fall back only if it has gone (mid-delete).
  const board = (currentBoard && boards.find((b) => b.id === currentBoard.id)) || currentBoard;
  return {
    pendingFirst: !!(board && board.sort_pending_first),
    dueFirst: !!(board && board.sort_due_first),
  };
}

function sortActive() {
  const f = boardSortFlags();
  return f.pendingFirst || f.dueFirst;
}

// Comparable "YYYY-MM-DDTHH:MM" string, or null for no deadline. A
// top-level item with no due date of its own borrows its earliest child's,
// matching the inherited badge the row already shows — otherwise a parent
// whose only deadline lives on a sub-item would sort to the bottom while
// displaying an urgent date.
function deadlineKey(entity, isSub) {
  let e = entity;
  if (!isSub && !e.due_date) e = earliestChildDeadline(entity) || entity;
  if (!e.due_date) return null;
  return e.due_date + "T" + (e.due_time || "00:00");
}

// Returns `entities` untouched when no sorting is on, so the common case
// allocates nothing. Array#sort is stable, so items that tie on every
// active criterion keep their manual order. Notes have no `done`, which
// makes them sort with the unfinished items — they're never "done", so
// sinking them with the checked-off ones would be wrong.
function sortedForDisplay(entities, isSub) {
  const f = boardSortFlags();
  if (!f.pendingFirst && !f.dueFirst) return entities;
  return entities.slice().sort((a, b) => compareForDisplay(a, b, f, isSub));
}

// The comparison sortedForDisplay sorts by, split out so storedDropIndex can
// ask the same question the sort asks: a 0 here means the two items tie on
// every active criterion, i.e. they sit in the same block of the displayed
// list and their relative order is decided purely by manual rank.
function compareForDisplay(a, b, f, isSub) {
  if (f.pendingFirst) {
    const diff = (a.done ? 1 : 0) - (b.done ? 1 : 0);
    if (diff !== 0) return diff;
    // Within the completed block, most recently checked first — so
    // ticking something moves it just past the last unfinished item
    // rather than all the way to the bottom of the list, where the user
    // can't see what they just did. Items completed before this field
    // existed (or by an older client) have no `done_at` and sort below
    // the ones that do, keeping their relative order.
    if (a.done) {
      if (a.done_at && b.done_at) { if (a.done_at !== b.done_at) return a.done_at < b.done_at ? 1 : -1; }
      else if (a.done_at) return -1;
      else if (b.done_at) return 1;
    }
  }
  if (f.dueFirst) {
    const ak = deadlineKey(a, isSub);
    const bk = deadlineKey(b, isSub);
    if (ak !== bk) {
      if (ak === null) return 1;
      if (bk === null) return -1;
      return ak < bk ? -1 : 1;
    }
  }
  return 0;
}

// Translates a drop position from displayed order into an index in the
// stored array. attachDragReorder reports `displayToIndex` as an index into
// the rendered sibling order, counted after the dragged item is removed —
// which is the stored order exactly while nothing is sorting the display, so
// with no sort on this passes straight through.
//
// With a sort on the two orders differ, and a sort is display-only (see
// sortedForDisplay: render() sorts a copy, the stored array stays in manual
// order, so switching a sort off restores it). Writing the display index
// straight into the stored array would scramble that manual order, so
// instead the item is re-ranked *relative to the neighbour it was dropped
// against*, leaving every other item's rank untouched.
//
// Which neighbour: the one the item now ties with under the active sort,
// preferring the row above. The tie matters — a neighbour in a different
// block (a dated row among undated ones, say) is displayed nowhere near its
// own manual rank, so anchoring to it would move the item somewhere the drop
// never pointed at. Since the sort is stable and returns 0 on a tie, ranking
// against a tied neighbour reproduces exactly the drop the user made.
//
// A drop where neither neighbour ties is a move between blocks: the rank
// still changes, but the sort outranks it on the next render, so the row
// springs back — unavoidable while the sort is the outer criterion.
//
// A search hides items as well, so `displayed` is the siblings as actually
// drawn, sorted and filtered. With a search and no sort every item ties, so
// the drop lands right after the row it was dropped below (or before the
// one it was dropped above), and the hidden items keep their places.
function storedDropIndex(entities, displayed, id, displayToIndex, isSub) {
  if (!sortActive() && searchTerms().length === 0) return displayToIndex;
  const f = boardSortFlags();
  const dragged = entities.find((e) => e.id === id);
  const stored = entities.filter((e) => e.id !== id);
  const display = displayed.filter((e) => e.id !== id);
  if (!dragged || display.length === 0) return 0;
  const clamped = Math.max(0, Math.min(displayToIndex, display.length));
  const above = clamped > 0 ? display[clamped - 1] : null;
  const below = clamped < display.length ? display[clamped] : null;
  const ties = (other) => other && compareForDisplay(dragged, other, f, isSub) === 0;
  // Math.max guards the case where a background sync swapped the array out
  // from under the drag and the anchor is gone: fall back to the top rather
  // than handing applyOp a negative index.
  const indexOf = (other) => Math.max(0, stored.findIndex((e) => e.id === other.id));
  if (ties(above)) return indexOf(above) + 1;
  if (ties(below)) return indexOf(below);
  if (above) return indexOf(above) + 1;
  return indexOf(below);
}

// --- Search ----------------------------------------------------------
//
// Per board, in memory only: the bottom bar filters the open list to the
// items whose text (icon included) holds every typed word, ignoring case
// and accents. A parent is kept when it or any of its sub-items matches;
// when sub-items match, it is drawn open with only those. The add rows are
// hidden while a search is on, since an item added there that didn't match
// would vanish the moment it was added.
function searchQuery() {
  return (currentBoard && searchQueries.get(currentBoard.id)) || "";
}

function normalizeForSearch(text) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function searchTerms() {
  return normalizeForSearch(searchQuery()).split(/\s+/).filter(Boolean);
}

function entityMatches(entity, terms) {
  const hay = normalizeForSearch(textWithIcon(entity));
  return terms.every((t) => hay.includes(t));
}

// The sub-items a search leaves on show under `todo`, or null when the
// search doesn't reach into them (no search, or no sub-item matches).
function matchingChildren(todo, terms) {
  if (terms.length === 0) return null;
  const hits = (todo.children || []).filter((c) => entityMatches(c, terms));
  return hits.length > 0 ? hits : null;
}

// The top-level items as drawn: sorted, then filtered by the search.
function displayedTodos() {
  const terms = searchTerms();
  const shown = sortedForDisplay(todos, false);
  if (terms.length === 0) return shown;
  return shown.filter((t) => entityMatches(t, terms) || matchingChildren(t, terms));
}

// The sub-items of `todo` as drawn: sorted, then cut to the matches when
// the search reaches into them.
function displayedChildren(todo) {
  const shown = sortedForDisplay(todo.children || [], true);
  const hits = matchingChildren(todo, searchTerms());
  return hits ? shown.filter((c) => hits.includes(c)) : shown;
}

function setSearch(value) {
  if (!currentBoard) return;
  if (value) searchQueries.set(currentBoard.id, value); else searchQueries.delete(currentBoard.id);
  el("searchInput").value = value;
  el("searchClearBtn").hidden = !value;
  render();
}

function render() {
  const list = el("todoList");
  list.innerHTML = "";
  const shown = displayedTodos();
  for (const todo of shown) list.appendChild(renderTodoItem(todo));
  el("todoList").hidden = false;
  const searching = searchTerms().length > 0;
  el("addForm").hidden = searching;
  el("emptyState").textContent = todos.length === 0
    ? "Nothing here yet. Add one below."
    : "No matches for “" + searchQuery().trim() + "”.";
  el("emptyState").hidden = shown.length !== 0;
}

function formatDuration(mins) {
  if (mins < 60) return mins + "m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? h + "h" : h + "h" + m + "m";
}

// Pure: maps a "YYYY-MM-DD" due date (+ optional "HH:MM" due time) to a
// display label + CSS class. Day-level comparisons are timezone-stable (no
// time component); when the due date is today AND a due time is set, shows
// a countdown/overdue-by in hours+minutes instead of just "Today" — an
// all-day due date (no time) has no specific moment to count down to, so it
// keeps showing "Today" plain.
function daysLeftLabel(dueDateStr, dueTimeStr) {
  const now = new Date();
  const todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
  const oneDay = 86400000;
  const dToday = new Date(todayStr + "T00:00:00");
  const dDue = new Date(dueDateStr + "T00:00:00");
  const diffDays = Math.round((dDue - dToday) / oneDay);

  if (diffDays === 0 && dueTimeStr) {
    const dueMoment = new Date(dueDateStr + "T" + dueTimeStr + ":00");
    const diffMinutes = Math.round((dueMoment - now) / 60000);
    if (diffMinutes >= 0) return { text: formatDuration(diffMinutes), cls: "today" };
    return { text: "-" + formatDuration(-diffMinutes), cls: "overdue" };
  }
  if (diffDays === 0) return { text: "Today", cls: "today" };
  if (diffDays < 0) return { text: diffDays + "d", cls: "overdue" };
  return { text: diffDays + "d", cls: "" };
}

// An emoji typed at the start of an item's text ("📌 Item text") is split off
// into the item's `icon` field instead of staying in the text. The phone's
// own emoji keyboard is the picker, which is deliberate: no emoji palette
// ships in the app shell, so the public deploy mirror still reveals nothing
// about what any board is used for (see docs/spec.md §4a).
//
// `icon` is stored as {type, value} rather than a bare string so a future
// custom-image icon can slot in as {type: "image", value: <path>} without
// migrating already-encrypted board files on both devices.
const LEADING_EMOJI_RE = /^(\p{Regional_Indicator}\p{Regional_Indicator}|\p{Extended_Pictographic}(\uFE0F|\p{Emoji_Modifier})*(\u200D\p{Extended_Pictographic}(\uFE0F|\p{Emoji_Modifier})*)*)\s*/u;

// Returns {icon, text} for a raw string typed into any add/edit field.
// `icon` is null when there's no leading emoji to take.
function splitLeadingIcon(raw) {
  const trimmed = (raw || "").trim();
  const m = trimmed.match(LEADING_EMOJI_RE);
  if (!m) return { icon: null, text: trimmed };
  const rest = trimmed.slice(m[0].length).trim();
  // An item that is *nothing but* an emoji keeps it as its text — promoting
  // it to the icon would leave a labelless, unreadable row.
  if (!rest) return { icon: null, text: trimmed };
  return { icon: { type: "emoji", value: m[1] }, text: rest };
}

// Inverse of splitLeadingIcon, for prefilling an edit form: the icon comes
// back as part of the text so it can be changed or removed with the same
// keyboard that set it, with no extra field in the form.
function textWithIcon(entity) {
  return entity.icon && entity.icon.type === "emoji"
    ? entity.icon.value + " " + entity.text
    : entity.text;
}

// Parses one pasted line back into an item. This is the exact inverse of
// markdownLine() below, so anything the Copy button produces can be pasted
// straight back in — a plain "📌 Item text" list is just the case where every
// optional part is absent.
function parseImportLine(line) {
  let rest = line.trim();
  let done = false;

  const box = rest.match(/^-\s*\[([ xX])\]\s*/);
  if (box) {
    done = box[1].toLowerCase() === "x";
    rest = rest.slice(box[0].length);
  }

  let due_date = null;
  let due_time = null;
  const due = rest.match(/\s+@(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?$/);
  if (due) {
    due_date = due[1];
    due_time = due[2] || null;
    rest = rest.slice(0, due.index);
  }

  const { icon, text } = splitLeadingIcon(rest);
  return { text, icon, done, due_date, due_time };
}

// Turns a multi-line paste into a single "addMany" op. One op, not one per
// line: pendingOps is flushed with a read-check-write Dropbox round trip per
// op (see syncPending), so 30 separate adds would mean 30 serialized
// download+upload cycles instead of one.
function bulkAdd(lines, mode) {
  const parsed = lines.map(parseImportLine).filter((p) => p.text);
  if (parsed.length === 0) return;

  // Case-insensitive, against top-level items only — re-pasting an edited
  // list should top it up, not duplicate it.
  const existing = new Set(todos.map((t) => t.text.trim().toLowerCase()));
  const fresh = parsed.filter((p) => !existing.has(p.text.toLowerCase()));
  const skipped = parsed.length - fresh.length;

  if (fresh.length === 0) {
    toast("All " + parsed.length + " already on this list.");
    return;
  }

  const boardName = currentBoard ? currentBoard.label : "this list";
  const question = "Add " + fresh.length + " items to " + boardName + "?" +
    (skipped > 0 ? "\n\n(" + skipped + " already on the list will be skipped.)" : "");
  if (!confirm(question)) return;

  // uuids/timestamps are generated up front so the op stays plain JSON and
  // survives persistQueue()/loadPersistedQueue() and a later replay.
  const now = new Date().toISOString();
  const todosToAdd = fresh.map((p) => {
    const item = newEntity(mode, p.text, now);
    if (mode === "todo") item.done = p.done;
    if (p.icon) item.icon = p.icon;
    if (mode === "todo" && p.due_date) {
      item.due_date = p.due_date;
      if (p.due_time) item.due_time = p.due_time;
    }
    return item;
  });

  applyEdit({ type: "addMany", todos: todosToAdd });
  const ids = todosToAdd.map((t) => t.id);
  toast("Added " + todosToAdd.length + " items.", {
    label: "Undo",
    onClick: () => applyEdit({ type: "removeIds", ids }),
  });
}

function renderDaysBadge(entity) {
  if (!entity.due_date) return null;
  const { text, cls } = daysLeftLabel(entity.due_date, entity.due_time);
  const span = document.createElement("span");
  // Done items keep showing their date but drop the today/overdue urgency
  // styling — a checked-off item being "overdue" isn't meaningful.
  span.className = "todo-days" + (cls && !entity.done ? " " + cls : "");
  span.textContent = text;
  return span;
}

// A top-level item with no due_date of its own borrows the closest upcoming
// deadline among its still-open sub-items (notes and done sub-items don't
// count), so it shows *some* urgency in the list without the user having to
// open every parent to see what's due soon.
function earliestChildDeadline(entity) {
  const candidates = (entity.children || []).filter((c) => c.type !== "note" && !c.done && c.due_date);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => {
    const key = c.due_date + "T" + (c.due_time || "00:00");
    const bestKey = best.due_date + "T" + (best.due_time || "00:00");
    return key < bestKey ? c : best;
  });
}

// --- Counters --------------------------------------------------------
//
// A counter is `{ type: "counter", text, presses, display }`: its + button
// records one ISO timestamp per press, kept sorted oldest first (ISO strings
// sort chronologically), and `display` picks what the row shows of them. It
// has no `done` and never any children of its own, but can be a sub-item.
const COUNTER_DISPLAYS = [
  ["count", "Count"],
  ["since", "Days since last"],
  ["average", "Average between"],
];

function isCounter(entity) {
  return entity.type === "counter";
}

function localDayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// What the row shows, per `display`. Days since is counted in calendar
// days, as the deadline badge is, so a press late last night is "1d ago"
// this morning. The average is over the gaps between presses,
// (last - first) / (presses - 1), so it needs two of them.
function counterValue(entity) {
  const presses = entity.presses || [];
  if (entity.display === "since") {
    if (presses.length === 0) return "—";
    const last = new Date(presses[presses.length - 1]);
    const days = Math.round((localDayStart(new Date()) - localDayStart(last)) / 86400000);
    return days === 0 ? "Today" : days + "d ago";
  }
  if (entity.display === "average") {
    if (presses.length < 2) return "—";
    const mins = (new Date(presses[presses.length - 1]) - new Date(presses[0])) / (presses.length - 1) / 60000;
    if (mins < 1440) return "every " + formatDuration(Math.round(mins));
    return "every " + (mins / 1440).toFixed(1).replace(/\.0$/, "") + "d";
  }
  return String(presses.length);
}

const TRASH_BIN_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';
const PERSON_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
const DRAG_HANDLE_SVG = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.5"></circle><circle cx="15" cy="6" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="9" cy="18" r="1.5"></circle><circle cx="15" cy="18" r="1.5"></circle></svg>';

// Builds the swipeable row (drag handle + radio + text + days badge +
// assignee avatar) shared by top-level todos and sub-todos. Long-pressing
// the row opens its edit page (`onMenu`, see openEditPage), which is
// where every edit lives — there is no edit icon; `onRowClick`
// (top-level only) toggles the sub-todo list separately, and the two are
// independent so opening one doesn't force the other open too. Swiping left
// past a threshold deletes the row; swiping right (only if `onAssignOpen`
// is passed) opens the assignee picker (see attachSwipeGestures). Returns
// { el, handle } rather than just the row element so callers can wire the
// handle to attachDragReorder against the outer <li>, which drag needs to
// translate as a whole (see renderTodoItem / renderChildrenSection).
function renderRow(entity, { isSub, onToggle, onPress, onMenu, onRowClick, onDelete, onAssignOpen }) {
  const wrap = document.createElement("div");
  wrap.className = "swipe-wrap";

  const assignBg = document.createElement("div");
  assignBg.className = "swipe-assign-bg";
  assignBg.innerHTML = PERSON_SVG;
  wrap.appendChild(assignBg);

  const deleteBg = document.createElement("div");
  deleteBg.className = "swipe-delete-bg";
  deleteBg.innerHTML = TRASH_BIN_SVG;
  wrap.appendChild(deleteBg);

  const isNote = entity.type === "note";
  const row = document.createElement("div");
  row.className = "todo-item" + (isSub ? " sub-item" : "") + (isNote ? " note-item" : "");

  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "drag-handle";
  handle.title = "Drag to reorder";
  handle.innerHTML = DRAG_HANDLE_SVG;
  // Dragging starts from the handle only, never the row, so it never fights
  // the row's horizontal swipe-to-delete gesture or the page's vertical
  // scroll — see attachDragReorder.
  handle.onclick = (e) => e.stopPropagation();
  row.appendChild(handle);

  // The circle at the start of the row: a check for a todo, a + for a
  // counter, nothing for a note. Assignment tints whichever one it is.
  let check = null;
  if (isCounter(entity)) {
    check = document.createElement("button");
    check.type = "button";
    check.className = "counter-btn" + (isSub ? " sub-check" : "");
    check.textContent = "+";
    check.onclick = (e) => { e.stopPropagation(); onPress(); };
    row.appendChild(check);
  } else if (!isNote) {
    check = document.createElement("button");
    check.className = "todo-check" + (isSub ? " sub-check" : "") + (entity.done ? " done" : "");
    check.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    check.onclick = (e) => { e.stopPropagation(); onToggle(); };
    row.appendChild(check);
  }

  if (entity.icon && entity.icon.type === "emoji") {
    const icon = document.createElement("span");
    icon.className = "todo-icon";
    icon.textContent = entity.icon.value;
    row.appendChild(icon);
  }

  const text = document.createElement("span");
  text.className = "todo-text" + (entity.done ? " done" : "") + (entity.bold ? " bold" : "");
  text.textContent = entity.text;

  row.appendChild(text);

  const children = entity.children || [];
  // An urgent sub-item reddens its parent too, the same way a child's
  // deadline surfaces on the parent below — a collapsed row shouldn't hide
  // that something inside it is on fire. Done sub-items stop counting.
  if (entity.urgent || children.some((c) => c.urgent && !c.done)) row.classList.add("urgent");
  const checkableChildren = children.filter((c) => c.type !== "note" && !isCounter(c));
  if (!isSub && checkableChildren.length > 0) {
    const doneCount = checkableChildren.filter((c) => c.done).length;
    const countSpan = document.createElement("span");
    countSpan.className = "todo-subcount";
    countSpan.textContent = "(" + doneCount + "/" + checkableChildren.length + ")";
    row.appendChild(countSpan);
  }

  if (isCounter(entity)) {
    const value = document.createElement("span");
    value.className = "counter-value";
    value.textContent = counterValue(entity);
    row.appendChild(value);
  }

  let inheritedDeadline = false;
  let badgeEntity = entity;
  if (!isSub && !isNote && !isCounter(entity) && !entity.due_date) {
    const inherited = earliestChildDeadline(entity);
    if (inherited) { badgeEntity = inherited; inheritedDeadline = true; }
  }
  const badge = renderDaysBadge(badgeEntity);
  if (badge) {
    if (inheritedDeadline) badge.classList.add("inherited");
    row.appendChild(badge);
  }

  // Who an item is assigned to is shown by tinting its check circle in that
  // person's color, rather than by an initialled avatar at the end of the
  // row: a second circle on every assigned row was visual noise, and the
  // check circle is already a colored circle sitting right next to the text.
  // The name is still one tap away (swipe right opens the assign panel) and
  // is on the button's tooltip for desktop.
  if (entity.assigned_to) {
    const user = findUser(entity.assigned_to);
    const color = userColor(user);
    const label = "Assigned to " + ((user && user.name) || "Unnamed");
    if (check) {
      check.style.borderColor = color;
      if (entity.done) check.style.background = color;
      check.title = label;
    } else {
      // A note has no check circle to carry the tint, so it keeps a plain
      // dot — the same signal, minus the initial that made it noisy.
      const dot = document.createElement("span");
      dot.className = "assignee-dot";
      dot.style.background = color;
      dot.title = label;
      row.appendChild(dot);
    }
  }

  if (onRowClick) row.onclick = onRowClick;
  else row.classList.add("no-row-click");

  // Long press is a *touch* idiom; a right click is the desktop equivalent.
  // preventDefault runs for every contextmenu, which keeps the native menu
  // away on the platforms that raise one from a touch long press (Android
  // Chrome does), but only a mouse's opens ours: a touch press is the
  // timer's in attachSwipeGestures, and Android's contextmenu also fires off
  // the hold that starts a reorder on the drag handle — which is how the
  // menu used to open mid-drag. The "not on a control" guard covers a right
  // click on the handle or the radio.
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (lastPointerType !== "mouse" || e.target.closest("button")) return;
    openMenuFromGesture(onMenu, false);
  });

  wrap.appendChild(row);
  attachSwipeGestures(row, { onDelete, onAssignOpen, onLongPress: onMenu, deleteBg, assignBg });
  return { el: wrap, handle };
}

// Renders one entity (todo, sub-todo, or note) as a single Markdown-ish
// line: "- [ ]"/"- [x]" for checkable items, plain text for notes, due date
// (+ time, if set) as an ISO "@" suffix. `indent` is a tab count, so a
// top-level item's own line is unindented and its children sit one tab in.
function markdownLine(entity, indent) {
  const prefix = "\t".repeat(indent);
  const deadline = entity.due_date ? " @" + entity.due_date + (entity.due_time ? "T" + entity.due_time : "") : "";
  if (entity.type === "note") return prefix + textWithIcon(entity);
  // Not round-trippable: the importer reads this back as a plain todo.
  if (isCounter(entity)) return prefix + textWithIcon(entity) + ": " + (entity.presses || []).length;
  return prefix + "- [" + (entity.done ? "x" : " ") + "] " + textWithIcon(entity) + deadline;
}

// Full Markdown-ish text for the Copy button: the entity's own line, plus
// one tab-indented line per child (checklist item, or plain text for a
// note) — see markdownLine. A sub-todo has no `children` of its own (depth
// is capped at 2), so this naturally reduces to just its own line there.
function entityToMarkdown(entity) {
  const lines = [markdownLine(entity, 0)];
  for (const child of entity.children || []) lines.push(markdownLine(child, 1));
  return lines.join("\n");
}

function writeClipboard(text, okMessage) {
  if (!navigator.clipboard) {
    toast("Clipboard not available in this browser.");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => toast(okMessage),
    () => toast("Couldn't copy — clipboard access denied.")
  );
}

// "Copy" is the plain-prose one: just this item's own text (emoji icon
// included, since that reads as part of the label), with no checkbox, no
// deadline suffix and no sub-items — for dropping a single line into a
// message. "Export" below is the round-trippable one.
function copyEntityText(entity) {
  writeClipboard(textWithIcon(entity), "Text copied to clipboard.");
}

// The Markdown-ish dump: this item's own line plus every sub-item, in the
// same format the paste importer reads back (see parseImportLine).
function exportEntityMarkdown(entity) {
  writeClipboard(entityToMarkdown(entity), "Exported to clipboard.");
}

// Panel opened by swipe-right (see attachSwipeGestures's onAssignOpen),
// listing every registered device identity as a tappable chip; picking one
// calls onAssign(userId) and an already-assigned entity also gets an
// "Unassign" chip. Shared by top-level todos and sub-todos.
function renderAssignPanel(entity, onAssign) {
  const panel = document.createElement("div");
  panel.className = "assign-panel";

  if (users.length === 0) {
    const p = document.createElement("p");
    p.className = "assign-empty";
    p.textContent = "No one has set a name yet — add yours in Settings.";
    panel.appendChild(p);
    return panel;
  }

  for (const user of users) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "assign-chip" + (entity.assigned_to === user.id ? " selected" : "");
    const avatar = document.createElement("span");
    avatar.className = "assignee-avatar";
    avatar.style.background = userColor(user);
    avatar.textContent = userInitial(user);
    chip.appendChild(avatar);
    const label = document.createElement("span");
    label.textContent = user.name || "Unnamed";
    chip.appendChild(label);
    chip.onclick = () => onAssign(user.id);
    panel.appendChild(chip);
  }

  if (entity.assigned_to) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "assign-chip assign-clear";
    clearBtn.textContent = "Unassign";
    clearBtn.onclick = () => onAssign(null);
    panel.appendChild(clearBtn);
  }

  return panel;
}

// The long-press edit page: every edit to an item goes through here. It is a
// full-screen page rather than a sheet, and it edits a *draft*: the fields
// are read off the item once, when the page opens, and nothing lands until
// Save. Save sends one edit carrying only the fields that changed — so a
// field someone else changed in the meantime is not put back — and offers
// one Undo for all of it. Back (the header arrow, the system back, Escape)
// leaves without saving, and asks first if anything was changed.
//
// Below the fields are the actions (Duplicate, Copy, Export, Wrap), which
// are commands rather than fields. Picking one saves the draft first, then
// leaves the page and runs, so the action sees the item as it was left.
//
// It lives outside the list, in static markup, so the render() a background
// sync triggers can't rebuild it mid-typing — and the draft is never
// refreshed from that sync either. The item is held as a ref and looked up
// again on Save, since that sync also replaces `todos`.
//
// Only what is legal for the row is offered: no Wrap on a sub-item (nesting
// is one level deep), no deadline on a note, Bold only on a note. Assign and
// Delete are not here at all: the two swipes already are those.
let editState = null; // { ref, initial, read } while the page is open, else null

// `removed` is the counter presses struck out on the page, which Save sends
// as an "unpress" of its own rather than as part of the field patch.
function draftOf(entity) {
  return {
    text: textWithIcon(entity),
    due_date: entity.due_date || "",
    due_time: entity.due_time || "",
    urgent: !!entity.urgent,
    bold: !!entity.bold,
    display: entity.display || "count",
    removed: [],
  };
}

// The edit that turns `initial` into `draft`, holding only what changed —
// `icon` with `text`, and `due_time` with `due_date`, the pairs applyPatch
// treats as one. Empty when nothing did.
function draftPatch(initial, draft) {
  const patch = {};
  if (draft.text.trim() !== initial.text.trim()) {
    const { icon, text } = splitLeadingIcon(draft.text);
    // `icon` is always sent (null included) so deleting the emoji from the
    // text is what clears the icon — see applyPatch.
    patch.text = text;
    patch.icon = icon;
  }
  if (draft.due_date !== initial.due_date || draft.due_time !== initial.due_time) {
    patch.due_date = draft.due_date || null;
    patch.due_time = draft.due_date ? (draft.due_time || null) : null;
  }
  if (draft.urgent !== initial.urgent) patch.urgent = draft.urgent;
  if (draft.bold !== initial.bold) patch.bold = draft.bold;
  if (draft.display !== initial.display) patch.display = draft.display;
  return patch;
}

function isEditDirty() {
  const draft = editState.read();
  return Object.keys(draftPatch(editState.initial, draft)).length > 0 || draft.removed.length > 0;
}

function formatPress(at) {
  const d = new Date(at);
  const opts = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleString([], opts);
}

// A counter's display choice, each option previewing what the row would
// show with it, and its presses, newest first. A press is struck out by its
// ✕ and put back by a second tap; nothing is deleted until Save. A long
// history is cut to the latest PRESS_LIST_LIMIT, with a button for the rest.
const PRESS_LIST_LIMIT = 50;

function counterSections(entity, initial) {
  const radios = document.createElement("div");
  for (const [key, label] of COUNTER_DISPLAYS) {
    const row = document.createElement("div");
    row.className = "edit-toggle";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "editDisplay";
    input.id = "editDisplay-" + key;
    input.value = key;
    input.checked = initial.display === key;
    const preview = document.createElement("span");
    preview.className = "counter-value";
    preview.textContent = counterValue({ ...entity, display: key });
    row.append(fieldLabel(label, input.id), preview, input);
    radios.appendChild(row);
  }

  const presses = (entity.presses || []).slice().reverse();
  const removed = new Set();
  const list = document.createElement("div");
  const addRows = (from, to) => {
    for (const at of presses.slice(from, to)) {
      const row = document.createElement("div");
      row.className = "press-row";
      const when = document.createElement("span");
      when.textContent = formatPress(at);
      const strike = pageButton("✕", () => {
        if (removed.has(at)) removed.delete(at); else removed.add(at);
        row.classList.toggle("removed", removed.has(at));
        strike.textContent = removed.has(at) ? "↺" : "✕";
        strike.title = removed.has(at) ? "Keep this press" : "Delete this press";
      }, "press-delete");
      strike.title = "Delete this press";
      row.append(when, strike);
      list.appendChild(row);
    }
  };
  if (presses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "assign-empty";
    empty.textContent = "No presses yet.";
    list.appendChild(empty);
  }
  addRows(0, PRESS_LIST_LIMIT);
  const section = editSection(fieldLabel("Presses (" + presses.length + ")"), list);
  if (presses.length > PRESS_LIST_LIMIT) {
    const more = pageButton("Show all " + presses.length, () => {
      more.remove();
      addRows(PRESS_LIST_LIMIT, presses.length);
    }, "action-item");
    section.appendChild(more);
  }

  return {
    sections: [editSection(fieldLabel("Display"), radios), section],
    readDisplay: () => radios.querySelector("input:checked").value,
    readRemoved: () => [...removed],
  };
}

function pageButton(label, onClick, cls) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = cls || "action-item";
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

function fieldLabel(text, forId) {
  const label = document.createElement("label");
  label.className = "field-label";
  label.textContent = text;
  if (forId) label.htmlFor = forId;
  return label;
}

function editSection(...children) {
  const section = document.createElement("div");
  section.className = "edit-section";
  section.append(...children);
  return section;
}

function editToggle(label, id, checked) {
  const row = document.createElement("div");
  row.className = "edit-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = id;
  input.checked = checked;
  row.append(fieldLabel(label, id), input);
  return { row, input };
}

function openEditPage(ref) {
  const entity = findEntity(ref);
  if (!entity) return;
  const isNote = entity.type === "note";
  const counter = isCounter(entity);
  const initial = draftOf(entity);
  const page = el("editPage");
  page.innerHTML = "";

  const header = document.createElement("div");
  header.className = "edit-header";
  const back = pageButton("←", () => history.back(), "edit-back");
  back.title = "Back without saving";
  const heading = document.createElement("h2");
  heading.textContent = isNote ? "Edit note" : counter ? "Edit counter" : "Edit item";
  header.append(back, heading, pageButton("Save", saveAndLeave, "action-btn accent"));

  const body = document.createElement("div");
  body.className = "edit-body";

  // A form so Enter in the text field is Save, as it was in the old view.
  const textForm = document.createElement("form");
  textForm.onsubmit = (e) => { e.preventDefault(); saveAndLeave(); };
  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.id = "editText";
  textInput.value = initial.text;
  textInput.autocomplete = "off";
  textForm.append(fieldLabel("Text — a leading emoji is the icon", "editText"), textInput);
  body.appendChild(editSection(textForm));

  let dateInput = null;
  let timeInput = null;
  if (!isNote && !counter) {
    const row = document.createElement("div");
    row.className = "action-date-row";
    dateInput = document.createElement("input");
    dateInput.type = "date";
    dateInput.id = "editDate";
    dateInput.value = initial.due_date;
    timeInput = document.createElement("input");
    timeInput.type = "time";
    timeInput.value = initial.due_time;
    // A time means nothing without a date, and is dropped with it.
    const syncTime = () => {
      if (!dateInput.value) timeInput.value = "";
      timeInput.disabled = !dateInput.value;
    };
    dateInput.onchange = syncTime;
    syncTime();
    const clear = pageButton("Clear", () => { dateInput.value = ""; syncTime(); }, "action-btn");
    row.append(dateInput, timeInput, clear);
    body.appendChild(editSection(fieldLabel("Deadline", "editDate"), row));
  }

  const urgent = editToggle("Urgent", "editUrgent", initial.urgent);
  const flags = editSection(urgent.row);
  let bold = null;
  if (isNote) {
    bold = editToggle("Bold", "editBold", initial.bold);
    flags.appendChild(bold.row);
  }
  body.appendChild(flags);

  const counterParts = counter ? counterSections(entity, initial) : null;
  if (counterParts) body.append(...counterParts.sections);

  // Copy and Export look the item up only after the save, so they copy what
  // was just saved rather than what the page opened on.
  const withEntity = (fn) => () => { const now = findEntity(ref); if (now) fn(now); };
  const list = document.createElement("div");
  list.className = "action-list";
  list.append(
    pageButton("Duplicate", () => runEditAction(() => duplicateWithUndo(ref))),
    pageButton("Copy text", () => runEditAction(withEntity(copyEntityText))),
    pageButton("Export as Markdown", () => runEditAction(withEntity(exportEntityMarkdown))),
  );
  const actions = editSection(fieldLabel("Actions"), list);

  if (!ref.parentId) {
    const wrapInput = document.createElement("input");
    wrapInput.type = "text";
    wrapInput.id = "editWrapText";
    wrapInput.placeholder = "New parent's text";
    wrapInput.autocomplete = "off";
    const wrap = (ids) => () => {
      if (!splitLeadingIcon(wrapInput.value).text) {
        toast("Type the new parent's text first.");
        wrapInput.focus();
        return;
      }
      const text = wrapInput.value;
      runEditAction(() => promoteToSuper(ids, text));
    };
    const btnRow = document.createElement("div");
    btnRow.className = "action-btn-row";
    btnRow.appendChild(pageButton("Wrap this", wrap([ref.id]), "action-btn"));
    // "Below" is as the list is drawn, since that is what the user is looking
    // at when they pick it — under a sort that is not the stored order.
    const shown = sortedForDisplay(todos, false);
    const below = shown.slice(shown.findIndex((t) => t.id === ref.id));
    if (below.length > 1) {
      btnRow.appendChild(pageButton("Wrap this and the " + (below.length - 1) + " below", wrap(below.map((t) => t.id)), "action-btn"));
    }
    actions.append(fieldLabel("Wrap in a new parent", "editWrapText"), wrapInput, btnRow);
  }
  body.appendChild(actions);

  page.append(header, body);

  editState = {
    ref,
    initial,
    read: () => ({
      text: textInput.value,
      due_date: dateInput ? dateInput.value : initial.due_date,
      due_time: timeInput ? timeInput.value : initial.due_time,
      urgent: urgent.input.checked,
      bold: bold ? bold.input.checked : initial.bold,
      display: counterParts ? counterParts.readDisplay() : initial.display,
      removed: counterParts ? counterParts.readRemoved() : [],
    }),
  };
  // The page is a history entry of its own, so the system back closes it
  // instead of leaving the app — see the popstate handler in init.
  history.pushState({ editPage: true }, "");
  page.classList.add("open");
  page.scrollTop = 0;
}

// Lands the draft. Returns false only when the page should stay open (an
// empty text); an item deleted elsewhere while the page was open is reported
// and the page left, since there is nothing left to edit.
function saveDraft() {
  const { ref, initial, read } = editState;
  const draft = read();
  if (!splitLeadingIcon(draft.text).text) {
    toast("An item needs some text.");
    return false;
  }
  const patch = draftPatch(initial, draft);
  const hasPatch = Object.keys(patch).length > 0;
  if (!hasPatch && draft.removed.length === 0) return true;
  const entity = findEntity(ref);
  if (!entity) {
    toast("This item was deleted elsewhere — nothing saved.");
    return true;
  }
  // One Undo for the whole save, like the delete's. Each undo is a second,
  // ordinary op carrying the old values rather than a retraction of the
  // first, which is what keeps it correct after the save has synced.
  const ops = [];
  const undos = [];
  if (hasPatch) {
    undos.push(editOp(ref, patchSnapshot(entity, patch)));
    ops.push(editOp(ref, patch));
  }
  if (draft.removed.length > 0) {
    ops.push(pressOp(ref, "unpress", draft.removed));
    undos.push(pressOp(ref, "press", draft.removed));
  }
  for (const op of ops) applyEdit(op);
  toast("Saved", { label: "Undo", onClick: () => { for (const op of undos) applyEdit(op); } });
  return true;
}

function closeEditPage() {
  editState = null;
  el("editPage").classList.remove("open");
  el("editPage").innerHTML = "";
}

// Leaves through the history, popping the entry openEditPage pushed.
// editState is cleared first, so the popstate this raises is not taken for
// a back press.
function leaveEditPage() {
  closeEditPage();
  history.back();
}

function saveAndLeave() {
  if (saveDraft()) leaveEditPage();
}

function runEditAction(fn) {
  if (!saveDraft()) return;
  leaveEditPage();
  fn();
}

// A back press: the system back, the header arrow and Escape all arrive
// here, the latter two through history.back(). The entry is already popped
// by then, so staying on the page means pushing it again.
function onEditPageBack() {
  if (!editState) return;
  if (isEditDirty() && !confirm("Discard your changes to this item?")) {
    history.pushState({ editPage: true }, "");
    return;
  }
  closeEditPage();
}

function renderTodoItem(todo) {
  const wrap = document.createElement("li");
  wrap.className = "todo-item-wrap";

  const { el: rowEl, handle } = renderRow(todo, {
    isSub: false,
    onToggle: () => toggleTodo(todo.id),
    onPress: () => pressCounter({ id: todo.id, parentId: null }),
    onMenu: () => openEditPage({ id: todo.id, parentId: null }),
    // A counter holds no sub-items, so there is nothing for a tap to open.
    onRowClick: isCounter(todo) ? null : () => { shownChildrenIds.has(todo.id) ? shownChildrenIds.delete(todo.id) : shownChildrenIds.add(todo.id); render(); },
    onDelete: () => deleteTodoWithUndo(todo.id),
    onAssignOpen: () => { assigningIds.has(todo.id) ? assigningIds.delete(todo.id) : assigningIds.add(todo.id); render(); },
  });
  wrap.appendChild(rowEl);
  // A drop arrives as an index into the *rendered* order, which is not the
  // stored order while a sort is on — storedDropIndex translates it, so the
  // handle stays usable under a sort instead of disappearing.
  attachDragReorder(handle, wrap, () => Array.from(el("todoList").children), (fromIndex, toIndex) =>
    reorderTodo(todo.id, storedDropIndex(todos, displayedTodos(), todo.id, toIndex, false))
  );

  if (assigningIds.has(todo.id)) {
    const panel = document.createElement("div");
    panel.className = "todo-expand";
    panel.appendChild(renderAssignPanel(todo, (userId) => { assigningIds.delete(todo.id); render(); assignWithUndo({ id: todo.id, parentId: null }, userId); }));
    wrap.appendChild(panel);
  }

  const open = shownChildrenIds.has(todo.id) || matchingChildren(todo, searchTerms());
  if (open && !isCounter(todo)) wrap.appendChild(renderChildrenSection(todo));

  return wrap;
}

// The sub-todo list plus its "add sub-todo" input, shown together when a
// top-level row is clicked. Sub-todos never get their own add-sub-todo
// affordance — nesting stays exactly one level deep.
function renderChildrenSection(todo) {
  const section = document.createElement("div");
  section.className = "children-section";

  const children = todo.children || [];
  if (children.length > 0) {
    const ul = document.createElement("ul");
    ul.className = "sub-list";

    for (const child of displayedChildren(todo)) {
      const li = document.createElement("li");
      li.className = "sub-item-wrap" + (child.type === "note" ? " note-item-wrap" : "");

      const { el: childRowEl, handle: childHandle } = renderRow(child, {
        isSub: true,
        onToggle: () => toggleSubTodo(todo.id, child.id),
        onPress: () => pressCounter({ id: child.id, parentId: todo.id }),
        onMenu: () => openEditPage({ id: child.id, parentId: todo.id }),
        onDelete: () => deleteSubTodoWithUndo(todo.id, child.id),
        onAssignOpen: () => { assigningIds.has(child.id) ? assigningIds.delete(child.id) : assigningIds.add(child.id); render(); },
      });
      li.appendChild(childRowEl);
      // The sibling array is looked up again at drop time, not closed over,
      // so a sync that replaced `todos` mid-drag can't leave the translation
      // reading a detached copy.
      attachDragReorder(childHandle, li, () => Array.from(ul.children), (fromIndex, toIndex) => {
        const parent = todos.find((t) => t.id === todo.id);
        if (!parent) return;
        reorderSubTodo(todo.id, child.id, storedDropIndex(parent.children || [], displayedChildren(parent), child.id, toIndex, true));
      });

      if (assigningIds.has(child.id)) {
        const panel = document.createElement("div");
        panel.className = "todo-expand";
        panel.appendChild(renderAssignPanel(child, (userId) => { assigningIds.delete(child.id); render(); assignWithUndo({ id: child.id, parentId: todo.id }, userId); }));
        li.appendChild(panel);
      }

      ul.appendChild(li);
    }
    section.appendChild(ul);
  }

  const addForm = document.createElement("form");
  addForm.className = "sub-add-row";

  const mode = subAddMode.get(todo.id) || "todo";
  const noteModeBtn = document.createElement("button");
  noteModeBtn.type = "button";
  noteModeBtn.className = "note-mode-btn";
  styleAddModeBtn(noteModeBtn, mode);
  noteModeBtn.onclick = () => {
    // render() rebuilds this whole section from scratch, which would
    // otherwise silently wipe out whatever was already typed — carry it
    // over to the freshly-built input.
    const draft = addInput.value;
    const next = nextAddMode(mode);
    if (next === "todo") subAddMode.delete(todo.id); else subAddMode.set(todo.id, next);
    render();
    const revived = document.getElementById("subAddInput-" + todo.id);
    if (revived) {
      revived.value = draft;
      revived.focus();
    }
  };

  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.id = "subAddInput-" + todo.id; // looked up after a re-render to restore in-progress text (see noteModeBtn.onclick)
  addInput.placeholder = addModePlaceholder(mode, true);
  addInput.autocomplete = "off";
  addForm.onsubmit = (e) => {
    e.preventDefault();
    addSubItem(todo.id, addInput.value, mode);
    addInput.value = "";
  };
  addForm.append(noteModeBtn, addInput);
  if (searchTerms().length === 0) section.appendChild(addForm);

  return section;
}

// Attaches a horizontal swipe gesture to `rowEl` via Pointer Events (unifies
// touch + mouse). Vertical drags are left alone so the list still scrolls
// normally. A left swipe past SWIPE_THRESHOLD (or a fast flick past a
// smaller distance) deletes the row, sliding it fully off-screen first —
// that's a destructive, unrecoverable-looking action so it commits visually.
// A right swipe past the same threshold instead opens the assignee picker
// (see onAssignOpen/renderAssignPanel) and snaps back to place, since picking
// a person is a second step, not something the swipe alone can express.
// A press held past LONG_PRESS_MS without moving *arms* the row's edit
// page (`onLongPress`, see openEditPage) — the gesture that replaced the
// old edit pencil — and the page opens on release, provided nothing moved in
// between. Opening on the timer instead meant a press that paused before
// turning into a scroll, a swipe or a drag opened the page under the finger.
// It shares this function's pointer bookkeeping rather than getting
// listeners of its own, because the two must agree on one thing: any move
// past the deadzone is a swipe or a scroll, never an edit.
// Gesture state is closure-local per row, not shared module state — except
// the click-swallow, which has to outlive the row it started on (see
// openMenuFromGesture).
const SWIPE_DEADZONE = 8;
const SWIPE_THRESHOLD = 80;
// Deliberately under the ~500ms most platforms use, because iOS Safari fires
// pointercancel more eagerly than Android and a longer hold there is more
// likely to be swallowed before it completes.
const LONG_PRESS_MS = 450;

// What started the latest press, read by the rows' contextmenu handler.
// Android raises its own contextmenu off a touch long press — on the drag
// handle too, whose pointerdown never reaches the row — and that one has to
// be ignored, since a touch press is already handled by the timer above.
// Recorded in the capture phase so a control that stops propagation (the
// drag handle does) can't hide it.
let lastPointerType = "mouse";
document.addEventListener("pointerdown", (e) => { lastPointerType = e.pointerType; }, true);

// Single entry point for "open this row's edit page by gesture", shared by
// the press release and a mouse right click.
//
// The release synthesizes a click after pointerup, and by then the edit
// page is what sits under the finger: unswallowed, that click would press
// whichever control the press ended over. It can't be guarded on the row, which the
// click no longer reaches. Hence a one-shot capture listener on the
// document. A right click is followed by no click, so it must not arm the
// swallow — that would eat the user's next real tap.
function openMenuFromGesture(onMenu, swallowClick) {
  if (swallowClick) {
    const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
    document.addEventListener("click", swallow, { capture: true, once: true });
    // A release that synthesizes no click (some platforms skip it after a
    // long hold) would otherwise leave the listener armed to eat the user's
    // next real tap.
    setTimeout(() => document.removeEventListener("click", swallow, true), 1000);
  }
  onMenu();
}

function attachSwipeGestures(rowEl, { onDelete, onAssignOpen, onLongPress, deleteBg, assignBg }) {
  let startX = 0, startY = 0, startTime = 0;
  let axis = null; // null | "x" | "y", decided once past the deadzone
  let dx = 0;
  let suppressClick = false;
  let pressTimer = null;
  let armed = false; // held long enough; the edit page opens on release, if nothing moved since

  const cancelLongPress = () => {
    if (pressTimer !== null) clearTimeout(pressTimer);
    pressTimer = null;
    armed = false;
    rowEl.classList.remove("pressing");
  };

  rowEl.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    startTime = e.timeStamp;
    axis = null;
    dx = 0;
    rowEl.classList.add("dragging");
    if (deleteBg && assignBg) {
      deleteBg.style.opacity = "0";
      assignBg.style.opacity = "0";
    }
    // Presses that start on the drag handle, the radio, or any other control
    // bubble up to here; those have their own meaning, so they never edit.
    if (onLongPress && !e.target.closest("button")) {
      // .pressing is the only confirmation an iPhone gets — navigator.vibrate
      // doesn't exist in iOS Safari — so the visual cue isn't optional there.
      rowEl.classList.add("pressing");
      pressTimer = setTimeout(() => {
        pressTimer = null;
        armed = true;
        if (navigator.vibrate) navigator.vibrate(10);
      }, LONG_PRESS_MS);
    }
  });

  rowEl.addEventListener("pointermove", (e) => {
    if (startTime === 0) return;
    const curDx = e.clientX - startX;
    const curDy = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(curDx) < SWIPE_DEADZONE && Math.abs(curDy) < SWIPE_DEADZONE) return;
      axis = Math.abs(curDx) > Math.abs(curDy) ? "x" : "y";
      cancelLongPress();
      if (axis === "x") rowEl.setPointerCapture(e.pointerId);
    }
    if (axis !== "x") return;
    e.preventDefault();
    dx = onAssignOpen ? curDx : Math.min(0, curDx);
    rowEl.style.transform = "translateX(" + dx + "px)";
    // Both backgrounds fill the same grid cell behind the row (see
    // .swipe-delete-bg/.swipe-assign-bg), so whichever comes later in the
    // DOM would otherwise always paint over the other regardless of swipe
    // direction. Fade out whichever one the drag isn't revealing — NOT via
    // z-index: the row itself has no explicit z-index (it relies on being
    // last in DOM order to stay on top), so giving a background z-index:1
    // would lift it above the row instead of just above its sibling
    // background, hiding the whole row under a solid color block.
    if (deleteBg && assignBg) {
      deleteBg.style.opacity = dx < 0 ? "1" : "0";
      assignBg.style.opacity = dx > 0 ? "1" : "0";
    }
  });

  // Swallow the click a touch/mouse release synthesizes after a horizontal
  // drag, so a swipe never also toggles the expand panel.
  rowEl.addEventListener("click", (e) => {
    if (suppressClick) e.stopImmediatePropagation();
  }, true);

  const finish = (e) => {
    // Only a release opens the edit page. A pointercancel means the browser took
    // the gesture for a scroll, and any move past the deadzone has already
    // disarmed it in pointermove above.
    const open = armed && e.type === "pointerup";
    cancelLongPress();
    if (open) openMenuFromGesture(onLongPress, true);
    if (startTime === 0) return;
    const elapsed = e.timeStamp - startTime;
    rowEl.classList.remove("dragging");
    if (axis === "x") {
      const velocity = dx / Math.max(elapsed, 1);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (dx < -SWIPE_THRESHOLD || (dx < -30 && velocity < -0.5)) {
        rowEl.style.transform = "translateX(-100%)";
        setTimeout(onDelete, 150);
      } else if (onAssignOpen && (dx > SWIPE_THRESHOLD || (dx > 30 && velocity > 0.5))) {
        rowEl.style.transform = "translateX(0)";
        onAssignOpen();
      } else {
        rowEl.style.transform = "translateX(0)";
      }
    }
    startTime = 0;
    axis = null;
    dx = 0;
  };

  rowEl.addEventListener("pointerup", finish);
  rowEl.addEventListener("pointercancel", finish);
}

// Vertical drag-to-reorder, started only from a dedicated handle (never the
// row itself) so it never has to be disambiguated from the row's horizontal
// swipe-to-delete gesture or from the page's normal vertical scroll — the
// handle has touch-action:none and simply always drags.
//
// `wrapEl` is the outer <li> (todo-item-wrap or sub-item-wrap), which is
// translated as a whole so any open assign panel / children section moves with
// it. `getSiblingWraps()` is called at drag-start and must return the
// current siblings (same list: all top-level <li>s, or one parent's sub
// <li>s) in DOM order. `onDrop(fromIndex, toIndex)` fires once, on release,
// with indices into that *rendered* order — which is the stored array order
// only while no sort is on, so callers run the drop through storedDropIndex
// before applying it and re-rendering (render() resets all transforms).
//
// Sibling shift amounts during the drag use the dragged row's own height as
// a stand-in for every sibling's height. Rows at the same level are close
// enough in height that this reads fine in practice; exact per-sibling
// offsets would need re-measuring every sibling on each move, which isn't
// worth it for a todo list.
function attachDragReorder(handleEl, wrapEl, getSiblingWraps, onDrop) {
  let dragging = false;
  let startY = 0;
  let siblings = []; // [{ el, top }], captured at drag start, in original DOM order
  let currentIndex = 0;
  let dropIndex = 0;
  let rowHeight = 0;

  handleEl.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handleEl.setPointerCapture(e.pointerId);
    dragging = true;
    startY = e.clientY;
    const wraps = getSiblingWraps();
    siblings = wraps.map((el) => ({ el, top: el.offsetTop }));
    currentIndex = wraps.indexOf(wrapEl);
    dropIndex = currentIndex;
    rowHeight = wrapEl.offsetHeight;
    wrapEl.classList.add("drag-active");
  });

  handleEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.stopPropagation();
    const dy = e.clientY - startY;
    wrapEl.style.transform = "translateY(" + dy + "px)";

    const draggedCenter = siblings[currentIndex].top + rowHeight / 2 + dy;
    const others = siblings.filter((_, i) => i !== currentIndex);
    let k = others.findIndex((s) => draggedCenter < s.top + rowHeight / 2);
    if (k === -1) k = others.length;
    dropIndex = k;

    others.forEach((s, i) => {
      const originalIndex = siblings.indexOf(s);
      const newIndex = i < k ? i : i + 1;
      const shift = (newIndex - originalIndex) * rowHeight;
      s.el.style.transform = shift ? "translateY(" + shift + "px)" : "";
    });
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    e.stopPropagation();
    wrapEl.classList.remove("drag-active");
    wrapEl.style.transform = "";
    for (const s of siblings) s.el.style.transform = "";
    if (dropIndex !== currentIndex) onDrop(currentIndex, dropIndex);
  };

  handleEl.addEventListener("pointerup", finish);
  handleEl.addEventListener("pointercancel", finish);
}

// updated_at is null here (not a fresh timestamp) so repeated calls before
// the file exists on Dropbox compare equal — otherwise every read-check-write
// on a still-nonexistent file looks like a remote conflict.
function emptyTodoDoc() {
  return { version: 1, updated_at: null, todos: [] };
}

// Downloads + decrypts the current remote file (or a fresh empty doc if none exists yet).
async function fetchRemoteDoc() {
  const text = await DropboxFile.download(currentBoard.file);
  if (text === null) return emptyTodoDoc();
  try {
    return await decryptPayload(cryptoKey, text);
  } catch (err) {
    // Distinguishes "the key is wrong" from "couldn't reach Dropbox" so
    // callers don't discard a perfectly good cached key over a network blip.
    err.isKeyError = true;
    throw err;
  }
}

// --- Boards (tabs) ---------------------------------------------------
//
// The manifest (list of boards: id/label/icon/data-file) is itself an
// encrypted file in the Dropbox App Folder, at the fixed generic path
// CONFIG.BOARDS_MANIFEST_PATH. This is deliberate: the actual board names
// and how many boards exist are private data, so they only ever live
// inside this encrypted file — never in the (public) committed code.

function emptyManifest() {
  return { version: 1, updated_at: null, boards: [], users: [] };
}

async function fetchManifest() {
  const text = await DropboxFile.download(CONFIG.BOARDS_MANIFEST_PATH);
  if (text === null) return null;
  try {
    return await decryptPayload(cryptoKey, text);
  } catch (err) {
    err.isKeyError = true;
    throw err;
  }
}

const LS_MANIFEST_CACHE = "shared_todo_manifest_cache";

function persistManifestCache() {
  try {
    localStorage.setItem(LS_MANIFEST_CACHE, JSON.stringify({ boards, users, updated_at: manifestUpdatedAt }));
  } catch (err) {
    console.error(err);
  }
}

function loadManifestCache() {
  try {
    const raw = localStorage.getItem(LS_MANIFEST_CACHE);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function saveManifest(manifest) {
  manifest.updated_at = new Date().toISOString();
  const text = await encryptPayload(cryptoKey, manifest);
  await DropboxFile.upload(CONFIG.BOARDS_MANIFEST_PATH, text);
  manifestUpdatedAt = manifest.updated_at;
  boards = manifest.boards;
  users = manifest.users || [];
  persistManifestCache();
}

// Loads the manifest, creating one on first run. If a pre-multi-board
// install already has data at the legacy single-file path, that becomes
// the first board instead of starting empty, so existing lists aren't lost.
// `allowOfflineFallback` mirrors loadAndRender's flag: only a previously
// validated key may fall back to the last cached manifest when Dropbox is
// unreachable.
async function ensureManifest(allowOfflineFallback) {
  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (err) {
    if (err.isKeyError || !allowOfflineFallback) throw err;
    const cached = loadManifestCache();
    if (!cached) throw err;
    boards = cached.boards;
    users = cached.users || [];
    manifestUpdatedAt = cached.updated_at;
    return;
  }

  if (manifest) {
    manifestUpdatedAt = manifest.updated_at;
    boards = manifest.boards;
    users = manifest.users || [];
    persistManifestCache();
    // Silently register this device the first time its id is seen, so a
    // roster of known devices builds up automatically just from opening the
    // app — no separate sign-up step (see deviceId above).
    if (!users.some((u) => u.id === deviceId)) {
      manifest.users = users;
      manifest.users.push({ id: deviceId, name: null, color: null, created_at: new Date().toISOString() });
      await saveManifest(manifest);
    }
    return;
  }

  const legacyText = await DropboxFile.download(LEGACY_TODO_PATH);
  manifest = emptyManifest();
  manifest.boards.push({
    id: crypto.randomUUID(),
    label: "List 1",
    icon: "list",
    file: legacyText !== null ? LEGACY_TODO_PATH : "/board-1.json",
  });
  manifest.users.push({ id: deviceId, name: null, color: null, created_at: new Date().toISOString() });
  await saveManifest(manifest);
}

function pickInitialBoard() {
  const remembered = localStorage.getItem(LS_ACTIVE_BOARD);
  return boards.find((b) => b.id === remembered) || boards[0];
}

async function bootstrapBoards(allowOfflineFallback) {
  await ensureManifest(allowOfflineFallback);
  currentBoard = pickInitialBoard();
  localStorage.setItem(LS_ACTIVE_BOARD, currentBoard.id);
  el("headerTitle").textContent = currentBoard.label;
  renderTabs();
}

// A board's stored `icon` is an emoji, but manifests written by earlier
// versions hold a key into the SVG set that replaced — map those on read so
// an old board still shows something sensible with no migration write.
function boardEmoji(board) {
  const icon = board && board.icon;
  return CONFIG.LEGACY_BOARD_ICONS[icon] || icon || CONFIG.BOARD_EMOJI[0];
}

function renderTabs() {
  const bar = el("tabBar");
  bar.innerHTML = "";
  for (const b of boards) {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (currentBoard && b.id === currentBoard.id ? " active" : "");
    btn.textContent = boardEmoji(b);
    btn.title = b.label;
    btn.onclick = () => switchBoard(b.id);
    bar.appendChild(btn);
  }
}

// Switches the active tab. Waits for any in-flight sync of the outgoing
// board to settle first, since syncChain/todos/pendingOps are scoped to
// "whichever board is current" — switching mid-sync would otherwise let a
// stray write land against the wrong board's file.
async function switchBoard(id) {
  if (currentBoard && id === currentBoard.id) return;
  // Only a sync has to finish first; a background refresh still out for the
  // old board sees the switch and drops its answer (see refreshOpenBoard).
  if (pendingOps.length > 0) await syncChain;
  currentBoard = boards.find((b) => b.id === id);
  localStorage.setItem(LS_ACTIVE_BOARD, currentBoard.id);
  // Each list keeps its own search, so switching back finds it as it was left.
  el("searchInput").value = searchQuery();
  el("searchClearBtn").hidden = !searchQuery();
  el("headerTitle").textContent = currentBoard.label;
  renderTabs();
  // A list seen before on this device shows at once, then catches up.
  if (showCachedBoard()) syncChain = syncChain.then(refreshOpenBoard);
  else await loadAndRender(true);
}

function colorPickerHtml(selected) {
  return CONFIG.USER_COLORS.map((c) =>
    '<button type="button" data-color="' + c + '" class="' + (c === selected ? "selected" : "") + '" style="background:' + c + '"></button>'
  ).join("");
}

// Selected-getter pattern: returns a closure giving the currently picked
// value, for the identity color swatches in Settings.
function wireColorPicker(container, initialSelected) {
  container.innerHTML = colorPickerHtml(initialSelected);
  let selected = initialSelected;
  for (const btn of container.querySelectorAll("button")) {
    btn.onclick = () => {
      selected = btn.dataset.color;
      for (const b of container.querySelectorAll("button")) b.classList.toggle("selected", b === btn);
    };
  }
  return () => selected;
}

// Settings -> "Lists": just a list of the boards. Everything that only
// concerns one board (title, icon, import, export, delete) lives on the
// per-board page below, so this stays a single tap-through row each.
function renderManageBoards() {
  const list = el("manageBoardsList");
  list.innerHTML = "";
  for (const b of boards) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "manage-board-row";

    const emoji = document.createElement("span");
    emoji.className = "board-emoji";
    emoji.textContent = boardEmoji(b);

    const label = document.createElement("span");
    label.className = "board-label";
    label.textContent = b.label;

    const chevron = document.createElement("span");
    chevron.className = "board-chevron";
    chevron.textContent = "\u203a";

    row.append(emoji, label, chevron);
    row.onclick = () => openBoardPage(b.id);
    list.appendChild(row);
  }

  const addRow = document.createElement("button");
  addRow.type = "button";
  addRow.className = "manage-board-row add-board-row";
  addRow.textContent = "+ New list";
  addRow.onclick = () => addBoard();
  list.appendChild(addRow);
}

// --- Per-list settings page ------------------------------------------
//
// A second view inside the Settings sheet (see index.html), shown for one
// board at a time. It edits the manifest only — except Import, which routes
// through the normal add path and therefore switches to the board first.

let boardPageId = null; // board whose page is open, or null for the main view

function openBoardPage(id) {
  const board = boards.find((b) => b.id === id);
  if (!board) return;
  boardPageId = id;
  el("boardPageHeading").textContent = board.label;
  el("boardTitleInput").value = board.label;
  el("sortPendingInput").checked = !!board.sort_pending_first;
  el("sortDueInput").checked = !!board.sort_due_first;
  el("importText").value = "";
  renderBoardIconPicker();
  el("settingsMain").hidden = true;
  el("settingsBoard").hidden = false;
}

function closeBoardPage() {
  boardPageId = null;
  el("settingsBoard").hidden = true;
  el("settingsMain").hidden = false;
  renderManageBoards();
}

function renderBoardIconPicker() {
  const board = boards.find((b) => b.id === boardPageId);
  const picker = el("boardIconPicker");
  picker.innerHTML = "";
  if (!board) return;
  const current = boardEmoji(board);
  for (const emoji of CONFIG.BOARD_EMOJI) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = emoji === current ? "selected" : "";
    btn.textContent = emoji;
    btn.onclick = async () => {
      await renameBoard(board.id, board.label, emoji);
      renderBoardIconPicker();
    };
    picker.appendChild(btn);
  }
}

// Markdown-ish dump of a whole board, same per-item format as the row Copy
// button. The open board is exported from memory so unsynced edits are
// included; any other board is fetched and decrypted on demand.
async function exportBoard(id) {
  const board = boards.find((b) => b.id === id);
  if (!board) return;
  const entities = currentBoard && currentBoard.id === id
    ? todos
    : (await fetchBoardDoc(board)).todos;
  const text = entities.map((t) => entityToMarkdown(t)).join("\n");
  if (!navigator.clipboard) {
    toast("Clipboard not available in this browser.");
    return;
  }
  navigator.clipboard.writeText(text).then(
    () => toast(entities.length + " items copied to clipboard."),
    () => toast("Couldn't copy — clipboard access denied.")
  );
}

async function fetchBoardDoc(board) {
  const text = await DropboxFile.download(board.file);
  if (text === null) return emptyTodoDoc();
  return await decryptPayload(cryptoKey, text);
}

// New lists are created with a placeholder name and the default icon and
// then opened for editing, rather than asking for both up front — one tap
// to create, and the title/icon controls are the same ones used later.
async function addBoard() {
  const manifest = await fetchManifest() || emptyManifest();
  const id = crypto.randomUUID();
  manifest.boards.push({
    id,
    label: "New list",
    icon: CONFIG.BOARD_EMOJI[0],
    file: "/board-" + id + ".json",
  });
  await saveManifest(manifest);
  renderTabs();
  renderManageBoards();
  openBoardPage(id);
}

async function renameBoard(id, label, icon) {
  const trimmed = label.trim();
  if (!trimmed) return;
  const manifest = await fetchManifest() || emptyManifest();
  const b = manifest.boards.find((x) => x.id === id);
  if (!b) return;
  b.label = trimmed;
  b.icon = icon;
  await saveManifest(manifest);
  if (currentBoard && currentBoard.id === id) {
    currentBoard.label = trimmed;
    currentBoard.icon = icon;
    el("headerTitle").textContent = trimmed;
  }
  if (boardPageId === id) el("boardPageHeading").textContent = trimmed;
  renderTabs();
}

// Toggles one of a board's display-sort options. Same shape as
// renameBoard: manifest-only, saved on tap, with the live `currentBoard`
// patched by hand because saveManifest swaps the `boards` array out from
// under it. Re-renders so the open list reorders immediately.
async function setBoardSort(id, key, value) {
  const manifest = await fetchManifest() || emptyManifest();
  const b = manifest.boards.find((x) => x.id === id);
  if (!b) return;
  if (value) b[key] = true;
  else delete b[key]; // absent rather than false — an off switch adds nothing to the file
  await saveManifest(manifest);
  if (currentBoard && currentBoard.id === id) {
    if (value) currentBoard[key] = true;
    else delete currentBoard[key];
    render();
  }
}

// Sets this device's display name + assignee color in the shared manifest.
// The device is normally already registered by ensureManifest on load; a
// from-scratch manifest.users entry is created here too just in case this
// runs before that's happened (e.g. a retried save after a failed load).
async function setMyIdentity(name, color) {
  const trimmed = name.trim();
  const manifest = await fetchManifest() || emptyManifest();
  if (!manifest.users) manifest.users = [];
  let me = manifest.users.find((u) => u.id === deviceId);
  if (!me) {
    me = { id: deviceId, name: null, color: null, created_at: new Date().toISOString() };
    manifest.users.push(me);
  }
  me.name = trimmed || null;
  me.color = color || null;
  await saveManifest(manifest);
  render(); // re-tint any rows already assigned to this device
  toast(trimmed ? "Name saved." : "Name cleared.");
}

function findUser(id) {
  return users.find((u) => u.id === id);
}

function userInitial(user) {
  return user && user.name ? user.name.trim()[0].toUpperCase() : "?";
}

function userColor(user) {
  return (user && user.color) || "var(--muted)";
}

async function deleteBoard(id) {
  if (boards.length <= 1) {
    toast("Can't delete the last list.");
    return;
  }
  const board = boards.find((b) => b.id === id);
  const warning = "Delete \u201c" + (board ? board.label : "this list") +
    "\u201d and all of its items, for everyone sharing this passphrase?\n\n" +
    "This cannot be undone.";
  if (!confirm(warning)) return;
  const manifest = await fetchManifest() || emptyManifest();
  manifest.boards = manifest.boards.filter((b) => b.id !== id);
  await saveManifest(manifest);
  if (boardPageId === id) closeBoardPage();
  renderManageBoards();
  renderTabs();
  if (currentBoard && currentBoard.id === id) {
    await switchBoard(boards[0].id);
  }
}

// Applies a single serializable edit op to a todos list. `op` carries only
// plain JSON data (ids, patches, pre-generated timestamps/uuids for new
// items) so it can round-trip through persistQueue()/loadPersistedQueue() —
// unlike a raw closure, which can't survive localStorage. Each op is applied
// twice over its lifetime: once immediately to the local `todos` (optimistic
// UI), and once later to a freshly-fetched remote copy at sync time (see
// syncPending) — so relative changes like "toggle" re-flip rather than
// storing an absolute target state.
// The field-level half of the "edit"/"editSub" ops. Each field is touched
// only when the patch carries its key, because the edit page sends only the
// fields that changed: a rename must not clear the deadline, and a deadline
// must not rewrite the text. Ops queued by older builds always carried text and
// (on tasks) due_date together, so they replay exactly as before.
function applyPatch(t, patch) {
  if ("text" in patch) t.text = patch.text;
  if ("icon" in patch) { if (patch.icon) t.icon = patch.icon; else delete t.icon; }
  if (patch.bold !== undefined) t.bold = patch.bold;
  // Dropped rather than stored as false, so an item that was never
  // marked urgent stays byte-identical to what older builds wrote.
  if (patch.urgent !== undefined) { if (patch.urgent) t.urgent = true; else delete t.urgent; }
  if ("display" in patch) t.display = patch.display;
  if ("due_date" in patch) {
    if (patch.due_date) {
      t.due_date = patch.due_date;
      if (patch.due_time) t.due_time = patch.due_time; else delete t.due_time;
    } else {
      delete t.due_date;
      delete t.due_time;
    }
  }
}

function applyOp(list, op) {
  switch (op.type) {
    case "add":
      list.push(op.todo);
      break;
    // Bulk paste-import. One op for the whole batch so it costs a single
    // sync round trip; see bulkAdd.
    case "addMany":
      list.push(...op.todos);
      break;
    // Undo for "addMany" — by id rather than by count, so it still removes
    // the right rows if anything else landed in between.
    case "removeIds": {
      const drop = new Set(op.ids);
      for (let i = list.length - 1; i >= 0; i--) {
        if (drop.has(list[i].id)) list.splice(i, 1);
      }
      break;
    }
    case "toggle": {
      const t = list.find((x) => x.id === op.id);
      if (!t) break;
      t.done = !t.done;
      // `done_at` is what lets a just-checked item settle at the *top* of
      // the completed block instead of falling to the bottom of the list
      // (see sortedForDisplay). Cleared on un-check so it never describes
      // an item that isn't done.
      if (t.done) t.done_at = op.now; else delete t.done_at;
      t.updated_at = op.now;
      break;
    }
    case "delete": {
      const idx = list.findIndex((x) => x.id === op.id);
      if (idx > -1) list.splice(idx, 1);
      break;
    }
    // Undo for "delete" — reinserts at its original index instead of at the
    // end (which is what a plain "add" op would do), so undoing a delete
    // near the top of a long list doesn't silently drop the item to the
    // bottom, out of view, looking like it got deleted all over again.
    case "restore": {
      const idx = Math.min(op.index, list.length);
      list.splice(idx, 0, op.todo);
      break;
    }
    case "edit": {
      const t = list.find((x) => x.id === op.id);
      if (!t) break;
      applyPatch(t, op.patch);
      t.updated_at = op.now;
      break;
    }
    case "addSub": {
      const parent = list.find((x) => x.id === op.parentId);
      if (!parent) break;
      if (!parent.children) parent.children = [];
      parent.children.push(op.todo);
      parent.updated_at = op.now;
      break;
    }
    case "toggleSub": {
      const parent = list.find((x) => x.id === op.parentId);
      const child = parent && parent.children && parent.children.find((c) => c.id === op.childId);
      if (!child) break;
      child.done = !child.done;
      if (child.done) child.done_at = op.now; else delete child.done_at;
      child.updated_at = op.now;
      parent.updated_at = op.now;
      break;
    }
    case "deleteSub": {
      const parent = list.find((x) => x.id === op.parentId);
      if (!parent || !parent.children) break;
      const idx = parent.children.findIndex((c) => c.id === op.childId);
      if (idx > -1) {
        parent.children.splice(idx, 1);
        parent.updated_at = op.now;
      }
      break;
    }
    // Undo for "deleteSub" — see "restore" above for why this reinserts at
    // the original index rather than appending.
    case "restoreSub": {
      const parent = list.find((x) => x.id === op.parentId);
      if (!parent) break;
      if (!parent.children) parent.children = [];
      const idx = Math.min(op.index, parent.children.length);
      parent.children.splice(idx, 0, op.todo);
      parent.updated_at = op.now;
      break;
    }
    case "editSub": {
      const parent = list.find((x) => x.id === op.parentId);
      const child = parent && parent.children && parent.children.find((c) => c.id === op.childId);
      if (!child) break;
      applyPatch(child, op.patch);
      child.updated_at = op.now;
      parent.updated_at = op.now;
      break;
    }
    // A counter's presses, at either level. `ats` is a list so one op can
    // carry a whole batch of deletions (and its undo). A timestamp already
    // present is not added twice, so replaying a press is harmless.
    case "press":
    case "unpress": {
      const t = findInList(list, op.id, op.parentId);
      if (!t) break;
      const have = new Set(t.presses || []);
      for (const at of op.ats) {
        if (op.type === "press") have.add(at); else have.delete(at);
      }
      t.presses = [...have].sort();
      t.updated_at = op.now;
      break;
    }
    case "assign": {
      const t = list.find((x) => x.id === op.id);
      if (t) { t.assigned_to = op.userId; t.updated_at = op.now; }
      break;
    }
    case "assignSub": {
      const parent = list.find((x) => x.id === op.parentId);
      const child = parent && parent.children && parent.children.find((c) => c.id === op.childId);
      if (!child) break;
      child.assigned_to = op.userId;
      child.updated_at = op.now;
      parent.updated_at = op.now;
      break;
    }
    case "reorder": {
      const idx = list.findIndex((x) => x.id === op.id);
      if (idx === -1) break;
      const [item] = list.splice(idx, 1);
      list.splice(Math.min(op.toIndex, list.length), 0, item);
      break;
    }
    case "reorderSub": {
      const parent = list.find((x) => x.id === op.parentId);
      if (!parent || !parent.children) break;
      const idx = parent.children.findIndex((c) => c.id === op.childId);
      if (idx === -1) break;
      const [item] = parent.children.splice(idx, 1);
      parent.children.splice(Math.min(op.toIndex, parent.children.length), 0, item);
      parent.updated_at = op.now;
      break;
    }
    // The general form of "wrapSuper" below, which only remains so ops queued
    // by older builds still replay. The new parent takes the place of the
    // first id (the pressed row); ids already gone are skipped.
    case "wrapMany": {
      const picked = op.ids.map((id) => list.find((x) => x.id === id)).filter(Boolean);
      if (picked.length === 0) break;
      const at = list.indexOf(picked[0]);
      const kept = list.filter((x) => !picked.includes(x));
      const pos = kept.filter((x) => list.indexOf(x) < at).length;
      for (const child of picked) {
        delete child.children; // depth is capped at 2
        child.updated_at = op.now;
      }
      kept.splice(pos, 0, { ...op.newParent, children: picked });
      list.splice(0, list.length, ...kept);
      break;
    }
    case "wrapSuper": {
      const idx = list.findIndex((x) => x.id === op.id);
      if (idx === -1) break; // item was deleted/moved elsewhere before this op replayed
      const child = list[idx];
      delete child.children; // depth is capped at 2 — the demoted item can't keep its own sub-items
      child.updated_at = op.now;
      list[idx] = { ...op.newParent, children: [child] };
      break;
    }
  }
}

// Initial load on app open (spec section 6, step 1). A last-known-good
// snapshot ({todos, loadedUpdatedAt, pendingOps}) is kept in localStorage at
// all times (see persistQueue calls below and in syncPending) — not just
// while edits are pending — so a network failure on open always has
// something to fall back to instead of blocking on a "couldn't reach
// Dropbox" screen with no way to view or edit the list.
//
// `allowOfflineFallback` gates that fallback: it's only safe when the active
// cryptoKey has already been validated against real Dropbox data at least
// once before (i.e. unlocking via the remembered key in tryStoredKey/the
// refresh button, both past a prior successful online unlock this device).
// A fresh, never-validated passphrase attempt (unlockWithPassphrase) must
// NOT be allowed to "succeed" offline against stale cached data — that could
// silently accept a wrong passphrase and later encrypt edits with the wrong
// derived key once synced.
async function loadAndRender(allowOfflineFallback) {
  showScreen("loading");
  el("loadingText").textContent = "Loading your list...";
  el("loadingRetryBtn").hidden = true;

  const cached = loadPersistedQueue(currentBoard.id);

  let doc;
  try {
    doc = await fetchRemoteDoc(); // also validates the passphrase (throws isKeyError on a wrong key)
  } catch (err) {
    if (err.isKeyError || !allowOfflineFallback || !cached) throw err;
    // Offline (or Dropbox unreachable) — fall back to the last-known-good
    // cache instead of getting stuck; the sync-status line will retry once
    // connectivity comes back.
    todos = cached.todos;
    loadedUpdatedAt = cached.loadedUpdatedAt;
    pendingOps = cached.pendingOps;
    render();
    updateSyncStatus(new Date());
    showScreen("list");
    setSyncState("error");
    toast(pendingOps.length > 0
      ? "Offline — showing your unsynced changes. Will retry syncing once you're back online."
      : "Offline — showing your last synced list. Edits will sync once you're back online.");
    return;
  }

  if (cached && cached.pendingOps.length > 0) {
    // Reached Dropbox fine, but there's also a leftover local queue — restore
    // it on top of the (possibly newer) remote base and let syncPending do
    // its normal replay/push instead of discarding it.
    todos = cached.todos;
    loadedUpdatedAt = cached.loadedUpdatedAt;
    pendingOps = cached.pendingOps;
    render();
    updateSyncStatus(new Date());
    showScreen("list");
    syncChain = syncChain.then(syncPending);
    return;
  }

  todos = doc.todos;
  loadedUpdatedAt = doc.updated_at;
  pendingOps = [];
  persistQueue(); // keep a last-known-good cache around for a future offline open
  render();
  updateSyncStatus(new Date());
  showScreen("list");
}

// Applies one local edit op optimistically (instant render, no network
// wait), persists the queue so it survives a killed process, then syncs it
// to Dropbox in the background.
//
// The op is applied as a copy, here and in syncPending, so the item an "add"
// carries never becomes the very object in the list: later edits to the
// item would otherwise rewrite the queued op too, and a replay of it would
// then land the item already edited, for the later op to edit again.
function applyEdit(op) {
  applyOp(todos, structuredClone(op));
  render();
  pendingOps.push(op);
  persistQueue();
  syncChain = syncChain.then(syncPending);
}

// Draws the open board from the copy kept on this device (see persistQueue),
// so a list the device has seen before is on screen at once instead of after
// a Dropbox round trip. Returns false when there is no such copy.
function showCachedBoard() {
  const cached = loadPersistedQueue(currentBoard.id);
  if (!cached) return false;
  todos = cached.todos;
  loadedUpdatedAt = cached.loadedUpdatedAt;
  pendingOps = cached.pendingOps;
  render();
  showScreen("list");
  setSyncState("syncing");
  return true;
}

// Brings the open board up to date with Dropbox behind whatever is already
// on screen. Always run on syncChain, never alongside a sync: a download
// answered after a sync had uploaded would draw the older list over it.
// Unsynced edits hand over to syncPending, which downloads and draws anyway;
// so does an edit made while this download was out, whose sync is queued
// right behind it. A board switched away from meanwhile is left alone.
async function refreshOpenBoard() {
  if (pendingOps.length > 0) return syncPending();
  const boardId = currentBoard.id;
  setSyncState("syncing");
  try {
    const doc = await fetchRemoteDoc();
    if (currentBoard.id !== boardId || pendingOps.length > 0) return;
    todos = doc.todos;
    loadedUpdatedAt = doc.updated_at;
    persistQueue();
    render();
    setSyncState("synced");
  } catch (err) {
    console.error(err);
    if (err.isKeyError) lockWithWrongKey();
    else setSyncState("error");
  }
}

// The remembered key no longer opens the data (the passphrase was changed
// on another device): forget it and ask for the passphrase.
function lockWithWrongKey() {
  localStorage.removeItem(LS_KEY_CACHE);
  cryptoKey = null;
  showScreen("passphrase");
}

// Flushes pendingOps using read-check-write (spec section 6, step 2).
// Serialized via syncChain so overlapping edits don't race each other's
// Dropbox round trip. On failure (including offline), pendingOps is left
// intact (and already persisted) so the next edit, a manual retry (refresh
// button), or the next app open resumes from where it left off — nothing
// already shown on screen is discarded.
async function syncPending() {
  if (pendingOps.length === 0) return;
  setSyncState("syncing");
  try {
    const remoteDoc = await fetchRemoteDoc();

    // The queue is replayed onto whatever is on Dropbox now, including when
    // another device wrote since we last read it: every op addresses items
    // by id and touches only what it names, so it lands on the newer list
    // as it would have on ours. This used to discard the queue on any such
    // change ("please redo your edit"), which a counter can't afford — two
    // people pressing the same counter is exactly when it happens.
    //
    // Only the ops queued by now go up in this upload. Edits made while it is
    // in flight stay queued — their own syncPending runs next on syncChain —
    // and are applied again on top of what was uploaded before it is drawn.
    // Clearing the whole queue here, as this once did, silently dropped every
    // edit made during the round trip: a quick run of swipes kept only the
    // first.
    const batch = pendingOps.length;
    for (const op of pendingOps.slice(0, batch)) applyOp(remoteDoc.todos, structuredClone(op));
    remoteDoc.updated_at = new Date().toISOString();

    const text = await encryptPayload(cryptoKey, remoteDoc);
    await DropboxFile.upload(currentBoard.file, text);

    pendingOps = pendingOps.slice(batch);
    const shown = structuredClone(remoteDoc.todos);
    for (const op of pendingOps) applyOp(shown, structuredClone(op));
    todos = shown;
    loadedUpdatedAt = remoteDoc.updated_at;
    persistQueue();
    render();
    setSyncState(pendingOps.length > 0 ? "syncing" : "synced");
  } catch (err) {
    console.error(err);
    setSyncState("error");
  }
}

// What an add bar adds: "todo", "note" or "counter". Both bars (the
// top-level one and each parent's sub-item one) cycle through the three
// with their mode button, which shows N for a note and + for a counter.
function nextAddMode(mode) {
  return mode === "todo" ? "note" : mode === "note" ? "counter" : "todo";
}

function styleAddModeBtn(btn, mode) {
  btn.classList.toggle("active", mode !== "todo");
  btn.textContent = mode === "counter" ? "+" : "N";
  btn.title = mode === "todo" ? "Adding checklist items — tap for notes"
    : mode === "note" ? "Adding notes — tap for counters"
    : "Adding counters — tap for checklist items";
}

function addModePlaceholder(mode, isSub) {
  if (mode === "note") return "Add a note...";
  if (mode === "counter") return "Add a counter...";
  return isSub ? "Add a sub-item..." : "Add an item...";
}

function newEntity(mode, text, now) {
  const base = { id: crypto.randomUUID(), text, created_at: now, updated_at: now };
  if (mode === "note") return { ...base, type: "note", bold: false };
  if (mode === "counter") return { ...base, type: "counter", presses: [], display: "count" };
  return { ...base, done: false };
}

function addTodo(text, mode) {
  const { icon, text: trimmed } = splitLeadingIcon(text);
  if (!trimmed) return;
  const todo = newEntity(mode, trimmed, new Date().toISOString());
  if (icon) todo.icon = icon;
  applyEdit({ type: "add", todo });
}

function toggleTodo(id) {
  applyEdit({ type: "toggle", id, now: new Date().toISOString() });
}

function deleteTodo(id) {
  applyEdit({ type: "delete", id });
}

// Sub-items are one level deep only: `children` lives on a top-level todo,
// and children never have children of their own. Notes and counters reuse
// the "addSub"/"editSub" ops via their `type` tag.
function addSubItem(parentId, text, mode) {
  const { icon, text: trimmed } = splitLeadingIcon(text);
  if (!trimmed) return;
  const now = new Date().toISOString();
  const todo = newEntity(mode, trimmed, now);
  if (icon) todo.icon = icon;
  applyEdit({ type: "addSub", parentId, now, todo });
}

// Wraps top-level todos in a brand-new parent todo, demoting them to its
// children in the order given. That is one item for the edit page's "Wrap
// this" and the pressed row plus everything drawn below it for "Wrap this
// and the N below". Depth is capped at 2 (children never have children of
// their own), so any sub-items the wrapped items hold get dropped — confirm
// with the user before doing that.
function promoteToSuper(ids, text) {
  const { icon, text: trimmed } = splitLeadingIcon(text);
  if (!trimmed) return;
  const picked = ids.map((id) => todos.find((t) => t.id === id)).filter(Boolean);
  if (picked.length === 0) return;
  const dropped = picked.reduce((n, t) => n + (t.children ? t.children.length : 0), 0);
  if (dropped > 0) {
    const what = picked.length === 1 ? "This item has " : "These items have ";
    const ok = confirm(
      what + dropped + " sub-item(s) between them. Nesting them under a new item will remove those, since items can only be nested one level deep. Continue?"
    );
    if (!ok) return;
  }
  // Snapshotted with their sub-items and stored positions, so Undo gives back
  // exactly the list that was there — including the sub-items the wrap
  // dropped, which is the part of this edit most worth undoing.
  const snapshots = picked
    .map((t) => ({ index: todos.indexOf(t), todo: JSON.parse(JSON.stringify(t)) }))
    .sort((x, y) => x.index - y.index);
  const now = new Date().toISOString();
  const newParentId = crypto.randomUUID();
  // Opened, so the rows land on screen inside it rather than vanishing into a
  // collapsed row — a gesture that makes rows disappear reads as a delete.
  shownChildrenIds.add(newParentId);
  applyEdit({
    type: "wrapMany",
    ids: picked.map((t) => t.id),
    now,
    newParent: Object.assign(
      { id: newParentId, text: trimmed, done: false, created_at: now, updated_at: now },
      icon ? { icon } : null
    ),
  });
  // Undone as a delete of the new parent plus a restore of each original, the
  // ops a delete's Undo is built from. Restored in ascending stored position,
  // so each index is correct at the moment it is reinserted.
  toast('Wrapped ' + (picked.length === 1 ? "" : picked.length + " items ") + 'in "' + trimmed + '"', {
    label: "Undo",
    onClick: () => {
      shownChildrenIds.delete(newParentId);
      applyEdit({ type: "delete", id: newParentId });
      for (const { index, todo } of snapshots) applyEdit({ type: "restore", index, todo });
    },
  });
}

function toggleSubTodo(parentId, childId) {
  applyEdit({ type: "toggleSub", parentId, childId, now: new Date().toISOString() });
}

// `toIndex` is a target index within the array *after* the moved item is
// removed from it (see attachDragReorder's dropIndex, and applyOp's splice
// pair above) — not its final resting index in some other frame.
function reorderTodo(id, toIndex) {
  applyEdit({ type: "reorder", id, toIndex });
}

function reorderSubTodo(parentId, childId, toIndex) {
  applyEdit({ type: "reorderSub", parentId, childId, toIndex, now: new Date().toISOString() });
}

function deleteSubTodo(parentId, childId) {
  applyEdit({ type: "deleteSub", parentId, childId, now: new Date().toISOString() });
}

// An item is addressed as { id, parentId }, with parentId null for a
// top-level one — the one shape the edit page can hold for either level.
// Looked up afresh every time rather than kept, because a sync replaces
// `todos` wholesale and a held object would be a detached copy.
function findEntity(ref) {
  return findInList(todos, ref.id, ref.parentId);
}

function findInList(list, id, parentId) {
  if (!parentId) return list.find((t) => t.id === id) || null;
  const parent = list.find((t) => t.id === parentId);
  return (parent && parent.children && parent.children.find((c) => c.id === id)) || null;
}

function editOp(ref, patch) {
  const now = new Date().toISOString();
  return ref.parentId
    ? { type: "editSub", parentId: ref.parentId, childId: ref.id, now, patch }
    : { type: "edit", id: ref.id, now, patch };
}

// What an entity holds now for each field a patch would change — which is
// exactly the patch that puts it back. `icon` travels with `text`, and
// `due_time` with `due_date`, the same pairs applyPatch treats as one.
function patchSnapshot(entity, patch) {
  const back = {};
  if ("text" in patch) { back.text = entity.text; back.icon = entity.icon || null; }
  if ("bold" in patch) back.bold = !!entity.bold;
  if ("urgent" in patch) back.urgent = !!entity.urgent;
  if ("display" in patch) back.display = entity.display || "count";
  if ("due_date" in patch) { back.due_date = entity.due_date || null; back.due_time = entity.due_time || null; }
  return back;
}

function pressOp(ref, type, ats) {
  return { type, id: ref.id, parentId: ref.parentId || null, ats, now: new Date().toISOString() };
}

// One press of a counter's +. Mis-taps are easy, so it offers an Undo,
// which takes back exactly that press.
function pressCounter(ref) {
  const at = new Date().toISOString();
  applyEdit(pressOp(ref, "press", [at]));
  toast("Counted", { label: "Undo", onClick: () => applyEdit(pressOp(ref, "unpress", [at])) });
}

// `userId` is a device id from `users`, or null to unassign.
function assignWithUndo(ref, userId) {
  const entity = findEntity(ref);
  if (!entity || (entity.assigned_to || null) === userId) return;
  const before = entity.assigned_to || null;
  const op = (who) => ref.parentId
    ? { type: "assignSub", parentId: ref.parentId, childId: ref.id, userId: who, now: new Date().toISOString() }
    : { type: "assign", id: ref.id, userId: who, now: new Date().toISOString() };
  applyEdit(op(userId));
  const user = userId && findUser(userId);
  toast(userId ? "Assigned to " + ((user && user.name) || "Unnamed") : "Unassigned", {
    label: "Undo",
    onClick: () => applyEdit(op(before)),
  });
}

// Puts a copy of an item — sub-items included — right below it, as a quick
// way to start a new list from an old one. Every copy gets fresh ids: ops
// address items by id alone (sub-items by parent + child id), so a copy
// sharing one would have every later edit land on whichever came first.
// The copy starts un-done, and its sub-items with it, because a list being
// reused is a list being started again; everything else is carried over.
// It rides the existing "restore"/"restoreSub" ops, which insert at an
// index, and is undone by an ordinary delete of the copy.
function duplicateWithUndo(ref) {
  const entity = findEntity(ref);
  if (!entity) return;
  const now = new Date().toISOString();
  const fresh = (item) => {
    const copy = JSON.parse(JSON.stringify(item));
    copy.id = crypto.randomUUID();
    copy.created_at = now;
    copy.updated_at = now;
    if (isCounter(copy)) copy.presses = [];
    else if (copy.type !== "note") copy.done = false;
    delete copy.done_at;
    if (copy.children) copy.children = copy.children.map(fresh);
    return copy;
  };
  const copy = fresh(entity);
  if (ref.parentId) {
    const parent = todos.find((t) => t.id === ref.parentId);
    const index = parent.children.indexOf(entity) + 1;
    applyEdit({ type: "restoreSub", parentId: ref.parentId, index, now, todo: copy });
    toast('Duplicated "' + entity.text + '"', {
      label: "Undo",
      onClick: () => applyEdit({ type: "deleteSub", parentId: ref.parentId, childId: copy.id, now: new Date().toISOString() }),
    });
  } else {
    applyEdit({ type: "restore", index: todos.indexOf(entity) + 1, todo: copy });
    toast('Duplicated "' + entity.text + '"', {
      label: "Undo",
      onClick: () => {
        shownChildrenIds.delete(copy.id);
        applyEdit({ type: "delete", id: copy.id });
      },
    });
  }
}

// Deletes immediately (swipe has no separate confirm step) but snapshots the
// item first and offers an Undo toast that re-adds it via a fresh applyEdit
// push — this works correctly even if the delete has already synced to
// Dropbox by the time Undo is tapped, since it never tries to cancel/splice
// an already-queued or already-flushed op.
function deleteTodoWithUndo(id) {
  const index = todos.findIndex((t) => t.id === id);
  if (index === -1) return;
  const snapshot = JSON.parse(JSON.stringify(todos[index]));
  deleteTodo(id);
  // Stale local-only UI state (open assign panel, expanded children)
  // would otherwise linger keyed to this id and reappear if it's undone.
  assigningIds.delete(id);
  shownChildrenIds.delete(id);
  toast('Deleted "' + snapshot.text + '"', {
    label: "Undo",
    onClick: () => applyEdit({ type: "restore", index, todo: snapshot }),
  });
}

function deleteSubTodoWithUndo(parentId, childId) {
  const parent = todos.find((t) => t.id === parentId);
  const index = parent && parent.children ? parent.children.findIndex((c) => c.id === childId) : -1;
  if (index === -1) return;
  const snapshot = JSON.parse(JSON.stringify(parent.children[index]));
  deleteSubTodo(parentId, childId);
  assigningIds.delete(childId);
  toast('Deleted "' + snapshot.text + '"', {
    label: "Undo",
    // parent may have been deleted meanwhile — applyOp's "restoreSub" case
    // already no-ops silently if the parent id isn't found.
    onClick: () => applyEdit({ type: "restoreSub", parentId, index, now: new Date().toISOString(), todo: snapshot }),
  });
}

async function unlockWithPassphrase(passphrase, remember) {
  el("passphraseError").textContent = "";
  showScreen("loading");
  el("loadingText").textContent = "Unlocking...";
  try {
    const key = await deriveKeyFromPassphrase(passphrase);
    cryptoKey = key;
    // allowOfflineFallback=false: this passphrase has never been validated
    // online before, so a network failure must not "succeed" against stale
    // cached data — it should surface as an error instead (see loadAndRender).
    await bootstrapBoards(false);
    await loadAndRender(false); // throws if the passphrase is wrong (decrypt/auth-tag failure) or unreachable
    if (remember) {
      localStorage.setItem(LS_KEY_CACHE, await exportKeyToBase64(key));
    } else {
      localStorage.removeItem(LS_KEY_CACHE);
    }
  } catch (err) {
    console.error(err);
    cryptoKey = null;
    showScreen("passphrase");
    el("passphraseError").textContent = "Wrong passphrase, or the data is corrupted.";
  }
}

async function tryStoredKey() {
  const cached = localStorage.getItem(LS_KEY_CACHE);
  if (!cached) return false;
  try {
    cryptoKey = await importKeyFromBase64(cached);
    if (showCachedStart()) return true;
    // allowOfflineFallback=true: this key was only ever cached after a prior
    // successful online unlock, so it's safe to trust offline.
    await bootstrapBoards(true);
    await loadAndRender(true);
    return true;
  } catch (err) {
    console.error(err);
    if (err.isKeyError) {
      // The cached key genuinely doesn't decrypt the remote doc — drop it
      // and fall back to the passphrase screen.
      localStorage.removeItem(LS_KEY_CACHE);
      cryptoKey = null;
      return false;
    }
    // Some other failure (offline, Dropbox token refresh failed, etc).
    // The cached key is still good — don't force a passphrase re-entry,
    // just let the user retry the load.
    showScreen("loading");
    el("loadingText").textContent = "Couldn't reach Dropbox. Check your connection and retry.";
    el("loadingRetryBtn").hidden = false;
    return true;
  }
}

// The fast open: with a remembered key and this device's copies of the list
// of lists and of the last open board, draw from those straight away and
// fetch both from Dropbox behind them. Only reached with a key that was
// cached after a successful online unlock, so trusting local copies
// decrypted under it is the same call loadAndRender's offline fallback
// makes. Returns false when a copy is missing, for the ordinary load.
function showCachedStart() {
  const manifest = loadManifestCache();
  if (!manifest || !manifest.boards || manifest.boards.length === 0) return false;
  boards = manifest.boards;
  users = manifest.users || [];
  manifestUpdatedAt = manifest.updated_at;
  currentBoard = pickInitialBoard();
  el("headerTitle").textContent = currentBoard.label;
  renderTabs();
  if (!showCachedBoard()) return false;
  refreshAfterCachedStart();
  return true;
}

async function refreshAfterCachedStart() {
  try {
    await ensureManifest(true);
  } catch (err) {
    console.error(err);
    if (err.isKeyError) lockWithWrongKey();
    else setSyncState("error");
    return;
  }
  // The list of lists may have changed elsewhere: renamed, re-iconed,
  // re-sorted, or the open board deleted.
  const board = boards.find((b) => b.id === currentBoard.id);
  if (!board) {
    currentBoard = pickInitialBoard();
    localStorage.setItem(LS_ACTIVE_BOARD, currentBoard.id);
    el("headerTitle").textContent = currentBoard.label;
    renderTabs();
    if (!showCachedBoard()) await loadAndRender(true);
    return;
  }
  currentBoard = board;
  el("headerTitle").textContent = currentBoard.label;
  renderTabs();
  syncChain = syncChain.then(refreshOpenBoard);
}

function wireEvents() {
  el("appVersionRow").textContent = "App version v" + CONFIG.APP_VERSION;

  const savedTheme = localStorage.getItem(LS_THEME) || "system";
  el("themeSelect").value = savedTheme;
  applyTheme(savedTheme); // syncs themeColorMeta; [data-theme] itself was already set by index.html's inline script
  el("themeSelect").onchange = (e) => setTheme(e.target.value);

  el("connectBtn").onclick = () => DropboxAuth.startLogin();

  el("passphraseForm").onsubmit = (e) => {
    e.preventDefault();
    unlockWithPassphrase(el("passphraseInput").value, el("rememberKey").checked);
  };

  // The add bar is static markup (not rebuilt by render()), so unlike the
  // per-item mode toggle there's no re-render to lose typed text to —
  // cycling just updates a closure-local mode and the button/input in
  // place. Sticky across adds, matching subAddMode's per-parent behavior.
  let addMode = "todo";
  const addNoteModeBtn = el("addNoteModeBtn");
  const addInput = el("addInput");
  addNoteModeBtn.onclick = () => {
    addMode = nextAddMode(addMode);
    styleAddModeBtn(addNoteModeBtn, addMode);
    addInput.placeholder = addModePlaceholder(addMode, false);
  };

  // The new item lands right above the add row, which keeps focus for the
  // next one; scrolling keeps the row in view as the list grows under it.
  const submitAdd = () => {
    addTodo(addInput.value, addMode);
    addInput.value = "";
    el("addForm").scrollIntoView({ block: "nearest" });
  };
  // Enter used to implicitly submit this form back when it held a single
  // text field and a type="submit" button. Now that the "N" toggle button
  // also lives in the form, browsers no longer treat Enter as a submit
  // trigger (a <button> in a form suppresses that fallback) — handle Enter
  // directly instead of depending on it. addTodo's own trim-check makes
  // this safe to also leave wired to onsubmit for any path that does still
  // fire native submission (e.g. an on-screen keyboard's "Go" action): a
  // second call lands on an already-cleared input and no-ops.
  addInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    submitAdd();
  });
  // A multi-line paste is read straight off the clipboard, because this is a
  // single-line <input>: the browser strips the newlines before the value is
  // readable, which would silently collapse a 30-line list into one item.
  // Anything shorter than two lines falls through to an ordinary paste.
  addInput.addEventListener("paste", (e) => {
    const raw = (e.clipboardData || window.clipboardData).getData("text");
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    bulkAdd(lines, addMode);
  });
  el("addForm").onsubmit = (e) => {
    e.preventDefault();
    submitAdd();
  };

  const searchInput = el("searchInput");
  searchInput.addEventListener("input", () => setSearch(searchInput.value));
  // Enter (the keyboard's search key) only puts the keyboard away: the list
  // already filters as you type. Escape clears.
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchInput.blur(); }
    if (e.key === "Escape") setSearch("");
  });
  el("searchClearBtn").onclick = () => { setSearch(""); searchInput.focus(); };

  el("refreshBtn").onclick = () => {
    // Retries the sync if there's an unsynced edit, and otherwise catches the
    // list up in the background, without a loading screen over it.
    syncChain = syncChain.then(refreshOpenBoard);
  };

  let getUserColor = () => CONFIG.USER_COLORS[0];
  el("settingsBtn").onclick = () => {
    closeBoardPage(); // always open on the main view, whatever was last shown
    const me = users.find((u) => u.id === deviceId);
    el("userNameInput").value = (me && me.name) || "";
    getUserColor = wireColorPicker(el("userColorPicker"), (me && me.color) || CONFIG.USER_COLORS[0]);
    el("settingsPanel").classList.add("open");
    refreshUpdateButtonLabel();
  };

  el("userNameForm").onsubmit = (e) => {
    e.preventDefault();
    setMyIdentity(el("userNameInput").value, getUserColor());
  };
  el("closeSettingsBtn").onclick = () => el("settingsPanel").classList.remove("open");
  el("settingsPanel").onclick = (e) => {
    if (e.target === el("settingsPanel")) el("settingsPanel").classList.remove("open");
  };

  // The edit page's back: the system back pops the entry openEditPage
  // pushed, and Escape is the same back press on desktop.
  window.addEventListener("popstate", onEditPageBack);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editState) history.back();
  });

  el("boardPageBackBtn").onclick = () => closeBoardPage();
  el("boardPageDoneBtn").onclick = () => {
    closeBoardPage();
    el("settingsPanel").classList.remove("open");
  };

  // Committed on blur/Enter rather than with a Save button — the icon
  // swatches save on tap too, so the page has no "unsaved" state at all.
  el("boardTitleInput").onchange = () => {
    const board = boards.find((b) => b.id === boardPageId);
    if (board) renameBoard(board.id, el("boardTitleInput").value, board.icon);
  };

  // Saved on toggle, like the icon swatches. If the manifest write fails
  // the checkbox would be left showing a state that never landed, so it is
  // put back from the board record either way.
  const wireSortToggle = (elementId, key) => {
    el(elementId).onchange = async (e) => {
      const id = boardPageId;
      await setBoardSort(id, key, e.target.checked);
      const board = boards.find((b) => b.id === id);
      if (board && boardPageId === id) e.target.checked = !!board[key];
    };
  };
  wireSortToggle("sortPendingInput", "sort_pending_first");
  wireSortToggle("sortDueInput", "sort_due_first");

  el("boardExportBtn").onclick = () => exportBoard(boardPageId);
  el("boardDeleteBtn").onclick = () => deleteBoard(boardPageId);

  // Visible counterpart to the add-bar paste shortcut. A <textarea> keeps its
  // newlines natively, so this path needs no clipboard interception and works
  // the same on desktop — and unlike the paste gesture, it is discoverable.
  el("importForm").onsubmit = async (e) => {
    e.preventDefault();
    const lines = el("importText").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    // bulkAdd works on the open board, so import into any other one has to
    // switch to it first — which is what the user wants to be looking at
    // once the items land anyway.
    const targetId = boardPageId;
    // Close first: bulkAdd confirms, then renders the result behind this sheet.
    closeBoardPage();
    el("settingsPanel").classList.remove("open");
    el("importText").value = "";
    if (targetId) await switchBoard(targetId);
    bulkAdd(lines, "todo");
  };

  el("disconnectBtn").onclick = () => {
    const warning = pendingOps.length > 0
      ? "You have unsynced changes that haven't reached Dropbox yet. Disconnecting will lose them. Disconnect anyway?"
      : "Disconnect this device from Dropbox? You can reconnect any time.";
    if (!confirm(warning)) return;
    DropboxAuth.unlink();
    localStorage.removeItem(LS_KEY_CACHE);
    localStorage.removeItem(LS_ACTIVE_BOARD);
    for (const b of boards) clearPersistedQueue(b.id);
    cryptoKey = null;
    boards = [];
    currentBoard = null;
    todos = [];
    pendingOps = [];
    el("settingsPanel").classList.remove("open");
    showScreen("connect");
  };

  el("forgetKeyBtn").onclick = () => {
    localStorage.removeItem(LS_KEY_CACHE);
    toast("This device will ask for the passphrase next time.");
  };

  el("forceUpdateBtn").onclick = () => forceUpdate();

  el("loadingRetryBtn").onclick = () => tryStoredKey();
}

// APP_VERSION is only bumped on deploys that also change the shell cache
// name (see the comment on APP_VERSION in config.js) — plenty of smaller
// fixes ship without a bump, so a version number match here doesn't
// guarantee this device is byte-for-byte current, only that no
// cache-invalidating deploy has landed since. Fetched with cache: "no-store"
// so this check itself isn't answered by the very service-worker cache
// it's trying to detect staleness of.

let updateVersion = null; // deployed version, when newer than this device's
let lastUpdateCheck = 0;
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;

// Reads the deployed APP_VERSION and lights the gear's dot if it differs
// from what this device is running. Never throws: offline is the ordinary
// case here (the app runs from a service-worker cache), and a failed check
// just leaves whatever the last one concluded.
async function checkForUpdate() {
  lastUpdateCheck = Date.now();
  try {
    const res = await fetch("config.js?_=" + Date.now(), { cache: "no-store" });
    const text = await res.text();
    const match = text.match(/APP_VERSION:\s*"([^"]+)"/);
    if (match) updateVersion = match[1] === CONFIG.APP_VERSION ? null : match[1];
  } catch (err) {
    console.error(err); // offline or unreachable — keep the previous verdict
  }
  el("settingsBtn").classList.toggle("has-update", updateVersion !== null);
}

async function refreshUpdateButtonLabel() {
  const btn = el("forceUpdateBtn");
  if (btn.disabled) return; // an update is already in progress
  await checkForUpdate();
  // Same amber as the gear's dot, so the thing the dot sent the user here
  // to find is visibly the same signal rather than one plain row among the
  // several this sheet already has.
  btn.classList.toggle("update-ready", updateVersion !== null);
  btn.textContent = updateVersion ? "Update to v" + updateVersion : "Check for update";
}

// Unregisters the service worker and clears its caches, then reloads —
// a lighter alternative to Android's "Clear storage" that only forces fresh
// app files (index.html/app.js/etc.) without touching localStorage, so the
// cached passphrase key and Dropbox refresh token survive and you don't get
// logged out just to pick up a new deploy.
// Same list as sw.js's SHELL_FILES (minus the icons, which never change
// often enough to matter here) — re-fetched below with cache: "reload" so
// GitHub Pages' several-minutes-long HTTP cache-control on these files
// doesn't leave location.reload() serving stale bytes even after the
// service worker itself is gone and its own Cache Storage is cleared.
const SHELL_FILE_URLS = ["./", "./index.html", "./config.js", "./crypto.js", "./dropbox.js", "./app.js", "./manifest.json"];

async function forceUpdate() {
  const btn = el("forceUpdateBtn");
  btn.disabled = true;
  btn.textContent = "Updating...";
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) await reg.unregister();
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const key of keys) await caches.delete(key);
    }
    await Promise.all(SHELL_FILE_URLS.map((u) => fetch(u, { cache: "reload" }).catch(() => {})));
  } finally {
    location.reload();
  }
}

async function main() {
  wireEvents();

  try {
    await DropboxAuth.handleRedirectIfPresent();
  } catch (err) {
    console.error(err);
    toast("Dropbox login failed. Please try again.");
  }

  if (!DropboxAuth.isLinked()) {
    showScreen("connect");
    return;
  }

  const unlocked = await tryStoredKey();
  if (!unlocked) {
    showScreen("passphrase");
  }

  // An installed PWA can sit in the background for days, so one check at
  // startup isn't enough — but it's also the only moment a phone reliably
  // gives us, so re-check when the app is brought back to the foreground,
  // rate-limited so flipping between apps isn't a stream of requests.
  checkForUpdate();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) return;
    checkForUpdate();
  });
}

document.addEventListener("DOMContentLoaded", main);
