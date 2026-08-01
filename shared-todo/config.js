// Fill these in after creating your Dropbox app (see README.md).
const CONFIG = {
  // Dropbox App key from https://www.dropbox.com/developers/apps
  DROPBOX_APP_KEY: "bdr3pqu40eqnek1",

  // Must exactly match a redirect URI registered on the Dropbox app.
  // Defaults to wherever this page is actually being served from, so it
  // works the same on GitHub Pages and on localhost during development
  // as long as that exact URL is also registered with Dropbox.
  REDIRECT_URI: window.location.origin + window.location.pathname,

  // Fixed PBKDF2 salt. Not secret (it only needs to be consistent across
  // devices) but should be random and set once, then never changed —
  // changing it will make previously-encrypted data undecryptable.
  PBKDF2_SALT: "shared-todo-v1-3f9a2c7e1b4d6f80",

  // Path of the encrypted data file inside the Dropbox App Folder.
  TODO_FILE_PATH: "/todos.json",

  PBKDF2_ITERATIONS: 200000,
};
