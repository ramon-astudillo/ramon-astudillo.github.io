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

  // A small, generic, public icon set. Boards reference one of these keys
  // from the (private, encrypted) manifest — the icon glyphs themselves
  // carry no meaning about what any given board is used for.
  ICONS: {
    list: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>',
    check: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><polyline points="8 12 11 15 16 9"></polyline></svg>',
    star: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
    flag: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>',
    bell: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>',
    book: '<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>',
  },
};
