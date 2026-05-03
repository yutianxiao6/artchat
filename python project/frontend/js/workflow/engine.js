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
    this.pipeline = pipelineDef.pipeline || [];
    this.defId = pipelineDef.id || "default";
    this.defTitle = pipelineDef.title || "工作流";
    this.workflows = [];
    this.currentId = null;
    this.running = false;
    this.runningNodes = {};
    this.execRange = { from: null, to: null, segments: "all" };
    this.solidDividers = {};
    this.selectedNodeKey = null;
    this.selectedBranch = 0;
    this.detailOpen = false;
    this.historyOpen = false;
    this.panX = 0; this.panY = 0; this.zoom = 1;
    this.panning = false; this.panStartX = 0; this.panStartY = 0;
    this._stopFlag = false;
  }

  var P = WorkflowEngine.prototype;

  /* ── current ── */
  P.current = function () {
    var id = this.currentId;
    return this.workflows.find(function (w) { return w.id === id; }) || null;
  };

  /* ── CRUD ── */
  P.create = function (title) {
    var wf = {
      id: makeId(),
      title: title || "新工作流",
      createdAt: new Date().toISOString(),
      input: { plot: "", style: "", type: "", segmentCount: null },
      mode: "single",
      multiCount: 1,
      history: [],
    };
    var self = this;
    this.pipeline.forEach(function (step) {
      if (step.nodeType === "input") return;
      if (step.category === "global") {
        wf[step.nodeType + "Count"] = 1;
        wf[step.nodeType + "s"] = [NR.createNodeData()];
      }
    });
    wf.segments = [];
    this.workflows.unshift(wf);
    this.currentId = wf.id;
    this.save();
    return wf;
  };

  P.delete = function (id) {
    this.workflows = this.workflows.filter(function (w) { return w.id !== id; });
    if (this.currentId === id) this.currentId = this.workflows[0] ? this.workflows[0].id : null;
    this.save();
    fetch("/api/workflow/" + id, { method: "DELETE" }).catch(function () {});
  };

  P.ensureShape = function (wf) {
    if (!wf) return;
    if (!wf.input) wf.input = { plot: "", style: "", type: "", segmentCount: null };
    if (!wf.input.plot) wf.input.plot = "";
    if (!wf.input.style) wf.input.style = "";
    if (!wf.input.type) wf.input.type = "";
    if (!wf.history) wf.history = [];
    if (!wf.mode) wf.mode = "single";
    if (!wf.multiCount) wf.multiCount = 1;
    if (!wf.segments) wf.segments = [];
    var self = this;
    this.pipeline.forEach(function (step) {
      if (step.nodeType === "input" || step.nodeType === "output") return;
      if (step.category === "global") {
        var countKey = step.nodeType + "Count";
        var arrayKey = step.nodeType + "s";
        if (!wf[countKey]) wf[countKey] = 1;
        if (!wf[arrayKey] || !wf[arrayKey].length) wf[arrayKey] = [NR.createNodeData()];
      }
    });
    wf.segments.forEach(function (seg) {
      self.pipeline.forEach(function (step) {
        if (step.category !== "segment") return;
        var countKey = step.nodeType + "Count";
        var arrayKey = step.nodeType + "s";
        if (!seg[countKey]) seg[countKey] = 1;
        if (!seg[arrayKey] || !seg[arrayKey].length) seg[arrayKey] = [NR.createNodeData()];
      });
    });
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
    this.workflows.forEach(function (w) { self.ensureShape(w); });
    if (!this.workflows.length) this.create("我的第一个工作流");
    else this.currentId = this.workflows[0].id;
  };

  P.save = function () {
    var wf = this.current();
    if (!wf) return;
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
    if (wf.mode === "multi") {
      return wf.scriptCount || 1;
    }
    return wf.multiCount || 1;
  };

  P.getGlobalSteps = function () {
    return this.pipeline.filter(function (s) { return s.category === "global" || s.nodeType === "input" || s.nodeType === "output"; });
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
      } else if (step.nodeType === "input") {
        var inputKey = "input";
        nodes.push({ key: inputKey, type: "input", x: colX, y: baseY, status: wf.input.plot ? "done" : "idle" });
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
    var steps = this.pipeline.filter(function (s) { return s.nodeType !== "input" && s.nodeType !== "output"; });
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

  P.run = async function (onUpdate) {
    var wf = this.current();
    if (!wf || this.running) return;
    if (!wf.input.plot) { alert("请先填写输入信息"); return; }
    this.running = true;
    this.runningWfId = wf.id;
    this._stopFlag = false;
    this.runningNodes = {};
    this._resetStuckNodes(wf);
    if (onUpdate) onUpdate();

    var steps = this.pipeline.filter(function (s) { return s.nodeType !== "input"; });
    var segSteps = this.getSegmentSteps();
    var self = this;

    try {
      // Global steps first
      for (var i = 0; i < steps.length; i++) {
        if (self._stopFlag) break;
        var step = steps[i];
        if (step.category !== "global") continue;
        if (wf[step.nodeType + "Skip"]) continue;
        await self._runGlobalStep(wf, step, onUpdate);
      }

      // Segment steps: per-segment order (finish segment 1 before segment 2)
      var segIdxs = self.getExecSegments(wf);
      for (var si = 0; si < segIdxs.length; si++) {
        if (self._stopFlag) break;
        for (var j = 0; j < segSteps.length; j++) {
          if (self._stopFlag) break;
          var segStep = segSteps[j];
          if (wf[segStep.nodeType + "Skip"]) continue;
          await self._runSegmentStep(wf, segStep, segIdxs[si], onUpdate);
        }
      }
    } catch (err) {
      console.error("[workflow] run error", err);
    } finally {
      self.running = false;
      self.runningWfId = null;
      self.runningNodes = {};
      self.saveWorkflow(wf);
      if (onUpdate) onUpdate();
    }
  };

  function _hasImage(v) {
    if (!v) return false;
    if (v.imageUrl) return true;
    if (v.images && v.images.length) return true;
    if (v.characters && v.characters.some(function (c) { return c.imageUrl; })) return true;
    if (v.scenes && v.scenes.some(function (s) { return s.imageUrl; })) return true;
    return false;
  }

  P._runGlobalStep = async function (wf, step, onUpdate, forceAll) {
    var typeDef = NR.get(step.nodeType);
    if (!typeDef || !typeDef.generate) return;
    var arr = wf[step.nodeType + "s"];
    if (!arr || !arr.length) { arr = [NR.createNodeData()]; wf[step.nodeType + "s"] = arr; }

    var self = this;
    var nd = arr[0];
    if (!forceAll && NR.getActiveVersion(nd)) {
      if (!typeDef.needsImage || _hasImage(NR.getActiveVersion(nd))) return;
    }
    nd.status = "running";
    self.runningNodes[step.nodeType + "_0"] = true;
    if (onUpdate) onUpdate();

    try {
      var result = await typeDef.generate({ workflow: wf, nodeData: nd, branchIdx: 0 });
      if (result) NR.addVersion(nd, result);
      self._addHistory(wf, step.nodeType, 0, null, "done");
    } catch (err) {
      nd.status = "error";
      self._addHistory(wf, step.nodeType, 0, null, "error", err.message);
    } finally {
      delete self.runningNodes[step.nodeType + "_0"];
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
    var promises = [];
    for (var bi = 0; bi < branchCount; bi++) {
      (function (idx) {
        var nd = arr[idx];
        if (!nd) { nd = NR.createNodeData(); arr[idx] = nd; }
        if (!forceAll && NR.getActiveVersion(nd)) {
          if (!typeDef.needsImage || _hasImage(NR.getActiveVersion(nd))) return;
        }
        if (nd.status === "running") return;
        nd.status = "running";
        var nk = "seg_" + segIdx + "_" + step.nodeType + "_" + idx;
        self.runningNodes[nk] = true;
        if (onUpdate) onUpdate();

        var p = typeDef.generate({ workflow: wf, nodeData: nd, branchIdx: idx, segIndex: segIdx, segment: seg })
          .then(function (result) {
            if (result) NR.addVersion(nd, result);
            self._addHistory(wf, step.nodeType, idx, segIdx, "done");
          })
          .catch(function (err) {
            nd.status = "error";
            self._addHistory(wf, step.nodeType, idx, segIdx, "error", err.message);
          })
          .finally(function () {
            delete self.runningNodes[nk];
            if (onUpdate) onUpdate();
          });
        promises.push(p);
      })(bi);
    }
    await Promise.all(promises);
  };

  P.stop = function () { this._stopFlag = true; this.running = false; };

  P._addHistory = function (wf, nodeType, branchIdx, segIdx, status, errorMsg) {
    if (!wf.history) wf.history = [];
    wf.history.push({
      id: NR.makeVersionId(),
      time: new Date().toISOString(),
      nodeType: nodeType,
      branchIdx: branchIdx,
      segIndex: segIdx,
      status: status,
      error: errorMsg || null,
    });
    if (wf.history.length > 500) wf.history = wf.history.slice(-500);
  };

  P._resetStuckNodes = function (wf) {
    var self = this;
    this.pipeline.forEach(function (step) {
      if (step.nodeType === "input") return;
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
        storyboardGrid: segData.storyboard_grid || 4,
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
