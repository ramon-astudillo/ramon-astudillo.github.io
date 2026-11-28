// Photo app: browse, search and label the archive. Labels only: nothing
// here moves, edits or deletes a photo (see dropbox.js). Spec: pomot task
// "Add web app" (ImageRepo), decisions of 2026-11-27.

const Backend = new URLSearchParams(location.search).has("mock") ? MockBackend : DropboxBackend;

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function lsGet(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* private mode: keep going */ }
}

// -- small IndexedDB key/value store (index + thumbnails) ----------------------

const Store = (() => {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open("photos", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("kv");
          req.result.createObjectStore("thumbs");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function op(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  return {
    get: (store, key) => op(store, "readonly", (s) => s.get(key)).catch(() => undefined),
    put: (store, key, value) => op(store, "readwrite", (s) => s.put(value, key)).catch(() => undefined),
  };
})();

// -- the index -----------------------------------------------------------------

const Index = {
  rows: [],
  byHash: new Map(),
  built: "",

  async load(onStatus) {
    let rev = null;
    try {
      rev = await Backend.indexRev();
    } catch (e) {
      onStatus("Offline: using the saved photo list");
    }
    const cached = await Store.get("kv", "index");
    let bytes;
    if (cached && (rev === null || cached.rev === rev)) {
      bytes = cached.bytes;
    } else {
      onStatus("Downloading the photo list…");
      bytes = await Backend.indexBytes();
      await Store.put("kv", "index", { rev, bytes });
    }
    const text = await new Response(new Blob([bytes]).stream()
      .pipeThrough(new DecompressionStream("gzip"))).text();
    const data = JSON.parse(text);
    const col = {};
    data.cols.forEach((c, i) => (col[c] = i));
    this.built = data.built;
    this.rows = data.rows.map((r) => {
      const p = r[col.p];
      const d = r[col.d];
      return {
        p, h: r[col.h], s: r[col.s], d, ds: r[col.ds], k: r[col.k],
        pat: r[col.pat], dev: r[col.dev], al: r[col.al],
        name: p.slice(p.lastIndexOf("/") + 1),
        folder: p.slice(0, p.lastIndexOf("/")),
      };
    });
    this.byHash = new Map(this.rows.map((r) => [r.h, r]));
  },
};

// -- labels: append-only event logs, one per phone ------------------------------

const Labels = {
  device: null,
  user: null,
  own: [],          // this phone's events (also in localStorage)
  others: {},       // file name -> events
  state: new Map(), // content hash -> { fav, del, tags:Set, date, place, move, last }
  dirty: false,
  saving: null,
  lastSync: null,
  syncError: null,

  init() {
    this.device = lsGet("photos_device");
    if (!this.device) {
      this.device = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      lsSet("photos_device", this.device);
    }
    this.user = lsGet("photos_user");
    this.own = JSON.parse(lsGet("photos_events") || "[]");
    this.dirty = lsGet("photos_dirty") === "1";
    this.replay();
  },

  file() {
    return this.device + ".jsonl";
  },

  parse(text) {
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  },

  // Reads every phone's log. Our own file is merged by event id, so a phone
  // whose storage was cleared gets its history back.
  async pull() {
    const files = await Backend.listEventFiles();
    for (const f of files) {
      const events = this.parse(await Backend.readEvents(f.name));
      if (f.name === this.file()) {
        const have = new Set(this.own.map((e) => e.id));
        const missing = events.filter((e) => !have.has(e.id));
        if (missing.length) {
          this.own = this.own.concat(missing).sort(byTime);
          this.persistLocal();
        }
      } else {
        this.others[f.name] = events;
      }
    }
    this.lastSync = new Date();
    this.replay();
  },

  async push() {
    if (!this.dirty) return;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      try {
        await Backend.writeEvents(this.file(), this.own.map((e) => JSON.stringify(e)).join("\n") + "\n");
        this.dirty = false;
        lsSet("photos_dirty", "0");
        this.syncError = null;
        this.lastSync = new Date();
      } catch (e) {
        this.syncError = e.message;
      } finally {
        this.saving = null;
        UI.syncBadge();
      }
    })();
    return this.saving;
  },

  persistLocal() {
    lsSet("photos_events", JSON.stringify(this.own));
  },

  add(row, op, fields) {
    const e = Object.assign({
      id: this.device + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6),
      t: new Date().toISOString(),
      by: this.user || "?",
      h: row.h,
      p: row.p,
      op,
    }, fields);
    this.own.push(e);
    this.persistLocal();
    this.dirty = true;
    lsSet("photos_dirty", "1");
    this.applyOne(e);
    UI.syncBadge();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 1500);
  },

  replay() {
    this.state = new Map();
    let all = this.own;
    for (const k in this.others) all = all.concat(this.others[k]);
    all.sort(byTime).forEach((e) => this.applyOne(e));
  },

  get(h) {
    return this.state.get(h) || null;
  },

  // Last write wins, per photo and per kind of label (per tag for tags).
  applyOne(e) {
    let s = this.state.get(e.h);
    if (!s) {
      s = { fav: false, del: false, tags: new Set(), date: "", place: null, move: "", last: null };
      this.state.set(e.h, s);
    }
    if (e.op === "fav") s.fav = !!e.on;
    else if (e.op === "del") s.del = !!e.on;
    else if (e.op === "tag") e.on ? s.tags.add(e.tag) : s.tags.delete(e.tag);
    else if (e.op === "date") s.date = e.d || "";
    else if (e.op === "place") s.place = e.place ? { place: e.place, lat: e.lat, lon: e.lon } : null;
    else if (e.op === "move") s.move = e.to || "";
    s.last = e;
  },

  allTags() {
    const n = new Map();
    for (const s of this.state.values()) for (const t of s.tags) n.set(t, (n.get(t) || 0) + 1);
    return Array.from(n.keys()).sort();
  },

  allPlaces() {
    const n = new Set();
    for (const s of this.state.values()) {
      if (!s.place) continue;
      // "A > B > C" offers "A" and "A > B" too.
      const parts = s.place.place.split(">").map((x) => x.trim());
      for (let i = 1; i <= parts.length; i++) n.add(parts.slice(0, i).join(" > "));
    }
    return Array.from(n).sort();
  },
};

function byTime(a, b) {
  return a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The date a photo is shown under: a person's date beats the index's.
function dateOf(row) {
  const s = Labels.get(row.h);
  return (s && s.date) || row.d;
}

// -- search --------------------------------------------------------------------

const Search = {
  filters() {
    const f = {};
    $$("#filters [name]").forEach((el) => {
      f[el.name] = el.type === "checkbox" ? el.checked : el.value.trim();
    });
    return f;
  },

  match(f) {
    let re = null;
    if (f.regex) re = new RegExp(f.regex, "i"); // a bad pattern throws; caller shows it
    const fromY = f.from ? parseInt(f.from, 10) : null;
    const toY = f.to ? parseInt(f.to, 10) : null;
    const place = f.place.toLowerCase();
    return Index.rows.filter((r) => {
      const s = Labels.get(r.h);
      const d = dateOf(r);
      if (f.undated) {
        if (d) return false;
      } else if (fromY || toY) {
        const y = d ? parseInt(d.slice(0, 4), 10) : null;
        if (!y || (fromY && y < fromY) || (toY && y > toY)) return false;
      }
      if (f.month && d.slice(5, 7) !== f.month.padStart(2, "0")) return false;
      if (f.day && d.slice(8, 10) !== f.day.padStart(2, "0")) return false;
      if (f.album === "dated" && r.al) return false;
      if (f.album && f.album !== "dated" && r.al !== f.album) return false;
      if (f.pat && r.pat !== f.pat) return false;
      if (f.dev && r.dev !== f.dev) return false;
      if (f.kind && r.k !== f.kind) return false;
      if (f.tag && !(s && s.tags.has(f.tag))) return false;
      if (place && !(s && s.place && s.place.place.toLowerCase().includes(place))) return false;
      if (f.label) {
        if (f.label === "none" && s && (s.fav || s.del || s.tags.size || s.date || s.place || s.move)) return false;
        if (f.label === "fav" && !(s && s.fav)) return false;
        if (f.label === "del" && !(s && s.del)) return false;
        if (f.label === "move" && !(s && s.move)) return false;
        if (f.label === "date" && !(s && s.date)) return false;
        if (f.label === "place" && !(s && s.place)) return false;
        if (f.hidedel && s && s.del) return false;
        if (f.label === "tagged" && !(s && s.tags.size)) return false;
      }
      if (!f.label || f.label !== "del") {
      }
      if (re && !re.test(r.p)) return false;
      return true;
    });
  },

  // Samples of one search are drawn without replacement: "New sample" shows
  // only photos this search has not shown yet, until all have been seen.
  seen: { key: "", hashes: new Set() },

  run(resample) {
    const f = this.filters();
    let found;
    try {
      found = this.match(f);
    } catch (e) {
      $("#result-count").textContent = "Bad name pattern: " + e.message;
      UI.grid([]);
      return;
    }
    let shown = found;
    let note;
    if (found.length > CONFIG.EXHAUSTIVE_LIMIT) {
      const key = JSON.stringify(f);
      if (!resample || this.seen.key !== key) this.seen = { key, hashes: new Set() };
      let left = found.filter((r) => !this.seen.hashes.has(r.h));
      if (!left.length) {
        this.seen.hashes.clear();
        left = found;
      }
      shown = sample(left, CONFIG.SAMPLE_SIZE);
      shown.forEach((r) => this.seen.hashes.add(r.h));
      note = found.length.toLocaleString() + " photos: showing a random " + shown.length +
        " (" + this.seen.hashes.size.toLocaleString() + " seen)";
      $("#resample").hidden = false;
    } else {
      note = found.length + (found.length === 1 ? " photo" : " photos");
      $("#resample").hidden = true;
    }
    // A sample is always shown in time order ("Random" would be random twice).
    sortRows(shown, shown !== found && f.sort === "random" ? "old" : f.sort);
    $("#result-count").textContent = note;
    UI.grid(shown);
    lsSet("photos_filters", JSON.stringify(f));
  },
};

function sample(rows, n) {
  const a = rows.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Time order, photos with no date first either way.
function sortRows(rows, how) {
  if (how === "random") return;
  const dir = how === "old" ? 1 : -1;
  rows.sort((a, b) => {
    const da = dateOf(a), db = dateOf(b);
    if (!da !== !db) return da ? 1 : -1;
    return da < db ? -dir : da > db ? dir : a.p < b.p ? -1 : 1;
  });
}

// -- app update (as in SharedTODO) --------------------------------------------
// Reads the deployed config.js past every cache; a different APP_VERSION
// lights a dot on ⚙ and turns Settings' button into "Update to vN", which
// drops the service worker and its cache and reloads. Labels, the photo list,
// thumbnails and the Dropbox login stay (IndexedDB/localStorage).

const SHELL_URLS = ["./", "./index.html", "./config.js", "./dropbox.js", "./app.js", "./sw.js", "./manifest.json"];

const Update = {
  version: null, // the deployed version, when it differs from this one
  last: 0,

  async check(verbose) {
    this.last = Date.now();
    try {
      const text = await (await fetch("config.js?_=" + Date.now(), { cache: "no-store" })).text();
      const m = text.match(/APP_VERSION:\s*"([^"]+)"/);
      if (m) this.version = m[1] === CONFIG.APP_VERSION ? null : m[1];
    } catch (e) {
      if (verbose) UI.toast("Could not check: offline?");
    }
    $("#gear").classList.toggle("has-update", this.version !== null);
    const btn = $("#s-update");
    if (btn && !btn.disabled) {
      btn.classList.toggle("update-ready", this.version !== null);
      btn.textContent = this.version ? "Update to v" + this.version : "Check for update";
      if (verbose && !this.version) UI.toast("Up to date");
    }
  },

  async apply() {
    const btn = $("#s-update");
    btn.disabled = true;
    btn.textContent = "Updating…";
    await Labels.push();
    try {
      if ("serviceWorker" in navigator) {
        for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
      }
      if ("caches" in window) for (const k of await caches.keys()) await caches.delete(k);
      await Promise.all(SHELL_URLS.map((u) => fetch(u, { cache: "reload" }).catch(() => {})));
    } finally {
      location.reload();
    }
  },
};

// -- photo of the day ----------------------------------------------------------

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// The same photo on both phones: picked from the date alone, among photos
// sorted by path. Labels can change the pool (favourites, places), so the
// phones agree once both have synced.
const Daily = {
  categories(today) {
    const md = today.slice(5);
    const year = parseInt(today.slice(0, 4), 10);
    const usable = Index.rows.filter((r) => !(Labels.get(r.h) || {}).del && r.k === "photo");
    const onThisDay = usable.filter((r) => {
      const d = dateOf(r);
      return d.length >= 10 && d.slice(5, 10) === md && parseInt(d, 10) < year;
    });
    const favs = usable.filter((r) => (Labels.get(r.h) || {}).fav);
    const placed = usable.filter((r) => (Labels.get(r.h) || {}).place);
    const seed = hashString(today);
    const years = Array.from(new Set(usable.map((r) => dateOf(r).slice(0, 4)).filter(Boolean))).sort();
    const pickYear = years.length ? years[seed % years.length] : null;
    const inYear = usable.filter((r) => pickYear && dateOf(r).startsWith(pickYear));
    return [
      { key: "day", title: "On this day", rows: onThisDay },
      { key: "fav", title: "A favourite", rows: favs },
      { key: "place", title: "A place", rows: placed },
      { key: "year", title: "From " + pickYear, rows: inYear },
    ].filter((c) => c.rows.length);
  },

  pick(today) {
    const cats = this.categories(today);
    if (!cats.length) return null;
    const seed = hashString(today);
    // "On this day" whenever there is one; the others take turns.
    const cat = cats[0].key === "day" && seed % 3 !== 0 ? cats[0] : cats[seed % cats.length];
    const rows = cat.rows.slice().sort((a, b) => (a.p < b.p ? -1 : 1));
    return { cat, row: rows[hashString(today + cat.key) % rows.length], all: cats };
  },
};

function todayString() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// -- thumbnails ----------------------------------------------------------------

const Thumbs = {
  queue: new Map(), // path -> [img elements]
  timer: null,
  memo: new Map(),

  async want(img, row) {
    const hit = this.memo.get(row.p) || (await Store.get("thumbs", row.h));
    if (hit) {
      this.memo.set(row.p, hit);
      img.src = hit;
      return;
    }
    if (!this.queue.has(row.p)) this.queue.set(row.p, []);
    this.queue.get(row.p).push({ img, row });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 60);
  },

  async flush() {
    const batch = Array.from(this.queue.entries()).slice(0, 25);
    batch.forEach(([p]) => this.queue.delete(p));
    if (!batch.length) return;
    if (this.queue.size) this.timer = setTimeout(() => this.flush(), 60);
    let got = {};
    try {
      got = await Backend.thumbs(batch.map(([p]) => p));
    } catch (e) {
      UI.toast("Thumbnails: " + e.message);
    }
    for (const [p, waiters] of batch) {
      const url = got[p];
      for (const w of waiters) {
        if (url) w.img.src = url;
        else w.img.closest(".tile").classList.add("nothumb");
      }
      if (url) {
        this.memo.set(p, url);
        if (url.startsWith("data:")) Store.put("thumbs", waiters[0].row.h, url);
      }
    }
  },
};

// -- UI ------------------------------------------------------------------------

const UI = {
  list: [],   // what the grid shows, for prev/next in the viewer
  at: -1,
  observer: null,

  toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (t.hidden = true), 3500);
  },

  show(view) {
    $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
    $$("nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    lsSet("photos_view", view);
    if (view === "settings") this.settings();
  },

  syncBadge() {
    const b = $("#sync");
    if (Labels.syncError) {
      b.textContent = "⚠";
      b.title = Labels.syncError;
    } else if (Labels.dirty) {
      b.textContent = "…";
      b.title = "Labels not saved to Dropbox yet";
    } else {
      b.textContent = "✓";
      b.title = Labels.lastSync ? "Saved " + Labels.lastSync.toLocaleTimeString() : "";
    }
  },

  grid(rows) {
    this.list = rows;
    const g = $("#grid");
    g.innerHTML = "";
    if (this.observer) this.observer.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const tile = en.target;
        this.observer.unobserve(tile);
        Thumbs.want($("img", tile), rows[tile.dataset.i]);
      }
    }, { root: $("main"), rootMargin: "400px" });
    rows.forEach((r, i) => {
      const s = Labels.get(r.h);
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.dataset.i = i;
      tile.innerHTML = '<img alt="">' +
        (r.k === "video" ? '<span class="badge vid">▶</span>' : "") +
        (s && s.fav ? '<span class="badge fav">★</span>' : "") +
        (s && s.del ? '<span class="badge del">🗑</span>' : "");
      tile.onclick = () => this.open(i);
      g.appendChild(tile);
      this.observer.observe(tile);
    });
  },

  // Re-draws the badges of one tile after a label changes.
  refreshTile(i) {
    const tile = $('#grid .tile[data-i="' + i + '"]');
    if (!tile) return;
    const r = this.list[i];
    const s = Labels.get(r.h);
    $$(".badge.fav,.badge.del", tile).forEach((b) => b.remove());
    if (s && s.fav) tile.insertAdjacentHTML("beforeend", '<span class="badge fav">★</span>');
    if (s && s.del) tile.insertAdjacentHTML("beforeend", '<span class="badge del">🗑</span>');
  },

  open(i, list) {
    if (list) this.list = list;
    this.at = i;
    $("#viewer").hidden = false;
    document.body.classList.add("noscroll");
    this.drawViewer();
  },

  close() {
    $("#viewer").hidden = true;
    document.body.classList.remove("noscroll");
    $("#v-media").innerHTML = "";
  },

  step(d) {
    const n = this.at + d;
    if (n < 0 || n >= this.list.length) return;
    this.at = n;
    this.drawViewer();
  },

  async drawViewer() {
    const r = this.list[this.at];
    const media = $("#v-media");
    media.innerHTML = '<div class="loading">…</div>';
    $("#v-pos").textContent = (this.at + 1) + " / " + this.list.length;
    this.drawInfo();
    if (r.k === "video") {
      try {
        const link = await Backend.link(r.p);
        if (this.list[this.at] !== r) return;
        media.innerHTML = '<video controls playsinline preload="metadata"></video>';
        $("video", media).src = link;
      } catch (e) {
        media.innerHTML = '<div class="loading">' + esc(e.message) + "</div>";
      }
      return;
    }
    let url = null;
    try {
      url = (await Backend.thumbs([r.p], "w2048h1536"))[r.p];
    } catch (e) {
      url = null;
    }
    if (this.list[this.at] !== r) return;
    if (!url) {
      media.innerHTML = '<div class="loading">No preview for this file. <button id="v-orig">Open original</button></div>';
      $("#v-orig").onclick = async () => window.open(await Backend.link(r.p), "_blank");
      return;
    }
    media.innerHTML = '<img alt="">';
    $("img", media).src = url;
  },

  drawInfo() {
    const r = this.list[this.at];
    const s = Labels.get(r.h) || { fav: false, del: false, tags: new Set(), date: "", place: null, move: "" };
    const d = dateOf(r);
    const src = s.date ? "set by hand" : { exif: "camera", video: "video", name: "file name", folder: "folder", none: "unknown" }[r.ds] || r.ds;
    $("#v-fav").classList.toggle("on", s.fav);
    $("#v-del").classList.toggle("on", s.del);
    $("#v-info").innerHTML =
      '<div class="when">' + esc(d || "Date unknown") + ' <span class="muted">(' + esc(src) + ")</span></div>" +
      '<div class="muted path">' + esc(r.p) + "</div>" +
      '<div class="muted">' + esc([r.dev, r.k === "video" ? "video" : "", Math.round(r.s / 1024) + " KB"].filter(Boolean).join(" · ")) + "</div>" +
      (s.place ? '<div>📍 ' + esc(s.place.place) + (s.place.lat != null ? ' <span class="muted">(' + s.place.lat + ", " + s.place.lon + ")</span>" : "") + "</div>" : "") +
      (s.move ? '<div>➜ move to ' + esc(s.move) + ' <span class="muted">(requested)</span></div>' : "") +
      (s.del ? '<div>🗑 <span class="muted">marked to delete (a request only)</span></div>' : "") +
      '<div class="chips">' + Array.from(s.tags).sort().map((t) =>
        '<span class="chip">' + esc(t) + ' <button data-untag="' + esc(t) + '" aria-label="remove">×</button></span>').join("") + "</div>" +
      (s.last ? '<div class="muted small">Last change: ' + esc(s.last.by) + ", " + esc(new Date(s.last.t).toLocaleString()) + "</div>" : "");
    $$("[data-untag]").forEach((b) => (b.onclick = () => this.label("tag", { tag: b.dataset.untag, on: false })));
  },

  label(op, fields) {
    const r = this.list[this.at];
    Labels.add(r, op, fields);
    this.drawInfo();
    this.refreshTile(this.at);
  },

  // A small form sheet for date / place / move / tag.
  ask(kind) {
    const r = this.list[this.at];
    const s = Labels.get(r.h) || {};
    const sheet = $("#sheet");
    const forms = {
      tag: {
        title: "Add a tag",
        html: '<input name="v" list="dl-tags" placeholder="e.g. beach, family" autocomplete="off">',
        ok: (f) => f.v && this.label("tag", { tag: f.v.toLowerCase(), on: true }),
      },
      date: {
        title: "Date taken",
        html: '<input name="v" placeholder="YYYY, YYYY-MM or YYYY-MM-DD" value="' + esc(s.date || "") + '" inputmode="numeric">' +
          '<p class="muted small">Shown instead of the date from the camera or folder. The photo is not changed.</p>',
        ok: (f) => {
          if (f.v && !/^(19|20)\d\d(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/.test(f.v)) {
            UI.toast("Use YYYY, YYYY-MM or YYYY-MM-DD");
            return false;
          }
          this.label("date", { d: f.v });
        },
        clear: () => this.label("date", { d: "" }),
      },
      place: {
        title: "Place",
        html: '<input name="v" list="dl-places" placeholder="Country > City > Place, or any text" value="' + esc(s.place ? s.place.place : "") + '" autocomplete="off">' +
          '<input name="coords" placeholder="Coordinates, optional: 38.71, -9.13" value="' + esc(s.place && s.place.lat != null ? s.place.lat + ", " + s.place.lon : "") + '">',
        ok: (f) => {
          if (!f.v) return;
          let lat, lon;
          if (f.coords) {
            const m = f.coords.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (!m) {
              UI.toast("Coordinates as: latitude, longitude");
              return false;
            }
            lat = parseFloat(m[1]);
            lon = parseFloat(m[2]);
          }
          const place = f.v.split(">").map((x) => x.trim()).filter(Boolean).join(" > ");
          this.label("place", lat == null ? { place } : { place, lat, lon });
        },
        clear: () => this.label("place", { place: "" }),
      },
      move: {
        title: "Ask to move to",
        html: '<input name="v" list="dl-folders" placeholder="/Pictures/YYYY/MM" value="' + esc(s.move || "") + '" autocomplete="off">' +
          '<p class="muted small">A request only: nothing is moved by this app.</p>',
        ok: (f) => f.v && this.label("move", { to: f.v }),
        clear: () => this.label("move", { to: "" }),
      },
    };
    const form = forms[kind];
    this.datalists();
    sheet.innerHTML = '<form><h3>' + form.title + "</h3>" + form.html +
      '<div class="row"><button type="submit" class="primary">Save</button>' +
      (form.clear ? '<button type="button" data-clear>Clear</button>' : "") +
      '<button type="button" data-cancel>Cancel</button></div></form>';
    sheet.hidden = false;
    const f = $("form", sheet);
    $("input", f).focus();
    f.onsubmit = (ev) => {
      ev.preventDefault();
      const vals = {};
      $$("input", f).forEach((i) => (vals[i.name] = i.value.trim()));
      if (form.ok(vals) !== false) sheet.hidden = true;
    };
    $("[data-cancel]", f).onclick = () => (sheet.hidden = true);
    if (form.clear) $("[data-clear]", f).onclick = () => { form.clear(); sheet.hidden = true; };
  },

  datalists() {
    const opts = (arr) => arr.map((v) => '<option value="' + esc(v) + '">').join("");
    $("#dl-tags").innerHTML = opts(Labels.allTags());
    $("#dl-places").innerHTML = opts(Labels.allPlaces());
    if (!this.folders) {
      this.folders = Array.from(new Set(Index.rows.map((r) => r.folder))).sort();
    }
    $("#dl-folders").innerHTML = opts(this.folders);
  },

  // Fills the search form's fixed lists from the index.
  filterOptions() {
    const count = (key) => {
      const n = new Map();
      Index.rows.forEach((r) => r[key] && n.set(r[key], (n.get(r[key]) || 0) + 1));
      return Array.from(n.entries()).sort((a, b) => b[1] - a[1]);
    };
    const fill = (name, pairs, first) => {
      $('#filters [name="' + name + '"]').innerHTML = '<option value="">' + first + "</option>" +
        pairs.map(([v, n]) => '<option value="' + esc(v) + '">' + esc(v) + " (" + n.toLocaleString() + ")</option>").join("");
    };
    fill("pat", count("pat"), "Any name pattern");
    fill("dev", count("dev"), "Any device");
    $('#filters [name="album"]').innerHTML = '<option value="">Dated and albums</option><option value="dated">Dated only</option>' +
      count("al").map(([v, n]) => '<option value="' + esc(v) + '">Album: ' + esc(v) + " (" + n + ")</option>").join("");
    this.tagOptions();
  },

  tagOptions() {
    const sel = $('#filters [name="tag"]');
    const cur = sel.value;
    sel.innerHTML = '<option value="">Any tag</option>' + Labels.allTags().map((t) => '<option>' + esc(t) + "</option>").join("");
    sel.value = cur;
  },

  restoreFilters() {
    let f = null;
    try { f = JSON.parse(lsGet("photos_filters") || "null"); } catch (e) { f = null; }
    if (!f) return;
    $$("#filters [name]").forEach((el) => {
      if (!(el.name in f)) return;
      if (el.type === "checkbox") el.checked = f[el.name];
      else el.value = f[el.name];
    });
  },

  async today() {
    const t = todayString();
    const pick = Daily.pick(t);
    const box = $("#daily");
    if (!pick) {
      box.innerHTML = '<p class="muted">No photos yet.</p>';
      return;
    }
    const r = pick.row;
    const d = dateOf(r);
    let caption = pick.cat.title;
    if (pick.cat.key === "day") {
      const ago = parseInt(t, 10) - parseInt(d, 10);
      caption = "On this day, " + d.slice(0, 4) + " (" + ago + (ago === 1 ? " year" : " years") + " ago)";
    }
    box.innerHTML = '<h2>' + esc(caption) + '</h2><button class="daily-photo"><img alt=""></button>' +
      '<div class="muted">' + esc(d || "Date unknown") + "</div>";
    const img = $("img", box);
    try {
      const url = (await Backend.thumbs([r.p], "w1024h768"))[r.p];
      if (url) img.src = url;
    } catch (e) {
      UI.toast(e.message);
    }
    $(".daily-photo", box).onclick = () => this.open(0, [r]);
    // The rest of today's "on this day", as a strip.
    const day = pick.all.find((c) => c.key === "day");
    const strip = $("#daily-more");
    strip.innerHTML = "";
    if (day && day.rows.length > 1) {
      const rows = day.rows.filter((x) => x !== r);
      sortRows(rows, "old");
      const shown = rows.length > 60 ? sample(rows, 60).sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : 1)) : rows;
      strip.innerHTML = "<h3>More from this day (" + rows.length + ")</h3>";
      const g = document.createElement("div");
      g.className = "strip";
      shown.forEach((x, i) => {
        const tile = document.createElement("button");
        tile.className = "tile";
        tile.innerHTML = '<img alt=""><span class="badge yr">' + esc(dateOf(x).slice(0, 4)) + "</span>";
        tile.onclick = () => this.open(i, shown);
        g.appendChild(tile);
        Thumbs.want($("img", tile), x);
      });
      strip.appendChild(g);
    }
  },

  settings() {
    const box = $("#settings-body");
    const linked = (a) => (a.isLinked() ? "connected" : "not connected");
    let n = 0;
    for (const s of Labels.state.values()) if (s.fav || s.del || s.tags.size || s.date || s.place || s.move) n++;
    box.innerHTML =
      "<h3>You</h3><p>" + esc(Labels.user || "?") + ' <button id="s-name">Change</button></p>' +
      (Backend.mock ? '<p class="warn">Mock mode: test data from the dev server, not Dropbox.</p>' :
        "<h3>Dropbox</h3><p>Photos (read only): " + linked(Auth.viewer) + "<br>Labels: " + linked(Auth.labels) +
        '</p><p><button id="s-disconnect">Disconnect this phone</button></p>') +
      "<h3>Photos</h3><p>" + Index.rows.length.toLocaleString() + " photos, list built " + esc(Index.built) + "</p>" +
      "<h3>Labels</h3><p>" + n.toLocaleString() + " labelled photos. This phone: " + Labels.own.length + " changes" +
      (Labels.dirty ? " (not all saved yet)" : "") + ". Other phones: " + Object.keys(Labels.others).length + "</p>" +
      (Labels.syncError ? '<p class="warn">Last save failed: ' + esc(Labels.syncError) + "</p>" : "") +
      '<p><button id="s-sync">Sync now</button> <button id="s-export">Download all labels</button></p>' +
      '<h3>App</h3><p>Version ' + esc(CONFIG.APP_VERSION) + ' <button id="s-update">Check for update</button></p>';
    $("#s-update").onclick = () => (Update.version ? Update.apply() : Update.check(true));
    Update.check(false);
    $("#s-name").onclick = () => askName(true);
    $("#s-sync").onclick = () => syncNow(true);
    $("#s-export").onclick = () => {
      let all = Labels.own;
      for (const k in Labels.others) all = all.concat(Labels.others[k]);
      const blob = new Blob([all.sort(byTime).map((e) => JSON.stringify(e)).join("\n") + "\n"], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "photo-labels-" + todayString() + ".jsonl";
      a.click();
    };
    const dis = $("#s-disconnect");
    if (dis) dis.onclick = () => {
      Auth.viewer.unlink();
      Auth.labels.unlink();
      location.reload();
    };
  },
};

function askName(force) {
  if (Labels.user && !force) return;
  const sheet = $("#sheet");
  sheet.innerHTML = '<form><h3>Who is using this phone?</h3><input name="v" placeholder="Your name" value="' +
    esc(Labels.user || "") + '" autocomplete="off"><p class="muted small">Saved with every label you add.</p>' +
    '<div class="row"><button type="submit" class="primary">OK</button></div></form>';
  sheet.hidden = false;
  const f = $("form", sheet);
  $("input", f).focus();
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const v = $("input", f).value.trim();
    if (!v) return;
    Labels.user = v;
    lsSet("photos_user", v);
    sheet.hidden = true;
    if ($("#view-settings").hidden === false) UI.settings();
  };
}

async function syncNow(loud) {
  try {
    await Labels.push();
    await Labels.pull();
    UI.tagOptions();
    UI.syncBadge();
    if (loud) UI.toast("Labels up to date");
  } catch (e) {
    Labels.syncError = e.message;
    UI.syncBadge();
    if (loud) UI.toast("Sync failed: " + e.message);
  }
}

// -- start ---------------------------------------------------------------------

function connectScreen() {
  const box = $("#connect");
  box.hidden = false;
  const steps = [
    ["viewer", "1. Connect the photos (read only)"],
    ["labels", "2. Connect the labels folder"],
  ];
  box.innerHTML = "<h2>Connect to Dropbox</h2><p>Log in with the photos' Dropbox account. Two steps, once per phone.</p>" +
    steps.map(([k, t]) => '<p><button class="primary" data-k="' + k + '"' + (Auth[k].isLinked() ? " disabled" : "") + ">" +
      t + (Auth[k].isLinked() ? " ✓" : "") + "</button></p>").join("");
  $$("[data-k]", box).forEach((b) => (b.onclick = () => Auth[b.dataset.k].startLogin()));
}

// Chrome's "Desktop site" lays the page out 980 px wide and shrinks it: say so.
function checkDesktopMode() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  $("#desktop-mode").hidden = !(coarse && window.innerWidth > 1.5 * Math.min(screen.width, screen.height));
}

async function start() {
  checkDesktopMode();
  Labels.init();
  if (!Backend.mock) {
    try {
      await Auth.handleRedirect();
    } catch (e) {
      UI.toast(e.message);
    }
    if (!CONFIG.VIEWER_APP_KEY || !CONFIG.LABELS_APP_KEY) {
      $("#status").textContent = "Dropbox app keys missing in config.js (webapp/README.md).";
      return;
    }
    if (!Auth.viewer.isLinked() || !Auth.labels.isLinked()) {
      $("#status").hidden = true;
      connectScreen();
      return;
    }
  }
  askName(false);
  try {
    await Index.load((msg) => ($("#status").textContent = msg));
  } catch (e) {
    $("#status").textContent = "Could not load the photo list: " + e.message;
    return;
  }
  $("#status").hidden = true;
  $("#app").hidden = false;
  UI.filterOptions();
  UI.restoreFilters();
  UI.syncBadge();
  await syncNow(false);
  UI.tagOptions();
  UI.restoreFilters();
  UI.today();
  Search.run();
  UI.show(lsGet("photos_view") === "search" ? "search" : "today");
}

function wire() {
  $$("nav button").forEach((b) => (b.onclick = () => UI.show(b.dataset.view)));
  $("#filters").onsubmit = (ev) => {
    ev.preventDefault();
    Search.run();
  };
  $("#filters").onreset = () => setTimeout(() => Search.run(), 0);
  $("#resample").onclick = () => Search.run(true);
  $("#sync").onclick = () => syncNow(true);
  $("#v-close").onclick = () => UI.close();
  $("#v-prev").onclick = () => UI.step(-1);
  $("#v-next").onclick = () => UI.step(1);
  $("#v-fav").onclick = () => {
    const s = Labels.get(UI.list[UI.at].h);
    UI.label("fav", { on: !(s && s.fav) });
  };
  $("#v-del").onclick = () => {
    const s = Labels.get(UI.list[UI.at].h);
    UI.label("del", { on: !(s && s.del) });
  };
  $$("[data-ask]").forEach((b) => (b.onclick = () => UI.ask(b.dataset.ask)));
  document.addEventListener("keydown", (ev) => {
    if ($("#viewer").hidden || !$("#sheet").hidden) return;
    if (ev.key === "ArrowLeft") UI.step(-1);
    else if (ev.key === "ArrowRight") UI.step(1);
    else if (ev.key === "Escape") UI.close();
  });
  // Swipe left/right in the viewer.
  let x0 = null;
  const media = $("#v-media");
  media.addEventListener("touchstart", (e) => (x0 = e.touches.length === 1 ? e.touches[0].clientX : null), { passive: true });
  media.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 60) UI.step(dx < 0 ? 1 : -1);
  });
  window.addEventListener("online", () => syncNow(false));
  Update.check(false);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !$("#app").hidden) syncNow(false);
    if (document.visibilityState === "visible" && Date.now() - Update.last > 15 * 60 * 1000) Update.check(false);
    if (document.visibilityState === "hidden") Labels.push();
  });
}

if ("serviceWorker" in navigator && !new URLSearchParams(location.search).has("mock")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
wire();
start();
