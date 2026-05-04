/**
 * frame-prompt-workflow.js — 首尾帧补全提示词工作流
 * 上传首尾帧图片+剧情+时长，一键生成视频提示词
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;
  var esc = window.WF_escapeHtml;

  function getConfigId(type) {
    var gc = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
    if (gc["framePrompt"]) {
      var key = type === "image" ? "imageConfigId" : "chatConfigId";
      if (gc["framePrompt"][key]) return gc["framePrompt"][key];
    }
    var sel = document.getElementById(type === "image" ? "image-config-select" : "chat-config-select");
    if (sel && sel.value) return sel.value;
    var list = (window.GLOBAL && window.GLOBAL.configList) || [];
    var allowed = type === "image" ? ["image", "both"] : ["chat", "both"];
    var c = list.find(function (c) { return allowed.indexOf(c.config_type) >= 0; });
    return c ? c.id : "";
  }

  async function callApi(url, body) {
    var res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var result = await res.json();
    if (result.code !== 0) throw new Error(result.message || result.detail || "生成失败");
    return result.data;
  }

  /* ── Node: fpInput ── */
  NR.register({
    id: "fpInput", label: "输入", icon: "fa-pencil", color: "#8b5cf6",
    category: "global", allowMultiple: false,
    getPreview: function (nd) { return nd && nd.plot ? nd.plot.slice(0, 60) : ""; },
    renderDetail: function (nd, wf) {
      var dur = (wf.input && wf.input.duration) || 5;
      return '<div class="wf-detail-section"><div class="wf-detail-label">这段时间内的剧情描述</div>'
        + '<textarea class="wf-detail-textarea" id="wf-fp-plot" rows="4" placeholder="描述首帧到尾帧之间发生了什么...">' + esc((wf.input && wf.input.plot) || "") + '</textarea></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">视频时长（秒，最多15秒）</div>'
        + '<input class="wf-detail-input" id="wf-fp-duration" type="number" min="1" max="15" value="' + dur + '"></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">首帧图片</div>'
        + (wf.input && wf.input.firstFrameUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(wf.input.firstFrameUrl) + '" style="margin-bottom:6px;">' : '')
        + '<label class="wf-upload-btn"><i class="fa fa-upload"></i> ' + (wf.input && wf.input.firstFrameUrl ? '替换首帧' : '上传首帧') + '<input type="file" accept="image/*" class="wf-file-input" data-fp-upload="firstFrame" style="display:none"></label></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">尾帧图片</div>'
        + (wf.input && wf.input.lastFrameUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(wf.input.lastFrameUrl) + '" style="margin-bottom:6px;">' : '')
        + '<label class="wf-upload-btn"><i class="fa fa-upload"></i> ' + (wf.input && wf.input.lastFrameUrl ? '替换尾帧' : '上传尾帧') + '<input type="file" accept="image/*" class="wf-file-input" data-fp-upload="lastFrame" style="display:none"></label></div>'
        + '<div class="wf-detail-actions"><button class="wf-tb-btn primary" id="wf-fp-save-input">保存</button></div>';
    },
  });

  /* ── Node: framePrompt ── */
  NR.register({
    id: "framePrompt", label: "视频提示词", icon: "fa-film", color: "#ec4899",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.fullText ? v.fullText.slice(0, 60) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      if (!wf.input.plot) throw new Error("请先填写剧情描述");
      if (!wf.input.firstFrameUrl && !wf.input.lastFrameUrl) throw new Error("请至少上传一张首帧或尾帧图片");
      var data = await callApi("/api/workflow/generate/frame-prompt", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("chat"),
        plot: wf.input.plot,
        duration: wf.input.duration || 5,
        first_frame_url: wf.input.firstFrameUrl || "",
        last_frame_url: wf.input.lastFrameUrl || "",
      });
      return { fullText: data.full_text || "" };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = (ctx && ctx.engine && ctx.engine.running && ctx.engine.runningWfId === ctx.engine.currentId) ? " disabled" : "";
      var html = "";
      if (v && v.fullText) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">生成的提示词</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="fullText" rows="12" style="white-space:pre-wrap;">' + esc(v.fullText) + '</textarea></div>';
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="framePrompt"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新生成" : "生成提示词") + '</button></div>';
      return html;
    },
  });

  /* ── Pipeline Definition ── */
  var FRAME_PROMPT_PIPELINE = {
    id: "frame-prompt",
    title: "首尾帧补全提示词",
    pipeline: [
      { nodeType: "fpInput", category: "global" },
      { nodeType: "framePrompt", category: "global" },
    ],
  };

  /* ── Template Registration ── */
  if (!window.WF_Templates) window.WF_Templates = [];
  window.WF_Templates.push({
    id: "frame-prompt",
    name: "根据首尾帧快速补全提示词",
    icon: "fa-magic",
    description: "上传首尾帧图片和剧情，自动生成详细视频提示词",
    pipeline: FRAME_PROMPT_PIPELINE,
  });

  /* ── Events ── */
  function bindFramePromptEvents(engine, rerender) {
    document.addEventListener("click", function (e) {
      var wfRoot = e.target.closest && e.target.closest("#workflow");
      if (!wfRoot) return;

      if (e.target.closest && e.target.closest("#wf-fp-save-input")) {
        var wf = engine.current();
        if (!wf) return;
        wf.input.plot = (document.getElementById("wf-fp-plot") || {}).value || "";
        var durVal = parseInt((document.getElementById("wf-fp-duration") || {}).value) || 5;
        wf.input.duration = Math.max(1, Math.min(15, durVal));
        if (wf.input.plot) {
          var _tpl = (window.WF_Templates || []).find(function (t) { return t.id === wf.templateId; });
          var _defTitle = _tpl ? _tpl.name : "新工作流";
          if (wf.title === _defTitle || wf.title === "新工作流") {
            wf.title = wf.input.plot.replace(/[\n\r]/g, " ").slice(0, 20);
          }
        }
        engine.save();
        rerender();
        return;
      }
    });

    document.addEventListener("change", function (e) {
      if (!e.target.classList || !e.target.classList.contains("wf-file-input")) return;
      var fpUpload = e.target.getAttribute("data-fp-upload");
      if (!fpUpload) return;
      if (!e.target.files || !e.target.files[0]) return;
      var file = e.target.files[0];
      var reader = new FileReader();
      reader.onload = function () {
        var wf = engine.current();
        if (!wf) return;
        fetch("/api/workflow/upload-image/" + wf.id, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_data: reader.result, prefix: fpUpload }),
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.code !== 0 || !res.data || !res.data.url) return;
          if (fpUpload === "firstFrame") wf.input.firstFrameUrl = res.data.url;
          else if (fpUpload === "lastFrame") wf.input.lastFrameUrl = res.data.url;
          engine.save();
          rerender();
        }).catch(function (err) { alert("上传失败: " + err.message); });
      };
      reader.readAsDataURL(file);
    });
  }

  var _fpBound = false;
  var _origInit = window.initWorkflowModule;
  window.initWorkflowModule = async function () {
    await _origInit();
    if (!_fpBound) {
      _fpBound = true;
      var engine = window._wfEngine;
      var rerender = function () { WF_Renderer.render(engine); };
      bindFramePromptEvents(engine, rerender);
    }
  };
})();
