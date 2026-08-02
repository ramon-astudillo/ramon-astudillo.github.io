// UI + sync orchestration. Wires together dropbox.js and crypto.js.

const LS_KEY_CACHE = "shared_todo_key_cache";

let cryptoKey = null;   // CryptoKey, derived from the passphrase
let todos = [];         // in-memory list, includes any not-yet-synced optimistic edits
let loadedUpdatedAt = null; // updated_at of the version we last read from Dropbox
let pendingMutates = []; // edits applied locally but not yet confirmed on Dropbox
let syncChain = Promise.resolve(); // serializes background syncs so edits don't race
const expandedIds = new Set(); // todo IDs whose sub-todos are currently shown (local UI state, not synced)

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

function toast(message) {
  const t = el("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 2800);
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

function renderTodoItem(todo) {
  const wrap = document.createElement("li");
  wrap.className = "todo-item-wrap";

  const row = document.createElement("div");
  row.className = "todo-item";

  const check = document.createElement("button");
  check.className = "todo-check" + (todo.done ? " done" : "");
  check.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  check.onclick = () => toggleTodo(todo.id);

  const text = document.createElement("span");
  text.className = "todo-text" + (todo.done ? " done" : "");
  text.textContent = todo.text;

  row.append(check, text);

  const children = todo.children || [];
  const expanded = expandedIds.has(todo.id);
  if (children.length > 0) {
    const doneCount = children.filter((c) => c.done).length;
    const foldBtn = document.createElement("button");
    foldBtn.className = "todo-fold";
    foldBtn.textContent = doneCount + "/" + children.length + (expanded ? " ▾" : " ▸");
    foldBtn.onclick = () => { expandedIds.has(todo.id) ? expandedIds.delete(todo.id) : expandedIds.add(todo.id); render(); };
    row.append(foldBtn);
  }

  const addSub = document.createElement("button");
  addSub.className = "todo-addsub";
  addSub.title = "Add sub-todo";
  addSub.textContent = "+";
  addSub.onclick = () => { expandedIds.add(todo.id); render(); };
  row.append(addSub);

  const del = document.createElement("button");
  del.className = "todo-del";
  del.textContent = "×";
  del.onclick = () => deleteTodo(todo.id);
  row.append(del);

  wrap.appendChild(row);
  if (expanded) wrap.appendChild(renderSubList(todo));
  return wrap;
}

function renderSubList(todo) {
  const ul = document.createElement("ul");
  ul.className = "sub-list";

  for (const child of todo.children || []) {
    const li = document.createElement("li");
    li.className = "sub-item";

    const check = document.createElement("button");
    check.className = "todo-check sub-check" + (child.done ? " done" : "");
    check.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    check.onclick = () => toggleSubTodo(todo.id, child.id);

    const text = document.createElement("span");
    text.className = "todo-text" + (child.done ? " done" : "");
    text.textContent = child.text;

    const del = document.createElement("button");
    del.className = "todo-del";
    del.textContent = "×";
    del.onclick = () => deleteSubTodo(todo.id, child.id);

    li.append(check, text, del);
    ul.appendChild(li);
  }

  const addLi = document.createElement("li");
  addLi.className = "sub-add-row";
  const form = document.createElement("form");
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add sub-todo...";
  input.autocomplete = "off";
  form.onsubmit = (e) => {
    e.preventDefault();
    addSubTodo(todo.id, input.value);
    input.value = "";
  };
  form.appendChild(input);
  addLi.appendChild(form);
  ul.appendChild(addLi);

  return ul;
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
  return decryptPayload(cryptoKey, text);
}

// Initial load on app open (spec section 6, step 1).
async function loadAndRender() {
  showScreen("loading");
  el("loadingText").textContent = "Loading your list...";
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
    localStorage.removeItem(LS_KEY_CACHE);
    cryptoKey = null;
    return false;
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
