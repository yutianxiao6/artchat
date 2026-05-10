/**
 * engine.js — 通用工作流引擎
 * 管理工作流状态、CRUD、布局计算、执行调度
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;

  var LAYOUT = {
    nodeW: 190, nodeH: 110,
    gapX: 80, gapY: 24,
    colGap: 50,
    segGapY: 40,
    startX: 60, startY: 100,
    dividerPad: 16,
  };

  /* ── helpers ── */
  function makeId() { return "wf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  /* ── WorkflowEngine ── */
  function WorkflowEngine(pipelineDef) {
    this.defaultPipeline = pipelineDef.pipeline || [];
    this.pipeline = this.defaultPipeline;
    this.defId = pipelineDef.id || "default";
    this.defTitle = pipelineDef.title || "工作流";
    this.workflows = [];
    this.currentId = null;
    this.execRange = { from: null, to: null, segments: "all" };
    this.solidDividers = {};
    this.selectedNodeKey = null;
    this.selectedBranch = 0;
    this.detailOpen = false;
    this.historyOpen = false;
    this.panX = 0; this.panY = 0; this.zoom = 1;
    this.panning = false; this.panStartX = 0; this.panStartY = 0;
    this.execHistoryOpen = false;
    this._wfStates = {};
  }

  var P = WorkflowEngine.prototype;

  /* ── Per-workflow execution state ──
   * 每个工作流维护独立的执行状态，互不影响。
   * 渲染默认读当前工作流（_currentState），执行链路用 _state(wf.id) 显式锁定。
   */
  function _newWfState() {
    return {
      running: false,
      runningNodes: {},
      segmentRunning: {},
      _stopFlag: false,
      _segStopFlags: {},
      _inReview: false,
      _autoExecMode: false,
    };
  }

  P._state = function (wfId) {
    if (!wfId) return _newWfState();
    if (!this._wfStates[wfId]) this._wfStates[wfId] = _newWfState();
    return this._wfStates[wfId];
  };

  P._currentState = function () {
    return this._state(this.currentId);
  };

  /* 兼容性访问器 —— 渲染/旧调用读写时代理到当前工作流状态。
   * 注意：异步场景下，执行链路应显式使用 _state(wf.id) 持有状态，避免
   * 用户切换会话后写入错误的桶。
   */
  Object.defineProperty(P, "running", {
    get: function () { return !!this._currentState().running; },
    set: function (v) { this._currentState().running = v; },
  });
  Object.defineProperty(P, "runningNodes", {
    get: function () { return this._currentState().runningNodes; },
    set: function (v) { this._currentState().runningNodes = v; },
  });
  Object.defineProperty(P, "segmentRunning", {
    get: function () { return this._currentState().segmentRunning; },
    set: function (v) { this._currentState().segmentRunning = v; },
  });
  Object.defineProperty(P, "runningWfId", {
    get: function () {
      var ids = Object.keys(this._wfStates);
      for (var i = 0; i < ids.length; i++) {
        if (this._wfStates[ids[i]].running) return ids[i];
      }
      return null;
    },
    set: function () { /* 只读：runningWfId 由 state.running 推导 */ },
  });

  P.getPipeline = function () {
    var id = this.currentId;
    var wf = this.workflows.find(function (w) { return w.id === id; }) || null;
    if (wf && wf.templateId) {
      var tpl = (window.WF_Templates || []).find(function (t) { return t.id === wf.templateId; });
      if (tpl && tpl.pipeline && tpl.pipeline.pipeline) return tpl.pipeline.pipeline;
    }
    return this.defaultPipeline;
  };

  P.syncPipeline = function () {
    this.pipeline = this.getPipeline();
  };

  /* ── current ── */
  P.current = function () {
    var id = this.currentId;
    var wf = this.workflows.find(function (w) { return w.id === id; }) || null;
    this.syncPipeline();
    return wf;
  };

  /* ── CRUD ── */
  P.create = function (title, templateId) {
    var template = null;
    var templates = window.WF_Templates || [];
    if (templateId) {
      template = templates.find(function (t) { return t.id === templateId; });
    }
    if (!template && templates.length) template = templates[0];

    var tplPipeline = (template && template.pipeline && template.pipeline.pipeline) || this.defaultPipeline;

    var wf = {
      id: makeId(),
      title: title || (template ? template.name : "新工作流"),
      templateId: template ? template.id : null,
      createdAt: new Date().toISOString(),
      input: { plot: "", style: "", type: "", segmentCount: null, episodeCount: null },
      mode: "single",
      multiCount: 1,
      history: [],
    };
    var self = this;
    tplPipeline.forEach(function (step) {
      if (step.nodeType === "input" || step.nodeType === "fpInput") return;
      if (step.category === "global") {
        wf[step.nodeType + "Count"] = 1;
        wf[step.nodeType + "s"] = [NR.createNodeData()];
      }
    });
    wf.segments = [];
    // 初始化 episode 模型
    var ep0 = Object.assign({
      id: "ep_" + Date.now().toString(36),
      index: 0,
      title: "第1集",
      plot: "",
      prevEpisodeId: null,
    }, this._snapshotEpisode(wf, tplPipeline));
    wf.episodes = [ep0];
    wf.currentEpisodeId = ep0.id;
    this.workflows.unshift(wf);
    this.currentId = wf.id;
    this.syncPipeline();
    var execSteps = this.pipeline.filter(function (s) { return s.nodeType !== "input" && s.nodeType !== "output"; });
    if (execSteps.length) {
      this.execRange = { from: execSteps[0].nodeType, to: execSteps[execSteps.length - 1].nodeType, segments: "all" };
    }
    this.save();
    return wf;
  };

  P.delete = function (id) {
    this.workflows = this.workflows.filter(function (w) { return w.id !== id; });
    if (this.currentId === id) this.currentId = this.workflows[0] ? this.workflows[0].id : null;
    delete this._wfStates[id];
    this.save();
    fetch("/api/workflow/" + id, { method: "DELETE" }).catch(function () {});
  };

  P.ensureShape = function (wf) {
    if (!wf) return;
    if (!wf.input) wf.input = { plot: "", style: "", type: "", segmentCount: null, episodeCount: null };
    if (!wf.input.plot) wf.input.plot = "";
    if (!wf.input.style) wf.input.style = "";
    if (!wf.input.type) wf.input.type = "";
    if (!("episodeCount" in wf.input)) wf.input.episodeCount = null;
    if (!wf.history) wf.history = [];
    if (!wf.mode) wf.mode = "single";
    if (!wf.multiCount) wf.multiCount = 1;
    if (!wf.segments) wf.segments = [];

    var wfPipeline = this.defaultPipeline;
    if (wf.templateId) {
      var tpl = (window.WF_Templates || []).find(function (t) { return t.id === wf.templateId; });
      if (tpl && tpl.pipeline && tpl.pipeline.pipeline) wfPipeline = tpl.pipeline.pipeline;
    }

    // 多剧集迁移：把旧版顶层字段包装为 episodes[0]
    this._migrateToEpisodes(wf, wfPipeline);

    wfPipeline.forEach(function (step) {
      if (step.nodeType === "input" || step.nodeType === "fpInput" || step.nodeType === "output") return;
      if (step.category === "global") {
        var countKey = step.nodeType + "Count";
        var arrayKey = step.nodeType + "s";
        if (!wf[countKey]) wf[countKey] = 1;
        if (!wf[arrayKey] || !wf[arrayKey].length) wf[arrayKey] = [NR.createNodeData()];
      }
    });
    wf.segments.forEach(function (seg) {
      wfPipeline.forEach(function (step) {
        if (step.category !== "segment") return;
        var countKey = step.nodeType + "Count";
        var arrayKey = step.nodeType + "s";
        if (!seg[countKey]) seg[countKey] = 1;
        if (!seg[arrayKey] || !seg[arrayKey].length) seg[arrayKey] = [NR.createNodeData()];
      });
    });
  };

  /* ── 多剧集模型 ── */
  // 跨集共享的全局字段（不属于任何单集）
  var SHARED_GLOBAL_NODES = { mainCharacters: true };

  // 哪些顶层字段属于"剧集级"（每集独立）
  P._getEpisodeFieldKeys = function (wfPipeline) {
    var keys = ["segments"];
    (wfPipeline || this.defaultPipeline).forEach(function (step) {
      if (step.nodeType === "input" || step.nodeType === "fpInput" || step.nodeType === "output") return;
      if (step.category !== "global") return;
      if (SHARED_GLOBAL_NODES[step.nodeType]) return;
      keys.push(step.nodeType + "s");
      keys.push(step.nodeType + "Count");
    });
    return keys;
  };

  P._isSharedGlobalNode = function (nodeType) {
    return !!SHARED_GLOBAL_NODES[nodeType];
  };

  P._snapshotEpisode = function (wf, wfPipeline) {
    var snap = {};
    var keys = this._getEpisodeFieldKeys(wfPipeline);
    keys.forEach(function (k) { if (wf[k] !== undefined) snap[k] = wf[k]; });
    return snap;
  };

  P._applyEpisode = function (wf, ep, wfPipeline) {
    var keys = this._getEpisodeFieldKeys(wfPipeline);
    keys.forEach(function (k) {
      if (ep[k] !== undefined) wf[k] = ep[k];
      else delete wf[k];
    });
  };

  P._migrateToEpisodes = function (wf, wfPipeline) {
    var self = this;
    if (wf.episodes && wf.episodes.length) {
      // 已是新结构：将共享字段（如 mainCharacters）从各 episode 提升到顶层
      wf.episodes.forEach(function (ep) {
        Object.keys(SHARED_GLOBAL_NODES).forEach(function (nt) {
          var ak = nt + "s", ck = nt + "Count";
          if (ep[ak] && (!wf[ak] || self._isEmptyNodeArray(wf[ak]))) {
            wf[ak] = ep[ak];
            wf[ck] = ep[ck] || 1;
          }
          delete ep[ak];
          delete ep[ck];
        });
      });
      var cur = wf.episodes.find(function (e) { return e.id === wf.currentEpisodeId; });
      if (!cur) { cur = wf.episodes[0]; wf.currentEpisodeId = cur.id; }
      this._applyEpisode(wf, cur, wfPipeline);
      return;
    }
    // 旧版：把顶层 segments + global 节点数组打包为 episodes[0]
    var snap = this._snapshotEpisode(wf, wfPipeline);
    var ep0 = Object.assign({
      id: "ep_" + Date.now().toString(36),
      index: 0,
      title: "第1集",
      plot: (wf.input && wf.input.plot) || "",
      prevEpisodeId: null,
    }, snap);
    wf.episodes = [ep0];
    wf.currentEpisodeId = ep0.id;
  };

  P._isEmptyNodeArray = function (arr) {
    if (!arr || !arr.length) return true;
    for (var i = 0; i < arr.length; i++) {
      var nd = arr[i];
      if (nd && (nd.versions && nd.versions.length || nd.activeVersionId)) return false;
    }
    return true;
  };

  P.currentEpisode = function (wf) {
    wf = wf || this.current();
    if (!wf || !wf.episodes) return null;
    return wf.episodes.find(function (e) { return e.id === wf.currentEpisodeId; }) || wf.episodes[0] || null;
  };

  P.switchEpisode = function (epId) {
    var wf = this.current();
    if (!wf || !wf.episodes) return;
    var target = wf.episodes.find(function (e) { return e.id === epId; });
    if (!target) return;
    // 写回当前集的最新顶层字段（用户可能刚编辑过）
    var pipeline = this.getPipeline();
    var cur = this.currentEpisode(wf);
    if (cur) {
      var snap = this._snapshotEpisode(wf, pipeline);
      Object.keys(snap).forEach(function (k) { cur[k] = snap[k]; });
    }
    wf.currentEpisodeId = target.id;
    this._applyEpisode(wf, target, pipeline);
    this.ensureShape(wf);
    this.save();
  };

  P.addEpisode = function (title) {
    var wf = this.current();
    if (!wf) return null;
    var pipeline = this.getPipeline();
    // 写回当前集
    var cur = this.currentEpisode(wf);
    if (cur) {
      var snap = this._snapshotEpisode(wf, pipeline);
      Object.keys(snap).forEach(function (k) { cur[k] = snap[k]; });
    }
    var idx = wf.episodes.length;
    var newEp = {
      id: "ep_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
      index: idx,
      title: title || ("第" + (idx + 1) + "集"),
      plot: "",
      prevEpisodeId: cur ? cur.id : null,
      segments: [],
    };
    var self = this;
    // 集独占的 global 节点空开（mainCharacters 等共享节点保留在 wf 顶层，不落入 episode）
    pipeline.forEach(function (step) {
      if (step.nodeType === "input" || step.nodeType === "fpInput" || step.nodeType === "output") return;
      if (step.category !== "global") return;
      if (self._isSharedGlobalNode(step.nodeType)) return;
      var ak = step.nodeType + "s";
      if (!newEp[ak]) {
        newEp[ak] = [NR.createNodeData()];
        newEp[step.nodeType + "Count"] = 1;
      }
    });
    wf.episodes.push(newEp);
    wf.currentEpisodeId = newEp.id;
    this._applyEpisode(wf, newEp, pipeline);
    this.ensureShape(wf);
    this.save();
    return newEp;
  };

  P.deleteEpisode = function (epId) {
    var wf = this.current();
    if (!wf || !wf.episodes || wf.episodes.length <= 1) return;
    var pipeline = this.getPipeline();
    var idx = wf.episodes.findIndex(function (e) { return e.id === epId; });
    if (idx < 0) return;
    var wasCurrent = wf.currentEpisodeId === epId;
    wf.episodes.splice(idx, 1);
    // 重建 index 和 prevEpisodeId 链
    wf.episodes.forEach(function (e, i) {
      e.index = i;
      e.prevEpisodeId = i > 0 ? wf.episodes[i - 1].id : null;
    });
    if (wasCurrent) {
      var fallback = wf.episodes[Math.max(0, idx - 1)] || wf.episodes[0];
      wf.currentEpisodeId = fallback.id;
      this._applyEpisode(wf, fallback, pipeline);
      this.ensureShape(wf);
    }
    this.save();
  };

  /* ── Persistence ── */
  P.load = async function () {
    try {
      var res = await fetch("/api/workflow/list");
      var result = await res.json();
      if (result.code === 0) this.workflows = result.data || [];
    } catch (e) { this.workflows = []; }
    var self = this;
    for (var i = 0; i < this.workflows.length; i++) {
      var summary = this.workflows[i];
      if (!summary.input) {
        try {
          var r = await fetch("/api/workflow/" + summary.id);
          var d = await r.json();
          if (d.code === 0 && d.data) this.workflows[i] = d.data;
        } catch (e) {}
      }
    }
    this.workflows.forEach(function (w) { self.ensureShape(w); self._resetStuckNodes(w); });
    if (!this.workflows.length) this.create();
    else this.currentId = this.workflows[0].id;
  };

  P.save = function () {
    var wf = this.current();
    if (!wf) return;
    // 保存前把顶层 alias 字段写回当前集
    if (wf.episodes && wf.episodes.length) {
      var pipeline = this.getPipeline();
      var cur = this.currentEpisode(wf);
      if (cur) {
        var snap = this._snapshotEpisode(wf, pipeline);
        Object.keys(snap).forEach(function (k) { cur[k] = snap[k]; });
      }
    }
    this.saveWorkflow(wf);
  };

  P.saveWorkflow = function (wf) {
    if (!wf || !wf.id) return;
    fetch("/api/workflow/" + wf.id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wf),
    }).catch(function () {});
  };

  /* ── Layout Engine ── */
  P.getBranchCount = function (wf) {
    if (!wf) return 1;
    // 多剧集模式下不再使用 multi 分支
    return 1;
  };

  P.getGlobalSteps = function () {
    return this.pipeline.filter(function (s) { return s.category === "global" || s.nodeType === "input" || s.nodeType === "fpInput" || s.nodeType === "output"; });
  };

  P.getSegmentSteps = function () {
    return this.pipeline.filter(function (s) { return s.category === "segment"; });
  };

  P.computeLayout = function (wf) {
    if (!wf) return { nodes: [], edges: [], dividers: [], segBoxes: [] };
    this.ensureShape(wf);

    var nodes = [], edges = [], dividers = [], segBoxes = [];
    var branchCount = this.getBranchCount(wf);
    var globalSteps = this.getGlobalSteps();
    var segSteps = this.getSegmentSteps();
    var segments = wf.segments || [];
    var hasSegments = segments.length > 0;

    var colX = LAYOUT.startX;
    var baseY = LAYOUT.startY;
    var colPositions = [];
    var prevColKeys = [];

    for (var gi = 0; gi < globalSteps.length; gi++) {
      var step = globalSteps[gi];

      if (step.nodeType === "output" && hasSegments) break;

      if (step.category === "global" && step.nodeType !== "input" && step.nodeType !== "output") {
        var count = wf[step.nodeType + "Count"] || 1;
        var arr = wf[step.nodeType + "s"] || [];
        var colKeys = [];
        for (var bi = 0; bi < branchCount; bi++) {
          var srcIdx = bi < count ? bi : 0;
          var nd = arr[srcIdx] || {};
          var key = step.nodeType + "_" + bi;
          var ny = baseY + bi * (LAYOUT.nodeH + LAYOUT.gapY);
          nodes.push({ key: key, type: step.nodeType, x: colX, y: ny, status: nd.status || "idle", branchIdx: bi, srcIdx: srcIdx, isReuse: bi >= count });
          colKeys.push(key);
          prevColKeys.forEach(function (pk) { edges.push({ from: pk, to: key }); });
        }
        colPositions.push({ x: colX, type: step.nodeType });
        prevColKeys = colKeys;
        colX += LAYOUT.nodeW + LAYOUT.gapX;
      } else if (step.nodeType === "input" || step.nodeType === "fpInput") {
        var inputKey = step.nodeType;
        var _curEp = this.currentEpisode(wf);
        var _hasPlot = (_curEp && _curEp.index > 0) ? !!_curEp.plot : !!wf.input.plot;
        nodes.push({ key: inputKey, type: step.nodeType, x: colX, y: baseY, status: _hasPlot ? "done" : "idle" });
        colPositions.push({ x: colX, type: "input" });
        prevColKeys = [inputKey];
        colX += LAYOUT.nodeW + LAYOUT.gapX;
      } else if (step.nodeType === "output" && !hasSegments) {
        // Show placeholder segment nodes before output when no segments exist
        for (var psi = 0; psi < segSteps.length; psi++) {
          var ps = segSteps[psi];
          var pKey = "placeholder_" + ps.nodeType;
          nodes.push({ key: pKey, type: ps.nodeType, x: colX, y: baseY, status: "idle", branchIdx: 0, srcIdx: 0, placeholder: true });
          prevColKeys.forEach(function (pk) { edges.push({ from: pk, to: pKey }); });

          if (psi < segSteps.length - 1) {
            var pDivId = "seg|" + ps.nodeType + "|" + segSteps[psi + 1].nodeType;
            dividers.push({ id: pDivId, x: colX + LAYOUT.nodeW + LAYOUT.gapX / 2, y: LAYOUT.startY - 20, height: LAYOUT.nodeH + 60 });
          }

          colPositions.push({ x: colX, type: ps.nodeType });
          prevColKeys = [pKey];
          colX += LAYOUT.nodeW + LAYOUT.gapX;
        }

        var divBeforeSeg = globalSteps[gi - 1] ? globalSteps[gi - 1].nodeType + "|segment" : "";
        if (divBeforeSeg) {
          dividers.push({ id: divBeforeSeg, x: colPositions[colPositions.length - segSteps.length].x - LAYOUT.gapX / 2, y: LAYOUT.startY - 20, height: LAYOUT.nodeH + 60 });
        }

        var outKey = "output";
        nodes.push({ key: outKey, type: "output", x: colX, y: baseY, status: "idle" });
        prevColKeys.forEach(function (pk) { edges.push({ from: pk, to: outKey }); });
        colPositions.push({ x: colX, type: "output" });

        var outDivId = "segment|output";
        dividers.push({ id: outDivId, x: colX - LAYOUT.gapX / 2, y: LAYOUT.startY - 20, height: LAYOUT.nodeH + 60 });
      }

      if (gi < globalSteps.length - 1 && !(step.nodeType === "output")) {
        var divX = colX - LAYOUT.gapX / 2;
        var nextStep = globalSteps[gi + 1];
        var divId = step.nodeType + "|" + (nextStep ? nextStep.nodeType : "segment");
        dividers.push({ id: divId, x: divX, y: LAYOUT.startY - 20, height: branchCount * (LAYOUT.nodeH + LAYOUT.gapY) + 40 });
      }
    }

    if (hasSegments) {
      var segStartX = colX;
      var lastSegDivId = prevColKeys.length ? (globalSteps[globalSteps.length - 2] || globalSteps[0]).nodeType + "|segment" : "";

      if (lastSegDivId) {
        dividers.push({ id: lastSegDivId, x: colX - LAYOUT.gapX / 2, y: LAYOUT.startY - 20, height: 0 });
      }

      var totalSegHeight = 0;

      for (var si = 0; si < segments.length; si++) {
        var seg = segments[si];
        var segY = baseY + totalSegHeight;
        var segStartColX = segStartX;
        var segPrevKeys = prevColKeys.slice();
        var segMinY = segY, segMaxY = segY;

        for (var sti = 0; sti < segSteps.length; sti++) {
          var ss = segSteps[sti];
          var sCount = seg[ss.nodeType + "Count"] || 1;
          var sArr = seg[ss.nodeType + "s"] || [];
          var sColKeys = [];

          for (var sbi = 0; sbi < branchCount; sbi++) {
            var sSrcIdx = sbi < sCount ? sbi : 0;
            var sNd = sArr[sSrcIdx] || {};
            var sKey = "seg_" + si + "_" + ss.nodeType + "_" + sbi;
            var sny = segY + sbi * (LAYOUT.nodeH + LAYOUT.gapY);
            nodes.push({ key: sKey, type: ss.nodeType, x: segStartColX, y: sny, status: sNd.status || "idle", branchIdx: sbi, srcIdx: sSrcIdx, segIndex: si, isReuse: sbi >= sCount });
            sColKeys.push(sKey);
            segMaxY = Math.max(segMaxY, sny + LAYOUT.nodeH);
            segPrevKeys.forEach(function (pk) { edges.push({ from: pk, to: sKey }); });
          }

          if (sti < segSteps.length - 1) {
            var sDivId = "seg|" + ss.nodeType + "|" + segSteps[sti + 1].nodeType;
            if (!dividers.find(function (d) { return d.id === sDivId; })) {
              dividers.push({ id: sDivId, x: segStartColX + LAYOUT.nodeW + LAYOUT.gapX / 2, y: 0, height: 0, segDivider: true });
            }
          }

          segPrevKeys = sColKeys;
          segStartColX += LAYOUT.nodeW + LAYOUT.gapX;
        }

        var segRowH = branchCount * (LAYOUT.nodeH + LAYOUT.gapY);
        segBoxes.push({
          segIndex: si,
          x: segStartX - 12,
          y: segY - 16,
          width: segSteps.length * (LAYOUT.nodeW + LAYOUT.gapX) - LAYOUT.gapX + 24,
          height: segRowH + 16,
          label: "第" + (si + 1) + "段",
        });

        totalSegHeight += segRowH + LAYOUT.segGapY;

        if (si === segments.length - 1) {
          var outX = segStartColX;
          var outY = baseY + ((totalSegHeight - LAYOUT.segGapY) / 2) - LAYOUT.nodeH / 2;
          nodes.push({ key: "output", type: "output", x: outX, y: outY, status: "idle" });
          segPrevKeys.forEach(function (pk) { edges.push({ from: pk, to: "output" }); });
          colPositions.push({ x: outX, type: "output" });
        }
      }

      var totalH = totalSegHeight + 60;
      dividers.forEach(function (d) {
        if (d.height === 0) { d.y = LAYOUT.startY - 20; d.height = totalH; }
      });
    }

    return { nodes: nodes, edges: edges, dividers: dividers, segBoxes: segBoxes, branchCount: branchCount };
  };

  /* ── Execution Engine ── */
  P.setExecRange = function (from, to, segments) {
    this.execRange.from = from;
    this.execRange.to = to;
    if (segments !== undefined) this.execRange.segments = segments;
  };

  P.getExecSteps = function () {
    var from = this.execRange.from;
    var to = this.execRange.to;
    var steps = this.pipeline.filter(function (s) { return s.nodeType !== "input" && s.nodeType !== "fpInput" && s.nodeType !== "output"; });
    var fromIdx = from ? steps.findIndex(function (s) { return s.nodeType === from; }) : 0;
    var toIdx = to ? steps.findIndex(function (s) { return s.nodeType === to; }) : steps.length - 1;
    if (fromIdx < 0) fromIdx = 0;
    if (toIdx < 0) toIdx = steps.length - 1;
    return steps.slice(fromIdx, toIdx + 1);
  };

  P.getExecSegments = function (wf) {
    if (!wf || !wf.segments || !wf.segments.length) return [];
    var sel = this.execRange.segments;
    if (sel === "all" || !sel) return wf.segments.map(function (_, i) { return i; });
    if (Array.isArray(sel)) return sel;
    return [sel];
  };

  /* ── Dependency Resolution System ── */

  var REVIEWABLE_NODES = {
    planCharactersScenes: true, scene: true, planFrames: true,
    firstFrame: true, storyboard: true, lastFrame: true,
    videoPrompt: true, storyTemplate: true,
  };

  P.isNodeSkipped = function (nodeType, segIdx, wf) {
    if (!wf) return false;
    if (wf[nodeType + "Skip"]) return true;
    if (segIdx !== null && segIdx !== undefined && wf.segments && wf.segments[segIdx]) {
      return !!wf.segments[segIdx][nodeType + "Skip"];
    }
    return false;
  };

  function _allImagesReady(v, nodeType) {
    if (!v) return false;
    if (nodeType === "mainCharacters" || nodeType === "minorCharacters") {
      var chars = v.characters || [];
      return chars.length > 0 && chars.every(function (c) { return !!c.imageUrl; });
    }
    if (nodeType === "scene") {
      var scenes = v.scenes || [];
      return scenes.length > 0 && scenes.every(function (s) { return !!s.imageUrl; });
    }
    if (nodeType === "storyboard") return !!(v.images && v.images.length);
    if (nodeType === "firstFrame" || nodeType === "lastFrame") return !!v.imageUrl;
    if (nodeType === "storyTemplate") {
      // 文本预设产出 markdown，没有 imageUrl
      if (v.kind === "text") return !!v.markdown;
      return !!v.imageUrl;
    }
    return true;
  }

  P.isNodeComplete = function (nodeType, segIdx, wf) {
    if (!wf) return false;
    if (this.isNodeSkipped(nodeType, segIdx, wf)) return true;
    if (nodeType === "input" || nodeType === "fpInput") {
      var curEp_ = this.currentEpisode(wf);
      if (curEp_ && curEp_.index > 0) return !!curEp_.plot;
      return !!wf.input.plot;
    }
    if (nodeType === "output") return true;

    var nd = null;
    var typeDef = NR.get(nodeType);
    if (segIdx !== null && segIdx !== undefined && wf.segments && wf.segments[segIdx]) {
      var arr = wf.segments[segIdx][nodeType + "s"] || [];
      nd = arr[0];
    } else {
      var arr = wf[nodeType + "s"] || [];
      nd = arr[0];
    }
    var v = NR.getActiveVersion(nd);
    if (!v) return false;
    if (typeDef && typeDef.needsImage && !_allImagesReady(v, nodeType)) return false;

    if (REVIEWABLE_NODES[nodeType] && this._state(wf.id)._autoExecMode && this._reviewEnabled()) {
      if (nd && nd.reviewStatus === "pending") return false;
    }
    return true;
  };

  P._reviewEnabled = function () {
    try { return parseInt(localStorage.getItem("flowdraw:wfReviewMaxRetries")) > 0; } catch(e) { return true; }
  };

  P.getDependencies = function (nodeType, segIdx, wf) {
    if (!wf) return [];
    var deps = [];
    var self = this;

    function addDep(nt, si) {
      if (!self.isNodeSkipped(nt, si, wf)) deps.push({ nodeType: nt, segIdx: si });
    }

    switch (nodeType) {
      case "input": case "fpInput": break;
      case "script": addDep("input", null); break;
      case "planCharactersScenes": addDep("script", null); break;
      case "mainCharacters": addDep("planCharactersScenes", null); break;
      case "minorCharacters": addDep("planCharactersScenes", null); break;
      case "scene":
        addDep("planCharactersScenes", null);
        if (segIdx > 0) addDep("scene", segIdx - 1);
        break;
      case "planFrames":
        addDep("planCharactersScenes", null);
        // 第二段及之后的规划需要依赖前一段的规划
        if (segIdx > 0) addDep("planFrames", segIdx - 1);
        break;
      case "firstFrame":
      case "lastFrame":
        addDep("planFrames", segIdx);
        addDep("mainCharacters", null);
        addDep("scene", segIdx);
        break;
      case "storyboard":
        addDep("planFrames", segIdx);
        addDep("mainCharacters", null);
        addDep("scene", segIdx);
        // 第二段及之后的分镜图需要依赖前一段的分镜图
        if (segIdx > 0) addDep("storyboard", segIdx - 1);
        break;
      case "videoPrompt":
      case "storyTemplate":
        addDep("script", null);
        addDep("planCharactersScenes", null);
        // storyTemplate 的文本预设（shotListMd）不需要图片类依赖
        var stTextMode = false;
        if (nodeType === "storyTemplate" && segIdx !== null && segIdx !== undefined) {
          var stSeg = wf.segments && wf.segments[segIdx];
          var stNd = stSeg && (stSeg.storyTemplates || [])[0];
          if (stNd && stNd.presetId) {
            var stPreset = (window.WF_findPreset && window.WF_findPreset("storyTemplate", stNd.presetId));
            if (stPreset && stPreset.kind === "text") stTextMode = true;
          }
        }
        if (!stTextMode) {
          addDep("mainCharacters", null);
          if (segIdx !== null && segIdx !== undefined) {
            var segNodeTypes = ["minorCharacters", "scene", "planFrames", "firstFrame", "storyboard", "lastFrame"];
            for (var i = 0; i < segNodeTypes.length; i++) {
              addDep(segNodeTypes[i], segIdx);
            }
          }
        }
        break;
    }
    return deps;
  };

  P.isNodeRunning = function (nodeType, segIdx, wfId) {
    var state = this._state(wfId || this.currentId);
    if (!state) return false;
    var keys = Object.keys(state.runningNodes);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (segIdx !== null && segIdx !== undefined) {
        if (k.indexOf("seg_" + segIdx + "_" + nodeType + "_") === 0) return true;
      } else {
        if (k.indexOf(nodeType + "_") === 0 && k.indexOf("seg_") !== 0) return true;
      }
    }
    return false;
  };

  P.canExecute = function (nodeType, segIdx, wf) {
    if (!wf) return false;
    if (this.isNodeSkipped(nodeType, segIdx, wf)) return false;
    if (this.isNodeRunning(nodeType, segIdx, wf.id)) return false;
    var deps = this.getDependencies(nodeType, segIdx, wf);
    for (var i = 0; i < deps.length; i++) {
      if (!this.isNodeComplete(deps[i].nodeType, deps[i].segIdx, wf)) return false;
    }
    return true;
  };

  P.isAnyRunning = function (wfId) {
    var state = this._state(wfId || this.currentId);
    return !!(state && Object.keys(state.runningNodes).length > 0);
  };

  /* ── Execution Engine ── */

  P.run = async function (onUpdate) {
    var wf = this.current();
    if (!wf) return;
    var state = this._state(wf.id);
    if (state.running) return;
    if (this.isAnyRunning(wf.id)) { alert("当前工作流有节点正在生成中，请等待完成或停止后再执行"); return; }
    var curEp = this.currentEpisode(wf);
    var plot = (curEp && curEp.index > 0) ? (curEp.plot || "") : (wf.input.plot || "");
    if (!plot) { alert(curEp && curEp.index > 0 ? "请先填写本集情节" : "请先填写输入信息"); return; }
    state.running = true;
    state._stopFlag = false;
    state._autoExecMode = true;
    state.runningNodes = {};
    this._resetStuckNodes(wf);

    var self = this;
    var _rerenderTimer = null;
    function debouncedUpdate() {
      if (_rerenderTimer) return;
      _rerenderTimer = setTimeout(function () { _rerenderTimer = null; if (onUpdate) onUpdate(); }, 100);
    }
    debouncedUpdate();

    var tasks = self._buildTaskList(wf);
    var started = {};
    var completed = {};
    var retryCount = {};

    function taskKey(t) {
      return t.segIdx !== null ? "seg_" + t.segIdx + "_" + t.nodeType : t.nodeType;
    }

    function scheduleReady() {
      if (state._stopFlag) return;
      tasks.forEach(function (t) {
        var tk = taskKey(t);
        if (started[tk] || completed[tk]) return;
        if (!self.canExecute(t.nodeType, t.segIdx, wf)) return;
        started[tk] = true;
        launchTask(t);
      });
    }

    function launchTask(t) {
      var step = { nodeType: t.nodeType, category: t.category };
      var promise;
      if (t.category === "global") {
        promise = self._runGlobalStep(wf, step, debouncedUpdate, false);
      } else {
        promise = self._runSegmentStep(wf, step, t.segIdx, debouncedUpdate, false);
      }
      promise.then(function () {
        var tk = taskKey(t);
        var nd = self._getTaskNode(wf, t);
        if (nd && nd.status === "error") {
          var rc = retryCount[tk] || 0;
          if (rc < 1) {
            retryCount[tk] = rc + 1;
            nd.status = "idle";
            nd.errorMsg = null;
            delete started[tk];
            debouncedUpdate();
            scheduleReady();
            return;
          }
          completed[tk] = true;
          var isCritical = t.nodeType === "script" || t.nodeType === "planCharactersScenes";
          if (isCritical) { state._stopFlag = true; }
        } else {
          completed[tk] = true;
        }
        self.saveWorkflow(wf);
        debouncedUpdate();
        scheduleReady();
      });
    }

    scheduleReady();

    await new Promise(function (resolve) {
      var interval = setInterval(function () {
        var allDone = tasks.every(function (t) { return completed[taskKey(t)]; });
        var noneRunning = !self.isAnyRunning(wf.id);
        if (allDone || (state._stopFlag && noneRunning)) {
          clearInterval(interval);
          resolve();
        }
      }, 200);
    });

    if (_rerenderTimer) { clearTimeout(_rerenderTimer); _rerenderTimer = null; }
    state.running = false;
    state._autoExecMode = false;
    self.saveWorkflow(wf);
    if (onUpdate) onUpdate();
  };

  P._buildTaskList = function (wf) {
    var tasks = [];
    var self = this;
    var globalSteps = this.pipeline.filter(function (s) {
      return s.category === "global" && s.nodeType !== "input" && s.nodeType !== "fpInput" && s.nodeType !== "output";
    });
    var segSteps = this.getSegmentSteps();
    var segIdxs = this.getExecSegments(wf);

    globalSteps.forEach(function (step) {
      if (self.isNodeSkipped(step.nodeType, null, wf)) return;
      if (self.isNodeComplete(step.nodeType, null, wf)) return;
      tasks.push({ nodeType: step.nodeType, segIdx: null, category: "global" });
    });

    segIdxs.forEach(function (si) {
      segSteps.forEach(function (step) {
        if (self.isNodeSkipped(step.nodeType, si, wf)) return;
        if (self.isNodeComplete(step.nodeType, si, wf)) return;
        tasks.push({ nodeType: step.nodeType, segIdx: si, category: "segment" });
      });
    });

    return tasks;
  };

  P._getTaskNode = function (wf, task) {
    if (task.segIdx !== null && task.segIdx !== undefined) {
      var seg = wf.segments[task.segIdx];
      if (!seg) return null;
      var arr = seg[task.nodeType + "s"] || [];
      return arr[0] || null;
    }
    var arr = wf[task.nodeType + "s"] || [];
    return arr[0] || null;
  };

  P._runGlobalStep = async function (wf, step, onUpdate, forceAll) {
    var typeDef = NR.get(step.nodeType);
    if (!typeDef || !typeDef.generate) return;
    var arr = wf[step.nodeType + "s"];
    if (!arr || !arr.length) { arr = [NR.createNodeData()]; wf[step.nodeType + "s"] = arr; }

    var self = this;
    var state = this._state(wf.id);
    var nd = arr[0];
    if (!forceAll && NR.getActiveVersion(nd)) {
      if (!typeDef.needsImage || _allImagesReady(NR.getActiveVersion(nd), step.nodeType)) return;
    }
    var globalKey = step.nodeType + "_0";
    var isActuallyRunning = !!state.runningNodes[globalKey];
    if (nd.status === "running" && !isActuallyRunning) {
      nd.status = "idle";
      nd.errorMsg = null;
    }
    if (nd.status === "running") return;
    nd.status = "running";
    nd.errorMsg = null;
    if (state._autoExecMode && REVIEWABLE_NODES[step.nodeType]) nd.reviewStatus = "pending";
    state.runningNodes[globalKey] = true;
    if (onUpdate) onUpdate();

    try {
      var result = await typeDef.generate({ workflow: wf, nodeData: nd, branchIdx: 0, engine: self });
      if (result) NR.addVersion(nd, result);
      nd.errorMsg = null;
      self._addHistory(wf, step.nodeType, 0, null, "done");
      if (!state._inReview && window.WF_ReviewHooks && window.WF_ReviewHooks.afterNodeComplete) {
        state._inReview = true;
        try { await window.WF_ReviewHooks.afterNodeComplete(self, wf, step.nodeType, null, onUpdate); } catch (e) {}
        state._inReview = false;
      }
    } catch (err) {
      nd.status = "error";
      nd.errorMsg = err.message || "生成失败";
      self._addHistory(wf, step.nodeType, 0, null, "error", err.message);
    } finally {
      delete state.runningNodes[step.nodeType + "_0"];
      if (onUpdate) onUpdate();
    }
  };

  P._runSegmentStep = async function (wf, step, segIdx, onUpdate, forceAll) {
    var typeDef = NR.get(step.nodeType);
    if (!typeDef || !typeDef.generate) return;
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var branchCount = this.getBranchCount(wf);
    var arr = seg[step.nodeType + "s"];
    if (!arr) { arr = []; seg[step.nodeType + "s"] = arr; }
    while (arr.length < branchCount) arr.push(NR.createNodeData());

    var self = this;
    var state = this._state(wf.id);
    var promises = [];
    for (var bi = 0; bi < branchCount; bi++) {
      (function (idx) {
        var nd = arr[idx];
        if (!nd) { nd = NR.createNodeData(); arr[idx] = nd; }
        if (!forceAll && NR.getActiveVersion(nd)) {
          if (!typeDef.needsImage || _allImagesReady(NR.getActiveVersion(nd), step.nodeType)) return;
        }
        var nk = "seg_" + segIdx + "_" + step.nodeType + "_" + idx;
        var isActuallyRunning = !!state.runningNodes[nk];
        if (nd.status === "running" && !isActuallyRunning) {
          nd.status = "idle";
          nd.errorMsg = null;
        }
        if (nd.status === "running") return;
        nd.status = "running";
        nd.errorMsg = null;
        if (state._autoExecMode && REVIEWABLE_NODES[step.nodeType]) nd.reviewStatus = "pending";
        state.runningNodes[nk] = true;
        if (onUpdate) onUpdate();

        var p = typeDef.generate({ workflow: wf, nodeData: nd, branchIdx: idx, segIndex: segIdx, segment: seg, engine: self })
          .then(function (result) {
            if (result) NR.addVersion(nd, result);
            nd.errorMsg = null;
            self._addHistory(wf, step.nodeType, idx, segIdx, "done");
          })
          .catch(function (err) {
            nd.status = "error";
            nd.errorMsg = err.message || "生成失败";
            self._addHistory(wf, step.nodeType, idx, segIdx, "error", err.message);
          })
          .finally(function () {
            delete state.runningNodes[nk];
            if (onUpdate) onUpdate();
          });
        promises.push(p);
      })(bi);
    }
    await Promise.all(promises);
    var anyError = false;
    for (var ci = 0; ci < branchCount; ci++) {
      var cnd = arr[ci];
      if (cnd && cnd.status === "error") { anyError = true; break; }
    }
    if (!anyError && !state._inReview && window.WF_ReviewHooks && window.WF_ReviewHooks.afterNodeComplete) {
      state._inReview = true;
      try { await window.WF_ReviewHooks.afterNodeComplete(self, wf, step.nodeType, segIdx, onUpdate); } catch (e) {}
      state._inReview = false;
    }
  };

  P.stop = function (wfId) {
    var state = this._state(wfId || this.currentId);
    if (!state) return;
    state._stopFlag = true;
    state.running = false;
  };

  /* ── Segment-level execution ── */
  P.runSegment = async function (segIdx, onUpdate) {
    var wf = this.current();
    if (!wf || !wf.segments || !wf.segments[segIdx]) return;
    var state = this._state(wf.id);
    if (state.segmentRunning[segIdx]) return;
    if (state.running) return;
    state.segmentRunning[segIdx] = true;
    state._segStopFlags[segIdx] = false;
    state._autoExecMode = true;
    if (onUpdate) onUpdate();

    var self = this;
    var segSteps = this.getSegmentSteps();
    var tasks = [];
    segSteps.forEach(function (step) {
      if (self.isNodeSkipped(step.nodeType, segIdx, wf)) return;
      if (self.isNodeComplete(step.nodeType, segIdx, wf)) return;
      tasks.push({ nodeType: step.nodeType, segIdx: segIdx, category: "segment" });
    });

    var started = {}, completed = {};
    function taskKey(t) { return "seg_" + t.segIdx + "_" + t.nodeType; }

    function scheduleReady() {
      if (state._segStopFlags[segIdx]) return;
      tasks.forEach(function (t) {
        var tk = taskKey(t);
        if (started[tk] || completed[tk]) return;
        if (!self.canExecute(t.nodeType, t.segIdx, wf)) return;
        started[tk] = true;
        var step = { nodeType: t.nodeType, category: "segment" };
        self._runSegmentStep(wf, step, t.segIdx, onUpdate, false).then(function () {
          completed[tk] = true;
          self.saveWorkflow(wf);
          if (onUpdate) onUpdate();
          scheduleReady();
        });
      });
    }

    scheduleReady();

    await new Promise(function (resolve) {
      var interval = setInterval(function () {
        var allDone = tasks.every(function (t) { return completed[taskKey(t)]; });
        var noneRunning = !Object.keys(state.runningNodes).some(function (k) { return k.indexOf("seg_" + segIdx + "_") === 0; });
        if (allDone || (state._segStopFlags[segIdx] && noneRunning)) {
          clearInterval(interval);
          resolve();
        }
      }, 200);
    });

    delete state.segmentRunning[segIdx];
    delete state._segStopFlags[segIdx];
    if (!state.running && !Object.keys(state.segmentRunning).length) state._autoExecMode = false;
    self.saveWorkflow(wf);
    if (onUpdate) onUpdate();
  };

  P.stopSegment = function (segIdx, wfId) {
    var state = this._state(wfId || this.currentId);
    if (!state) return;
    state._segStopFlags[segIdx] = true;
    delete state.segmentRunning[segIdx];
  };

  P.isSegmentRunning = function (segIdx, wfId) {
    var state = this._state(wfId || this.currentId);
    return !!(state && state.segmentRunning[segIdx]);
  };

  P._addHistory = function (wf, nodeType, branchIdx, segIdx, status, errorMsg, itemLabel) {
    if (!wf.history) wf.history = [];
    wf.history.push({
      id: NR.makeVersionId(),
      time: new Date().toISOString(),
      nodeType: nodeType,
      branchIdx: branchIdx,
      segIndex: segIdx,
      status: status,
      error: errorMsg || null,
      itemLabel: itemLabel || null,
    });
    if (wf.history.length > 500) wf.history = wf.history.slice(-500);
  };

  P._updateLastReviewHistory = function (wf, nodeType, segIdx, newStatus, errorMsg) {
    if (!wf.history) return;
    for (var i = wf.history.length - 1; i >= 0; i--) {
      var h = wf.history[i];
      if (h.nodeType === nodeType && h.status === "reviewing") {
        var segMatch = (segIdx === null || segIdx === undefined)
          ? (h.segIndex === null || h.segIndex === undefined)
          : h.segIndex === segIdx;
        if (segMatch) {
          h.status = newStatus;
          h.error = errorMsg || null;
          h.time = new Date().toISOString();
          return;
        }
      }
    }
    this._addHistory(wf, nodeType, 0, segIdx, newStatus, errorMsg);
  };

  P.setNodeReviewing = function (nodeType, segIdx, reviewing, wfId) {
    var state = this._state(wfId || this.currentId);
    if (!state) return;
    var keys = Object.keys(state.runningNodes);
    var prefix = (segIdx !== null && segIdx !== undefined) ? "seg_" + segIdx + "_" + nodeType + "_" : nodeType + "_";
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0 || keys[i] === prefix + "0") {
        state.runningNodes[keys[i]] = reviewing ? "reviewing" : true;
        return;
      }
    }
    if (reviewing) {
      var nk = (segIdx !== null && segIdx !== undefined) ? "seg_" + segIdx + "_" + nodeType + "_0" : nodeType + "_0";
      state.runningNodes[nk] = "reviewing";
    }
  };

  P.isNodeReviewing = function (nodeType, segIdx, wfId) {
    var state = this._state(wfId || this.currentId);
    if (!state) return false;
    var prefix = (segIdx !== null && segIdx !== undefined) ? "seg_" + segIdx + "_" + nodeType + "_" : nodeType + "_";
    var keys = Object.keys(state.runningNodes);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(prefix) === 0 && state.runningNodes[keys[i]] === "reviewing") return true;
    }
    return false;
  };

  P._resetStuckNodes = function (wf) {
    var self = this;
    this.pipeline.forEach(function (step) {
      if (step.nodeType === "input" || step.nodeType === "fpInput") return;
      if (step.category === "global") {
        var arr = wf[step.nodeType + "s"] || [];
        arr.forEach(function (nd) { if (nd && nd.status === "running") nd.status = "idle"; });
      }
    });
    (wf.segments || []).forEach(function (seg) {
      self.pipeline.forEach(function (step) {
        if (step.category !== "segment") return;
        var arr = seg[step.nodeType + "s"] || [];
        arr.forEach(function (nd) { if (nd && nd.status === "running") nd.status = "idle"; });
      });
    });
  };

  /* ── Clear node ── */
  P.clearNode = function (key) {
    var wf = this.current();
    if (!wf) return;
    var nodeType = key;
    var segMatch = key.match(/^seg_(\d+)_(\w+)_(\d+)$/);
    var globalMatch = key.match(/^(\w+)_(\d+)$/);
    if (segMatch) {
      var segIdx = parseInt(segMatch[1]);
      nodeType = segMatch[2];
      var branchIdx = parseInt(segMatch[3]);
      var seg = wf.segments[segIdx];
      if (seg && seg[nodeType + "s"] && seg[nodeType + "s"][branchIdx]) {
        seg[nodeType + "s"][branchIdx] = NR.createNodeData();
      }
    } else if (globalMatch) {
      nodeType = globalMatch[1];
      var bi = parseInt(globalMatch[2]);
      if (wf[nodeType + "s"] && wf[nodeType + "s"][bi]) {
        wf[nodeType + "s"][bi] = NR.createNodeData();
      }
    }
    this.save();
  };

  /* ── Segment management ── */
  P.createSegments = function (wf, segmentDataArray) {
    var self = this;
    var segSteps = this.getSegmentSteps();
    wf.segments = segmentDataArray.map(function (segData, i) {
      var text = typeof segData === "string" ? segData : (segData.text || "");
      var seg = {
        id: "seg_" + i, index: i, scriptText: text,
        minorCharactersHint: segData.minor_characters || [],
        scenesHint: segData.scenes || [],
        mainCharacterNames: segData.main_character_names || [],
        hasMinor: !!(segData.minor_characters && segData.minor_characters.length),
      };
      segSteps.forEach(function (step) {
        seg[step.nodeType + "Count"] = 1;
        seg[step.nodeType + "s"] = [NR.createNodeData()];
        if (step.nodeType === "minorCharacters" && !seg.hasMinor) {
          seg[step.nodeType + "Skip"] = true;
        }
      });
      return seg;
    });
  };

  /* ── Exports ── */
  window.WF_Engine = WorkflowEngine;
  window.WF_LAYOUT = LAYOUT;
  window.WF_escapeHtml = escapeHtml;
})();
