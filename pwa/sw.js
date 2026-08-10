/* WorkBuddy Desk — Service Worker（仅缓存静态外壳，业务数据存于 localStorage） */
const CACHE = "workbuddy-desk-v5";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./assets/css/styles.css",
  "./assets/js/storage.js",
  "./assets/js/persist.js",
  "./assets/js/app.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var req = e.request;
  var isNav = req.mode === "navigate";

  // 导航请求（HTML 外壳）必须 network-first：否则改版/修 bug 后用户永远拿到旧页面
  if (isNav) {
    e.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.status === 200) {
          var cp = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return resp;
      }).catch(function () {
        return caches.match(req).then(function (cached) { return cached || caches.match("./"); });
      })
    );
    return;
  }

  // 静态资源：cache-first（stale-while-revalidate）
  e.respondWith(
    caches.match(req).then(function (cached) {
      var net = fetch(req).then(function (resp) {
        if (resp && resp.status === 200 && resp.type === "basic") {
          var cp = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, cp); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || net;
    })
  );
});
