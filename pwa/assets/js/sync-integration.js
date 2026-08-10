/*
 * sync-integration.js — 把 PWA 的 Store 桥接到 SyncEngine
 * =============================================================
 * 取代原先「整体快照 PUT」的朴素同步。职责：
 *   - Store.set 钩子：把变更按桶拆解成记录级变更（数组按 id、设置/资料按字段）入引擎。
 *   - 引擎「change」事件：合并远端数据，回调 window.Workbench.applyRemote 写回 PWA。
 *   - 登录后 start()：拉全量 + 推 outbox + 开 SSE 实时 + 定时兜底。
 *
 * 依赖（均由 app.js 挂到 window）：
 *   window.Store, window.apiFetch, window.sessionToken, window.apiBase, window.Workbench
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SyncBridge = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DEFAULT_BUCKETS = {
    profile: { mode: "fields" }, settings: { mode: "fields" },
    tasks: { mode: "lww" }, events: { mode: "lww" }, notes: { mode: "lww" }, links: { mode: "lww" },
    contacts: { mode: "lww" }, projects: { mode: "lww" }, emails: { mode: "lww" },
    interviews: { mode: "lww" }, deploys: { mode: "lww" }, prompts: { mode: "lww" }, focusLog: { mode: "lww" }
  };

  // Store 键 -> 同步桶映射（明确同步范围，排除 reminderCfg/reminderLog 等设备本地配置）
  var ARRAY_KEYS = ["tasks", "events", "notes", "links", "contacts", "projects", "emails", "interviews", "deploys", "prompts", "focusLog"];
  var SETTINGS_KEYS = { theme: "theme", focusSettings: "focus." };

  function hash(o) {
    try { var s = JSON.stringify(o); var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
    catch (e) { return Math.floor(Math.random() * 1e9); }
  }
  function ridOf(el) {
    if (el && typeof el === "object" && el.id) return String(el.id);
    if (typeof el === "number" || typeof el === "string") return "k" + String(el);
    return "h" + hash(el);
  }
  function arrayToMap(arr) {
    var m = {}; (Array.isArray(arr) ? arr : []).forEach(function (el) { m[ridOf(el)] = el; }); return m;
  }
  function flattenFocus(fs) {
    var o = {}; if (fs && typeof fs === "object") Object.keys(fs).forEach(function (k) { o["focus." + k] = fs[k]; }); return o;
  }
  function unflattenFocus(obj) {
    var fs = {}; Object.keys(obj).forEach(function (k) { if (k.indexOf("focus.") === 0) fs[k.slice(6)] = obj[k]; }); return fs;
  }

  function localStore() {
    var LS = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
    return {
      get: function (k) { if (!LS) return null; try { var v = LS.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
      set: function (k, v) { if (!LS) return; try { LS.setItem(k, JSON.stringify(v)); } catch (e) {} },
      remove: function (k) { if (LS) try { LS.removeItem(k); } catch (e) {} }
    };
  }

  function getDeviceId() {
    var LS = (typeof window !== "undefined" && window.localStorage) ? window.localStorage : null;
    if (!LS) return "dev-" + Math.random().toString(36).slice(2, 10);
    var id = LS.getItem("workbuddy.sync.deviceId");
    if (!id) { id = "dev-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); try { LS.setItem("workbuddy.sync.deviceId", id); } catch (e) {} }
    return id;
  }

  function buildRequest() {
    return function (method, path, body) {
      if (!window.apiFetch) return Promise.resolve({ ok: false });
      var opts = { method: method };
      if (body !== undefined) opts.body = JSON.stringify(body);
      return Promise.resolve(window.apiFetch(path, opts)).then(function (r) {
        try { return r.json(); } catch (e) { return { ok: false }; }
      }).catch(function () { return { ok: false }; });
    };
  }

  function buildOpenStream() {
    if (typeof window === "undefined" || !window.fetch) return null;
    return function (onEvent) {
      var closed = false, ctrl = null, retry = 0, timer = null;

      function connect() {
        if (closed) return;
        var ab = window.apiBase ? window.apiBase() : "";
        var url = ab.replace(/\/$/, "") + "/api/sync/v2/stream";
        ctrl = new AbortController();
        var headers = {};
        var t = window.sessionToken ? window.sessionToken() : "";
        if (t) headers["Authorization"] = "Bearer " + t;
        fetch(url, { headers: headers, signal: ctrl.signal, cache: "no-store" }).then(function (res) {
          if (!res.ok || !res.body) { onEvent({ type: "error" }); return scheduleReconnect(); }
          retry = 0;
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
          function pump() {
            reader.read().then(function (r) {
              if (r.done) return scheduleReconnect();   // 服务端关闭/重启 -> 重连，否则实时推送永久失效
              buf += dec.decode(r.value, { stream: true });
              var idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                var chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
                var ev = "sync", data = null;
                chunk.split("\n").forEach(function (line) {
                  if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
                  else if (line.indexOf("data:") === 0) { try { data = JSON.parse(line.slice(5).trim()); } catch (e) {} }
                });
                if (data) onEvent({ type: ev, data: data });
              }
              pump();
            }).catch(function () { scheduleReconnect(); });
          }
          pump();
        }).catch(function () { scheduleReconnect(); });
      }

      function scheduleReconnect() {
        if (closed || timer) return;
        retry = Math.min(retry + 1, 6);
        var wait = Math.min(1000 * Math.pow(2, retry - 1), 30000);   // 1s→2s→…→30s 封顶
        timer = setTimeout(function () { timer = null; connect(); }, wait);
      }

      connect();
      return function () {
        closed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { if (ctrl) ctrl.abort(); } catch (e) {}
      };
    };
  }

  function SyncBridge() {
    this.engine = null;
    this.accountId = "me";
    this._wrapped = false;
  }

  SyncBridge.prototype.init = function () {
    var self = this;
    if (this.engine) { this._wrapStore(); return this; }
    var storage = localStore();
    var Engine = (typeof window !== "undefined" && window.SyncEngine) ? window.SyncEngine : null;
    if (!Engine) { console.warn("[sync] SyncEngine 未加载"); return this; }
    this.engine = new Engine({
      buckets: DEFAULT_BUCKETS,
      storage: storage,
      request: buildRequest(),
      openStream: buildOpenStream(),
      deviceId: getDeviceId(),
      getToken: function () { return window.sessionToken ? window.sessionToken() : ""; }
    });
    this.engine.init(this._accountId());
    // 只对「远端来的变更」回写 UI；本地变更本来就已经在 Store 里了，回写只会白跑一轮渲染
    this.engine.on("change", function (e) { if (e && e.remote) self._onRemote(); });
    this._wrapStore();
    return this;
  };

  SyncBridge.prototype._accountId = function () {
    try {
      if (window.Workbench && window.Workbench.getAccountId) return window.Workbench.getAccountId();
    } catch (e) {}
    return this.accountId;
  };

  // Store.set 钩子：本地变更 -> 引擎入队
  SyncBridge.prototype._wrapStore = function () {
    var self = this;
    if (this._wrapped || !window.Store || typeof window.Store.set !== "function") return;
    var _orig = window.Store.set;
    window.Store.set = function (key, value) {
      var old = window.Store.get(key, undefined);
      var r = _orig.call(window.Store, key, value);
      if (window.__wbSyncApplying) return r;        // 远端回写时不重复入队
      try { self._onLocalChange(key, old, value); } catch (e) {}
      return r;
    };
    this._wrapped = true;
  };

  SyncBridge.prototype._onLocalChange = function (key, oldVal, newVal) {
    var eng = this.engine; if (!eng) return;
    var now = Date.now();
    if (ARRAY_KEYS.indexOf(key) >= 0) {
      var ob = arrayToMap(oldVal), nb = arrayToMap(newVal);
      Object.keys(nb).forEach(function (rid) {
        var changed = !ob[rid] || JSON.stringify(ob[rid]) !== JSON.stringify(nb[rid]);
        if (changed) eng.localChange(key, rid, nb[rid], { v: now });
      });
      Object.keys(ob).forEach(function (rid) {
        if (!nb[rid]) eng.localDelete(key, rid);
      });
    } else if (key === "theme" || key === "focusSettings") {
      var changedFields = {};
      if (key === "theme") changedFields.theme = newVal;
      else {
        var of = oldVal || {}, nf = newVal || {};
        Object.keys(nf).forEach(function (f) { if (JSON.stringify(of[f]) !== JSON.stringify(nf[f])) changedFields["focus." + f] = nf[f]; });
      }
      if (!Object.keys(changedFields).length) return;
      var full = Object.assign({}, flattenFocus(window.Store.get("focusSettings", {})), { theme: window.Store.get("theme", "light") });
      var fv = {}; Object.keys(changedFields).forEach(function (f) { fv[f] = now; });
      eng.localChange("settings", "_", full, { fv: fv, pushValue: changedFields });
    }
  };

  // 资料同步（由 app.js 在登录/改资料后调用）
  SyncBridge.prototype.syncProfile = function () {
    var eng = this.engine; if (!eng || !window.Workbench) return;
    var p = window.Workbench.getProfile ? window.Workbench.getProfile() : null;
    if (!p) return;
    // 只推「与引擎已知值不同」的字段。若每次登录都给全部字段打上最新 fv，
    // 本端就会无脑覆盖别的设备刚改过的资料 —— 字段合并等于失效。
    var known = eng.getRecord("profile", "_") || {};
    var now = Date.now();
    var changed = {}, fv = {}, any = false;
    Object.keys(p).forEach(function (f) {
      if (JSON.stringify(known[f]) !== JSON.stringify(p[f])) { changed[f] = p[f]; fv[f] = now; any = true; }
    });
    if (!any) return;
    eng.localChange("profile", "_", changed, { fv: fv, pushValue: changed, v: now });
  };

  // 远端变更 -> 合并 -> 写回 PWA
  SyncBridge.prototype._onRemote = function () {
    var eng = this.engine; if (!eng || !window.Workbench || !window.Workbench.applyRemote) return;
    if (window.__wbSyncApplying) return;
    var merged = {};
    ARRAY_KEYS.forEach(function (k) {
      var all = eng.getAll(k);   // 取一次即可，之前每条记录都重算一遍是 O(n²)
      merged[k] = Object.keys(all).map(function (rid) { return all[rid]; });
    });
    var s = eng.getRecord("settings", "_") || {};
    merged.theme = (s && s.theme) || window.Store.get("theme", "light");
    merged.focusSettings = Object.keys(s || {}).length ? unflattenFocus(s) : window.Store.get("focusSettings", {});
    var p = eng.getRecord("profile", "_");
    if (p) merged.profile = p;
    window.__wbSyncApplying = true;
    try { window.Workbench.applyRemote(merged); } catch (e) { console.warn("[sync] applyRemote 失败", e); }
    window.__wbSyncApplying = false;
  };

  SyncBridge.prototype.start = function () {
    if (!this.engine) this.init();
    this.engine.init(this._accountId());   // 登录后账号才确定，这里按真实账号重挂缓存
    var self = this;
    return this.engine.fullSync().then(function () {
      self.engine.start();
      self.syncProfile();
    }).catch(function () { self.engine.start(); self.syncProfile(); });
  };
  SyncBridge.prototype.stop = function () { if (this.engine) this.engine.stop(); };

  /* 退出登录 / 注销账号时清掉本机同步缓存。
     共享设备上不清的话，上一位用户的任务、便签、联系人会原封不动留在 localStorage 里。
     清之前尽力推一次 outbox，避免把「离线期间的改动」连同缓存一起丢掉。 */
  SyncBridge.prototype.wipeLocal = function () {
    var st = localStore();
    var acct = this._accountId();
    ["sync:cache:", "sync:seq:", "sync:outbox:"].forEach(function (p) { st.remove(p + acct); });
    if (this.engine) { this.engine.cache = {}; this.engine.outbox = []; this.engine.lastSeq = 0; }
  };

  SyncBridge.prototype.clearLocal = function () {
    var self = this;
    var eng = this.engine;
    var wipe = function () { self.wipeLocal(); };
    if (!eng) { wipe(); return Promise.resolve(); }
    // 最多等 1.5s，网络不通就直接放弃，不能卡住退出流程
    var raced = Promise.race([
      eng.push().catch(function () {}),
      new Promise(function (r) { setTimeout(r, 1500); })
    ]);
    return raced.then(wipe, wipe);
  };

  return new SyncBridge();
});
