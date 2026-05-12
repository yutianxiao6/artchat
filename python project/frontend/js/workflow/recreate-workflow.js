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

  // 全局并发：节点级 override 优先，否则读 wf.globalConcurrency，默认 3
  function getConcurrency(wf, nd) {
    var over = nd && nd.maxConcurrentOverride;
    if (over !== undefined && over !== null && over !== "") {
      var n = parseInt(over);
      if (!isNaN(n) && n > 0) return n;
    }
    var g = wf && wf.globalConcurrency;
    var gn = parseInt(g);
    return (!isNaN(gn) && gn > 0) ? gn : 3;
  }

  function getBatchSize(nd, def) {
    var n = nd && nd.batchSize;
    var bn = parseInt(n);
    return (!isNaN(bn) && bn > 0) ? bn : (def || 6);
  }

  function _getDisabledAttr(ctx, nodeType) {
    if (!ctx || !ctx.engine) return "";
    var segIdx = (ctx.segIndex !== undefined && ctx.segIndex !== null) ? ctx.segIndex : null;
    if (ctx.engine.isNodeRunning && ctx.engine.isNodeRunning(nodeType, segIdx)) return " disabled";
    if (ctx.engine.canExecute) {
      var wf = ctx.engine.current();
      if (wf && !ctx.engine.canExecute(nodeType, segIdx, wf)) return " disabled";
    }
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
      if (!v) return "";
      var kept = v.frames ? v.frames.length : 0;
      var rej = v.rejected ? v.rejected.length : 0;
      return "保留 " + kept + " / 过滤 " + rej;
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      if (!wf.input || !wf.input.videoUrl) throw new Error("请先在输入节点上传视频");
      var nd = ctx.nodeData;
      var body = { };
      // 高级参数（均可选）
      ["min_scene_threshold","long_shot_max_gap","sharpness_min","hamming_dedup_threshold","luma_lo","luma_hi","edge_density_min","max_candidates"].forEach(function(k){
        if (nd[k] !== undefined && nd[k] !== null && nd[k] !== "") body[k] = nd[k];
      });
      var data = await callApi("/api/recreate/extract-keyframes/" + wf.id, body);
      return data; // 直接保存后端返回结构（duration/fps/params/scene_cuts/frames/rejected/stats）
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcKeyframes");
      var advOpen = !!nd.showAdvanced;
      var params = (v && v.params) || {};
      var stats = (v && v.stats) || {};

      var html = "";
      // 统计与分组展示
      if (v && v.frames) {
        var frames = v.frames || [];
        var rej = v.rejected || [];
        var sceneCuts = v.scene_cuts || [];
        html += '<div class="wf-detail-section" style="background:rgba(6,182,212,.08);border:1px solid rgba(6,182,212,.25);border-radius:10px;padding:10px 12px;">'
          + '<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12px;">'
          + '<div><span style="color:#94a3b8;">场景切点</span>: <b>' + sceneCuts.length + '</b></div>'
          + '<div><span style="color:#94a3b8;">候选</span>: <b>' + (stats.candidates || frames.length + rej.length) + '</b></div>'
          + '<div><span style="color:#22c55e;">保留</span>: <b>' + frames.length + '</b></div>'
          + '<div><span style="color:#ef4444;">过滤</span>: <b>' + rej.length + '</b></div>'
          + (v.duration ? '<div><span style="color:#94a3b8;">时长</span>: <b>' + _formatDuration(v.duration) + '</b></div>' : '')
          + '</div></div>';

        // 按 scene_group 分组
        var groups = {};
        frames.forEach(function (f) {
          var g = f.scene_group;
          if (g === undefined || g === null) g = -1;
          if (!groups[g]) groups[g] = [];
          groups[g].push(f);
        });
        var groupKeys = Object.keys(groups).map(Number).sort(function(a,b){return a-b;});
        groupKeys.forEach(function (gk) {
          var list = groups[gk];
          var firstTs = (list[0] && list[0].timestamp) || 0;
          var lastTs = (list[list.length-1] && list[list.length-1].timestamp) || 0;
          html += '<div class="wf-detail-section"><div class="wf-detail-label">'
            + '场景组 ' + gk + ' · ' + list.length + ' 帧 · '
            + firstTs.toFixed(1) + 's-' + lastTs.toFixed(1) + 's</div>'
            + '<div class="wf-frames-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">';
          list.forEach(function (f) {
            var ts = f.timestamp || 0;
            var tsLabel = ts >= 60 ? Math.floor(ts/60) + ":" + String(Math.floor(ts%60)).padStart(2,"0") : ts.toFixed(1) + "s";
            var badge = f.is_supplement ? '<div style="position:absolute;top:2px;right:22px;background:rgba(245,158,11,.9);color:#fff;font-size:9px;padding:1px 4px;border-radius:3px;">补</div>' : '';
            var sharp = (f.sharpness !== undefined && f.sharpness >= 0) ? ('<div style="position:absolute;bottom:2px;left:2px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;padding:1px 4px;border-radius:3px;">' + f.sharpness.toFixed(0) + '</div>') : '';
            html += '<div style="position:relative;">'
              + '<img class="wf-preview-img" src="' + esc(f.url) + '" style="width:100%;border-radius:6px;">'
              + '<div style="position:absolute;top:2px;left:2px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;">#' + f.index + ' · ' + tsLabel + '</div>'
              + badge + sharp
              + '<button class="wf-ref-del-btn" data-del-rc-frame="' + f.index + '" style="position:absolute;top:2px;right:2px;"><i class="fa fa-times"></i></button>'
              + '</div>';
          });
          html += '</div></div>';
        });

        // 已过滤帧折叠
        if (rej.length) {
          var rejOpen = !!nd.showRejected;
          html += '<div class="wf-detail-section"><div class="wf-detail-label" style="cursor:pointer;user-select:none;" id="wf-rc-toggle-rejected">'
            + '<i class="fa fa-' + (rejOpen ? "chevron-down" : "chevron-right") + '"></i> 已过滤 (' + rej.length + ')</div>';
          if (rejOpen) {
            html += '<div class="wf-frames-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;opacity:.85;">';
            rej.forEach(function (f, i) {
              var ts = f.timestamp || 0;
              html += '<div style="position:relative;border:1px dashed rgba(239,68,68,.4);border-radius:6px;padding:2px;">'
                + '<img src="' + esc(f.url) + '" style="width:100%;border-radius:4px;filter:grayscale(30%);">'
                + '<div style="font-size:9px;color:#94a3b8;padding:2px 0;">'+ ts.toFixed(1) +'s · ' + esc(f.reason || "?") + '</div>'
                + '<button class="wf-tb-btn" data-restore-rc-frame="' + i + '" style="font-size:10px;padding:2px 6px;width:100%;">恢复</button>'
                + '</div>';
            });
            html += '</div>';
          }
          html += '</div>';
        }
      }

      // 高级参数折叠
      html += '<div class="wf-detail-section"><div class="wf-detail-label" style="cursor:pointer;user-select:none;" id="wf-rc-toggle-advanced">'
        + '<i class="fa fa-' + (advOpen ? "chevron-down" : "chevron-right") + '"></i> 高级参数</div>';
      if (advOpen) {
        html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
          + '<div><div style="font-size:11px;color:#94a3b8;">场景阈值</div><input class="wf-detail-input wf-editable" data-edit-field="min_scene_threshold" type="number" step="0.01" min="0.02" max="0.5" value="' + (nd.min_scene_threshold !== undefined ? nd.min_scene_threshold : (params.min_scene_threshold !== undefined ? params.min_scene_threshold : 0.10)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">长镜头补帧间隔(s)</div><input class="wf-detail-input wf-editable" data-edit-field="long_shot_max_gap" type="number" step="0.5" min="1" max="10" value="' + (nd.long_shot_max_gap !== undefined ? nd.long_shot_max_gap : (params.long_shot_max_gap !== undefined ? params.long_shot_max_gap : 4.0)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">清晰度下限</div><input class="wf-detail-input wf-editable" data-edit-field="sharpness_min" type="number" step="5" min="0" max="500" value="' + (nd.sharpness_min !== undefined ? nd.sharpness_min : (params.sharpness_min !== undefined ? params.sharpness_min : 80)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">pHash 汉明阈值</div><input class="wf-detail-input wf-editable" data-edit-field="hamming_dedup_threshold" type="number" step="1" min="0" max="32" value="' + (nd.hamming_dedup_threshold !== undefined ? nd.hamming_dedup_threshold : (params.hamming_dedup_threshold !== undefined ? params.hamming_dedup_threshold : 8)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">亮度下限</div><input class="wf-detail-input wf-editable" data-edit-field="luma_lo" type="number" step="1" min="0" max="128" value="' + (nd.luma_lo !== undefined ? nd.luma_lo : (params.luma_lo !== undefined ? params.luma_lo : 10)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">亮度上限</div><input class="wf-detail-input wf-editable" data-edit-field="luma_hi" type="number" step="1" min="128" max="255" value="' + (nd.luma_hi !== undefined ? nd.luma_hi : (params.luma_hi !== undefined ? params.luma_hi : 245)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">边缘密度下限</div><input class="wf-detail-input wf-editable" data-edit-field="edge_density_min" type="number" step="0.005" min="0" max="0.2" value="' + (nd.edge_density_min !== undefined ? nd.edge_density_min : (params.edge_density_min !== undefined ? params.edge_density_min : 0.02)) + '"></div>'
          + '<div><div style="font-size:11px;color:#94a3b8;">候选上限</div><input class="wf-detail-input wf-editable" data-edit-field="max_candidates" type="number" step="10" min="30" max="600" value="' + (nd.max_candidates !== undefined ? nd.max_candidates : (params.max_candidates !== undefined ? params.max_candidates : 300)) + '"></div>'
          + '</div>';
      }
      html += '</div>';

      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcKeyframes"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新提取" : "提取关键帧") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcFrameLabel（Round 1：视觉标注）─────────────────────────────
  NR.register({
    id: "rcFrameLabel", label: "帧标注", icon: "fa-tags", color: "#6366f1",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.frames ? v.frames.length + " 帧已标注" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var kfNode = (wf.rcKeyframess || [])[0];
      var kfV = NR.getActiveVersion(kfNode);
      if (!kfV || !kfV.frames || !kfV.frames.length) throw new Error("请先提取关键帧");
      var nd = ctx.nodeData;
      var data = await callApi("/api/recreate/generate/frame-label", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcFrameLabel"),
        frames: kfV.frames,
        plot: (wf.input && wf.input.plot) || "",
        batch_size: getBatchSize(nd, 6),
        max_concurrent: getConcurrency(wf, nd),
      });
      return { frames: data.frames || [], overview: data.overview || {} };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcFrameLabel");
      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var kfFrames = (kfV && kfV.frames) || [];
      var kfMap = {}; kfFrames.forEach(function (f) { kfMap[f.index] = f; });

      var gc = getConcurrency(wf, null);
      var hasOverride = nd.maxConcurrentOverride !== undefined && nd.maxConcurrentOverride !== null && nd.maxConcurrentOverride !== "";
      var html = '<div class="wf-detail-section" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">'
        + '<div style="font-size:11px;color:#94a3b8;">批大小</div>'
        + '<input class="wf-detail-input wf-editable" data-edit-field="batchSize" type="number" min="2" max="15" value="' + getBatchSize(nd, 6) + '" style="width:70px;">'
        + '<div style="font-size:11px;color:#94a3b8;margin-left:8px;">并发 = ' + gc + (hasOverride ? ' (本节点)' : ' (来自顶部)') + '</div>'
        + '<label style="font-size:11px;color:#94a3b8;cursor:pointer;"><input type="checkbox" data-rc-toggle-override' + (hasOverride ? ' checked' : '') + '> 本节点覆盖</label>'
        + (hasOverride ? '<input class="wf-detail-input wf-editable" data-edit-field="maxConcurrentOverride" type="number" min="1" max="10" value="' + nd.maxConcurrentOverride + '" style="width:60px;">' : '')
        + '</div>';

      if (v && v.overview) {
        var ov = v.overview;
        html += '<div class="wf-detail-section" style="background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.25);border-radius:10px;padding:10px 12px;">'
          + '<div class="wf-detail-label" style="color:#818cf8;">全局清单</div>';
        if (ov.narrative) html += '<div style="font-size:12px;margin-bottom:6px;">' + esc(ov.narrative) + '</div>';
        (ov.characters || []).forEach(function (c, ci) {
          html += '<div style="font-size:11px;margin-bottom:2px;"><b>' + esc(c.name || ("人物" + (ci+1))) + '</b>: ' + esc(c.features || "") + '</div>';
        });
        (ov.scenes || []).forEach(function (s, si) {
          html += '<div style="font-size:11px;color:#a5b4fc;margin-bottom:2px;"><b>' + esc(s.name || ("场景" + (si+1))) + '</b>: ' + esc(s.features || "") + '</div>';
        });
        html += '</div>';
      }

      if (v && v.frames && v.frames.length) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">逐帧标注（' + v.frames.length + '）</div>';
        v.frames.forEach(function (f, i) {
          var kf = kfMap[f.index];
          var thumb = kf ? '<img class="wf-preview-img" src="' + esc(kf.url) + '" style="width:72px;float:left;margin-right:8px;border-radius:4px;">' : "";
          var errBadge = f.error ? '<span style="color:#ef4444;font-size:10px;"> ⚠ ' + esc(f.error.slice(0, 60)) + '</span>' : '';
          var qualityColor = f.quality === 'clear' ? '#22c55e' : (f.quality === 'motion_blur' ? '#ef4444' : '#94a3b8');
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(148,163,184,.15);border-radius:8px;">'
            + thumb
            + '<div style="margin-left:' + (kf ? '80px' : '0') + ';">'
            + '<div style="font-size:11px;color:#94a3b8;">#' + f.index + ' @ ' + (f.timestamp || 0).toFixed(1) + 's · '
            + '<span style="color:#60a5fa;">' + esc(f.shot_type || "") + '</span> · '
            + '<span style="color:#a78bfa;">' + esc(f.transition_hint || "none") + '</span> · '
            + '<span style="color:' + qualityColor + ';">' + esc(f.quality || "?") + '</span>'
            + errBadge + '</div>'
            + '<div style="font-size:12px;color:#e2e8f0;margin-top:4px;">' + esc(f.content || "") + '</div>'
            + (f.subtitle ? '<div style="font-size:11px;color:#fbbf24;margin-top:2px;">字幕: ' + esc(f.subtitle) + '</div>' : '')
            + '</div><div style="clear:both;"></div></div>';
        });
        html += '</div>';
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">尚未标注</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcFrameLabel"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新标注" : "开始标注") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcScript（剧本演绎：合成完整剧本并分段）─────────────────────────
  NR.register({
    id: "rcScript", label: "剧本演绎", icon: "fa-file-text-o", color: "#0ea5e9",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.segments) return "";
      return v.segments.length + " 段 · " + ((v.full_script || "").length) + " 字";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var flV = NR.getActiveVersion((wf.rcFrameLabels || [])[0]);
      if (!flV || !flV.frames || !flV.frames.length) throw new Error("请先完成帧标注");
      var data = await callApi("/api/recreate/generate/script", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("chat", "rcScript"),
        plot: (wf.input && wf.input.plot) || "",
      });
      return { full_script: data.full_script || "", segments: data.segments || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcScript");
      var html = "";
      if (v && v.full_script) {
        html += '<div class="wf-detail-section">'
          + '<div class="wf-detail-label">完整剧本（共 ' + (v.full_script || "").length + ' 字）</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="full_script" rows="8">' + esc(v.full_script || "") + '</textarea>'
          + '</div>';
      }
      if (v && v.segments && v.segments.length) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">剧本分段（' + v.segments.length + '）</div>';
        v.segments.forEach(function (s, i) {
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(14,165,233,.25);border-radius:8px;">'
            + '<div style="font-size:11px;color:#94a3b8;">段 ' + s.index + ' ['
            + (s.start || 0).toFixed(1) + 's-' + (s.end || 0).toFixed(1) + 's] 帧 '
            + (s.frame_range || [0,0]).join('-') + '</div>'
            + '<div style="font-size:11px;color:#38bdf8;margin:2px 0;">主题: ' + esc(s.theme || "") + '</div>'
            + '<div style="font-size:11px;color:#94a3b8;">剧本文本</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.script_text" rows="3">' + esc(s.script_text || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">镜头语言</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.camera_notes" rows="2">' + esc(s.camera_notes || "") + '</textarea>'
            + '</div>';
        });
        html += '</div>';
      }
      if (!v) html += '<div class="wf-detail-text" style="color:#64748b;">点击生成将 " 帧标注 " 输出的批次笔记合成连贯剧本。</div>';
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcScript"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新生成" : "生成剧本") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcSmartSegment（Round 2：智能分段）─────────────────────────────
  NR.register({
    id: "rcSmartSegment", label: "智能分段", icon: "fa-columns", color: "#14b8a6",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.segments ? v.segments.length + " 段" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var scV = NR.getActiveVersion((wf.rcScripts || [])[0]);
      if (!scV || !scV.segments || !scV.segments.length) throw new Error("请先完成剧本演绎");
      var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
      if (!prV || !prV.segments || !prV.segments.length) throw new Error("请先完成剧情重编排");
      var nd = ctx.nodeData;
      var data = await callApi("/api/recreate/generate/smart-segment", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcSmartSegment"),
        script_segments: scV.segments,
        rewrite_segments: prV.segments,
        max_seg_sec: parseFloat(nd.maxSegSec) || 10.0,
        min_seg_sec: parseFloat(nd.minSegSec) || 3.0,
      });
      var outSegs = data.segments || [];
      // 自动按智能分段建立段节点（title 用智能分段 theme），并带入改编剧本文本
      if (outSegs.length && ctx.engine && ctx.engine.createSegments) {
        var segmentData = outSegs.map(function (s, i) {
          var rw = (prV.segments || [])[i] || {};
          return {
            index: i,
            text: s.theme || (rw.script || rw.text || "").slice(0, 25),
            duration: Math.round(s.seconds || s.duration || (s.end - s.start) || 15),
            main_character_names: s.characters_in_scene || [],
            minor_characters: [],
            scenes: [],
          };
        });
        ctx.engine.createSegments(wf, segmentData);
      }
      return { segments: outSegs, constraints: data.constraints || {} };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcSmartSegment");
      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var kfMap = {}; ((kfV && kfV.frames) || []).forEach(function (f) { kfMap[f.index] = f; });
      var maxSec = parseFloat(nd.maxSegSec) || 10.0;
      var minSec = parseFloat(nd.minSegSec) || 3.0;

      var html = '<div class="wf-detail-section" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">'
        + '<div style="font-size:11px;color:#94a3b8;">视频段时长范围(s)</div>'
        + '<input class="wf-detail-input wf-editable" data-edit-field="minSegSec" type="number" min="2" max="10" step="0.5" value="' + minSec + '" style="width:70px;">'
        + '<span style="color:#64748b;">~</span>'
        + '<input class="wf-detail-input wf-editable" data-edit-field="maxSegSec" type="number" min="5" max="30" step="0.5" value="' + maxSec + '" style="width:70px;">'
        + '</div>';

      if (v && v.segments && v.segments.length) {
        var totalVideoSec = v.segments.reduce(function (a, s) { return a + ((s.end || 0) - (s.start || 0)); }, 0);
        var totalNewSec = v.segments.reduce(function (a, s) { return a + (parseFloat(s.seconds) || (s.end - s.start)); }, 0);
        html += '<div class="wf-detail-section"><div class="wf-detail-label">共 ' + v.segments.length + ' 段 · 视频 ' + totalVideoSec.toFixed(1) + 's · 新剧情 ' + totalNewSec.toFixed(1) + 's</div>';
        v.segments.forEach(function (s, i) {
          var videoDur = (s.duration !== undefined) ? s.duration : (s.end - s.start);
          var newSec = parseFloat(s.seconds) || videoDur;
          var overLimit = videoDur > maxSec + 0.01;
          var thumbs = (s.frame_indices || []).slice(0, 4).map(function (fi) {
            var kf = kfMap[fi];
            return kf ? '<img src="' + esc(kf.url) + '" style="width:56px;height:36px;object-fit:cover;border-radius:3px;margin-right:3px;">' : '';
          }).join("");
          var tIn = (s.transitions || {}).in || "none";
          var tOut = (s.transitions || {}).out || "none";
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid ' + (overLimit ? 'rgba(239,68,68,.5)' : 'rgba(20,184,166,.25)') + ';border-radius:8px;">'
            + '<div style="font-size:11px;color:#94a3b8;">段 ' + s.index + ' 视频 [' + s.start.toFixed(1) + 's-' + s.end.toFixed(1) + 's] 视频段长 ' + videoDur.toFixed(1) + 's · '
            + '<span style="color:#22c55e;">新剧情 ' + newSec.toFixed(1) + 's</span> · '
            + '<span style="color:#60a5fa;">in=' + esc(tIn) + '</span> · <span style="color:#a78bfa;">out=' + esc(tOut) + '</span> · 帧 ' + (s.frame_indices || []).length + '</div>'
            + '<div style="font-size:12px;color:#e2e8f0;margin:4px 0;"><b>' + esc(s.theme || "") + '</b></div>'
            + '<div style="margin:4px 0;">' + thumbs + '</div>'
            + '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">尚未分段</div>';
      }
      html += '<div class="wf-detail-actions">'
        + '<button class="wf-tb-btn primary" data-gen-global="rcSmartSegment"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新分段" : "开始分段") + '</button>';
      if (v && v.segments && v.segments.length) {
        html += ' <button class="wf-tb-btn" id="wf-rc-create-segments-from-smart" style="margin-left:6px;"><i class="fa fa-sitemap"></i> 建立段节点</button>';
      }
      html += '</div>';
      return html;
    },
  });

  // ── Node: rcRepFrames（Round 3：段内选代表帧）─────────────────────────────
  NR.register({
    id: "rcRepFrames", label: "代表帧", icon: "fa-star", color: "#f97316",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.segments) return "";
      var total = v.segments.reduce(function (a, s) { return a + (s.picked_indices ? s.picked_indices.length : 0); }, 0);
      return total + " 帧 / " + v.segments.length + " 段";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var ssV = NR.getActiveVersion((wf.rcSmartSegments || [])[0]);
      if (!ssV || !ssV.segments || !ssV.segments.length) throw new Error("请先完成智能分段");
      var flV = NR.getActiveVersion((wf.rcFrameLabels || [])[0]);
      if (!flV || !flV.frames || !flV.frames.length) throw new Error("请先完成帧标注");
      var nd = ctx.nodeData;
      var data = await callApi("/api/recreate/generate/select-representative-frames", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcRepFrames"),
        segments: ssV.segments,
        frame_labels: flV.frames,
        max_concurrent: getConcurrency(wf, nd),
      });
      return { segments: data.segments || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcRepFrames");
      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var kfMap = {}; ((kfV && kfV.frames) || []).forEach(function (f) { kfMap[f.index] = f; });
      var ssV = NR.getActiveVersion((wf.rcSmartSegments || [])[0]);
      var segs = (ssV && ssV.segments) || [];

      var gc = getConcurrency(wf, null);
      var hasOverride = nd.maxConcurrentOverride !== undefined && nd.maxConcurrentOverride !== null && nd.maxConcurrentOverride !== "";
      var html = '<div class="wf-detail-section" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">'
        + '<div style="font-size:11px;color:#94a3b8;">并发 = ' + gc + (hasOverride ? ' (本节点)' : ' (来自顶部)') + '</div>'
        + '<label style="font-size:11px;color:#94a3b8;cursor:pointer;"><input type="checkbox" data-rc-toggle-override' + (hasOverride ? ' checked' : '') + '> 本节点覆盖</label>'
        + (hasOverride ? '<input class="wf-detail-input wf-editable" data-edit-field="maxConcurrentOverride" type="number" min="1" max="10" value="' + nd.maxConcurrentOverride + '" style="width:60px;">' : '')
        + '</div>';

      if (v && v.segments && v.segments.length) {
        v.segments.forEach(function (rs) {
          var seg = segs.find(function (s) { return s.index === rs.index; }) || {};
          var pickedSet = {}; (rs.picked_indices || []).forEach(function (i) { pickedSet[i] = true; });
          var candIdxs = seg.frame_indices || rs.picked_indices || [];
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(249,115,22,.25);border-radius:8px;">'
            + '<div class="wf-detail-label" style="color:#fb923c;">段 ' + rs.index + ' · 目标 ' + rs.target_count + ' 帧 · 选中 ' + (rs.picked_indices || []).length + ' / ' + candIdxs.length + '</div>'
            + (rs.reason ? '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">' + esc(rs.reason) + '</div>' : '')
            + '<div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;">';
          candIdxs.forEach(function (fi) {
            var kf = kfMap[fi];
            if (!kf) return;
            var picked = pickedSet[fi];
            html += '<div style="position:relative;' + (picked ? '' : 'opacity:.35;filter:grayscale(60%);') + '">'
              + '<img src="' + esc(kf.url) + '" style="width:100%;border-radius:4px;' + (picked ? 'box-shadow:0 0 0 2px #f97316;' : '') + '">'
              + '<div style="position:absolute;bottom:1px;left:1px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;padding:1px 3px;border-radius:2px;">#' + fi + '</div>'
              + '</div>';
          });
          html += '</div></div>';
        });
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">尚未选择代表帧</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcRepFrames"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新选择" : "开始选择") + '</button></div>';
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
      if (!wf.input || !wf.input.plot) throw new Error("请先填写原始剧情");
      var scV = NR.getActiveVersion((wf.rcScripts || [])[0]);
      if (!scV || !scV.full_script) throw new Error("请先完成剧本演绎");
      var data = await callApi("/api/recreate/generate/rewrite-plot", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("chat", "rcPlotRewrite"),
        original_plot: wf.input.plot,
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
        var totalSec = v.segments.reduce(function (a, s) { return a + (parseFloat(s.seconds) || 0); }, 0);
        if (totalSec > 0) {
          html += '<div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">新剧情建议总时长 ' + totalSec.toFixed(1) + 's · 共 ' + v.segments.length + ' 段</div>';
        }
        v.segments.forEach(function (s, i) {
          var sceneAction = s.scene_action || "keep";
          var scriptText = s.script || s.text || "";
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(59,130,246,.25);border-radius:8px;">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
            + '<div class="wf-detail-label" style="flex:1;">第 ' + (i + 1) + ' 段</div>'
            + '<div style="font-size:11px;color:#94a3b8;">时长(s)</div>'
            + '<input class="wf-detail-input wf-editable" data-edit-field="segments.' + i + '.seconds" type="number" min="1" max="60" step="0.5" value="' + (parseFloat(s.seconds) || 0) + '" style="width:70px;">'
            + '</div>'
            + '<div style="font-size:11px;color:#60a5fa;">新剧情（含动作/场景/情绪/运镜过渡）</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.script" rows="5" placeholder="详细剧本，包含场景与运镜过渡安排">' + esc(scriptText) + '</textarea>'
            + '<div style="font-size:11px;color:#fbbf24;margin-top:6px;">台词 / 旁白 / 画外音</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="segments.' + i + '.dialogue" rows="3" placeholder="按出场顺序，标注说话人与情绪">' + esc(s.dialogue || "") + '</textarea>'
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

      // 对话修改区（仅当已有剧本后显示）
      if (v && v.segments && v.segments.length) {
        var history = nd.chatHistory || [];
        var histHtml = history.map(function (m) {
          var isUser = m.role === "user";
          return '<div style="display:flex;justify-content:' + (isUser ? 'flex-end' : 'flex-start') + ';margin:4px 0;">'
            + '<div style="max-width:85%;padding:6px 10px;border-radius:8px;font-size:12px;line-height:1.4;'
            + (isUser ? 'background:rgba(59,130,246,.2);color:#dbeafe;' : 'background:rgba(148,163,184,.12);color:#e2e8f0;')
            + '">' + esc(m.content || "") + '</div></div>';
        }).join("");
        html += '<div class="wf-detail-section" style="margin-top:12px;padding:8px;border:1px solid rgba(59,130,246,.2);border-radius:8px;">'
          + '<div class="wf-detail-label" style="color:#60a5fa;"><i class="fa fa-comments"></i> 对话修改</div>'
          + (history.length ? '<div style="max-height:280px;overflow-y:auto;padding:4px 0;">' + histHtml + '</div>' : '<div style="font-size:11px;color:#64748b;margin-bottom:6px;">对剧本提出修改意见，例如：第 3 段不够紧张，请加强冲突 / 增加两段铺垫 / 把方向改为悬疑</div>')
          + '<textarea class="wf-detail-textarea" id="wf-rc-rewrite-chat-input" rows="3" placeholder="输入修改意见，回车发送（Shift+Enter 换行）" style="margin-top:6px;"></textarea>'
          + '<div style="display:flex;gap:6px;margin-top:6px;">'
          + '<button class="wf-tb-btn primary" data-rc-rewrite-chat-send' + dis + '><i class="fa fa-paper-plane"></i> 发送修改</button>'
          + (history.length ? '<button class="wf-tb-btn" data-rc-rewrite-chat-clear title="清空对话历史"><i class="fa fa-trash-o"></i> 清空历史</button>' : '')
          + '</div>'
          + '</div>';
      }
      return html;
    },
  });

  // ── Node: rcPlanCharScenes（自动挑帧提取人物清单 + 各段场景，供后续节点消费）─────
  NR.register({
    id: "rcPlanCharScenes", label: "人物场景规划", icon: "fa-sitemap", color: "#d946ef",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v) return "";
      var nc = (v.characters || []).length;
      var ns = (v.scenes || []).length;
      return nc + " 人 · " + ns + " 场";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var rfV = NR.getActiveVersion((wf.rcRepFramess || [])[0]);
      if (!rfV || !rfV.segments || !rfV.segments.length) throw new Error("请先完成代表帧选择");
      var data = await callApi("/api/recreate/generate/plan-char-scenes", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcPlanCharScenes"),
      });
      return { characters: data.characters || [], scenes: data.scenes || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcPlanCharScenes");
      var html = "";
      if (v && v.characters && v.characters.length) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">主要人物（' + v.characters.length + '）</div>'
          + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">';
        v.characters.forEach(function (c, ci) {
          if (!c) return;
          var confColor = c.confidence === "high" ? "#22c55e" : (c.confidence === "low" ? "#ef4444" : "#f59e0b");
          html += '<div style="padding:6px;border:1px solid rgba(217,70,239,.2);border-radius:6px;">'
            + (c.ref_frame_url ? '<img class="wf-preview-img" src="' + esc(c.ref_frame_url) + '" style="width:100%;height:80px;object-fit:cover;border-radius:4px;">' : '')
            + '<div style="font-size:12px;margin-top:4px;"><b>' + esc(c.name || "") + '</b>'
            + (c.confidence ? ' <span style="font-size:10px;color:' + confColor + ';">[' + esc(c.confidence) + ']</span>' : '')
            + '</div>'
            + '<div style="font-size:11px;color:#94a3b8;line-height:1.3;">' + esc((c.features || "").slice(0, 60)) + '</div>'
            + '</div>';
        });
        html += '</div></div>';
      }
      if (v && v.scenes && v.scenes.length) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">各段场景（' + v.scenes.length + '）</div>'
          + '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">';
        v.scenes.forEach(function (s, si) {
          if (!s) return;
          html += '<div style="padding:6px;border:1px solid rgba(16,185,129,.2);border-radius:6px;">'
            + '<div style="font-size:11px;color:#64748b;">段 ' + s.segment_index + '</div>'
            + (s.ref_frame_url ? '<img class="wf-preview-img" src="' + esc(s.ref_frame_url) + '" style="width:100%;height:60px;object-fit:cover;border-radius:4px;">' : '')
            + '<div style="font-size:12px;margin-top:4px;"><b>' + esc(s.name || "") + '</b></div>'
            + '<div style="font-size:11px;color:#94a3b8;line-height:1.3;">' + esc((s.features || "").slice(0, 50)) + '</div>'
            + '</div>';
        });
        html += '</div></div>';
      }
      if (!v) html += '<div class="wf-detail-text" style="color:#64748b;">点击规划将从所有段代表帧中自动识别主要人物和每段的主场景。</div>';
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="rcPlanCharScenes"' + dis + '><i class="fa fa-magic"></i> ' + (v ? "重新规划" : "自动规划") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcCharacters（全局，纯生图，消费 Plan 数据）─────────
  NR.register({
    id: "rcCharacters", label: "人物生图", icon: "fa-users", color: "#f59e0b",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.characters || !v.characters.length) return "";
      var done = v.characters.filter(function (c) { return !!(c && c.imageUrl); }).length;
      return done + " / " + v.characters.length + " 已生图";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var chars = (v && v.characters) || [];
      // 若节点未初始化，从 rcPlanCharScenes 拉取
      if (!chars.length) {
        var planV = NR.getActiveVersion((wf.rcPlanCharSceness || [])[0]);
        chars = (planV && planV.characters) ? planV.characters.map(function (c) { return Object.assign({}, c); }) : [];
      }
      if (!chars.length) throw new Error("请先运行人物场景规划");
      var data = await callApi("/api/recreate/generate/redesign-characters", {
        workflow_id: wf.id,
        action: "generate",
        image_config_id: getConfigId("image", "rcCharacters"),
        characters: chars,
        style: (wf.input && wf.input.style) || "",
        force: !!nd._forceRegen,
        target_names: nd._targetNames || null,
      });
      delete nd._forceRegen;
      delete nd._targetNames;
      return { characters: data.characters || chars };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcCharacters");
      var chars = (v && v.characters) || [];
      // 未初始化时，从 Plan 节点拉数据并**主动写入节点**（持久化，避免关闭再打开丢失）
      if (!chars.length) {
        var planV = NR.getActiveVersion((wf.rcPlanCharSceness || [])[0]);
        if (planV && planV.characters && planV.characters.length) {
          chars = planV.characters.map(function (c) { return Object.assign({}, c); });
          NR.addVersion(nd, { characters: chars });
          if (ctx.engine) ctx.engine.save();
        }
      }
      var html = "";
      if (!chars.length) {
        html += '<div class="wf-detail-text" style="color:#64748b;">请先在"人物场景规划"节点自动识别人物。</div>';
      } else {
        chars.forEach(function (c, ci) {
          if (!c) return;
          var hasNew = !!c.imageUrl;
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(245,158,11,.2);border-radius:8px;">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">'
            + '<input class="wf-detail-input wf-editable" data-edit-field="characters.' + ci + '.name" value="' + esc(c.name || "") + '" style="flex:1;">'
            + '<button class="wf-char-del-btn" data-del-rc-char="' + ci + '" title="删除" style="background:transparent;border:none;color:#ef4444;cursor:pointer;"><i class="fa fa-trash-o"></i></button>'
            + '</div>'
            + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px;">'
            + '<div><div style="font-size:11px;color:#94a3b8;">原始截图</div>'
            + (c.ref_frame_url ? '<img class="wf-preview-img" src="' + esc(c.ref_frame_url) + '" style="width:100%;border-radius:4px;">' : '<div style="font-size:11px;color:#64748b;padding:8px;">（无）</div>')
            + '</div>'
            + '<div><div style="font-size:11px;color:' + (hasNew ? '#22c55e' : '#94a3b8') + ';">新形象</div>'
            + (hasNew ? '<img class="wf-preview-img" src="' + esc(c.imageUrl) + '" style="width:100%;border-radius:4px;">' : '<div style="font-size:11px;color:#64748b;padding:8px;">尚未生成</div>')
            + '</div></div>'
            + '<div style="font-size:11px;color:#94a3b8;">新形象描述（留空则按特征直接生成）</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="characters.' + ci + '.new_desc" rows="2">' + esc(c.new_desc || "") + '</textarea>'
            + '<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">'
            + '<button class="wf-tb-btn" data-regen-rc-char="' + ci + '" style="font-size:11px;">'
            + '<i class="fa fa-magic"></i> ' + (hasNew ? "重新生成" : "生成此角色图") + '</button>'
            + '<label class="wf-tb-btn" style="font-size:11px;cursor:pointer;"><i class="fa fa-upload"></i> 上传替换'
            + '<input type="file" accept="image/*" data-upload-rc-char="' + ci + '" style="display:none;"></label>'
            + '</div>'
            + '</div>';
        });
      }
      html += '<div class="wf-detail-actions">'
        + '<button class="wf-tb-btn primary" data-rc-char-generate' + dis + '><i class="fa fa-paint-brush"></i> ' + (chars.some(function(c){return c && c.imageUrl;}) ? "生成未完成" : "生成全部") + '</button>';
      if (chars.length) {
        html += ' <button class="wf-tb-btn" data-rc-char-regen-all' + dis + ' title="强制全部重新生成"><i class="fa fa-refresh"></i> 全部重生成</button>';
      }
      html += '</div>';
      return html;
    },
  });

  // ── Node: rcScenes（段级，纯生图，消费 Plan 数据）─────────
  NR.register({
    id: "rcScenes", label: "场景生图", icon: "fa-image", color: "#10b981",
    category: "segment", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.scene) return "";
      return (v.scene.name || "") + (v.scene.imageUrl ? " · 已生图" : "");
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var nd = ctx.nodeData;
      var segIdx = ctx.segIndex;
      var v = NR.getActiveVersion(nd);
      var scene = (v && v.scene) || null;
      if (!scene) {
        // 从 rcPlanCharScenes 取本段场景
        var planV = NR.getActiveVersion((wf.rcPlanCharSceness || [])[0]);
        var planScenes = (planV && planV.scenes) || [];
        var match = planScenes.find(function (s) { return s.segment_index === segIdx; });
        if (match) scene = Object.assign({}, match);
      }
      if (!scene) throw new Error("请先运行人物场景规划");
      var data = await callApi("/api/recreate/generate/redesign-scenes", {
        workflow_id: wf.id,
        action: "generate",
        segment_index: segIdx,
        image_config_id: getConfigId("image", "rcScenes"),
        scene: scene,
        style: (wf.input && wf.input.style) || "",
        force: !!nd._forceRegen,
      });
      delete nd._forceRegen;
      return { scene: data.scene || scene };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcScenes");
      var s = v && v.scene;
      // 未初始化时，从 Plan 拉数据并**主动写入段节点**（持久化）
      if (!s) {
        var planV = NR.getActiveVersion((wf.rcPlanCharSceness || [])[0]);
        var planScenes = (planV && planV.scenes) || [];
        var match = planScenes.find(function (x) { return x.segment_index === ctx.segIndex; });
        if (match) {
          s = Object.assign({}, match);
          NR.addVersion(nd, { scene: s });
          if (ctx.engine) ctx.engine.save();
        }
      }
      var html = "";
      if (!s) {
        html += '<div class="wf-detail-text" style="color:#64748b;">请先在"人物场景规划"节点自动识别场景。</div>';
      } else {
        var hasNew = !!s.imageUrl;
        html += '<div class="wf-detail-section">'
          + '<div style="font-size:11px;color:#94a3b8;">场景名</div>'
          + '<input class="wf-detail-input wf-editable" data-edit-field="scene.name" value="' + esc(s.name || "") + '">'
          + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">'
          + '<div><div style="font-size:11px;color:#94a3b8;">原始场景</div>'
          + (s.ref_frame_url ? '<img class="wf-preview-img" src="' + esc(s.ref_frame_url) + '" style="width:100%;border-radius:4px;">' : '<div style="font-size:11px;color:#64748b;">（无）</div>')
          + '</div>'
          + '<div><div style="font-size:11px;color:' + (hasNew ? '#22c55e' : '#94a3b8') + ';">新场景</div>'
          + (hasNew ? '<img class="wf-preview-img" src="' + esc(s.imageUrl) + '" style="width:100%;border-radius:4px;">' : '<div style="font-size:11px;color:#64748b;">尚未生成</div>')
          + '</div></div>'
          + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">新场景描述（留空则按特征直接生成）</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="scene.new_desc" rows="2">' + esc(s.new_desc || "") + '</textarea>'
          + '<div style="margin-top:6px;"><label class="wf-tb-btn" style="font-size:11px;cursor:pointer;"><i class="fa fa-upload"></i> 上传替换'
          + '<input type="file" accept="image/*" data-upload-rc-scene="' + ctx.segIndex + '" style="display:none;"></label></div>'
          + '</div>';
      }
      html += '<div class="wf-detail-actions">'
        + '<button class="wf-tb-btn primary" data-rc-scene-generate="' + ctx.segIndex + '"' + dis + '><i class="fa fa-paint-brush"></i> ' + (s && s.imageUrl ? "重生成场景" : "生成场景") + '</button>';
      html += '</div>';
      return html;
    },
  });

  // ── Node: rcStoryboard（段级，终点，多分镜提示词）─────────
  NR.register({
    id: "rcStoryboard", label: "分镜提示词", icon: "fa-film", color: "#ec4899",
    category: "segment", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.shots || !v.shots.length) return "";
      return v.shots.length + " 条分镜";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var segIdx = ctx.segIndex;
      var seg = ctx.segment || (wf.segments || [])[segIdx];
      if (!seg) throw new Error("未找到段落");

      var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
      var segData = (prV && prV.segments && prV.segments[segIdx]) || { text: "", scene_action: "keep" };

      var charsV = NR.getActiveVersion((wf.rcCharacterss || [])[0]);
      var characters = (charsV && charsV.characters) || [];
      var sceneV = NR.getActiveVersion((seg.rcSceness || [])[0]);
      var scene = (sceneV && sceneV.scene) || null;

      var data = await callApi("/api/recreate/generate/rc-storyboard", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcStoryboard"),
        segment_index: segIdx,
        segment: segData,
        direction: (wf.input && wf.input.direction) || "",
        style: (wf.input && wf.input.style) || "",
        characters: characters,
        scene: scene,
      });
      return { shots: data.shots || [] };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcStoryboard");
      var shots = (v && v.shots) || [];
      var html = "";
      if (!shots.length) {
        html += '<div class="wf-detail-text" style="color:#64748b;">尚未生成分镜提示词</div>';
      } else {
        shots.forEach(function (sh, si) {
          html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(236,72,153,.25);border-radius:8px;">'
            + '<div style="font-size:11px;color:#f472b6;margin-bottom:4px;">分镜 ' + (si + 1) + ' · idx=' + sh.ref_frame_index + '</div>'
            + (sh.ref_frame_url ? '<img class="wf-preview-img" src="' + esc(sh.ref_frame_url) + '" style="width:100%;max-height:160px;object-fit:cover;border-radius:6px;margin-bottom:6px;">' : '')
            + '<div style="font-size:11px;color:#94a3b8;">English Prompt</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="shots.' + si + '.prompt_en" rows="4">' + esc(sh.prompt_en || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">中文提示词</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="shots.' + si + '.prompt_cn" rows="3">' + esc(sh.prompt_cn || "") + '</textarea>'
            + '<div style="font-size:11px;color:#94a3b8;margin-top:4px;">构图说明</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="shots.' + si + '.composition_notes" rows="2">' + esc(sh.composition_notes || "") + '</textarea>'
            + '</div>';
        });
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="rcStoryboard"' + dis + '><i class="fa fa-refresh"></i> ' + (shots.length ? "重新生成" : "生成分镜提示词") + '</button></div>';
      return html;
    },
  });

  // ── Node: rcVideoPrompt（段级，终点：视频生成提示词）─────────
  NR.register({
    id: "rcVideoPrompt", label: "视频提示词", icon: "fa-video-camera", color: "#f43f5e",
    category: "segment", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.full_text) return "";
      return (v.full_text || "").slice(0, 40);
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var segIdx = ctx.segIndex;
      var seg = ctx.segment || (wf.segments || [])[segIdx];
      if (!seg) throw new Error("未找到段落");

      // 本段分镜提示词
      var sbV = NR.getActiveVersion((seg.rcStoryboards || [])[0]);
      var shots = (sbV && sbV.shots) || [];

      // 段剧本（优先从 rcPlotRewrite；兜底 rcScript）
      var prV = NR.getActiveVersion((wf.rcPlotRewrites || [])[0]);
      var prSeg = (prV && prV.segments && prV.segments[segIdx]) || {};
      var ssV = NR.getActiveVersion((wf.rcSmartSegments || [])[0]);
      var ssSeg = (ssV && ssV.segments && ssV.segments[segIdx]) || {};
      // 组合段数据：优先用 rcPlotRewrite 的 text，配 rcSmartSegment 的 duration/camera_notes
      var segData = {
        index: segIdx,
        text: prSeg.text || ssSeg.theme || "",
        script_text: prSeg.text || ssSeg.theme || "",
        theme: ssSeg.theme || prSeg.scene_note || "",
        start: ssSeg.start || 0,
        end: ssSeg.end || 0,
        duration: ssSeg.duration || (ssSeg.end - ssSeg.start) || 15,
        camera_notes: ssSeg.camera_notes || "",
      };

      // 全片人物
      var charsV = NR.getActiveVersion((wf.rcCharacterss || [])[0]);
      var characters = (charsV && charsV.characters) || [];

      // 本段场景
      var sceneV = NR.getActiveVersion((seg.rcSceness || [])[0]);
      var scene = (sceneV && sceneV.scene) || null;

      var total_segments = (wf.segments || []).length;

      var data = await callApi("/api/recreate/generate/rc-video-prompt", {
        workflow_id: wf.id,
        chat_config_id: getConfigId("vision", "rcVideoPrompt"),
        segment_index: segIdx,
        segment: segData,
        shots: shots,
        characters: characters,
        scene: scene,
        duration: segData.duration,
        style: (wf.input && wf.input.style) || "",
        type: "二创短视频",
        direction: (wf.input && wf.input.direction) || "",
        total_segments: total_segments,
      });
      return { full_text: data.full_text || "" };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "rcVideoPrompt");
      var html = "";
      if (v && v.full_text) {
        html += '<div class="wf-detail-section" style="padding:8px;border:1px solid rgba(244,63,94,.25);border-radius:8px;">'
          + '<div class="wf-detail-label" style="color:#fb7185;">视频生成提示词（共 ' + (v.full_text || "").length + ' 字）</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="full_text" rows="16" style="font-family:monospace;font-size:12px;">' + esc(v.full_text || "") + '</textarea>'
          + '</div>';
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">综合段剧本、分镜提示词、人物、场景生成最终视频提示词。</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="rcVideoPrompt"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新生成" : "生成视频提示词") + '</button></div>';
      return html;
    },
  });

  // ── Pipeline Definition ─────────────────────────────
  var RECREATE_PIPELINE = {
    id: "recreate",
    title: "最强二创影视剧工作流",
    pipeline: [
      { nodeType: "rcInput",           category: "global" },
      { nodeType: "rcKeyframes",       category: "global" },
      { nodeType: "rcFrameLabel",      category: "global" },
      { nodeType: "rcScript",          category: "global" },
      { nodeType: "rcPlotRewrite",     category: "global" },
      { nodeType: "rcSmartSegment",    category: "global" },
      { nodeType: "rcRepFrames",       category: "global" },
      { nodeType: "rcPlanCharScenes",  category: "global" },
      { nodeType: "rcCharacters",      category: "global" },
      { nodeType: "rcScenes",          category: "segment" },
      { nodeType: "rcStoryboard",      category: "segment" },
      { nodeType: "rcVideoPrompt",     category: "segment" },
    ],
    topbarHtml: function (engine, wf) {
      var g = (wf && wf.globalConcurrency) || 3;
      var warn = g > 6
        ? '<span style="color:#f59e0b;font-size:11px;margin-left:6px;"><i class="fa fa-exclamation-triangle"></i> 过高可能触发 API 限流</span>'
        : '';
      return '<div class="wf-rc-topbar" style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.15);border-radius:10px;margin-bottom:8px;">'
        + '<div style="font-size:12px;color:#94a3b8;"><i class="fa fa-tachometer"></i> 全局并发</div>'
        + '<input id="wf-rc-global-concurrency" type="number" min="1" max="10" value="' + g + '" style="width:64px;padding:4px 8px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.25);border-radius:6px;color:#e2e8f0;">'
        + '<div style="font-size:11px;color:#64748b;">所有 LLM 步骤共享该值（节点面板可单独覆盖）</div>'
        + warn
        + '</div>';
    },
  };

  // ── Template Registration ─────────────────────────────
  if (!window.WF_Templates) window.WF_Templates = [];
  window.WF_Templates.push({
    id: "recreate-drama",
    name: "最强二创影视剧工作流",
    icon: "fa-recycle",
    description: "上传视频+剧情，关键帧提取→帧标注→智能分段→代表帧→剧情重编排→人物/场景重设计→生成二创作品",
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
        var delIdx = parseInt(delFrameBtn.getAttribute("data-del-rc-frame"));
        var kfNode = (wf.rcKeyframess || [])[0];
        var kfV = kfNode && NR.getActiveVersion(kfNode);
        if (kfV && kfV.frames) {
          var pos = kfV.frames.findIndex(function (f) { return f.index === delIdx; });
          if (pos >= 0) {
            kfV.frames.splice(pos, 1);
            engine.save();
            if (window.WF_Renderer) window.WF_Renderer.render(engine);
          }
        }
        return;
      }

      // 恢复被过滤帧
      var restoreBtn = e.target.closest("[data-restore-rc-frame]");
      if (restoreBtn) {
        var ri = parseInt(restoreBtn.getAttribute("data-restore-rc-frame"));
        var kfNode2 = (wf.rcKeyframess || [])[0];
        var kfV2 = kfNode2 && NR.getActiveVersion(kfNode2);
        if (kfV2 && kfV2.rejected && kfV2.rejected[ri]) {
          var item = kfV2.rejected.splice(ri, 1)[0];
          kfV2.frames = kfV2.frames || [];
          // 恢复时赋予一个新 index（避免与保留帧 index 冲突）
          var maxIdx = kfV2.frames.reduce(function (m, f) { return Math.max(m, f.index); }, -1);
          item.index = maxIdx + 1;
          delete item.reason;
          kfV2.frames.push(item);
          kfV2.frames.sort(function (a, b) { return a.timestamp - b.timestamp; });
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }

      // 折叠：高级参数
      if (e.target.closest("#wf-rc-toggle-advanced")) {
        var kfNode3 = (wf.rcKeyframess || [])[0];
        if (kfNode3) {
          kfNode3.showAdvanced = !kfNode3.showAdvanced;
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }
      if (e.target.closest("#wf-rc-toggle-rejected")) {
        var kfNode4 = (wf.rcKeyframess || [])[0];
        if (kfNode4) {
          kfNode4.showRejected = !kfNode4.showRejected;
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }

      // 勾选/取消 本节点并发覆盖
      if (e.target.matches && e.target.matches("[data-rc-toggle-override]")) {
        var wrap = e.target.closest(".wf-detail-section");
        var nodeId = wrap && wrap.closest("[data-node-key]") ? wrap.closest("[data-node-key]").getAttribute("data-node-key") : "";
        // 简单做法：查找当前激活节点（global）
        var activeNd = null;
        ["rcFrameLabel", "rcSmartSegment", "rcRepFrames"].forEach(function (nt) {
          var arr = wf[nt + "s"] || [];
          if (arr[0] && wrap && wrap.closest(".wf-node-detail-" + nt)) activeNd = arr[0];
        });
        // 兜底：依次尝试标注/选帧节点
        if (!activeNd) {
          var flArr = wf.rcFrameLabels || [];
          var rfArr = wf.rcRepFramess || [];
          activeNd = flArr[0] || rfArr[0];
        }
        if (activeNd) {
          if (e.target.checked) {
            activeNd.maxConcurrentOverride = getConcurrency(wf, null);
          } else {
            delete activeNd.maxConcurrentOverride;
          }
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }

      // rcCharacters：生成全部未完成的
      if (e.target.closest("[data-rc-char-generate]")) {
        var charNode_g = (wf.rcCharacterss || [])[0];
        if (charNode_g) {
          delete charNode_g._forceRegen;
          delete charNode_g._targetNames;
          runSingleGlobal(engine, "rcCharacters");
        }
        return;
      }
      // rcCharacters：强制全部重新生成
      if (e.target.closest("[data-rc-char-regen-all]")) {
        var charNode_r = (wf.rcCharacterss || [])[0];
        if (charNode_r) {
          charNode_r._forceRegen = true;
          delete charNode_r._targetNames;
          runSingleGlobal(engine, "rcCharacters");
        }
        return;
      }
      // rcCharacters：单个角色重生成
      var regenCharBtn = e.target.closest("[data-regen-rc-char]");
      if (regenCharBtn) {
        var rci = parseInt(regenCharBtn.getAttribute("data-regen-rc-char"));
        var charNode_s = (wf.rcCharacterss || [])[0];
        var charV_s = charNode_s && NR.getActiveVersion(charNode_s);
        var target = charV_s && charV_s.characters && charV_s.characters[rci];
        if (target && target.name) {
          charNode_s._forceRegen = true;
          charNode_s._targetNames = [target.name];
          runSingleGlobal(engine, "rcCharacters");
        }
        return;
      }

      // rcScenes 段级：生成场景
      var sceneGenBtn = e.target.closest("[data-rc-scene-generate]");
      if (sceneGenBtn) {
        var sIdx_g = parseInt(sceneGenBtn.getAttribute("data-rc-scene-generate"));
        var seg_g = (wf.segments || [])[sIdx_g];
        var sNode_g = seg_g && (seg_g.rcSceness || [])[0];
        if (sNode_g) {
          runSingleSegment(engine, "rcScenes", sIdx_g);
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
        charV.characters.push({ name: "新人物" + (charV.characters.length + 1), features: "", new_desc: "", ref_frame_url: "", imageUrl: "" });
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

      // 基于智能分段结果创建 segments（优先）
      if (e.target.closest("#wf-rc-create-segments-from-smart")) {
        var ssV = NR.getActiveVersion((wf.rcSmartSegments || [])[0]);
        if (ssV && ssV.segments && ssV.segments.length) {
          if (engine.createSegments) {
            engine.createSegments(wf, ssV.segments.map(function (s, i) {
              return {
                index: i,
                text: s.theme || "",
                duration: Math.round(s.duration || (s.end - s.start) || 15),
                main_character_names: s.characters_in_scene || [],
                minor_characters: [],
                scenes: [],
              };
            }));
            engine.save();
            if (window.WF_Renderer) window.WF_Renderer.render(engine);
          }
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

    // rcPlotRewrite 对话修改：发送 / 清空历史
    document.addEventListener("click", async function (e) {
      var engine = window._wfEngine;
      var wf = engine && engine.current();
      if (!wf || wf.templateId !== "recreate-drama") return;

      if (e.target.closest && e.target.closest("[data-rc-rewrite-chat-clear]")) {
        var prNode0 = (wf.rcPlotRewrites || [])[0];
        if (prNode0) {
          prNode0.chatHistory = [];
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
        return;
      }
      var sendBtn = e.target.closest && e.target.closest("[data-rc-rewrite-chat-send]");
      if (!sendBtn) return;

      var input = document.getElementById("wf-rc-rewrite-chat-input");
      var msg = input && input.value.trim();
      if (!msg) return;
      var prNode = (wf.rcPlotRewrites || [])[0];
      var prV = prNode && NR.getActiveVersion(prNode);
      if (!prNode || !prV) { alert("请先运行剧情重编排"); return; }

      // 先把用户消息加入 history 并渲染
      prNode.chatHistory = prNode.chatHistory || [];
      prNode.chatHistory.push({ role: "user", content: msg });
      input.value = "";
      // 标记 running 以灰掉按钮
      var wasStatus = prNode.status;
      prNode.status = "running";
      engine.save();
      if (window.WF_Renderer) window.WF_Renderer.render(engine);

      try {
        var data = await callApi("/api/recreate/generate/rewrite-plot-chat", {
          workflow_id: wf.id,
          chat_config_id: getConfigId("chat", "rcPlotRewrite"),
          current_segments: prV.segments || [],
          current_characters: prV.characters || [],
          current_scenes: prV.scenes || [],
          chat_history: prNode.chatHistory.slice(0, -1),  // 不含本次用户消息（后端会看 user_message）
          user_message: msg,
          direction: (wf.input && wf.input.direction) || "",
          style: (wf.input && wf.input.style) || "",
        });
        // 助手回复加入 history
        var assistantMsg = data.message || "已更新剧本";
        prNode.chatHistory.push({ role: "assistant", content: assistantMsg });
        // 新 segments/characters/scenes 作为新版本
        NR.addVersion(prNode, {
          segments: data.segments || [],
          characters: data.characters || [],
          scenes: data.scenes || [],
        });
      } catch (err) {
        prNode.chatHistory.push({ role: "assistant", content: "修改失败：" + (err.message || err) });
        prNode.status = wasStatus || "done";
      }
      engine.save();
      if (window.WF_Renderer) window.WF_Renderer.render(engine);
    });

    // 顶部全局并发框
    document.addEventListener("change", function (e) {
      if (e.target && e.target.id === "wf-rc-global-concurrency") {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "recreate-drama") return;
        var val = parseInt(e.target.value);
        if (!isNaN(val) && val > 0) {
          wf.globalConcurrency = Math.min(10, Math.max(1, val));
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }
      }
    });

    // 上传替换图片（人物/场景）
    document.addEventListener("change", async function (e) {
      var charIdxAttr = e.target.getAttribute && e.target.getAttribute("data-upload-rc-char");
      var sceneSegAttr = e.target.getAttribute && e.target.getAttribute("data-upload-rc-scene");
      if (charIdxAttr === null && sceneSegAttr === null) return;
      if (!e.target.files || !e.target.files[0]) return;
      var engine = window._wfEngine;
      var wf = engine && engine.current();
      if (!wf || wf.templateId !== "recreate-drama") return;

      var file = e.target.files[0];
      var dataUrl = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      try {
        var prefix = (charIdxAttr !== null) ? "rc_char_upload" : ("rc_scene_upload_s" + sceneSegAttr);
        var res = await fetch("/api/recreate/upload-image/" + wf.id, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_data: dataUrl, prefix: prefix }),
        });
        var r = await res.json();
        if (r.code !== 0) throw new Error(r.detail || r.message || "上传失败");
        var newUrl = r.data && r.data.url;
        if (!newUrl) throw new Error("服务未返回 URL");

        if (charIdxAttr !== null) {
          var ci = parseInt(charIdxAttr);
          var charNode = (wf.rcCharacterss || [])[0];
          var cV = charNode && NR.getActiveVersion(charNode);
          if (cV && cV.characters && cV.characters[ci]) {
            cV.characters[ci].imageUrl = newUrl;
          }
        } else {
          var sIdx = parseInt(sceneSegAttr);
          var seg = (wf.segments || [])[sIdx];
          var sNode = seg && (seg.rcSceness || [])[0];
          var sV = sNode && NR.getActiveVersion(sNode);
          if (sV && sV.scene) {
            sV.scene.imageUrl = newUrl;
          }
        }
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
      } catch (err) {
        alert("上传失败: " + (err.message || err));
      } finally {
        e.target.value = "";
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



