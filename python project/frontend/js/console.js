/**
 * 应用内控制台：查看实时日志、历史日志文件、下载、清空
 * 挂在右下角浮动按钮，点开右侧抽屉。
 */
(function () {
  "use strict";

  var POLL_MS = 2000;
  var TAIL_LIMIT = 500;
  var state = {
    panelEl: null,
    listEl: null,
    fileSelectEl: null,
    autoScrollEl: null,
    filterEl: null,
    lastId: 0,
    polling: null,
    visible: false,
    viewingFile: "",       // 空串=实时；否则=历史文件名
    entries: [],           // 实时模式：从 /api/logs 累计的条目
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function fmtTime(ts) {
    try {
      var d = new Date(ts);
      var pad = function (n) { return (n < 10 ? "0" : "") + n; };
      return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
    } catch (_) { return ""; }
  }

  function injectStyles() {
    if (document.getElementById("flowdraw-console-style")) return;
    var css = [
      "#fd-console-fab{position:fixed;right:14px;bottom:14px;z-index:9998;width:38px;height:38px;border-radius:8px;",
      "background:rgba(15,23,42,.85);color:#cbd5e1;border:1px solid #334155;cursor:pointer;display:flex;align-items:center;",
      "justify-content:center;font-size:15px;box-shadow:0 4px 12px rgba(0,0,0,.35);transition:background .15s,color .15s,transform .15s;}",
      "#fd-console-fab:hover{background:#0f172a;color:#38bdf8;transform:translateY(-1px);}",
      "#fd-console-fab.open{color:#38bdf8;border-color:#38bdf8;}",
      "#fd-console-panel{position:fixed;right:0;top:0;bottom:0;width:min(520px,90vw);background:#0b1120;color:#e2e8f0;",
      "z-index:9999;display:flex;flex-direction:column;border-left:1px solid #1e293b;box-shadow:-8px 0 24px rgba(0,0,0,.4);",
      "transform:translateX(100%);transition:transform .2s ease;}",
      "#fd-console-panel.open{transform:translateX(0);}",
      "#fd-console-head{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid #1e293b;flex-wrap:wrap;}",
      "#fd-console-head .title{font-size:13px;font-weight:600;margin-right:auto;}",
      "#fd-console-head select,#fd-console-head input,#fd-console-head button{background:#0f172a;color:#e2e8f0;",
      "border:1px solid #334155;border-radius:4px;padding:3px 8px;font-size:12px;}",
      "#fd-console-head button{cursor:pointer;}",
      "#fd-console-head button:hover{border-color:#38bdf8;color:#38bdf8;}",
      "#fd-console-list{flex:1;overflow:auto;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;",
      "padding:8px 12px;background:#020617;}",
      "#fd-console-list .row{white-space:pre-wrap;word-break:break-all;}",
      "#fd-console-list .row .t{color:#64748b;}",
      "#fd-console-list .row .lv{display:inline-block;min-width:46px;color:#94a3b8;}",
      "#fd-console-list .row.err .lv{color:#ef4444;}",
      "#fd-console-list .row.err{color:#fecaca;}",
      "#fd-console-foot{padding:6px 12px;font-size:11px;color:#64748b;border-top:1px solid #1e293b;display:flex;gap:10px;}",
    ].join("");
    var style = document.createElement("style");
    style.id = "flowdraw-console-style";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildPanel() {
    if (state.panelEl) return;
    injectStyles();

    // 入口按钮：控制台/终端图标
    var fab = document.createElement("button");
    fab.id = "fd-console-fab";
    fab.title = "控制台日志";
    fab.innerHTML = '<i class="fa fa-terminal"></i>';
    fab.addEventListener("click", function (e) {
      e.stopPropagation();
      toggle();
    });
    document.body.appendChild(fab);
    state.fabEl = fab;

    var panel = document.createElement("div");
    panel.id = "fd-console-panel";
    panel.innerHTML = ''
      + '<div id="fd-console-head">'
      +   '<span class="title"><i class="fa fa-terminal" style="margin-right:6px;color:#38bdf8;"></i>控制台</span>'
      +   '<select id="fd-console-file"><option value="">实时</option></select>'
      +   '<input id="fd-console-filter" placeholder="过滤关键字" size="10">'
      +   '<label style="font-size:11px;color:#94a3b8;display:inline-flex;align-items:center;gap:3px;">'
      +     '<input type="checkbox" id="fd-console-autoscroll" checked>自动滚动</label>'
      +   '<button id="fd-console-clear" title="清空内存日志">清空</button>'
      +   '<button id="fd-console-download" title="下载当前视图">下载</button>'
      +   '<button id="fd-console-close">×</button>'
      + '</div>'
      + '<div id="fd-console-list"></div>'
      + '<div id="fd-console-foot"><span id="fd-console-count">0 条</span><span id="fd-console-mode">实时</span></div>';
    document.body.appendChild(panel);

    state.panelEl = panel;
    state.listEl = panel.querySelector("#fd-console-list");
    state.fileSelectEl = panel.querySelector("#fd-console-file");
    state.filterEl = panel.querySelector("#fd-console-filter");
    state.autoScrollEl = panel.querySelector("#fd-console-autoscroll");

    panel.querySelector("#fd-console-close").addEventListener("click", toggle);
    panel.querySelector("#fd-console-clear").addEventListener("click", clearLogs);
    panel.querySelector("#fd-console-download").addEventListener("click", downloadLogs);
    state.filterEl.addEventListener("input", function () { renderList(); });
    state.fileSelectEl.addEventListener("change", onSwitchSource);

    // 点面板外任意空白处 → 关闭控制台（按钮本身与面板内不触发）
    document.addEventListener("click", function (e) {
      if (!state.visible) return;
      if (state.panelEl && state.panelEl.contains(e.target)) return;
      if (state.fabEl && state.fabEl.contains(e.target)) return;
      toggle();
    });
  }

  function toggle() {
    buildPanel();
    state.visible = !state.visible;
    state.panelEl.classList.toggle("open", state.visible);
    if (state.fabEl) state.fabEl.classList.toggle("open", state.visible);
    if (state.visible) {
      refreshFiles();
      startPolling();
    } else {
      stopPolling();
    }
  }

  function startPolling() {
    stopPolling();
    pollOnce();
    state.polling = setInterval(pollOnce, POLL_MS);
  }

  function stopPolling() {
    if (state.polling) { clearInterval(state.polling); state.polling = null; }
  }

  async function pollOnce() {
    if (state.viewingFile) return; // 历史文件模式不轮询
    try {
      var url = "/api/logs?tail=" + TAIL_LIMIT + "&since=" + state.lastId;
      var res = await fetch(url, { cache: "no-store" });
      var r = await res.json();
      if (r.code !== 0 || !r.data) return;
      var entries = r.data.entries || [];
      if (state.lastId === 0 && entries.length === 0) {
        // 首次加载，没内容
      }
      if (entries.length) {
        state.entries = state.entries.concat(entries);
        if (state.entries.length > TAIL_LIMIT * 2) {
          state.entries = state.entries.slice(-TAIL_LIMIT);
        }
        state.lastId = r.data.lastId || state.lastId;
        renderList();
      } else if (state.lastId === 0) {
        // 初始即空
        renderList();
      }
    } catch (e) { /* ignore */ }
  }

  async function refreshFiles() {
    try {
      var r = await (await fetch("/api/logs/files", { cache: "no-store" })).json();
      if (r.code !== 0) return;
      var cur = state.fileSelectEl.value;
      var opts = '<option value="">实时</option>';
      (r.data || []).forEach(function (f) {
        opts += '<option value="' + esc(f.name) + '">' + esc(f.name) + ' (' + Math.round((f.size || 0) / 1024) + 'KB)</option>';
      });
      state.fileSelectEl.innerHTML = opts;
      state.fileSelectEl.value = cur;
    } catch (_) {}
  }

  async function onSwitchSource() {
    var name = state.fileSelectEl.value;
    state.viewingFile = name;
    var modeEl = state.panelEl.querySelector("#fd-console-mode");
    if (name) {
      modeEl.textContent = "历史：" + name;
      stopPolling();
      try {
        var r = await (await fetch("/api/logs/files/" + encodeURIComponent(name), { cache: "no-store" })).json();
        var text = (r.data && r.data.text) || "";
        state.listEl.innerHTML = '<div class="row">' + esc(text) + '</div>';
        state.panelEl.querySelector("#fd-console-count").textContent = text.split("\n").length + " 行";
      } catch (e) {
        state.listEl.innerHTML = '<div class="row err">读取失败：' + esc(e.message || e) + '</div>';
      }
    } else {
      modeEl.textContent = "实时";
      state.entries = [];
      state.lastId = 0;
      renderList();
      startPolling();
    }
  }

  function renderList() {
    if (state.viewingFile) return;
    var kw = (state.filterEl.value || "").trim().toLowerCase();
    var rows = "";
    var shown = 0;
    state.entries.forEach(function (e) {
      if (kw && e.text.toLowerCase().indexOf(kw) < 0) return;
      var cls = e.level === "error" ? "row err" : "row";
      rows += '<div class="' + cls + '"><span class="t">[' + fmtTime(e.ts) + ']</span> <span class="lv">[' + esc(e.level) + ']</span> ' + esc(e.text) + '</div>';
      shown++;
    });
    state.listEl.innerHTML = rows || '<div class="row" style="color:#64748b;">暂无日志</div>';
    state.panelEl.querySelector("#fd-console-count").textContent = shown + " / " + state.entries.length + " 条";
    if (state.autoScrollEl.checked) {
      state.listEl.scrollTop = state.listEl.scrollHeight;
    }
  }

  async function clearLogs() {
    if (!confirm("清空内存日志？磁盘文件不会删除。")) return;
    try {
      await fetch("/api/logs", { method: "DELETE" });
      state.entries = [];
      state.lastId = 0;
      renderList();
    } catch (_) {}
  }

  function downloadLogs() {
    var text;
    if (state.viewingFile) {
      text = state.listEl.textContent || "";
    } else {
      text = state.entries.map(function (e) {
        return "[" + fmtTime(e.ts) + "] [" + e.level + "] " + e.text;
      }).join("\n");
    }
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = state.viewingFile || ("console-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log");
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", buildPanel);
  } else {
    buildPanel();
  }

  window.FlowdrawConsole = { toggle: toggle };
})();
