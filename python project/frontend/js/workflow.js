(function () {
  "use strict";

  const NODE_TYPES = {
    input: { label: "输入", icon: "fa-pencil", color: "#8b5cf6" },
    script: { label: "剧本生成", icon: "fa-file-text-o", color: "#3b82f6" },
    mainCharacters: { label: "主要人物设定", icon: "fa-users", color: "#f59e0b" },
    minorCharacters: { label: "次要人物", icon: "fa-user", color: "#f97316" },
    scene: { label: "场景设定", icon: "fa-image", color: "#10b981" },
    storyboard: { label: "分镜图", icon: "fa-th", color: "#06b6d4" },
    videoPrompt: { label: "视频提示词", icon: "fa-film", color: "#ec4899" },
    output: { label: "最终输出", icon: "fa-check-circle", color: "#22c55e" }
  };

  const LAYOUT = { nodeW: 190, nodeH: 110, gapX: 80, gapY: 30, segGapY: 40, startX: 60, startY: 80 };

  let STATE = {
    workflows: [],
    currentWorkflowId: null,
    panX: 0, panY: 0, zoom: 1,
    panning: false, panStartX: 0, panStartY: 0,
    selectedNodeKey: null,
    detailOpen: false,
    outputOpen: false,
    running: false,
    runController: null,
  };

  function currentWorkflow() { return STATE.workflows.find((w) => w.id === STATE.currentWorkflowId) || null; }
  function makeId() { return "wf_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function makeVersionId() { return "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4); }
  function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

  // ===== Workflow CRUD =====
  function createWorkflow(title) {
    const wf = {
      id: makeId(), title: title || "新工作流", createdAt: new Date().toISOString(),
      input: { plot: "", style: "", type: "", duration: null, segmentCount: null },
      script: { status: "idle", versions: [], activeVersionId: null },
      mainCharacters: { status: "idle", versions: [], activeVersionId: null },
      segments: []
    };
    STATE.workflows.unshift(wf);
    STATE.currentWorkflowId = wf.id;
    saveWorkflowList();
    return wf;
  }

  function deleteWorkflow(id) {
    STATE.workflows = STATE.workflows.filter((w) => w.id !== id);
    if (STATE.currentWorkflowId === id) STATE.currentWorkflowId = STATE.workflows[0]?.id || null;
    saveWorkflowList();
    fetch(`/api/workflow/${id}`, { method: "DELETE" }).catch(() => {});
  }

  function getActiveVersion(node) {
    if (!node || !node.versions?.length) return null;
    return node.versions.find((v) => v.id === node.activeVersionId) || node.versions[node.versions.length - 1];
  }

  // ===== Persistence =====
  async function loadWorkflows() {
    try {
      const res = await fetch("/api/workflow/list");
      const result = await res.json();
      if (result.code === 0) STATE.workflows = result.data || [];
    } catch { STATE.workflows = []; }
    STATE.workflows.forEach(ensureWorkflowShape);
    if (!STATE.workflows.length) createWorkflow("我的第一个工作流");
    else STATE.currentWorkflowId = STATE.workflows[0]?.id || null;
  }

  function saveWorkflowList() {
    const wf = currentWorkflow();
    if (!wf) return;
    fetch("/api/workflow/" + wf.id, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wf)
    }).catch(() => {});
  }

  // ===== Layout Engine (mindmap) =====
  function ensureWorkflowShape(wf) {
    if (!wf.input) wf.input = {};
    if (!wf.input.plot) wf.input.plot = "";
    if (!wf.input.style) wf.input.style = "";
    if (!wf.input.type) wf.input.type = "";
    if (!wf.script) wf.script = { status: "idle", versions: [], activeVersionId: null };
    if (!wf.mainCharacters) wf.mainCharacters = { status: "idle", versions: [], activeVersionId: null };
    if (!wf.segments) wf.segments = [];
  }

  function computeLayout(wf) {
    if (!wf) return { nodes: [], edges: [] };
    ensureWorkflowShape(wf);
    const nodes = [];
    const edges = [];
    let x = LAYOUT.startX, y = LAYOUT.startY;

    nodes.push({ key: "input", type: "input", x, y, status: wf.input.plot ? "done" : "idle" });
    const prevX = x; x += LAYOUT.nodeW + LAYOUT.gapX;

    nodes.push({ key: "script", type: "script", x, y, status: wf.script.status });
    edges.push({ from: "input", to: "script" });
    x += LAYOUT.nodeW + LAYOUT.gapX;

    nodes.push({ key: "mainCharacters", type: "mainCharacters", x, y, status: wf.mainCharacters.status });
    edges.push({ from: "script", to: "mainCharacters" });

    const branchX = x + LAYOUT.nodeW + LAYOUT.gapX;
    const segments = wf.segments || [];
    const segNodeTypes = ["minorCharacters", "scene", "storyboard", "videoPrompt"];

    if (!segments.length) {
      nodes.push({ key: "output", type: "output", x: branchX, y, status: "idle" });
      edges.push({ from: "mainCharacters", to: "output" });
      return { nodes, edges };
    }

    segments.forEach((seg, si) => {
      const segY = y + si * (segNodeTypes.length * (LAYOUT.nodeH + LAYOUT.gapY) + LAYOUT.segGapY);
      segNodeTypes.forEach((type, ti) => {
        const nx = branchX + ti * (LAYOUT.nodeW + LAYOUT.gapX);
        const ny = segY;
        const key = `seg_${si}_${type}`;
        const nodeData = seg[type] || {};
        nodes.push({ key, type, x: nx, y: ny, status: nodeData.status || "idle", segIndex: si, segId: seg.id });
        if (ti === 0) edges.push({ from: "mainCharacters", to: key });
        else edges.push({ from: `seg_${si}_${segNodeTypes[ti - 1]}`, to: key });
      });
    });

    const lastSegType = segNodeTypes[segNodeTypes.length - 1];
    const outputX = branchX + segNodeTypes.length * (LAYOUT.nodeW + LAYOUT.gapX);
    const outputY = y + ((segments.length - 1) / 2) * (segNodeTypes.length * (LAYOUT.nodeH + LAYOUT.gapY) + LAYOUT.segGapY);
    nodes.push({ key: "output", type: "output", x: outputX, y: outputY, status: "idle" });
    segments.forEach((_, si) => { edges.push({ from: `seg_${si}_${lastSegType}`, to: "output" }); });

    return { nodes, edges };
  }

  // ===== Rendering =====
  function renderWorkflow() {
    const container = document.getElementById("workflow");
    if (!container) return;
    const wf = currentWorkflow();

    if (!wf) {
      container.innerHTML = `<div class="wf-empty"><div class="wf-empty-inner"><div class="wf-empty-icon"><i class="fa fa-film"></i></div><div class="wf-empty-title">还没有工作流</div><div class="wf-empty-desc">点击「新建工作流」开始创建 AI 视频分镜</div></div></div>`;
      return;
    }

    const { nodes, edges } = computeLayout(wf);

    container.innerHTML = `
      <div class="wf-shell">
        <div class="wf-main">
          <div class="wf-toolbar" id="wf-toolbar">
            <select id="wf-select" class="form-select" style="min-width:140px;">${STATE.workflows.map((w) => `<option value="${w.id}" ${w.id === STATE.currentWorkflowId ? "selected" : ""}>${escapeHtml(w.title)}</option>`).join("")}</select>
            <button class="btn" id="wf-new-btn"><i class="fa fa-plus"></i> 新建</button>
            <button class="btn danger" id="wf-del-btn"><i class="fa fa-trash-o"></i></button>
            <div class="wf-toolbar-sep"></div>
            <button class="btn primary" id="wf-run-all-btn"><i class="fa fa-play"></i> 一键生成</button>
            <button class="btn" id="wf-run-step-btn"><i class="fa fa-step-forward"></i> 逐步生成</button>
            <button class="btn danger" id="wf-stop-btn" disabled><i class="fa fa-stop"></i> 停止</button>
            <div class="wf-toolbar-sep"></div>
            <label style="font-size:11px;color:#94a3b8;">从</label>
            <select id="wf-from-node" class="form-select">${renderNodeOptions()}</select>
            <label style="font-size:11px;color:#94a3b8;">到</label>
            <select id="wf-to-node" class="form-select">${renderNodeOptions("videoPrompt")}</select>
            <div class="wf-toolbar-sep"></div>
            <button class="btn" id="wf-output-btn"><i class="fa fa-list"></i> 查看输出</button>
          </div>
          <div class="wf-canvas-wrap" id="wf-canvas-wrap">
            <div class="wf-canvas" id="wf-canvas" style="transform:translate(${STATE.panX}px,${STATE.panY}px) scale(${STATE.zoom})">
              <svg class="wf-svg">${edges.map((e) => renderEdge(e, nodes)).join("")}</svg>
              ${nodes.map((n) => renderNode(n, wf)).join("")}
            </div>
          </div>
          <div class="wf-output ${STATE.outputOpen ? "open" : ""}" id="wf-output-panel">${renderOutputPanel(wf)}</div>
        </div>
        <div class="wf-detail ${STATE.detailOpen ? "open" : ""}" id="wf-detail">${renderDetailPanel(wf)}</div>
      </div>
    `;
    bindWorkflowEvents();
  }

  function renderNodeOptions(defaultVal) {
    const opts = [
      { value: "script", label: "剧本生成" },
      { value: "mainCharacters", label: "主要人物设定" },
      { value: "minorCharacters", label: "次要人物" },
      { value: "scene", label: "场景设定" },
      { value: "storyboard", label: "分镜图" },
      { value: "videoPrompt", label: "视频提示词" },
    ];
    return opts.map((o) => `<option value="${o.value}" ${o.value === defaultVal ? "selected" : ""}>${o.label}</option>`).join("");
  }

  function renderNode(n, wf) {
    const meta = NODE_TYPES[n.type] || NODE_TYPES.input;
    const selected = STATE.selectedNodeKey === n.key ? "selected" : "";
    let preview = "";
    if (n.type === "input" && wf.input.plot) preview = escapeHtml(wf.input.plot.slice(0, 60)) + "...";
    else if (n.type === "script") { const v = getActiveVersion(wf.script); if (v) preview = escapeHtml((v.fullText || "").slice(0, 60)) + "..."; }
    else if (n.type === "mainCharacters") { const v = getActiveVersion(wf.mainCharacters); if (v?.characters?.length) preview = v.characters.map((c) => c.name).join("、"); }
    const segLabel = n.segIndex !== undefined ? `<span style="font-size:10px;color:#64748b;margin-left:auto;">段${n.segIndex + 1}</span>` : "";
    return `<div class="wf-node status-${n.status} ${selected}" data-node-key="${n.key}" style="left:${n.x}px;top:${n.y}px;">
      <div class="wf-node-header"><div class="wf-node-icon" style="background:${meta.color}22;color:${meta.color}"><i class="fa ${meta.icon}"></i></div><div class="wf-node-title">${meta.label}</div>${segLabel}</div>
      ${preview ? `<div class="wf-node-body">${preview}</div>` : ""}
      <div class="wf-node-footer"><div class="wf-node-status"></div><span style="font-size:10px;color:#64748b;">${n.status === "done" ? "已完成" : n.status === "running" ? "生成中..." : n.status === "error" ? "失败" : "待执行"}</span></div>
    </div>`;
  }

  function renderEdge(e, nodes) {
    const from = nodes.find((n) => n.key === e.from);
    const to = nodes.find((n) => n.key === e.to);
    if (!from || !to) return "";
    const x1 = from.x + LAYOUT.nodeW, y1 = from.y + LAYOUT.nodeH / 2;
    const x2 = to.x, y2 = to.y + LAYOUT.nodeH / 2;
    const mx = (x1 + x2) / 2;
    return `<path class="wf-edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  }

  // ===== Detail & Output Panels =====
  function renderDetailPanel(wf) {
    if (!STATE.detailOpen || !STATE.selectedNodeKey || !wf) return "";
    const key = STATE.selectedNodeKey;

    if (key === "input") {
      return `<div class="wf-detail-inner">
        <div class="wf-detail-title">输入设定 <button class="wf-detail-close" id="wf-detail-close">×</button></div>
        <div class="wf-detail-section"><div class="wf-detail-label">简要情节</div><textarea class="wf-detail-textarea" id="wf-input-plot" rows="4" placeholder="描述你的视频故事情节...">${escapeHtml(wf.input.plot)}</textarea></div>
        <div class="wf-detail-section"><div class="wf-detail-label">视频风格</div><input class="wf-detail-textarea" id="wf-input-style" style="min-height:auto;padding:10px 12px;" placeholder="如：水墨国风、赛博朋克、写实..." value="${escapeHtml(wf.input.style)}"></div>
        <div class="wf-detail-section"><div class="wf-detail-label">视频类型</div><input class="wf-detail-textarea" id="wf-input-type" style="min-height:auto;padding:10px 12px;" placeholder="如：短剧、广告、MV、纪录片..." value="${escapeHtml(wf.input.type)}"></div>
        <div class="wf-detail-section"><div class="wf-detail-label">段数（留空=AI自动）</div><input class="wf-detail-textarea" id="wf-input-segments" type="number" min="1" max="30" style="min-height:auto;padding:10px 12px;" placeholder="AI自动决定" value="${wf.input.segmentCount || ""}"></div>
        <div class="wf-detail-actions"><button class="btn primary" id="wf-save-input">保存</button></div>
      </div>`;
    }

    if (key === "script") {
      const v = getActiveVersion(wf.script);
      return `<div class="wf-detail-inner">
        <div class="wf-detail-title">剧本生成 <button class="wf-detail-close" id="wf-detail-close">×</button></div>
        ${v ? `<div class="wf-detail-section"><div class="wf-detail-label">完整剧本</div><textarea class="wf-detail-textarea" id="wf-script-text" rows="8">${escapeHtml(v.fullText)}</textarea></div>
        <div class="wf-detail-section"><div class="wf-detail-label">分段 (${v.segments?.length || 0} 段)</div>${(v.segments || []).map((s, i) => `<div class="wf-detail-text"><strong>段${i + 1}</strong> (${s.duration}s)<br>${escapeHtml(s.text)}</div>`).join("")}</div>` : `<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>`}
        ${renderVersionList(wf.script)}
        <div class="wf-detail-actions"><button class="btn primary" id="wf-gen-script"><i class="fa fa-refresh"></i> ${v ? "重新生成" : "生成剧本"}</button></div>
      </div>`;
    }

    if (key === "mainCharacters") {
      const v = getActiveVersion(wf.mainCharacters);
      return `<div class="wf-detail-inner">
        <div class="wf-detail-title">主要人物设定 <button class="wf-detail-close" id="wf-detail-close">×</button></div>
        ${v?.characters?.length ? v.characters.map((c) => `<div class="wf-detail-section"><div class="wf-detail-label">${escapeHtml(c.name)}</div><div class="wf-detail-text">${escapeHtml(c.description)}</div>${c.imageUrl ? `<img class="wf-detail-img" src="${escapeHtml(c.imageUrl)}">` : ""}</div>`).join("") : `<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>`}
        ${renderVersionList(wf.mainCharacters)}
        <div class="wf-detail-actions"><button class="btn primary" id="wf-gen-main-chars"><i class="fa fa-refresh"></i> ${v ? "重新生成" : "生成人物"}</button></div>
      </div>`;
    }

    const segMatch = key.match(/^seg_(\d+)_(\w+)$/);
    if (segMatch) {
      const si = parseInt(segMatch[1]);
      const type = segMatch[2];
      const seg = wf.segments[si];
      if (!seg) return "";
      const nodeData = seg[type] || {};
      const v = getActiveVersion(nodeData);
      const meta = NODE_TYPES[type];
      let content = "";
      if (type === "scene" && v) content = `<div class="wf-detail-text">${escapeHtml(v.description)}</div>${v.imageUrl ? `<img class="wf-detail-img" src="${escapeHtml(v.imageUrl)}">` : ""}`;
      else if (type === "minorCharacters" && v?.characters?.length) content = v.characters.map((c) => `<div class="wf-detail-text"><strong>${escapeHtml(c.name)}</strong><br>${escapeHtml(c.description)}</div>${c.imageUrl ? `<img class="wf-detail-img" src="${escapeHtml(c.imageUrl)}">` : ""}`).join("");
      else if (type === "storyboard" && v?.images?.length) content = `<div style="display:grid;grid-template-columns:repeat(${Math.ceil(Math.sqrt(v.images.length))},1fr);gap:6px;">${v.images.map((url) => `<img class="wf-detail-img" src="${escapeHtml(url)}">`).join("")}</div>`;
      else if (type === "videoPrompt" && v) content = `<div class="wf-detail-section"><div class="wf-detail-label">运镜</div><div class="wf-detail-text">${escapeHtml(v.camera)}</div></div><div class="wf-detail-section"><div class="wf-detail-label">音效</div><div class="wf-detail-text">${escapeHtml(v.sound)}</div></div><div class="wf-detail-section"><div class="wf-detail-label">配音</div><div class="wf-detail-text">${escapeHtml(v.voiceover)}</div></div><div class="wf-detail-section"><div class="wf-detail-label">过渡</div><div class="wf-detail-text">${escapeHtml(v.transition)}</div></div><div class="wf-detail-section"><div class="wf-detail-label">完整提示词</div><textarea class="wf-detail-textarea" rows="6" id="wf-vp-fulltext">${escapeHtml(v.fullText)}</textarea></div>`;
      if (!content && !v) content = `<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>`;
      const gridSelect = type === "storyboard" ? `<div class="wf-detail-section"><div class="wf-detail-label">宫格数</div><select id="wf-grid-select" style="background:#111827;border:1px solid rgba(148,163,184,.16);color:#e5e7eb;border-radius:10px;padding:8px;width:100%;"><option value="4" ${(nodeData.grid||4)===4?"selected":""}>4 宫格</option><option value="9" ${(nodeData.grid||4)===9?"selected":""}>9 宫格</option><option value="16" ${(nodeData.grid||4)===16?"selected":""}>16 宫格</option></select></div>` : "";
      return `<div class="wf-detail-inner">
        <div class="wf-detail-title">${meta.label} · 段${si + 1} <button class="wf-detail-close" id="wf-detail-close">×</button></div>
        <div class="wf-detail-section"><div class="wf-detail-label">段落剧本</div><div class="wf-detail-text">${escapeHtml(seg.scriptText)}</div></div>
        ${gridSelect}${content}${renderVersionList(nodeData)}
        <div class="wf-detail-actions"><button class="btn primary" data-gen-seg="${si}" data-gen-type="${type}"><i class="fa fa-refresh"></i> ${v ? "重新生成" : "生成"}</button></div>
      </div>`;
    }

    return "";
  }

  function renderVersionList(node) {
    if (!node?.versions?.length || node.versions.length <= 1) return "";
    return `<div class="wf-detail-section"><div class="wf-detail-label">历史版本</div><div class="wf-version-list">${node.versions.map((v) => `<div class="wf-version-item ${v.id === node.activeVersionId ? "active" : ""}" data-version-id="${v.id}"><span>${v.createdAt ? new Date(v.createdAt).toLocaleString("zh-CN") : v.id}</span>${v.id === node.activeVersionId ? "<span>当前</span>" : ""}</div>`).join("")}</div></div>`;
  }

  function renderOutputPanel(wf) {
    if (!wf?.segments?.length) return `<div class="wf-output-header"><div class="wf-output-title">最终输出</div><button class="btn" id="wf-output-close">收起</button></div><div style="padding:24px;text-align:center;color:#64748b;">暂无输出内容</div>`;
    const cards = wf.segments.map((seg, i) => {
      const vp = getActiveVersion(seg.videoPrompt || {});
      const sb = getActiveVersion(seg.storyboard || {});
      const imgSrc = sb?.images?.[0] || "";
      return `<div class="wf-output-card">${imgSrc ? `<img class="wf-output-card-img" src="${escapeHtml(imgSrc)}">` : ""}<div class="wf-output-card-body"><div class="wf-output-card-title">段${i + 1}</div><div class="wf-output-card-text">${vp ? escapeHtml((vp.fullText || "").slice(0, 200)) : "提示词未生成"}</div><div class="wf-output-card-actions"><button class="btn" data-copy-vp="${i}"><i class="fa fa-copy"></i> 复制</button></div></div></div>`;
    }).join("");
    return `<div class="wf-output-header"><div class="wf-output-title">最终输出 · ${wf.segments.length} 段</div><button class="btn" id="wf-output-close">收起</button></div><div class="wf-output-grid">${cards}</div>`;
  }

  // ===== Events =====
  let _eventsBound = false;

  function bindWorkflowEvents() {
    if (_eventsBound) return;
    _eventsBound = true;

    window.addEventListener("mousemove", (e) => {
      if (!STATE.panning) return;
      STATE.panX = e.clientX - STATE.panStartX;
      STATE.panY = e.clientY - STATE.panStartY;
      const canvas = document.getElementById("wf-canvas");
      if (canvas) canvas.style.transform = `translate(${STATE.panX}px,${STATE.panY}px) scale(${STATE.zoom})`;
    });
    window.addEventListener("mouseup", () => {
      if (STATE.panning) {
        STATE.panning = false;
        const canvas = document.getElementById("wf-canvas");
        if (canvas) canvas.classList.remove("panning");
      }
    });

    document.addEventListener("mousedown", (e) => {
      const wrap = e.target.closest?.("#wf-canvas-wrap");
      if (!wrap || e.target.closest(".wf-node")) return;
      STATE.panning = true;
      STATE.panStartX = e.clientX - STATE.panX;
      STATE.panStartY = e.clientY - STATE.panY;
      const canvas = document.getElementById("wf-canvas");
      if (canvas) canvas.classList.add("panning");
    });

    document.addEventListener("wheel", (e) => {
      if (!e.target.closest?.("#wf-canvas-wrap")) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.06 : 0.06;
      STATE.zoom = Math.max(0.3, Math.min(2, STATE.zoom + delta));
      const canvas = document.getElementById("wf-canvas");
      if (canvas) canvas.style.transform = `translate(${STATE.panX}px,${STATE.panY}px) scale(${STATE.zoom})`;
    }, { passive: false });

    document.addEventListener("click", (e) => {
      const wfRoot = e.target.closest?.("#workflow");
      if (!wfRoot) return;
      const target = e.target;

      const node = target.closest?.(".wf-node");
      if (node) {
        STATE.selectedNodeKey = node.getAttribute("data-node-key");
        STATE.detailOpen = true;
        renderWorkflow();
        return;
      }
      if (target.closest?.("#wf-detail-close")) { STATE.detailOpen = false; STATE.selectedNodeKey = null; renderWorkflow(); return; }
      if (target.closest?.("#wf-output-close")) { STATE.outputOpen = false; renderWorkflow(); return; }
      if (target.closest?.("#wf-output-btn")) { STATE.outputOpen = !STATE.outputOpen; renderWorkflow(); return; }
      if (target.closest?.("#wf-new-btn")) { createWorkflow(); renderWorkflow(); return; }
      if (target.closest?.("#wf-del-btn")) { if (confirm("确定删除当前工作流？")) { deleteWorkflow(STATE.currentWorkflowId); renderWorkflow(); } return; }
      if (target.closest?.("#wf-save-input")) { saveInputNode(); return; }
      if (target.closest?.("#wf-gen-script")) { generateNode("script"); return; }
      if (target.closest?.("#wf-gen-main-chars")) { generateNode("mainCharacters"); return; }
      const genSeg = target.closest?.("[data-gen-seg]");
      if (genSeg) { generateNode(genSeg.getAttribute("data-gen-type"), parseInt(genSeg.getAttribute("data-gen-seg"))); return; }
      if (target.closest?.("#wf-run-all-btn")) { runWorkflow("all"); return; }
      if (target.closest?.("#wf-run-step-btn")) { runWorkflow("step"); return; }
      if (target.closest?.("#wf-stop-btn")) { stopWorkflow(); return; }
      const copyVp = target.closest?.("[data-copy-vp]");
      if (copyVp) { copyVideoPrompt(parseInt(copyVp.getAttribute("data-copy-vp"))); return; }
    });

    document.addEventListener("change", (e) => {
      if (e.target.id === "wf-select") {
        STATE.currentWorkflowId = e.target.value;
        STATE.selectedNodeKey = null;
        STATE.detailOpen = false;
        renderWorkflow();
      }
    });
  }

  function saveInputNode() {
    const wf = currentWorkflow();
    if (!wf) return;
    wf.input.plot = document.getElementById("wf-input-plot")?.value || "";
    wf.input.style = document.getElementById("wf-input-style")?.value || "";
    wf.input.type = document.getElementById("wf-input-type")?.value || "";
    wf.input.segmentCount = parseInt(document.getElementById("wf-input-segments")?.value) || null;
    saveWorkflowList();
    renderWorkflow();
  }

  function copyVideoPrompt(segIndex) {
    const wf = currentWorkflow();
    if (!wf?.segments?.[segIndex]) return;
    const vp = getActiveVersion(wf.segments[segIndex].videoPrompt || {});
    if (vp?.fullText && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(vp.fullText).then(() => alert("已复制")).catch(() => {});
    }
  }

  // ===== Generation API calls =====
  async function generateNode(type, segIndex) {
    const wf = currentWorkflow();
    if (!wf) return;
    const chatSel = document.getElementById("chat-config-select")?.value || (window.GLOBAL?.configList || []).find((c) => ["chat", "both"].includes(c.config_type))?.id || "";
    const imageSel = document.getElementById("image-config-select")?.value || (window.GLOBAL?.configList || []).find((c) => ["image", "both"].includes(c.config_type))?.id || "";

    try {
      let url = "", body = {};
      if (type === "script") {
        url = "/api/workflow/generate/script";
        body = { workflow_id: wf.id, chat_config_id: chatSel, plot: wf.input.plot, style: wf.input.style, type: wf.input.type, segment_count: wf.input.segmentCount };
        wf.script.status = "running"; renderWorkflow();
      } else if (type === "mainCharacters") {
        const sv = getActiveVersion(wf.script);
        url = "/api/workflow/generate/main-characters";
        body = { workflow_id: wf.id, chat_config_id: chatSel, image_config_id: imageSel, script: sv?.fullText || "", style: wf.input.style };
        wf.mainCharacters.status = "running"; renderWorkflow();
      } else if (segIndex !== undefined && wf.segments[segIndex]) {
        const seg = wf.segments[segIndex];
        const sv = getActiveVersion(wf.script);
        const mcv = getActiveVersion(wf.mainCharacters);
        if (type === "minorCharacters") {
          url = "/api/workflow/generate/minor-characters";
          body = { workflow_id: wf.id, chat_config_id: chatSel, image_config_id: imageSel, segment_text: seg.scriptText, main_characters: mcv?.characters || [], style: wf.input.style };
        } else if (type === "scene") {
          url = "/api/workflow/generate/scene";
          const mcChars = getActiveVersion(seg.minorCharacters || {})?.characters || [];
          body = { workflow_id: wf.id, chat_config_id: chatSel, image_config_id: imageSel, segment_text: seg.scriptText, characters: [...(mcv?.characters || []), ...mcChars], style: wf.input.style };
        } else if (type === "storyboard") {
          url = "/api/workflow/generate/storyboard";
          const sceneV = getActiveVersion(seg.scene || {});
          body = { workflow_id: wf.id, image_config_id: imageSel, segment_text: seg.scriptText, scene_description: sceneV?.description || "", characters: mcv?.characters || [], grid: seg.storyboard?.grid || 4, style: wf.input.style };
        } else if (type === "videoPrompt") {
          url = "/api/workflow/generate/video-prompt";
          const sceneV = getActiveVersion(seg.scene || {});
          const sbV = getActiveVersion(seg.storyboard || {});
          body = { workflow_id: wf.id, chat_config_id: chatSel, segment_text: seg.scriptText, segment_index: segIndex, total_segments: wf.segments.length, scene_description: sceneV?.description || "", characters: mcv?.characters || [], storyboard_images: sbV?.images || [], style: wf.input.style, type: wf.input.type };
        }
        if (seg[type]) seg[type].status = "running";
        renderWorkflow();
      }

      if (!url) return;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await res.json();
      if (result.code !== 0) throw new Error(result.message || result.detail || "生成失败");

      applyGenerationResult(wf, type, segIndex, result.data);
      saveWorkflowList();
      renderWorkflow();
    } catch (err) {
      if (type === "script") wf.script.status = "error";
      else if (type === "mainCharacters") wf.mainCharacters.status = "error";
      else if (segIndex !== undefined && wf.segments[segIndex]?.[type]) wf.segments[segIndex][type].status = "error";
      renderWorkflow();
      alert("生成失败：" + err.message);
    }
  }

  function applyGenerationResult(wf, type, segIndex, data) {
    const vid = makeVersionId();
    const now = new Date().toISOString();
    if (type === "script") {
      const version = { id: vid, createdAt: now, fullText: data.full_text || "", segments: data.segments || [] };
      wf.script.versions.push(version);
      wf.script.activeVersionId = vid;
      wf.script.status = "done";
      wf.segments = (data.segments || []).map((s, i) => ({
        id: "seg_" + i, scriptText: s.text || "", index: i,
        minorCharacters: { status: "idle", versions: [], activeVersionId: null },
        scene: { status: "idle", versions: [], activeVersionId: null },
        storyboard: { status: "idle", grid: 4, versions: [], activeVersionId: null },
        videoPrompt: { status: "idle", versions: [], activeVersionId: null }
      }));
    } else if (type === "mainCharacters") {
      const version = { id: vid, createdAt: now, characters: data.characters || [] };
      wf.mainCharacters.versions.push(version);
      wf.mainCharacters.activeVersionId = vid;
      wf.mainCharacters.status = "done";
    } else if (segIndex !== undefined && wf.segments[segIndex]) {
      const seg = wf.segments[segIndex];
      if (type === "minorCharacters") {
        const version = { id: vid, createdAt: now, characters: data.characters || [] };
        seg.minorCharacters.versions.push(version);
        seg.minorCharacters.activeVersionId = vid;
        seg.minorCharacters.status = "done";
      } else if (type === "scene") {
        const version = { id: vid, createdAt: now, description: data.description || "", imageUrl: data.image_url || "" };
        seg.scene.versions.push(version);
        seg.scene.activeVersionId = vid;
        seg.scene.status = "done";
      } else if (type === "storyboard") {
        const version = { id: vid, createdAt: now, images: data.images || [] };
        seg.storyboard.versions.push(version);
        seg.storyboard.activeVersionId = vid;
        seg.storyboard.status = "done";
      } else if (type === "videoPrompt") {
        const version = { id: vid, createdAt: now, camera: data.camera || "", sound: data.sound || "", voiceover: data.voiceover || "", transition: data.transition || "", fullText: data.full_text || "" };
        seg.videoPrompt.versions.push(version);
        seg.videoPrompt.activeVersionId = vid;
        seg.videoPrompt.status = "done";
      }
    }
  }

  async function runWorkflow(mode) {
    const wf = currentWorkflow();
    if (!wf || STATE.running) return;
    if (!wf.input.plot) { alert("请先填写输入信息"); STATE.selectedNodeKey = "input"; STATE.detailOpen = true; renderWorkflow(); return; }
    STATE.running = true;
    renderWorkflow();
    const fromNode = document.getElementById("wf-from-node")?.value || "script";
    const toNode = document.getElementById("wf-to-node")?.value || "videoPrompt";
    const nodeOrder = ["script", "mainCharacters", "minorCharacters", "scene", "storyboard", "videoPrompt"];
    const fromIdx = nodeOrder.indexOf(fromNode);
    const toIdx = nodeOrder.indexOf(toNode);
    const steps = nodeOrder.slice(fromIdx, toIdx + 1);

    try {
      for (const step of steps) {
        if (!STATE.running) break;
        if (step === "script" || step === "mainCharacters") {
          await generateNode(step);
          if (mode === "step" && step !== steps[steps.length - 1]) {
            if (!confirm(`${NODE_TYPES[step].label} 已完成，继续下一步？`)) break;
          }
        } else {
          for (let si = 0; si < wf.segments.length; si++) {
            if (!STATE.running) break;
            await generateNode(step, si);
          }
          if (mode === "step" && step !== steps[steps.length - 1]) {
            if (!confirm(`所有段落的${NODE_TYPES[step].label}已完成，继续下一步？`)) break;
          }
        }
      }
    } catch (err) {
      console.error("[workflow] run error", err);
    } finally {
      STATE.running = false;
      renderWorkflow();
    }
  }

  function stopWorkflow() { STATE.running = false; renderWorkflow(); }

  // ===== Init =====
  let _initialized = false;

  async function initWorkflowModule() {
    if (!_initialized) {
      _initialized = true;
      bindWorkflowEvents();
      await loadWorkflows();
    }
    renderWorkflow();
  }

  window.initWorkflowModule = initWorkflowModule;
})();
