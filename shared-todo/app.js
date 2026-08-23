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
const editingIds = new Set(); // todo/sub-todo IDs whose rename/date edit panel is open (local UI state, not synced; ids are UUIDs so one Set covers both levels)
const shownChildrenIds = new Set(); // top-level todo IDs whose sub-todo list + add-sub-todo form is shown (local UI state, not synced)
const noteAddMode = new Set(); // top-level todo IDs whose add-sub-item form is currently in "add note" mode (local UI state, not synced)

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
  el("addBar").hidden = !isList;
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

// `todos` array order is the source of truth for display order (drag-to-
// reorder mutates it directly via the "reorder" op) — no separate sort here.
// This was already true in effect before reordering existed, since "add"
// only ever pushed to the end, so this changes nothing for existing data.
function render() {
  const list = el("todoList");
  list.innerHTML = "";
  for (const todo of todos) list.appendChild(renderTodoItem(todo));
  el("todoList").hidden = false;
  el("emptyState").hidden = todos.length !== 0;
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

function renderDaysBadge(entity) {
  if (!entity.due_date) return null;
  const { text, cls } = daysLeftLabel(entity.due_date, entity.due_time);
  const span = document.createElement("span");
  span.className = "todo-days" + (cls ? " " + cls : "");
  span.textContent = text;
  return span;
}

const EDIT_PENCIL_SVG = '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>';
const DRAG_HANDLE_SVG = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.5"></circle><circle cx="15" cy="6" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="9" cy="18" r="1.5"></circle><circle cx="15" cy="18" r="1.5"></circle></svg>';

// Builds the swipeable row (drag handle + radio + text + days badge + edit
// icon) shared by top-level todos and sub-todos. The edit icon always
// toggles the rename/date panel; `onRowClick` (top-level only) toggles the
// sub-todo list separately — the two are independent so opening one doesn't
// force the other open too. Swiping left past a threshold deletes the row
// (see attachSwipeToDelete). Returns { el, handle } rather than just the row
// element so callers can wire the handle to attachDragReorder against the
// outer <li>, which drag needs to translate as a whole (see renderTodoItem /
// renderChildrenSection).
function renderRow(entity, { isSub, onToggle, onEditToggle, onRowClick, onDelete }) {
  const wrap = document.createElement("div");
  wrap.className = "swipe-wrap";

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

  if (!isNote) {
    const check = document.createElement("button");
    check.className = "todo-check" + (isSub ? " sub-check" : "") + (entity.done ? " done" : "");
    check.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    check.onclick = (e) => { e.stopPropagation(); onToggle(); };
    row.appendChild(check);
  }

  const text = document.createElement("span");
  text.className = "todo-text" + (entity.done ? " done" : "") + (entity.bold ? " bold" : "");
  text.textContent = entity.text;

  row.appendChild(text);

  const children = entity.children || [];
  const checkableChildren = children.filter((c) => c.type !== "note");
  if (!isSub && checkableChildren.length > 0) {
    const doneCount = checkableChildren.filter((c) => c.done).length;
    const countSpan = document.createElement("span");
    countSpan.className = "todo-subcount";
    countSpan.textContent = "(" + doneCount + "/" + checkableChildren.length + ")";
    row.appendChild(countSpan);
  }

  const badge = renderDaysBadge(entity);
  if (badge) row.appendChild(badge);

  const editBtn = document.createElement("button");
  editBtn.className = "todo-edit";
  editBtn.title = "Edit";
  editBtn.innerHTML = EDIT_PENCIL_SVG;
  editBtn.onclick = (e) => { e.stopPropagation(); onEditToggle(); };
  row.appendChild(editBtn);

  if (onRowClick) row.onclick = onRowClick;
  else row.classList.add("no-row-click");

  wrap.appendChild(row);
  attachSwipeToDelete(row, onDelete);
  return { el: wrap, handle };
}

// Renders one entity (todo, sub-todo, or note) as a single Markdown-ish
// line: "- [ ]"/"- [x]" for checkable items, plain text for notes, due date
// (+ time, if set) as an ISO "@" suffix. `indent` is a tab count, so a
// top-level item's own line is unindented and its children sit one tab in.
function markdownLine(entity, indent) {
  const prefix = "\t".repeat(indent);
  const deadline = entity.due_date ? " @" + entity.due_date + (entity.due_time ? "T" + entity.due_time : "") : "";
  if (entity.type === "note") return prefix + entity.text;
  return prefix + "- [" + (entity.done ? "x" : " ") + "] " + entity.text + deadline;
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

function copyEntityMarkdown(entity) {
  if (!navigator.clipboard) {
    toast("Clipboard not available in this browser.");
    return;
  }
  navigator.clipboard.writeText(entityToMarkdown(entity)).then(
    () => toast("Copied to clipboard."),
    () => toast("Couldn't copy — clipboard access denied.")
  );
}

// Shared rename + due-date/time form used by both top-level todos and
// sub-todos. Time is optional and only meaningful when a date is set — if
// the date is cleared, any time is dropped with it; if a date is set with no
// time, callers treat that as start-of-day (00:00). The date/time pair sits
// on its own row above the text input so neither competes with it for
// width; there's no separate Cancel since tapping the edit pencil again
// already closes this panel without saving.
function renderEditForm(entity, onSave) {
  const form = document.createElement("form");
  form.className = "edit-form";

  const dateRow = document.createElement("div");
  dateRow.className = "edit-date-row";

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "edit-date";
  dateInput.value = entity.due_date || "";

  const timeInput = document.createElement("input");
  timeInput.type = "time";
  timeInput.className = "edit-time";
  timeInput.value = entity.due_time || "";

  dateRow.append(dateInput, timeInput);

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.className = "edit-text";
  textInput.value = entity.text;
  textInput.required = true;

  const btnRow = document.createElement("div");
  btnRow.className = "edit-btn-row";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-btn";
  copyBtn.textContent = "Copy";
  copyBtn.onclick = () => copyEntityMarkdown(entity);

  btnRow.append(saveBtn, copyBtn);

  form.append(dateRow, textInput, btnRow);
  form.onsubmit = (e) => {
    e.preventDefault();
    onSave({
      text: textInput.value,
      due_date: dateInput.value || null,
      due_time: dateInput.value ? (timeInput.value || null) : null,
    });
  };
  return form;
}

// Edit form for note-type sub-items: just text + a bold toggle, no
// checkbox/date fields since notes are never "done" or due. No Cancel, same
// reasoning as renderEditForm.
function renderNoteEditForm(entity, onSave) {
  const form = document.createElement("form");
  form.className = "edit-form";

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.className = "edit-text";
  textInput.value = entity.text;
  textInput.required = true;

  let bold = !!entity.bold;
  const boldBtn = document.createElement("button");
  boldBtn.type = "button";
  boldBtn.className = "bold-toggle-btn" + (bold ? " active" : "");
  boldBtn.textContent = "B";
  boldBtn.title = "Bold (for section separators)";
  boldBtn.onclick = () => {
    bold = !bold;
    boldBtn.classList.toggle("active", bold);
  };

  const btnRow = document.createElement("div");
  btnRow.className = "edit-btn-row";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "copy-btn";
  copyBtn.textContent = "Copy";
  copyBtn.onclick = () => copyEntityMarkdown(entity);

  btnRow.append(boldBtn, saveBtn, copyBtn);

  form.append(textInput, btnRow);
  form.onsubmit = (e) => {
    e.preventDefault();
    onSave({ text: textInput.value, bold });
  };
  return form;
}

// The "add a super-item" input shown above a top-level row when it's
// expanded, mirroring renderChildrenSection's add-sub-item form below it.
// Submitting wraps `todo` in a brand-new parent via promoteToSuper.
function renderParentSection(todo) {
  const section = document.createElement("div");
  section.className = "parent-section";

  const addForm = document.createElement("form");
  addForm.className = "super-add-row";

  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.placeholder = "Add a super-item...";
  addInput.autocomplete = "off";
  addForm.onsubmit = (e) => {
    e.preventDefault();
    promoteToSuper(todo.id, addInput.value);
    addInput.value = "";
  };
  addForm.appendChild(addInput);
  section.appendChild(addForm);

  return section;
}

function renderTodoItem(todo) {
  const wrap = document.createElement("li");
  wrap.className = "todo-item-wrap";

  if (shownChildrenIds.has(todo.id)) wrap.appendChild(renderParentSection(todo));

  const { el: rowEl, handle } = renderRow(todo, {
    isSub: false,
    onToggle: () => toggleTodo(todo.id),
    onEditToggle: () => { editingIds.has(todo.id) ? editingIds.delete(todo.id) : editingIds.add(todo.id); render(); },
    onRowClick: () => { shownChildrenIds.has(todo.id) ? shownChildrenIds.delete(todo.id) : shownChildrenIds.add(todo.id); render(); },
    onDelete: () => deleteTodoWithUndo(todo.id),
  });
  wrap.appendChild(rowEl);
  attachDragReorder(handle, wrap, () => Array.from(el("todoList").children), (fromIndex, toIndex) => reorderTodo(todo.id, toIndex));

  if (editingIds.has(todo.id)) {
    const panel = document.createElement("div");
    panel.className = "todo-expand";
    panel.appendChild(renderEditForm(
      todo,
      (patch) => { editTodo(todo.id, patch); editingIds.delete(todo.id); render(); }
    ));
    wrap.appendChild(panel);
  }

  if (shownChildrenIds.has(todo.id)) wrap.appendChild(renderChildrenSection(todo));

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

    for (const child of children) {
      const li = document.createElement("li");
      li.className = "sub-item-wrap" + (child.type === "note" ? " note-item-wrap" : "");

      const { el: childRowEl, handle: childHandle } = renderRow(child, {
        isSub: true,
        onToggle: () => toggleSubTodo(todo.id, child.id),
        onEditToggle: () => { editingIds.has(child.id) ? editingIds.delete(child.id) : editingIds.add(child.id); render(); },
        onDelete: () => deleteSubTodoWithUndo(todo.id, child.id),
      });
      li.appendChild(childRowEl);
      attachDragReorder(childHandle, li, () => Array.from(ul.children), (fromIndex, toIndex) => reorderSubTodo(todo.id, child.id, toIndex));

      if (editingIds.has(child.id)) {
        const panel = document.createElement("div");
        panel.className = "todo-expand";
        panel.appendChild(
          child.type === "note"
            ? renderNoteEditForm(
                child,
                (patch) => { editSubNote(todo.id, child.id, patch); editingIds.delete(child.id); render(); }
              )
            : renderEditForm(
                child,
                (patch) => { editSubTodo(todo.id, child.id, patch); editingIds.delete(child.id); render(); }
              )
        );
        li.appendChild(panel);
      }

      ul.appendChild(li);
    }
    section.appendChild(ul);
  }

  const addForm = document.createElement("form");
  addForm.className = "sub-add-row";

  const noteModeBtn = document.createElement("button");
  noteModeBtn.type = "button";
  noteModeBtn.className = "note-mode-btn" + (noteAddMode.has(todo.id) ? " active" : "");
  noteModeBtn.title = "Add a note instead of a checklist item";
  noteModeBtn.textContent = "N";
  noteModeBtn.onclick = () => {
    noteAddMode.has(todo.id) ? noteAddMode.delete(todo.id) : noteAddMode.add(todo.id);
    render();
  };

  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.placeholder = noteAddMode.has(todo.id) ? "Add a note..." : "Add a sub-item...";
  addInput.autocomplete = "off";
  addForm.onsubmit = (e) => {
    e.preventDefault();
    if (noteAddMode.has(todo.id)) addSubNote(todo.id, addInput.value);
    else addSubTodo(todo.id, addInput.value);
    addInput.value = "";
  };
  addForm.append(noteModeBtn, addInput);
  section.appendChild(addForm);

  return section;
}

// Attaches a left-swipe-to-delete gesture to `rowEl` via Pointer Events
// (unifies touch + mouse). Vertical drags are left alone so the list still
// scrolls normally; horizontal drags past SWIPE_DELETE_THRESHOLD (or a fast
// flick past a smaller distance) call `onDelete`, otherwise the row snaps
// back. Gesture state is closure-local per row, not shared module state.
const SWIPE_DEADZONE = 8;
const SWIPE_DELETE_THRESHOLD = 80;

function attachSwipeToDelete(rowEl, onDelete) {
  let startX = 0, startY = 0, startTime = 0;
  let axis = null; // null | "x" | "y", decided once past the deadzone
  let dx = 0;
  let suppressClick = false;

  rowEl.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    startX = e.clientX;
    startY = e.clientY;
    startTime = e.timeStamp;
    axis = null;
    dx = 0;
    rowEl.classList.add("dragging");
  });

  rowEl.addEventListener("pointermove", (e) => {
    if (startTime === 0) return;
    const curDx = e.clientX - startX;
    const curDy = e.clientY - startY;
    if (axis === null) {
      if (Math.abs(curDx) < SWIPE_DEADZONE && Math.abs(curDy) < SWIPE_DEADZONE) return;
      axis = Math.abs(curDx) > Math.abs(curDy) ? "x" : "y";
      if (axis === "x") rowEl.setPointerCapture(e.pointerId);
    }
    if (axis !== "x") return;
    e.preventDefault();
    dx = Math.min(0, curDx);
    rowEl.style.transform = "translateX(" + dx + "px)";
  });

  // Swallow the click a touch/mouse release synthesizes after a horizontal
  // drag, so a swipe never also toggles the expand panel.
  rowEl.addEventListener("click", (e) => {
    if (suppressClick) e.stopImmediatePropagation();
  }, true);

  const finish = (e) => {
    if (startTime === 0) return;
    const elapsed = e.timeStamp - startTime;
    rowEl.classList.remove("dragging");
    if (axis === "x") {
      const velocity = dx / Math.max(elapsed, 1);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
      if (dx < -SWIPE_DELETE_THRESHOLD || (dx < -30 && velocity < -0.5)) {
        rowEl.style.transform = "translateX(-100%)";
        setTimeout(onDelete, 150);
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
// translated as a whole so any open edit panel / children section moves with
// it. `getSiblingWraps()` is called at drag-start and must return the
// current siblings (same list: all top-level <li>s, or one parent's sub
// <li>s) in DOM order — which matches the underlying array order, since
// render() no longer re-sorts. `onDrop(fromIndex, toIndex)` fires once, on
// release, with indices into that same array; the caller applies the
// reorder to its data and re-renders (render() resets all transforms).
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
      manifest.users.push({ id: deviceId, name: null, created_at: new Date().toISOString() });
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
  manifest.users.push({ id: deviceId, name: null, created_at: new Date().toISOString() });
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

function renderTabs() {
  const bar = el("tabBar");
  bar.innerHTML = "";
  for (const b of boards) {
    const btn = document.createElement("button");
    btn.className = "tab-btn" + (currentBoard && b.id === currentBoard.id ? " active" : "");
    btn.innerHTML = CONFIG.ICONS[b.icon] || CONFIG.ICONS.list;
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
  await syncChain;
  currentBoard = boards.find((b) => b.id === id);
  localStorage.setItem(LS_ACTIVE_BOARD, currentBoard.id);
  el("headerTitle").textContent = currentBoard.label;
  renderTabs();
  await loadAndRender(true);
}

function iconPickerHtml(selected) {
  return Object.keys(CONFIG.ICONS).map((key) =>
    '<button type="button" data-icon="' + key + '" class="' + (key === selected ? "selected" : "") + '">' + CONFIG.ICONS[key] + '</button>'
  ).join("");
}

function wireIconPicker(container, initialSelected) {
  container.innerHTML = iconPickerHtml(initialSelected);
  let selected = initialSelected;
  for (const btn of container.querySelectorAll("button")) {
    btn.onclick = () => {
      selected = btn.dataset.icon;
      for (const b of container.querySelectorAll("button")) b.classList.toggle("selected", b === btn);
    };
  }
  return () => selected;
}

const expandedBoardIconPickers = new Set(); // board IDs whose icon picker is open (local UI state, not synced)

function renderManageBoards() {
  const list = el("manageBoardsList");
  list.innerHTML = "";
  for (const b of boards) {
    const row = document.createElement("div");
    row.className = "manage-board-row";

    const iconBtn = document.createElement("button");
    iconBtn.type = "button";
    iconBtn.title = "Change icon";
    iconBtn.style.cssText = "background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:6px; cursor:pointer; display:flex; color:var(--muted);";
    iconBtn.innerHTML = CONFIG.ICONS[b.icon] || CONFIG.ICONS.list;
    iconBtn.onclick = () => {
      expandedBoardIconPickers.has(b.id) ? expandedBoardIconPickers.delete(b.id) : expandedBoardIconPickers.add(b.id);
      renderManageBoards();
    };

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = b.label;
    nameInput.style.cssText = "flex:1; border:none; background:none; font-size:0.9rem; color:var(--text); padding:2px;";
    nameInput.onchange = () => renameBoard(b.id, nameInput.value, b.icon);

    const delBtn = document.createElement("button");
    delBtn.title = "Delete list";
    delBtn.textContent = "✕";
    delBtn.onclick = () => deleteBoard(b.id);

    row.append(iconBtn, nameInput, delBtn);
    list.appendChild(row);

    if (expandedBoardIconPickers.has(b.id)) {
      const picker = document.createElement("div");
      picker.className = "icon-picker";
      picker.style.marginLeft = "26px";
      picker.innerHTML = iconPickerHtml(b.icon);
      for (const btn of picker.querySelectorAll("button")) {
        btn.onclick = () => {
          expandedBoardIconPickers.delete(b.id);
          renameBoard(b.id, b.label, btn.dataset.icon);
          renderManageBoards();
        };
      }
      list.appendChild(picker);
    }
  }
}

async function addBoard(label, icon) {
  const trimmed = label.trim();
  if (!trimmed) return;
  const manifest = await fetchManifest() || emptyManifest();
  const id = crypto.randomUUID();
  manifest.boards.push({ id, label: trimmed, icon, file: "/board-" + id + ".json" });
  await saveManifest(manifest);
  renderTabs();
  renderManageBoards();
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
  renderTabs();
}

// Sets (or clears) this device's display name in the shared manifest. The
// device is normally already registered by ensureManifest on load; a
// from-scratch manifest.users entry is created here too just in case this
// runs before that's happened (e.g. a retried save after a failed load).
async function setMyName(name) {
  const trimmed = name.trim();
  const manifest = await fetchManifest() || emptyManifest();
  if (!manifest.users) manifest.users = [];
  let me = manifest.users.find((u) => u.id === deviceId);
  if (!me) {
    me = { id: deviceId, name: null, created_at: new Date().toISOString() };
    manifest.users.push(me);
  }
  me.name = trimmed || null;
  await saveManifest(manifest);
  toast(trimmed ? "Name saved." : "Name cleared.");
}

async function deleteBoard(id) {
  if (boards.length <= 1) {
    toast("Can't delete the last list.");
    return;
  }
  if (!confirm("Delete this list? Its items will no longer be reachable from here.")) return;
  const manifest = await fetchManifest() || emptyManifest();
  manifest.boards = manifest.boards.filter((b) => b.id !== id);
  await saveManifest(manifest);
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
function applyOp(list, op) {
  switch (op.type) {
    case "add":
      list.push(op.todo);
      break;
    case "toggle": {
      const t = list.find((x) => x.id === op.id);
      if (t) { t.done = !t.done; t.updated_at = op.now; }
      break;
    }
    case "delete": {
      const idx = list.findIndex((x) => x.id === op.id);
      if (idx > -1) list.splice(idx, 1);
      break;
    }
    case "edit": {
      const t = list.find((x) => x.id === op.id);
      if (!t) break;
      t.text = op.patch.text;
      if (op.patch.due_date) {
        t.due_date = op.patch.due_date;
        if (op.patch.due_time) t.due_time = op.patch.due_time; else delete t.due_time;
      } else {
        delete t.due_date;
        delete t.due_time;
      }
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
    case "editSub": {
      const parent = list.find((x) => x.id === op.parentId);
      const child = parent && parent.children && parent.children.find((c) => c.id === op.childId);
      if (!child) break;
      child.text = op.patch.text;
      if (op.patch.bold !== undefined) child.bold = op.patch.bold;
      if (op.patch.due_date) {
        child.due_date = op.patch.due_date;
        if (op.patch.due_time) child.due_time = op.patch.due_time; else delete child.due_time;
      } else {
        delete child.due_date;
        delete child.due_time;
      }
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
    // its normal conflict check/replay/push instead of discarding it.
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
function applyEdit(op) {
  applyOp(todos, op);
  render();
  pendingOps.push(op);
  persistQueue();
  syncChain = syncChain.then(syncPending);
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

    if (remoteDoc.updated_at !== loadedUpdatedAt) {
      todos = remoteDoc.todos;
      loadedUpdatedAt = remoteDoc.updated_at;
      pendingOps = [];
      persistQueue(); // keep the last-known-good cache, just with an empty queue now
      render();
      setSyncState("synced");
      toast("List changed elsewhere — reloading latest. Please redo your edit.");
      return;
    }

    for (const op of pendingOps) applyOp(remoteDoc.todos, op);
    remoteDoc.updated_at = new Date().toISOString();

    const text = await encryptPayload(cryptoKey, remoteDoc);
    await DropboxFile.upload(currentBoard.file, text);

    todos = remoteDoc.todos;
    loadedUpdatedAt = remoteDoc.updated_at;
    pendingOps = [];
    persistQueue(); // keep the last-known-good cache, just with an empty queue now
    render();
    setSyncState("synced");
  } catch (err) {
    console.error(err);
    setSyncState("error");
  }
}

function addTodo(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  applyEdit({ type: "add", todo: { id: crypto.randomUUID(), text: trimmed, done: false, created_at: now, updated_at: now } });
}

function toggleTodo(id) {
  applyEdit({ type: "toggle", id, now: new Date().toISOString() });
}

function deleteTodo(id) {
  applyEdit({ type: "delete", id });
}

// Sub-todos are one level deep only: `children` lives on a top-level todo,
// and child todos never have children of their own.
function addSubTodo(parentId, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  applyEdit({ type: "addSub", parentId, now, todo: { id: crypto.randomUUID(), text: trimmed, done: false, created_at: now, updated_at: now } });
}

// Wraps a top-level todo in a brand-new parent todo, demoting the original
// to that parent's sole child. Depth is capped at 2 (children never have
// children of their own), so if the item being wrapped already has
// sub-items, those get dropped — confirm with the user before doing that.
function promoteToSuper(id, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  if (todo.children && todo.children.length > 0) {
    const ok = confirm(
      "This item has " + todo.children.length + " sub-item(s). Making it a sub-item of a new item will remove them, since items can only be nested one level deep. Continue?"
    );
    if (!ok) return;
  }
  const now = new Date().toISOString();
  applyEdit({
    type: "wrapSuper",
    id,
    now,
    newParent: { id: crypto.randomUUID(), text: trimmed, done: false, created_at: now, updated_at: now },
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

// Note sub-items are plain text (no checkbox, no due date) used as
// separators/remarks; they reuse the "addSub"/"editSub" op types via a
// `type: "note"` tag on the child object, so no sync/op-log changes needed.
function addSubNote(parentId, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  applyEdit({ type: "addSub", parentId, now, todo: { id: crypto.randomUUID(), type: "note", text: trimmed, bold: false, created_at: now, updated_at: now } });
}

function deleteSubTodo(parentId, childId) {
  applyEdit({ type: "deleteSub", parentId, childId, now: new Date().toISOString() });
}

// Combined rename + due-date mutators for the inline edit form. `patch.due_date`
// is a "YYYY-MM-DD" string to set, or a falsy value to clear the due date.
function editTodo(id, patch) {
  const trimmed = (patch.text || "").trim();
  if (!trimmed) return;
  applyEdit({ type: "edit", id, now: new Date().toISOString(), patch: { text: trimmed, due_date: patch.due_date, due_time: patch.due_time } });
}

function editSubTodo(parentId, childId, patch) {
  const trimmed = (patch.text || "").trim();
  if (!trimmed) return;
  applyEdit({ type: "editSub", parentId, childId, now: new Date().toISOString(), patch: { text: trimmed, due_date: patch.due_date, due_time: patch.due_time } });
}

function editSubNote(parentId, childId, patch) {
  const trimmed = (patch.text || "").trim();
  if (!trimmed) return;
  applyEdit({ type: "editSub", parentId, childId, now: new Date().toISOString(), patch: { text: trimmed, bold: !!patch.bold } });
}

// Deletes immediately (swipe has no separate confirm step) but snapshots the
// item first and offers an Undo toast that re-adds it via a fresh applyEdit
// push — this works correctly even if the delete has already synced to
// Dropbox by the time Undo is tapped, since it never tries to cancel/splice
// an already-queued or already-flushed op.
function deleteTodoWithUndo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  const snapshot = JSON.parse(JSON.stringify(todo));
  deleteTodo(id);
  toast('Deleted "' + todo.text + '"', {
    label: "Undo",
    onClick: () => applyEdit({ type: "add", todo: snapshot }),
  });
}

function deleteSubTodoWithUndo(parentId, childId) {
  const parent = todos.find((t) => t.id === parentId);
  const child = parent && parent.children && parent.children.find((c) => c.id === childId);
  if (!child) return;
  const snapshot = JSON.parse(JSON.stringify(child));
  deleteSubTodo(parentId, childId);
  toast('Deleted "' + child.text + '"', {
    label: "Undo",
    // parent may have been deleted meanwhile — applyOp's "addSub" case
    // already no-ops silently if the parent id isn't found.
    onClick: () => applyEdit({ type: "addSub", parentId, now: new Date().toISOString(), todo: snapshot }),
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

  el("addForm").onsubmit = (e) => {
    e.preventDefault();
    const input = el("addInput");
    addTodo(input.value);
    input.value = "";
  };

  el("refreshBtn").onclick = () => {
    // Retry rather than reload if there's an unsynced edit — a full reload
    // would fetch the remote copy and discard what's only shown locally.
    // allowOfflineFallback=true: reaching this button means the user is
    // already past a validated unlock this session.
    if (pendingOps.length > 0) syncChain = syncChain.then(syncPending);
    else loadAndRender(true);
  };

  let getAddBoardIcon = () => "list";
  el("settingsBtn").onclick = () => {
    renderManageBoards();
    el("addBoardName").value = "";
    getAddBoardIcon = wireIconPicker(el("addBoardIconPicker"), "list");
    const me = users.find((u) => u.id === deviceId);
    el("userNameInput").value = (me && me.name) || "";
    el("settingsPanel").classList.add("open");
  };

  el("userNameForm").onsubmit = (e) => {
    e.preventDefault();
    setMyName(el("userNameInput").value);
  };
  el("closeSettingsBtn").onclick = () => el("settingsPanel").classList.remove("open");
  el("settingsPanel").onclick = (e) => {
    if (e.target === el("settingsPanel")) el("settingsPanel").classList.remove("open");
  };

  el("addBoardForm").onsubmit = (e) => {
    e.preventDefault();
    addBoard(el("addBoardName").value, getAddBoardIcon());
    el("addBoardName").value = "";
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

// Unregisters the service worker and clears its caches, then reloads —
// a lighter alternative to Android's "Clear storage" that only forces fresh
// app files (index.html/app.js/etc.) without touching localStorage, so the
// cached passphrase key and Dropbox refresh token survive and you don't get
// logged out just to pick up a new deploy.
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
}

document.addEventListener("DOMContentLoaded", main);
