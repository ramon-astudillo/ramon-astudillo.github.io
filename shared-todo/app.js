// UI + sync orchestration. Wires together dropbox.js and crypto.js.

const LS_KEY_CACHE = "shared_todo_key_cache";

let cryptoKey = null;   // CryptoKey, derived from the passphrase
let todos = [];         // in-memory list, mirrors what's on Dropbox after a successful sync
let loadedUpdatedAt = null; // updated_at of the version we last read from Dropbox

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

function render() {
  const list = el("todoList");
  list.innerHTML = "";
  const sorted = [...todos].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const todo of sorted) {
    const li = document.createElement("li");
    li.className = "todo-item";

    const check = document.createElement("button");
    check.className = "todo-check" + (todo.done ? " done" : "");
    check.innerHTML = '<svg viewBox="0 0 24 24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    check.onclick = () => toggleTodo(todo.id);

    const text = document.createElement("span");
    text.className = "todo-text" + (todo.done ? " done" : "");
    text.textContent = todo.text;

    const del = document.createElement("button");
    del.className = "todo-del";
    del.textContent = "×";
    del.onclick = () => deleteTodo(todo.id);

    li.append(check, text, del);
    list.appendChild(li);
  }
  el("todoList").hidden = false;
  el("emptyState").hidden = sorted.length !== 0;
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
  render();
  updateSyncStatus(new Date());
  showScreen("list");
}

// Applies one local edit using read-check-write (spec section 6, step 2).
// `mutate` receives the freshly-fetched todos array and modifies it in place.
async function applyEdit(mutate) {
  try {
    const remoteDoc = await fetchRemoteDoc();

    if (remoteDoc.updated_at !== loadedUpdatedAt) {
      todos = remoteDoc.todos;
      loadedUpdatedAt = remoteDoc.updated_at;
      render();
      toast("List changed elsewhere — reloading latest. Please redo your edit.");
      return;
    }

    mutate(remoteDoc.todos);
    remoteDoc.updated_at = new Date().toISOString();

    const text = await encryptPayload(cryptoKey, remoteDoc);
    await DropboxFile.upload(text);

    todos = remoteDoc.todos;
    loadedUpdatedAt = remoteDoc.updated_at;
    render();
    updateSyncStatus(new Date());
  } catch (err) {
    console.error(err);
    toast("Sync failed — check your connection and try again.");
  }
}

function addTodo(text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const now = new Date().toISOString();
  applyEdit((list) => {
    list.push({ id: crypto.randomUUID(), text: trimmed, done: false, created_at: now, updated_at: now });
  });
}

function toggleTodo(id) {
  applyEdit((list) => {
    const t = list.find((x) => x.id === id);
    if (t) { t.done = !t.done; t.updated_at = new Date().toISOString(); }
  });
}

function deleteTodo(id) {
  applyEdit((list) => {
    const idx = list.findIndex((x) => x.id === id);
    if (idx > -1) list.splice(idx, 1);
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

  el("refreshBtn").onclick = () => loadAndRender();

  el("settingsBtn").onclick = () => el("settingsPanel").classList.add("open");
  el("closeSettingsBtn").onclick = () => el("settingsPanel").classList.remove("open");
  el("settingsPanel").onclick = (e) => {
    if (e.target === el("settingsPanel")) el("settingsPanel").classList.remove("open");
  };

  el("disconnectBtn").onclick = () => {
    if (!confirm("Disconnect this device from Dropbox? You can reconnect any time.")) return;
    DropboxAuth.unlink();
    localStorage.removeItem(LS_KEY_CACHE);
    cryptoKey = null;
    todos = [];
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
