// Dropbox access for the photo app: two OAuth2 PKCE logins (no SDK).
//
//   viewer  - Full Dropbox, READ-ONLY scopes: the index, thumbnails, photos.
//   labels  - App folder, read/write: the label logs, nothing else.
//
// The page never calls a Dropbox endpoint that moves, deletes or writes
// outside the labels app folder; with the viewer token Dropbox would refuse
// it anyway. Backend (below) is what app.js uses; Mock is the same interface
// against webapp/dev_server.py, for testing without Dropbox.

function makeAuth(name, appKey) {
  const LS_REFRESH = "photos_" + name + "_refresh_token";
  const SS_VERIFIER = "photos_" + name + "_pkce_verifier";
  let token = null;
  let expiresAt = 0;

  function b64url(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function isLinked() {
    return !!localStorage.getItem(LS_REFRESH);
  }

  function unlink() {
    localStorage.removeItem(LS_REFRESH);
    token = null;
    expiresAt = 0;
  }

  async function startLogin() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
    sessionStorage.setItem(SS_VERIFIER, verifier);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const params = new URLSearchParams({
      client_id: appKey,
      response_type: "code",
      code_challenge: b64url(new Uint8Array(digest)),
      code_challenge_method: "S256",
      redirect_uri: CONFIG.REDIRECT_URI,
      token_access_type: "offline",
      state: name,
    });
    window.location.assign("https://www.dropbox.com/oauth2/authorize?" + params);
  }

  // Exchanges ?code= when this login's state came back. The code is
  // single-use, so the URL is cleaned before the exchange.
  async function finishLogin(code) {
    const verifier = sessionStorage.getItem(SS_VERIFIER);
    sessionStorage.removeItem(SS_VERIFIER);
    const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        client_id: appKey,
        redirect_uri: CONFIG.REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    if (!resp.ok) throw new Error("Dropbox login failed: " + (await resp.text()));
    const data = await resp.json();
    localStorage.setItem(LS_REFRESH, data.refresh_token);
    token = data.access_token;
    expiresAt = Date.now() + data.expires_in * 1000;
  }

  async function getToken() {
    if (token && Date.now() < expiresAt - 60000) return token;
    const refresh = localStorage.getItem(LS_REFRESH);
    if (!refresh) throw new Error("Not connected to Dropbox (" + name + ")");
    const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: appKey }),
    });
    if (!resp.ok) {
      if (resp.status === 400 || resp.status === 401) unlink();
      throw new Error("Dropbox session ended (" + name + "): " + (await resp.text()));
    }
    const data = await resp.json();
    token = data.access_token;
    expiresAt = Date.now() + data.expires_in * 1000;
    return token;
  }

  return { name, isLinked, unlink, startLogin, finishLogin, getToken };
}

const Auth = {
  viewer: makeAuth("viewer", CONFIG.VIEWER_APP_KEY),
  labels: makeAuth("labels", CONFIG.LABELS_APP_KEY),

  // Call once on load: finishes whichever login just redirected back.
  async handleRedirect() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) return null;
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.pathname + url.search);
    const auth = Auth[state];
    if (!auth) throw new Error("Unknown login came back: " + state);
    await auth.finishLogin(code);
    return state;
  },
};

// -- Dropbox calls -------------------------------------------------------------

async function rpc(auth, endpoint, args) {
  const resp = await fetch("https://api.dropboxapi.com/2/" + endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + (await auth.getToken()), "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (resp.status === 409) return { error: await resp.json() };
  if (!resp.ok) throw new Error(endpoint + " failed: " + (await resp.text()));
  return resp.json();
}

async function contentCall(auth, endpoint, args, body) {
  const headers = {
    Authorization: "Bearer " + (await auth.getToken()),
    // Non-ASCII in this header must be escaped (Dropbox docs, "HTTP headers").
    "Dropbox-API-Arg": JSON.stringify(args).replace(/[\u007f-￿]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")),
  };
  if (body !== undefined) headers["Content-Type"] = "application/octet-stream";
  const resp = await fetch("https://content.dropboxapi.com/2/" + endpoint, { method: "POST", headers, body });
  if (resp.status === 409) return null;
  if (!resp.ok) throw new Error(endpoint + " failed: " + (await resp.text()));
  return resp;
}

// Testing on the phone over USB (adb reverse): the page is opened as
// localhost, and the photo list comes from webapp/dev_server.py instead of
// Dropbox. Photos and labels still use the real Dropbox. Never true on the
// published page.
const LOCAL_INDEX = ["localhost", "127.0.0.1"].includes(location.hostname);

const DropboxBackend = {
  mock: false,

  // The index file's revision, to skip re-downloading an unchanged one.
  async indexRev() {
    if (LOCAL_INDEX) return (await (await fetch("mock/index-rev")).text()) || null;
    const r = await rpc(Auth.viewer, "files/get_metadata", { path: CONFIG.INDEX_PATH });
    return r.error ? null : r.rev;
  },

  async indexBytes() {
    if (LOCAL_INDEX) return (await fetch("mock/index")).arrayBuffer();
    const resp = await contentCall(Auth.viewer, "files/download", { path: CONFIG.INDEX_PATH });
    if (!resp) throw new Error("No photo index on Dropbox yet (" + CONFIG.INDEX_PATH + ")");
    return resp.arrayBuffer();
  },

  // paths -> { path: dataURL or null }, up to 25 per call.
  async thumbs(paths, size) {
    const out = {};
    const resp = await fetch("https://content.dropboxapi.com/2/files/get_thumbnail_batch", {
      method: "POST",
      headers: { Authorization: "Bearer " + (await Auth.viewer.getToken()), "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: paths.map((path) => ({ path, format: "jpeg", size: size || "w256h256", mode: "fitone_bestfit" })),
      }),
    });
    if (!resp.ok) throw new Error("thumbnails failed: " + (await resp.text()));
    const data = await resp.json();
    data.entries.forEach((e, i) => {
      out[paths[i]] = e[".tag"] === "success" ? "data:image/jpeg;base64," + e.thumbnail : null;
    });
    return out;
  },

  // A 4-hour link to the original file (photos too big for a thumbnail, videos).
  async link(path) {
    const r = await rpc(Auth.viewer, "files/get_temporary_link", { path });
    if (r.error) throw new Error("Could not open " + path);
    return r.link;
  },

  async listEventFiles() {
    const r = await rpc(Auth.labels, "files/list_folder", { path: CONFIG.EVENTS_DIR });
    if (r.error) return []; // folder not made yet: no labels anywhere
    let entries = r.entries;
    let page = r;
    while (page.has_more) {
      page = await rpc(Auth.labels, "files/list_folder/continue", { cursor: page.cursor });
      entries = entries.concat(page.entries);
    }
    return entries.filter((e) => e[".tag"] === "file").map((e) => ({ name: e.name, rev: e.rev }));
  },

  async readEvents(name) {
    const resp = await contentCall(Auth.labels, "files/download", { path: CONFIG.EVENTS_DIR + "/" + name });
    return resp ? resp.text() : "";
  },

  // Only this phone's own log, overwritten whole (it only ever grows).
  async writeEvents(name, text) {
    await contentCall(Auth.labels, "files/upload",
      { path: CONFIG.EVENTS_DIR + "/" + name, mode: "overwrite", mute: true }, text);
  },
};

// Same interface, served by webapp/dev_server.py (?mock in the URL).
const MockBackend = {
  mock: true,
  async indexRev() {
    return (await (await fetch("mock/index-rev")).text()) || null;
  },
  async indexBytes() {
    return (await fetch("mock/index")).arrayBuffer();
  },
  async thumbs(paths) {
    const out = {};
    for (const p of paths) out[p] = "mock/thumb?p=" + encodeURIComponent(p);
    return out;
  },
  async link(path) {
    return "mock/thumb?big=1&p=" + encodeURIComponent(path);
  },
  async listEventFiles() {
    return (await fetch("mock/events")).json();
  },
  async readEvents(name) {
    return (await fetch("mock/events/" + encodeURIComponent(name))).text();
  },
  async writeEvents(name, text) {
    const r = await fetch("mock/events/" + encodeURIComponent(name), { method: "PUT", body: text });
    if (!r.ok) throw new Error("mock write failed");
  },
};
