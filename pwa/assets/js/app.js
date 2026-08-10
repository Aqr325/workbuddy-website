/**
 * app.js — 个人工作台主逻辑（v3）
 * 模块：概览（含趋势/专注）、任务（标签/筛选/逾期/行内编辑）、日历+重复+提醒、
 *       便签、链接、专注番茄钟、数据备份、键盘快捷键。数据全部经 Store(localStorage) 持久化。
 */
(function () {
  "use strict";

  var Store = window.Store;

  /* ---------- 工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function dateParts(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }

  function sanitizeUrl(url) {
    var u = (url || "").trim();
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try {
      var p = new URL(u);
      if (p.protocol !== "http:" && p.protocol !== "https:") return "";
      return p.href;
    } catch (e) { return ""; }
  }

  /* 仅允许 #rgb / #rrggbb 形式的颜色，杜绝 style 属性里的 CSS 注入（如 c.color="red;color:expression(...)"） */
  function sanitizeColor(c) {
    if (typeof c !== "string") return "";
    var t = c.trim();
    if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t)) return t;
    return "";
  }
  var FALLBACK_COLOR = "#94a3b8";

  function toast(msg, type) {
    var wrap = $("#toast-wrap");
    var el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("show"); });
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { el.remove(); }, 300);
    }, 3600);
  }

  /* ---------- 数据状态 ---------- */
  var currentUser = null;          // 当前登录用户对象（id/username/name/avatar/bio，由服务端 /api/auth/me 返回，绝不持有口令哈希）
  var tasks = [], events = [], notes = [], links = [], contacts = [], focusLog = [], projects = [];
  var emails = [], interviews = [], deploys = [], prompts = [];
  var focusSettings = { work: 25, short: 5, long: 15, auto: true };

  var taskFilter = "all";
  var taskSearch = "", noteSearch = "", linkSearch = "", relSearch = "", projSearch = "";
  var emailSearch = "", interviewSearch = "", interviewTypeFilter = "all", deploySearch = "", promptSearch = "", promptTagFilter = [];
  var tagFilter = [];
  var relGroupFilter = "all";
  var relIndustryFilter = "all";
  var projStatusFilter = "all";
  var editingLinkId = null;
  var editingEventId = null;
  var editingContactId = null;
  var calYear, calMonth, selDate;
  var notified = {};
  var reminderCfg = { email: "", mode: "mailto", api: "", autoOpen: true };
  var reminderLog = {}; // key=eventId|date -> {status, sentAt, sig, to}
  var remCollapsed = {}; // 按日期分组的折叠状态：ds -> true(折叠)

  /* ---------- 导航 / 主题 ---------- */
  var VIEWS = {
    dashboard: { title: "概览", desc: "一眼掌握今日待办、安排与灵感。" },
    tasks: { title: "任务管理", desc: "管理你的待办清单，专注当下最重要的事。" },
    calendar: { title: "日程安排", desc: "月视图规划，重要事件到点提醒。" },
    notes: { title: "便签记录", desc: "快速记录灵感，随手即存。" },
    links: { title: "链接收藏", desc: "自定义常用入口，一键直达。" },
    relations: { title: "社会关系", desc: "经营你的人际网络，重要日子不忘。" },
    projects: { title: "项目管理", desc: "记录本地项目目录，一键定位文件夹位置。" },
    emails: { title: "邮件模板库", desc: "沉淀常用邮件模板，变量填充即可调用。" },
    interviews: { title: "访谈话书库", desc: "整理访谈提纲、记录与话术，按类型检索。" },
    deploys: { title: "服务部署面板", desc: "配置服务地址，一键部署与状态查看。" },
    prompts: { title: "提示词仓库", desc: "保存与复用提示词，标签分类管理。" },
  };
  var VIEW_ORDER = ["dashboard", "tasks", "calendar", "relations", "notes", "links", "projects", "emails", "interviews", "deploys", "prompts"];

  function switchView(view) {
    if (!VIEWS[view]) return;
    $all(".nav-item").forEach(function (b) { b.classList.toggle("active", b.dataset.view === view); });
    $all(".m-nav-item").forEach(function (b) { b.classList.toggle("active", b.dataset.view === view); });
    $all(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + view); });
    $("#view-title").textContent = VIEWS[view].title;
    $("#view-desc").textContent = VIEWS[view].desc;
    if (view === "calendar") renderCalendar();
    if (view === "dashboard") renderDashboard();
    if (view === "tasks") renderTagFilter();
    if (view === "relations") renderRelations();
    if (view === "projects") renderProjects();
    if (view === "emails") renderEmails();
    if (view === "interviews") renderInterviews();
    if (view === "deploys") renderDeploys();
    if (view === "prompts") renderPrompts();
  }

  function initNav() {
    $all("[data-view]").forEach(function (b) {
      b.addEventListener("click", function () { switchView(b.dataset.view); });
    });
    applyTheme(Store.get("theme", "light"));
    $("#btn-theme").addEventListener("click", function () {
      applyTheme(document.body.classList.contains("dark") ? "light" : "dark");
    });
    $("#btn-help").addEventListener("click", openHelp);
  }

  function applyTheme(theme) {
    document.body.classList.toggle("dark", theme === "dark");
    Store.set("theme", theme);
  }

  /* ---------- 时钟 ---------- */
  function tickClock() {
    var now = new Date();
    $("#clock").textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
    var wk = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
    $("#today-label").textContent = (now.getMonth() + 1) + "月" + now.getDate() + "日 周" + wk;
  }

  /* ---------- 渲染汇总 ---------- */
  function renderAll() {
    renderDashboard();
    renderTasks();
    renderCalendar();
    renderNotes();
    renderLinks();
    renderRelations();
    renderProjects();
    renderEmails();
    renderInterviews();
    renderDeploys();
    renderPrompts();
  }

  /* 跨端同步回写：把合并后的远端数据写回内存 + 本地存储 + 重渲染。
     由 sync-integration.js 在收到引擎 change 事件时调用（已置 __wbSyncApplying，避免回写再次入队）。 */
  function applyRemote(merged) {
    if (!merged) return;
    var setSafe = function (k, v) { try { Store.set(k, v); } catch (e) {} };
    if (merged.tasks !== undefined) { tasks = merged.tasks || []; setSafe("tasks", tasks); }
    if (merged.events !== undefined) { events = merged.events || []; setSafe("events", events); }
    if (merged.notes !== undefined) { notes = merged.notes || []; setSafe("notes", notes); }
    if (merged.links !== undefined) { links = merged.links || []; setSafe("links", links); }
    if (merged.contacts !== undefined) { contacts = merged.contacts || []; setSafe("contacts", contacts); }
    if (merged.projects !== undefined) { projects = merged.projects || []; setSafe("projects", projects); }
    if (merged.emails !== undefined) { emails = merged.emails || []; setSafe("emails", emails); }
    if (merged.interviews !== undefined) { interviews = merged.interviews || []; setSafe("interviews", interviews); }
    if (merged.deploys !== undefined) { deploys = merged.deploys || []; setSafe("deploys", deploys); }
    if (merged.prompts !== undefined) { prompts = merged.prompts || []; setSafe("prompts", prompts); }
    if (merged.focusLog !== undefined) {
      focusLog = (merged.focusLog || []).slice().sort(function (a, b) { return (a || 0) - (b || 0); });
      setSafe("focusLog", focusLog);
    }
    if (merged.theme !== undefined) { setSafe("theme", merged.theme); applyTheme(merged.theme); }
    if (merged.focusSettings !== undefined) {
      focusSettings = merged.focusSettings || { work: 25, short: 5, long: 15, auto: true };
      setSafe("focusSettings", focusSettings);
    }
    if (merged.profile && currentUser) {
      currentUser.name = merged.profile.name || currentUser.name;
      currentUser.avatar = merged.profile.avatar || currentUser.avatar;
      currentUser.bio = merged.profile.bio || currentUser.bio;
      try { updateUserChip(); } catch (e) {}
      try { setupProfileUI(); } catch (e) {}
    }
    renderAll();
  }
  function getProfile() {
    if (!currentUser) return null;
    return { name: currentUser.name || "", avatar: currentUser.avatar || "🙂", bio: currentUser.bio || "" };
  }

  /* ---------- 概览仪表盘 ---------- */
  function renderDashboard() {
    var pending = tasks.filter(function (t) { return !t.done; }).length;
    var todayEv = events.filter(function (e) { return occursOn(e, todayStr()); }).length;
    var stats = [
      { ico: "✔", num: pending, label: "待办任务" },
      { ico: "▦", num: todayEv, label: "今日日程" },
      { ico: "✎", num: notes.length, label: "便签" },
      { ico: "⚷", num: links.length, label: "链接" },
      { ico: "☺", num: contacts.length, label: "联系人" },
      { ico: "▣", num: projects.length, label: "项目" },
      { ico: "✉", num: emails.length, label: "邮件模板" },
      { ico: "❒", num: interviews.length, label: "访谈话术" },
      { ico: "▶", num: deploys.length, label: "部署服务" },
      { ico: "✦", num: prompts.length, label: "提示词" },
    ];
    $("#stat-grid").innerHTML = stats.map(function (s) {
      return '<div class="stat-card"><span class="stat-ico">' + s.ico + "</span>" +
        '<span class="stat-num">' + s.num + '</span><span class="stat-label">' + s.label + "</span></div>";
    }).join("");

    var dayEv = events.filter(function (e) { return occursOn(e, todayStr()); })
      .sort(function (a, b) { return a.time < b.time ? -1 : 1; });
    var evHtml = dayEv.map(function (e) {
      return '<li><span class="mini-time">' + escapeHtml(e.time) + "</span>" +
        '<span class="mini-main">' + escapeHtml(e.title) + repeatBadge(e) + "</span></li>";
    }).join("");
    $("#dash-events").innerHTML = evHtml;
    $("#dash-events-empty").hidden = dayEv.length !== 0;

    var prioRank = { high: 0, mid: 1, low: 2 };
    var topTasks = tasks.filter(function (t) { return !t.done; })
      .sort(function (a, b) { return (prioRank[a.prio] - prioRank[b.prio]) || (a.created - b.created); })
      .slice(0, 5);
    var tkHtml = topTasks.map(function (t) {
      return '<li><span class="mini-dot ' + t.prio + '"></span>' +
        '<span class="mini-main">' + escapeHtml(t.title) + "</span></li>";
    }).join("");
    $("#dash-tasks").innerHTML = tkHtml;
    $("#dash-tasks-empty").hidden = topTasks.length !== 0;

    var ql = links.slice(0, 8).map(function (l) {
      var ico = l.icon || (l.name || l.url).charAt(0).toUpperCase();
      return '<a class="quick-chip" href="' + sanitizeUrl(l.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="qc-ico">' + escapeHtml(ico) + "</span>" + escapeHtml(l.name || l.url) + "</a>";
    }).join("");
    $("#dash-links").innerHTML = ql;
    $("#dash-links-empty").hidden = links.length !== 0;

    var prank = { active: 0, planning: 1, paused: 2, done: 3 };
    var topProj = projects.slice().sort(function (a, b) {
      return (prank[a.status] || 1) - (prank[b.status] || 1) || (b.updated || 0) - (a.updated || 0);
    }).slice(0, 5);
    $("#dash-projects").innerHTML = topProj.map(function (p) {
      var col = sanitizeColor(p.color || statusColor(p.status)) || FALLBACK_COLOR;
      var todoLeft = (p.todos || []).filter(function (t) { return !t.done; }).length;
      var todoTag = (p.todos && p.todos.length) ? ' <span class="mini-todo">待办 ' + todoLeft + "</span>" : "";
      return '<li><span class="proj-badge" style="background:' + col + '22;color:' + col + '">' +
        statusText(p.status) + "</span>" +
        '<span class="mini-main">' + escapeHtml(p.name) + todoTag + "</span>" +
        '<button class="mini-open" data-path="' + escapeHtml(p.path) + '" title="打开文件夹">▣</button></li>';
    }).join("");
    $("#dash-projects-empty").hidden = topProj.length !== 0;
    $all("#dash-projects .mini-open").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openProjectFolder(b.getAttribute("data-path")); });
    });

    var up = upcomingBirthdays(30);
    $("#dash-birthdays").innerHTML = up.map(function (b) {
      return '<li><span class="mini-main">' + escapeHtml(b.name) + "</span>" +
        '<span class="bd-days">' + (b.days === 0 ? "今天" : b.days + " 天后") + " 🎂</span></li>";
    }).join("");
    $("#dash-birthdays-empty").hidden = up.length !== 0;

    /* 今日要处理（铁律5：逾期/今天到期项置顶） */
    var t0 = new Date(); t0.setHours(0, 0, 0, 0); var tday = t0.getTime();
    var todayItems = [];
    tasks.forEach(function (tk) {
      if (!tk.done && tk.due && new Date(tk.due + "T00:00:00").getTime() < tday) {
        todayItems.push({ red: true, text: "任务逾期：" + tk.title, view: "tasks" });
      }
    });
    interviews.forEach(function (it) {
      if (!it.done && it.dueDate && new Date(it.dueDate + "T00:00:00").getTime() <= tday) {
        var over = new Date(it.dueDate + "T00:00:00").getTime() < tday;
        todayItems.push({ red: over, text: "访谈" + (it.type || "提纲") + "到期：" + it.title, view: "interviews" });
      }
    });
    if (deploys.length) {
      todayItems.push({ red: false, text: "部署服务 " + deploys.length + " 个，建议查看运行状态", view: "deploys" });
    }
    $("#dash-today").innerHTML = todayItems.map(function (x) {
      return '<li' + (x.red ? ' class="today-red"' : "") + '>' +
        '<span class="mini-main">' + escapeHtml(x.text) + "</span>" +
        '<button class="mini-open" data-go="' + x.view + '">去处理 ›</button></li>';
    }).join("");
    $("#dash-today-empty").hidden = todayItems.length !== 0;
    $all("#dash-today .mini-open").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); switchView(b.getAttribute("data-go")); });
    });

    $("#dash-focus-num").textContent = focusTodayCount();
    renderChart();
  }

  function upcomingBirthdays(days) {
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var res = [];
    contacts.forEach(function (c) {
      if (!c.birthday) return;
      var p = c.birthday.split("-"); if (p.length < 3) return;
      var y = now.getFullYear();
      var d1 = new Date(y, +p[1] - 1, +p[2]);
      if (d1 < now) d1 = new Date(y + 1, +p[1] - 1, +p[2]);
      var diff = Math.round((d1 - now) / 86400000);
      if (diff >= 0 && diff <= days) res.push({ name: c.name, days: diff, date: c.birthday });
    });
    res.sort(function (a, b) { return a.days - b.days; });
    return res;
  }

  function repeatBadge(e) {
    if (!e.repeat || e.repeat === "none") return "";
    var map = { daily: "每天", weekly: "每周", monthly: "每月" };
    return ' <span class="rep-badge">↻' + (map[e.repeat] || "") + "</span>";
  }

  function renderChart() {
    var days = [], now = new Date();
    for (var i = 6; i >= 0; i--) {
      var d = new Date(now); d.setDate(now.getDate() - i);
      var ds = ymd(d);
      var c = tasks.filter(function (t) { return t.completedAt && ymd(new Date(t.completedAt)) === ds; }).length;
      days.push({ label: (d.getMonth() + 1) + "/" + d.getDate(), c: c });
    }
    var max = Math.max(1, days.reduce(function (m, x) { return Math.max(m, x.c); }, 0));
    var w = 280, h = 92, bw = 26, gap = (w - days.length * bw) / (days.length + 1);
    var svg = "";
    days.forEach(function (d, i) {
      var bh = Math.round((d.c / max) * (h - 24));
      var x = gap + i * (bw + gap);
      var y = h - 14 - bh;
      svg += '<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + bh + '" rx="4"></rect>';
      svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 3) + '" font-size="8" fill="var(--muted)" text-anchor="middle">' + d.label + "</text>";
      if (d.c > 0) svg += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (y - 3).toFixed(1) + '" font-size="8" fill="var(--muted)" text-anchor="middle">' + d.c + "</text>";
    });
    $("#dash-chart").innerHTML = svg;
  }

  /* ---------- 任务管理 ---------- */
  function saveTasks() { Store.set("tasks", tasks); }

  function renderTasks() {
    var q = taskSearch.trim().toLowerCase();
    var items = tasks.slice().sort(function (a, b) { return (a.done === b.done) ? (a.created - b.created) : (a.done ? 1 : -1); });
    if (taskFilter === "active") items = items.filter(function (t) { return !t.done; });
    if (taskFilter === "done") items = items.filter(function (t) { return t.done; });
    if (q) items = items.filter(function (t) { return t.title.toLowerCase().indexOf(q) >= 0; });
    if (tagFilter.length) items = items.filter(function (t) {
      return (t.tags || []).some(function (x) { return tagFilter.indexOf(x) >= 0; });
    });

    var list = $("#task-list");
    list.innerHTML = "";
    $("#task-empty").hidden = items.length !== 0;

    var t = new Date(); t.setHours(0, 0, 0, 0);
    var today = t.getTime();

    items.forEach(function (tk) {
      var li = document.createElement("li");
      li.className = "task-item prio-" + tk.prio + (tk.done ? " done" : "");
      var dueHtml = "";
      if (tk.due) {
        var overdue = !tk.done && new Date(tk.due + "T00:00:00").getTime() < today;
        dueHtml = '<span class="task-due">📅 ' + escapeHtml(tk.due) + (overdue ? ' <span class="tag-overdue">逾期</span>' : "") + "</span>";
      }
      var tagsHtml = (tk.tags || []).map(function (tg) {
        return '<span class="task-tag">' + escapeHtml(tg) + "</span>";
      }).join("");
      li.innerHTML =
        '<button class="task-check" data-act="toggle" title="完成/恢复"></button>' +
        '<div class="task-body"><span class="task-title">' + escapeHtml(tk.title) + "</span>" +
        dueHtml + (tagsHtml ? '<span class="task-tags-wrap">' + tagsHtml + "</span>" : "") + "</div>" +
        '<button class="task-del" data-act="del" title="删除">🗑</button>';
      li.querySelector('[data-act="toggle"]').addEventListener("click", function () { toggleTask(tk.id); });
      li.querySelector('[data-act="del"]').addEventListener("click", function () { delTask(tk.id); });
      var titleEl = li.querySelector(".task-title");
      titleEl.addEventListener("dblclick", function () { beginEditTitle(tk, titleEl); });
      list.appendChild(li);
    });

    var left = tasks.filter(function (x) { return !x.done; }).length;
    $("#task-stat").textContent = "共 " + tasks.length + " · 待办 " + left + " · 已完成 " + (tasks.length - left);
  }

  function renderTagFilter() {
    var wrap = $("#task-tags-filter");
    if (!wrap) return;
    var all = {};
    tasks.forEach(function (t) { (t.tags || []).forEach(function (tg) { all[tg] = 1; }); });
    var tags = Object.keys(all);
    wrap.innerHTML = "";
    tags.forEach(function (tg) {
      var b = document.createElement("button");
      b.className = "tag-chip" + (tagFilter.indexOf(tg) >= 0 ? " active" : "");
      b.textContent = tg;
      b.addEventListener("click", function () {
        var i = tagFilter.indexOf(tg);
        if (i >= 0) tagFilter.splice(i, 1); else tagFilter.push(tg);
        renderTagFilter(); renderTasks();
      });
      wrap.appendChild(b);
    });
  }

  function beginEditTitle(tk, el) {
    var input = document.createElement("input");
    input.className = "task-title-input";
    input.value = tk.title;
    el.replaceWith(input);
    input.focus(); input.select();
    function commit() {
      var v = input.value.trim();
      if (v) { tk.title = v; saveTasks(); }
      renderTasks();
    }
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { input.value = tk.title; input.blur(); }
    });
  }

  function parseTags(str) {
    return (str || "").split(/[,，]/).map(function (s) { return s.trim(); })
      .filter(function (s, i, a) { return s && a.indexOf(s) === i; }).slice(0, 6);
  }

  function addTask(title, due, prio, tags) {
    tasks.push({
      id: Store.uid(), title: title, due: due || "", prio: prio || "mid",
      done: false, created: Date.now(), completedAt: 0, tags: tags || []
    });
    saveTasks(); renderTasks(); renderTagFilter(); renderDashboard();
  }
  function toggleTask(id) {
    var t = tasks.find(function (x) { return x.id === id; });
    if (t) { t.done = !t.done; t.completedAt = t.done ? Date.now() : 0; saveTasks(); renderTasks(); renderDashboard(); }
  }
  function delTask(id) {
    tasks = tasks.filter(function (x) { return x.id !== id; });
    saveTasks(); renderTasks(); renderTagFilter(); renderDashboard();
  }

  function initTasks() {
    $("#task-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var title = $("#task-title").value.trim();
      if (!title) return;
      addTask(title, $("#task-due").value, $("#task-prio").value, parseTags($("#task-tags").value));
      $("#task-title").value = ""; $("#task-due").value = ""; $("#task-tags").value = "";
    });
    $("#task-filter").addEventListener("click", function (e) {
      var btn = e.target.closest(".seg-btn"); if (!btn) return;
      taskFilter = btn.dataset.filter;
      $all(".seg-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
      renderTasks();
    });
    $("#task-search").addEventListener("input", function (e) { taskSearch = e.target.value; renderTasks(); });
    renderTasks();
  }

  /* ---------- 日程安排 + 重复 ---------- */
  function saveEvents() { Store.set("events", events); }

  function occursOn(ev, dateStr) {
    if (ev.repeat && ev.repeat !== "none") {
      var base = dateParts(ev.date), cur = dateParts(dateStr);
      if (cur < base) return false;
      if (ev.repeat === "daily") return true;
      if (ev.repeat === "weekly") return cur.getDay() === base.getDay();
      if (ev.repeat === "monthly") return cur.getDate() === base.getDate();
    }
    return ev.date === dateStr;
  }

  function renderCalendar() {
    var now = new Date();
    if (calYear === undefined) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
    if (!selDate) selDate = ymd(now);

    $("#cal-month").textContent = calYear + "年 " + (calMonth + 1) + "月";
    var grid = $("#cal-grid");
    grid.innerHTML = "";

    var first = new Date(calYear, calMonth, 1);
    var startOffset = (first.getDay() + 6) % 7;
    var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    var cells = [];
    for (var i = 0; i < startOffset; i++) cells.push(null);
    for (var d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);

    var todayStrV = ymd(now);
    cells.forEach(function (d) {
      var cell = document.createElement("div");
      if (d === null) { cell.className = "cal-cell empty"; grid.appendChild(cell); return; }
      var dateStr = calYear + "-" + pad(calMonth + 1) + "-" + pad(d);
      var dayEvents = events.filter(function (ev) { return occursOn(ev, dateStr); });
      cell.className = "cal-cell";
      if (dateStr === todayStrV) cell.classList.add("today");
      if (dateStr === selDate) cell.classList.add("selected");
      cell.innerHTML = '<span class="cal-num">' + d + "</span>" +
        (dayEvents.length ? '<span class="cal-dot' + (dayEvents.length > 2 ? " many" : "") + '">' + dayEvents.length + "</span>" : "");
      cell.addEventListener("click", function () { selDate = dateStr; renderCalendar(); });
      grid.appendChild(cell);
    });
    renderDayEvents();
    renderReminderCenterR();
  }

  function renderDayEvents() {
    var list = $("#event-list");
    var title = $("#day-title");
    if (!selDate) { title.textContent = "选择日期"; list.innerHTML = ""; return; }
    var parts = selDate.split("-");
    title.textContent = parts[1] + "月" + parts[2] + "日 的安排";
    var dayEvents = events.filter(function (ev) { return occursOn(ev, selDate); })
      .sort(function (a, b) { return a.time < b.time ? -1 : 1; });
    list.innerHTML = "";
    $("#event-empty").hidden = dayEvents.length !== 0;
    dayEvents.forEach(function (ev) {
      var li = document.createElement("li");
      li.className = "event-item";
      li.innerHTML = '<span class="ev-time">' + escapeHtml(ev.time) + "</span>" +
        '<span class="ev-title" data-id="' + escapeHtml(ev.id) + '" title="点击编辑">' + escapeHtml(ev.title) + repeatBadge(ev) + "</span>" +
        (ev.location ? '<span class="ev-loc" title="地点">@' + escapeHtml(ev.location) + "</span>" : "") +
        (ev.remind ? '<span class="ev-bell" title="到点提醒">🔔</span>' : "") +
        (ev.emailRemind ? '<span class="ev-bell" title="邮件提醒">✉</span>' : "") +
        '<button class="ev-del" data-id="' + escapeHtml(ev.id) + '" title="删除">🗑</button>';
      li.querySelector(".ev-title").addEventListener("click", function () { openEventModal(ev); });
      li.querySelector(".ev-del").addEventListener("click", function (e) {
        e.stopPropagation();
        if (ev.repeat && ev.repeat !== "none" && !confirm("该事件为重复事件，删除将移除整个系列。确认？")) return;
        delEvent(ev.id);
      });
      list.appendChild(li);
    });
  }

  function addEvent(date, time, title, remind, repeat, location, note, emailRemind, leadMinutes, emailTo) {
    events.push({
      id: Store.uid(), date: date, time: time, title: title, remind: !!remind, repeat: repeat || "none",
      location: location || "", note: note || "",
      emailRemind: !!emailRemind, leadMinutes: leadMinutes || 30, emailTo: emailTo || ""
    });
    saveEvents(); renderCalendar(); renderDashboard();
    if (reminderCfg.daemonSync) syncToDaemon();
  }
  function updateEvent(id, date, time, title, remind, repeat, location, note, emailRemind, leadMinutes, emailTo) {
    var ev = events.find(function (x) { return x.id === id; });
    if (ev) {
      ev.date = date; ev.time = time; ev.title = title; ev.remind = !!remind; ev.repeat = repeat || "none";
      ev.location = location || ""; ev.note = note || "";
      ev.emailRemind = !!emailRemind; ev.leadMinutes = leadMinutes || 30; ev.emailTo = emailTo || "";
      saveEvents(); syncReminderOnEdit(ev);
    }
    renderCalendar(); renderDashboard();
    if (reminderCfg.daemonSync) syncToDaemon();
  }
  function delEvent(id) {
    syncReminderOnDelete(id);
    events = events.filter(function (x) { return x.id !== id; });
    saveEvents(); renderCalendar(); renderDashboard();
    if (reminderCfg.daemonSync) syncToDaemon();
  }

  function initCalendar() {
    var notifBtn = $("#ev-notif-btn");
    if (notifBtn) notifBtn.addEventListener("click", function () {
      requestNotifPermission(function (granted) {
        if (granted) { toast("桌面通知已开启 🔔"); var r = $("#ev-notif-row"); if (r) r.hidden = true; }
        else toast("已使用应用内提醒（未授权系统通知）", "warn");
      });
    });

    $("#cal-prev").addEventListener("click", function () {
      calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar();
    });
    $("#cal-next").addEventListener("click", function () {
      calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar();
    });
    $("#cal-today").addEventListener("click", function () {
      var n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); selDate = ymd(n); renderCalendar();
    });

    var modal = $("#event-modal");
    function closeModal() { modal.hidden = true; editingEventId = null; }
    $("#ev-add").addEventListener("click", function () { openEventModal(null); });
    $all("[data-close]", modal).forEach(function (b) { b.addEventListener("click", closeModal); });

    function openEventModal(ev) {
      editingEventId = ev ? ev.id : null;
      $("#ev-modal-title").textContent = ev ? "编辑事件" : "添加事件";
      $("#ev-date").value = ev ? ev.date : (selDate || ymd(new Date()));
      $("#ev-time").value = ev ? ev.time : "09:00";
      $("#ev-title").value = ev ? ev.title : "";
      $("#ev-repeat").value = ev ? (ev.repeat || "none") : "none";
      $("#ev-remind").checked = ev ? !!ev.remind : true;
      $("#ev-location").value = ev ? (ev.location || "") : "";
      $("#ev-note").value = ev ? (ev.note || "") : "";
      $("#ev-email-remind").checked = ev ? !!ev.emailRemind : false;
      $("#ev-lead").value = ev ? String(ev.leadMinutes || 30) : "30";
      $("#ev-email-to").value = ev ? (ev.emailTo || "") : "";
      $("#ev-delete").hidden = !ev;
      var notifRow = $("#ev-notif-row");
      if (notifRow) {
        notifRow.hidden = !("Notification" in window) || Notification.permission === "granted";
      }
      modal.hidden = false;
    }

    $("#ev-delete").addEventListener("click", function () {
      if (editingEventId) { delEvent(editingEventId); closeModal(); toast("事件已删除"); }
    });

    $("#event-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var date = $("#ev-date").value, time = $("#ev-time").value, title = $("#ev-title").value.trim();
      if (!date || !time || !title) return;
      var repeat = $("#ev-repeat").value;
      var location = $("#ev-location").value.trim();
      var note = $("#ev-note").value.trim();
      var emailRemind = $("#ev-email-remind").checked;
      var leadMinutes = parseInt($("#ev-lead").value, 10) || 30;
      var emailTo = $("#ev-email-to").value.trim();
      if (editingEventId) { updateEvent(editingEventId, date, time, title, $("#ev-remind").checked, repeat, location, note, emailRemind, leadMinutes, emailTo); toast("事件已更新"); }
      else { addEvent(date, time, title, $("#ev-remind").checked, repeat, location, note, emailRemind, leadMinutes, emailTo); toast("事件已添加"); }
      closeModal();
    });

    /* 立即发送真实提醒：基于当前弹窗字段，真正调起邮件客户端 / POST 到网关（支持多接收人） */
    var sendNow = document.getElementById("ev-send-now");
    if (sendNow) sendNow.addEventListener("click", function () {
      var date = $("#ev-date").value, time = $("#ev-time").value, title = $("#ev-title").value.trim();
      if (!date || !time || !title) { toast("请先填写日期、时间和标题", "warn"); return; }
      if (!$("#ev-email-remind").checked) { toast("请先勾选「启用邮件提醒」", "warn"); return; }
      var emailTo = $("#ev-email-to").value.trim();
      var recs = parseEmailsR(emailTo);
      if (!recs.length) recs = parseEmailsR(reminderCfg.email);
      if (!recs.length) { toast("请先配置接收邮箱（事件级或全局提醒设置）", "warn"); return; }
      var evId = editingEventId;
      if (!evId) {
        /* 未保存则先落库拿到真实 id，避免产生孤立的提醒日志 */
        addEvent(date, time, title, $("#ev-remind").checked, repeat, location, note, emailRemind, leadMinutes, emailTo);
        evId = (events[events.length - 1] || {}).id;
      }
      var realEv = events.find(function (x) { return x.id === evId; });
      if (!realEv) { toast("发送失败：事件未保存", "warn"); return; }
      sendReminderR(buildReminderR(realEv, realEv.date), null, true);
      toast("已发送真实提醒至：" + recs.join("、"));
    });
  }

  /* ---------- 邮件提醒引擎 ---------- */
  function remKeyR(ev, ds) { return ev.id + "|" + ds; }
  function remSigR(ev, ds) {
    return [ds, ev.time, ev.title, ev.location || "", ev.note || "", ev.leadMinutes, recipientsOfR(ev).join("|")].join("\u0001");
  }
  function evDateAtR(ev, ds) {
    var t = (ev.time || "00:00").split(":");
    return new Date(ds + "T" + pad(parseInt(t[0], 10)) + ":" + pad(parseInt(t[1], 10)) + ":00");
  }
  function leadMinR(ev) { return parseInt(ev.leadMinutes, 10) || 30; }
  /* 解析多个邮箱：支持逗号 / 分号 / 全角标点 / 空白分隔，过滤非法项 */
  function parseEmailsR(str) {
    if (!str) return [];
    return String(str).split(/[,;，；\s]+/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); });
  }
  /* 返回该日程的接收人数组：事件级优先，否则用全局默认 */
  function recipientsOfR(ev) {
    var arr = parseEmailsR(ev.emailTo);
    if (arr.length) return arr;
    return parseEmailsR(reminderCfg.email);
  }
  function recipientsStrR(ev) { return recipientsOfR(ev).join(", "); }

  /* 返回事件在 [start, end] 区间内的所有发生日期（含重复） */
  function occBetweenR(ev, start, end) {
    var res = [];
    if (ev.repeat && ev.repeat !== "none") {
      var base = dateParts(ev.date);
      var cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      while (cur <= end) {
        var ds = ymd(cur);
        if (cur >= base && occursOn(ev, ds)) res.push(ds);
        cur.setDate(cur.getDate() + 1);
      }
    } else {
      var dt0 = evDateAtR(ev, ev.date);
      if (dt0 >= start && dt0 <= end) res.push(ev.date);
    }
    return res;
  }

  function buildReminderR(ev, ds) {
    var dt = evDateAtR(ev, ds);
    var remindAt = new Date(dt.getTime() - leadMinR(ev) * 60000);
    return { ev: ev, ds: ds, dt: dt, remindAt: remindAt, key: remKeyR(ev, ds), sig: remSigR(ev, ds), to: recipientsOfR(ev) };
  }
  /* 当前「应发送但未过期」的提醒列表 */
  function dueRemindersR() {
    var now = new Date();
    var horizon = new Date(now.getTime() + 60 * 24 * 3600 * 1000);
    var out = [];
    events.forEach(function (ev) {
      if (!ev.emailRemind) return;
      if (!recipientsOfR(ev).length) return;
      occBetweenR(ev, now, horizon).forEach(function (ds) {
        var r = buildReminderR(ev, ds);
        if (now >= r.remindAt && now < r.dt) out.push(r);
      });
    });
    return out;
  }

  /* 提醒内容格式：标题 / 日期 / 时间 / 地点 / 备注 / 提前量 */
  function buildReminderBodyR(ev, ds, note) {
    var lines = [];
    if (note) lines.push(note);
    lines.push("您好，您有一条日程即将开始：");
    lines.push("");
    lines.push("标题：" + (ev.title || "（无标题）"));
    lines.push("日期：" + ds);
    lines.push("时间：" + (ev.time || ""));
    lines.push("地点：" + (ev.location || "未填写"));
    lines.push("备注：" + (ev.note || "无"));
    lines.push("提前量：" + leadMinR(ev) + " 分钟");
    var recs = recipientsOfR(ev);
    if (recs.length) lines.push("接收人：" + recs.join("、"));
    lines.push("");
    lines.push("—— 个人工作台 自动提醒");
    return lines.join("\n");
  }
  function openMailtoR(toJoined, subject, body) {
    var url = "mailto:" + toJoined + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    var a = document.createElement("a");
    a.href = url; a.style.display = "none";
    document.body.appendChild(a); a.click(); a.remove();
  }
  function markLogR(r, status) {
    reminderLog[r.key] = { status: status, sentAt: new Date().toISOString(), sig: r.sig, to: r.to };
    Store.set("reminderLog", reminderLog);
  }
  /* 发送一条提醒：mailto 自动调起 或 API POST（支持多个接收人）。
     force=true 时无论 autoOpen 是否开启都立即真实发送（用于手动「立即发送真实提醒」） */
  function sendReminderR(r, note, force) {
    var to = r.to; // 数组
    var toStr = to.join(", ");
    var subject = "【日程提醒】" + r.ev.title + " · " + r.ds + " " + r.ev.time;
    var body = buildReminderBodyR(r.ev, r.ds, note);
    if (reminderCfg.mode === "api" && reminderCfg.api) {
      var payload = { to: to, toStr: toStr, subject: subject, body: body, eventId: r.ev.id, occurDate: r.ds, type: note ? "update" : "reminder" };
      fetch(reminderCfg.api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        .then(function () { markLogR(r, note ? "updated" : "sent"); renderReminderCenterR(); })
        .catch(function () { toast("提醒发送失败：" + (reminderCfg.api || ""), "warn"); renderReminderCenterR(); });
    } else {
      if (reminderCfg.autoOpen || force) {
        openMailtoR(to.join(","), subject, body);
        markLogR(r, note ? "updated" : "sent");
      } else {
        if (!reminderLog[r.key]) markLogR(r, "pending");
      }
      renderReminderCenterR();
    }
  }

  /* 日程变更同步：关闭邮件提醒 → 撤销待发；内容变更 → 已发送的标记待更新重发 */
  function syncReminderOnEdit(ev) {
    if (!ev.emailRemind) {
      Object.keys(reminderLog).forEach(function (k) {
        if (k.indexOf(ev.id + "|") === 0 && reminderLog[k].status !== "cancelled") reminderLog[k].status = "cancelled";
      });
      Store.set("reminderLog", reminderLog);
    }
  }
  /* 日程删除同步：标记已撤销；若已发送且为 API 模式，发撤销通知 */
  function syncReminderOnDelete(id) {
    Object.keys(reminderLog).forEach(function (k) {
      if (k.indexOf(id + "|") === 0) {
        var entry = reminderLog[k];
        if (entry.status === "sent" && reminderCfg.mode === "api" && reminderCfg.api) {
          try {
            fetch(reminderCfg.api, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ eventId: id, type: "cancel", note: "该日程已取消" }) }).catch(function () {});
          } catch (e) {}
        }
        entry.status = "cancelled";
      }
    });
    Store.set("reminderLog", reminderLog);
  }

  /* 主检查：应用启动 + 每 60 秒 调用 */
  function checkEmailReminders() {
    /* 已接入本地自动发送服务：自动化发信由后台守护进程负责，前端不再自动调起 mailto，避免重复发送 */
    if (reminderCfg.daemonSync && reminderCfg.daemonUrl) {
      var banner = document.getElementById("rem-daemon-banner");
      if (banner) banner.hidden = false;
      var list = document.getElementById("rem-list"); if (list) list.hidden = true;
      renderReminderCenterR();
      return;
    }
    dueRemindersR().forEach(function (r) {
      var log = reminderLog[r.key];
      if (log && log.status === "cancelled") return;
      if (log && log.status === "sent") {
        if (log.sig !== r.sig) { log.status = "updated"; log.sig = r.sig; Store.set("reminderLog", reminderLog); sendReminderR(r, "（日程已更新，以下为最新信息）"); }
        return;
      }
      sendReminderR(r);
    });
    renderReminderCenterR();
  }

  /* 提醒中心渲染：按日期分组 + 可折叠 */
  function renderReminderCenterR() {
    var sum = document.getElementById("rem-summary");
    var list = document.getElementById("rem-list");
    if (!list) return;
    var due = dueRemindersR();
    var pending = due.filter(function (r) { var l = reminderLog[r.key]; return !l || l.status === "pending"; });
    var stats = { pending: pending.length, sent: 0, updated: 0, cancelled: 0 };
    Object.keys(reminderLog).forEach(function (k) { var s = reminderLog[k].status; if (stats[s] !== undefined) stats[s]++; });
    if (sum) sum.innerHTML = '<span class="rem-chip sent">已发送 ' + stats.sent + "</span>" +
      '<span class="rem-chip updated">待更新 ' + stats.updated + "</span>" +
      '<span class="rem-chip pending">待发送 ' + stats.pending + "</span>" +
      '<span class="rem-chip cancelled">已撤销 ' + stats.cancelled + "</span>";
    var items = [];
    pending.forEach(function (r) { items.push({ r: r, status: "pending" }); });
    Object.keys(reminderLog).forEach(function (k) {
      var entry = reminderLog[k];
      if (entry.status === "pending") return;
      var parts = k.split("|"); var id = parts[0], ds = parts[1];
      var ev = events.find(function (x) { return x.id === id; });
      if (!ev) return;
      items.push({ ev: ev, ds: ds, status: entry.status, key: k });
    });
    var order = { pending: 0, updated: 1, sent: 2, cancelled: 3 };
    items.sort(function (a, b) { return (order[a.status] || 9) - (order[b.status] || 9) || (a.ds < b.ds ? 1 : -1); });
    var empty = document.getElementById("rem-empty");
    if (empty) empty.hidden = items.length !== 0;
    list.innerHTML = "";
    if (!items.length) return;

    function toOf(it) {
      if (it.r) return it.r.to.join(", ");
      var e = reminderLog[it.key];
      if (e && e.to) return Array.isArray(e.to) ? e.to.join(", ") : e.to;
      return "";
    }

    /* 按日期分组 */
    var groups = {};
    items.forEach(function (it) { (groups[it.ds] = groups[it.ds] || []).push(it); });
    var dates = Object.keys(groups).sort(function (a, b) { return a < b ? 1 : -1; });
    var labels = { pending: "待发送", updated: "待更新重发", sent: "已发送", cancelled: "已撤销" };
    var cmap = { pending: "amber", updated: "blue", sent: "green", cancelled: "grey" };

    dates.forEach(function (ds) {
      var gitems = groups[ds];
      var g = { pending: 0, updated: 0, sent: 0, cancelled: 0 };
      gitems.forEach(function (it) { g[it.status]++; });
      var chips = [];
      if (g.pending) chips.push('<span class="rem-chip amber">待发送 ' + g.pending + "</span>");
      if (g.updated) chips.push('<span class="rem-chip blue">待更新 ' + g.updated + "</span>");
      if (g.sent) chips.push('<span class="rem-chip green">已发送 ' + g.sent + "</span>");
      if (g.cancelled) chips.push('<span class="rem-chip grey">已撤销 ' + g.cancelled + "</span>");
      var collapsed = !!remCollapsed[ds];

      var li = document.createElement("li");
      li.className = "rem-group";
      li.innerHTML = '<div class="rem-group-head" data-date="' + escapeHtml(ds) + '">' +
        '<span class="rem-caret">' + (collapsed ? "▸" : "▾") + "</span>" +
        '<span class="rem-group-date">' + escapeHtml(ds) + "</span>" +
        '<span class="rem-group-chips">' + chips.join("") + "</span>" +
        '<span class="rem-group-count">' + gitems.length + " 条</span>" +
        "</div>";
      var ul = document.createElement("ul");
      ul.className = "rem-group-list event-list";
      if (collapsed) ul.hidden = true;
      gitems.forEach(function (it) {
        var ev = it.ev || it.r.ev, status = it.status;
        var li2 = document.createElement("li");
        li2.className = "event-item rem-item " + status;
        var toStr = toOf(it);
        var html = '<span class="ev-time">' + escapeHtml(ev.time) + "</span>" +
          '<span class="ev-title">' + escapeHtml(ev.title) + "</span>" +
          '<span class="rem-to" title="' + escapeHtml(toStr) + '">→ ' + escapeHtml(toStr || "未配置邮箱") + "</span>" +
          '<span class="pill ' + cmap[status] + '">' + labels[status] + "</span>";
        if (status === "pending" || status === "updated" || status === "sent") {
          html += '<button class="btn btn-sm rem-send" data-key="' + escapeHtml(it.r ? it.r.key : (ev.id + "|" + ds)) + '">' + (status === "sent" ? "重发" : "发送") + "</button>";
        }
        li2.innerHTML = html;
        ul.appendChild(li2);
      });
      li.appendChild(ul);
      list.appendChild(li);
    });

    $all(".rem-group-head", list).forEach(function (h) {
      h.addEventListener("click", function () {
        var ds = h.getAttribute("data-date");
        remCollapsed[ds] = !remCollapsed[ds];
        var ul = h.parentNode.querySelector(".rem-group-list");
        if (ul) ul.hidden = !ul.hidden;
        var caret = h.querySelector(".rem-caret");
        if (caret) caret.textContent = ul.hidden ? "▸" : "▾";
      });
    });
    $all(".rem-send", list).forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        var key = b.getAttribute("data-key");
        var parts = key.split("|");
        var ev2 = events.find(function (x) { return x.id === parts[0]; });
        if (ev2) sendReminderR(buildReminderR(ev2, parts[1]));
      });
    });
  }

  /* 提醒设置弹窗 + 按钮初始化 */
  /* ---------- 本地自动发送服务（端到端无人值守） ---------- */
  /* 把当前所有日程 + 默认邮箱推送到守护进程；成功后守护进程按提前量自动真实发信 */
  function syncToDaemon() {
    var url = (reminderCfg.daemonUrl || "").trim().replace(/\/+$/, "");
    var token = (reminderCfg.daemonToken || "").trim();
    if (!url) { reminderCfg.daemonOnline = false; updateDaemonStatusR(); return Promise.resolve(false); }
    return fetch(url + "/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Daemon-Token": token },
      body: JSON.stringify({ events: events, cfg: { email: reminderCfg.email } })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok !== false, j: j }; }); })
      .then(function (res) {
        reminderCfg.daemonOnline = !!res.ok;
        updateDaemonStatusR();
        return res.ok;
      })
      .catch(function () { reminderCfg.daemonOnline = false; updateDaemonStatusR(); return false; });
  }
  function updateDaemonStatusR() {
    var el = document.getElementById("rem-daemon-status");
    if (el) {
      if (reminderCfg.daemonSync && reminderCfg.daemonOnline) { el.className = "pill green"; el.textContent = "已连接 · 自动发送中"; }
      else if (reminderCfg.daemonSync) { el.className = "pill amber"; el.textContent = "未连接"; }
      else { el.className = "pill grey"; el.textContent = "未启用"; }
    }
  }

  function initReminderUI() {
    var sb = document.getElementById("rem-settings-btn");
    if (sb) sb.addEventListener("click", function () {
      $("#rem-email").value = reminderCfg.email || "";
      $("#rem-mode").value = reminderCfg.mode || "mailto";
      $("#rem-api").value = reminderCfg.api || "";
      $("#rem-auto").checked = !!reminderCfg.autoOpen;
      $("#rem-daemon-url").value = reminderCfg.daemonUrl || "";
      $("#rem-daemon-token").value = reminderCfg.daemonToken || "";
      $("#rem-daemon-sync").checked = !!reminderCfg.daemonSync;
      updateDaemonStatusR();
      if ($("#rem-mode")) { document.getElementById("rem-api-row").style.display = ($("#rem-mode").value === "api") ? "" : "none"; }
      document.getElementById("reminder-modal").hidden = false;
    });
    var cb = document.getElementById("rem-check-btn");
    if (cb) cb.addEventListener("click", function () { checkEmailReminders(); toast("已检查邮件提醒"); });

    var testBtn = document.getElementById("rem-test");
    if (testBtn) testBtn.addEventListener("click", function () {
      var url = ($("#rem-daemon-url").value || "").trim().replace(/\/+$/, "");
      var token = ($("#rem-daemon-token").value || "").trim();
      if (!url) { toast("请先填写服务地址", "warn"); return; }
      fetch(url + "/api/health", { headers: { "X-Daemon-Token": token } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (res.ok && res.j && res.j.ok) {
            toast("连接成功：服务运行中（dryRun=" + !!res.j.dryRun + "，已发 " + (res.j.sent || 0) + " 封）");
          } else { toast("服务返回异常：" + (res.j && res.j.error || res.j), "warn"); }
        })
        .catch(function () { toast("无法连接服务，请确认守护进程已启动", "warn"); });
    });
    var syncNow = document.getElementById("rem-sync-now");
    if (syncNow) syncNow.addEventListener("click", function () {
      reminderCfg.daemonUrl = ($("#rem-daemon-url").value || "").trim();
      reminderCfg.daemonToken = ($("#rem-daemon-token").value || "").trim();
      syncToDaemon().then(function (ok) { toast(ok ? "已全量同步到本地服务" : "同步失败，请检查服务地址/令牌", ok ? "" : "warn"); });
    });

    var form = document.getElementById("reminder-form");
    if (form) form.addEventListener("submit", function (e) {
      e.preventDefault();
      reminderCfg.email = $("#rem-email").value.trim();
      reminderCfg.mode = $("#rem-mode").value;
      reminderCfg.api = $("#rem-api").value.trim();
      reminderCfg.autoOpen = $("#rem-auto").checked;
      reminderCfg.daemonUrl = $("#rem-daemon-url").value.trim();
      reminderCfg.daemonToken = $("#rem-daemon-token").value.trim();
      reminderCfg.daemonSync = $("#rem-daemon-sync").checked;
      Store.set("reminderCfg", reminderCfg);
      updateDaemonStatusR();
      document.getElementById("reminder-modal").hidden = true;
      renderReminderCenterR();
      toast("提醒设置已保存");
      if (reminderCfg.daemonSync) syncToDaemon().then(function (ok) { if (!ok) toast("自动同步未成功，请检查服务", "warn"); });
    });
    var modeSel = document.getElementById("rem-mode");
    var apiRow = document.getElementById("rem-api-row");
    if (modeSel && apiRow) {
      var toggle = function () { apiRow.style.display = (modeSel.value === "api") ? "" : "none"; };
      modeSel.addEventListener("change", toggle);
    }
  }

  /* 提醒引擎：每 20 秒检查一次，到点事件（含重复）弹出提醒 */
  function checkReminders() {
    var now = new Date();
    var ds = ymd(now);
    var nowMin = now.getHours() * 60 + now.getMinutes();
    events.forEach(function (ev) {
      if (!ev.remind) return;
      if (!occursOn(ev, ds)) return;
      var t = ev.time.split(":");
      var evMin = parseInt(t[0], 10) * 60 + parseInt(t[1], 10);
      var key = ev.id + "|" + ds;
      if (nowMin >= evMin && nowMin <= evMin + 1 && !notified[key]) {
        notified[key] = true;
        var msg = "提醒：" + ev.time + " " + ev.title;
        toast(msg, "warn");
        if ("Notification" in window && Notification.permission === "granted") {
          try { new Notification("个人工作台提醒", { body: msg }); } catch (e) {}
        }
      }
    });
  }

  function initReminders() {
    /* 注意：浏览器要求通知权限必须由用户手势触发，故不在此自动请求，
       而是在事件弹窗中提供「开启桌面通知」按钮，由用户主动开启。 */
    checkReminders();
    setInterval(checkReminders, 20000);
    checkEmailReminders();
    setInterval(checkEmailReminders, 60000);
    initReminderUI();
    /* 启动后若已启用自动发送服务，把当前日程同步过去，让守护进程立即接管 */
    if (reminderCfg.daemonSync && reminderCfg.daemonUrl) {
      syncToDaemon().then(function (ok) { if (!ok) toast("本地自动发送服务未连接，提醒将改为前端方式", "warn"); });
    }
  }

  /* 请求系统通知权限（由用户手势触发） */
  function requestNotifPermission(cb) {
    if (!("Notification" in window)) { if (cb) cb(false); return; }
    if (Notification.permission === "granted") { if (cb) cb(true); return; }
    if (Notification.permission === "denied") { if (cb) cb(false); return; }
    try {
      var p = Notification.requestPermission();
      if (p && p.then) p.then(function (r) { if (cb) cb(r === "granted"); }).catch(function () { if (cb) cb(false); });
      else if (cb) cb(Notification.permission === "granted");
    } catch (e) { if (cb) cb(false); }
  }

  /* ---------- 便签记录 ---------- */
  var notesSaveTimer = null;
  function saveNotes() { Store.set("notes", notes); }

  function renderNotes() {
    var q = noteSearch.trim().toLowerCase();
    var list = notes.slice();
    if (q) list = list.filter(function (n) { return (n.text || "").toLowerCase().indexOf(q) >= 0; });
    list.sort(function (a, b) { return (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated - a.updated); });

    var grid = $("#notes-grid");
    grid.innerHTML = "";
    $("#notes-empty").hidden = list.length !== 0;
    list.forEach(function (n) {
      var card = document.createElement("div");
      card.className = "note-card" + (n.pinned ? " pinned" : "");
      card.innerHTML = '<textarea class="note-text" placeholder="写点什么…"></textarea>' +
        '<div class="note-foot"><span class="note-time"></span>' +
        '<span><button class="note-pin" title="置顶">📌</button>' +
        '<button class="note-del" title="删除">🗑</button></span></div>';
      var ta = card.querySelector(".note-text");
      ta.value = n.text;
      card.querySelector(".note-time").textContent = fmtTime(n.updated);
      ta.addEventListener("input", function () {
        n.text = ta.value; n.updated = Date.now();
        card.querySelector(".note-time").textContent = fmtTime(n.updated);
        clearTimeout(notesSaveTimer);
        notesSaveTimer = setTimeout(function () { saveNotes(); renderDashboard(); }, 400);
      });
      card.querySelector(".note-pin").addEventListener("click", function () {
        n.pinned = !n.pinned; n.updated = Date.now(); saveNotes(); renderNotes(); renderDashboard();
      });
      card.querySelector(".note-del").addEventListener("click", function () {
        notes = notes.filter(function (x) { return x.id !== n.id; });
        saveNotes(); renderNotes(); renderDashboard();
      });
      grid.appendChild(card);
    });
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function initNotes() {
    $("#note-add").addEventListener("click", function () {
      notes.unshift({ id: Store.uid(), text: "", updated: Date.now(), pinned: false });
      saveNotes(); renderNotes(); renderDashboard();
      var first = $("#notes-grid .note-text");
      if (first) first.focus();
    });
    $("#note-search").addEventListener("input", function (e) { noteSearch = e.target.value; renderNotes(); });
    renderNotes();
  }

  /* ---------- 链接收藏 ---------- */
  function saveLinks() { Store.set("links", links); }

  function renderLinks() {
    var q = linkSearch.trim().toLowerCase();
    var list = links.slice();
    if (q) list = list.filter(function (l) {
      return (l.name || "").toLowerCase().indexOf(q) >= 0 || (l.url || "").toLowerCase().indexOf(q) >= 0;
    });

    var grid = $("#links-grid");
    grid.innerHTML = "";
    $("#links-empty").hidden = list.length !== 0;
    list.forEach(function (l) {
      var card = document.createElement("a");
      card.className = "link-card";
      card.href = l.url; card.target = "_blank"; card.rel = "noopener noreferrer";
      var ico = l.icon || (l.name || l.url).charAt(0).toUpperCase();
      card.innerHTML = '<span class="link-ico-wrap">' + escapeHtml(ico) + "</span>" +
        '<span class="link-name">' + escapeHtml(l.name || l.url) + "</span>" +
        '<span class="link-url">' + escapeHtml(l.url.replace(/^https?:\/\//, "")) + "</span>" +
        '<button class="link-edit" data-id="' + escapeHtml(l.id) + '" title="编辑">✎</button>' +
        '<button class="link-del" data-id="' + escapeHtml(l.id) + '" title="删除">🗑</button>';
      card.querySelector(".link-del").addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        links = links.filter(function (x) { return x.id !== l.id; });
        saveLinks(); renderLinks(); renderDashboard();
      });
      card.querySelector(".link-edit").addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation(); beginEditLink(l);
      });
      grid.appendChild(card);
    });
  }

  function beginEditLink(l) {
    editingLinkId = l.id;
    $("#link-name").value = l.name || "";
    $("#link-url").value = l.url || "";
    $("#link-icon").value = l.icon || "";
    $("#link-submit").textContent = "更新";
    $("#link-cancel").hidden = false;
    $("#link-name").focus();
  }
  function cancelEditLink() {
    editingLinkId = null;
    $("#link-form").reset();
    $("#link-submit").textContent = "收藏";
    $("#link-cancel").hidden = true;
  }

  function initLinks() {
    $("#link-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = $("#link-name").value.trim();
      var url = sanitizeUrl($("#link-url").value);
      if (!url) { toast("请输入有效的链接地址", "warn"); return; }
      if (editingLinkId) {
        var l = links.find(function (x) { return x.id === editingLinkId; });
        if (l) { l.name = name || url.replace(/^https?:\/\//, ""); l.url = url; l.icon = $("#link-icon").value.trim(); saveLinks(); toast("链接已更新"); }
        cancelEditLink();
      } else {
        links.push({ id: Store.uid(), name: name || url.replace(/^https?:\/\//, ""), url: url, icon: $("#link-icon").value.trim() });
        saveLinks(); toast("已收藏");
        $("#link-name").value = ""; $("#link-url").value = ""; $("#link-icon").value = "";
      }
      renderLinks(); renderDashboard();
    });
    $("#link-cancel").addEventListener("click", cancelEditLink);
    $("#link-search").addEventListener("input", function (e) { linkSearch = e.target.value; renderLinks(); });
    renderLinks();
  }

  /* ---------- 社会关系（联系人） ---------- */
  function saveContacts() { Store.set("contacts", contacts); }

  function groupColor(g) {
    var palette = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316"];
    g = g || "其他";
    var h = 0;
    for (var i = 0; i < g.length; i++) h = (h * 31 + g.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }
  function relAvatar(c) { return c.icon || (c.name || "?").charAt(0).toUpperCase(); }

  /* 关系分类下拉：动态读取实际分类（含新增的角色/身份），保证细分后可筛选归组 */
  var DEFAULT_GROUPS = ["家人", "亲戚", "同事", "客户", "朋友", "同学", "其他"];
  function refreshGroupFilter() {
    var sel = $("#rel-group-filter");
    if (!sel) return;
    var seen = {};
    DEFAULT_GROUPS.forEach(function (g) { seen[g] = 1; });
    contacts.forEach(function (c) { seen[c.group || "其他"] = 1; });
    var arr = Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, "zh-Hans-CN"); });
    var cur = relGroupFilter;
    sel.innerHTML = '<option value="all">全部关系</option>' + arr.map(function (g) {
      return '<option value="' + escapeHtml(g) + '">' + escapeHtml(g) + "</option>";
    }).join("");
    if (cur === "all" || seen[cur]) sel.value = cur;
    else { sel.value = "all"; relGroupFilter = "all"; }
  }

  function renderRelations() {
    var q = relSearch.trim().toLowerCase();
    var g = relGroupFilter;
    var ind = relIndustryFilter;
    var list = contacts.slice();
    if (q) list = list.filter(function (c) {
      return (c.name || "").toLowerCase().indexOf(q) >= 0 ||
        (c.org || "").toLowerCase().indexOf(q) >= 0 ||
        (c.note || "").toLowerCase().indexOf(q) >= 0 ||
        (c.group || "").toLowerCase().indexOf(q) >= 0 ||
        (c.industry || "未分类").toLowerCase().indexOf(q) >= 0;
    });
    if (g && g !== "all") list = list.filter(function (c) { return (c.group || "其他") === g; });
    if (ind && ind !== "all") list = list.filter(function (c) { return (c.industry || "未分类") === ind; });
    list.sort(function (a, b) {
      return (a.group || "").localeCompare(b.group || "") || (a.name || "").localeCompare(b.name || "");
    });

    var grid = $("#rel-grid");
    grid.innerHTML = "";
    $("#rel-empty").hidden = list.length !== 0;

    list.forEach(function (c) {
      var col = sanitizeColor(c.color || groupColor(c.group)) || FALLBACK_COLOR;
      var meta = [];
      if (c.phone) meta.push('<span>📞 <a href="tel:' + escapeHtml(c.phone) + '">' + escapeHtml(c.phone) + "</a></span>");
      if (c.email) meta.push('<span>✉ <a href="mailto:' + escapeHtml(c.email) + '">' + escapeHtml(c.email) + "</a></span>");
      if (c.org) meta.push('<span>🏢 ' + escapeHtml(c.org) + "</span>");
      if (c.birthday) meta.push('<span>🎂 ' + escapeHtml(c.birthday) + "</span>");
      var card = document.createElement("div");
      card.className = "rel-card";
      card.innerHTML =
        '<div class="rel-head"><span class="rel-avatar">' + escapeHtml(relAvatar(c)) + "</span>" +
        '<div class="rel-id"><span class="rel-name">' + escapeHtml(c.name) + "</span>" +
        '<span class="rel-group" style="background:' + col + '22;color:' + col + '">' + escapeHtml(c.group || "其他") + "</span>" +
        (c.industry && c.industry !== "未分类" ? '<span class="rel-industry">' + escapeHtml(c.industry) + "</span>" : "") + "</div></div>" +
        (meta.length ? '<div class="rel-meta">' + meta.join("") + "</div>" : "") +
        (c.note ? '<div class="rel-note">' + escapeHtml(c.note) + "</div>" : "") +
        '<button class="rel-edit" data-id="' + escapeHtml(c.id) + '" title="编辑">✎</button>' +
        '<button class="rel-del" data-id="' + escapeHtml(c.id) + '" title="删除">🗑</button>';
      card.querySelector(".rel-del").addEventListener("click", function (e) {
        e.stopPropagation();
        if (confirm("删除联系人「" + (c.name || "") + "」？")) {
          contacts = contacts.filter(function (x) { return x.id !== c.id; });
          saveContacts(); refreshGroupFilter(); renderRelations(); renderDashboard();
        }
      });
      card.querySelector(".rel-edit").addEventListener("click", function (e) { e.stopPropagation(); openContactModal(c); });
      card.addEventListener("click", function () { openContactModal(c); });
      grid.appendChild(card);
    });
  }

  function initRelations() {
    $("#rel-search").addEventListener("input", function (e) { relSearch = e.target.value; renderRelations(); });
    $("#rel-group-filter").addEventListener("change", function (e) { relGroupFilter = e.target.value; renderRelations(); });
    $("#rel-industry-filter").addEventListener("change", function (e) { relIndustryFilter = e.target.value; renderRelations(); });
    $("#rel-add").addEventListener("click", function () { openContactModal(null); });

    var modal = $("#contact-modal");
    function closeModal() { modal.hidden = true; editingContactId = null; }

    $all("[data-close]", modal).forEach(function (b) { b.addEventListener("click", closeModal); });

    function openContactModal(c) {
      editingContactId = c ? c.id : null;
      $("#rel-modal-title").textContent = c ? "编辑联系人" : "新增联系人";
      $("#rel-name").value = c ? c.name : "";
      $("#rel-group").value = c ? c.group : "";
      $("#rel-industry").value = c ? (c.industry || "未分类") : "未分类";
      $("#rel-phone").value = c ? c.phone : "";
      $("#rel-email").value = c ? c.email : "";
      $("#rel-org").value = c ? c.org : "";
      $("#rel-birthday").value = c ? c.birthday : "";
      $("#rel-icon").value = c ? c.icon : "";
      $("#rel-color").value = c && c.color ? c.color : (c ? groupColor(c.group) : "#4f46e5");
      $("#rel-note").value = c ? c.note : "";
      $("#rel-delete").hidden = !c;
      modal.hidden = false;
    }

    $("#rel-delete").addEventListener("click", function () {
      if (!editingContactId) return;
      if (!confirm("删除该联系人？")) return;
      contacts = contacts.filter(function (x) { return x.id !== editingContactId; });
      saveContacts(); closeModal(); refreshGroupFilter(); renderRelations(); renderDashboard();
    });

    $("#contact-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = $("#rel-name").value.trim();
      if (!name) return;
      var data = {
        name: name,
        group: $("#rel-group").value.trim() || "其他",
        industry: $("#rel-industry").value || "未分类",
        phone: $("#rel-phone").value.trim(),
        email: $("#rel-email").value.trim(),
        org: $("#rel-org").value.trim(),
        birthday: $("#rel-birthday").value,
        icon: $("#rel-icon").value.trim(),
        color: $("#rel-color").value,
        note: $("#rel-note").value.trim(),
      };
      if (editingContactId) {
        var c = contacts.find(function (x) { return x.id === editingContactId; });
        if (c) { for (var k in data) c[k] = data[k]; c.updated = Date.now(); saveContacts(); toast("联系人已更新"); }
      } else {
        data.id = Store.uid(); data.created = Date.now(); data.updated = Date.now();
        contacts.push(data); saveContacts(); toast("已添加联系人");
      }
      closeModal(); refreshGroupFilter(); renderRelations(); renderDashboard();
    });
    refreshGroupFilter();
  }

  /* ---------- 项目管理（本地项目目录 + 一键定位） ---------- */
  function saveProjects() { Store.set("projects", projects); }

  function projAvatar(p) { return (p.name || "?").charAt(0).toUpperCase(); }
  function statusText(s) {
    return { planning: "规划中", active: "进行中", done: "已完成", paused: "搁置" }[s] || "进行中";
  }
  function statusColor(s) {
    return { planning: "#0ea5e9", active: "#4f46e5", done: "#10b981", paused: "#f59e0b" }[s] || "#4f46e5";
  }

  /* 复制文本到剪贴板的 copyText() 统一定义于下方提示词区域（仅保留一处，避免重复声明） */


  /* 直接定位本地文件夹：file:// 源下浏览器允许打开；http(s) 源被浏览器安全策略禁止，
     此时复制路径并提示用户在资源管理器中粘贴打开。 */
  function openProjectFolder(path) {
    path = (path || "").trim();
    if (!path) { toast("未填写文件夹路径", "warn"); return; }
    if (location.protocol === "file:") {
      var s = path.replace(/\\/g, "/");
      if (!s.startsWith("/")) s = "/" + s;
      var a = document.createElement("a");
      a.href = "file://" + s;
      a.target = "_blank";
      document.body.appendChild(a); a.click(); a.remove();
    } else {
      copyText(path);
      toast("已复制路径，请在文件资源管理器中粘贴打开：" + path, "warn");
    }
  }

  function renderProjectStats() {
    var counts = { planning: 0, active: 0, done: 0, paused: 0 };
    projects.forEach(function (p) { var s = p.status || "active"; counts[s] = (counts[s] || 0) + 1; });
    var total = 0, done = 0;
    projects.forEach(function (p) { (p.todos || []).forEach(function (t) { total++; if (t.done) done++; }); });
    var order = [["planning", "规划中"], ["active", "进行中"], ["done", "已完成"], ["paused", "搁置"]];
    var pills = order.map(function (o) {
      var c = counts[o[0]] || 0, col = sanitizeColor(statusColor(o[0])) || FALLBACK_COLOR;
      var active = (projStatusFilter === o[0]) ? " active" : "";
      return '<button class="proj-stat-pill' + active + '" data-status="' + o[0] + '" style="border-color:' + col + '55;color:' + col + '">' +
        statusText(o[0]) + " <b>" + c + "</b></button>";
    }).join("");
    $("#proj-stats").innerHTML =
      '<div class="proj-stat-row">' + pills + "</div>" +
      '<div class="proj-stat-todo">项目待办 共 <b>' + total + "</b> · 已完成 <b>" + done + "</b> · 未完成 <b>" + (total - done) + "</b></div>";
    $all("#proj-stats .proj-stat-pill").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = b.getAttribute("data-status");
        projStatusFilter = (projStatusFilter === s) ? "all" : s;
        $("#proj-status-filter").value = projStatusFilter;
        renderProjects();
      });
    });
  }

  function renderProjects() {
    renderProjectStats();
    var q = projSearch.trim().toLowerCase();
    var g = projStatusFilter;
    var list = projects.slice();
    if (q) list = list.filter(function (p) {
      return (p.name || "").toLowerCase().indexOf(q) >= 0 ||
        (p.note || "").toLowerCase().indexOf(q) >= 0 ||
        (p.stack || "").toLowerCase().indexOf(q) >= 0;
    });
    if (g && g !== "all") list = list.filter(function (p) { return (p.status || "active") === g; });
    var rank = { active: 0, planning: 1, paused: 2, done: 3 };
    list.sort(function (a, b) {
      return (rank[a.status] || 1) - (rank[b.status] || 1) || (b.updated || 0) - (a.updated || 0);
    });

    var grid = $("#proj-grid");
    grid.innerHTML = "";
    $("#proj-empty").hidden = list.length !== 0;
    list.forEach(function (p) {
      p.todos = p.todos || [];
      var col = sanitizeColor(p.color || statusColor(p.status)) || FALLBACK_COLOR;
      var card = document.createElement("div");
      card.className = "proj-card";
      var meta = [];
      if (p.stack) meta.push("🏷 " + escapeHtml(p.stack));
      if (p.note) meta.push("📝 " + escapeHtml(p.note));
      var doneT = p.todos.filter(function (t) { return t.done; }).length;
      var todoSummary = p.todos.length
        ? '<div class="proj-todo-sum">✓ 待办 <b>' + (p.todos.length - doneT) + '</b> / 共 <b>' + p.todos.length + '</b></div>'
        : "";
      card.innerHTML =
        '<div class="proj-head"><span class="proj-avatar">' + escapeHtml(projAvatar(p)) + "</span>" +
        '<div class="proj-id"><span class="proj-name">' + escapeHtml(p.name) + "</span>" +
        '<span class="proj-status" style="background:' + col + '22;color:' + col + '">' + statusText(p.status) + "</span></div></div>" +
        '<div class="proj-path" title="点击打开本地文件夹：' + escapeHtml(p.path) + '"><span class="proj-path-text">' + escapeHtml(p.path) + "</span>" +
        '<button class="proj-copy" type="button" title="复制路径">⧉</button></div>' +
        (meta.length ? '<div class="proj-meta">' + meta.join("　") + "</div>" : "") +
        todoSummary +
        '<div class="proj-actions">' +
        '<button class="btn btn-primary btn-sm" data-act="open">打开文件夹</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>' +
        '<button class="btn btn-ghost btn-sm proj-del-btn" data-act="del">删除</button></div>';
      card.querySelector(".proj-path").addEventListener("click", function (e) { e.stopPropagation(); openProjectFolder(p.path); });
      card.querySelector('[data-act="open"]').addEventListener("click", function (e) { e.stopPropagation(); openProjectFolder(p.path); });
      card.querySelector('[data-act="edit"]').addEventListener("click", function (e) { e.stopPropagation(); openProjectModal(p); });
      card.querySelector('[data-act="del"]').addEventListener("click", function (e) {
        e.stopPropagation();
        if (confirm("删除项目「" + (p.name || "") + "」？")) {
          projects = projects.filter(function (x) { return x.id !== p.id; });
          saveProjects(); renderProjects(); renderDashboard();
        }
      });
      card.querySelector(".proj-copy").addEventListener("click", function (e) {
        e.stopPropagation(); copyText(p.path); toast("路径已复制：" + p.path);
      });
      card.addEventListener("click", function () { openProjectModal(p); });
      grid.appendChild(card);
    });
  }

  var editingProjectId = null;
  function initProjects() {
    $("#proj-search").addEventListener("input", function (e) { projSearch = e.target.value; renderProjects(); });
    $("#proj-status-filter").addEventListener("change", function (e) { projStatusFilter = e.target.value; renderProjects(); });
    $("#proj-add").addEventListener("click", function () { openProjectModal(null); });

    var modal = $("#project-modal");
    var modalTodos = [];
    function closeModal() { modal.hidden = true; editingProjectId = null; modalTodos = []; }

    function addModalTodo(title) {
      title = (title || "").trim();
      if (!title) return;
      modalTodos.push({ id: Store.uid(), title: title, done: false });
      $("#proj-todo-input").value = ""; renderModalTodos();
    }
    function renderModalTodos() {
      var ul = $("#proj-todo-list");
      ul.innerHTML = "";
      modalTodos.forEach(function (t) {
        var li = document.createElement("li");
        li.className = "proj-todo-item" + (t.done ? " done" : "");
        li.innerHTML = '<label class="pt-check"><input type="checkbox" ' + (t.done ? "checked" : "") + ' /><span>' + escapeHtml(t.title) + "</span></label>" +
          '<button class="pt-del" type="button" title="删除">✕</button>';
        li.querySelector("input").addEventListener("change", function () { t.done = this.checked; renderModalTodos(); });
        li.querySelector(".pt-del").addEventListener("click", function () {
          modalTodos = modalTodos.filter(function (x) { return x.id !== t.id; }); renderModalTodos();
        });
        ul.appendChild(li);
      });
      $("#proj-todo-count").textContent = modalTodos.length;
      $("#proj-todo-empty").hidden = modalTodos.length !== 0;
    }
    $("#proj-todo-add").addEventListener("click", function () { addModalTodo($("#proj-todo-input").value); });
    $("#proj-todo-input").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addModalTodo(this.value); } });

    $all("[data-close]", modal).forEach(function (b) { b.addEventListener("click", closeModal); });

    function openProjectModal(p) {
      editingProjectId = p ? p.id : null;
      modalTodos = (p && p.todos) ? p.todos.map(function (t) { return { id: t.id || Store.uid(), title: t.title, done: !!t.done }; }) : [];
      $("#proj-modal-title").textContent = p ? "编辑项目" : "新建项目";
      $("#proj-name").value = p ? p.name : "";
      $("#proj-path").value = p ? p.path : "";
      $("#proj-status").value = p ? p.status : "active";
      $("#proj-color").value = p && p.color ? p.color : statusColor(p ? p.status : "active");
      $("#proj-stack").value = p ? p.stack : "";
      $("#proj-note").value = p ? p.note : "";
      $("#proj-delete").hidden = !p;
      renderModalTodos();
      modal.hidden = false;
    }

    $("#proj-delete").addEventListener("click", function () {
      if (!editingProjectId) return;
      if (!confirm("删除该项目？")) return;
      projects = projects.filter(function (x) { return x.id !== editingProjectId; });
      saveProjects(); closeModal(); renderProjects(); renderDashboard();
    });

    $("#project-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var name = $("#proj-name").value.trim();
      var path = $("#proj-path").value.trim();
      if (!name) { toast("请输入项目名称", "warn"); return; }
      if (!path) { toast("请输入本地文件夹路径", "warn"); return; }
      var data = {
        name: name, path: path, status: $("#proj-status").value,
        color: $("#proj-color").value, stack: $("#proj-stack").value.trim(), note: $("#proj-note").value.trim(),
        todos: modalTodos.slice()
      };
      if (editingProjectId) {
        var pr = projects.find(function (x) { return x.id === editingProjectId; });
        if (pr) { for (var k in data) pr[k] = data[k]; pr.updated = Date.now(); saveProjects(); toast("项目已更新"); }
      } else {
        data.id = Store.uid(); data.created = Date.now(); data.updated = Date.now();
        projects.push(data); saveProjects(); toast("已添加项目");
      }
      closeModal(); renderProjects(); renderDashboard();
    });
  }

  /* ---------- 专注番茄钟 ---------- */
  var focus = { mode: "work", remaining: focusSettings.work * 60, running: false, timer: null, round: 0 };

  function fmtMMSS(s) { var m = Math.floor(s / 60), ss = s % 60; return pad(m) + ":" + pad(ss); }
  function focusModeLabel(m) { return m === "work" ? "专注" : m === "short" ? "短休" : "长休"; }
  function focusDuration(m) {
    var s = focusSettings;
    return (m === "work" ? s.work : m === "short" ? s.short : s.long) * 60;
  }
  function focusTodayCount() {
    var t = todayStr();
    return focusLog.filter(function (ts) { return ymd(new Date(ts)) === t; }).length;
  }
  function focusRender() {
    $("#focus-mode").textContent = focusModeLabel(focus.mode);
    $("#focus-time").textContent = fmtMMSS(focus.remaining);
    $("#focus-toggle").textContent = focus.running ? "暂停" : "开始";
    $("#focus-stat").textContent = "今日已完成 " + focusTodayCount() + " 个专注";
    var total = focusDuration(focus.mode) || 1;
    var pct = Math.max(0, Math.min(100, Math.round((1 - focus.remaining / total) * 100)));
    $("#focus-prog").style.width = pct + "%";
    $("#focus-fab").classList.toggle("active", focus.running);
    $("#focus-panel").classList.toggle("work", focus.mode === "work");
  }
  function focusStart() {
    if (focus.running) return;
    focus.running = true;
    tickFocus();
    focus.timer = setInterval(tickFocus, 1000);
    focusRender();
  }
  function focusPause() { focus.running = false; clearInterval(focus.timer); focusRender(); }
  function focusToggle() { focus.running ? focusPause() : focusStart(); }
  function tickFocus() {
    if (focus.remaining > 0) { focus.remaining--; focusRender(); }
    else { focusComplete(); }
  }
  function focusComplete() {
    clearInterval(focus.timer); focus.running = false;
    if (focus.mode === "work") {
      focusLog.push(Date.now()); Store.set("focusLog", focusLog);
      renderDashboard(); toast("专注完成，休息一下 ☕", "warn");
    } else { toast("休息结束，继续加油 💪"); }
    var next = focus.mode === "work" ? (focus.round % 4 === 3 ? "long" : "short") : "work";
    if (focus.mode === "work") focus.round++;
    focus.mode = next;
    focus.remaining = focusDuration(next);
    if (focusSettings.auto) focusStart(); else focusRender();
  }
  function focusReset() {
    clearInterval(focus.timer); focus.running = false;
    focus.mode = "work"; focus.remaining = focusDuration("work"); focusRender();
  }
  function focusSkip() {
    clearInterval(focus.timer); focus.running = false;
    var next = focus.mode === "work" ? (focus.round % 4 === 3 ? "long" : "short") : "work";
    if (focus.mode === "work") focus.round++;
    focus.mode = next; focus.remaining = focusDuration(next); focusRender();
  }
  /* ============================================================
     新增模块：邮件模板库 / 访谈话书库 / 服务部署面板 / 提示词仓库
     数据均经 Store（用户命名空间）持久化，与既有模块风格一致。
     ============================================================ */

  function saveEmails() { Store.set("emails", emails); }
  function saveInterviews() { Store.set("interviews", interviews); }
  function saveDeploys() { Store.set("deploys", deploys); }
  function savePrompts() { Store.set("prompts", prompts); }

  function copyText(txt) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(function () { toast("已复制到剪贴板"); }, function () { fallbackCopy(txt); });
    } else { fallbackCopy(txt); }
  }
  function fallbackCopy(txt) {
    var ta = document.createElement("textarea");
    ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("已复制到剪贴板"); }
    catch (e) { toast("复制失败，请手动复制", "warn"); }
    ta.remove();
  }
  function byNew(a, b) { return (b.created || 0) - (a.created || 0); }
  function parseTagsCsv(s) {
    return (s || "").split(/[,，]/).map(function (x) { return x.trim(); })
      .filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 8);
  }

  /* ---------- 邮件模板库 ---------- */
  var emailCatFilter = "all";
  var editingEmailId = null;

  function renderEmailCatOptions() {
    var cats = {};
    emails.forEach(function (e) { if (e.category) cats[e.category] = 1; });
    var sel = $("#email-cat-filter"), dl = $("#email-cats");
    var cur = sel.value;
    sel.innerHTML = '<option value="all">全部分类</option>' +
      Object.keys(cats).map(function (c) { return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + "</option>"; }).join("");
    if (cur) sel.value = cur;
    if (dl) dl.innerHTML = Object.keys(cats).map(function (c) { return '<option value="' + escapeHtml(c) + '">'; }).join("");
  }

  function renderEmails() {
    var q = emailSearch.trim().toLowerCase();
    var items = emails.slice().sort(byNew);
    if (emailCatFilter !== "all") items = items.filter(function (e) { return e.category === emailCatFilter; });
    if (q) items = items.filter(function (e) { return (e.name + " " + (e.subject || "") + " " + (e.category || "")).toLowerCase().indexOf(q) >= 0; });
    var grid = $("#email-grid");
    grid.innerHTML = "";
    $("#email-empty").hidden = items.length !== 0;
    items.forEach(function (e) {
      var card = document.createElement("div");
      card.className = "item-card email-card";
      var varsHtml = (e.variables || []).map(function (v) { return '<span class="item-tag">' + escapeHtml(v) + "</span>"; }).join("");
      card.innerHTML =
        '<div class="item-head"><span class="item-title">' + escapeHtml(e.name) + "</span>" +
        (e.category ? '<span class="item-cat">' + escapeHtml(e.category) + "</span>" : "") + "</div>" +
        (e.subject ? '<div class="item-sub">' + escapeHtml(e.subject) + "</div>" : "") +
        (varsHtml ? '<div class="item-tags">' + varsHtml + "</div>" : "") +
        '<div class="item-foot"><span class="muted">用 ' + (e.usageCount || 0) + " 次</span>" +
        '<div class="item-acts"><button class="btn btn-ghost btn-sm" data-act="use">调用</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>' +
        '<button class="item-del" data-act="del">🗑</button></div></div>';
      card.querySelector('[data-act="use"]').addEventListener("click", function () { openEmailUse(e.id); });
      card.querySelector('[data-act="edit"]').addEventListener("click", function () { openEmailModal(e.id); });
      card.querySelector('[data-act="del"]').addEventListener("click", function () { delEmail(e.id); });
      grid.appendChild(card);
    });
    renderEmailCatOptions();
  }

  function openEmailModal(id) {
    editingEmailId = id || null;
    var e = id ? emails.find(function (x) { return x.id === id; }) : null;
    $("#email-modal-title").textContent = e ? "编辑邮件模板" : "新建邮件模板";
    $("#email-name").value = e ? e.name : "";
    $("#email-category").value = e ? (e.category || "") : "";
    $("#email-subject").value = e ? (e.subject || "") : "";
    $("#email-body").value = e ? (e.body || "") : "";
    $("#email-vars").value = e ? (e.variables || []).join(", ") : "";
    $("#email-delete").hidden = !e;
    $("#email-modal").hidden = false;
    setTimeout(function () { $("#email-name").focus(); }, 30);
  }

  function openEmailUse(id) {
    var e = emails.find(function (x) { return x.id === id; });
    if (!e) return;
    var vars = e.variables || [];
    if (!vars.length) {
      copyText((e.subject ? ("【" + e.subject + "】\n") : "") + (e.body || ""));
      e.usageCount = (e.usageCount || 0) + 1; saveEmails(); renderEmails(); return;
    }
    var filled = {}, i = 0;
    function ask() {
      if (i >= vars.length) {
        var txt = (e.subject ? ("【" + e.subject + "】\n") : "") + (e.body || "");
        vars.forEach(function (v) { txt = txt.split("{{" + v + "}}").join(filled[v] || ("{{" + v + "}}")); });
        copyText(txt);
        e.usageCount = (e.usageCount || 0) + 1; saveEmails(); renderEmails();
        return;
      }
      var val = window.prompt("填写变量「" + vars[i] + "」：", "");
      if (val === null) return;
      filled[vars[i]] = val; i++; ask();
    }
    ask();
  }

  function delEmail(id) {
    if (!confirm("删除该邮件模板？")) return;
    emails = emails.filter(function (x) { return x.id !== id; });
    saveEmails(); renderEmails();
  }

  function initEmails() {
    $("#email-add").addEventListener("click", function () { openEmailModal(null); });
    $("#email-search").addEventListener("input", function (ev) { emailSearch = ev.target.value; renderEmails(); });
    $("#email-cat-filter").addEventListener("change", function (ev) { emailCatFilter = ev.target.value; renderEmails(); });
    $("#email-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var name = $("#email-name").value.trim();
      if (!name) return;
      var obj = {
        name: name, category: $("#email-category").value.trim(), subject: $("#email-subject").value.trim(),
        body: $("#email-body").value, variables: parseTagsCsv($("#email-vars").value), usageCount: 0, created: Date.now()
      };
      if (editingEmailId) {
        var ex = emails.find(function (x) { return x.id === editingEmailId; });
        if (ex) { ex.name = obj.name; ex.category = obj.category; ex.subject = obj.subject; ex.body = obj.body; ex.variables = obj.variables; }
      } else { obj.id = Store.uid(); emails.push(obj); }
      saveEmails(); $("#email-modal").hidden = true; renderEmails();
    });
    $("#email-delete").addEventListener("click", function () { if (editingEmailId) { delEmail(editingEmailId); $("#email-modal").hidden = true; } });
    renderEmails();
  }

  /* ---------- 访谈话书库 ---------- */
  var interviewTagFilter = [];
  var editingInterviewId = null;

  function renderInterviewTags() {
    var wrap = $("#interview-tags-filter");
    if (!wrap) return;
    var all = {};
    interviews.forEach(function (it) { (it.tags || []).forEach(function (t) { all[t] = 1; }); });
    var tags = Object.keys(all);
    wrap.innerHTML = "";
    tags.forEach(function (tg) {
      var b = document.createElement("button");
      b.className = "tag-chip" + (interviewTagFilter.indexOf(tg) >= 0 ? " active" : "");
      b.textContent = tg;
      b.addEventListener("click", function () {
        var i = interviewTagFilter.indexOf(tg);
        if (i >= 0) interviewTagFilter.splice(i, 1); else interviewTagFilter.push(tg);
        renderInterviewTags(); renderInterviews();
      });
      wrap.appendChild(b);
    });
  }

  function renderInterviews() {
    var q = interviewSearch.trim().toLowerCase();
    var items = interviews.slice().sort(byNew);
    if (interviewTypeFilter !== "all") items = items.filter(function (it) { return (it.type || "提纲") === interviewTypeFilter; });
    if (interviewTagFilter.length) items = items.filter(function (it) { return (it.tags || []).some(function (t) { return interviewTagFilter.indexOf(t) >= 0; }); });
    if (q) items = items.filter(function (it) { return (it.title + " " + (it.topic || "") + " " + (it.content || "")).toLowerCase().indexOf(q) >= 0; });
    var grid = $("#interview-grid");
    grid.innerHTML = "";
    $("#interview-empty").hidden = items.length !== 0;
    var today0 = new Date(); today0.setHours(0, 0, 0, 0);
    items.forEach(function (it) {
      var card = document.createElement("div");
      card.className = "item-card interview-card" + (it.done ? " done" : "");
      var tagsHtml = (it.tags || []).map(function (t) { return '<span class="item-tag">' + escapeHtml(t) + "</span>"; }).join("");
      var typeText = it.type || "提纲";
      var dueHtml = "";
      if (it.dueDate) {
        var overdue = !it.done && new Date(it.dueDate + "T00:00:00").getTime() < today0.getTime();
        dueHtml = '<span class="item-due">📅 ' + escapeHtml(it.dueDate) + (overdue ? ' <span class="tag-overdue">逾期</span>' : "") + "</span>";
      }
      var content = it.content || "";
      card.innerHTML =
        '<div class="item-head"><span class="item-title">' + escapeHtml(it.title) + "</span>" +
        '<span class="item-cat">' + escapeHtml(typeText) + "</span></div>" +
        (it.topic ? '<div class="item-sub">' + escapeHtml(it.topic) + "</div>" : "") +
        (content ? '<div class="item-meta">' + escapeHtml(content.slice(0, 80)) + (content.length > 80 ? "…" : "") + "</div>" : "") +
        (tagsHtml ? '<div class="item-tags">' + tagsHtml + "</div>" : "") +
        (dueHtml ? '<div class="item-due-row">' + dueHtml + "</div>" : "") +
        '<div class="item-foot"><label class="check item-done"><input type="checkbox" ' + (it.done ? "checked" : "") + "/> 已完成</label>" +
        '<div class="item-acts"><button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>' +
        '<button class="item-del" data-act="del">🗑</button></div></div>';
      card.querySelector('[data-act="edit"]').addEventListener("click", function () { openInterviewModal(it.id); });
      card.querySelector('[data-act="del"]').addEventListener("click", function () { delInterview(it.id); });
      card.querySelector('input[type="checkbox"]').addEventListener("change", function () { it.done = this.checked; saveInterviews(); renderInterviews(); renderDashboard(); });
      grid.appendChild(card);
    });
    renderInterviewTags();
  }

  function openInterviewModal(id) {
    editingInterviewId = id || null;
    var it = id ? interviews.find(function (x) { return x.id === id; }) : null;
    $("#interview-modal-title").textContent = it ? "编辑访谈条目" : "新增访谈条目";
    $("#interview-title").value = it ? it.title : "";
    $("#interview-type").value = it ? (it.type || "提纲") : "提纲";
    $("#interview-topic").value = it ? (it.topic || "") : "";
    $("#interview-tags").value = it ? (it.tags || []).join(", ") : "";
    $("#interview-due").value = it ? (it.dueDate || "") : "";
    $("#interview-content").value = it ? (it.content || "") : "";
    $("#interview-delete").hidden = !it;
    $("#interview-modal").hidden = false;
    setTimeout(function () { $("#interview-title").focus(); }, 30);
  }

  function delInterview(id) {
    if (!confirm("删除该访谈条目？")) return;
    interviews = interviews.filter(function (x) { return x.id !== id; });
    saveInterviews(); renderInterviews(); renderDashboard();
  }

  function initInterviews() {
    $("#interview-add").addEventListener("click", function () { openInterviewModal(null); });
    $("#interview-search").addEventListener("input", function (ev) { interviewSearch = ev.target.value; renderInterviews(); });
    $("#interview-type-filter").addEventListener("click", function (ev) {
      var b = ev.target.closest(".seg-btn"); if (!b) return;
      interviewTypeFilter = b.dataset.type;
      $all("#interview-type-filter .seg-btn").forEach(function (x) { x.classList.toggle("active", x === b); });
      renderInterviews();
    });
    $("#interview-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var title = $("#interview-title").value.trim();
      if (!title) return;
      var obj = {
        title: title, type: $("#interview-type").value, topic: $("#interview-topic").value.trim(),
        tags: parseTagsCsv($("#interview-tags").value), dueDate: $("#interview-due").value,
        content: $("#interview-content").value, done: false, created: Date.now()
      };
      if (editingInterviewId) {
        var ex = interviews.find(function (x) { return x.id === editingInterviewId; });
        if (ex) { ex.title = obj.title; ex.type = obj.type; ex.topic = obj.topic; ex.tags = obj.tags; ex.dueDate = obj.dueDate; ex.content = obj.content; }
      } else { obj.id = Store.uid(); interviews.push(obj); }
      saveInterviews(); $("#interview-modal").hidden = true; renderInterviews(); renderDashboard();
    });
    $("#interview-delete").addEventListener("click", function () { if (editingInterviewId) { delInterview(editingInterviewId); $("#interview-modal").hidden = true; } });
    renderInterviews();
  }

  /* ---------- 服务部署快捷面板 ---------- */
  var editingDeployId = null;

  function deployStatusText(s) { return { unknown: "未知", running: "运行中", down: "异常", deploying: "部署中" }[s] || "未知"; }
  function deployStatusColor(s) { return { unknown: "var(--muted)", running: "var(--success)", down: "var(--danger)", deploying: "var(--warn)" }[s] || "var(--muted)"; }

  function renderDeploys() {
    var q = deploySearch.trim().toLowerCase();
    var items = deploys.slice().sort(byNew);
    if (q) items = items.filter(function (d) { return (d.name + " " + (d.host || "") + " " + (d.kind || "")).toLowerCase().indexOf(q) >= 0; });
    var grid = $("#deploy-grid");
    grid.innerHTML = "";
    $("#deploy-empty").hidden = items.length !== 0;
    items.forEach(function (d) {
      var card = document.createElement("div");
      card.className = "item-card deploy-card";
      var addr = (d.host ? d.host : "") + (d.port ? ":" + d.port : "");
      card.innerHTML =
        '<div class="item-head"><span class="item-title">' + escapeHtml(d.name) + "</span>" +
        '<span class="item-status" data-st="' + escapeHtml(d.status || "unknown") + '">' + deployStatusText(d.status) + "</span></div>" +
        '<div class="item-meta">' + escapeHtml(({ web: "Web 服务", api: "API 服务", db: "数据库", worker: "后台任务", other: "其他" }[d.kind] || "服务")) +
        (addr ? " · " + escapeHtml(addr) : "") + "</div>" +
        (d.notes ? '<div class="item-sub">' + escapeHtml(d.notes) + "</div>" : "") +
        '<div class="item-acts" style="margin-top:10px">' +
        (d.healthUrl ? '<button class="btn btn-ghost btn-sm" data-act="open">打开</button>' : "") +
        '<button class="btn btn-primary btn-sm" data-act="deploy">一键部署</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="check">检查状态</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>' +
        '<button class="item-del" data-act="del">🗑</button></div>';
      if (d.healthUrl) card.querySelector('[data-act="open"]').addEventListener("click", function () { window.open(d.healthUrl, "_blank", "noopener"); });
      card.querySelector('[data-act="deploy"]').addEventListener("click", function () { deployNow(d.id); });
      card.querySelector('[data-act="check"]').addEventListener("click", function () { checkStatus(d.id, card); });
      card.querySelector('[data-act="edit"]').addEventListener("click", function () { openDeployModal(d.id); });
      card.querySelector('[data-act="del"]').addEventListener("click", function () { delDeploy(d.id); });
      grid.appendChild(card);
    });
  }

  function deployNow(id) {
    var d = deploys.find(function (x) { return x.id === id; });
    if (!d) return;
    if (d.deployCmd) copyText(d.deployCmd);
    if (d.apiEndpoint) {
      fetch(d.apiEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: d.name, action: "deploy" }) })
        .then(function (r) { toast(r.ok ? "已触发部署网关" : "部署网关返回 " + r.status); })
        .catch(function () { toast("部署网关请求失败（可能跨域或地址不可达）", "warn"); });
    }
    if (d.healthUrl) window.open(d.healthUrl, "_blank", "noopener");
    toast("已复制部署命令" + (d.apiEndpoint ? "并触发网关" : ""));
  }

  function checkStatus(id, card) {
    var d = deploys.find(function (x) { return x.id === id; });
    if (!d || !d.healthUrl) { toast("未配置健康检查地址", "warn"); return; }
    var badge = card ? card.querySelector(".item-status") : null;
    if (badge) { badge.textContent = "检查中…"; badge.style.color = "var(--warn)"; }
    fetch(d.healthUrl, { method: "GET", cache: "no-store" })
      .then(function (r) { d.status = r.ok ? "running" : "down"; })
      .catch(function () { d.status = "down"; })
      .then(function () { saveDeploys(); renderDeploys(); renderDashboard(); });
  }

  function openDeployModal(id) {
    editingDeployId = id || null;
    var d = id ? deploys.find(function (x) { return x.id === id; }) : null;
    $("#deploy-modal-title").textContent = d ? "编辑服务" : "添加服务";
    $("#deploy-name").value = d ? d.name : "";
    $("#deploy-kind").value = d ? (d.kind || "web") : "web";
    $("#deploy-host").value = d ? (d.host || "") : "";
    $("#deploy-port").value = d ? (d.port || "") : "";
    $("#deploy-health").value = d ? (d.healthUrl || "") : "";
    $("#deploy-cmd").value = d ? (d.deployCmd || "") : "";
    $("#deploy-api").value = d ? (d.apiEndpoint || "") : "";
    $("#deploy-notes").value = d ? (d.notes || "") : "";
    $("#deploy-delete").hidden = !d;
    $("#deploy-modal").hidden = false;
    setTimeout(function () { $("#deploy-name").focus(); }, 30);
  }

  function delDeploy(id) {
    if (!confirm("删除该服务？")) return;
    deploys = deploys.filter(function (x) { return x.id !== id; });
    saveDeploys(); renderDeploys(); renderDashboard();
  }

  function initDeploys() {
    $("#deploy-add").addEventListener("click", function () { openDeployModal(null); });
    $("#deploy-search").addEventListener("input", function (ev) { deploySearch = ev.target.value; renderDeploys(); });
    $("#deploy-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var name = $("#deploy-name").value.trim();
      if (!name) return;
      var obj = {
        name: name, kind: $("#deploy-kind").value, host: $("#deploy-host").value.trim(), port: $("#deploy-port").value.trim(),
        healthUrl: $("#deploy-health").value.trim(), deployCmd: $("#deploy-cmd").value,
        apiEndpoint: $("#deploy-api").value.trim(), notes: $("#deploy-notes").value.trim(), status: "unknown", created: Date.now()
      };
      if (editingDeployId) {
        var ex = deploys.find(function (x) { return x.id === editingDeployId; });
        if (ex) { ex.name = obj.name; ex.kind = obj.kind; ex.host = obj.host; ex.port = obj.port; ex.healthUrl = obj.healthUrl; ex.deployCmd = obj.deployCmd; ex.apiEndpoint = obj.apiEndpoint; ex.notes = obj.notes; }
      } else { obj.id = Store.uid(); deploys.push(obj); }
      saveDeploys(); $("#deploy-modal").hidden = true; renderDeploys(); renderDashboard();
    });
    $("#deploy-delete").addEventListener("click", function () { if (editingDeployId) { delDeploy(editingDeployId); $("#deploy-modal").hidden = true; } });
    renderDeploys();
  }

  /* ---------- 提示词仓库 ---------- */
  var editingPromptId = null;

  function renderPromptTags() {
    var wrap = $("#prompt-tags-filter");
    if (!wrap) return;
    var all = {};
    prompts.forEach(function (p) { (p.tags || []).forEach(function (t) { all[t] = 1; }); });
    var tags = Object.keys(all);
    wrap.innerHTML = "";
    tags.forEach(function (tg) {
      var b = document.createElement("button");
      b.className = "tag-chip" + (promptTagFilter.indexOf(tg) >= 0 ? " active" : "");
      b.textContent = tg;
      b.addEventListener("click", function () {
        var i = promptTagFilter.indexOf(tg);
        if (i >= 0) promptTagFilter.splice(i, 1); else promptTagFilter.push(tg);
        renderPromptTags(); renderPrompts();
      });
      wrap.appendChild(b);
    });
  }

  function renderPrompts() {
    var q = promptSearch.trim().toLowerCase();
    var items = prompts.slice().sort(byNew);
    if (promptTagFilter.length) items = items.filter(function (p) { return (p.tags || []).some(function (t) { return promptTagFilter.indexOf(t) >= 0; }); });
    if (q) items = items.filter(function (p) { return (p.title + " " + (p.category || "") + " " + (p.content || "")).toLowerCase().indexOf(q) >= 0; });
    var grid = $("#prompt-grid");
    grid.innerHTML = "";
    $("#prompt-empty").hidden = items.length !== 0;
    items.forEach(function (p) {
      var card = document.createElement("div");
      card.className = "item-card prompt-card" + (p.favorite ? " fav" : "");
      var tagsHtml = (p.tags || []).map(function (t) { return '<span class="item-tag">' + escapeHtml(t) + "</span>"; }).join("");
      var content = p.content || "";
      card.innerHTML =
        '<div class="item-head"><span class="item-title">' + escapeHtml(p.title) + (p.favorite ? ' <span class="item-star">★</span>' : "") + "</span>" +
        (p.category ? '<span class="item-cat">' + escapeHtml(p.category) + "</span>" : "") + "</div>" +
        (content ? '<div class="item-meta">' + escapeHtml(content.slice(0, 90)) + (content.length > 90 ? "…" : "") + "</div>" : "") +
        (tagsHtml ? '<div class="item-tags">' + tagsHtml + "</div>" : "") +
        '<div class="item-foot"><span class="muted">用 ' + (p.usageCount || 0) + " 次</span>" +
        '<div class="item-acts"><button class="btn btn-ghost btn-sm" data-act="use">复用</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="fav">' + (p.favorite ? "取消收藏" : "收藏") + "</button>" +
        '<button class="btn btn-ghost btn-sm" data-act="edit">编辑</button>' +
        '<button class="item-del" data-act="del">🗑</button></div></div>';
      card.querySelector('[data-act="use"]').addEventListener("click", function () { copyText(p.content || ""); p.usageCount = (p.usageCount || 0) + 1; savePrompts(); renderPrompts(); });
      card.querySelector('[data-act="fav"]').addEventListener("click", function () { p.favorite = !p.favorite; savePrompts(); renderPrompts(); });
      card.querySelector('[data-act="edit"]').addEventListener("click", function () { openPromptModal(p.id); });
      card.querySelector('[data-act="del"]').addEventListener("click", function () { delPrompt(p.id); });
      grid.appendChild(card);
    });
    renderPromptTags();
  }

  function openPromptModal(id) {
    editingPromptId = id || null;
    var p = id ? prompts.find(function (x) { return x.id === id; }) : null;
    $("#prompt-modal-title").textContent = p ? "编辑提示词" : "新建提示词";
    $("#prompt-title").value = p ? p.title : "";
    $("#prompt-category").value = p ? (p.category || "") : "";
    $("#prompt-tags").value = p ? (p.tags || []).join(", ") : "";
    $("#prompt-content").value = p ? (p.content || "") : "";
    $("#prompt-delete").hidden = !p;
    $("#prompt-modal").hidden = false;
    setTimeout(function () { $("#prompt-title").focus(); }, 30);
  }

  function delPrompt(id) {
    if (!confirm("删除该提示词？")) return;
    prompts = prompts.filter(function (x) { return x.id !== id; });
    savePrompts(); renderPrompts();
  }

  function initPrompts() {
    $("#prompt-add").addEventListener("click", function () { openPromptModal(null); });
    $("#prompt-search").addEventListener("input", function (ev) { promptSearch = ev.target.value; renderPrompts(); });
    $("#prompt-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var title = $("#prompt-title").value.trim();
      if (!title) return;
      var obj = {
        title: title, category: $("#prompt-category").value.trim(),
        tags: parseTagsCsv($("#prompt-tags").value), content: $("#prompt-content").value,
        favorite: false, usageCount: 0, created: Date.now()
      };
      if (editingPromptId) {
        var ex = prompts.find(function (x) { return x.id === editingPromptId; });
        if (ex) { ex.title = obj.title; ex.category = obj.category; ex.tags = obj.tags; ex.content = obj.content; }
      } else { obj.id = Store.uid(); prompts.push(obj); }
      savePrompts(); $("#prompt-modal").hidden = true; renderPrompts();
    });
    $("#prompt-delete").addEventListener("click", function () { if (editingPromptId) { delPrompt(editingPromptId); $("#prompt-modal").hidden = true; } });
    renderPrompts();
  }

  function initFocus() {
    $("#focus-fab").addEventListener("click", function () {
      var p = $("#focus-panel"); p.hidden = !p.hidden; if (!p.hidden) focusRender();
    });
    $("#focus-close").addEventListener("click", function () { $("#focus-panel").hidden = true; });
    $("#focus-toggle").addEventListener("click", focusToggle);
    $("#focus-reset").addEventListener("click", focusReset);
    $("#focus-skip").addEventListener("click", focusSkip);
    $("#dash-focus-open").addEventListener("click", function () {
      var p = $("#focus-panel"); p.hidden = false; focusRender();
    });
    ["work", "short", "long"].forEach(function (k) {
      $("#fs-" + k).addEventListener("change", function (e) {
        var v = parseInt(e.target.value, 10); if (!v || v < 1) v = 1;
        focusSettings[k] = v; Store.set("focusSettings", focusSettings);
        if (!focus.running) { focus.remaining = focusDuration(focus.mode); focusRender(); }
      });
    });
    $("#fs-auto").addEventListener("change", function (e) {
      focusSettings.auto = e.target.checked; Store.set("focusSettings", focusSettings);
    });
    $("#fs-work").value = focusSettings.work;
    $("#fs-short").value = focusSettings.short;
    $("#fs-long").value = focusSettings.long;
    $("#fs-auto").checked = !!focusSettings.auto;
    focus.remaining = focusDuration("work");
    focusRender();
  }

  /* ---------- 数据备份 / 恢复 ---------- */
  function exportData() {
    var data = {
      app: "workbuddy-desk", version: 7,
      exportedAt: new Date().toISOString(),
      theme: Store.get("theme", "light"),
      tasks: tasks, events: events, notes: notes, links: links, contacts: contacts, projects: projects,
      emails: emails, interviews: interviews, deploys: deploys, prompts: prompts,
      focusLog: focusLog, focusSettings: focusSettings,
      reminderCfg: reminderCfg, reminderLog: reminderLog,
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var d = new Date();
    a.href = url;
    a.download = "workbuddy-desk-backup-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("备份已导出");
  }

  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || typeof data !== "object") throw new Error("文件不是有效的备份 JSON");
        // 容错：非数组字段强制清空，避免脏数据污染渲染
        ["tasks", "events", "notes", "links", "contacts", "projects", "focusLog", "emails", "interviews", "deploys", "prompts"].forEach(function (k) {
          if (!Array.isArray(data[k])) data[k] = [];
        });
        // 导入即 sanitize：清除可能携带的 javascript: 链接与非法 id，避免持久化 XSS
        (data.links || []).forEach(function (l) { if (l && l.url) l.url = sanitizeUrl(l.url); if (l && l.id) l.id = String(l.id).slice(0, 64); });
        (data.contacts || []).forEach(function (c) { if (c && c.id) c.id = String(c.id).slice(0, 64); });
        (data.events || []).forEach(function (ev) { if (ev && ev.id) ev.id = String(ev.id).slice(0, 64); });
        (data.projects || []).forEach(function (p) { if (p && p.id) p.id = String(p.id).slice(0, 64); });
        tasks = data.tasks;
        events = data.events;
        notes = data.notes;
        links = data.links;
        contacts = data.contacts;
        projects = data.projects;
        emails = data.emails;
        interviews = data.interviews;
        deploys = data.deploys;
        prompts = data.prompts;
        focusLog = data.focusLog;
        if (data.focusSettings && typeof data.focusSettings === "object") focusSettings = data.focusSettings;
        if (data.reminderCfg && typeof data.reminderCfg === "object") reminderCfg = data.reminderCfg;
        if (data.reminderLog && typeof data.reminderLog === "object") reminderLog = data.reminderLog;
        saveTasks(); saveEvents(); saveNotes(); saveLinks(); saveContacts(); saveProjects();
        saveEmails(); saveInterviews(); saveDeploys(); savePrompts();
        Store.set("focusLog", focusLog); Store.set("focusSettings", focusSettings);
        Store.set("reminderCfg", reminderCfg); Store.set("reminderLog", reminderLog);
        if (data.theme) applyTheme(data.theme);
        renderAll(); focusRender();
        var vNote = (data.version && data.version < 6) ? "（旧版本备份，已兼容导入）" : "";
        toast("备份已导入" + vNote);
      } catch (e) {
        toast("导入失败：" + e.message, "warn");
      }
    };
    reader.onerror = function () { toast("读取文件失败，请重试", "warn"); };
    reader.readAsText(file);
  }

  function clearAll() {
    if (!confirm("确定清空全部任务、日程、便签、链接、联系人、项目与知识库（邮件/访谈/部署/提示词）？此操作不可撤销。")) return;
    ["tasks", "events", "notes", "links", "contacts", "projects", "focusLog", "emails", "interviews", "deploys", "prompts", "reminderLog"].forEach(function (k) { Store.remove(k); });
    Store.remove("reminderCfg");
    tasks = []; events = []; notes = []; links = []; contacts = []; projects = []; focusLog = [];
    emails = []; interviews = []; deploys = []; prompts = [];
    reminderCfg = { email: "", mode: "mailto", api: "", autoOpen: true }; reminderLog = {};
    renderAll(); focusRender();
    toast("已清空全部数据");
  }

  function initDataTools() {
    $("#btn-export").addEventListener("click", exportData);
    $("#btn-import").addEventListener("click", function () { $("#import-file").click(); });
    $("#import-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) importData(f);
      e.target.value = "";
    });
    $("#btn-clear").addEventListener("click", clearAll);

    // L2：从 IndexedDB 本地保险箱恢复
    var btnIdb = $("#btn-restore-idb");
    if (btnIdb) btnIdb.addEventListener("click", function () {
      if (!window.Persist) { toast("本地保险箱不可用（浏览器不支持 IndexedDB）", "warn"); return; }
      Persist.restore().then(function (n) {
        if (n > 0) { loadUser(); renderAll(); toast("已从本地保险箱恢复 " + n + " 项数据", "ok"); }
        else toast("本地保险箱无新增可恢复数据（当前已是最新）");
      }).catch(function () { toast("恢复失败，请重试", "warn"); });
    });

    // L3：守护进程磁盘保险箱（备份 / 恢复）
    var btnVb = $("#btn-vault-backup");
    if (btnVb) btnVb.addEventListener("click", function () {
      if (!window.Persist) { toast("保险箱不可用", "warn"); return; }
      if (!reminderCfg.daemonUrl) { toast("请先在「提醒设置」中配置守护进程地址与令牌", "warn"); return; }
      btnVb.disabled = true;
      Persist.backupToVault(currentSnapshot(), reminderCfg).then(function (r) {
        btnVb.disabled = false;
        if (r.ok) toast("已同步到守护进程保险箱", "ok");
        else toast("保险箱同步失败：" + (r.reason || "未知原因"), "warn");
      });
    });
    var btnVr = $("#btn-vault-restore");
    if (btnVr) btnVr.addEventListener("click", function () {
      if (!window.Persist) { toast("保险箱不可用", "warn"); return; }
      if (!reminderCfg.daemonUrl) { toast("请先在「提醒设置」中配置守护进程地址与令牌", "warn"); return; }
      if (!confirm("从守护进程保险箱恢复将用服务端最新备份覆盖当前数据，确定继续？")) return;
      btnVr.disabled = true;
      Persist.restoreFromVault(reminderCfg).then(function (r) {
        btnVr.disabled = false;
        if (!r.ok || !r.payload) { toast("无可用保险箱备份", "warn"); return; }
        applySnapshot(r.payload);
        toast("已从守护进程保险箱恢复（保存于 " + (r.savedAt || "") + "）", "ok");
      }).catch(function () { btnVr.disabled = false; toast("恢复失败", "warn"); });
    });
  }

  /* ---------- 快捷键 / 帮助 ---------- */
  function openHelp() { $("#help-modal").hidden = false; }
  function closeHelp() { $("#help-modal").hidden = true; }

  function initShortcuts() {
    $all(".modal").forEach(function (m) {
      m.addEventListener("click", function (e) {
        if (e.target.matches("[data-close], .modal-mask")) m.hidden = true;
      });
    });
    document.addEventListener("keydown", function (e) {
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "Escape") {
        $("#event-modal").hidden = true; closeHelp();
        $("#focus-panel").hidden = true; editingEventId = null;
        $("#profile-modal").hidden = true; $("#about-modal").hidden = true; return;
      }
      if (e.key === "?") { openHelp(); return; }
      if (e.key === "t" || e.key === "T") {
        applyTheme(document.body.classList.contains("dark") ? "light" : "dark"); return;
      }
      var idx = "123456789".indexOf(e.key);
      if (idx >= 0 && VIEW_ORDER[idx]) { switchView(VIEW_ORDER[idx]); return; }
      if (e.key === "0" && VIEW_ORDER[9]) { switchView(VIEW_ORDER[9]); return; }
    });
  }

  /* ---------- 账号 / 鉴权 / 个人资料 ---------- */

  /* 鉴权后端 = 守护进程（服务端权威）。
     后端地址优先级（登录前必须可知，故独立于用户数据）：
       1) localStorage["workbuddy.desk.apiBase"]  —— 每台设备设一次，最优先（多端共享同一公网后端）
       2) URL query ?api=xxx                       —— 临时覆盖（便于分享带后端的链接）
       3) reminderCfg.daemonUrl                   —— 旧路径兼容（提醒设置里配过）
       4) 默认 http://127.0.0.1:7700              —— 本机守护进程
  */
  function apiBase() {
    try {
      var ls = localStorage.getItem("workbuddy.desk.apiBase");
      if (ls && ls.trim()) return ls.trim().replace(/\/+$/, "");
    } catch (e) {}
    var q = (location.search.match(/[?&]api=([^&]+)/) || [])[1];
    if (q) { try { return decodeURIComponent(q).replace(/\/+$/, ""); } catch (e) {} }
    var cfg = (typeof Store !== "undefined" && Store.get) ? (Store.get("reminderCfg", {}) || {}) : {};
    var u = (cfg.daemonUrl || "").trim().replace(/\/+$/, "");
    return u || "http://127.0.0.1:7700";
  }
  function setApiBase(u) {
    u = (u || "").trim().replace(/\/+$/, "");
    try { if (u) localStorage.setItem("workbuddy.desk.apiBase", u); else localStorage.removeItem("workbuddy.desk.apiBase"); } catch (e) {}
  }
  function sessionToken() { try { return localStorage.getItem("workbuddy.desk.sessionToken") || ""; } catch (e) { return ""; } }
  function setSessionToken(t) { try { if (t) localStorage.setItem("workbuddy.desk.sessionToken", t); else localStorage.removeItem("workbuddy.desk.sessionToken"); } catch (e) {} }
  function authHeaders(extra) {
    var h = Object.assign({ "Content-Type": "application/json" }, extra || {});
    var t = sessionToken();
    if (t) h["Authorization"] = "Bearer " + t;
    return h;
  }
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = authHeaders(opts.headers || {});
    return fetch(apiBase() + path, opts);
  }
  /* 跨平台同步由 sync-integration.js（SyncBridge）接管：
     Store.set 钩子 -> 记录级变更入引擎 -> 登录后全量拉取 + 增量推/拉 + SSE 实时。
     同步范围：tasks/events/notes/links/contacts/projects/emails/interviews/deploys/prompts/
     focusLog（业务数据，LWW） + theme/focusSettings（设置，字段合并）+ 资料（字段合并）。
     明确不同步：reminderCfg/reminderLog 等设备本地配置。 */
  function finishLogin(user, token) {
    setSessionToken(token);
    persistDeviceSession(token);          // 桌面端「记住本机」：固化到本机服务端文件
    currentUser = user;
    enterApp(user);
    ensureSyncStarted();
  }

  /* 登录成功后启动跨端同步：全量拉取 -> 推 outbox -> 开 SSE + 定时兜底 */
  function ensureSyncStarted() {
    if (window.SyncBridge) {
      try { window.SyncBridge.start(); } catch (e) { console.warn("[sync] 启动失败", e); }
    }
  }
  /* 把当前会话令牌固化为本机设备会话（清缓存后仍可自动登录）。失败静默忽略。 */
  function persistDeviceSession(token) {
    apiFetch("/api/auth/device-session", { method: "POST", body: JSON.stringify({ token: token }) })
      .catch(function () {});
  }

  function loadUser() {
    tasks = Store.get("tasks", []);
    events = Store.get("events", []);
    notes = Store.get("notes", []);
    links = Store.get("links", []);
    contacts = Store.get("contacts", []);
    projects = Store.get("projects", []);
    emails = Store.get("emails", []);
    interviews = Store.get("interviews", []);
    deploys = Store.get("deploys", []);
    prompts = Store.get("prompts", []);
    focusLog = Store.get("focusLog", []);
    focusSettings = Store.get("focusSettings", { work: 25, short: 5, long: 15, auto: true });
    reminderCfg = Store.get("reminderCfg", { email: "", mode: "mailto", api: "", autoOpen: true, daemonUrl: "", daemonToken: "", daemonSync: false, daemonOnline: false });
    reminderLog = Store.get("reminderLog", {});
  }

  /* 口令由服务端用 scrypt 加密存储，前端不再做任何本地哈希（避免伪安全）。 */
  /* 密码强度评分 0–4：长度≥8、含大小写、含数字、含特殊符号 各 +1 */
  function evalPwd(pw) {
    if (!pw) return 0;
    var s = 0;
    if (pw.length >= 8) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  }
  function renderPwdStrength() {
    var box = $("#auth-pwd-strength");
    if (!box) return;
    if (authMode !== "register") { box.hidden = true; return; }
    var pw = $("#auth-password").value;
    if (!pw) { box.hidden = true; return; }
    box.hidden = false;
    var s = evalPwd(pw);
    var bars = box.querySelectorAll("i");
    var labels = ["太弱", "较弱", "一般", "较强", "很强"];
    for (var i = 0; i < bars.length; i++) {
      bars[i].className = "pwd-bar" + (i < s ? " on lv" + s : "");
    }
    $("#auth-pwd-text").textContent = labels[s];
  }
  var authMode = "login";
  function setAuthMode(mode) {
    authMode = mode;
    $all(".auth-tab").forEach(function (b) { b.classList.toggle("active", b.dataset.mode === mode); });
    $("#auth-name-field").hidden = mode !== "register";
    $("#auth-avatar-field").hidden = mode !== "register";
    $("#auth-submit").textContent = mode === "register" ? "注册并进入" : "登录";
    $("#auth-hint").textContent = mode === "register"
      ? "创建账号，数据以加密方式安全同步到服务端，仅你本人可访问。"
      : "首次使用？切换到「注册」创建账号。";
    $("#auth-error").hidden = true;
    renderPwdStrength();
  }
  function showAuthError(msg) { var el = $("#auth-error"); el.textContent = msg; el.hidden = false; }

  function setupAuthUI() {
    $all(".auth-tab").forEach(function (b) {
      b.addEventListener("click", function () { setAuthMode(b.dataset.mode); });
    });
    $("#auth-password").addEventListener("input", renderPwdStrength);
    $("#auth-form").addEventListener("submit", function (e) { e.preventDefault(); onAuthSubmit(); });
    // 服务器地址：每台设备设一次（多端共享同一公网后端）。优先用已保存值，否则展示当前实际生效地址。
    var srvEl = $("#auth-server");
    if (srvEl) {
      srvEl.value = apiBase();
      srvEl.addEventListener("input", function () { setApiBase(srvEl.value); });
      srvEl.addEventListener("change", function () { setApiBase(srvEl.value); });
      // 在公网页面（非本机）打开却仍是默认本机地址时，高亮提示需填写服务器
      if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(location.origin) && /^https?:\/\/127\.0\.0\.1:7700$/.test(apiBase())) {
        srvEl.classList.add("auth-server-warn");
        srvEl.placeholder = "请填写后端服务器地址";
      }
    }
  }
  function onAuthSubmit() {
    var srvEl = $("#auth-server"); if (srvEl) setApiBase(srvEl.value); // 登录前先固化本次使用的后端地址
    var username = $("#auth-username").value.trim();
    var password = $("#auth-password").value;
    if (!username) { showAuthError("请输入用户名"); return; }
    if (!password || password.length < 4) { showAuthError("密码至少 4 位"); return; }
    var payload = {
      username: username,
      password: password,
      name: $("#auth-name").value.trim() || username,
      avatar: $("#auth-avatar").value.trim() || "🙂"
    };
    var path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    apiFetch(path, { method: "POST", body: JSON.stringify(payload) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, json: j }; }); })
      .then(function (res) {
        var j = res.json;
        if (res.status === 200 && j.ok && j.token) { finishLogin(j.user, j.token); return; }
        if (res.status === 409) { showAuthError("该用户名已被注册"); return; }
        if (res.status === 401) { showAuthError("用户名或密码错误"); return; }
        if (res.status === 429) { showAuthError("尝试过于频繁，请 5 分钟后再试"); return; }
        if (res.status === 400) { showAuthError(j.error || "输入不合法（用户名 3–30 位、密码至少 8 位）"); return; }
        showAuthError(j.error || "操作失败，请重试");
      })
      .catch(function (e) { showAuthError("网络错误：无法连接鉴权服务（" + (e && e.message || e) + "）"); });
  }
  function showAuth() {
    setAuthMode("login");
    $("#auth-username").value = "";
    $("#auth-password").value = "";
    $("#auth-name").value = "";
    $("#auth-avatar").value = "";
    $("#auth-screen").classList.remove("hidden");
    $("#app-root").classList.add("hidden");
  }

  /* 首次进入时预置知识库示例（含 1 条逾期访谈，驱动「今日要处理」），仅执行一次 */
  function seedKnowledge() {
    if (Store.get("seeded_kb", false)) return;
    var now = Date.now();
    var od = new Date(); od.setDate(od.getDate() - 2);
    var overdue = ymd(od);
    emails = [
      { id: Store.uid(), name: "周报同步", category: "内部", subject: "本周工作周报", body: "Hi 团队，本周进展：{{进展}}；下周计划：{{计划}}。", variables: ["进展", "计划"], usageCount: 0, created: now - 3000 },
      { id: Store.uid(), name: "客户回访", category: "客户", subject: "产品使用回访", body: "您好 {{姓名}}，我是 {{公司}} 的对接人，想了解您对 {{产品}} 的使用反馈。", variables: ["姓名", "公司", "产品"], usageCount: 0, created: now - 2000 }
    ];
    interviews = [
      { id: Store.uid(), title: "新客户首次访谈提纲", type: "提纲", topic: "需求挖掘", tags: ["销售", "B2B"], content: "1. 当前业务流程痛点\n2. 预算与决策链\n3. 上线时间预期", dueDate: overdue, done: false, created: now - 4000 },
      { id: Store.uid(), title: "用户研究话术-开场", type: "话术", topic: "用户访谈", tags: ["研究"], content: "感谢参与，本次约 20 分钟，主要用于了解您的真实使用场景。", done: false, created: now - 5000 },
      { id: Store.uid(), title: "竞品分析记录", type: "记录", topic: "竞品", tags: ["分析"], content: "记录要点：定价偏高、文档较弱。", done: true, created: now - 6000 }
    ];
    deploys = [
      { id: Store.uid(), name: "官网前端", kind: "web", host: "example.com", port: "443", healthUrl: "https://example.com/healthz", deployCmd: "npm run build && scp -r dist/ server:/var/www", apiEndpoint: "", notes: "生产环境", status: "unknown", created: now - 7000 },
      { id: Store.uid(), name: "API 网关", kind: "api", host: "api.example.com", port: "8080", healthUrl: "https://api.example.com/ping", deployCmd: "kubectl rollout restart deploy/api-gateway", notes: "", status: "unknown", created: now - 8000 }
    ];
    prompts = [
      { id: Store.uid(), title: "代码审查助手", category: "开发", tags: ["code", "review"], content: "你是一名资深工程师，请审查以下代码，指出潜在 bug、安全隐患与可维护性建议：\n{{code}}", favorite: true, usageCount: 3, created: now - 9000 },
      { id: Store.uid(), title: "周报生成", category: "写作", tags: ["writing"], content: "根据以下要点生成一份结构清晰的周报：\n{{points}}", favorite: false, usageCount: 1, created: now - 10000 }
    ];
    saveEmails(); saveInterviews(); saveDeploys(); savePrompts();
    Store.set("seeded_kb", true);

    /* 示例日程：仅在用户尚无任何日程时填充，避免覆盖真实数据。
       其中一条开启邮件提醒、时间设在「当前之后几分钟、提前量更大」，保证打开即处于到期窗口，
       用于演示「基于真实数据的真实提醒」。 */
    if (!Store.get("seeded_events", false) && events.length === 0) {
      var n0 = new Date();
      var todayDs = ymd(n0);
      var soonD = new Date(n0.getTime() + 6 * 60000);
      var soonTime = pad(soonD.getHours()) + ":" + pad(soonD.getMinutes());
      events = [
        { id: Store.uid(), date: todayDs, time: "09:00", title: "每日计划梳理", remind: true, repeat: "none", location: "", note: "列出今日 3 件要事", emailRemind: false, leadMinutes: 30, emailTo: "" },
        { id: Store.uid(), date: todayDs, time: soonTime, title: "客户电话沟通", remind: true, repeat: "none", location: "手机", note: "确认合同细节与交付时间", emailRemind: true, leadMinutes: 60, emailTo: "" },
        { id: Store.uid(), date: todayDs, time: "18:30", title: "健身打卡", remind: true, repeat: "daily", location: "健身房", note: "", emailRemind: false, leadMinutes: 30, emailTo: "" }
      ];
      saveEvents();
      Store.set("seeded_events", true);
      /* 若账号名即邮箱，作为默认接收人，便于真实提醒立即可用 */
      if (!reminderCfg.email && currentUser && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(currentUser.username || "")) {
        reminderCfg.email = currentUser.username;
        Store.set("reminderCfg", reminderCfg);
      }
    }
  }

  /* 当前全量数据快照（完整键 -> 值），用于二级/三级持久化 */
  function currentSnapshot() {
    var s = {};
    s[Store.fullKeyOf("tasks")] = tasks;
    s[Store.fullKeyOf("events")] = events;
    s[Store.fullKeyOf("notes")] = notes;
    s[Store.fullKeyOf("links")] = links;
    s[Store.fullKeyOf("contacts")] = contacts;
    s[Store.fullKeyOf("projects")] = projects;
    s[Store.fullKeyOf("emails")] = emails;
    s[Store.fullKeyOf("interviews")] = interviews;
    s[Store.fullKeyOf("deploys")] = deploys;
    s[Store.fullKeyOf("prompts")] = prompts;
    s[Store.fullKeyOf("focusLog")] = focusLog;
    s[Store.fullKeyOf("focusSettings")] = focusSettings;
    s[Store.fullKeyOf("reminderCfg")] = reminderCfg;
    s[Store.fullKeyOf("reminderLog")] = reminderLog;
    // 注意：不再写入 users / session —— 口令哈希与会话由服务端权威管理，禁止上传到任何本地/备份接口。
    return s;
  }

  /* 把一份快照（来自保险箱）应用到当前会话并落盘 */
  function applySnapshot(data) {
    if (!data || typeof data !== "object") return;
    ["tasks", "events", "notes", "links", "contacts", "projects", "focusLog", "emails", "interviews", "deploys", "prompts"].forEach(function (k) {
      if (!Array.isArray(data[k])) data[k] = [];
    });
    (data.links || []).forEach(function (l) { if (l && l.url) l.url = sanitizeUrl(l.url); });
    tasks = data.tasks; events = data.events; notes = data.notes; links = data.links;
    contacts = data.contacts; projects = data.projects; emails = data.emails;
    interviews = data.interviews; deploys = data.deploys; prompts = data.prompts;
    focusLog = data.focusLog;
    if (data.focusSettings && typeof data.focusSettings === "object") focusSettings = data.focusSettings;
    if (data.reminderCfg && typeof data.reminderCfg === "object") reminderCfg = data.reminderCfg;
    if (data.reminderLog && typeof data.reminderLog === "object") reminderLog = data.reminderLog;
    saveTasks(); saveEvents(); saveNotes(); saveLinks(); saveContacts(); saveProjects();
    saveEmails(); saveInterviews(); saveDeploys(); savePrompts();
    Store.set("focusLog", focusLog); Store.set("focusSettings", focusSettings);
    Store.set("reminderCfg", reminderCfg); Store.set("reminderLog", reminderLog);
    renderAll(); focusRender();
  }

  function enterApp(user) {
    currentUser = user;
    Store.setNamespace(user.id);                 // 本地命名空间：离线缓存 + 同机多用户隔离
    loadUser();
    // 三级持久化接入：优先从 IndexedDB 二级保险箱恢复缺失数据，再补齐 IDB 底稿
    if (window.Persist && Persist.restore) {
      Persist.restore().then(function (n) {
        if (n > 0) { loadUser(); renderAll(); toast("已从本地保险箱恢复 " + n + " 项数据", "ok"); }
        Persist.seed(currentSnapshot());
      }).catch(function () {});
    }
    // 服务端数据优先（权威）：登录后拉取云端数据回填；失败则退回本地缓存
    if (sessionToken()) {
      apiFetch("/api/user/data", { method: "GET" })
        .then(function (r) { if (!r.ok) throw new Error("status " + r.status); return r.json(); })
        .then(function (j) {
          if (j && j.ok && j.data && Object.keys(j.data).length) {
            applySnapshot(j.data);               // 云端回填（覆盖本地，保证多端一致）
          } else {
            seedKnowledge();                      // 全新用户：预置知识库示例，稍后自动同步到云端
          }
          scheduleSync();                         // 注册自动同步：此后任意数据改动都会防抖 PUT 到服务端
        })
        .catch(function (e) {
          console.warn("[enterApp] 服务端数据拉取失败，使用本地缓存：", e && e.message || e);
          seedKnowledge();
        });
    } else {
      seedKnowledge();
    }
    initNav(); initTasks(); initCalendar(); initNotes(); initLinks();
    initRelations(); initProjects(); initEmails(); initInterviews(); initDeploys(); initPrompts();
    initFocus(); initDataTools(); initReminders(); initShortcuts();
    updateUserChip();
    $("#auth-screen").classList.add("hidden");
    $("#app-root").classList.remove("hidden");
    switchView("dashboard");
    renderAll();
    tickClock(); setInterval(tickClock, 30000);
    registerSW();
  }

  /* PWA：注册 Service Worker（仅真实浏览器安全上下文；桌面壳 Electron 用自带 http 服务，跳过 SW 缓存） */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;                 // SW 必须安全上下文（https/localhost）
    if (/Electron/.test(navigator.userAgent)) return;     // 桌面壳不注册 SW，避免缓存干扰
    navigator.serviceWorker.register("./sw.js").catch(function (e) {
      console.warn("[sw] 注册失败（可忽略，不影响功能）:", e.message || e);
    });
  }

  /* PWA 安装入口：捕获 beforeinstallprompt，显示「安装」按钮；桌面壳无此事件自动隐藏 */
  var deferredInstall = null;
  function setupInstall() {
    if (/Electron/.test(navigator.userAgent)) return;     // 桌面壳不提供安装入口
    var btn = document.getElementById("btn-install");
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();                                  // 拦截浏览器默认迷你提示，改用我们自己的按钮
      deferredInstall = e;
      if (btn) btn.hidden = false;
    });
    window.addEventListener("appinstalled", function () {
      if (btn) btn.hidden = true;
      deferredInstall = null;
      toast("已安装到设备，下次可从桌面 / 主屏直接打开。", "ok");
    });
    if (btn) {
      btn.addEventListener("click", function () {
        if (!deferredInstall) {
          toast("当前浏览器未弹出安装入口，可手动「添加到主屏幕 / 安装应用」。", "info");
          return;
        }
        deferredInstall.prompt();
        deferredInstall.userChoice.then(function (choice) {
          if (choice && choice.outcome === "accepted") { /* 用户已安装 */ }
        }).catch(function () {})
          .then(function () { deferredInstall = null; if (btn) btn.hidden = true; });
      });
    }
  }

  function updateUserChip() {
    if (!currentUser) return;
    $("#user-avatar").textContent = currentUser.avatar || "🙂";
    $("#user-name").textContent = currentUser.name || currentUser.username;
  }

  function setupProfileUI() {
    $("#btn-profile").addEventListener("click", openProfile);
    var modal = $("#profile-modal");
    $all("[data-close]", modal).forEach(function (b) {
      b.addEventListener("click", function () { modal.hidden = true; });
    });
    $("#pf-avatar").addEventListener("input", function () {
      $("#profile-avatar-preview").textContent = $("#pf-avatar").value.trim() || "🙂";
    });
    $("#pf-logout").addEventListener("click", logout);
    var delBtn = $("#pf-delete-account");
    if (delBtn) delBtn.addEventListener("click", deleteAccount);
    $("#profile-form").addEventListener("submit", function (e) {
      e.preventDefault(); onProfileSubmit(modal);
    });
  }
  function openProfile() {
    if (!currentUser) return;
    $("#pf-name").value = currentUser.name || "";
    $("#pf-avatar").value = currentUser.avatar || "";
    $("#profile-avatar-preview").textContent = currentUser.avatar || "🙂";
    $("#pf-bio").value = currentUser.bio || "";
    $("#pf-curpwd").value = ""; $("#pf-newpwd").value = "";
    $("#pf-error").hidden = true;
    $("#profile-modal").hidden = false;
  }
  function showPfError(msg) { var el = $("#pf-error"); el.textContent = msg; el.hidden = false; }
  function onProfileSubmit(modal) {
    var name = $("#pf-name").value.trim();
    if (!name) { showPfError("请输入显示名称"); return; }
    var avatar = $("#pf-avatar").value.trim();
    var bio = $("#pf-bio").value.trim();
    var cur = $("#pf-curpwd").value, neu = $("#pf-newpwd").value;

    // 1) 资料更新（name/avatar/bio）走服务端权威接口
    var step1 = apiFetch("/api/user/profile", { method: "PUT", body: JSON.stringify({ name: name, avatar: avatar || "🙂", bio: bio }) })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "资料更新失败"); });
        return r.json();
      });

    // 2) 改密（可选）走服务端；成功返回新令牌，所有旧令牌立即失效
    var step2 = Promise.resolve();
    if (neu) {
      if (!cur) { showPfError("请输入当前密码"); return; }
      if (neu.length < 8) { showPfError("新密码至少 8 位"); return; }
      step2 = apiFetch("/api/user/password", { method: "POST", body: JSON.stringify({ currentPassword: cur, newPassword: neu }) })
        .then(function (r) {
          return r.json().then(function (j) {
            if (!r.ok || !j.ok) throw new Error(j.error || "改密失败");
            if (j.token) setSessionToken(j.token);   // 换发新会话令牌
            return j;
          });
        });
    }

    Promise.all([step1, step2]).then(function () {
      currentUser.name = name;
      currentUser.avatar = avatar || "🙂";
      currentUser.bio = bio;
      updateUserChip();
      modal.hidden = true;
      $("#pf-curpwd").value = ""; $("#pf-newpwd").value = "";
      toast("资料已更新");
      if (window.SyncBridge) window.SyncBridge.syncProfile();   // 资料变更同步到其它端
    }).catch(function (e) { showPfError(e.message || "更新失败"); });
  }
  function logout() {
    var done = function () {
      var finish = function () {
        setSessionToken("");                       // 清除本地会话令牌
        try { Store.clearNamespaceData(); } catch (e) {}  // 清掉本机缓存，防止共享设备数据泄露
        location.reload();
      };
      if (window.SyncBridge) {
        try {
          // 先尽力把 outbox 推上去，再清同步缓存（否则共享设备上会残留上一位用户的数据）
          window.SyncBridge.clearLocal().then(function () {
            try { window.SyncBridge.stop(); } catch (e) {}
            finish();
          }, finish);
          return;
        } catch (e) { /* 落到下面的直接退出 */ }
      }
      finish();
    };
    if (sessionToken()) {
      apiFetch("/api/auth/device-session", { method: "DELETE" }).catch(function () {}); // 撤销「记住本机」
      apiFetch("/api/auth/logout", { method: "POST", body: "{}" }).catch(function () {}).then(done);
    } else {
      done();
    }
  }

  /* 删除账号：校验密码后，调服务端彻底清除该用户云端数据 + 账号记录；本地缓存一并清除 */
  function deleteAccount() {
    if (!currentUser) return;
    var pwd = $("#pf-delpwd").value;
    if (!pwd) { showPfError("请输入当前密码以确认删除"); return; }
    if (!confirm("确定永久删除账号「" + (currentUser.name || currentUser.username) + "」及其全部数据？此操作不可恢复。")) return;
    apiFetch("/api/user", { method: "DELETE", body: JSON.stringify({ password: pwd }) })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "删除失败"); });
        return r.json();
      })
      .then(function () {
        setSessionToken("");
        try { Store.clearNamespaceData(); } catch (e) {}
        // 账号已在服务端销毁，这里不必再推 outbox，直接抹掉本机同步缓存
        if (window.SyncBridge) {
          try { window.SyncBridge.stop(); } catch (e) {}
          try { window.SyncBridge.wipeLocal(); } catch (e) {}
        }
        location.reload();
      })
      .catch(function (e) { showPfError(e.message || "删除失败"); });
  }

  /* ---------- 启动 ---------- */
  /* ---------- 关于 / 版本 / 检查更新 ----------
   * 桌面端：通过 window.updater 桥读取版本、查看更新状态、手动检查/下载/安装；
   * 网页端：仅展示「网页版」并提示需在桌面客户端更新（无内置更新能力）。
   */
  function initAboutUI() {
    var modal = $("#about-modal");
    var btnAbout = $("#btn-about");
    if (!modal || !btnAbout) return;
    var elVer = $("#about-version"), elEdition = $("#about-edition"),
        elPill = $("#about-update-pill"), elMsg = $("#about-update-msg"),
        elProg = $("#about-progress"), elFill = $("#about-progress-fill"), elPct = $("#about-progress-pct"),
        btnCheck = $("#about-check"), btnUpdate = $("#about-update-btn"), btnInstall = $("#about-install-btn"),
        elTip = $("#about-tip");

    function renderState(s) {
      s = s || {};
      var phase = s.phase || "idle";
      if (s.version) elVer.textContent = "v" + s.version;
      // 进度条仅在下载中显示
      if (phase === "downloading" && typeof s.progress === "number") {
        elProg.hidden = false;
        elFill.style.width = s.progress + "%";
        elPct.textContent = Math.floor(s.progress) + "%";
      } else {
        elProg.hidden = true;
      }
      var pill = { text: "—", cls: "grey" }, showCheck = true, showUpdate = false, showInstall = false, msg = s.message || "";
      if (phase === "idle") { pill = { text: "未检查", cls: "grey" }; }
      else if (phase === "checking") { pill = { text: "检查中…", cls: "blue" }; showCheck = false; }
      else if (phase === "available") { pill = { text: "有新版本", cls: "orange" }; showCheck = false; showUpdate = true; }
      else if (phase === "downloading") { pill = { text: "下载中", cls: "blue" }; showCheck = false; }
      else if (phase === "downloaded") { pill = { text: "更新就绪", cls: "green" }; showCheck = false; showInstall = true; }
      else if (phase === "uptodate") { pill = { text: "已是最新", cls: "green" }; }
      else if (phase === "error") { pill = { text: "更新出错", cls: "red" }; }
      elPill.textContent = pill.text;
      elPill.className = "pill " + pill.cls;
      elMsg.textContent = msg;
      btnCheck.hidden = !showCheck;
      btnUpdate.hidden = !showUpdate;
      btnInstall.hidden = !showInstall;
    }

    function renderProgress(p) {
      if (!p || typeof p.percent !== "number") return;
      elProg.hidden = false;
      elFill.style.width = p.percent + "%";
      elPct.textContent = Math.floor(p.percent) + "%";
    }

    var IS_DESKTOP = !!(window.updater && window.updater.isElectron);
    if (IS_DESKTOP) {
      try {
        window.updater.getVersion().then(function (v) {
          elVer.textContent = "v" + (v.version || "—");
          elEdition.textContent = v.isPortable ? "便携版" : "安装版";
          elEdition.className = "pill " + (v.isPortable ? "dark" : "blue");
        }).catch(function () {});
      } catch (e) {}
      try {
        window.updater.getState().then(renderState).catch(function () {});
      } catch (e) {}
      try { window.updater.onState(renderState); } catch (e) {}
      try { window.updater.onProgress(renderProgress); } catch (e) {}
      btnCheck.addEventListener("click", function () { try { window.updater.check(); } catch (e) {} });
      btnUpdate.addEventListener("click", function () { try { window.updater.download(); } catch (e) {} });
      btnInstall.addEventListener("click", function () { try { window.updater.install(); } catch (e) {} });
      elTip.textContent = "桌面端会在启动时自动检查更新；也可点「检查更新」手动触发。";
    } else {
      elVer.textContent = "网页版";
      elEdition.textContent = "网页";
      elEdition.className = "pill grey";
      elPill.textContent = "网页版";
      elPill.className = "pill grey";
      elMsg.textContent = "";
      btnCheck.hidden = true; btnUpdate.hidden = true; btnInstall.hidden = true;
      elTip.textContent = "网页版不支持内置更新。请使用桌面客户端（安装版/便携版），它会自动检查并安装新版本。";
    }

    btnAbout.addEventListener("click", function () {
      modal.hidden = false;
      if (IS_DESKTOP) { try { window.updater.getState().then(renderState).catch(function () {}); } catch (e) {} }
    });
  }

  function boot() {
    Store.onError(function (msg) { toast(msg, "warn"); });
    if (window.SyncBridge) { try { window.SyncBridge.init(); } catch (e) { console.warn("[sync] 初始化失败", e); } } // 安装 Store.set 钩子
    if (window.Persist && Persist.initMirror) Persist.initMirror(); // 注册二级持久化镜像
    window.addEventListener("error", function (e) {
      console.error("[app] 未捕获错误:", e.error || e.message);
      toast("出现异常：" + (e.message || "未知错误"), "warn");
    });
    window.addEventListener("unhandledrejection", function (e) {
      console.error("[app] 未处理的 Promise 拒绝:", e.reason);
    });
    applyTheme(Store.get("theme", "light")); // 登录页使用全局主题
    setupAuthUI();
    setupProfileUI();
    setupInstall();
    initAboutUI();
    resumeSession();
  }

  /* 恢复登录态：优先用本地令牌；本地无令牌时尝试本机设备会话（桌面端「记住本机」）。 */
  function resumeSession() {
    var t = sessionToken();
    if (t) { validateToken(t); return; }
    // 清缓存 / 首次打开：尝试本机设备会话，命中则自动登录，无需重新输入口令
    apiFetch("/api/auth/device-session", { method: "GET" })
      .then(function (r) { if (!r.ok) throw new Error("net"); return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.token) { setSessionToken(j.token); validateToken(j.token); }
        else showAuth();
      })
      .catch(function () { showAuth(); });
  }

  /* 校验令牌有效性；有效则进入应用并续期（长期免登录），无效则清除设备会话并退回登录页。 */
  function validateToken(t) {
    apiFetch("/api/auth/me", { method: "GET" })
      .then(function (r) { if (!r.ok) throw new Error("status " + r.status); return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.user) {
          refreshToken();                       // 续期：换取新令牌，长期免登录
          currentUser = j.user; enterApp(j.user);
          ensureSyncStarted();
        } else { setSessionToken(""); clearDeviceSessionLocal(); showAuth(); }
      })
      .catch(function () { setSessionToken(""); clearDeviceSessionLocal(); showAuth(); });
  }

  /* 用旧令牌换发新令牌（有效期顺延），并同步更新本机设备会话。 */
  function refreshToken() {
    apiFetch("/api/auth/refresh", { method: "POST" })
      .then(function (r) { if (!r.ok) throw new Error("status " + r.status); return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.token) { setSessionToken(j.token); persistDeviceSession(j.token); }
      })
      .catch(function () {});
  }

  /* 令牌失效时，清理可能残留的本机设备会话，避免下次误自动登录。 */
  function clearDeviceSessionLocal() {
    apiFetch("/api/auth/device-session", { method: "DELETE" }).catch(function () {});
  }

  /* 暴露跨端同步所需的钩子给 sync-integration.js（框架无关，避免直接耦合 IIFE 内部变量） */
  window.apiFetch = apiFetch;
  window.sessionToken = function () { return sessionToken(); };
  window.apiBase = apiBase;
  // getAccountId：同步缓存必须按账号隔离，否则同一台设备上换账号会读到上一位用户的缓存
  window.Workbench = {
    applyRemote: applyRemote,
    getProfile: getProfile,
    getAccountId: function () { return currentUser ? String(currentUser.id || currentUser.username || "me") : "me"; }
  };

  document.addEventListener("DOMContentLoaded", boot);
})();
