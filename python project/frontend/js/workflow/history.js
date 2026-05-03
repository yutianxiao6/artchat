/**
 * history.js — 工作流会话列表
 * 左侧折叠栏显示所有工作流会话，可切换
 */
(function () {
  "use strict";

  var esc = window.WF_escapeHtml;

  function renderHistoryPanel(engine) {
    var open = engine.historyOpen;
    var wfs = engine.workflows || [];
    var curId = engine.currentId;

    var toggle = '<button class="wf-history-toggle" id="wf-history-toggle" title="工作流列表">'
      + '<i class="fa fa-list"></i>'
      + (wfs.length > 1 ? '<span class="wf-history-badge">' + wfs.length + '</span>' : '')
      + '</button>';

    if (!open) return toggle + '<div class="wf-history-panel"></div>';

    var items = wfs.map(function (w) {
      var active = w.id === curId ? "active" : "";
      var time = formatTime(w.createdAt);
      var plot = (w.input && w.input.plot) ? esc(w.input.plot).slice(0, 40) : "空白工作流";
      return '<div class="wf-history-item ' + active + '" data-wf-id="' + w.id + '">'
        + '<div class="wf-history-item-icon"><i class="fa fa-film"></i></div>'
        + '<div class="wf-history-item-body">'
        + '<div class="wf-history-item-title">' + esc(w.title) + '</div>'
        + '<div class="wf-history-item-desc">' + plot + '</div>'
        + '<div class="wf-history-item-time">' + time + '</div>'
        + '</div></div>';
    }).join("");

    if (!items) items = '<div class="wf-history-empty">暂无工作流</div>';

    return toggle + '<div class="wf-history-panel open">'
      + '<div class="wf-history-header">'
      + '<span>工作流列表</span>'
      + '<button class="wf-tb-btn" id="wf-history-new" style="padding:4px 10px;font-size:11px;"><i class="fa fa-plus"></i></button>'
      + '</div>'
      + '<div class="wf-history-list custom-scrollbar">' + items + '</div>'
      + '</div>';
  }

  function formatTime(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
      return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    } catch (e) { return iso; }
  }

  function bindHistoryEvents(engine, rerender) {
    document.addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest("#wf-history-toggle")) {
        engine.historyOpen = !engine.historyOpen;
        rerender();
        return;
      }
      if (e.target.closest && e.target.closest("#wf-history-new")) {
        engine.create();
        rerender();
        return;
      }
      var item = e.target.closest && e.target.closest(".wf-history-item[data-wf-id]");
      if (item) {
        engine.currentId = item.getAttribute("data-wf-id");
        engine.selectedNodeKey = null;
        engine.detailOpen = false;
        rerender();
        return;
      }
    });
  }

  window.WF_History = {
    render: renderHistoryPanel,
    bindEvents: bindHistoryEvents,
  };
})();
