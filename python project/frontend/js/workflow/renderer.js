/**
 * renderer.js v2 — 通用工作流渲染器
 * 固定管线头 + 下方内容列 + 分隔线 + 段落框
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;
  var esc = window.WF_escapeHtml;

  function _getReviewMaxRetries() {
    try {
      var raw = localStorage.getItem("flowdraw:wfReviewMaxRetries");
      if (raw === null || raw === "") return 2;
      var n = parseInt(raw);
      return isNaN(n) ? 2 : n;
    } catch(e) { return 2; }
  }
  function _setReviewMaxRetries(n) {
    var v = parseInt(n);
    if (isNaN(v) || v < 0) v = 0;
    localStorage.setItem("flowdraw:wfReviewMaxRetries", String(v));
  }

  /* ── Mini Pipeline (toolbar) ── */
  function renderMiniPipeline(engine) {
    var wf = engine.current();
    var steps = engine.pipeline.filter(function (s) {
      return s.nodeType !== "input" && s.nodeType !== "fpInput" && s.nodeType !== "output"
        && s.nodeType !== "rcInput" && s.nodeType !== "rcOutput";
    });
    var segments = wf ? (wf.segments || []) : [];
    var hasSegs = segments.length > 0;
    var execSteps = engine.getExecSteps();
    var execIds = {};
    execSteps.forEach(function (s) { execIds[s.nodeType] = true; });

    var nodesHtml = steps.map(function (s, i) {
      var def = NR.get(s.nodeType);
      var active = execIds[s.nodeType] ? "active" : "";
      var dot = '<div class="wf-mini-node ' + active + '" data-mini-node="' + s.nodeType + '"'
        + ' style="--node-color:' + (def ? def.color : '#64748b') + '">'
        + '<i class="fa ' + (def ? def.icon : 'fa-circle') + '"></i>'
        + '<span>' + (def ? def.label : s.nodeType) + '</span></div>';
      var line = i < steps.length - 1 ? '<div class="wf-mini-line ' + (active && execIds[steps[i + 1].nodeType] ? "active" : "") + '"></div>' : "";
      return dot + line;
    }).join("");

    var segPicker = "";
    if (hasSegs) {
      var selSegs = engine.execRange.segments;
      var isAll = selSegs === "all" || !selSegs;
      segPicker = '<div class="wf-seg-picker">'
        + '<span class="wf-seg-picker-label">段落:</span>'
        + '<button class="wf-seg-chip ' + (isAll ? "active" : "") + '" data-seg-pick="all">全部</button>';
      for (var i = 0; i < segments.length; i++) {
        var isActive = isAll || (Array.isArray(selSegs) && selSegs.indexOf(i) >= 0);
        segPicker += '<button class="wf-seg-chip ' + (isActive ? "active" : "") + '" data-seg-pick="' + i + '">第' + (i + 1) + '段</button>';
      }
      segPicker += '</div>';
    }

    return '<div class="wf-mini-pipeline">'
      + '<div class="wf-mini-nodes">' + nodesHtml + '</div>'
      + segPicker + '</div>';
  }

  /* ── Toolbar ── */
  function renderToolbar(engine) {
    var wf = engine.current();
    var mode = wf ? wf.mode : "single";
    var isAutoRunning = engine.running && engine.runningWfId === (wf && wf.id);
    var isBusy = isAutoRunning || engine.isAnyRunning();
    var templates = window.WF_Templates || [];
    var tplOpts = templates.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.name) + '</option>';
    }).join("");
    var episodes = (wf && wf.episodes) || [];
    var curEpId = wf && wf.currentEpisodeId;
    var epOpts = episodes.map(function (e) {
      var sel = e.id === curEpId ? " selected" : "";
      return '<option value="' + esc(e.id) + '"' + sel + '>' + esc(e.title || ("第" + (e.index + 1) + "集")) + '</option>';
    }).join("");
    var canDelEp = episodes.length > 1;
    return '<div class="wf-toolbar" id="wf-toolbar">'
      + '<select id="wf-template-select" class="wf-toolbar-select wf-template-select">' + tplOpts + '</select>'
      + '<button class="wf-tb-btn" id="wf-new-btn"><i class="fa fa-plus"></i> 新建</button>'
      + '<button class="wf-tb-btn danger" id="wf-del-btn"><i class="fa fa-trash-o"></i></button>'
      + '<div class="wf-toolbar-sep"></div>'
      + (wf ? ('<select id="wf-episode-select" class="wf-toolbar-select" title="切换剧集">' + epOpts + '</select>'
        + '<button class="wf-tb-btn" id="wf-add-episode-btn" title="新增下一集（基于当前集续写）"' + (isBusy ? " disabled" : "") + '><i class="fa fa-plus"></i> 新增剧集</button>'
        + (canDelEp ? '<button class="wf-tb-btn danger" id="wf-del-episode-btn" title="删除当前剧集"' + (isBusy ? " disabled" : "") + '><i class="fa fa-trash-o"></i></button>' : '')) : '')
      + '<div class="wf-toolbar-sep"></div>'
      + '<div class="wf-review-setting"><span>审核重试:</span><select id="wf-review-retries">'
      + [0,1,2,3,5].map(function(n){ var sel = _getReviewMaxRetries() === n ? " selected" : ""; return '<option value="'+n+'"'+sel+'>'+(n===0?'关闭':n+'次')+'</option>'; }).join("")
      + '</select></div>'
      + '<div class="wf-toolbar-sep"></div>'
      + '<button class="wf-tb-btn primary" id="wf-run-btn"' + (isBusy ? " disabled" : "") + '><i class="fa fa-play"></i> 一键执行</button>'
      + (isAutoRunning ? '<button class="wf-tb-btn danger" id="wf-stop-btn"><i class="fa fa-stop"></i> 停止</button>' : '')
      + '</div>';
  }

  /* ── Pipeline Header ── */
  function renderPipelineHeader(engine) {
    var wf = engine.current();
    var allSteps = engine.pipeline;
    var html = '<div class="wf-pipeline-header">';

    allSteps.forEach(function (step, i) {
      var def = NR.get(step.nodeType);
      if (!def) return;
      var isSkipped = wf && wf[step.nodeType + "Skip"];
      var isRunning = false;
      if (wf) {
        var runKeys = Object.keys(engine._state(wf.id).runningNodes);
        var needle = step.category === "segment" ? "_" + step.nodeType + "_" : step.nodeType + "_";
        for (var ki = 0; ki < runKeys.length; ki++) {
          if (runKeys[ki].indexOf(needle) >= 0) { isRunning = true; break; }
        }
      }
      var statusCls = isRunning ? "running" : (isSkipped ? "skipped" : "");
      var selected = engine.selectedNodeKey === step.nodeType ? "selected" : "";
      var isPlan = (step.nodeType === "planCharactersScenes" || step.nodeType === "planFrames");

      if (i > 0) {
        html += '<div class="wf-pipe-connector"><div class="wf-pipe-line-solid"></div></div>';
      }

      html += '<div class="wf-pipe-node ' + statusCls + ' ' + selected + (isPlan ? ' wf-pipe-plan' : '') + '" data-pipe-node="' + step.nodeType + '">'
        + '<div class="wf-pipe-icon" style="background:' + def.color + '22;color:' + def.color + '"><i class="fa ' + def.icon + '"></i></div>'
        + '<div class="wf-pipe-label">' + def.label + (isSkipped ? ' <span style="font-size:9px;color:#64748b;">(跳过)</span>' : '') + (isRunning ? ' <span style="font-size:9px;color:#60a5fa;"><i class="fa fa-spinner fa-spin"></i> 生成中</span>' : '') + '</div>'
        + '</div>';
    });

    html += '</div>';
    return html;
  }

  /* ── Global-Only Content (for simple templates without segments) ── */
  function renderGlobalOnlyContent(engine, wf) {
    var globalSteps = engine.pipeline.filter(function (s) { return s.category === "global"; });
    var html = '<div class="wf-content-area">';
    html += '<div class="wf-content-inner" id="wf-content-inner" style="transform:translate(' + engine.panX + 'px,' + engine.panY + 'px) scale(' + engine.zoom + ');transform-origin:0 0;">';
    html += '<div class="wf-content-grid"><div class="wf-global-cols">';

    var curEpGO = engine.currentEpisode ? engine.currentEpisode(wf) : null;
    var displayPlotGO = (curEpGO && curEpGO.index > 0) ? (curEpGO.plot || "") : (wf.input.plot || "");

    globalSteps.forEach(function (step) {
      var def = NR.get(step.nodeType);
      if (!def) return;
      var isInputLike = (step.nodeType === "input" || step.nodeType === "fpInput");
      if (isInputLike) {
        html += '<div class="wf-gcol" data-col="' + step.nodeType + '"><div class="wf-col-header">' + def.label + '</div><div class="wf-col-body">';
        if (displayPlotGO) {
          html += '<div class="wf-content-card" data-node-key="' + step.nodeType + '">';
          html += '<div class="wf-card-text">' + esc(displayPlotGO) + '</div>';
          if (wf.input.style) html += '<div class="wf-card-tag">风格: ' + esc(wf.input.style) + '</div>';
          if (wf.input.duration) html += '<div class="wf-card-tag">时长: ' + wf.input.duration + '秒</div>';
          if (wf.input.firstFrameUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(wf.input.firstFrameUrl) + '" style="max-height:120px;margin-top:6px;">';
          if (wf.input.lastFrameUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(wf.input.lastFrameUrl) + '" style="max-height:120px;margin-top:6px;">';
          html += '</div>';
        } else {
          html += '<div class="wf-content-empty">点击上方节点填写</div>';
        }
        html += '</div></div>';
      } else {
        var arr = wf[step.nodeType + "s"] || [];
        html += '<div class="wf-gcol" data-col="' + step.nodeType + '"><div class="wf-col-header">' + def.label + '</div><div class="wf-col-body">';
        html += renderContentCard(engine, step.nodeType, arr[0], 0, null);
        html += '</div></div>';
      }
    });

    html += '</div></div></div></div>';
    return html;
  }

  /* ── Generic Pipeline Content (for non-video templates) ──
   * 完全按 engine.pipeline 动态生成列，不依赖硬编码字段名。
   * 每个 global 节点一个列，segments 区域每个 segment 节点一列。
   */
  function renderGenericPipelineContent(engine, wf) {
    var globalSteps = engine.pipeline.filter(function (s) { return s.category === "global"; });
    var segSteps = engine.pipeline.filter(function (s) { return s.category === "segment"; });
    var segments = wf.segments || [];
    var html = '<div class="wf-content-area">';
    // 模板级 topbar（如果模板定义了 topbarHtml）
    try {
      var tpl = (window.WF_Templates || []).find(function (t) { return t.id === wf.templateId; });
      var topFn = tpl && tpl.pipeline && tpl.pipeline.topbarHtml;
      if (typeof topFn === "function") {
        html += topFn(engine, wf);
      }
    } catch (e) { /* ignore topbar failure */ }
    html += '<div class="wf-content-inner" id="wf-content-inner" style="transform:translate(' + engine.panX + 'px,' + engine.panY + 'px) scale(' + engine.zoom + ');transform-origin:0 0;">';
    html += '<div class="wf-content-grid">';

    // 全局节点列
    html += '<div class="wf-global-cols">';
    globalSteps.forEach(function (step) {
      var def = NR.get(step.nodeType);
      if (!def) return;
      if (wf[step.nodeType + "Skip"]) return;
      var isInputLike = (step.nodeType === "input" || step.nodeType === "fpInput" || step.nodeType === "rcInput" || step.nodeType === "vrInput");
      html += '<div class="wf-gcol" data-col="' + step.nodeType + '">'
        + '<div class="wf-col-header">' + def.label + '</div>'
        + '<div class="wf-col-body">';
      if (isInputLike) {
        // 输入节点：直接读 wf.input，不走 node 版本机制
        var inp = wf.input || {};
        var hasContent = inp.plot || inp.videoUrl;
        if (hasContent) {
          html += '<div class="wf-content-card" data-node-key="' + step.nodeType + '_0">';
          if (inp.plot) html += '<div class="wf-card-text">' + esc(inp.plot).slice(0, 200) + '</div>';
          if (inp.style) html += '<div class="wf-card-tag">风格: ' + esc(inp.style) + '</div>';
          if (inp.direction) html += '<div class="wf-card-tag">二创: ' + esc(inp.direction).slice(0, 30) + '</div>';
          if (inp.videoFilename) html += '<div class="wf-card-tag">视频: ' + esc(inp.videoFilename) + '</div>';
          html += '</div>';
        } else {
          html += '<div class="wf-content-empty">点击上方节点填写</div>';
        }
      } else {
        var arr = wf[step.nodeType + "s"] || [];
        html += renderContentCard(engine, step.nodeType, arr[0], 0, null);
      }
      html += '</div></div>';
    });
    html += '</div>';

    // 段落节点矩阵
    if (segments.length && segSteps.length) {
      var visibleSegSteps = segSteps.filter(function (s) { return !wf[s.nodeType + "Skip"]; });
      html += '<div class="wf-seg-area">';
      // Header row
      html += '<div class="wf-seg-header-row">';
      html += '<div class="wf-seg-label-col-header">段落</div>';
      visibleSegSteps.forEach(function (col) {
        var def = NR.get(col.nodeType);
        html += '<div class="wf-seg-col-header">' + (def ? def.label : col.nodeType) + '</div>';
      });
      html += '</div>';
      // Segment rows
      segments.forEach(function (seg, segIdx) {
        var segRunning = engine.isSegmentRunning(segIdx);
        var segRunBtn = segRunning
          ? '<button class="wf-seg-run-btn stop" data-seg-stop="' + segIdx + '" title="停止"><i class="fa fa-stop"></i></button>'
          : '<button class="wf-seg-run-btn play" data-seg-run="' + segIdx + '" title="执行本段"><i class="fa fa-play"></i></button>';
        html += '<div class="wf-seg-row">';
        html += '<div class="wf-seg-label-cell"><div class="wf-seg-num">第' + (segIdx + 1) + '段</div>'
          + segRunBtn
          + '<div class="wf-seg-script-preview">' + esc((seg.text || seg.scriptText || "").slice(0, 40)) + '</div></div>';
        visibleSegSteps.forEach(function (col) {
          html += '<div class="wf-seg-cell">';
          var sArr = seg[col.nodeType + "s"] || [];
          var typeDef = NR.get(col.nodeType);
          if (typeDef && typeDef.allowMultiple && sArr.length > 0) {
            for (var si = 0; si < sArr.length; si++) {
              html += renderContentCard(engine, col.nodeType, sArr[si], si, segIdx);
            }
          } else {
            html += renderContentCard(engine, col.nodeType, sArr[0], 0, segIdx);
          }
          html += '</div>';
        });
        html += '</div>';
      });
      html += '</div>';
    }

    html += '</div></div></div>';
    return html;
  }

  /* ── Content Area ── */
  function renderContentArea(engine) {
    var wf = engine.current();
    if (!wf) return '<div class="wf-content-area"></div>';
    var segSteps = engine.getSegmentSteps();

    // 所有模板统一走通用 pipeline 渲染（含 video-short-drama）
    if (wf.templateId) {
      return renderGenericPipelineContent(engine, wf);
    }

    if (!segSteps.length) {
      return renderGlobalOnlyContent(engine, wf);
    }

    var segments = wf.segments || [];
    var branchCount = engine.getBranchCount(wf);
    var segSteps = engine.getSegmentSteps();
    var visibleSegSteps = segSteps.filter(function (s) { return !wf[s.nodeType + "Skip"]; });
    var isMulti = wf.mode === "multi";

    var html = '<div class="wf-content-area">';
    html += '<div class="wf-content-inner" id="wf-content-inner" style="transform:translate(' + engine.panX + 'px,' + engine.panY + 'px) scale(' + engine.zoom + ');transform-origin:0 0;">';
    html += '<div class="wf-content-grid">';

    var curEpRC = engine.currentEpisode ? engine.currentEpisode(wf) : null;
    var displayPlotRC = (curEpRC && curEpRC.index > 0) ? (curEpRC.plot || "") : (wf.input.plot || "");

    // -- Input column --
    html += '<div class="wf-global-cols"><div class="wf-gcol" data-col="input"><div class="wf-col-header">输入'
      + (curEpRC && curEpRC.index > 0 ? ' · 第' + (curEpRC.index + 1) + '集' : '')
      + '</div><div class="wf-col-body">';
    if (displayPlotRC) {
      html += '<div class="wf-content-card" data-node-key="input">'
        + '<div class="wf-card-text">' + esc(displayPlotRC) + '</div>'
        + (wf.input.style ? '<div class="wf-card-tag">风格: ' + esc(wf.input.style) + '</div>' : '')
        + '</div>';
    } else {
      html += '<div class="wf-content-empty">点击上方节点填写</div>';
    }
    html += '</div></div>';

    // -- Episode Plan column --（仅多集时渲染为可见卡片；单集视为透传）
    if (!wf.episodePlanSkip) {
      var epCountRC = parseInt(wf.input && wf.input.episodeCount) || 0;
      if (epCountRC > 1) {
        var epArr = wf.episodePlans || [];
        html += '<div class="wf-gcol" data-col="episodePlan"><div class="wf-col-header">剧集规划</div><div class="wf-col-body">';
        html += renderContentCard(engine, "episodePlan", epArr[0], 0, null);
        html += '</div></div>';
      }
    }

    // -- Script column --
    if (!wf.scriptSkip) {
      var scriptArr = wf.scripts || [];
      var scriptCount = isMulti ? (wf.scriptCount || 1) : 1;
      html += '<div class="wf-gcol" data-col="script"><div class="wf-col-header">剧本</div><div class="wf-col-body">';
      for (var si = 0; si < scriptCount; si++) {
        html += renderContentCard(engine, "script", scriptArr[si], si, null);
      }
      html += '</div></div>';
    }

    html += '</div>';

    // -- Segment area --
    if (segments.length) {
      // planCharactersScenes 列
      if (!wf.planCharactersScenesSkip) {
        var pcsArr = wf.planCharactersSceness || [];
        html += '<div class="wf-global-cols"><div class="wf-gcol wf-gcol-plan" data-col="planCharactersScenes"><div class="wf-col-header">人物场景规划</div><div class="wf-col-body">';
        html += renderContentCard(engine, "planCharactersScenes", pcsArr[0], 0, null);
        html += '</div></div></div>';
      }

      // 主要人物单独一列（只渲染一次，所有段落复用）
      if (!wf.mainCharactersSkip) {
        var mcArr = wf.mainCharacterss || [];
        var mcCount = isMulti ? branchCount : 1;
        html += '<div class="wf-global-cols"><div class="wf-gcol" data-col="mainCharacters"><div class="wf-col-header">主要人物</div><div class="wf-col-body">';
        for (var mi = 0; mi < mcCount; mi++) {
          html += renderContentCard(engine, "mainCharacters", mcArr[mi], mi, null);
        }
        html += '</div></div></div>';
      }

      var allSegCols = [];
      visibleSegSteps.forEach(function (s) {
        var def = NR.get(s.nodeType);
        allSegCols.push({ nodeType: s.nodeType, label: def ? def.label : s.nodeType });
      });

      html += '<div class="wf-seg-area">';

      // Header row
      html += '<div class="wf-seg-header-row">';
      html += '<div class="wf-seg-label-col-header">段落</div>';
      allSegCols.forEach(function (col) {
        var planCls = col.nodeType === "planFrames" ? " wf-seg-col-plan" : "";
        html += '<div class="wf-seg-col-header' + planCls + '">' + col.label + '</div>';
      });
      html += '</div>';

      // Segment rows
      for (var bi = 0; bi < branchCount; bi++) {
        if (branchCount > 1) {
          html += '<div class="wf-branch-header">分支 ' + (bi + 1) + '</div>';
        }
        segments.forEach(function (seg, segIdx) {
          var segRunning = engine.isSegmentRunning(segIdx);
          var segRunBtn = segRunning
            ? '<button class="wf-seg-run-btn stop" data-seg-stop="' + segIdx + '" title="停止"><i class="fa fa-stop"></i></button>'
            : '<button class="wf-seg-run-btn play" data-seg-run="' + segIdx + '" title="执行本段"><i class="fa fa-play"></i></button>';
          html += '<div class="wf-seg-row">';
          html += '<div class="wf-seg-label-cell"><div class="wf-seg-num">第' + (segIdx + 1) + '段</div>'
            + segRunBtn
            + '<div class="wf-seg-script-preview">' + esc((seg.scriptText || "").slice(0, 40)) + '</div></div>';

          allSegCols.forEach(function (col) {
            var planCls = col.nodeType === "planFrames" ? " wf-seg-cell-plan" : "";
            html += '<div class="wf-seg-cell' + planCls + '">';
            var sArr = seg[col.nodeType + "s"] || [];
            html += renderContentCard(engine, col.nodeType, sArr[bi], bi, segIdx);
            html += '</div>';
          });

          html += '</div>';
        });
      }
      html += '</div>';
    } else if (!wf.mainCharactersSkip) {
      // No segments yet, show mainCharacters as standalone column
      var mcArr = wf.mainCharacterss || [];
      var mcCount = isMulti ? branchCount : 1;
      html += '<div class="wf-global-cols"><div class="wf-gcol" data-col="mainCharacters"><div class="wf-col-header">主要人物</div><div class="wf-col-body">';
      for (var mi = 0; mi < mcCount; mi++) {
        html += renderContentCard(engine, "mainCharacters", mcArr[mi], mi, null);
      }
      html += '</div></div></div>';
    }

    html += '</div></div>';
    return html;
  }

  /* ── Content Card (renders generated data for a node) ── */
  function collectRefImages(engine, branchIdx, segIndex) {
    var wf = engine.current();
    if (!wf) return [];
    var refs = [];

    // 获取本段出场人物名单（用于过滤）
    var appearingNames = null;
    if (segIndex !== null && wf.segments && wf.segments[segIndex]) {
      var seg_ = wf.segments[segIndex];
      var pfNd_ = (seg_.planFramess || [])[0];
      if (pfNd_) {
        var pfV_ = NR.getActiveVersion(pfNd_);
        if (pfV_ && Array.isArray(pfV_.appearingCharacters)) {
          appearingNames = pfV_.appearingCharacters;
        } else {
          var hist_ = pfNd_.planningHistory || [];
          for (var hi = hist_.length - 1; hi >= 0; hi--) {
            if (Array.isArray((hist_[hi] || {}).appearing_characters)) {
              appearingNames = hist_[hi].appearing_characters;
              break;
            }
          }
        }
      }
    }
    var nameSet = null;
    if (Array.isArray(appearingNames)) {
      nameSet = {};
      appearingNames.forEach(function (n) { if (typeof n === "string") nameSet[n.trim()] = true; });
    }

    if (!wf.mainCharactersSkip) {
      var mcArr = wf.mainCharacterss || [];
      var mcV = NR.getActiveVersion(mcArr[branchIdx] || mcArr[0]);
      if (mcV && mcV.characters) {
        mcV.characters.forEach(function (c) {
          if (!c.imageUrl) return;
          if (nameSet && !nameSet[(c.name || "").trim()]) return;
          refs.push({ label: "主要人物·" + c.name, url: c.imageUrl });
        });
      }
    }
    if (segIndex === null || !wf.segments || !wf.segments[segIndex]) return refs;
    var seg = wf.segments[segIndex];
    if (!seg.minorCharactersSkip) {
      var minorV = NR.getActiveVersion((seg.minorCharacterss || [])[branchIdx] || (seg.minorCharacterss || [])[0]);
      if (minorV && minorV.characters) {
        minorV.characters.forEach(function (c) {
          if (!c.imageUrl) return;
          if (nameSet && !nameSet[(c.name || "").trim()]) return;
          refs.push({ label: "次要人物·" + c.name, url: c.imageUrl });
        });
      }
    }
    if (!seg.sceneSkip) {
      var sceneV = NR.getActiveVersion((seg.scenes || [])[branchIdx] || (seg.scenes || [])[0]);
      if (sceneV && sceneV.scenes) {
        sceneV.scenes.forEach(function (sc) {
          if (sc.imageUrl) refs.push({ label: "场景·" + (sc.name || ""), url: sc.imageUrl });
        });
      } else if (sceneV && sceneV.imageUrl) {
        refs.push({ label: "场景", url: sceneV.imageUrl });
      }
    }
    if (!seg.firstFrameSkip) {
      var ffV = NR.getActiveVersion((seg.firstFrames || [])[branchIdx] || (seg.firstFrames || [])[0]);
      if (ffV && ffV.imageUrl) refs.push({ label: "首帧画面", url: ffV.imageUrl });
    }
    if (!seg.storyboardSkip) {
      var sbV = NR.getActiveVersion((seg.storyboards || [])[branchIdx] || (seg.storyboards || [])[0]);
      if (sbV && sbV.images) {
        sbV.images.forEach(function (url, i) { refs.push({ label: "分镜图", url: url }); });
      }
    }
    if (!seg.lastFrameSkip) {
      var lfV = NR.getActiveVersion((seg.lastFrames || [])[branchIdx] || (seg.lastFrames || [])[0]);
      if (lfV && lfV.imageUrl) refs.push({ label: "尾帧画面", url: lfV.imageUrl });
    }
    return refs;
  }

  function renderContentCard(engine, nodeType, nd, branchIdx, segIndex) {
    if (!nd) {
      var emptyKey = segIndex !== null ? "seg_" + segIndex + "_" + nodeType + "_" + branchIdx : nodeType + "_" + branchIdx;
      return '<div class="wf-content-card" data-node-key="' + emptyKey + '"><div class="wf-card-empty">未生成</div></div>';
    }
    var v = NR.getActiveVersion(nd);
    var statusCls = nd.status || "idle";
    var key = segIndex !== null ? "seg_" + segIndex + "_" + nodeType + "_" + branchIdx : nodeType + "_" + branchIdx;
    var branchLabel = branchIdx > 0 ? ' <span class="wf-branch-badge">#' + (branchIdx + 1) + '</span>' : "";
    var isRunning = !!engine.runningNodes[key];
    var isReviewing = engine.runningNodes[key] === "reviewing";
    // 单独生成某一项（如 mainCharacters_0_char_2、seg_0_scene_0_item_1）时，卡片也视为 running
    var hasItemRunning = false;
    if (!isRunning) {
      var prefix = key + "_";
      var runKeys = Object.keys(engine.runningNodes);
      for (var rki = 0; rki < runKeys.length; rki++) {
        if (runKeys[rki].indexOf(prefix) === 0) { isRunning = true; hasItemRunning = true; break; }
      }
    }

    var html = '<div class="wf-content-card status-' + statusCls + (isRunning ? ' running' : '') + '" data-node-key="' + key + '">';

    if (branchLabel) html += '<div class="wf-card-branch">' + branchLabel + '</div>';
    if (hasItemRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 正在生成...</div>';

    var typeDef = NR.get(nodeType);
    var isImageNode = typeDef && typeDef.needsImage;

    if (isReviewing) {
      html += '<div class="wf-card-reviewing"><i class="fa fa-search"></i> 审核中...</div>';
    } else if (isRunning && !v) {
      html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成中...</div>';
    } else if (!v) {
      html += '<div class="wf-card-empty">未生成</div>';
    } else if (nodeType === "script") {
      html += '<div class="wf-card-text">' + esc(v.fullText || "").slice(0, 300) + '</div>';
      if (v.segments && v.segments.length) {
        html += '<div class="wf-card-tag">' + v.segments.length + ' 段</div>';
      }
    } else if (nodeType === "episodePlan") {
      var epList = v.episodes || [];
      if (epList.length) {
        html += '<div class="wf-card-tag">共 ' + epList.length + ' 集</div>';
        epList.forEach(function (ep, i) {
          html += '<div class="wf-ep-plan-item">'
            + '<div class="wf-ep-plan-title">' + esc(ep.title || ("第" + (i + 1) + "集")) + '</div>'
            + '<div class="wf-ep-plan-plot">' + esc((ep.plot || "").slice(0, 140)) + ((ep.plot || "").length > 140 ? '…' : '') + '</div>'
            + '</div>';
        });
      } else {
        html += '<div class="wf-card-text">已规划</div>';
      }
    } else if (nodeType === "planCharactersScenes") {
      var mc = v.mainCharacters || [];
      var segs = v.segments || [];
      if (mc.length) html += '<div class="wf-card-text">主要人物: ' + mc.map(function(c){return esc(c.name);}).join("、") + '</div>';
      if (segs.length) html += '<div class="wf-card-tag">' + segs.length + ' 段已规划</div>';
      if (!mc.length && !segs.length) html += '<div class="wf-card-text">已规划</div>';
    } else if (nodeType === "planFrames") {
      var ff = v.firstFrame || {};
      var sb = v.storyboard || {};
      var lf = v.lastFrame || {};
      var parts = [];
      if (ff.description) parts.push("首帧");
      if (sb.grid_prompts && sb.grid_prompts.length) parts.push("分镜" + sb.grid_prompts.length + "格");
      if (lf.description) parts.push("尾帧");
      html += '<div class="wf-card-text">' + (parts.length ? parts.join(" + ") : "已规划") + '</div>';
    } else if (nodeType === "mainCharacters" || nodeType === "minorCharacters") {
      var chars = v.characters || [];
      chars.forEach(function (c) {
        html += '<div class="wf-char-card">';
        if (c.imageUrl) html += '<img class="wf-char-img wf-preview-img" src="' + esc(c.imageUrl) + '" data-preview="' + esc(c.imageUrl) + '">';
        html += '<div class="wf-char-info">'
          + '<div class="wf-char-name">' + esc(c.name) + '</div>'
          + '<div class="wf-char-desc">' + esc(c.description || "").slice(0, 100) + '</div>'
          + '</div></div>';
      });
      if (!chars.length) html += '<div class="wf-card-empty">无角色</div>';
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成图片中...</div>';
    } else if (nodeType === "scene") {
      if (v.scenes && v.scenes.length) {
        v.scenes.forEach(function (sc, i) {
          html += '<div class="wf-scene-card"><div class="wf-scene-label">' + esc(sc.name || ("场景" + (i + 1))) + '</div>';
          if (sc.imageUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(sc.imageUrl) + '" data-preview="' + esc(sc.imageUrl) + '">';
          html += '<div class="wf-card-text" style="font-size:10px;">' + esc(sc.description || "").slice(0, 80) + '</div></div>';
        });
      } else if (v.description) {
        html += '<div class="wf-card-text">' + esc(v.description).slice(0, 150) + '</div>';
        if (v.imageUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.imageUrl) + '" data-preview="' + esc(v.imageUrl) + '">';
      }
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成图片中...</div>';
    } else if (nodeType === "storyboard") {
      var _wf = engine.current();
      var isTemplateMode = _wf && _wf.dramaMode === "template";
      if (v.gridPrompts && v.gridPrompts.length) {
        html += '<div class="wf-card-text" style="font-size:10px;">' + v.gridPrompts.length + '格分镜</div>';
      } else if (v.description) {
        html += '<div class="wf-card-text" style="font-size:10px;">' + esc(v.description).slice(0, 80) + '</div>';
      }
      if (isTemplateMode && v.gridPrompts && v.gridPrompts.length) {
        // Mode 3: 显示纯文本分镜 + 组织状态（从故事模板节点读取）
        html += '<div class="wf-card-tag" style="color:#f59e0b;font-size:9px;">模式板 · 待出图</div>';
        var stSeg = _wf.segments && _wf.segments[segIndex];
        var stNd = stSeg ? (stSeg.storyTemplates || [])[0] : null;
        var stV = stNd ? NR.getActiveVersion(stNd) : null;
        if (stV && stV.organizedPrompt) {
          html += '<div class="wf-card-text" style="font-size:9px;color:#10b981;">提示词已组织</div>';
        }
      }
      var imgs = v.images || [];
      if (imgs.length) {
        var cols = Math.ceil(Math.sqrt(imgs.length));
        html += '<div class="wf-sb-grid" style="grid-template-columns:repeat(' + cols + ',1fr)">';
        imgs.forEach(function (url) { html += '<img class="wf-sb-img wf-preview-img" src="' + esc(url) + '" data-preview="' + esc(url) + '">'; });
        html += '</div>';
      }
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成图片中...</div>';
    } else if (nodeType === "firstFrame" || nodeType === "lastFrame" || nodeType === "singleStoryboard") {
      if (v.description) html += '<div class="wf-card-text">' + esc(v.description).slice(0, 100) + '</div>';
      if (v.imageUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.imageUrl) + '" data-preview="' + esc(v.imageUrl) + '">';
      if (nodeType === "singleStoryboard") {
        html += '<div class="wf-card-tag" style="font-size:9px;">单分镜帧</div>';
      }
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成图片中...</div>';
    } else if (nodeType === "videoPrompt" || nodeType === "framePrompt") {
      if (v.fullText) html += '<div class="wf-card-text">' + esc(v.fullText).slice(0, 300) + '</div>';
      if (nodeType === "videoPrompt") {
        var refImgs = collectRefImages(engine, branchIdx, segIndex);
        if (refImgs.length) {
          html += '<div class="wf-ref-images">';
          refImgs.forEach(function (r) {
            html += '<div class="wf-ref-img-item"><img class="wf-ref-img wf-preview-img" src="' + esc(r.url) + '" data-preview="' + esc(r.url) + '"><span class="wf-ref-img-label">@' + esc(r.label) + '</span></div>';
          });
          html += '</div>';
        }
      }
      html += '<button class="wf-copy-btn" data-copy-vp="' + key + '"><i class="fa fa-copy"></i> 复制全部</button>';
    } else if (nodeType === "storyTemplate") {
      if (v.organizedPrompt) {
        var orgPreview = String(v.organizedPrompt).slice(0, 200);
        if (v.organizedPrompt.length > 200) orgPreview += "…";
        html += '<div class="wf-card-text" style="font-size:10px;line-height:1.4;white-space:pre-wrap;">' + esc(orgPreview) + '</div>';
        html += '<div class="wf-card-tag" style="color:#10b981;">提示词已组织</div>';
      }
      if (v.kind === "text" && v.markdown) {
        var preview = String(v.markdown).split("\n").slice(0, 6).join("\n");
        if (v.markdown.length > preview.length) preview += "\n…";
        html += '<pre class="wf-card-text" style="font-family:monospace;font-size:11px;white-space:pre;overflow:hidden;max-height:140px;">' + esc(preview) + '</pre>';
      } else if (v.imageUrl) {
        html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.imageUrl) + '" data-preview="' + esc(v.imageUrl) + '">';
      } else if (!v.organizedPrompt) {
        html += '<div class="wf-card-text">已生成</div>';
      }
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成中...</div>';
    } else if (nodeType === "vrVideoPromptReverse") {
      if (v.full_text) {
        html += '<div class="wf-card-text" style="font-size:11px;line-height:1.5;white-space:pre-wrap;">' + esc(v.full_text).slice(0, 600) + (v.full_text.length > 600 ? '…' : '') + '</div>';
        html += '<div class="wf-card-tag">' + v.full_text.length + ' 字 · ' + (v.duration || 0) + 's</div>';
        html += '<button class="wf-copy-btn" data-copy-vp="' + key + '"><i class="fa fa-copy"></i> 复制全部</button>';
      } else {
        html += '<div class="wf-card-empty">未生成</div>';
      }
    } else if (nodeType.indexOf("rc") === 0) {
      // 二创工作流节点：用节点定义的 getPreview + 通用图片预览
      var def = NR.get(nodeType);
      var preview = def && def.getPreview ? def.getPreview(nd) : "";
      if (preview) html += '<div class="wf-card-text">' + esc(preview).slice(0, 200) + '</div>';
      if (v.imageUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.imageUrl) + '" data-preview="' + esc(v.imageUrl) + '">';
      if (v.grid && v.grid.url) html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.grid.url) + '" data-preview="' + esc(v.grid.url) + '">';
      // 多张缩略图（如关键帧列表、人物/场景列表）
      if (v.frames && v.frames.length) {
        html += '<div class="wf-ref-images" style="flex-wrap:wrap;gap:3px;">';
        v.frames.slice(0, 8).forEach(function (f) {
          if (f && f.url) html += '<img src="' + esc(f.url) + '" style="width:40px;height:28px;object-fit:cover;border-radius:3px;" data-preview="' + esc(f.url) + '">';
        });
        if (v.frames.length > 8) html += '<span style="font-size:10px;color:#94a3b8;align-self:center;">+' + (v.frames.length - 8) + '</span>';
        html += '</div>';
      }
      var itemList = v.characters || v.scenes;
      if (itemList && itemList.length) {
        html += '<div class="wf-ref-images" style="flex-wrap:wrap;gap:3px;">';
        itemList.slice(0, 6).forEach(function (it) {
          if (it && it.imageUrl) html += '<img src="' + esc(it.imageUrl) + '" style="width:40px;height:40px;object-fit:cover;border-radius:3px;" data-preview="' + esc(it.imageUrl) + '">';
        });
        html += '</div>';
      }
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成中...</div>';
    }

    if (nd && nd.status === "error") {
      html += '<div class="wf-card-error"><i class="fa fa-exclamation-triangle"></i> 生成失败';
      if (nd.errorMsg) html += '：' + esc(nd.errorMsg).slice(0, 100);
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  /* ── Detail Panel ── */
  function renderDetailPanel(engine) {
    if (!engine.detailOpen || !engine.selectedNodeKey) return "";
    var wf = engine.current();
    if (!wf) return "";
    var key = engine.selectedNodeKey;
    var nodeType = parseNodeType(key);
    var def = NR.get(nodeType);
    if (!def) return "";

    var isPipelineNode = (key === nodeType);
    var nd = getNodeDataByKey(engine, key);
    var segIdx = parseSegIndex(key);
    var branchIdx = parseBranchIdx(key);

    var html = '<div class="wf-detail-inner">';
    html += '<div class="wf-detail-title">' + def.label
      + (segIdx !== null ? ' · 段' + (segIdx + 1) : '')
      + (branchIdx > 0 ? ' #' + (branchIdx + 1) : '')
      + '</div>';

    if (isPipelineNode && nodeType !== "input" && nodeType !== "fpInput" && nodeType !== "rcInput" && nodeType !== "rcOutput" && nodeType !== "rcKeyframes") {
      html += renderModelSelect(engine, nodeType);
      if (nodeType !== "planCharactersScenes" && nodeType !== "planFrames" && nodeType !== "episodePlan") {
        html += renderSkipToggle(engine, key);
      }
      if (nodeType === "storyboard") {
        html += renderGridControl(engine);
      }
      if (nodeType === "storyTemplate") {
        html += renderStoryTemplateOrientation(engine);
      }
    }

    if (def.renderDetail) {
      var customHtml = def.renderDetail(nd, wf, { segIndex: segIdx, branchIdx: branchIdx, engine: engine, isPipelineNode: isPipelineNode });
      if (customHtml) html += customHtml;
    }

    if (isPipelineNode && def.category === "segment") {
      var disabledAttr = engine.isAnyRunning() ? " disabled" : "";
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-all-seg="' + nodeType + '"' + disabledAttr + '><i class="fa fa-play"></i> 全部段落生成</button></div>';
    }

    if (!isPipelineNode) {
      html += renderVersionList(nd);
      html += '<div class="wf-detail-actions">';
      var isNodeBusy = engine.isNodeRunning(nodeType, segIdx);
      if (NR.getActiveVersion(nd)) {
        html += '<button class="wf-tb-btn danger" data-clear-node="' + key + '"' + (isNodeBusy ? " disabled" : "") + '><i class="fa fa-trash-o"></i> 清空</button>';
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function renderCountControl(engine, key) {
    var wf = engine.current();
    if (!wf) return "";
    var nodeType = parseNodeType(key);
    var segIdx = parseSegIndex(key);
    var def = NR.get(nodeType);
    if (!def || !def.allowMultiple) return "";
    var countKey = nodeType + "Count";
    var currentCount;
    if (segIdx !== null) {
      var seg = wf.segments[segIdx];
      currentCount = seg ? (seg[countKey] || 1) : 1;
    } else {
      currentCount = wf[countKey] || 1;
    }
    return '<div class="wf-detail-section"><div class="wf-detail-label">生成数量</div>'
      + '<div class="wf-count-control">'
      + '<button class="wf-count-btn" data-count-delta="-1" data-count-node="' + key + '">-</button>'
      + '<span class="wf-count-value">' + currentCount + '</span>'
      + '<button class="wf-count-btn" data-count-delta="1" data-count-node="' + key + '">+</button>'
      + '</div></div>';
  }

  function renderModelSelect(engine, nodeType) {
    var wf = engine.current();
    if (!wf) return "";
    var gc = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
    var cfg = gc[nodeType] || {};
    var list = (window.GLOBAL && window.GLOBAL.configList) || [];
    // video 模板节点 + 二创纯文本节点 都用聊天模型
    var needsChat = [
      "script", "planCharactersScenes", "planFrames", "videoPrompt", "framePrompt",
      "episodePlan",
      "rcPlotAlign", "rcPlotRewrite"
    ].indexOf(nodeType) >= 0;
    var needsImage = [
      "mainCharacters", "minorCharacters", "scene", "firstFrame", "storyboard", "lastFrame", "storyTemplate",
      "rcStoryboardRemix"
    ].indexOf(nodeType) >= 0;
    // 视觉模型（帧标注、段内选帧、分段审核、二创分镜对话 都需要视觉 LLM）
    var needsVision = ["rcFrameLabel", "rcRepFrames", "rcSmartSegment", "rcStoryboardOrig", "rcStoryboardRemix", "rcVideoPrompt", "vrVideoPromptReverse"].indexOf(nodeType) >= 0;
    var dirty = false;
    var html = '';
    if (needsVision) {
      var visionConfigs = list.filter(function (c) { return c.config_type === "chat" || c.config_type === "both"; });
      if (!cfg.visionConfigId && visionConfigs.length) { cfg.visionConfigId = visionConfigs[0].id; dirty = true; }
      html += '<div class="wf-detail-section"><div class="wf-detail-label">视觉模型（需支持图片输入：GPT-4o / Claude-3.5+ / Gemini-Vision 等）</div>'
        + '<select class="wf-detail-input" data-node-config="' + nodeType + '" data-config-key="visionConfigId">';
      visionConfigs.forEach(function (c) {
        html += '<option value="' + c.id + '"' + (cfg.visionConfigId === c.id ? " selected" : "") + '>' + esc(c.name) + '</option>';
      });
      html += '</select></div>';
    }
    if (needsChat) {
      var chatConfigs = list.filter(function (c) { return c.config_type === "chat" || c.config_type === "both"; });
      if (!cfg.chatConfigId && chatConfigs.length) { cfg.chatConfigId = chatConfigs[0].id; dirty = true; }
      html += '<div class="wf-detail-section"><div class="wf-detail-label">聊天模型</div>'
        + '<select class="wf-detail-input" data-node-config="' + nodeType + '" data-config-key="chatConfigId">';
      chatConfigs.forEach(function (c) {
        html += '<option value="' + c.id + '"' + (cfg.chatConfigId === c.id ? " selected" : "") + '>' + esc(c.name) + '</option>';
      });
      html += '</select></div>';
    }
    if (needsImage) {
      var imgConfigs = list.filter(function (c) { return c.config_type === "image" || c.config_type === "both"; });
      if (!cfg.imageConfigId && imgConfigs.length) { cfg.imageConfigId = imgConfigs[0].id; dirty = true; }
      html += '<div class="wf-detail-section"><div class="wf-detail-label">图片模型</div>'
        + '<select class="wf-detail-input" data-node-config="' + nodeType + '" data-config-key="imageConfigId">';
      imgConfigs.forEach(function (c) {
        html += '<option value="' + c.id + '"' + (cfg.imageConfigId === c.id ? " selected" : "") + '>' + esc(c.name) + '</option>';
      });
      html += '</select></div>';
      var imgCount = parseInt(cfg.imageCount) || 1;
      html += '<div class="wf-detail-section"><div class="wf-detail-label">生成张数</div>'
        + '<select class="wf-detail-input" data-node-config="' + nodeType + '" data-config-key="imageCount">';
      [1, 2, 3, 4].forEach(function (n) {
        html += '<option value="' + n + '"' + (imgCount === n ? " selected" : "") + '>' + n + ' 张</option>';
      });
      html += '</select></div>';
    }
    if (dirty) {
      gc[nodeType] = cfg;
      if (window._saveGlobalNodeConfigs) window._saveGlobalNodeConfigs(gc);
    }
    return html;
  }

  function renderGridControl(engine) {
    var wf = engine.current();
    if (!wf) return "";
    var gc = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
    var sbCfg = gc.storyboard || {};
    var grid = parseInt(sbCfg.grid) || 4;
    var res = sbCfg.resolution || "2160x3840";
    var resOptions = [
      { value: "2160x3840", label: "2160×3840 (9:16 竖版)" },
      { value: "1080x1920", label: "1080×1920 (9:16 竖版)" },
      { value: "1536x1024", label: "1536×1024 (3:2 横版)" },
      { value: "2048x1152", label: "2048×1152 (16:9 横版)" },
      { value: "3840x2160", label: "3840×2160 (16:9 横版)" },
      { value: "1024x1024", label: "1024×1024 (1:1 方形)" },
      { value: "2048x2048", label: "2048×2048 (1:1 方形)" },
      { value: "1024x1536", label: "1024×1536 (2:3 竖版)" },
    ];
    var resHtml = resOptions.map(function (o) {
      return '<option value="' + o.value + '"' + (res === o.value ? " selected" : "") + '>' + o.label + '</option>';
    }).join("");
    var html = '<div class="wf-detail-section"><div class="wf-detail-label">分镜宫格（全局）</div>'
      + '<div class="wf-grid-btns">';
    var standardGrids = [4, 6, 9, 16];
    var extendedGrids = [5, 7, 8, 10, 11, 12];
    var allGrids = standardGrids.concat(extendedGrids).sort(function(a,b){return a-b;});
    var isTemplateMode = wf.dramaMode === "template";
    var showGrids = isTemplateMode ? [5, 6, 7, 8, 9, 10, 11, 12] : standardGrids;
    showGrids.forEach(function (g) {
      if (isTemplateMode) {
        html += '<button class="wf-grid-btn' + (grid === g ? " active" : "") + '" data-grid="' + g + '">' + g + '格</button>';
      } else {
        var labelMap = {4:"2×2",6:"2×3",9:"3×3",16:"4×4"};
        html += '<button class="wf-grid-btn' + (grid === g ? " active" : "") + '" data-grid="' + g + '">' + (labelMap[g] || g) + '</button>';
      }
    });
    html += '</div></div>'
      + '<div class="wf-detail-section"><div class="wf-detail-label">分镜分辨率（全局）</div>'
      + '<select class="wf-detail-input" id="wf-sb-resolution">' + resHtml + '</select>'
      + '</div>';
    return html;
  }

  function renderStoryTemplateOrientation(engine) {
    var gc = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
    var cfg = gc.storyTemplate || {};
    var orient = cfg.orientation === "vertical" ? "vertical" : "horizontal";
    return '<div class="wf-detail-section"><div class="wf-detail-label">排版方向（全局）</div>'
      + '<div class="wf-grid-btns">'
      + '<button class="wf-grid-btn' + (orient === "horizontal" ? " active" : "") + '" data-orientation="horizontal">横版 16:9</button>'
      + '<button class="wf-grid-btn' + (orient === "vertical" ? " active" : "") + '" data-orientation="vertical">竖版 9:16</button>'
      + '</div></div>';
  }

  function renderSkipToggle(engine, key) {
    var nodeType = parseNodeType(key);
    if (nodeType === "input" || nodeType === "fpInput" || nodeType === "output" || nodeType === "script" || nodeType === "framePrompt") return "";
    var wf = engine.current();
    if (!wf) return "";
    var segIdx = parseSegIndex(key);
    var skipKey = nodeType + "Skip";
    var isSkipped;
    if (segIdx !== null) {
      var seg = wf.segments[segIdx];
      isSkipped = seg ? seg[skipKey] : false;
    } else {
      isSkipped = wf[skipKey];
    }
    var checked = isSkipped ? " checked" : "";
    return '<div class="wf-detail-section"><label class="wf-skip-toggle">'
      + '<input type="checkbox" id="wf-skip-check" data-skip-node="' + key + '"' + checked + '>'
      + '<span>跳过此节点（不生成，由模型自行处理）</span></label></div>';
  }

  function renderVersionList(nd) {
    if (!nd || !nd.versions || nd.versions.length <= 1) return "";
    return '<div class="wf-detail-section"><div class="wf-detail-label">历史版本</div>'
      + '<div class="wf-version-list">' + nd.versions.map(function (v) {
        var active = v.id === nd.activeVersionId ? "active" : "";
        var time = v.createdAt ? new Date(v.createdAt).toLocaleString("zh-CN") : v.id;
        return '<div class="wf-version-item ' + active + '" data-version-id="' + v.id + '">'
          + '<span>' + time + '</span>'
          + (active ? '<span class="wf-version-current">当前</span>' : '')
          + '</div>';
      }).join("") + '</div></div>';
  }

  /* ── Key Parsers ── */
  function parseNodeType(key) {
    if (key === "input" || key === "output") return key;
    var segMatch = key.match(/^seg_\d+_(\w+)_\d+$/);
    if (segMatch) return segMatch[1];
    var globalMatch = key.match(/^(\w+)_\d+$/);
    if (globalMatch) return globalMatch[1];
    return key;
  }
  function parseSegIndex(key) {
    var m = key.match(/^seg_(\d+)_/);
    return m ? parseInt(m[1]) : null;
  }
  function parseBranchIdx(key) {
    var m = key.match(/_(\d+)$/);
    return m ? parseInt(m[1]) : 0;
  }
  function getNodeDataByKey(engine, key, createIfMissing) {
    var wf = engine.current();
    if (!wf) return {};
    if (key === "input" || key === "fpInput") return wf.input;
    if (key === "output") return {};
    var segIdx = parseSegIndex(key);
    var nodeType = parseNodeType(key);
    var branchIdx = parseBranchIdx(key);
    if (segIdx !== null) {
      var seg = wf.segments[segIdx];
      if (!seg) return {};
      var arrayKey = nodeType + "s";
      if (!seg[arrayKey]) seg[arrayKey] = [];
      if (createIfMissing && !seg[arrayKey][branchIdx]) {
        while (seg[arrayKey].length <= branchIdx) seg[arrayKey].push(NR.createNodeData());
      }
      return (seg[arrayKey][branchIdx]) || {};
    }
    var arrayKey = nodeType + "s";
    if (!wf[arrayKey]) wf[arrayKey] = [];
    if (createIfMissing && !wf[arrayKey][branchIdx]) {
      while (wf[arrayKey].length <= branchIdx) wf[arrayKey].push(NR.createNodeData());
    }
    return (wf[arrayKey][branchIdx]) || {};
  }

  /* ── Execution History Panel ── */
  function renderExecHistory(engine) {
    var wf = engine.current();
    if (!wf) return "";
    var history = (wf.history || []).slice(-100).reverse();
    var toggle = '<button class="wf-exec-history-toggle" id="wf-exec-history-toggle" title="执行历史"><i class="fa fa-history"></i>'
      + (history.length ? '<span class="wf-exec-history-badge">' + Math.min(history.length, 99) + '</span>' : '')
      + '</button>';
    if (!engine.execHistoryOpen) return toggle;

    var items = history.map(function (h) {
      var def = NR.get(h.nodeType);
      var label = def ? def.label : h.nodeType;
      var segLabel = (h.segIndex !== null && h.segIndex !== undefined) ? ' · 段' + (h.segIndex + 1) : '';
      var itemLabel = h.itemLabel ? ' · ' + esc(h.itemLabel) : '';
      var time = '';
      try {
        var d = new Date(h.time);
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      } catch (e) { time = ''; }
      var dotCls = h.status === 'done' ? 'wf-exec-dot-done'
        : h.status === 'reviewing' ? 'wf-exec-dot-reviewing'
        : h.status === 'review_passed' ? 'wf-exec-dot-review-passed'
        : h.status === 'review_failed' ? 'wf-exec-dot-review-failed'
        : 'wf-exec-dot-error';
      var statusLabel = '';
      if (h.status === 'reviewing') statusLabel = ' <span style="color:#f59e0b;">[审核中]</span>';
      else if (h.status === 'review_passed') statusLabel = ' <span style="color:#22c55e;">[审核通过]</span>';
      else if (h.status === 'review_failed') statusLabel = ' <span style="color:#f97316;">[审核不通过]</span>';
      else if (h.status === 'review_retry') statusLabel = ' <span style="color:#f59e0b;">[重试]</span>';
      var errText = h.error ? '<div class="wf-exec-error-text">' + esc(h.error).slice(0, 200) + '</div>' : '';
      if (h.status === 'review_failed' && !h.error) errText = '<div class="wf-exec-error-text">审核不通过（模型未给出具体原因）</div>';
      return '<div class="wf-exec-history-item">'
        + '<div class="' + dotCls + '"></div>'
        + '<div class="wf-exec-history-info">'
        + '<span class="wf-exec-history-label">' + label + segLabel + itemLabel + statusLabel + '</span>'
        + '<span class="wf-exec-history-time">' + time + '</span>'
        + '</div>'
        + errText
        + '</div>';
    }).join('');

    if (!items) items = '<div class="wf-exec-history-empty">暂无执行记录</div>';

    return toggle + '<div class="wf-exec-history-panel" id="wf-exec-history-panel">'
      + '<div class="wf-exec-history-header">执行历史</div>'
      + '<div class="wf-exec-history-list custom-scrollbar">' + items + '</div>'
      + '</div>';
  }

  /* ── Main Render ── */
  function render(engine) {
    var container = document.getElementById("workflow");
    if (!container) return;
    var wf = engine.current();
    if (!wf) {
      container.innerHTML = '<div class="wf-empty"><div class="wf-empty-inner"><div class="wf-empty-icon"><i class="fa fa-film"></i></div><div class="wf-empty-title">还没有工作流</div><div class="wf-empty-desc">点击「新建」开始创建</div></div></div>';
      return;
    }
    var historyHtml = WF_History.render(engine);
    container.innerHTML = '<div class="wf-shell">'
      + '<div class="wf-history-wrap">' + historyHtml + '</div>'
      + '<div class="wf-main" style="position:relative;">'
      + renderToolbar(engine)
      + renderExecHistory(engine)
      + renderPipelineHeader(engine)
      + renderContentArea(engine)
      + '</div>'
      + '<div class="wf-detail' + (engine.detailOpen ? " open" : "") + '" id="wf-detail">'
      + '<button class="wf-detail-close" id="wf-detail-close">×</button>'
      + renderDetailPanel(engine) + '</div>'
      + '<div class="wf-img-preview" id="wf-img-preview"><img id="wf-img-preview-src"><button class="wf-img-preview-close" id="wf-img-preview-close"><i class="fa fa-times"></i></button></div>'
      + '</div>';
  }

  /* ── Events ── */
  var _bound = false;
  function bindEvents(engine, rerender) {
    if (_bound) return;
    _bound = true;
    WF_History.bindEvents(engine, rerender);

    // Zoom & Pan on content area
    window.addEventListener("mousemove", function (e) {
      if (!engine.panning) return;
      engine.panX = e.clientX - engine.panStartX;
      engine.panY = e.clientY - engine.panStartY;
      var c = document.getElementById("wf-content-inner");
      if (c) c.style.transform = "translate(" + engine.panX + "px," + engine.panY + "px) scale(" + engine.zoom + ")";
    });
    window.addEventListener("mouseup", function () {
      if (engine.panning) { engine.panning = false; }
    });
    document.addEventListener("mousedown", function (e) {
      var wrap = e.target.closest && e.target.closest(".wf-content-area");
      if (!wrap || e.target.closest(".wf-content-card")) return;
      engine.panning = true;
      engine.panStartX = e.clientX - engine.panX;
      engine.panStartY = e.clientY - engine.panY;
    });
    document.addEventListener("wheel", function (e) {
      if (!e.target.closest || !e.target.closest(".wf-content-area")) return;
      e.preventDefault();
      var delta = e.deltaY > 0 ? -0.06 : 0.06;
      engine.zoom = Math.max(0.3, Math.min(2, engine.zoom + delta));
      var c = document.getElementById("wf-content-inner");
      if (c) c.style.transform = "translate(" + engine.panX + "px," + engine.panY + "px) scale(" + engine.zoom + ")";
    }, { passive: false });

    document.addEventListener("click", function (e) {
      // Exec history toggle
      if (e.target.closest && e.target.closest("#wf-exec-history-toggle")) {
        engine.execHistoryOpen = !engine.execHistoryOpen;
        rerender();
        return;
      }
      // Close exec history when clicking outside (don't return, let other handlers run)
      if (engine.execHistoryOpen && !(e.target.closest && e.target.closest("#wf-exec-history-panel")) && !(e.target.closest && e.target.closest("#wf-exec-history-toggle"))) {
        engine.execHistoryOpen = false;
      }

      // Image preview
      var previewImg = e.target.closest && e.target.closest(".wf-preview-img");
      if (previewImg) {
        var src = previewImg.getAttribute("data-preview") || previewImg.src;
        var overlay = document.getElementById("wf-img-preview");
        var img = document.getElementById("wf-img-preview-src");
        if (overlay && img && src) { img.src = src; overlay.classList.add("open"); }
        e.stopPropagation();
        return;
      }
      if (e.target.closest && e.target.closest("#wf-img-preview-close")) {
        var overlay = document.getElementById("wf-img-preview");
        if (overlay) overlay.classList.remove("open");
        return;
      }
      if (e.target.id === "wf-img-preview") {
        e.target.classList.remove("open");
        return;
      }

      var wfRoot = e.target.closest && e.target.closest("#workflow");
      if (!wfRoot) return;

      var pipeNode = e.target.closest && e.target.closest(".wf-pipe-node");
      if (pipeNode) {
        engine.selectedNodeKey = pipeNode.getAttribute("data-pipe-node");
        engine.detailOpen = true;
        rerender();
        return;
      }

      var copyBtn = e.target.closest && e.target.closest(".wf-copy-btn");
      if (copyBtn) {
        handleCopyVideoPrompt(engine, copyBtn.getAttribute("data-copy-vp"));
        e.stopPropagation();
        return;
      }

      var delRefBtn = e.target.closest && e.target.closest(".wf-ref-del-btn");
      if (delRefBtn) {
        var itemRefPath = delRefBtn.getAttribute("data-del-item-ref");
        if (itemRefPath) {
          var refIdx = parseInt(delRefBtn.getAttribute("data-del-item-ref-idx"));
          var key = engine.selectedNodeKey;
          if (key != null && !isNaN(refIdx)) {
            var nd = getNodeDataByKey(engine, key);
            var v = NR.getActiveVersion(nd);
            var item = getNestedField(v, itemRefPath);
            if (item && item.refImages && refIdx < item.refImages.length) {
              item.refImages.splice(refIdx, 1);
              engine.save();
              rerender();
            }
          }
          e.stopPropagation();
          return;
        }
        var idx = parseInt(delRefBtn.getAttribute("data-del-ref"));
        var key = engine.selectedNodeKey;
        if (key != null && !isNaN(idx)) {
          var nd = getNodeDataByKey(engine, key);
          if (nd && nd.refImages && idx < nd.refImages.length) {
            nd.refImages.splice(idx, 1);
            engine.save();
            rerender();
          }
        }
        e.stopPropagation();
        return;
      }

      var delSceneBtn = e.target.closest && e.target.closest("[data-del-scene-item]");
      if (delSceneBtn) {
        var sIdx = parseInt(delSceneBtn.getAttribute("data-del-scene-item"));
        var key = engine.selectedNodeKey;
        if (key != null && !isNaN(sIdx)) {
          var nd = getNodeDataByKey(engine, key);
          var v = NR.getActiveVersion(nd);
          if (v && v.scenes && sIdx < v.scenes.length) {
            v.scenes.splice(sIdx, 1);
            engine.save();
            rerender();
          }
        }
        e.stopPropagation();
        return;
      }

      var delCharBtn = e.target.closest && e.target.closest("[data-del-char-item]");
      if (delCharBtn) {
        var cIdx = parseInt(delCharBtn.getAttribute("data-del-char-item"));
        var key = engine.selectedNodeKey;
        if (key != null && !isNaN(cIdx)) {
          var nd = getNodeDataByKey(engine, key);
          var v = NR.getActiveVersion(nd);
          if (v && v.characters && cIdx < v.characters.length) {
            v.characters.splice(cIdx, 1);
            engine.save();
            rerender();
          }
        }
        e.stopPropagation();
        return;
      }

      var pickImg = e.target.closest && e.target.closest("[data-pick-image]");
      if (pickImg) {
        var pickIdx = parseInt(pickImg.getAttribute("data-pick-image"));
        var key = engine.selectedNodeKey;
        if (key != null && !isNaN(pickIdx)) {
          var nd = getNodeDataByKey(engine, key);
          var v = NR.getActiveVersion(nd);
          if (v && v.imageUrls && pickIdx < v.imageUrls.length) {
            v.imageUrl = v.imageUrls[pickIdx];
            engine.save();
            rerender();
          }
        }
        e.stopPropagation();
        return;
      }

      var contentCard = e.target.closest && e.target.closest(".wf-content-card[data-node-key]");
      if (contentCard) {
        engine.selectedNodeKey = contentCard.getAttribute("data-node-key");
        engine.detailOpen = true;
        rerender();
        return;
      }

      if (e.target.closest && e.target.closest("#wf-detail-close")) { engine.detailOpen = false; engine.selectedNodeKey = null; rerender(); return; }
      if (e.target.closest && e.target.closest("#wf-new-btn")) {
        var tplSel = document.getElementById("wf-template-select");
        var tplId = tplSel ? tplSel.value : null;
        engine.create(null, tplId);
        rerender();
        return;
      }
      if (e.target.closest && e.target.closest("#wf-del-btn")) { if (confirm("确定删除当前工作流？")) { engine.delete(engine.currentId); rerender(); } return; }
      if (e.target.closest && e.target.closest("#wf-run-btn")) { engine.run(rerender); return; }
      if (e.target.closest && e.target.closest("#wf-stop-btn")) { engine.stop(); rerender(); return; }

      var segRunBtn = e.target.closest && e.target.closest("[data-seg-run]");
      if (segRunBtn) {
        var si = parseInt(segRunBtn.getAttribute("data-seg-run"));
        if (!engine.isSegmentRunning(si)) engine.runSegment(si, rerender);
        return;
      }
      var segStopBtn = e.target.closest && e.target.closest("[data-seg-stop]");
      if (segStopBtn) {
        var si = parseInt(segStopBtn.getAttribute("data-seg-stop"));
        engine.stopSegment(si);
        rerender();
        return;
      }

      // 恢复预设默认模板
      var presetReset = e.target.closest && e.target.closest("[data-preset-reset]");
      if (presetReset) {
        var rkind = presetReset.getAttribute("data-preset-reset");
        var rkey = engine.selectedNodeKey;
        if (!rkey) return;
        var rnd = getNodeDataByKey(engine, rkey);
        if (!rnd) return;
        var rpreset = window.WF_findPreset && window.WF_findPreset(rkind, rnd.presetId);
        if (rpreset) {
          rnd.promptTemplate = rpreset.prompt_template || rpreset.template || rpreset.system_prompt || "";
          engine.save();
          rerender();
        }
        return;
      }

      // 复制 Markdown 分镜表
      var copyMd = e.target.closest && e.target.closest("[data-copy-markdown]");
      if (copyMd) {
        var ckey = engine.selectedNodeKey;
        if (!ckey) return;
        var cnd = getNodeDataByKey(engine, ckey);
        var cv = cnd && NR.getActiveVersion(cnd);
        if (cv && cv.markdown) {
          try {
            navigator.clipboard.writeText(cv.markdown);
            copyMd.innerHTML = '<i class="fa fa-check"></i> 已复制';
            setTimeout(function () { copyMd.innerHTML = '<i class="fa fa-copy"></i> 复制'; }, 1500);
          } catch (err) {}
        }
        return;
      }

      var modeBtn = e.target.closest && e.target.closest(".wf-mode-btn");
      if (modeBtn) {
        var wf = engine.current();
        if (wf) { wf.mode = modeBtn.getAttribute("data-mode"); engine.save(); }
        rerender();
        return;
      }

      // 新增剧集（无弹窗：切换到新集并自动打开输入节点详情面板，让用户在面板里填本集情节）
      if (e.target.closest && e.target.closest("#wf-add-episode-btn")) {
        var ep = engine.addEpisode();
        if (ep) {
          engine.selectedNodeKey = "input";
          engine.detailOpen = true;
          engine.save();
          rerender();
          // 滚到输入框并聚焦
          setTimeout(function () {
            var ta = document.getElementById("wf-input-plot");
            if (ta) { ta.focus(); ta.scrollIntoView({ block: "center" }); }
          }, 30);
        }
        return;
      }
      // 删除当前剧集
      if (e.target.closest && e.target.closest("#wf-del-episode-btn")) {
        var wfd = engine.current();
        if (!wfd || !wfd.currentEpisodeId) return;
        if (confirm("删除当前剧集？此操作不可恢复")) {
          engine.deleteEpisode(wfd.currentEpisodeId);
          rerender();
        }
        return;
      }

      var mcDelta = e.target.closest && e.target.closest("[data-mc-delta]");
      if (mcDelta) {
        var wf = engine.current();
        if (wf) {
          var d = parseInt(mcDelta.getAttribute("data-mc-delta"));
          wf.multiCount = Math.max(1, Math.min(5, (wf.multiCount || 1) + d));
          engine.save();
        }
        rerender();
        return;
      }

      var countBtn = e.target.closest && e.target.closest(".wf-count-btn");
      if (countBtn) { handleCountChange(engine, countBtn, rerender); return; }
      var versionItem = e.target.closest && e.target.closest(".wf-version-item");
      if (versionItem) { handleVersionSelect(engine, versionItem.getAttribute("data-version-id"), rerender); return; }

      var genAllSeg = e.target.closest && e.target.closest("[data-gen-all-seg]");
      if (genAllSeg) {
        if (engine.running) return;
        var nodeType = genAllSeg.getAttribute("data-gen-all-seg");
        handleGenAllSegments(engine, nodeType, rerender);
        return;
      }

      var clearNode = e.target.closest && e.target.closest("[data-clear-node]");
      if (clearNode) {
        var clearKey = clearNode.getAttribute("data-clear-node");
        var clearNodeType = parseNodeType(clearKey);
        var clearSegIdx = parseSegIndex(clearKey);
        if (engine.isNodeRunning(clearNodeType, clearSegIdx)) return;
        if (confirm("确定清空该节点内容？")) {
          engine.clearNode(clearKey);
          rerender();
        }
        return;
      }

      var gridBtn = e.target.closest && e.target.closest("[data-grid]");
      if (gridBtn) {
        var grid = parseInt(gridBtn.getAttribute("data-grid"));
        var gc = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
        if (!gc.storyboard) gc.storyboard = {};
        gc.storyboard.grid = grid;
        if (window._saveGlobalNodeConfigs) window._saveGlobalNodeConfigs(gc);
        rerender();
        return;
      }

      var orientBtn = e.target.closest && e.target.closest("[data-orientation]");
      if (orientBtn) {
        var orient = orientBtn.getAttribute("data-orientation");
        var gc2 = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
        if (!gc2.storyTemplate) gc2.storyTemplate = {};
        gc2.storyTemplate.orientation = orient;
        if (window._saveGlobalNodeConfigs) window._saveGlobalNodeConfigs(gc2);
        rerender();
        return;
      }
    });

    document.addEventListener("change", function (e) {
      if (e.target.id === "wf-review-retries") {
        _setReviewMaxRetries(e.target.value);
      }
      if (e.target.id === "wf-episode-select") {
        engine.switchEpisode(e.target.value);
        rerender();
        return;
      }
      // Preset selector change
      if (e.target.getAttribute && e.target.getAttribute("data-preset-select")) {
        var presetKind = e.target.getAttribute("data-preset-select");
        var key = engine.selectedNodeKey;
        if (!key) return;
        var nodeType = parseNodeType(key);
        var segIdx = parseSegIndex(key);
        var branchIdx = parseBranchIdx(key);
        var newPresetId = e.target.value;
        var preset = window.WF_findPreset && window.WF_findPreset(presetKind, newPresetId);
        var newTemplate = preset ? (preset.prompt_template || preset.template || preset.system_prompt || "") : "";

        var wf = engine.current();
        if (!wf) return;
        var def = NR.get(nodeType);
        var isPipelineNode = (key === nodeType);
        // pipeline 顶部节点：批量应用到所有 segment（segment 类节点）或所有分支（global 类节点）
        if (isPipelineNode && def && def.category === "segment") {
          (wf.segments || []).forEach(function (seg) {
            var arr = seg[nodeType + "s"] || [];
            arr.forEach(function (n) {
              if (n) { n.presetId = newPresetId; n.promptTemplate = newTemplate; }
            });
          });
        } else if (isPipelineNode && def && def.category === "global") {
          var arr = wf[nodeType + "s"] || [];
          arr.forEach(function (n) {
            if (n) { n.presetId = newPresetId; n.promptTemplate = newTemplate; }
          });
        } else {
          // 单个具体节点（带 segIdx/branchIdx）
          var nd = getNodeDataByKey(engine, key, true);
          if (!nd) return;
          nd.presetId = newPresetId;
          nd.promptTemplate = newTemplate;
        }
        engine.save();
        rerender();
        return;
      }
      if (e.target.id === "wf-skip-check") {
        var key = e.target.getAttribute("data-skip-node");
        var nodeType = parseNodeType(key);
        var segIdx = parseSegIndex(key);
        var wf = engine.current();
        if (!wf) return;
        var skipKey = nodeType + "Skip";
        if (segIdx !== null) {
          var seg = wf.segments[segIdx];
          if (seg) seg[skipKey] = e.target.checked;
        } else {
          wf[skipKey] = e.target.checked;
        }
        engine.save();
        rerender();
      }
      if (e.target.getAttribute && e.target.getAttribute("data-node-config")) {
        var nodeType = e.target.getAttribute("data-node-config");
        var configKey = e.target.getAttribute("data-config-key");
        var wf = engine.current();
        if (wf) {
          var gc = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
          if (!gc[nodeType]) gc[nodeType] = {};
          gc[nodeType][configKey] = e.target.value;
          if (window._saveGlobalNodeConfigs) window._saveGlobalNodeConfigs(gc);
        }
      }
      if (e.target.id === "wf-sb-resolution") {
        var gc3 = window._getGlobalNodeConfigs ? window._getGlobalNodeConfigs() : {};
        if (!gc3.storyboard) gc3.storyboard = {};
        gc3.storyboard.resolution = e.target.value;
        if (window._saveGlobalNodeConfigs) window._saveGlobalNodeConfigs(gc3);
      }
    });

    // Save editable text on blur
    document.addEventListener("focusout", function (e) {
      if (!e.target.classList || !e.target.classList.contains("wf-editable")) return;
      var field = e.target.getAttribute("data-edit-field");
      if (!field) return;
      var key = engine.selectedNodeKey;
      if (!key) return;
      var nd = getNodeDataByKey(engine, key);
      if (field === "userHint") {
        if (nd) nd.userHint = e.target.value;
        engine.save();
        return;
      }
      if (field === "promptTemplate") {
        if (nd) nd.promptTemplate = e.target.value;
        engine.save();
        return;
      }
      // 节点级配置字段（存在 nd 上，不走 version），主要用于 rcKeyframes 高级参数 / rcSmartSegment 段时长限制等
      var NODE_LEVEL_FIELDS = {
        min_scene_threshold: 1, long_shot_max_gap: 1, merge_min_dt: 1,
        sharpness_min: 1, hamming_dedup_threshold: 1,
        luma_lo: 1, luma_hi: 1, edge_density_min: 1, max_candidates: 1,
        batchSize: 1, maxConcurrentOverride: 1,
        minSegSec: 1, maxSegSec: 1,
      };
      if (NODE_LEVEL_FIELDS[field]) {
        if (nd) {
          var rawVal = e.target.value;
          var numVal = parseFloat(rawVal);
          nd[field] = (rawVal === "" || isNaN(numVal)) ? rawVal : numVal;
        }
        engine.save();
        return;
      }
      var v = NR.getActiveVersion(nd);
      if (!v) return;
      setNestedField(v, field, e.target.value);
      engine.save();
    });

    // File upload
    document.addEventListener("change", function (e) {
      if (!e.target.classList || !e.target.classList.contains("wf-file-input")) return;
      // 跳过二创工作流的视频上传，由 recreate-workflow.js 专用监听器处理
      if (e.target.getAttribute("data-rc-upload")) return;
      if (!e.target.files || !e.target.files[0]) return;
      var file = e.target.files[0];
      var field = e.target.getAttribute("data-upload-field");
      var addType = e.target.getAttribute("data-upload-add");
      var directType = e.target.getAttribute("data-upload-direct");
      var refType = e.target.getAttribute("data-upload-ref");
      var itemRefPath = e.target.getAttribute("data-upload-item-ref");
      var reader = new FileReader();
      reader.onload = function () {
        var wf = engine.current();
        if (!wf) return;
        var key = engine.selectedNodeKey;
        if (!key) return;
        var nd = getNodeDataByKey(engine, key, true);
        fetch("/api/workflow/upload-image/" + wf.id, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_data: reader.result, prefix: "upload" }),
        }).then(function (r) { return r.json(); }).then(function (res) {
          if (res.code !== 0 || !res.data || !res.data.url) return;
          var url = res.data.url;

          if (field) {
            var v = NR.getActiveVersion(nd);
            if (!v) v = NR.addVersion(nd, {});
            setNestedField(v, field, url);
          } else if (addType) {
            var v = NR.getActiveVersion(nd);
            if (!v) v = NR.addVersion(nd, {});
            var labelInput = e.target.closest(".wf-detail-section").querySelector(".wf-manual-label");
            var label = labelInput ? labelInput.value.trim() : "";
            if (!label) { alert("请先输入名称"); return; }
            if (addType === "mainCharacters" || addType === "minorCharacters") {
              if (!v.characters) v.characters = [];
              v.characters.push({ name: label, description: "", imageUrl: url });
            } else if (addType === "scene") {
              if (!v.scenes) v.scenes = [];
              v.scenes.push({ name: label, description: "", imageUrl: url });
            }
            if (labelInput) labelInput.value = "";
          } else if (directType) {
            var v = NR.getActiveVersion(nd);
            if (!v) v = NR.addVersion(nd, {});
            if (directType === "storyboard") {
              if (!v.images) v.images = [];
              v.images = [url];
            } else {
              v.imageUrl = url;
            }
          } else if (refType) {
            if (!nd.refImages) nd.refImages = [];
            nd.refImages.push(url);
          } else if (itemRefPath) {
            var v = NR.getActiveVersion(nd);
            if (v) {
              var item = getNestedField(v, itemRefPath);
              if (item) {
                if (!item.refImages) item.refImages = [];
                item.refImages.push(url);
              }
            }
          }
          engine.save();
          rerender();
        }).catch(function (err) { alert("上传失败: " + err.message); });
      };
      reader.readAsDataURL(file);
    });
  }

  function setNestedField(obj, path, value) {
    var parts = path.split(".");
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var k = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
      if (!cur[k]) cur[k] = {};
      cur = cur[k];
    }
    var last = isNaN(parts[parts.length - 1]) ? parts[parts.length - 1] : parseInt(parts[parts.length - 1]);
    cur[last] = value;
  }

  function getNestedField(obj, path) {
    var parts = path.split(".");
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (!cur) return undefined;
      var k = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
      cur = cur[k];
    }
    return cur;
  }

  /* ── Event Handlers ── */
  function handleMiniNodeClick(engine, nodeType, rerender) {
    var steps = engine.pipeline.filter(function (s) { return s.nodeType !== "input" && s.nodeType !== "output"; });
    var idx = steps.findIndex(function (s) { return s.nodeType === nodeType; });
    if (idx < 0) return;
    var from = engine.execRange.from, to = engine.execRange.to;
    var fromIdx = from ? steps.findIndex(function (s) { return s.nodeType === from; }) : -1;
    var toIdx = to ? steps.findIndex(function (s) { return s.nodeType === to; }) : -1;
    if (fromIdx < 0 || (from === to && from === nodeType)) {
      engine.execRange.from = nodeType; engine.execRange.to = nodeType;
    } else if (idx < fromIdx) { engine.execRange.from = nodeType;
    } else if (idx > toIdx) { engine.execRange.to = nodeType;
    } else { engine.execRange.to = nodeType; }
    rerender();
  }

  function handleSegChipClick(engine, val, rerender) {
    if (val === "all") { engine.execRange.segments = "all"; }
    else {
      var idx = parseInt(val);
      var cur = engine.execRange.segments;
      if (cur === "all" || !Array.isArray(cur)) { engine.execRange.segments = [idx]; }
      else {
        var pos = cur.indexOf(idx);
        if (pos >= 0) { cur.splice(pos, 1); if (!cur.length) engine.execRange.segments = "all"; }
        else { cur.push(idx); cur.sort(); }
      }
    }
    rerender();
  }

  function handleCountChange(engine, btn, rerender) {
    var delta = parseInt(btn.getAttribute("data-count-delta"));
    var key = btn.getAttribute("data-count-node");
    var nodeType = parseNodeType(key), segIdx = parseSegIndex(key);
    var def = NR.get(nodeType), maxCount = def ? def.maxCount : 5;
    var wf = engine.current();
    if (!wf) return;
    var countKey = nodeType + "Count", arrayKey = nodeType + "s";
    if (segIdx !== null) {
      var seg = wf.segments[segIdx]; if (!seg) return;
      seg[countKey] = Math.max(1, Math.min(maxCount, (seg[countKey] || 1) + delta));
      while (seg[arrayKey].length < seg[countKey]) seg[arrayKey].push(NR.createNodeData());
    } else {
      wf[countKey] = Math.max(1, Math.min(maxCount, (wf[countKey] || 1) + delta));
      while (wf[arrayKey].length < wf[countKey]) wf[arrayKey].push(NR.createNodeData());
    }
    engine.save(); rerender();
  }

  function handleVersionSelect(engine, versionId, rerender) {
    var key = engine.selectedNodeKey; if (!key) return;
    var nd = getNodeDataByKey(engine, key);
    if (nd && nd.versions) { NR.setActiveVersion(nd, versionId); engine.save(); rerender(); }
  }

  function showToast(text) {
    var el = document.getElementById("wf-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "wf-toast";
      el.style.cssText = "position:fixed;left:50%;top:20px;transform:translateX(-50%);background:rgba(15,23,42,.9);color:#e2e8f0;padding:8px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:99999;opacity:0;transition:opacity .2s;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.3);";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.style.opacity = "0"; }, 1000);
  }

  async function handleCopyVideoPrompt(engine, key) {
    var nd = getNodeDataByKey(engine, key);
    var v = NR.getActiveVersion(nd);
    if (!v || !v.fullText) { showToast("暂无内容"); return; }

    try {
      await navigator.clipboard.writeText(v.fullText);
      showToast("已复制");
    } catch (e) {
      var ta = document.createElement("textarea");
      ta.value = v.fullText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showToast("已复制");
    }
  }

  function handleGenAllSegments(engine, nodeType, rerender) {
    var wf = engine.current();
    if (!wf || !wf.segments || !wf.segments.length) return;
    if (engine.isAnyRunning && engine.isAnyRunning(wf.id)) {
      showToast("当前工作流有节点正在执行中");
      return;
    }
    var step = { nodeType: nodeType, category: "segment" };
    var MAX_RETRY = 1;
    var failCount = {};
    var permanent = {};
    var pendingSaveTimer = null;

    function debouncedSave() {
      if (pendingSaveTimer) return;
      pendingSaveTimer = setTimeout(function () {
        pendingSaveTimer = null;
        engine.save();
      }, 300);
    }

    function getSegNode(si) {
      var seg = wf.segments[si];
      if (!seg) return null;
      var arr = seg[nodeType + "s"] || [];
      return arr[0] || null;
    }

    function runReady() {
      var launched = false;
      var anyPending = false;
      for (var si = 0; si < wf.segments.length; si++) {
        if (permanent[si]) continue;
        if (engine.isNodeRunning(nodeType, si)) { launched = true; anyPending = true; continue; }
        if (engine.isNodeComplete(nodeType, si, wf)) continue;
        if (!engine.canExecute(nodeType, si, wf)) { anyPending = true; continue; }
        launched = true;
        anyPending = true;
        (function (idx) {
          engine._runSegmentStep(wf, step, idx, rerender, true).then(function () {
            var nd = getSegNode(idx);
            if (nd && nd.status === "error") {
              failCount[idx] = (failCount[idx] || 0) + 1;
              if (failCount[idx] > MAX_RETRY) {
                permanent[idx] = true;
                console.warn("[workflow] 第" + (idx + 1) + "段 " + nodeType + " 连续失败，停止重试:", nd.errorMsg);
              } else {
                nd.status = "idle";
                nd.errorMsg = null;
              }
            }
            debouncedSave();
            rerender();
            runReady();
          });
        })(si);
      }
      if (!launched && !anyPending) {
        if (pendingSaveTimer) { clearTimeout(pendingSaveTimer); pendingSaveTimer = null; engine.save(); }
        rerender();
      }
    }

    runReady();
  }

  window.WF_Renderer = {
    render: render, bindEvents: bindEvents,
    parseNodeType: parseNodeType, parseSegIndex: parseSegIndex,
    parseBranchIdx: parseBranchIdx, getNodeDataByKey: getNodeDataByKey,
    getReviewMaxRetries: _getReviewMaxRetries,
  };
})();
