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

  // Fixed, generic bootstrap path: an encrypted manifest listing the actual
  // boards (tabs) — their labels, icons, and per-board data file paths. The
  // manifest content (what the boards are actually called, how many there
  // are) lives only inside this encrypted file, never in committed code.
  BOARDS_MANIFEST_PATH: "/manifest.json",

  PBKDF2_ITERATIONS: 200000,

  // Bump alongside sw.js's CACHE_NAME suffix on every deploy that changes
  // app-shell files, so Settings can show which version a device is
  // actually running (useful for confirming an update landed).
  APP_VERSION: "39",

  // Preset swatches for a device's identity color (see Settings → Your
  // name), used to tint the assignee avatar shown on an assigned todo.
  // Picked, not hashed from the name, per explicit request — two people
  // with similar names shouldn't risk landing on similar colors.
  USER_COLORS: ["#e53935", "#fb8c00", "#c0a000", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60"],

  // A small, generic, public emoji palette offered when picking a list's
  // icon (Settings -> a list -> Icon). Which one a list actually uses lives
  // only in the encrypted manifest, and the palette itself is deliberately
  // broad and everyday, so shipping it in public code says nothing about
  // what any board is for -- the same reasoning as the icon set it replaced.
  BOARD_EMOJI: [
    "\u{1F4CB}", "\u2705", "\u2B50", "\u{1F6A9}", "\u{1F514}", "\u{1F4D7}", "\u{1F4DD}", "\u{1F5C2}\uFE0F",
    "\u{1F6D2}", "\u{1F3E0}", "\u{1F9F3}", "\u2708\uFE0F", "\u{1F381}", "\u{1F389}", "\u{1F4BC}", "\u{1F4A1}",
    "\u{1F527}", "\u{1F9F9}", "\u{1F37D}\uFE0F", "\u2615", "\u{1F43E}", "\u{1F331}", "\u{1F3CB}\uFE0F", "\u{1F3B5}",
    "\u{1F3AC}", "\u{1F4DA}", "\u{1F4B0}", "\u{1FA7A}", "\u{1F697}", "\u{1F30D}", "\u2600\uFE0F", "\u2764\uFE0F",
  ],

  // Icons of pre-emoji manifests were keys into a small SVG set; map them
  // so a board written by an older version still shows something sensible
  // without needing a migration write to the encrypted manifest.
  LEGACY_BOARD_ICONS: {
    list: "\u{1F4CB}", check: "\u2705", star: "\u2B50",
    flag: "\u{1F6A9}", bell: "\u{1F514}", book: "\u{1F4D7}",
  },
};
