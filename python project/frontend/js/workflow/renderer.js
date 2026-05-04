/**
 * renderer.js v2 — 通用工作流渲染器
 * 固定管线头 + 下方内容列 + 分隔线 + 段落框
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;
  var esc = window.WF_escapeHtml;

  /* ── Mini Pipeline (toolbar) ── */
  function renderMiniPipeline(engine) {
    var wf = engine.current();
    var steps = engine.pipeline.filter(function (s) {
      return s.nodeType !== "input" && s.nodeType !== "fpInput" && s.nodeType !== "output";
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
    var templates = window.WF_Templates || [];
    var tplOpts = templates.map(function (t) {
      return '<option value="' + t.id + '">' + esc(t.name) + '</option>';
    }).join("");
    return '<div class="wf-toolbar" id="wf-toolbar">'
      + '<select id="wf-template-select" class="wf-toolbar-select wf-template-select">' + tplOpts + '</select>'
      + '<button class="wf-tb-btn" id="wf-new-btn"><i class="fa fa-plus"></i> 新建</button>'
      + '<button class="wf-tb-btn danger" id="wf-del-btn"><i class="fa fa-trash-o"></i></button>'
      + '<div class="wf-toolbar-sep"></div>'
      + '<div class="wf-mode-switch">'
      + '<button class="wf-mode-btn' + (mode === "single" ? " active" : "") + '" data-mode="single">单剧本</button>'
      + '<button class="wf-mode-btn' + (mode === "multi" ? " active" : "") + '" data-mode="multi">多剧本</button>'
      + '</div>'
      + (mode === "single" && wf ? '<div class="wf-multi-count"><span>输出数量:</span><button class="wf-count-btn" data-mc-delta="-1">-</button><span class="wf-count-value">' + (wf.multiCount || 1) + '</span><button class="wf-count-btn" data-mc-delta="1">+</button></div>' : '')
      + '<div class="wf-toolbar-sep"></div>'
      + '<button class="wf-tb-btn primary" id="wf-run-btn"' + (isAutoRunning ? " disabled" : "") + '><i class="fa fa-play"></i> 一键执行</button>'
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
      if (engine.runningWfId === (wf && wf.id)) {
        Object.keys(engine.runningNodes).forEach(function (k) {
          if (k.indexOf(step.nodeType) >= 0) isRunning = true;
        });
      }
      var statusCls = isRunning ? "running" : (isSkipped ? "skipped" : "");
      var selected = engine.selectedNodeKey === step.nodeType ? "selected" : "";
      var isPlan = (step.nodeType === "planCharactersScenes" || step.nodeType === "planFrames");

      if (i > 0) {
        html += '<div class="wf-pipe-connector"><div class="wf-pipe-line-solid"></div></div>';
      }

      html += '<div class="wf-pipe-node ' + statusCls + ' ' + selected + (isPlan ? ' wf-pipe-plan' : '') + '" data-pipe-node="' + step.nodeType + '">'
        + '<div class="wf-pipe-icon" style="background:' + def.color + '22;color:' + def.color + '"><i class="fa ' + def.icon + '"></i></div>'
        + '<div class="wf-pipe-label">' + def.label + (isSkipped ? ' <span style="font-size:9px;color:#64748b;">(跳过)</span>' : '') + '</div>'
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

    globalSteps.forEach(function (step) {
      var def = NR.get(step.nodeType);
      if (!def) return;
      var isInputLike = (step.nodeType === "input" || step.nodeType === "fpInput");
      if (isInputLike) {
        html += '<div class="wf-gcol" data-col="' + step.nodeType + '"><div class="wf-col-header">' + def.label + '</div><div class="wf-col-body">';
        if (wf.input && wf.input.plot) {
          html += '<div class="wf-content-card" data-node-key="' + step.nodeType + '">';
          html += '<div class="wf-card-text">' + esc(wf.input.plot) + '</div>';
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

  /* ── Content Area ── */
  function renderContentArea(engine) {
    var wf = engine.current();
    if (!wf) return '<div class="wf-content-area"></div>';
    var segSteps = engine.getSegmentSteps();

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

    // -- Input column --
    html += '<div class="wf-global-cols"><div class="wf-gcol" data-col="input"><div class="wf-col-header">输入</div><div class="wf-col-body">';
    if (wf.input.plot) {
      html += '<div class="wf-content-card" data-node-key="input">'
        + '<div class="wf-card-text">' + esc(wf.input.plot) + '</div>'
        + (wf.input.style ? '<div class="wf-card-tag">风格: ' + esc(wf.input.style) + '</div>' : '')
        + '</div>';
    } else {
      html += '<div class="wf-content-empty">点击上方节点填写</div>';
    }
    html += '</div></div>';

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
          html += '<div class="wf-seg-row">';
          html += '<div class="wf-seg-label-cell"><div class="wf-seg-num">第' + (segIdx + 1) + '段</div>'
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
    if (!wf.mainCharactersSkip) {
      var mcArr = wf.mainCharacterss || [];
      var mcV = NR.getActiveVersion(mcArr[branchIdx] || mcArr[0]);
      if (mcV && mcV.characters) {
        mcV.characters.forEach(function (c) {
          if (c.imageUrl) refs.push({ label: "主要人物·" + c.name, url: c.imageUrl });
        });
      }
    }
    if (segIndex === null || !wf.segments || !wf.segments[segIndex]) return refs;
    var seg = wf.segments[segIndex];
    if (!seg.minorCharactersSkip) {
      var minorV = NR.getActiveVersion((seg.minorCharacterss || [])[branchIdx] || (seg.minorCharacterss || [])[0]);
      if (minorV && minorV.characters) {
        minorV.characters.forEach(function (c) {
          if (c.imageUrl) refs.push({ label: "次要人物·" + c.name, url: c.imageUrl });
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

    var html = '<div class="wf-content-card status-' + statusCls + (isRunning ? ' running' : '') + '" data-node-key="' + key + '">';

    if (branchLabel) html += '<div class="wf-card-branch">' + branchLabel + '</div>';

    var typeDef = NR.get(nodeType);
    var isImageNode = typeDef && typeDef.needsImage;

    if (isRunning && !v) {
      html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成中...</div>';
    } else if (!v) {
      html += '<div class="wf-card-empty">未生成</div>';
    } else if (nodeType === "script") {
      html += '<div class="wf-card-text">' + esc(v.fullText || "").slice(0, 300) + '</div>';
      if (v.segments && v.segments.length) {
        html += '<div class="wf-card-tag">' + v.segments.length + ' 段</div>';
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
      if (v.gridPrompts && v.gridPrompts.length) {
        html += '<div class="wf-card-text" style="font-size:10px;">' + v.gridPrompts.length + '格分镜</div>';
      } else if (v.description) {
        html += '<div class="wf-card-text" style="font-size:10px;">' + esc(v.description).slice(0, 80) + '</div>';
      }
      var imgs = v.images || [];
      if (imgs.length) {
        var cols = Math.ceil(Math.sqrt(imgs.length));
        html += '<div class="wf-sb-grid" style="grid-template-columns:repeat(' + cols + ',1fr)">';
        imgs.forEach(function (url) { html += '<img class="wf-sb-img wf-preview-img" src="' + esc(url) + '" data-preview="' + esc(url) + '">'; });
        html += '</div>';
      }
      if (isRunning) html += '<div class="wf-card-loading"><i class="fa fa-spinner fa-spin"></i> 生成图片中...</div>';
    } else if (nodeType === "firstFrame" || nodeType === "lastFrame") {
      if (v.description) html += '<div class="wf-card-text">' + esc(v.description).slice(0, 100) + '</div>';
      if (v.imageUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.imageUrl) + '" data-preview="' + esc(v.imageUrl) + '">';
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
      if (v.imageUrl) html += '<img class="wf-card-img wf-preview-img" src="' + esc(v.imageUrl) + '" data-preview="' + esc(v.imageUrl) + '">';
      else html += '<div class="wf-card-text">已生成</div>';
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

    if (isPipelineNode && nodeType !== "input" && nodeType !== "fpInput") {
      html += renderModelSelect(engine, nodeType);
      if (nodeType !== "planCharactersScenes" && nodeType !== "planFrames") {
        html += renderSkipToggle(engine, key);
      }
      if (nodeType === "storyboard") {
        html += renderGridControl(engine);
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
    var needsChat = ["script", "planCharactersScenes", "planFrames", "videoPrompt", "framePrompt"].indexOf(nodeType) >= 0;
    var needsImage = ["mainCharacters", "minorCharacters", "scene", "firstFrame", "storyboard", "lastFrame", "storyTemplate"].indexOf(nodeType) >= 0;
    var dirty = false;
    var html = '';
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
    var grid = wf.storyboardGrid || 4;
    var res = wf.storyboardResolution || "2160x3840";
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
    return '<div class="wf-detail-section"><div class="wf-detail-label">分镜宫格（全局）</div>'
      + '<div class="wf-grid-btns">'
      + '<button class="wf-grid-btn' + (grid === 4 ? " active" : "") + '" data-grid="4">2×2</button>'
      + '<button class="wf-grid-btn' + (grid === 6 ? " active" : "") + '" data-grid="6">2×3</button>'
      + '<button class="wf-grid-btn' + (grid === 9 ? " active" : "") + '" data-grid="9">3×3</button>'
      + '<button class="wf-grid-btn' + (grid === 16 ? " active" : "") + '" data-grid="16">4×4</button>'
      + '</div></div>'
      + '<div class="wf-detail-section"><div class="wf-detail-label">分镜分辨率（全局）</div>'
      + '<select class="wf-detail-input" id="wf-sb-resolution">' + resHtml + '</select>'
      + '</div>';
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
      var time = '';
      try {
        var d = new Date(h.time);
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        time = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      } catch (e) { time = ''; }
      var dotCls = h.status === 'done' ? 'wf-exec-dot-done' : 'wf-exec-dot-error';
      var errText = h.error ? '<div class="wf-exec-error-text">' + esc(h.error).slice(0, 80) + '</div>' : '';
      return '<div class="wf-exec-history-item">'
        + '<div class="' + dotCls + '"></div>'
        + '<div class="wf-exec-history-info">'
        + '<span class="wf-exec-history-label">' + label + segLabel + '</span>'
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

      var modeBtn = e.target.closest && e.target.closest(".wf-mode-btn");
      if (modeBtn) {
        var wf = engine.current();
        if (wf) { wf.mode = modeBtn.getAttribute("data-mode"); engine.save(); }
        rerender();
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
        var wf = engine.current();
        if (wf) {
          wf.storyboardGrid = grid;
          if (wf.segments) {
            wf.segments.forEach(function (seg) { seg.storyboardGrid = grid; });
          }
          engine.save();
        }
        rerender();
        return;
      }
    });

    document.addEventListener("change", function (e) {
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
        var wf = engine.current();
        if (wf) {
          wf.storyboardResolution = e.target.value;
          engine.save();
        }
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
      var v = NR.getActiveVersion(nd);
      if (!v) return;
      setNestedField(v, field, e.target.value);
      engine.save();
    });

    // File upload
    document.addEventListener("change", function (e) {
      if (!e.target.classList || !e.target.classList.contains("wf-file-input")) return;
      if (!e.target.files || !e.target.files[0]) return;
      var file = e.target.files[0];
      var field = e.target.getAttribute("data-upload-field");
      var addType = e.target.getAttribute("data-upload-add");
      var directType = e.target.getAttribute("data-upload-direct");
      var refType = e.target.getAttribute("data-upload-ref");
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
    var step = { nodeType: nodeType, category: "segment" };

    function runReady() {
      var launched = false;
      for (var si = 0; si < wf.segments.length; si++) {
        if (engine.isNodeRunning(nodeType, si)) { launched = true; continue; }
        if (engine.isNodeComplete(nodeType, si, wf)) continue;
        if (!engine.canExecute(nodeType, si, wf)) continue;
        launched = true;
        (function (idx) {
          engine._runSegmentStep(wf, step, idx, rerender, true).then(function () {
            engine.save();
            rerender();
            runReady();
          });
        })(si);
      }
      if (!launched) rerender();
    }

    runReady();
  }

  window.WF_Renderer = {
    render: render, bindEvents: bindEvents,
    parseNodeType: parseNodeType, parseSegIndex: parseSegIndex,
    parseBranchIdx: parseBranchIdx, getNodeDataByKey: getNodeDataByKey,
  };
})();
