// Bar Soutsu ジン最新ニュース — Service Worker
// 更新方針: ページ本体(HTML)とニュースデータ(JSON)は「ネットワーク優先」で常に最新を取得し、
//   オフライン時のみキャッシュを使う。画像などは「キャッシュ優先」で高速表示。
const CACHE_NAME = "gin-news-v5";
const CACHE_FILES = [
  "./",
  "./index.html",
  "./app.js",
  "./boot.js",
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/og-image.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CACHE_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const accept = req.headers.get("accept") || "";
  const fresh =
    req.mode === "navigate" ||
    accept.includes("text/html") ||
    url.pathname.endsWith(".json");

  if (fresh) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match("./index.html")),
        ),
    );
  } else {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
  }
});
