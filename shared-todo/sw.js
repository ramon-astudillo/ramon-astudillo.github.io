// Minimal app-shell cache so the page can open offline. Never touches
// Dropbox API calls or OAuth redirects — only caches this app's own files.
const CACHE_NAME = "shared-todo-shell-v41";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./config.js",
  "./crypto.js",
  "./dropbox.js",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Dropbox/OAuth requests pass straight through
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resp.clone()));
          return resp;
        })
        // If there's nothing cached yet (e.g. first visit to this exact
        // URL) and the network fetch itself fails, falling back to `cached`
        // here resolves to undefined — respondWith(undefined) isn't a valid
        // Response, which Chrome shows as a hard connection-reset error
        // page instead of a normal offline message. Always resolve to a
        // real Response.
        .catch(() => cached || new Response(
          "Offline and nothing cached yet for this page — check your connection and reload.",
          { status: 503, statusText: "Service Unavailable", headers: { "Content-Type": "text/plain" } }
        ));
      return cached || network;
    })
  );
});
