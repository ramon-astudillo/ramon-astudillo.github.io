// Minimal Dropbox client: OAuth2 PKCE login + raw REST calls for one file.
// No SDK, just fetch — keeps this a dependency-free static site.

const DropboxAuth = (() => {
  const LS_REFRESH_TOKEN = "shared_todo_refresh_token";
  const SS_CODE_VERIFIER = "shared_todo_pkce_verifier";

  let accessToken = null;
  let accessTokenExpiresAt = 0; // epoch ms

  function base64UrlEncode(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function randomVerifier() {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    return base64UrlEncode(bytes);
  }

  async function challengeFromVerifier(verifier) {
    const enc = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    return base64UrlEncode(new Uint8Array(digest));
  }

  function isLinked() {
    return !!localStorage.getItem(LS_REFRESH_TOKEN);
  }

  function unlink() {
    localStorage.removeItem(LS_REFRESH_TOKEN);
    accessToken = null;
    accessTokenExpiresAt = 0;
  }

  // Redirects the browser to Dropbox's consent screen.
  async function startLogin() {
    const verifier = randomVerifier();
    sessionStorage.setItem(SS_CODE_VERIFIER, verifier);
    const challenge = await challengeFromVerifier(verifier);

    const params = new URLSearchParams({
      client_id: CONFIG.DROPBOX_APP_KEY,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: CONFIG.REDIRECT_URI,
      token_access_type: "offline", // ask for a refresh token
    });
    window.location.assign("https://www.dropbox.com/oauth2/authorize?" + params.toString());
  }

  // Call on every page load. If the URL has an OAuth `code`, exchanges it
  // for tokens and cleans the URL. Returns true if a fresh login just happened.
  async function handleRedirectIfPresent() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) return false;

    // Strip ?code=...&state=... from the address bar immediately, before
    // attempting the exchange — an auth code is single-use, so it must
    // never be left sitting in history/URL to be replayed (and fail) on
    // a later reload.
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    window.history.replaceState({}, "", url.pathname + url.search);

    const verifier = sessionStorage.getItem(SS_CODE_VERIFIER);
    sessionStorage.removeItem(SS_CODE_VERIFIER);

    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: CONFIG.DROPBOX_APP_KEY,
      redirect_uri: CONFIG.REDIRECT_URI,
      code_verifier: verifier,
    });

    const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) {
      throw new Error("Dropbox login failed: " + (await resp.text()));
    }
    const data = await resp.json();
    localStorage.setItem(LS_REFRESH_TOKEN, data.refresh_token);
    accessToken = data.access_token;
    accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
    return true;
  }

  async function refreshAccessToken() {
    const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN);
    if (!refreshToken) throw new Error("Not linked to Dropbox");

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CONFIG.DROPBOX_APP_KEY,
    });
    const resp = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!resp.ok) {
      if (resp.status === 400 || resp.status === 401) unlink();
      throw new Error("Could not refresh Dropbox session: " + (await resp.text()));
    }
    const data = await resp.json();
    accessToken = data.access_token;
    accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
    return accessToken;
  }

  // Returns a valid access token, refreshing it first if it's missing/stale.
  async function getAccessToken() {
    if (accessToken && Date.now() < accessTokenExpiresAt - 60000) return accessToken;
    return refreshAccessToken();
  }

  return { isLinked, unlink, startLogin, handleRedirectIfPresent, getAccessToken };
})();

const DropboxFile = (() => {
  // Downloads CONFIG.TODO_FILE_PATH. Returns the raw text, or null if the
  // file doesn't exist yet (first run).
  async function download() {
    const token = await DropboxAuth.getAccessToken();
    const resp = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Dropbox-API-Arg": JSON.stringify({ path: CONFIG.TODO_FILE_PATH }),
      },
    });
    if (resp.status === 409) return null; // path/not_found
    if (!resp.ok) throw new Error("Dropbox download failed: " + (await resp.text()));
    return resp.text();
  }

  // Overwrites CONFIG.TODO_FILE_PATH with `text`.
  async function upload(text) {
    const token = await DropboxAuth.getAccessToken();
    const resp = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Dropbox-API-Arg": JSON.stringify({
          path: CONFIG.TODO_FILE_PATH,
          mode: "overwrite",
          mute: true,
        }),
        "Content-Type": "application/octet-stream",
      },
      body: text,
    });
    if (!resp.ok) throw new Error("Dropbox upload failed: " + (await resp.text()));
    return resp.json();
  }

  return { download, upload };
})();
