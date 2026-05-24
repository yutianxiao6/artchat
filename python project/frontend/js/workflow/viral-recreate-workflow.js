/**
 * viral-recreate-workflow.js — 最强爆款视频复刻工作流
 * 前半（输入/关键帧/帧标注/反推提示词）走二创节点；
 * 后半（人物场景规划/人物/场景/帧规划/首尾帧/分镜/视频提示词）复用短剧节点。
 * 两个顶部按钮：复刻爆款（跑全流程）/ 反推提示词（仅到反推节点）。
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;
  var esc = window.WF_escapeHtml;

  var REVERSE_NODE = "vrVideoPromptReverse";
  // 反推节点之后的所有节点（mode=reverse 时全部 Skip）
  var POST_REVERSE_NODES = [
    "planCharactersScenes", "mainCharacters", "minorCharacters", "scene",
    "planFrames", "firstFrame", "storyboard", "lastFrame", "videoPrompt", "storyTemplate",
  ];

  function _getNodeConfigs() {
    if (window._getGlobalNodeConfigs) return window._getGlobalNodeConfigs();
    try { return JSON.parse(localStorage.getItem("flowdraw:wfNodeConfigs") || "{}"); } catch (e) { return {}; }
  }
  function getConfigId(type, nodeType) {
    if (nodeType) {
      var gc = _getNodeConfigs();
      var nc = gc[nodeType] || {};
      var key = type === "image" ? "imageConfigId" : (type === "vision" ? "visionConfigId" : "chatConfigId");
      if (nc[key]) return nc[key];
    }
    var selectType = type === "image" ? "image" : "chat";
    var sel = document.getElementById(selectType === "image" ? "image-config-select" : "chat-config-select");
    if (sel && sel.value) return sel.value;
    var list = (window.GLOBAL && window.GLOBAL.configList) || [];
    var allowed = selectType === "image" ? ["image", "both"] : ["chat", "both"];
    var c = list.find(function (c) { return allowed.indexOf(c.config_type) >= 0; });
    return c ? c.id : "";
  }

  function _formatFileSize(bytes) {
    if (!bytes) return "0 B";
    var u = ["B", "KB", "MB", "GB"]; var i = 0; var v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i === 0 ? 0 : 2) + " " + u[i];
  }
  function _formatDuration(sec) {
    if (!sec || sec < 0) return "未知";
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // 段数计算：>30s 拒绝；<=20s 一段；>20s 且 余量>=8 → [0,15],[15,d]；否则平均切两段
  function computeSegmentRanges(duration) {
    var d = Math.round(duration || 0);
    if (d <= 0) return [];
    if (d <= 20) return [[0, d]];
    var rem = d - 15;
    if (rem >= 8) return [[0, 15], [15, d]];
    var half = Math.round(d / 2);
    return [[0, half], [half, d]];
  }

  function _xhrUpload(url, body, headers, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      if (headers) Object.keys(headers).forEach(function (k) { xhr.setRequestHeader(k, headers[k]); });
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      }
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error("响应解析失败")); }
        } else {
          var msg = "HTTP " + xhr.status;
          try { var j = JSON.parse(xhr.responseText); msg = j.detail || j.message || msg; } catch (e) {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = function () { reject(new Error("网络错误")); };
      xhr.send(body);
    });
  }

  async function uploadVideoFile(wfId, file, onProgress) {
    var sizeLimitMB = 5;
    if (file.size <= sizeLimitMB * 1024 * 1024) {
      var dataUrl = await new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(reader.result); };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      var json = await _xhrUpload("/api/recreate/upload-video-b64/" + wfId,
        JSON.stringify({ video_data: dataUrl, filename: file.name }),
        { "Content-Type": "application/json" }, onProgress);
      if (json.code !== 0) throw new Error(json.detail || "上传失败");
      return json.data;
    } else {
      var form = new FormData();
      form.append("file", file);
      var json2 = await _xhrUpload("/api/recreate/upload-video/" + wfId, form, null, onProgress);
      if (json2.code !== 0) throw new Error(json2.detail || "上传失败");
      return json2.data;
    }
  }

  function _renderVideoCard(input) {
    if (!input || !input.videoUrl) return "";
    var meta = input.videoMetadata || {};
    var rows = [];
    rows.push(['文件名', esc(input.videoFilename || "source")]);
    if (input.videoSize) rows.push(['大小', _formatFileSize(input.videoSize)]);
    if (meta.duration) rows.push(['时长', _formatDuration(meta.duration) + " (" + Math.round(meta.duration) + "s)"]);
    if (meta.width && meta.height) rows.push(['分辨率', meta.width + " × " + meta.height]);
    if (meta.fps) rows.push(['帧率', meta.fps + " fps"]);
    var ranges = computeSegmentRanges(meta.duration || 0);
    if (ranges.length) rows.push(['自动分段', ranges.map(function (r) { return r[0] + "-" + r[1] + "s"; }).join(" / ")]);
    var rowsHtml = rows.map(function (r) {
      return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;border-bottom:1px dashed rgba(148,163,184,.2);"><span style="color:#94a3b8;">' + r[0] + '</span><span style="color:#e2e8f0;">' + r[1] + '</span></div>';
    }).join("");
    return '<div style="background:rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.3);border-radius:10px;padding:10px 12px;margin-bottom:8px;">'
      + '<div style="color:#22c55e;font-size:12px;font-weight:600;margin-bottom:6px;"><i class="fa fa-check-circle"></i> 视频已上传</div>'
      + rowsHtml
      + '<video controls preload="metadata" src="' + esc(input.videoUrl) + '" style="width:100%;max-height:200px;margin-top:8px;border-radius:6px;background:#000;"></video>'
      + '</div>';
  }

  // ── Node: vrInput ─────────────────────────────
  NR.register({
    id: "vrInput", label: "输入视频", icon: "fa-upload", color: "#8b5cf6",
    category: "global", allowMultiple: false,
    getPreview: function (nd, wf) {
      var input = (wf && wf.input) || {};
      if (input.videoFilename) return input.videoFilename;
      return "";
    },
    renderDetail: function (nd, wf) {
      var input = wf.input || {};
      var dur = (input.videoMetadata && input.videoMetadata.duration) || 0;
      var dHint = dur ? ('当前时长 ' + Math.round(dur) + 's，自动分段：' + computeSegmentRanges(dur).map(function (r) { return r[0] + "-" + r[1] + "s"; }).join(" / ")) : '上传 ≤30 秒视频后将自动按规则分段';
      var plotVal = esc(input.plot || "");
      var refVal = esc(input.reference || "");
      return '<div class="wf-detail-section"><div class="wf-detail-label">上传视频（≤30 秒）</div>'
        + _renderVideoCard(input)
        + '<div id="wf-vr-upload-progress" style="display:none;margin-bottom:8px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;"><span id="wf-vr-upload-label" style="color:#60a5fa;">准备上传...</span><span id="wf-vr-upload-percent" style="color:#94a3b8;">0%</span></div>'
        + '<div style="height:6px;background:rgba(148,163,184,.2);border-radius:3px;overflow:hidden;"><div id="wf-vr-upload-bar" style="height:100%;background:linear-gradient(90deg,#60a5fa,#22c55e);width:0%;transition:width .2s ease;"></div></div>'
        + '<div id="wf-vr-upload-detail" style="font-size:11px;color:#64748b;margin-top:4px;"></div>'
        + '</div>'
        + '<label class="wf-upload-btn"><i class="fa fa-film"></i> ' + (input.videoUrl ? '替换视频' : '选择视频文件') + '<input type="file" accept="video/*" class="wf-file-input" data-vr-upload="video" style="display:none"></label>'
        + '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">' + esc(dHint) + '</div>'
        + '</div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">剧情参考（可选）</div>'
        + '<textarea data-vr-input="plot" placeholder="原始剧情概要，帮助模型理解画面语境。例如：女主角在街头偶遇前男友..." style="width:100%;height:60px;padding:8px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.25);border-radius:6px;color:#e2e8f0;font-size:12px;resize:vertical;">' + plotVal + '</textarea>'
        + '</div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">帧标注参考信息（关键！纠正模型识别偏差）</div>'
        + '<div style="font-size:10px;color:#fbbf24;margin-bottom:4px;"><i class="fa fa-exclamation-triangle"></i> 如果视频中有特殊角色（丧尸/机器人/非人类/特殊装扮），必须在此说明，否则模型可能误判。例如：女主角是丧尸，皮肤灰白、行动迟缓、瞳孔发白；场景是末日废墟。</div>'
        + '<textarea data-vr-input="reference" placeholder="帧标注和反推的参考信息。例如：女主角是丧尸（行动迟缓、皮肤溃烂、瞳孔发白）；男主穿黑色风衣、戴墨镜；场景发生在2150年末日废墟..." style="width:100%;height:80px;padding:8px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.25);border-radius:6px;color:#e2e8f0;font-size:12px;resize:vertical;">' + refVal + '</textarea>'
        + '</div>';
    },
  });

  // ── Node: vrVideoPromptReverse ─────────────────────────────
  NR.register({
    id: REVERSE_NODE, label: "反推视频提示词", icon: "fa-magic", color: "#ec4899",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v || !v.full_text) return "";
      return v.full_text.length + " 字";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var kfNode = (wf.rcKeyframess || [])[0];
      var kfV = NR.getActiveVersion(kfNode);
      if (!kfV || !kfV.frames || !kfV.frames.length) throw new Error("请先提取关键帧");
      var flV = NR.getActiveVersion((wf.rcFrameLabels || [])[0]);
      if (!flV || !flV.frames || !flV.frames.length) throw new Error("请先完成帧标注（反推强依赖逐帧描述与字幕）");
      var dur = (wf.input && wf.input.videoMetadata && wf.input.videoMetadata.duration) || 0;
      var nd = ctx.nodeData;
      var mode = nd.mode || "replica";
      var batchSize = parseInt(nd.batchSize) || 8;
      var maxConcurrent = parseInt(nd.maxConcurrent) || 3;

      var res = await fetch("/api/recreate/generate/reverse-video-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow_id: wf.id,
          chat_config_id: getConfigId("vision", REVERSE_NODE),
          duration: Math.round(dur),
          user_plot: (wf.input && wf.input.plot) || "",
          user_style: (wf.input && wf.input.style) || "",
          user_reference: (wf.input && wf.input.reference) || "",
          mode: mode,
          batch_size: batchSize,
          max_concurrent: maxConcurrent,
        }),
      });
      var json = await res.json();
      if (!res.ok || json.code !== 0) {
        throw new Error(json.detail || json.message || ("HTTP " + res.status));
      }
      var fullText = (json.data && json.data.full_text) || "";
      if (!fullText) throw new Error("后端未返回 full_text");

      // 自动按时长创建段落（如果还没有段落）
      if (ctx.engine && ctx.engine.createSegments && (!wf.segments || !wf.segments.length)) {
        var ranges = computeSegmentRanges(Math.round(dur));
        var segData = ranges.map(function (rg, idx) {
          return { index: idx, text: "第 " + (idx + 1) + " 段（" + rg[0] + "-" + rg[1] + "s）", duration: rg[1] - rg[0] };
        });
        if (segData.length) ctx.engine.createSegments(wf, segData);
      }

      // 把反推 full_text 注入到 wf.scripts[0]，供下游 planCharactersScenes 等节点消费
      if (!wf.scriptss) wf.scriptss = wf.scriptss || [];
      if (!wf.scripts) wf.scripts = [NR.createNodeData()];
      if (!wf.scripts[0]) wf.scripts[0] = NR.createNodeData();
      // 把 full_text 按段切成等分文本，便于 segments 拿到 text
      var segCount = (wf.segments || []).length || 1;
      var perLen = Math.ceil(fullText.length / segCount);
      var scriptSegs = [];
      for (var si = 0; si < segCount; si++) {
        scriptSegs.push({ text: fullText.slice(si * perLen, (si + 1) * perLen) });
      }
      NR.addVersion(wf.scripts[0], { fullText: fullText, segments: scriptSegs });
      // 同步到段的 scriptText
      (wf.segments || []).forEach(function (seg, i) {
        seg.scriptText = (scriptSegs[i] && scriptSegs[i].text) || seg.scriptText || "";
      });

      return { full_text: fullText, fullText: fullText, duration: Math.round(dur),
               mode: (json.data && json.data.mode) || mode,
               shot_count: (json.data && json.data.shot_count) || 0,
               avg_shot_sec: (json.data && json.data.avg_shot_sec) || 0 };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = "";
      if (ctx && ctx.engine) {
        if (ctx.engine.isNodeRunning && ctx.engine.isNodeRunning(REVERSE_NODE, null)) dis = " disabled";
        else if (ctx.engine.canExecute && !ctx.engine.canExecute(REVERSE_NODE, null, wf)) dis = " disabled";
      }
      var mode = nd.mode || "replica";
      var batchSize = parseInt(nd.batchSize) || 8;
      var maxConcurrent = parseInt(nd.maxConcurrent) || 3;

      var kfV = NR.getActiveVersion((wf.rcKeyframess || [])[0]);
      var kfCount = (kfV && kfV.frames && kfV.frames.length) || 0;
      var flV = NR.getActiveVersion((wf.rcFrameLabels || [])[0]);
      var flCount = (flV && flV.frames && flV.frames.length) || 0;
      var batches = kfCount ? Math.ceil(kfCount / batchSize) : 0;

      var html = '';

      // 精细模式提示 + 一键应用按钮（始终显示）
      var kfNd = (wf.rcKeyframess || [])[0];
      var threshold = (kfNd && kfNd.min_scene_threshold !== undefined) ? kfNd.min_scene_threshold : 0.04;
      var dedup = (kfNd && kfNd.hamming_dedup_threshold !== undefined) ? kfNd.hamming_dedup_threshold : 2;
      var isFine = (parseFloat(threshold) <= 0.04 && parseInt(dedup) <= 2);
      var fineColor = isFine ? '#22c55e' : '#fbbf24';
      var fineBg = isFine ? 'rgba(34,197,94,.08)' : 'rgba(245,158,11,.08)';
      var fineBorder = isFine ? 'rgba(34,197,94,.3)' : 'rgba(245,158,11,.3)';
      var fineMsg = isFine
        ? '<i class="fa fa-check-circle"></i> 关键帧参数已是精细模式（场景阈值 ' + threshold + '，pHash 去重 ' + dedup + '）'
        : '<i class="fa fa-exclamation-triangle"></i> 当前关键帧参数偏粗（场景阈值 ' + threshold + '，pHash 去重 ' + dedup + '）。建议应用精细参数后重跑关键帧提取，再来反推。';
      html += '<div class="wf-detail-section" style="background:' + fineBg + ';border:1px solid ' + fineBorder + ';border-radius:8px;padding:8px 10px;font-size:12px;color:' + fineColor + ';display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
        + '<div style="flex:1;min-width:200px;">' + fineMsg + '</div>'
        + '<button class="wf-tb-btn" data-vr-apply-fine style="font-size:11px;"><i class="fa fa-magic"></i> ' + (isFine ? '重新应用精细参数' : '一键应用精细参数') + '</button>'
        + '</div>';

      // 模式选择 + 批/并发
      html += '<div class="wf-detail-section" style="display:flex;flex-direction:column;gap:8px;">'
        + '<div class="wf-detail-label">反推模式</div>'
        + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
        + '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;padding:6px 10px;border:1px solid ' + (mode === "replica" ? "rgba(236,72,153,.5)" : "rgba(148,163,184,.2)") + ';border-radius:8px;background:' + (mode === "replica" ? "rgba(236,72,153,.08)" : "transparent") + ';">'
        +   '<input type="radio" name="vr-mode" data-vr-radio-mode="replica"' + (mode === "replica" ? " checked" : "") + '>'
        +   '<div><div style="font-size:12px;font-weight:600;color:#f9a8d4;">复刻档（严格画面）</div><div style="font-size:10px;color:#94a3b8;">人物外观/服装/配饰、场景环境、字幕原文，全部保留——用于精确还原原视频</div></div>'
        + '</label>'
        + '<label style="display:flex;gap:6px;align-items:center;cursor:pointer;padding:6px 10px;border:1px solid ' + (mode === "replace" ? "rgba(96,165,250,.5)" : "rgba(148,163,184,.2)") + ';border-radius:8px;background:' + (mode === "replace" ? "rgba(96,165,250,.08)" : "transparent") + ';">'
        +   '<input type="radio" name="vr-mode" data-vr-radio-mode="replace"' + (mode === "replace" ? " checked" : "") + '>'
        +   '<div><div style="font-size:12px;font-weight:600;color:#bfdbfe;">替换档（抽象占位）</div><div style="font-size:10px;color:#94a3b8;">把姓名地名抽象为「男主角/女主角/夜晚街道」——用于换人换景生成新版</div></div>'
        + '</label>'
        + '</div>'
        + '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;font-size:11px;color:#94a3b8;">'
        + '<div>关键帧 <b style="color:#e2e8f0;">' + kfCount + '</b></div>'
        + '<div>帧标注 <b style="color:' + (flCount ? '#22c55e' : '#ef4444') + ';">' + flCount + '</b>' + (flCount ? '' : '（必须先完成）') + '</div>'
        + '<div>每批帧数 <input class="wf-detail-input wf-editable" data-edit-field="batchSize" type="number" min="4" max="12" value="' + batchSize + '" style="width:60px;"></div>'
        + '<div>并发 <input class="wf-detail-input wf-editable" data-edit-field="maxConcurrent" type="number" min="1" max="6" value="' + maxConcurrent + '" style="width:60px;"></div>'
        + (batches ? '<div>预计 <b style="color:#e2e8f0;">' + batches + '</b> 批</div>' : '')
        + '</div>'
        + '</div>';

      if (v && v.full_text) {
        var meta = '';
        if (v.shot_count) meta += '镜头 ' + v.shot_count + ' · ';
        if (v.avg_shot_sec) meta += '平均 ' + v.avg_shot_sec + 's/镜 · ';
        meta += (v.full_text || "").length + ' 字 · 时长 ' + (v.duration || 0) + 's · ' + (v.mode === "replace" ? "替换档" : "复刻档");

        html += '<div class="wf-detail-section" style="border:1px solid rgba(96,165,250,.35);border-radius:10px;padding:10px 12px;background:rgba(59,130,246,.06);">'
          + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">'
          + '<div class="wf-detail-label" style="color:#bfdbfe;margin:0;">完整视频提示词（' + esc(meta) + '）</div>'
          + '<button class="wf-tb-btn primary" data-vr-copy-full><i class="fa fa-copy"></i> 复制完整提示词</button>'
          + '</div>'
          + '<textarea readonly class="wf-detail-textarea" rows="16" id="wf-vr-full-prompt" style="font-family:ui-monospace,monospace;font-size:12px;line-height:1.6;">' + esc(v.full_text || "") + '</textarea>'
          + '</div>';

        // 对话修改区
        var history = nd.chatHistory || [];
        var isTyping = history.length && history[history.length - 1]._typing;
        var inputDis = isTyping ? ' disabled' : '';
        var histHtml = '';
        if (history.length) {
          histHtml = '<div style="max-height:260px;overflow-y:auto;padding:4px 0;">' + history.map(function (m, idx) {
            if (m._typing) {
              return '<div style="display:flex;justify-content:flex-start;margin:4px 0;"><div style="padding:8px 12px;border-radius:8px;background:rgba(148,163,184,.12);color:#94a3b8;font-size:12px;">AI 正在思考...</div></div>';
            }
            var isUser = m.role === "user";
            var retryBtn = isUser
              ? '<button data-vr-chat-retry="' + idx + '" title="重试这条消息" style="background:none;border:none;color:#94a3b8;cursor:pointer;padding:2px;font-size:11px;opacity:0;transition:opacity .2s;"><i class="fa fa-refresh"></i></button>'
              : '';
            return '<div style="display:flex;justify-content:' + (isUser ? 'flex-end' : 'flex-start') + ';margin:4px 0;align-items:center;gap:4px;" class="vr-chat-row">'
              + (isUser ? retryBtn : '')
              + '<div style="max-width:85%;padding:6px 10px;border-radius:8px;font-size:12px;line-height:1.4;white-space:pre-wrap;'
              + (isUser ? 'background:rgba(236,72,153,.2);color:#f9a8d4;' : 'background:rgba(148,163,184,.12);color:#e2e8f0;')
              + '">' + esc(m.content || "") + '</div></div>';
          }).join("") + '</div>';
        }
        html += '<div class="wf-detail-section" style="margin-top:12px;padding:8px;border:1px solid rgba(236,72,153,.2);border-radius:8px;">'
          + '<div class="wf-detail-label" style="color:#f9a8d4;"><i class="fa fa-comments"></i> 对话修改</div>'
          + (history.length ? histHtml : '<div style="font-size:11px;color:#64748b;margin-bottom:6px;">对提示词提出修改意见，例如：女主角改成丧尸外观 / 剧情不对应该是相遇→冲突→和解 / 场景描述太暗了加点暖光</div>')
          + '<textarea class="wf-detail-textarea" id="wf-vr-chat-input" rows="3" placeholder="' + (isTyping ? 'AI 正在回复，请稍候...' : '输入修改意见，回车发送（Shift+Enter 换行）') + '" style="margin-top:6px;"' + inputDis + '></textarea>'
          + '<div style="display:flex;gap:6px;margin-top:6px;">'
          + '<button class="wf-tb-btn primary" data-vr-chat-send' + inputDis + '><i class="fa fa-paper-plane"></i> ' + (isTyping ? 'AI 正在回复...' : '发送修改') + '</button>'
          + (history.length ? '<button class="wf-tb-btn" data-vr-chat-clear title="清空对话历史"><i class="fa fa-trash-o"></i> 清空历史</button>' : '')
          + '</div>'
          + '</div>';
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">先完成关键帧（必需）与帧标注（必需），再点击下方按钮反推。后端会分批精读每张帧 → 文本模型合成最终提示词，可直接复制粘贴到任意视频模型。</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="' + REVERSE_NODE + '"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新反推" : "开始反推") + '</button></div>';
      return html;
    },
  });

  // ── Pipeline ─────────────────────────────
  var VIRAL_PIPELINE = {
    pipeline: [
      { nodeType: "vrInput",              category: "global" },
      { nodeType: "rcKeyframes",          category: "global" },
      { nodeType: "rcFrameLabel",         category: "global" },
      { nodeType: REVERSE_NODE,           category: "global" },
      { nodeType: "planCharactersScenes", category: "global" },
      { nodeType: "mainCharacters",       category: "global" },
      { nodeType: "minorCharacters",      category: "segment" },
      { nodeType: "scene",                category: "segment" },
      { nodeType: "planFrames",           category: "segment" },
      { nodeType: "firstFrame",           category: "segment" },
      { nodeType: "storyboard",           category: "segment" },
      { nodeType: "lastFrame",            category: "segment" },
      { nodeType: "videoPrompt",          category: "segment" },
      { nodeType: "storyTemplate",        category: "segment" },
    ],
    topbarHtml: function (engine, wf) {
      var mode = wf.vrMode || "full";
      var label = mode === "reverse" ? '<span style="color:#f9a8d4;">反推提示词</span>' : '<span style="color:#22c55e;">复刻爆款</span>';
      var g = (wf && wf.globalConcurrency) || 3;
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(148,163,184,.08);border:1px solid rgba(148,163,184,.15);border-radius:10px;margin-bottom:8px;flex-wrap:wrap;">'
        + '<button class="wf-tb-btn ' + (mode === "full" ? "primary" : "") + '" data-vr-mode="full"><i class="fa fa-fire"></i> 复刻爆款</button>'
        + '<button class="wf-tb-btn ' + (mode === "reverse" ? "primary" : "") + '" data-vr-mode="reverse"><i class="fa fa-magic"></i> 反推提示词</button>'
        + '<div style="font-size:12px;color:#94a3b8;">当前模式：' + label + '</div>'
        + '<div style="margin-left:auto;display:flex;align-items:center;gap:8px;">'
        + '<div style="font-size:12px;color:#94a3b8;"><i class="fa fa-tachometer"></i> 全局并发</div>'
        + '<input id="wf-vr-global-concurrency" type="number" min="1" max="10" value="' + g + '" style="width:64px;padding:4px 8px;background:rgba(15,23,42,.6);border:1px solid rgba(148,163,184,.25);border-radius:6px;color:#e2e8f0;">'
        + '</div>'
        + '<div style="flex-basis:100%;font-size:11px;color:#64748b;">反推模式：只跑到「反推视频提示词」节点即停。切回复刻爆款可继续后续节点，已完成节点不会重跑。</div>'
        + '</div>';
    },
  };

  // ── Template Registration ─────────────────────────────
  if (!window.WF_Templates) window.WF_Templates = [];
  window.WF_Templates.push({
    id: "viral-recreate",
    name: "最强爆款视频复刻工作流",
    icon: "fa-fire",
    description: "≤30s 视频 → 关键帧 → 帧解析 → 反推完整视频提示词（含风格） → 人物场景 → 分镜规划 → 分镜图 → 各段视频提示词。两种模式：复刻爆款 / 反推提示词",
    pipeline: VIRAL_PIPELINE,
  });

  // ── Mode Switch ─────────────────────────────
  function applyMode(wf, mode) {
    wf.vrMode = mode;
    var skipVal = (mode === "reverse");
    POST_REVERSE_NODES.forEach(function (nt) {
      wf[nt + "Skip"] = skipVal;
      (wf.segments || []).forEach(function (seg) { seg[nt + "Skip"] = skipVal; });
    });
  }

  // ── Events ─────────────────────────────
  var _initialized = false;
  function init() {
    if (_initialized) return;
    _initialized = true;

    document.addEventListener("click", function (e) {
      var btn = e.target.closest && e.target.closest("[data-vr-mode]");
      if (btn) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        applyMode(wf, btn.getAttribute("data-vr-mode"));
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        return;
      }
      var cp = e.target.closest && e.target.closest("[data-vr-copy-full]");
      if (cp) {
        var ta = document.getElementById("wf-vr-full-prompt");
        if (ta) {
          ta.select();
          try { document.execCommand("copy"); } catch (er) {}
          if (navigator.clipboard) { try { navigator.clipboard.writeText(ta.value); } catch (er2) {} }
          var old = cp.innerHTML;
          cp.innerHTML = '<i class="fa fa-check"></i> 已复制';
          setTimeout(function () { cp.innerHTML = old; }, 1200);
        }
        return;
      }

      // 一键应用精细参数到 rcKeyframes 节点
      var fineBtn = e.target.closest && e.target.closest("[data-vr-apply-fine]");
      if (fineBtn) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var kfNd = (wf.rcKeyframess || [])[0];
        if (!kfNd) { alert("未找到关键帧节点"); return; }
        kfNd.min_scene_threshold = 0.02;
        kfNd.long_shot_max_gap = 0.6;
        kfNd.sharpness_min = 20;
        kfNd.hamming_dedup_threshold = 1;
        kfNd.luma_lo = 2;
        kfNd.luma_hi = 253;
        kfNd.edge_density_min = 0.003;
        kfNd.max_candidates = 2000;
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        alert("已应用精细参数。请前往「关键帧提取」节点点击「重新提取」，再回来反推。");
        return;
      }

      // 反推对话修改 — 清空历史
      var chatClearBtn = e.target.closest && e.target.closest("[data-vr-chat-clear]");
      if (chatClearBtn) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var nd = (wf[REVERSE_NODE + "s"] || [])[0];
        if (nd) { nd.chatHistory = []; engine.save(); }
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        return;
      }

      // 反推对话修改 — 发送
      var chatSendBtn = e.target.closest && e.target.closest("[data-vr-chat-send]");
      if (chatSendBtn) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var nd = (wf[REVERSE_NODE + "s"] || [])[0];
        var v = nd && NR.getActiveVersion(nd);
        if (!nd || !v || !v.full_text) { alert("请先运行反推提示词"); return; }
        var input = document.getElementById("wf-vr-chat-input");
        var msg = input && input.value.trim();
        if (!msg) return;
        (function () {
          var capturedMsg = msg;
          nd.chatHistory = nd.chatHistory || [];
          nd.chatHistory.push({ role: "user", content: capturedMsg });
          nd.chatHistory.push({ role: "assistant", content: "", _typing: true });
          input.value = "";
          nd.status = "running";
          engine.save();
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
          function _removeTyping() { if (!nd.chatHistory) return; nd.chatHistory = nd.chatHistory.filter(function (m) { return !m._typing; }); }
          fetch("/api/recreate/generate/reverse-video-prompt-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              workflow_id: wf.id,
              chat_config_id: getConfigId("chat", REVERSE_NODE),
              current_full_text: v.full_text || "",
              chat_history: nd.chatHistory.filter(function (m) { return !m._typing; }).slice(0, -1),
              user_message: capturedMsg,
              user_plot: (wf.input && wf.input.plot) || "",
              user_style: (wf.input && wf.input.style) || "",
              user_reference: (wf.input && wf.input.reference) || "",
              duration: v.duration || 0,
              mode: nd.mode || "replica",
            }),
          }).then(function (res) { return res.json(); }).then(function (json) {
            _removeTyping();
            if (json.code === 0) {
              var newText = (json.data && json.data.full_text) || "";
              nd.chatHistory.push({ role: "assistant", content: json.data && json.data.message || "提示词已更新" });
              NR.addVersion(nd, Object.assign({}, v, { full_text: newText, fullText: newText }));
            } else {
              nd.chatHistory.push({ role: "assistant", content: "修改失败：" + (json.detail || "未知错误") });
            }
          }).catch(function (err) {
            _removeTyping();
            nd.chatHistory.push({ role: "assistant", content: "修改失败：" + (err.message || err) });
          }).finally(function () {
            nd.status = "done";
            engine.save();
            // 同步 full_text 到 scripts[0]（供下游节点消费）
            if (wf.scripts && wf.scripts[0]) {
              var sV = NR.getActiveVersion(wf.scripts[0]);
              NR.addVersion(wf.scripts[0], Object.assign({}, sV || {}, { fullText: (NR.getActiveVersion(nd) || {}).full_text || v.full_text }));
            }
            if (window.WF_Renderer) window.WF_Renderer.render(engine);
          });
        })();
        return;
      }

      // 反推对话修改 — 重试（hover 按钮）
      var retryBtn = e.target.closest && e.target.closest("[data-vr-chat-retry]");
      if (retryBtn) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var nd = (wf[REVERSE_NODE + "s"] || [])[0];
        if (!nd || !nd.chatHistory) return;
        var ridx = parseInt(retryBtn.getAttribute("data-vr-chat-retry"));
        if (isNaN(ridx) || ridx < 0 || ridx >= nd.chatHistory.length) return;
        var target = nd.chatHistory[ridx];
        if (!target || target.role !== "user") return;
        nd.chatHistory = nd.chatHistory.slice(0, ridx);
        engine.save();
        var input = document.getElementById("wf-vr-chat-input");
        if (input) { input.value = target.content || ""; input.focus(); }
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
        return;
      }
    });

    // 反推模式 radio
    document.addEventListener("change", function (e) {
      var radio = e.target && e.target.getAttribute && e.target.getAttribute("data-vr-radio-mode");
      if (radio) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var nd = (wf[REVERSE_NODE + "s"] || [])[0];
        if (!nd) return;
        nd.mode = radio;
        engine.save();
        if (window.WF_Renderer) window.WF_Renderer.render(engine);
      }
    });

    document.addEventListener("input", function (e) {
      if (e.target && e.target.id === "wf-vr-global-concurrency") {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var v = parseInt(e.target.value);
        if (!isNaN(v) && v > 0) { wf.globalConcurrency = v; engine.save(); }
      }
      // vrInput 文本字段（plot / reference）写入 wf.input
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-vr-input")) {
        var engine = window._wfEngine;
        var wf = engine && engine.current();
        if (!wf || wf.templateId !== "viral-recreate") return;
        var field = e.target.getAttribute("data-vr-input");
        wf.input = wf.input || {};
        wf.input[field] = e.target.value;
        engine.save();
      }
    });

    // 回车发送（Shift+Enter 换行）
    document.addEventListener("keydown", function (e) {
      if (e.target && e.target.id === "wf-vr-chat-input" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var sendBtn = document.querySelector("[data-vr-chat-send]");
        if (sendBtn && !sendBtn.disabled) sendBtn.click();
      }
    });

    // 视频上传（vrInput）
    document.addEventListener("change", async function (e) {
      if (!e.target.classList || !e.target.classList.contains("wf-file-input")) return;
      if (e.target.getAttribute("data-vr-upload") !== "video") return;
      if (!e.target.files || !e.target.files[0]) return;
      var file = e.target.files[0];
      var engine = window._wfEngine;
      var wf = engine && engine.current();
      if (!wf || wf.templateId !== "viral-recreate") return;

      var progEl = document.getElementById("wf-vr-upload-progress");
      var barEl = document.getElementById("wf-vr-upload-bar");
      var pctEl = document.getElementById("wf-vr-upload-percent");
      var lblEl = document.getElementById("wf-vr-upload-label");
      var detEl = document.getElementById("wf-vr-upload-detail");
      if (progEl) progEl.style.display = "block";
      if (lblEl) lblEl.textContent = "读取本地元数据...";
      if (detEl) detEl.textContent = file.name + " · " + _formatFileSize(file.size);

      var localMeta = {};
      try {
        localMeta = await new Promise(function (resolve) {
          var v = document.createElement("video");
          v.preload = "metadata";
          v.onloadedmetadata = function () {
            resolve({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
            URL.revokeObjectURL(v.src);
          };
          v.onerror = function () { resolve({}); };
          v.src = URL.createObjectURL(file);
          setTimeout(function () { resolve({}); }, 3000);
        });
      } catch (er) {}

      if (localMeta.duration && localMeta.duration > 30.5) {
        alert("视频时长 " + Math.round(localMeta.duration) + " 秒超过 30 秒上限，请裁剪后再上传。");
        if (progEl) progEl.style.display = "none";
        e.target.value = "";
        return;
      }

      if (lblEl) lblEl.textContent = "上传中...";
      try {
        var data = await uploadVideoFile(wf.id, file, function (loaded, total) {
          var pct = total > 0 ? Math.round(loaded * 100 / total) : 0;
          if (barEl) barEl.style.width = pct + "%";
          if (pctEl) pctEl.textContent = pct + "%";
          if (detEl) detEl.textContent = file.name + " · " + _formatFileSize(loaded) + " / " + _formatFileSize(total);
        });
        wf.input = wf.input || {};
        // 加时间戳避免浏览器缓存旧视频
        var urlWithBust = data.url + (data.url.indexOf("?") >= 0 ? "&" : "?") + "_t=" + Date.now();
        wf.input.videoUrl = urlWithBust;

        // 替换视频：清空所有下游节点数据，避免沿用上一个视频的关键帧/标注/反推/段落
        var downstreamNodes = ["rcKeyframes", "rcFrameLabel", "vrVideoPromptReverse",
                               "planCharactersScenes", "mainCharacters", "scripts"];
        downstreamNodes.forEach(function (nt) {
          var arrKey = nt === "scripts" ? "scripts" : (nt + "s");
          if (wf[arrKey]) {
            wf[arrKey] = [NR.createNodeData()];
          }
        });
        wf.segments = [];
        wf.input.videoFilename = file.name;
        wf.input.videoSize = file.size;
        wf.input.videoMetadata = Object.assign({}, localMeta, data.metadata || {});

        // 服务器返回的时长也校验一次
        var srvDur = (wf.input.videoMetadata && wf.input.videoMetadata.duration) || 0;
        if (srvDur > 30.5) {
          alert("服务器探测到时长 " + Math.round(srvDur) + " 秒超过 30 秒上限，请重新上传裁剪后的视频。");
          wf.input.videoUrl = "";
          wf.input.videoFilename = "";
          wf.input.videoSize = 0;
          wf.input.videoMetadata = {};
        } else {
          // 自动按时长创建段落（如果还没有段落）
          if (engine.createSegments && (!wf.segments || !wf.segments.length)) {
            var ranges = computeSegmentRanges(srvDur || localMeta.duration || 0);
            var segData = ranges.map(function (rg, idx) {
              return { index: idx, text: "第 " + (idx + 1) + " 段（" + rg[0] + "-" + rg[1] + "s）", duration: rg[1] - rg[0] };
            });
            if (segData.length) engine.createSegments(wf, segData);
          }
          // 初始化模式
          if (!wf.vrMode) applyMode(wf, "full");
        }

        engine.save();
        setTimeout(function () {
          if (progEl) progEl.style.display = "none";
          if (window.WF_Renderer) window.WF_Renderer.render(engine);
        }, 400);
      } catch (err) {
        if (lblEl) { lblEl.textContent = "上传失败"; lblEl.style.color = "#ef4444"; }
        alert("上传失败: " + (err.message || err));
      } finally {
        e.target.value = "";
      }
    });

    // 工作流加载后：若未设置 vrMode，默认 full
    var origRender = window.WF_Renderer && window.WF_Renderer.render;
    if (origRender && !window.WF_Renderer._vrPatched) {
      window.WF_Renderer._vrPatched = true;
      window.WF_Renderer.render = function (engine) {
        var wf = engine && engine.current && engine.current();
        if (wf && wf.templateId === "viral-recreate" && !wf.vrMode) {
          applyMode(wf, "full");
        }
        return origRender.apply(this, arguments);
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
