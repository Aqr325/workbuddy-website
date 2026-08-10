/*
 * sync-engine.js — 跨平台账号数据同步引擎（客户端，框架无关）
 * =============================================================
 * 浏览器(PWA/Electron) 与 Node(测试) 通用。负责：
 *   - 本地优先：所有读写先落本地缓存(离线可用)，再异步上推。
 *   - 离线队列：变更进 outbox，联网后 POST /push 重放。
 *   - 增量拉取：按 lastSeq 拉 /pull?after= 合并。
 *   - 实时推送：经 openStream(SSE) 收到 seq 变更即拉增量。
 *   - 冲突合并：LWW(业务数据) / 字段合并(设置·资料)，与服务端规则一致。
 *
 * 依赖注入（避免耦合具体传输/存储）：
 *   opts.storage     : {get(k), set(k,obj), remove(k)} 适配器
 *   opts.request     : async (method, path, body?) -> 解析后的 JSON（集成层负责带鉴权头）
 *   opts.openStream  : (onEvent) -> closeFn（集成层用 fetch 读 SSE，因 EventSource 不能带自定义头）
 *   opts.deviceId    : 设备稳定标识
 *   opts.getToken    : () -> 当前会话令牌（空则暂停同步）
 *   opts.buckets     : 可选，覆盖桶定义
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SyncEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 与服务端 lib/sync.js 的 BUCKETS 保持一致
  var DEFAULT_BUCKETS = {
    profile: { mode: "fields" },
    settings: { mode: "fields" },
    tasks: { mode: "lww" },
    events: { mode: "lww" },
    notes: { mode: "lww" },
    links: { mode: "lww" },
    contacts: { mode: "lww" },
    projects: { mode: "lww" },
    emails: { mode: "lww" },
    interviews: { mode: "lww" },
    deploys: { mode: "lww" },
    prompts: { mode: "lww" },
    focusLog: { mode: "lww" }
  };

  function nowMs() { return Date.now(); }

  function SyncEngine(opts) {
    opts = opts || {};
    this.buckets = opts.buckets || DEFAULT_BUCKETS;
    this.storage = opts.storage || memoryStorage();
    this.request = opts.request;
    this.openStream = opts.openStream || null;
    this.deviceId = opts.deviceId || "dev-" + Math.random().toString(36).slice(2, 10);
    this.getToken = opts.getToken || function () { return ""; };
    this.periodMs = opts.periodMs || 30000;
    this.pushDebounceMs = opts.pushDebounceMs || 1200;
    this.accountId = null;
    this.cache = {};        // {bucket:{recordId:{value,v,deleted,fv}}}
    this.lastSeq = 0;
    this.outbox = [];        // [{bucket,recordId,value,deleted,v,fv}]
    this._handlers = {};
    this._pushTimer = null;
    this._timer = null;
    this._streamClose = null;
    this._started = false;
  }

  SyncEngine.BUCKETS = DEFAULT_BUCKETS;

  /* ---------------- 事件 ---------------- */
  SyncEngine.prototype.on = function (evt, cb) {
    (this._handlers[evt] = this._handlers[evt] || []).push(cb);
    return this;
  };
  SyncEngine.prototype.emit = function (evt, payload) {
    (this._handlers[evt] || []).forEach(function (cb) { try { cb(payload); } catch (e) {} });
  };

  /* ---------------- 持久化 ---------------- */
  SyncEngine.prototype._cacheKey = function () { return "sync:cache:" + this.accountId; };
  SyncEngine.prototype._seqKey = function () { return "sync:seq:" + this.accountId; };
  SyncEngine.prototype._outboxKey = function () { return "sync:outbox:" + this.accountId; };
  SyncEngine.prototype._saveCache = function () { this.storage.set(this._cacheKey(), this.cache); };
  SyncEngine.prototype._saveSeq = function () { this.storage.set(this._seqKey(), this.lastSeq); };
  SyncEngine.prototype._saveOutbox = function () { this.storage.set(this._outboxKey(), this.outbox); };

  SyncEngine.prototype.init = function (accountId) {
    this.accountId = accountId;
    this.cache = this.storage.get(this._cacheKey()) || {};
    this.lastSeq = Number(this.storage.get(this._seqKey())) || 0;
    this.outbox = this.storage.get(this._outboxKey()) || [];
    return this;
  };

  SyncEngine.prototype.mode = function (bucket) {
    return (this.buckets[bucket] && this.buckets[bucket].mode) || "lww";
  };

  /* ---------------- 本地变更（乐观写入 + 入队） ---------------- */
  SyncEngine.prototype.localChange = function (bucket, recordId, value, opts) {
    opts = opts || {};
    if (!bucket || !recordId || !this.buckets[bucket]) return;
    this.cache[bucket] = this.cache[bucket] || {};
    var ver = opts.v || nowMs();
    if (opts.deleted) {
      this.cache[bucket][recordId] = { deleted: true, v: ver, fv: {} };
    } else if (this.mode(bucket) === "fields") {
      // fields 模式必须「合并」而非整体替换：否则本次只改了 theme，
      // 其它字段的 fv 会被清零，随后任何一条远端增量都能把它们盖掉。
      var prev = this.cache[bucket][recordId] || {};
      var pv = (prev.value && typeof prev.value === "object") ? prev.value : {};
      var pfv = (prev.fv && typeof prev.fv === "object") ? prev.fv : {};
      var nv = Object.assign({}, pv, (value && typeof value === "object") ? value : {});
      var nfv = Object.assign({}, pfv);
      Object.keys(opts.fv || {}).forEach(function (f) { nfv[f] = opts.fv[f]; });
      this.cache[bucket][recordId] = { value: nv, fv: nfv, deleted: false, v: ver };
    } else {
      this.cache[bucket][recordId] = { value: value, deleted: false, v: ver, fv: opts.fv || {} };
    }
    // outbox 去重：同 bucket+recordId 只留最新
    this.outbox = this.outbox.filter(function (c) { return !(c.bucket === bucket && c.recordId === recordId); });
    // pushValue：字段合并时只上推变更字段（默认上推完整 value）
    this.outbox.push({
      bucket: bucket, recordId: recordId,
      value: (opts.pushValue !== undefined ? opts.pushValue : value),
      deleted: !!opts.deleted,
      v: ver, fv: opts.fv || {}
    });
    this._saveCache();
    this._saveOutbox();
    this.schedulePush();
    this.emit("change", { bucket: bucket, recordId: recordId, remote: false });
  };
  SyncEngine.prototype.localDelete = function (bucket, recordId) {
    this.localChange(bucket, recordId, null, { deleted: true });
  };

  /* ---------------- 上推 ---------------- */
  SyncEngine.prototype.schedulePush = function () {
    var self = this;
    if (this._pushTimer) return;
    this._pushTimer = setTimeout(function () {
      self._pushTimer = null;
      self.push().catch(function () {});
    }, this.pushDebounceMs);
  };
  SyncEngine.prototype.push = function () {
    var self = this;
    if (!this.request) return Promise.resolve();
    if (!this.getToken()) return Promise.resolve();
    var batch = this.outbox.slice();
    if (!batch.length) return Promise.resolve();
    return Promise.resolve(this.request("POST", "/api/sync/v2/push", { deviceId: this.deviceId, changes: batch }))
      .then(function (r) {
        if (!r || !r.ok) throw new Error("push failed");
        // 只清掉「本批已发出且期间没有被更新的」条目：
        // 请求飞行途中若同一记录又改了，outbox 里的 v 会变大，必须留着下轮再推，否则丢改动。
        var sentV = {};
        batch.forEach(function (c) { sentV[c.bucket + "#" + c.recordId] = c.v; });
        var accepted = {};
        (r.applied || []).forEach(function (a) { if (a.accepted) accepted[a.bucket + "#" + a.recordId] = 1; });
        self.outbox = self.outbox.filter(function (c) {
          var k = c.bucket + "#" + c.recordId;
          return !(accepted[k] && sentV[k] === c.v);
        });
        self._saveOutbox();
        if (typeof r.seq === "number") { self.lastSeq = Math.max(self.lastSeq, r.seq); self._saveSeq(); }
        // 未被接受的（服务端有更新）通过 pull 收敛
        return self.pull();
      });
  };

  /* ---------------- 拉取 ---------------- */
  SyncEngine.prototype.pull = function () {
    var self = this;
    if (!this.request) return Promise.resolve();
    if (!this.getToken()) return Promise.resolve();
    return Promise.resolve(this.request("GET", "/api/sync/v2/pull?after=" + this.lastSeq))
      .then(function (r) {
        if (!r || !r.ok) throw new Error("pull failed");
        // 本端落后太多，服务端变更流水已被裁剪 -> 退回全量同步，避免静默丢改动
        if (r.truncated) return self.fullSync();
        (r.changes || []).forEach(function (d) { self._applyDelta(d); });
        if (typeof r.seq === "number") { self.lastSeq = r.seq; self._saveSeq(); }
      });
  };

  /* 应用服务端增量（客户端侧冲突合并，规则与服务端一致） */
  SyncEngine.prototype._applyDelta = function (d) {
    var bucket = d.bucket, rid = d.recordId;
    if (!bucket || !rid || !this.buckets[bucket]) return;
    this.cache[bucket] = this.cache[bucket] || {};
    if (this.mode(bucket) === "fields") {
      var rec = this.cache[bucket][rid] || { value: {}, fv: {}, deleted: false };
      var val = (rec.value && typeof rec.value === "object") ? rec.value : {};
      var fv = (rec.fv && typeof rec.fv === "object") ? rec.fv : {};
      if (d.deleted) {
        if ((d.seq || 0) >= (rec._seq || 0)) { this.cache[bucket][rid] = { deleted: true, value: {}, fv: {}, _seq: d.seq }; }
      } else {
        var inc = d.value || {};
        var incFv = d.fv || {};
        Object.keys(inc).forEach(function (f) {
          var iv = Number(incFv[f]) || 0, cv = Number(fv[f]) || 0;
          if (iv >= cv) { val[f] = inc[f]; fv[f] = iv; }
        });
        this.cache[bucket][rid] = { value: val, fv: fv, deleted: false };
      }
    } else { // lww
      var local = this.cache[bucket][rid];
      if (d.deleted) {
        if (!local || (d.v || 0) >= (local.v || 0)) this.cache[bucket][rid] = { deleted: true, v: d.v || 0 };
      } else {
        if (!local || (d.v || 0) > (local.v || 0)) this.cache[bucket][rid] = { value: d.value, v: d.v || 0, deleted: false };
      }
    }
    this._saveCache();
    this.emit("change", { bucket: bucket, recordId: rid, remote: true });
  };

  /* ---------------- 登录全量 ---------------- */
  SyncEngine.prototype.fullSync = function () {
    var self = this;
    if (!this.request || !this.getToken()) return Promise.resolve();
    return Promise.resolve(this.request("GET", "/api/sync/v2/state")).then(function (r) {
      if (!r || !r.ok) throw new Error("state failed");
      var data = r.data || {};
      var allFv = r.fv || {};
      var cache = {};
      Object.keys(data).forEach(function (b) {
        if (!self.buckets[b]) return;
        var recs = data[b];
        var out = {};
        Object.keys(recs).forEach(function (rid) {
          if (self.mode(b) === "fields") {
            // 带上服务端字段版本，否则本端 fv 全为 0，任何远端增量都能盖掉刚改的字段
            out[rid] = { value: recs[rid], fv: (allFv[b] && allFv[b][rid]) || {}, deleted: false };
          } else {
            out[rid] = { value: recs[rid], v: (r.v && r.v[b] && r.v[b][rid]) || r.serverTime || nowMs(), deleted: false };
          }
        });
        cache[b] = out;
      });
      self.cache = cache;
      self.lastSeq = r.seq || 0;
      // 全量覆盖会抹掉「尚未推成功的离线改动」，这里把 outbox 重新叠回本地视图，
      // 保证断网期间做的修改在重连后不会从界面上消失。
      self.outbox.forEach(function (c) {
        self.cache[c.bucket] = self.cache[c.bucket] || {};
        if (c.deleted) { self.cache[c.bucket][c.recordId] = { deleted: true, v: c.v, fv: {} }; return; }
        if (self.mode(c.bucket) === "fields") {
          var prev = self.cache[c.bucket][c.recordId] || { value: {}, fv: {} };
          var nv = Object.assign({}, prev.value, c.value || {});
          var nfv = Object.assign({}, prev.fv, c.fv || {});
          self.cache[c.bucket][c.recordId] = { value: nv, fv: nfv, deleted: false, v: c.v };
        } else {
          var cur = self.cache[c.bucket][c.recordId];
          if (!cur || (c.v || 0) >= (cur.v || 0)) self.cache[c.bucket][c.recordId] = { value: c.value, v: c.v, deleted: false };
        }
      });
      self._saveCache();
      self._saveSeq();
      self.emit("change", { bucket: "*", recordId: "*", remote: true, full: true });
      return r;
    });
  };

  /* ---------------- 读取（供 UI） ---------------- */
  SyncEngine.prototype.getRecord = function (bucket, recordId) {
    var rec = (this.cache[bucket] || {})[recordId];
    if (!rec || rec.deleted) return null;
    return rec.value;
  };
  SyncEngine.prototype.getAll = function (bucket) {
    var out = {};
    var recs = this.cache[bucket] || {};
    Object.keys(recs).forEach(function (rid) {
      if (!recs[rid].deleted) out[rid] = recs[rid].value;
    });
    return out;
  };

  /* ---------------- 生命周期 ---------------- */
  SyncEngine.prototype.start = function () {
    var self = this;
    if (this._started) return;
    this._started = true;
    if (this.openStream && this.getToken()) {
      try {
        this._streamClose = this.openStream(function (evt) {
          if (evt && evt.type === "sync") self.pull().catch(function () {});
        });
      } catch (e) { this._streamClose = null; }
    }
    this._timer = setInterval(function () { self.push().then(function () { return self.pull(); }).catch(function () {}); }, this.periodMs);
    // 启动即收敛一次
    this.push().then(function () { return self.pull(); }).catch(function () {});
  };
  SyncEngine.prototype.stop = function () {
    this._started = false;
    if (this._pushTimer) { clearTimeout(this._pushTimer); this._pushTimer = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._streamClose) { try { this._streamClose(); } catch (e) {} this._streamClose = null; }
  };

  /* ---------------- 内存存储（测试/兜底） ---------------- */
  function memoryStorage() {
    var m = {};
    return {
      get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      set: function (k, v) { m[k] = v; },
      remove: function (k) { delete m[k]; }
    };
  }
  SyncEngine.memoryStorage = memoryStorage;

  return SyncEngine;
});
