// UI + sync orchestration. Wires together dropbox.js and crypto.js.

const LS_KEY_CACHE = "shared_todo_key_cache";

let cryptoKey = null;   // CryptoKey, derived from the passphrase
let todos = [];         // in-memory list, includes any not-yet-synced optimistic edits
let loadedUpdatedAt = null; // updated_at of the version we last read from Dropbox
let pendingMutates = []; // edits applied locally but not yet confirmed on Dropbox
let syncChain = Promise.resolve(); // serializes background syncs so edits don't race
const expandedIds = new Set(); // todo/sub-todo IDs whose edit/add menu is currently expanded (local UI state, not synced; ids are UUIDs so one Set covers both levels)

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
  el("syncLine").hidden = !isList;
  el("settingsBtn").hidden = !isList;
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
  const text = "Last synced " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  el("syncStatus").textContent = text;
  el("settingsSyncTime").textContent = date.toLocaleString();
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

function render() {
  const list = el("todoList");
  list.innerHTML = "";
  const sorted = [...todos].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const todo of sorted) list.appendChild(renderTodoItem(todo));
  el("todoList").hidden = false;
  el("emptyState").hidden = sorted.length !== 0;
}

// Pure: maps a "YYYY-MM-DD" due date to a display label + CSS class,
// comparing at day resolution (no time component) so it's timezone-stable.
function daysLeftLabel(dueDateStr) {
  const today = new Date();
  const todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  const oneDay = 86400000;
  const dToday = new Date(todayStr + "T00:00:00");
  const dDue = new Date(dueDateStr + "T00:00:00");
  const diffDays = Math.round((dDue - dToday) / oneDay);
  if (diffDays === 0) return { text: "Today", cls: "today" };
  if (diffDays < 0) return { text: diffDays + "d", cls: "overdue" };
  return { text: diffDays + "d", cls: "" };
}

function renderDaysBadge(entity) {
  if (!entity.due_date) return null;
  const { text, cls } = daysLeftLabel(entity.due_date);
  const span = document.createElement("span");
  span.className = "todo-days" + (cls ? " " + cls : "");
  span.textContent = text;
  return span;
}

// Builds the swipeable row (radio + text + days badge) shared by top-level
// todos and sub-todos. Clicking anywhere but the radio toggles the caller's
// expand state; swiping left past a threshold deletes it (see
// attachSwipeToDelete).
function renderRow(entity, { isSub, onToggle, onExpandToggle, onDelete }) {
  const wrap = document.createElement("div");
  wrap.className = "swipe-wrap";

  const row = document.createElement("div");
  row.className = "todo-item" + (isSub ? " sub-item" : "");

  const check = document.createElement("button");
  check.className = "todo-check" + (isSub ? " sub-check" : "") + (entity.done ? " done" : "");
  check.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  check.onclick = (e) => { e.stopPropagation(); onToggle(); };

  const text = document.createElement("span");
  text.className = "todo-text" + (entity.done ? " done" : "");
  text.textContent = entity.text;

  row.append(check, text);
  const badge = renderDaysBadge(entity);
  if (badge) row.appendChild(badge);

  row.onclick = () => onExpandToggle();

  wrap.appendChild(row);
  attachSwipeToDelete(row, onDelete);
  return wrap;
}

// Shared rename + due-date form used by both top-level todos and sub-todos.
function renderEditForm(entity, onSave, onCancel) {
  const form = document.createElement("form");
  form.className = "edit-form";

  const textInput = document.createElement("input");
  textInput.type = "text";
  textInput.className = "edit-text";
  textInput.value = entity.text;
  textInput.required = true;

  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "edit-date";
  dateInput.value = entity.due_date || "";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "cancel-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = onCancel;

  form.append(textInput, dateInput, saveBtn, cancelBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    onSave({ text: textInput.value, due_date: dateInput.value || null });
  };
  return form;
}

function renderTodoItem(todo) {
  const wrap = document.createElement("li");
  wrap.className = "todo-item-wrap";

  wrap.appendChild(renderRow(todo, {
    isSub: false,
    onToggle: () => toggleTodo(todo.id),
    onExpandToggle: () => { expandedIds.has(todo.id) ? expandedIds.delete(todo.id) : expandedIds.add(todo.id); render(); },
    onDelete: () => deleteTodoWithUndo(todo.id),
  }));

  const expanded = expandedIds.has(todo.id);
  const children = todo.children || [];

  if (expanded) {
    const panel = document.createElement("div");
    panel.className = "todo-expand";

    panel.appendChild(renderEditForm(
      todo,
      (patch) => { editTodo(todo.id, patch); expandedIds.delete(todo.id); render(); },
      () => { expandedIds.delete(todo.id); render(); }
    ));

    const addForm = document.createElement("form");
    addForm.className = "sub-add-row";
    const addInput = document.createElement("input");
    addInput.type = "text";
    addInput.placeholder = "Add sub-todo...";
    addInput.autocomplete = "off";
    addForm.onsubmit = (e) => {
      e.preventDefault();
      addSubTodo(todo.id, addInput.value);
      addInput.value = "";
    };
    addForm.appendChild(addInput);
    panel.appendChild(addForm);

    wrap.appendChild(panel);

    if (children.length > 0) wrap.appendChild(renderSubList(todo));
  }

  return wrap;
}

function renderSubList(todo) {
  const ul = document.createElement("ul");
  ul.className = "sub-list";

  for (const child of todo.children || []) {
    const li = document.createElement("li");
    li.className = "sub-item-wrap";

    li.appendChild(renderRow(child, {
      isSub: true,
      onToggle: () => toggleSubTodo(todo.id, child.id),
      onExpandToggle: () => { expandedIds.has(child.id) ? expandedIds.delete(child.id) : expandedIds.add(child.id); render(); },
      onDelete: () => deleteSubTodoWithUndo(todo.id, child.id),
    }));

    if (expandedIds.has(child.id)) {
      const panel = document.createElement("div");
      panel.className = "todo-expand";
      panel.appendChild(renderEditForm(
        child,
        (patch) => { editSubTodo(todo.id, child.id, patch); expandedIds.delete(child.id); render(); },
        () => { expandedIds.delete(child.id); render(); }
      ));
      li.appendChild(panel);
    }

    ul.appendChild(li);
  }

  return ul;
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

// updated_at is null here (not a fresh timestamp) so repeated calls before
// the file exists on Dropbox compare equal — otherwise every read-check-write
// on a still-nonexistent file looks like a remote conflict.
function emptyTodoDoc() {
  return { version: 1, updated_at: null, todos: [] };
}

// Downloads + decrypts the current remote file (or a fresh empty doc if none exists yet).
async function fetchRemoteDoc() {
  const text = await DropboxFile.download();
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

// Initial load on app open (spec section 6, step 1).
async function loadAndRender() {
  showScreen("loading");
  el("loadingText").textContent = "Loading your list...";
  el("loadingRetryBtn").hidden = true;
  const doc = await fetchRemoteDoc();
  todos = doc.todos;
  loadedUpdatedAt = doc.updated_at;
  pendingMutates = []; // a fresh full reload supersedes any unsynced local queue
  render();
  updateSyncStatus(new Date());
  showScreen("list");
}

// Applies one local edit optimistically (instant render, no network wait),
// then queues it to be pushed to Dropbox in the background. `mutate` is
// applied to `todos` immediately and re-applied to a freshly-fetched remote
// copy at sync time, so it must be a pure function of the list it's given
// (no fresh IDs/timestamps generated inside it — see addTodo/toggleTodo).
function applyEdit(mutate) {
  mutate(todos);
  render();
  pendingMutates.push(mutate);
  syncChain = syncChain.then(syncPending);
}

// Flushes pendingMutates using read-check-write (spec section 6, step 2).
// Serialized via syncChain so overlapping edits don't race each other's
// Dropbox round trip. On failure (including offline), pendingMutates is
// left intact so the next edit or a manual retry (refresh button) resumes
// from where it left off — nothing already shown on screen is discarded.
async function syncPending() {
  if (pendingMutates.length === 0) return;
  setSyncState("syncing");
  try {
    const remoteDoc = await fetchRemoteDoc();

    if (remoteDoc.updated_at !== loadedUpdatedAt) {
      todos = remoteDoc.todos;
      loadedUpdatedAt = remoteDoc.updated_at;
      pendingMutates = [];
      render();
      setSyncState("synced");
      toast("List changed elsewhere — reloading latest. Please redo your edit.");
      return;
    }

    for (const mutate of pendingMutates) mutate(remoteDoc.todos);
    remoteDoc.updated_at = new Date().toISOString();

    const text = await encryptPayload(cryptoKey, remoteDoc);
    await DropboxFile.upload(text);

    todos = remoteDoc.todos;
    loadedUpdatedAt = remoteDoc.updated_at;
    pendingMutates = [];
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
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  applyEdit((list) => {
    list.push({ id, text: trimmed, done: false, created_at: now, updated_at: now });
  });
}

function toggleTodo(id) {
  const now = new Date().toISOString();
  applyEdit((list) => {
    const t = list.find((x) => x.id === id);
    if (t) { t.done = !t.done; t.updated_at = now; }
  });
}

function deleteTodo(id) {
  applyEdit((list) => {
    const idx = list.findIndex((x) => x.id === id);
    if (idx > -1) list.splice(idx, 1);
  });
}

// Sub-todos are one level deep only: `children` lives on a top-level todo,
// and child todos never have children of their own.
function addSubTodo(parentId, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  applyEdit((list) => {
    const parent = list.find((x) => x.id === parentId);
    if (!parent) return;
    if (!parent.children) parent.children = [];
    parent.children.push({ id, text: trimmed, done: false, created_at: now, updated_at: now });
    parent.updated_at = now;
  });
}

function toggleSubTodo(parentId, childId) {
  const now = new Date().toISOString();
  applyEdit((list) => {
    const parent = list.find((x) => x.id === parentId);
    const child = parent && parent.children && parent.children.find((c) => c.id === childId);
    if (!child) return;
    child.done = !child.done;
    child.updated_at = now;
    parent.updated_at = now;
  });
}

function deleteSubTodo(parentId, childId) {
  applyEdit((list) => {
    const parent = list.find((x) => x.id === parentId);
    if (!parent || !parent.children) return;
    const idx = parent.children.findIndex((c) => c.id === childId);
    if (idx > -1) {
      parent.children.splice(idx, 1);
      parent.updated_at = new Date().toISOString();
    }
  });
}

// Combined rename + due-date mutators for the inline edit form. `patch.due_date`
// is a "YYYY-MM-DD" string to set, or a falsy value to clear the due date.
function editTodo(id, patch) {
  const trimmed = (patch.text || "").trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  applyEdit((list) => {
    const t = list.find((x) => x.id === id);
    if (!t) return;
    t.text = trimmed;
    if (patch.due_date) t.due_date = patch.due_date; else delete t.due_date;
    t.updated_at = now;
  });
}

function editSubTodo(parentId, childId, patch) {
  const trimmed = (patch.text || "").trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  applyEdit((list) => {
    const parent = list.find((x) => x.id === parentId);
    const child = parent && parent.children && parent.children.find((c) => c.id === childId);
    if (!child) return;
    child.text = trimmed;
    if (patch.due_date) child.due_date = patch.due_date; else delete child.due_date;
    child.updated_at = now;
    parent.updated_at = now;
  });
}

// Deletes immediately (swipe has no separate confirm step) but snapshots the
// item first and offers an Undo toast that re-adds it via a fresh applyEdit
// push — this works correctly even if the delete has already synced to
// Dropbox by the time Undo is tapped, since it never tries to cancel/splice
// an already-queued or already-flushed mutator.
function deleteTodoWithUndo(id) {
  const todo = todos.find((t) => t.id === id);
  if (!todo) return;
  const snapshot = JSON.parse(JSON.stringify(todo));
  deleteTodo(id);
  toast('Deleted "' + todo.text + '"', {
    label: "Undo",
    onClick: () => applyEdit((list) => { list.push(snapshot); }),
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
    onClick: () => applyEdit((list) => {
      const p = list.find((x) => x.id === parentId);
      if (!p) return; // parent was also deleted meanwhile — undo silently no-ops
      if (!p.children) p.children = [];
      p.children.push(snapshot);
    }),
  });
}

async function unlockWithPassphrase(passphrase, remember) {
  el("passphraseError").textContent = "";
  showScreen("loading");
  el("loadingText").textContent = "Unlocking...";
  try {
    const key = await deriveKeyFromPassphrase(passphrase);
    cryptoKey = key;
    await loadAndRender(); // throws if the passphrase is wrong (decrypt/auth-tag failure)
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
    await loadAndRender();
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
    if (pendingMutates.length > 0) syncChain = syncChain.then(syncPending);
    else loadAndRender();
  };

  el("settingsBtn").onclick = () => el("settingsPanel").classList.add("open");
  el("closeSettingsBtn").onclick = () => el("settingsPanel").classList.remove("open");
  el("settingsPanel").onclick = (e) => {
    if (e.target === el("settingsPanel")) el("settingsPanel").classList.remove("open");
  };

  el("disconnectBtn").onclick = () => {
    const warning = pendingMutates.length > 0
      ? "You have unsynced changes that haven't reached Dropbox yet. Disconnecting will lose them. Disconnect anyway?"
      : "Disconnect this device from Dropbox? You can reconnect any time.";
    if (!confirm(warning)) return;
    DropboxAuth.unlink();
    localStorage.removeItem(LS_KEY_CACHE);
    cryptoKey = null;
    todos = [];
    pendingMutates = [];
    el("settingsPanel").classList.remove("open");
    showScreen("connect");
  };

  el("forgetKeyBtn").onclick = () => {
    localStorage.removeItem(LS_KEY_CACHE);
    toast("This device will ask for the passphrase next time.");
  };

  el("loadingRetryBtn").onclick = () => tryStoredKey();
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
