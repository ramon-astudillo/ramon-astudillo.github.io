// Photo app settings. The two Dropbox app keys come from the Dropbox App
// Console (setup steps: webapp/README.md). Both are public by design (PKCE,
// no secret), like SharedTODO's.
const CONFIG = {
  // "Photo viewer": Full Dropbox, scopes files.metadata.read +
  // files.content.read ONLY. Dropbox itself refuses any write with it.
  VIEWER_APP_KEY: "afm54wm9v4l7hx7",

  // "Photo labels": App folder, scopes files.metadata.read/write +
  // files.content.read/write. Can only touch its own folder.
  LABELS_APP_KEY: "kmtgu7i9dmtbigo",

  // Must match a redirect URI registered on BOTH Dropbox apps.
  REDIRECT_URI: window.location.origin + window.location.pathname,

  // The photo list, rebuilt nightly by the indexing job.
  INDEX_PATH: "/Pictures/_app_index.json.gz",

  // In the labels app folder: one append-only log per phone.
  EVENTS_DIR: "/events",

  // Search shows every match up to this many, a random sample above it.
  EXHAUSTIVE_LIMIT: 500,
  SAMPLE_SIZE: 120,

  // Bump with sw.js CACHE_NAME on every deploy that changes these files.
  APP_VERSION: "6",
};
