/**
 * recreate-workflow.js — 最强二创影视剧工作流
 * 注册10种节点类型、生成逻辑、详情面板、事件绑定
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;
  var esc = window.WF_escapeHtml;

  function _getNodeConfigs() {
    if (window._getGlobalNodeConfigs) return window._getGlobalNodeConfigs();
    try { return JSON.parse(localStorage.getItem("flowdraw:wfNodeConfigs") || "{}"); } catch (e) { return {}; }
  }

  function getConfigId(type, nodeType) {
    // 优先：节点级配置（视觉/聊天/图片）
    if (nodeType) {
      var gc = _getNodeConfigs();
      var nc = gc[nodeType] || {};
      var key = type === "image" ? "imageConfigId" : (type === "vision" ? "visionConfigId" : "chatConfigId");
      if (nc[key]) return nc[key];
    }
    // 次之：界面顶部下拉（vision 模型复用 chat 选择器，因为视觉模型也走 /chat/completions）
    var selectType = type === "image" ? "image" : "chat";
    var sel = document.getElementById(selectType === "image" ? "image-config-select" : "chat-config-select");
    if (sel && sel.value) return sel.value;
    // 最后：自动选配置列表里第一个
    var list = (window.GLOBAL && window.GLOBAL.configList) || [];
    var allowed = selectType === "image" ? ["image", "both"] : ["chat", "both"];
    var c = list.find(function (c) { return allowed.indexOf(c.config_type) >= 0; });
    return c ? c.id : "";
  }

  async function callApi(url, body) {
    var res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var result = await res.json();
    if (result.code !== 0) throw new Error(result.message || result.detail || "生成失败");
    return result.data;
  }

  function _getDisabledAttr(ctx, nodeType) {
    if (!ctx || !ctx.engine) return "";
    if (ctx.engine.isNodeRunning && ctx.engine.isNodeRunning(nodeType, null)) return " disabled";
    return "";
  }

  function _formatFileSize(bytes) {
    if (!bytes) return "0 B";
    var units = ["B", "KB", "MB", "GB"];
    var i = 0;
    var v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 2) + " " + units[i];
  }

  function _formatDuration(sec) {
    if (!sec || sec < 0) return "未知";
    sec = Math.round(sec);
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    return m + ":" + String(s).padStart(2, "0");
  }

  function _renderVideoCard(input) {
    if (!input || !input.videoUrl) return "";
    var meta = input.videoMetadata || {};
    var rows = [];
    rows.push(['文件名', esc(input.videoFilename || "source")]);
    if (input.videoSize) rows.push(['大小', _formatFileSize(input.videoSize)]);
    if (meta.duration) rows.push(['时长', _formatDuration(meta.duration)]);
    if (meta.width && meta.height) rows.push(['分辨率', meta.width + " × " + meta.height]);
    if (meta.fps) rows.push(['帧率', meta.fps + " fps"]);
    if (meta.codec) rows.push(['编码', esc(meta.codec)]);
    var rowsHtml = rows.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px dashed rgba(148,163,184,.2);"><span style="color:#94a3b8;">' + r[0] + '</span><span style="color:#e2e8f0;">' + r[1] + '</span></div>';
    }).join("");
    return '<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:10px 12px;margin-bottom:8px;">'
      + '<div style="color:#22c55e;font-size:12px;font-weight:600;margin-bottom:6px;"><i class="fa fa-check-circle"></i> 视频已上传</div>'
      + rowsHtml
      + '<video controls preload="metadata" src="' + esc(input.videoUrl) + '" style="width:100%;max-height:200px;margin-top:8px;border-radius:6px;background:#000;"></video>'
      + '</div>';
  }

  // ── Node: rcInput ─────────────────────────────
  NR.register({
    id: "rcInput", label: "输入", icon: "fa-upload", color: "#8b5cf6",
    category: "global", allowMultiple: false,
    getPreview: function (nd) { return nd && nd.plot ? nd.plot.slice(0, 60) : ""; },
    renderDetail: function (nd, wf) {
      var input = wf.input || {};
      return '<div class="wf-detail-section"><div class="wf-detail-label">上传视频</div>'
        + _renderVideoCard(input)
        + '<div id="wf-rc-upload-progress" style="display:none;margin-bottom:8px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span id="wf-rc-upload-label" style="color:#60a5fa;">准备上传...</span><span id="wf-rc-upload-percent" style="color:#94a3b8;">0%</span></div>'
        + '<div style="height:6px;background:rgba(148,163,184,.2);border-radius:3px;overflow:hidden;"><div id="wf-rc-upload-bar" style="height:100%;background:linear-gradient(90deg,#60a5fa,#22c55e);width:0%;transition:width .2s ease;"></div></div>'
        + '<div id="wf-rc-upload-detail" style="font-size:11px;color:#64748b;margin-top:4px;"></div>'
        + '</div>'
        + '<label class="wf-upload-btn"><i class="fa fa-film"></i> ' + (input.videoUrl ? '替换视频' : '选择视频文件') + '<input type="file" accept="video/*" class="wf-file-input" data-rc-upload="video" style="display:none"></label></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">原始完整剧情</div>'
        + '<textarea class="wf-detail-textarea" id="wf-rc-plot" rows="6" placeholder="粘贴这部视频的完整剧情...">' + esc(input.plot || "") + '</textarea></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">二创方向</div>'
        + '<textarea class="wf-detail-textarea" id="wf-rc-direction" rows="3" placeholder="如：改成喜剧结局、加入穿越元素、压缩为3分钟...">' + esc(input.direction || "") + '</textarea></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">目标风格</div>'
        + '<input class="wf-detail-input" id="wf-rc-style" placeholder="如：赛博朋克、水墨国风、日系动漫..." value="' + esc(input.style || "") + '"></div>'
        + '<div class="wf-detail-actions"><button class="wf-tb-btn primary" id="wf-rc-save-input">保存</button></div>';
    },
  });

  // ── Node: rcKeyframes ─────────────────────────────
  NR.register({
    id: "rcKeyframes", label: "关键帧提取", icon: "fa-th", color: "#06b6d4",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.frames ? "共 " + v.frames.length + " 帧" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      if (!wf.input || !wf.input.videoUrl) throw new Error("请先在输入节点上传视频");
      var nd = ctx.nodeData;
      var mode = nd.extractMode || "scene";
      var maxFrames = nd.maxFrames || (wf.input.recommendedMaxFrames) || 30;
      var intervalSec = nd.intervalSec || 2.0;
      var data = await callApi("/api/recreate/extract-keyframes/" + wf.id, {
        mode: mode, max_frames: maxFrames, interval_sec: intervalSec,
      });
      return { frames: data.frames || [], extractMode: mode };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcKeyframes");
      var mode = nd.extractMode || "scene";
      var recommended = (wf.input && wf.input.recommendedMaxFrames) || 0;
      var maxFrames = nd.maxFrames || recommended || 30;
      var intervalSec = nd.intervalSec || 2.0;
      var recHint = recommended
        ? '<div style="font-size:11px;color:#64748b;margin-top:4px;">根据视频时长 ' + _formatDuration((wf.input.videoMetadata && wf.input.videoMetadata.duration) || 0) + '，推荐 ' + recommended + ' 帧（每 15 秒一帧）</div>'
        : '';
      var html = '<div class="wf-detail-section"><div class="wf-detail-label">提取模式</div>'
        + '<select class="wf-detail-input wf-editable" data-edit-field="extractMode">'
        + '<option value="scene"' + (mode === "scene" ? " selected" : "") + '>场景检测（推荐）</option>'
        + '<option value="interval"' + (mode === "interval" ? " selected" : "") + '>固定间隔</option>'
        + '</select></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">最大帧数</div>'
        + '<input class="wf-detail-input wf-editable" data-edit-field="maxFrames" type="number" min="5" max="80" value="' + maxFrames + '">'
        + recHint + '</div>';
      if (mode === "interval") {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">间隔秒数</div>'
          + '<input class="wf-detail-input wf-editable" data-edit-field="intervalSec" type="number" min="0.5" max="10" step="0.5" value="' + intervalSec + '"></div>';
      }
      if (v && v.frames && v.frames.length) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">已提取 ' + v.frames.length + ' 帧</div>'
          + '<div class="wf-frames-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">';
        v.frames.forEach(function (f, i) {
          var ts = f.timestamp || 0;
          var tsLabel = ts >= 60
            ? Math.floor(ts / 60) + ":" + String(Math.floor(ts % 60)).padStart(2, "0")
            : ts.toFixed(1) + "s";
          html += '<div style="position:relative;">'
            + '<img class="wf-preview-img" src="' + esc(f.url) + '" style="width:100%;border-radius:6px;">'
            + '<div style="position:absolute;top:2px;left:2px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;">'
            + (i + 1) + ' · ' + tsLabel + '</div>'
            + '<button class="wf-ref-del-btn" data-del-rc-frame="' + i + '" style="position:absolute;top:2px;right:2px;"><i class="fa fa-times"></i></button>'
            + '</div>';
        });
        html += '</div></div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcKeyframes"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新提取" : "提取关键帧") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcFrameAnalysis ─────────────────────────────
  NR.register({
    id: "rcFrameAnalysis", label: "帧内容分析", icon: "fa-search", color: "#6366f1",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.frames ? v.frames.length + " 帧已分析" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var kfNode = (wf.rcKeyframess || [])[0];
      var kfV = NR.getActiveVersion(kfNode);
      if (!kfV || !kfV.frames || !kfV.frames.length) throw new Error("请先提取关键帧");
      var nd = ctx.nodeData;
      var batchSize = parseInt(nd.batchSize) || 6;
      var maxConcurrent = parseInt(nd.maxConcurrent) || 3;
      var data = await callApi("/api/recreate/generate/frame-analysis", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcFrameAnalysis"),
        frames: kfV.frames,
        batch_size: batchSize,
        max_concurrent: maxConcurrent,
      });
      return {
        frames: data.frames || [],
        overview: data.overview || {},
      };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcFrameAnalysis");
      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var kfFrames = (kfV && kfV.frames) || [];
      var batchSize = parseInt(nd.batchSize) || 6;
      var maxConcurrent = parseInt(nd.maxConcurrent) || 3;

      // 批处理参数
      var html = '<div class="wf-detail-section"><div class="wf-detail-label">分批大小（每批帧数）</div>'
        + '<input class="wf-detail-input wf-editable" data-edit-field="batchSize" type="number" min="2" max="15" value="' + batchSize + '">'
        + '<div style="font-size:11px;color:#64748b;margin-top:4px;">每批 6 张质量与速度平衡最好</div></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">并发批次数</div>'
        + '<input class="wf-detail-input wf-editable" data-edit-field="maxConcurrent" type="number" min="1" max="6" value="' + maxConcurrent + '">'
        + '<div style="font-size:11px;color:#64748b;margin-top:4px;">并发越多越快，但超过 API 限流会报错</div></div>';

      // 阶段1 overview 展示
      if (v && v.overview) {
        var ov = v.overview;
        html += '<div class="wf-detail-section" style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.25);border-radius:10px;padding:10px 12px;">'
          + '<div class="wf-detail-label" style="color:#818cf8;">全局脉络（阶段1）</div>';
        if (ov.narrative) {
          html += '<div style="font-size:11px;color:#94a3b8;">叙事脉络</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="overview.narrative" rows="3">' + esc(ov.narrative) + '</textarea>';
        }
        if (ov.characters && ov.characters.length) {
          html += '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">人物清单（' + ov.characters.length + '）</div>';
          ov.characters.forEach(function (c, ci) {
            html += '<div style="font-size:11px;margin-bottom:3px;"><b>' + esc(c.name || c.id || ("人物" + (ci + 1))) + '</b>: ' + esc(c.features || "") + '</div>';
          });
        }
        if (ov.scenes && ov.scenes.length) {
          html += '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">场景清单（' + ov.scenes.length + '）</div>';
          ov.scenes.forEach(function (s, si) {
            html += '<div style="font-size:11px;margin-bottom:3px;"><b>' + esc(s.name || s.id || ("场景" + (si + 1))) + '</b>: ' + esc(s.features || "") + '</div>';
          });
        }
        html += '</div>';
      }

      // 每帧详情
      if (v && v.frames && v.frames.length) {
        v.frames.forEach(function (f, i) {
          var thumb = kfFrames[i] ? '<img class="wf-preview-img" src="' + esc(kfFrames[i].url) + '" style="width:80px;float:left;margin-right:8px;border-radius:4px;">' : "";
          html += '<div class="wf-detail-section"><div class="wf-detail-label">帧 ' + (i + 1)
            + (f.error ? ' <span style="color:#ef4444;font-size:10px;">⚠ ' + esc(f.error) + '</span>' : '')
            + '</div>'
            + thumb
            + '<div style="margin-left:' + (kfFrames[i] ? '92px' : '0') + ';">'
            + '<div style="font-size:11px;color:#94a3b8;">场景</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="frames.' + i + '.scene" rows="2">' + esc(f.scene || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">人物/动作</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="frames.' + i + '.characters" rows="2">' + esc(f.characters || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">构图</div>'
            + '<input class="wf-detail-input wf-editable" data-edit-field="frames.' + i + '.composition" value="' + esc(f.composition || "") + '">'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">情绪</div>'
            + '<input class="wf-detail-input wf-editable" data-edit-field="frames.' + i + '.mood" value="' + esc(f.mood || "") + '">'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">对话/旁白</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="frames.' + i + '.dialogue" rows="2">' + esc(f.dialogue || "") + '</textarea>'
            + '</div><div style="clear:both;"></div></div>';
        });
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">尚未分析</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcFrameAnalysis"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新分析" : "开始分析") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcPlotAlign ─────────────────────────────
  NR.register({
    id: "rcPlotAlign", label: "剧情对齐", icon: "fa-link", color: "#0ea5e9",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.segments ? "已分 " + v.segments.length + " 段" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      if (!wf.input || !wf.input.plot) throw new Error("请先填写原始剧情");
      var faV = NR.getActiveVersion((wf.rcFrameAnalysiss || [])[0]);
      if (!faV || !faV.frames || !faV.frames.length) throw new Error("请先完成帧内容分析");
      var data = await callApi("/api/recreate/generate/plot-align", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("chat", "rcPlotAlign"),
        original_plot: wf.input.plot,
        frame_analyses: faV.frames,
        overview: faV.overview || {},
      });
      return { segments: data.segments || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcPlotAlign");
      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var kfFrames = (kfV && kfV.frames) || [];
      var html = "";
      if (v && v.segments && v.segments.length) {
        v.segments.forEach(function (s, i) {
          var frameIdxs = s.frame_indices || [];
          var thumbs = frameIdxs.slice(0, 3).map(function (fi) {
            return kfFrames[fi] ? '<img src="' + esc(kfFrames[fi].url) + '" style="width:50px;height:35px;object-fit:cover;border-radius:3px;margin-right:3px;">' : "";
          }).join("");
          html += '<div class="wf-detail-section"><div class="wf-detail-label">第 ' + (i + 1) + ' 段 '
            + (s.time_range ? '<span style="font-size:10px;color:#64748b;">[' + esc(s.time_range) + ']</span>' : '')
            + '</div>'
            + '<div style="margin-bottom:4px;">' + thumbs + '</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.plot_text" rows="3">' + esc(s.plot_text || "") + '</textarea>'
            + '</div>';
        });
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未对齐</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcPlotAlign"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新对齐" : "开始对齐") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcPlotRewrite ─────────────────────────────
  NR.register({
    id: "rcPlotRewrite", label: "剧情重编排", icon: "fa-pencil-square-o", color: "#3b82f6",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.segments ? v.segments.length + " 段新剧情" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var paV = NR.getActiveVersion((wf.rcPlotAligns || [])[0]);
      if (!paV || !paV.segments || !paV.segments.length) throw new Error("请先完成剧情对齐");
      var data = await callApi("/api/recreate/generate/rewrite-plot", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("chat", "rcPlotRewrite"),
        aligned_segments: paV.segments,
        direction: (wf.input && wf.input.direction) || "",
        style: (wf.input && wf.input.style) || "",
      });
      return {
        segments: data.segments || [],
        characters: data.characters || [],
        scenes: data.scenes || [],
      };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcPlotRewrite");
      var html = "";
      if (v && v.segments && v.segments.length) {
        v.segments.forEach(function (s, i) {
          var sceneAction = s.scene_action || "keep";
          html += '<div class="wf-detail-section"><div class="wf-detail-label">第 ' + (i + 1) + ' 段</div>'
            + '<div style="font-size:11px;color:#94a3b8;">新剧情</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.text" rows="3">' + esc(s.text || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">对话/旁白</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.dialogue" rows="2">' + esc(s.dialogue || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">场景处理</div>'
            + '<select class="wf-detail-input wf-editable" data-edit-field="segments.' + i + '.scene_action">'
            + '<option value="keep"' + (sceneAction === "keep" ? " selected" : "") + '>保留原场景</option>'
            + '<option value="modify"' + (sceneAction === "modify" ? " selected" : "") + '>修改场景</option>'
            + '<option value="new"' + (sceneAction === "new" ? " selected" : "") + '>新增场景</option>'
            + '</select>'
            + '</div>';
        });
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未重编排</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcPlotRewrite"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新编排" : "开始重编排") + '</button>';
      if (v && v.segments && v.segments.length) {
        html += ' <button class="wf-tb-btn" id="wf-rc-create-segments" style="margin-left:6px;"><i class="fa fa-sitemap"></i> 生成段落节点</button>';
      }
      html += '</div>';
      return html;
    },
  });

  // ── Node: rcCharacters ─────────────────────────────
  NR.register({
    id: "rcCharacters", label: "人物重设计", icon: "fa-users", color: "#f59e0b",
    category: "global", allowMultiple: false, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.characters ? v.characters.map(function (c) { return c.name; }).join("、") : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var chars = (v && v.characters) || [];
      if (!chars.length) {
        // 从 rcPlotRewrite 初始化人物列表
        var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
        chars = (prV && prV.characters) ? prV.characters.map(function (c) {
          return { name: c.name, original_desc: c.original_desc, new_desc: c.new_desc, visual_prompt: c.new_desc || c.original_desc, imageUrl: "" };
        }) : [];
      }
      if (!chars.length) throw new Error("请先运行剧情重编排获取人物列表，或手动添加人物");
      var data = await callApi("/api/recreate/generate/redesign-characters", {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", "rcCharacters"),
        characters: chars,
        style: (wf.input && wf.input.style) || "",
        ref_image_urls: nd.refImages || [],
      });
      return { characters: data.characters || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcCharacters");
      var html = "";
      var chars = (v && v.characters) || [];
      if (!chars.length) {
        var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
        if (prV && prV.characters) {
          html += '<div class="wf-detail-text" style="color:#64748b;">从剧情重编排中获取了 ' + prV.characters.length + ' 个人物，点击生成按钮开始重设计</div>';
        }
      }
      chars.forEach(function (c, ci) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">'
          + '<input class="wf-detail-input wf-editable" data-edit-field="characters.' + ci + '.name" value="' + esc(c.name || "") + '" style="width:auto;display:inline-block;">'
          + ' <button class="wf-char-del-btn" data-del-rc-char="' + ci + '" title="删除" style="float:right;background:transparent;border:none;color:#ef4444;cursor:pointer;"><i class="fa fa-trash-o"></i></button>'
          + '</div>'
          + (c.original_desc ? '<div style="font-size:11px;color:#64748b;margin-bottom:4px;">原始: ' + esc(c.original_desc) + '</div>' : '')
          + '<div style="font-size:11px;color:#94a3b8;">新形象描述</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="characters.' + ci + '.new_desc" rows="2">' + esc(c.new_desc || "") + '</textarea>'
          + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">视觉提示词</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="characters.' + ci + '.visual_prompt" rows="2">' + esc(c.visual_prompt || "") + '</textarea>'
          + (c.imageUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(c.imageUrl) + '">' : '')
          + '</div>';
      });
      html += '<div class="wf-detail-section"><button class="wf-tb-btn" id="wf-rc-add-char"><i class="fa fa-plus"></i> 添加人物</button></div>';
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcCharacters"' + dis + '><i class="fa fa-refresh"></i> ' + (chars.some(function(c){return c.imageUrl;}) ? "全部重新生成" : "全部生成图片") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcScenes ─────────────────────────────
  NR.register({
    id: "rcScenes", label: "场景重设计", icon: "fa-image", color: "#10b981",
    category: "global", allowMultiple: false, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.scenes ? v.scenes.map(function (s) { return s.name; }).join("、") : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var scenes = (v && v.scenes) || [];
      if (!scenes.length) {
        var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
        scenes = (prV && prV.scenes) ? prV.scenes.map(function (s) {
          return { name: s.name, original_desc: s.original_desc, new_desc: s.new_desc, visual_prompt: s.new_desc || s.original_desc, imageUrl: "" };
        }) : [];
      }
      if (!scenes.length) throw new Error("请先运行剧情重编排获取场景列表，或手动添加场景");
      var data = await callApi("/api/recreate/generate/redesign-scenes", {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", "rcScenes"),
        scenes: scenes,
        style: (wf.input && wf.input.style) || "",
        ref_image_urls: nd.refImages || [],
      });
      return { scenes: data.scenes || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcScenes");
      var html = "";
      var scenes = (v && v.scenes) || [];
      if (!scenes.length) {
        var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
        if (prV && prV.scenes) {
          html += '<div class="wf-detail-text" style="color:#64748b;">从剧情重编排中获取了 ' + prV.scenes.length + ' 个场景，点击生成按钮开始重设计</div>';
        }
      }
      scenes.forEach(function (s, si) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">'
          + '<input class="wf-detail-input wf-editable" data-edit-field="scenes.' + si + '.name" value="' + esc(s.name || "") + '" style="width:auto;display:inline-block;">'
          + ' <button class="wf-scene-del-btn" data-del-rc-scene="' + si + '" title="删除" style="float:right;background:transparent;border:none;color:#ef4444;cursor:pointer;"><i class="fa fa-trash-o"></i></button>'
          + '</div>'
          + (s.original_desc ? '<div style="font-size:11px;color:#64748b;margin-bottom:4px;">原始: ' + esc(s.original_desc) + '</div>' : '')
          + '<div style="font-size:11px;color:#94a3b8;">新风格描述</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="scenes.' + si + '.new_desc" rows="2">' + esc(s.new_desc || "") + '</textarea>'
          + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">视觉提示词</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="scenes.' + si + '.visual_prompt" rows="2">' + esc(s.visual_prompt || "") + '</textarea>'
          + (s.imageUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(s.imageUrl) + '">' : '')
          + '</div>';
      });
      html += '<div class="wf-detail-section"><button class="wf-tb-btn" id="wf-rc-add-scene"><i class="fa fa-plus"></i> 添加场景</button></div>';
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcScenes"' + dis + '><i class="fa fa-refresh"></i> ' + (scenes.some(function(s){return s.imageUrl;}) ? "全部重新生成" : "全部生成图片") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcStoryboard（segment 级）─────────────────────────────
  NR.register({
    id: "rcStoryboard", label: "分镜提示词", icon: "fa-film", color: "#ec4899",
    category: "segment", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.prompt ? v.prompt.slice(0, 60) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var segIdx = ctx.segIndex;
      var seg = ctx.segment || (wf.segments || [])[segIdx];
      if (!seg) throw new Error("未找到段落");

      var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
      var segData = (prV && prV.segments && prV.segments[segIdx]) || { text: "", dialogue: "" };

      var charsV = NR.getActiveVersion((wf.rcCharacterss || [])[0]);
      var characters = (charsV && charsV.characters) || [];
      var scenesV = NR.getActiveVersion((wf.rcSceness || [])[0]);
      var scenes = (scenesV && scenesV.scenes) || [];

      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var faV = NR.getActiveVersion((wf.rcFrameAnalysiss || [])[0]);
      var paV = NR.getActiveVersion((wf.rcPlotAligns || [])[0]);
      var alignSeg = (paV && paV.segments && paV.segments[segIdx]) || {};
      var frameIdxs = alignSeg.frame_indices || [segIdx];
      var firstFrameIdx = frameIdxs[0] !== undefined ? frameIdxs[0] : 0;
      var refFrame = (kfV && kfV.frames && kfV.frames[firstFrameIdx]) || null;
      var frameAnalysis = (faV && faV.frames && faV.frames[firstFrameIdx]) || {};

      var data = await callApi("/api/recreate/generate/rc-storyboard", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("chat", "rcStoryboard"),
        segment: segData,
        characters: characters,
        scenes: scenes,
        style: (wf.input && wf.input.style) || "",
        frame_url: refFrame ? refFrame.url : "",
        composition: frameAnalysis.composition || "",
      });
      return {
        prompt: data.prompt || "",
        prompt_cn: data.prompt_cn || "",
        composition_notes: data.composition_notes || "",
        ref_frame_url: refFrame ? refFrame.url : "",
      };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcStoryboard");
      var html = "";
      if (v) {
        if (v.ref_frame_url) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">原始构图参考</div>'
            + '<img class="wf-detail-img" src="' + esc(v.ref_frame_url) + '" style="max-width:100%;border-radius:6px;"></div>';
        }
        html += '<div class="wf-detail-section"><div class="wf-detail-label">图像提示词（英文）</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="prompt" rows="6">' + esc(v.prompt || "") + '</textarea></div>'
          + '<div class="wf-detail-section"><div class="wf-detail-label">中文提示词</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="prompt_cn" rows="4">' + esc(v.prompt_cn || "") + '</textarea></div>'
          + '<div class="wf-detail-section"><div class="wf-detail-label">构图说明</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="composition_notes" rows="2">' + esc(v.composition_notes || "") + '</textarea></div>';
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="rcStoryboard"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新生成" : "生成提示词") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcImageGen（segment 级）─────────────────────────────
  NR.register({
    id: "rcImageGen", label: "画面生成", icon: "fa-picture-o", color: "#a855f7",
    category: "segment", allowMultiple: false, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.imageUrl ? "已生成" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var segIdx = ctx.segIndex;
      var seg = ctx.segment || (wf.segments || [])[segIdx];
      if (!seg) throw new Error("未找到段落");

      var sbV = NR.getActiveVersion((seg.rcStoryboards || [])[0]);
      if (!sbV || !sbV.prompt) throw new Error("请先生成分镜提示词");

      var charsV = NR.getActiveVersion((wf.rcCharacterss || [])[0]);
      var charRefs = (charsV && charsV.characters) ? charsV.characters.map(function (c) { return c.imageUrl; }).filter(Boolean) : [];
      var scenesV = NR.getActiveVersion((wf.rcSceness || [])[0]);
      var sceneRef = (scenesV && scenesV.scenes && scenesV.scenes[0]) ? scenesV.scenes[0].imageUrl : "";

      var data = await callApi("/api/recreate/generate/rc-image", {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", "rcImageGen"),
        prompt: sbV.prompt,
        ref_frame_url: sbV.ref_frame_url || "",
        char_ref_urls: charRefs,
        scene_ref_url: sceneRef,
        segment_index: segIdx,
      });
      return { imageUrl: data.imageUrl || "", ref_frame_url: sbV.ref_frame_url || "" };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcImageGen");
      var html = "";
      if (v && v.imageUrl) {
        if (v.ref_frame_url) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">原始 vs 二创</div>'
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
            + '<div><div style="font-size:11px;color:#94a3b8;">原始</div><img class="wf-preview-img" src="' + esc(v.ref_frame_url) + '" style="width:100%;border-radius:6px;"></div>'
            + '<div><div style="font-size:11px;color:#22c55e;">二创</div><img class="wf-preview-img" src="' + esc(v.imageUrl) + '" style="width:100%;border-radius:6px;"></div>'
            + '</div></div>';
        } else {
          html += '<img class="wf-detail-img wf-preview-img" src="' + esc(v.imageUrl) + '">';
        }
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="rcImageGen"' + dis + '><i class="fa fa-refresh"></i> ' + (v && v.imageUrl ? "重新生成" : "生成画面") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcOutput ─────────────────────────────
  NR.register({
    id: "rcOutput", label: "最终输出", icon: "fa-check-circle", color: "#22c55e",
    category: "global", allowMultiple: false,
    getPreview: function () { return ""; },
    renderDetail: function (nd, wf) {
      var segments = wf.segments || [];
      var results = segments.map(function (seg, i) {
        var v = NR.getActiveVersion((seg.rcImageGens || [])[0]);
        return v && v.imageUrl ? { index: i, url: v.imageUrl, refUrl: v.ref_frame_url } : null;
      }).filter(Boolean);

      if (!results.length) {
        return '<div class="wf-detail-text" style="color:#64748b;">暂无生成结果。请先完成各段的画面生成。</div>';
      }
      var html = '<div class="wf-detail-section"><div class="wf-detail-label">二创成品（' + results.length + '/' + segments.length + ' 段完成）</div></div>';
      results.forEach(function (r) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">第 ' + (r.index + 1) + ' 段</div>';
        if (r.refUrl) {
          html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">'
            + '<img class="wf-preview-img" src="' + esc(r.refUrl) + '" style="width:100%;border-radius:6px;">'
            + '<img class="wf-preview-img" src="' + esc(r.url) + '" style="width:100%;border-radius:6px;">'
            + '</div>';
        } else {
          html += '<img class="wf-detail-img wf-preview-img" src="' + esc(r.url) + '">';
        }
        html += '</div>';
      });
      return html;
    },
  });

  // ── Pipeline Definition ─────────────────────────────
  var RECREATE_PIPELINE = {
    id: "recreate",
    title: "最强二创影视剧工作流",
    pipeline: [
      { nodeType: "rcInput",         category: "global" },
      { nodeType: "rcKeyframes",     category: "global" },
      { nodeType: "rcFrameAnalysis", category: "global" },
      { nodeType: "rcPlotAlign",     category: "global" },
      { nodeType: "rcPlotRewrite",   category: "global" },
      { nodeType: "rcCharacters",    category: "global" },
      { nodeType: "rcScenes",        category: "global" },
      { nodeType: "rcStoryboard",    category: "segment" },
      { nodeType: "rcImageGen",      category: "segment" },
      { nodeType: "rcOutput",        category: "global" },
    ],
  };

  // ── Template Registration ─────────────────────────────
  if (!window.WF_Templates) window.WF_Templates = [];
  window.WF_Templates.push({
    id: "recreate-drama",
    name: "最强二创影视剧工作流",
    icon: "fa-recycle",
    description: "上传视频+剧情，关键帧提取→剧情重编排→人物/场景重设计→生成二创作品",
    pipeline: RECREATE_PIPELINE,
  });

  // ── Init ─────────────────────────────
  var _initialized = false;

  function initRecreateModule() {
    if (_initialized) return;
    _initialized = true;
    bindRecreateEvents();
  }

  function _xhrUpload(url, body, headers, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      if (headers) {
        Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
      }
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch (e) { reject(new Error("响应解析失败")); }
        } else {
          var msg = "HTTP " + xhr.status;
          try {
            var j = JSON.parse(xhr.responseText);
            msg = j.detail || j.message || msg;
          } catch (e) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = function () { reject(new Error("网络错误")); };
      xhr.onabort = function () { reject(new Error("上传已取消")); };
      xhr.send(body);
    });
  }

  async function uploadVideoFile(wfId, file, onProgress) {
    var sizeLimitMB = 5;
    if (file.size <= sizeLimitMB * 1024 * 1024) {
      // 小文件走 base64 JSON
      var dataUrl = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      var json = await _xhrUpload(
        "/api/recreate/upload-video-b64/" + wfId,
        JSON.stringify({ video_data: dataUrl, filename: file.name }),
        { "Content-Type": "application/json" },
        onProgress
      );
      if (json.code !== 0) throw new Error(json.detail || "上传失败");
      return json.data;
    } else {
      // 大文件走 multipart
      var form = new FormData();
      form.append("file", file);
      var json = await _xhrUpload(
        "/api/recreate/upload-video/" + wfId,
        form,
        null,
        onProgress
      );
      if (json.code !== 0) throw new Error(json.detail || "上传失败");
      return json.data;
    }
  }

  async function runSingleGlobal(engine, nodeType) {
    var wf = engine.current();
    if (!wf) return;
    if (engine.isNodeRunning && engine.isNodeRunning(nodeType, null)) return;
    if (engine.canExecute && !engine.canExecute(nodeType, null, wf)) {
      alert("依赖节点尚未完成，请先完成上游节点");
      return;
    }
    var step = { nodeType: nodeType, category: "global" };
    try {
      await engine._runGlobalStep(wf, step, function () {
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
      }, true);
      engine.save();
    } catch (err) {
      alert("生成失败：" + (err.message || err));
    } finally {
      if (window.WF_Renderer) window.WF_Renderer.render(engine);
    }
  }

  async function runSingleSegment(engine, nodeType, segIdx) {
    var wf = engine.current();
    if (!wf) return;
    if (engine.isNodeRunning && engine.isNodeRunning(nodeType, segIdx)) return;
    if (engine.canExecute && !engine.canExecute(nodeType, segIdx, wf)) {
      alert("依赖节点尚未完成，请先完成上游节点");
      return;
    }
    var step = { nodeType: nodeType, category: "segment" };
    try {
      await engine._runSegmentStep(wf, step, segIdx, function () {
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
      }, true);
      engine.save();
    } catch (err) {
      alert("生成失败：" + (err.message || err));
    } finally {
      if (window.WF_Renderer) window.WF_Renderer.render(engine);
    }
  }

  function bindRecreateEvents() {
    document.addEventListener("click", function (e) {
      var wfRoot = e.target.closest && e.target.closest("#workflow");
      if (!wfRoot) return;
      var engine = window._wfEngine;
      if (!engine) return;
      var wf = engine.current();
      if (!wf || wf.templateId !== "recreate-drama") return;

      // 触发全局节点生成
      var genGlobal = e.target.closest("[data-gen-global]");
      if (genGlobal) {
        var gtype = genGlobal.getAttribute("data-gen-global");
        if (gtype && gtype.indexOf("rc") === 0) {
          runSingleGlobal(engine, gtype);
          return;
        }
      }

      // 触发段落节点生成
      var genSeg = e.target.closest("[data-gen-seg]");
      if (genSeg) {
        var segIdx = parseInt(genSeg.getAttribute("data-gen-seg"));
        var stype = genSeg.getAttribute("data-gen-type");
        if (stype && stype.indexOf("rc") === 0) {
          runSingleSegment(engine, stype, segIdx);
          return;
        }
      }

      // 保存输入
      if (e.target.closest("#wf-rc-save-input")) {
        wf.input = wf.input || {};
        wf.input.plot = (document.getElementById("wf-rc-plot") || {}).value || "";
        wf.input.direction = (document.getElementById("wf-rc-direction") || {}).value || "";
        wf.input.style = (document.getElementById("wf-rc-style") || {}).value || "";
        if (wf.input.plot && (wf.title === "新工作流" || wf.title === "最强二创影视剧工作流")) {
          wf.title = wf.input.plot.replace(/[\n\r]/g, " ").slice(0, 20);
        }
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        return;
      }

      // 删除关键帧
      var delFrameBtn = e.target.closest("[data-del-rc-frame]");
      if (delFrameBtn) {
        var idx = parseInt(delFrameBtn.getAttribute("data-del-rc-frame"));
        var kfNode = (wf.rcKeyframess || [])[0];
        var kfV = kfNode && NR.getActiveVersion(kfNode);
        if (kfV && kfV.frames) {
          kfV.frames.splice(idx, 1);
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }

      // 添加人物
      if (e.target.closest("#wf-rc-add-char")) {
        var charNode = (wf.rcCharacterss || [])[0];
        if (!charNode) return;
        var charV = NR.getActiveVersion(charNode);
        if (!charV) {
          NR.addVersion(charNode, { characters: [] });
          charV = NR.getActiveVersion(charNode);
        }
        if (!charV.characters) charV.characters = [];
        charV.characters.push({ name: "新人物" + (charV.characters.length + 1), new_desc: "", visual_prompt: "", imageUrl: "" });
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        return;
      }

      // 删除人物
      var delCharBtn = e.target.closest("[data-del-rc-char]");
      if (delCharBtn) {
        var ci = parseInt(delCharBtn.getAttribute("data-del-rc-char"));
        var cNode = (wf.rcCharacterss || [])[0];
        var cV = cNode && NR.getActiveVersion(cNode);
        if (cV && cV.characters) {
          cV.characters.splice(ci, 1);
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }

      // 添加场景
      if (e.target.closest("#wf-rc-add-scene")) {
        var sNode = (wf.rcSceness || [])[0];
        if (!sNode) return;
        var sV = NR.getActiveVersion(sNode);
        if (!sV) {
          NR.addVersion(sNode, { scenes: [] });
          sV = NR.getActiveVersion(sNode);
        }
        if (!sV.scenes) sV.scenes = [];
        sV.scenes.push({ name: "新场景" + (sV.scenes.length + 1), new_desc: "", visual_prompt: "", imageUrl: "" });
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        return;
      }

      // 删除场景
      var delSceneBtn = e.target.closest("[data-del-rc-scene]");
      if (delSceneBtn) {
        var si = parseInt(delSceneBtn.getAttribute("data-del-rc-scene"));
        var scNode = (wf.rcSceness || [])[0];
        var scV = scNode && NR.getActiveVersion(scNode);
        if (scV && scV.scenes) {
          scV.scenes.splice(si, 1);
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }

      // 基于重编排结果创建 segments
      if (e.target.closest("#wf-rc-create-segments")) {
        var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
        if (prV && prV.segments && prV.segments.length) {
          if (engine.createSegments) {
            engine.createSegments(wf, prV.segments.map(function (s, i) {
              return { index: i, text: s.text || "", duration: 15, main_character_names: s.characters_in_scene || [], minor_characters: [], scenes: [] };
            }));
            engine.save();
            if (window.WF_Renderer) window.WF_Renderer.render(engine);
          }
        }
        return;
      }
    });

    // 文件上传（视频）
    document.addEventListener("change", async function (e) {
      if (!e.target.classList || !e.target.classList.contains("wf-file-input")) return;
      var rcUpload = e.target.getAttribute("data-rc-upload");
      if (rcUpload !== "video") return;
      if (!e.target.files || !e.target.files[0]) return;
      var file = e.target.files[0];
      var engine = window._wfEngine;
      var wf = engine && engine.current();
      if (!wf || wf.templateId !== "recreate-drama") return;

      var progEl = document.getElementById("wf-rc-upload-progress");
      var barEl = document.getElementById("wf-rc-upload-bar");
      var pctEl = document.getElementById("wf-rc-upload-percent");
      var lblEl = document.getElementById("wf-rc-upload-label");
      var detEl = document.getElementById("wf-rc-upload-detail");
      if (progEl) progEl.style.display = "block";
      if (lblEl) lblEl.textContent = "读取本地元数据...";
      if (detEl) detEl.textContent = file.name + " · " + _formatFileSize(file.size);

      // 本地读取视频时长和分辨率（瞬间出结果，无需等服务器）
      var localMeta = {};
      try {
        localMeta = await new Promise(function (resolve) {
          var v = document.createElement("video");
          v.preload = "metadata";
          v.onloadedmetadata = function () {
            resolve({
              duration: v.duration,
              width: v.videoWidth,
              height: v.videoHeight,
            });
            URL.revokeObjectURL(v.src);
          };
          v.onerror = function () { resolve({}); };
          v.src = URL.createObjectURL(file);
          setTimeout(function () { resolve({}); }, 3000);
        });
      } catch (e) {}

      if (lblEl) lblEl.textContent = "上传中...";
      var detailPrefix = file.name + " · " + _formatFileSize(file.size);
      if (localMeta.duration) detailPrefix += " · " + _formatDuration(localMeta.duration);
      if (localMeta.width && localMeta.height) detailPrefix += " · " + localMeta.width + "×" + localMeta.height;
      if (detEl) detEl.textContent = detailPrefix;

      try {
        var data = await uploadVideoFile(wf.id, file, function (loaded, total) {
          var pct = total > 0 ? Math.round(loaded * 100 / total) : 0;
          if (barEl) barEl.style.width = pct + "%";
          if (pctEl) pctEl.textContent = pct + "%";
          if (detEl) detEl.textContent = detailPrefix + " · " + _formatFileSize(loaded) + " / " + _formatFileSize(total);
        });
        if (lblEl) lblEl.textContent = "上传成功";
        if (barEl) barEl.style.width = "100%";
        if (pctEl) pctEl.textContent = "100%";

        wf.input = wf.input || {};
        wf.input.videoUrl = data.url;
        wf.input.videoFilename = file.name;
        wf.input.videoSize = file.size;
        // 优先使用后端 ffprobe 的元数据，缺失则用本地读取的
        wf.input.videoMetadata = Object.assign({}, localMeta, data.metadata || {});
        // 后端推荐的最大帧数（按视频时长自适应）
        if (data.recommended_max_frames) {
          wf.input.recommendedMaxFrames = data.recommended_max_frames;
          // 同步到关键帧节点的 maxFrames 字段（未手动改过时才覆盖）
          var kfNode = (wf.rcKeyframess || [])[0];
          if (kfNode && (!kfNode.maxFrames || kfNode.maxFrames === 30)) {
            kfNode.maxFrames = data.recommended_max_frames;
          }
        }
        engine.save();
        setTimeout(function () {
          if (progEl) progEl.style.display = "none";
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }, 600);
      } catch (err) {
        if (lblEl) { lblEl.textContent = "上传失败"; lblEl.style.color = "#ef4444"; }
        if (detEl) detEl.textContent = String(err.message || err);
        alert("上传失败: " + (err.message || err));
      }
    });
  }

  // 注册初始化钩子：当切换到 recreate 模板时触发
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRecreateModule);
  } else {
    initRecreateModule();
  }

})();



