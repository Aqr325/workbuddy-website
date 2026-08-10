/**
 * persist.js — 三层持久化（L2 / L3）
 * -------------------------------------------------------------
 * L1：localStorage（主存，由 storage.js 负责，已具备命名空间隔离与配额兜底）
 * L2：IndexedDB 镜像 —— 即便用户「清除浏览数据」抹掉 localStorage，也能从 IDB 恢复
 * L3：守护进程磁盘保险箱 —— 把全量数据推送到 reminder-server 的 /api/backup，
 *     换机器 / 重装系统（只要保留服务端目录）都能完整还原。
 *
 * 设计：本文件只负责「存储动作」，不持有任何业务数据。它通过 storage.js 的
 * mirrorHook 在每次写入时把数据落到 IDB；恢复时按完整键把 IDB 内容回填 localStorage。
 */
(function (global) {
  "use strict";

  var Store = global.Store;
  var DB = "workbuddy-desk-idb";
  var STORE = "kv";
  var VERSION = 1;
  var dbp = null;

  function hasIdb() { return !!(global.indexedDB && global.IDBTransaction); }

  function open() {
    if (dbp) return dbp;
    if (!hasIdb()) return (dbp = Promise.reject(new Error("IndexedDB 不可用")));
    dbp = new Promise(function (resolve, reject) {
      var r = global.indexedDB.open(DB, VERSION);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error || new Error("IndexedDB 打开失败")); };
    });
    return dbp;
  }

  function idbPut(key, val) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readwrite");
        var rq = tx.objectStore(STORE).put(val, key);
        rq.onsuccess = function () { resolve(); };
        rq.onerror = function () { reject(rq.error); };
      });
    }).catch(function () { /* IDB 不可用时静默降级，不阻断主流程 */ });
  }

  function idbGet(key) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, "readonly");
        var rq = tx.objectStore(STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result); };
        rq.onerror = function () { reject(rq.error); };
      });
    }).catch(function () { return undefined; });
  }

  function idbKeys(prefix) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var out = [];
        var tx = db.transaction(STORE, "readonly");
        var rq = tx.objectStore(STORE).openCursor();
        rq.onsuccess = function (e) {
          var cur = e.target.result;
          if (cur) {
            if (!prefix || cur.key.indexOf(prefix) === 0) out.push(cur.key);
            cur.continue();
          } else resolve(out);
        };
        rq.onerror = function () { reject(rq.error); };
      });
    }).catch(function () { return []; });
  }

  /* 轻量校验和（FNV-1a 32 位），仅用于备份变更检测，非加密用途 */
  function checksum(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }

  /* ---------- L2：IndexedDB 镜像 ---------- */
  function initMirror() {
    if (!Store || typeof Store.onMirror !== "function") return;
    Store.onMirror(function (fullKey, value) {
      if (!hasIdb()) return;
      idbPut(fullKey, value).catch(function () {});
    });
  }

  /** 把当前内存中的全量数据快照写入 IDB（登录后调用一次，确保二级存储有底） */
  function seed(snapshot) {
    if (!hasIdb() || !snapshot) return Promise.resolve(0);
    var keys = Object.keys(snapshot);
    var chain = Promise.resolve(0);
    var n = 0;
    keys.forEach(function (k) {
      chain = chain.then(function () {
        return idbPut(k, snapshot[k]).then(function () { n++; }).catch(function () {});
      });
    });
    return chain.then(function () { return n; });
  }

  /**
   * 从 IDB 恢复缺失的 localStorage 键。仅在 localStorage 中不存在该键时才回填，
   * 不会覆盖已有数据（避免覆盖用户最新改动）。
   * @returns Promise<number> 实际恢复的键数量
   */
  function restore() {
    if (!hasIdb() || !Store) return Promise.resolve(0);
    var userPrefix = Store.prefix();
    var globalPrefix = Store.fullKeyOf("users").replace(/users$/, ""); // 即 NS
    var seen = {};
    var restored = 0;
    return idbKeys(userPrefix).then(function (userKeys) {
      return idbKeys(globalPrefix).then(function (gKeys) {
        var all = userKeys.concat(gKeys).filter(function (k) {
          if (seen[k]) return false; seen[k] = 1; return true;
        });
        return all.reduce(function (p, k) {
          return p.then(function () {
            if (Store.rawGet(k) != null) return; // 已有数据，不覆盖
            return idbGet(k).then(function (v) {
              if (v === undefined) return;
              if (Store.rawSet(k, v)) restored++;
            });
          });
        }, Promise.resolve());
      });
    }).then(function () { return restored; });
  }

  /* ---------- L3：守护进程磁盘保险箱 ---------- */
  function vaultUrl(cfg) {
    var url = (cfg && cfg.daemonUrl || "").trim().replace(/\/+$/, "");
    var token = (cfg && cfg.daemonToken || "").trim();
    return url ? { url: url, token: token } : null;
  }

  /** 推送全量数据到守护进程保险箱 */
  function backupToVault(payload, cfg) {
    var v = vaultUrl(cfg);
    if (!v) return Promise.resolve({ ok: false, reason: "no-daemon" });
    var body = JSON.stringify({
      userId: (cfg && cfg.userId) || "",
      appVersion: "3.0",
      checksum: checksum(JSON.stringify(payload)),
      payload: payload
    });
    return fetch(v.url + "/api/backup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Daemon-Token": v.token },
      body: body
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok !== false, j: j }; }); })
      .then(function (res) { return res.ok ? { ok: true, detail: res.j } : { ok: false, reason: "server", detail: res.j }; })
      .catch(function (e) { return { ok: false, reason: "network", error: String(e && e.message || e) }; });
  }

  /** 从守护进程保险箱取回最近一次全量备份 */
  function restoreFromVault(cfg) {
    var v = vaultUrl(cfg);
    if (!v) return Promise.resolve({ ok: false, reason: "no-daemon" });
    return fetch(v.url + "/api/backup/latest", {
      method: "GET",
      headers: { "X-Daemon-Token": v.token }
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok !== false, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j || !res.j.record) return { ok: false, reason: "empty" };
        return { ok: true, payload: (res.j.record.payload || null), savedAt: res.j.record.savedAt };
      })
      .catch(function (e) { return { ok: false, reason: "network", error: String(e && e.message || e) }; });
  }

  global.Persist = {
    initMirror: initMirror,
    seed: seed,
    restore: restore,
    backupToVault: backupToVault,
    restoreFromVault: restoreFromVault,
    available: hasIdb
  };
})(window);
