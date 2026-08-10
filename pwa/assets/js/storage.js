/**
 * storage.js — 本地数据持久化层
 * 基于 localStorage，提供命名空间（按用户隔离）、JSON 序列化与安全的容错读写。
 *
 * 设计要点：
 * - 命名空间：登录后 Store.setNamespace(userId) 会让 tasks/events 等用户数据落到
 *   workbuddy.desk.<userId>.xxx，实现同机多用户本地隔离（仅作离线缓存，
 *   真正的账号与数据隔离由服务端权威鉴权保证，见 reminder-server/lib/auth.js）。
 * - 全局键：users / session 属于旧版账号体系，现账号改由服务端管理；此处保留
 *   clearNamespaceData 供登出/删号时清理本机缓存。
 * - 密码：不在前端/本层处理，口令由服务端用 scrypt 加盐哈希存储（auth.js），
 *   前端永不直接接触口令哈希。
 */
(function (global) {
  "use strict";

  var NS = "workbuddy.desk.";               // 命名空间前缀，避免与其他应用冲突
  var GLOBAL_KEYS = { users: 1, session: 1 }; // 账号体系键，永远不进入用户命名空间
  var namespace = null;                     // 形如 "workbuddy.desk.<userId>." 或 null
  var onError = null;                       // 写入失败（如配额超限）时的回调钩子
  var mirrorHook = null;                    // 写入镜像钩子（用于 IndexedDB 二级持久化）

  function safeParse(raw, fallback) {
    if (raw === null || raw === undefined) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn("[storage] 解析失败，使用默认值:", e);
      return fallback;
    }
  }

  function fullKey(name) {
    if (GLOBAL_KEYS[name] || namespace === null) return NS + name;
    return namespace + name;
  }

  function handleWriteError(e) {
    var quota = (e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014));
    var msg = quota
      ? "本地存储空间已满，最新改动可能未保存。请删除部分便签/链接或导出备份后清空。"
      : "数据保存失败：" + (e && e.message ? e.message : "未知错误");
    console.error("[storage] 写入失败:", e);
    if (typeof onError === "function") onError(msg);
  }

  var Storage = {
    /** 注册写入失败的全局回调（如配额超限），由 app.js 用于弹出友好提示 */
    onError: function (cb) { onError = cb; },

    /** 注册写入镜像钩子：每次成功写入后把 (完整键, 原始值) 交给二级存储（IndexedDB） */
    onMirror: function (cb) { mirrorHook = cb; },

    /** 当前键前缀（用户命名空间或全局前缀），便于二级存储按用户隔离与恢复 */
    prefix: function () { return namespace === null ? NS : namespace; },

    /** 计算某个逻辑键对应的完整存储键 */
    fullKeyOf: function (name) { return fullKey(name); },

    /** 直接按完整键读写原始 JSON 字符串（供二级存储恢复时使用，绕开命名空间参数） */
    rawGet: function (full) {
      var raw = null;
      try { raw = localStorage.getItem(full); } catch (e) {}
      return raw;
    },
    rawSet: function (full, value) {
      try { localStorage.setItem(full, JSON.stringify(value)); return true; }
      catch (e) { handleWriteError(e); return false; }
    },

    /** 主动镜像某个逻辑键（用于初始化时把内存数据同步到二级存储） */
    mirrorKey: function (name, value) {
      if (typeof mirrorHook === "function") {
        try { mirrorHook(fullKey(name), value); } catch (e) {}
      }
    },

    /** 当前 localStorage 已用/估算用途提示（非精确） */
    isQuotaError: function (e) {
      return !!(e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014));
    },

    /** 设定当前用户命名空间；传入 null 或 falsy 恢复为全局（无命名空间） */
    setNamespace: function (id) {
      namespace = id ? NS + id + "." : null;
    },

    /** 清除命名空间，回到全局 */
    clearNamespace: function () {
      namespace = null;
    },

    /** 当前是否处于某用户命名空间下 */
    hasNamespace: function () {
      return namespace !== null;
    },

    /** 读取并反序列化；key 无需带命名空间前缀 */
    get: function (key, fallback) {
      var raw = null;
      try {
        raw = localStorage.getItem(fullKey(key));
      } catch (e) {
        // 隐身/无痕模式或某些 file:// 环境下访问 localStorage 会抛错，降级为空
        console.warn("[storage] 读取失败（可能处于无痕模式）:", e);
      }
      var val = safeParse(raw, null);
      return val === null ? (fallback !== undefined ? fallback : null) : val;
    },

    /** 序列化并写入 */
    set: function (key, value) {
      try {
        localStorage.setItem(fullKey(key), JSON.stringify(value));
        if (typeof mirrorHook === "function") { try { mirrorHook(fullKey(key), value); } catch (e) {} }
        return true;
      } catch (e) {
        handleWriteError(e);
        return false;
      }
    },

    /** 删除指定键 */
    remove: function (key) {
      try { localStorage.removeItem(fullKey(key)); }
      catch (e) { console.warn("[storage] 删除失败:", e); }
    },

    /** 删除当前命名空间下的全部用户键（用于删除账号时清理） */
    clearNamespaceData: function () {
      if (namespace === null) return;
      var toRemove = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(namespace) === 0) toRemove.push(k);
        }
        toRemove.forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
      } catch (e) { console.warn("[storage] 清理命名空间失败:", e); }
    },

    /* ---- 全局键（账号 / 会话）专用，绕过命名空间 ---- */
    globalGet: function (key, fallback) {
      var val = safeParse(localStorage.getItem(NS + key), null);
      return val === null ? (fallback !== undefined ? fallback : null) : val;
    },
    globalSet: function (key, value) {
      try {
        localStorage.setItem(NS + key, JSON.stringify(value));
        if (typeof mirrorHook === "function") { try { mirrorHook(NS + key, value); } catch (e) {} }
        return true;
      } catch (e) {
        handleWriteError(e);
        return false;
      }
    },
    globalRemove: function (key) {
      localStorage.removeItem(NS + key);
    },

    /** 生成唯一 id */
    uid: function () {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
  };

  global.Store = Storage;
})(window);
