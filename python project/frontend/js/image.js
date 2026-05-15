(function () {
  // ── 尺寸系统 ────────────────────────────────
  const CANVAS_SIZE_PRESETS = [
    { label: "1024 × 1024 · 1:1", w: 1024, h: 1024 },
    { label: "1024 × 1536 · 2:3 竖", w: 1024, h: 1536 },
    { label: "1536 × 1024 · 3:2 横", w: 1536, h: 1024 },
    { label: "1152 × 2048 · 9:16 竖", w: 1152, h: 2048 },
    { label: "2048 × 1152 · 16:9 横", w: 2048, h: 1152 },
    { label: "1440 × 1920 · 3:4 竖", w: 1440, h: 1920 },
    { label: "1920 × 1440 · 4:3 横", w: 1920, h: 1440 },
    { label: "2048 × 2048 · 1:1 高清", w: 2048, h: 2048 },
    { label: "1920 × 1080 · 全高清", w: 1920, h: 1080 },
    { label: "2160 × 3840 · 4K 竖", w: 2160, h: 3840 },
    { label: "3840 × 2160 · 4K 横", w: 3840, h: 2160 },
  ];
  const MAX_IMAGE_EDGE = 3840;
  const MIN_IMAGE_EDGE = 256;
  const MAX_RATIO = 3.0;
  const MIN_PIXELS = 655360;
  const MAX_PIXELS = 8294400;

  function align16(n) {
    const v = Math.max(MIN_IMAGE_EDGE, Math.floor(Number(n) / 16) * 16);
    return Math.min(v, MAX_IMAGE_EDGE);
  }

  function clampCanvasSize(w, h) {
    w = Number(w) | 0; h = Number(h) | 0;
    if (w <= 0 || h <= 0) return { width: 1024, height: 1024 };
    let longest = Math.max(w, h);
    if (longest > MAX_IMAGE_EDGE) {
      const s = MAX_IMAGE_EDGE / longest;
      w = Math.floor(w * s); h = Math.floor(h * s);
    }
    w = align16(w); h = align16(h);
    const longSide = Math.max(w, h), shortSide = Math.min(w, h);
    if (shortSide > 0 && longSide / shortSide > MAX_RATIO) {
      const newShort = align16(Math.floor(longSide / MAX_RATIO));
      if (w >= h) h = newShort; else w = newShort;
    }
    let pixels = w * h;
    if (pixels > MAX_PIXELS) {
      const s = Math.sqrt(MAX_PIXELS / pixels);
      w = align16(Math.floor(w * s)); h = align16(Math.floor(h * s));
    }
    pixels = w * h;
    if (pixels < MIN_PIXELS) {
      const s = Math.sqrt(MIN_PIXELS / pixels);
      w = align16(Math.max(MIN_IMAGE_EDGE, Math.floor(w * s) + 15));
      h = align16(Math.max(MIN_IMAGE_EDGE, Math.floor(h * s) + 15));
      if (w * h < MIN_PIXELS) {
        if (w <= h) w += 16; else h += 16;
      }
    }
    return { width: w, height: h };
  }

  function legacyResolveCanvasSize(resolution, ratio) {
    const longSideMap = { "1K": 1024, "2K": 2048, "4K": 3840 };
    const longSide = longSideMap[String(resolution || "1K")] || 1024;
    const [rw, rh] = String(ratio || "1:1").split(":").map((v) => Math.max(1, Number(v || 1)));
    const landscape = rw >= rh;
    const ratioValue = rw / rh;
    let width, height;
    if (landscape) { width = longSide; height = Math.round(longSide / ratioValue); }
    else { height = longSide; width = Math.round(longSide * ratioValue); }
    return clampCanvasSize(width, height);
  }

  function isGptImageModel(modelName) { return /gpt-image/i.test(String(modelName || "")); }
  const DEFAULT_NEGATIVE_PROMPT = "low quality, blurry, distorted, bad anatomy, extra fingers, watermark, text, cropped, artifacts";

  // 未上传图时的默认节点尺寸（视觉上也是占位框尺寸）
  const NODE_DEFAULT_W = 280;
  const NODE_DEFAULT_H = 280;
  // 自适应节点的显示尺寸封顶（实际生成尺寸在 node.width/height）
  const NODE_DISPLAY_MAX_W = 360;
  const NODE_DISPLAY_MAX_H = 400;
  const NODE_DISPLAY_MIN = 140;

  const NODE_WIDTH = NODE_DEFAULT_W; // 旧变量保留以兼容引用
  const PORT_RADIUS = 14;
  const SNAP_DISTANCE = 120;
  const MIN_ZOOM = 0.45;
  const MAX_ZOOM = 1.8;
  const DEFAULT_ASSET_CATEGORY = "未分类";

  const STATE = {
    initialized: false,
    nodes: [],
    edges: [],
    selectedNodeId: null,
    expandedNodeId: null,
    resizingNode: null,
    selectedEdgeId: null,
    draggingNodeId: null,
    dragMoved: false,
    dragFramePending: false,
    selectionBox: null,
    selectedNodeIds: [],
    dragOffsetX: 0,
    dragOffsetY: 0,
    panX: 0,
    panY: 0,
    zoom: 1,
    panning: false,
    panStartX: 0,
    panStartY: 0,
    connectionDrag: null,
    assetLibrary: [],
    historySessions: [],
    currentHistoryId: null,
    clipboardNode: null,
    undoStack: [],
    activeAssetCategory: "全部",
    pendingAssetCategory: DEFAULT_ASSET_CATEGORY,
    measuredNodeCenters: {},
    previewImageUrl: "",
    isAssetLibraryOpen: false,
    categories: [],
    categoryModal: { visible: false, mode: "create", targetImageUrl: "", targetTitle: "", targetAssetId: "", initialValue: "", category: "未分类" },
    contextMenu: { visible: false, x: 0, y: 0, canvasPoint: null, scope: "board", payload: null },
    assetLibraryDrag: { active: false, offsetX: 0, offsetY: 0 },
    assetLibraryPosition: null,
    debugInfo: { loadStateStatus: "booting", loadStateMessage: "script loaded", loadStateUrl: `${window.location.origin}/api/canvas/state` },
  };

  document.addEventListener("DOMContentLoaded", () => { if (document.getElementById("image")) initImageModule(); });
  let __imageModuleBootAttempts = 0;
  const __imageModuleBootTimer = setInterval(() => {
    __imageModuleBootAttempts += 1;
    const tab = document.getElementById("image");
    if (tab && (!STATE.initialized || !document.getElementById("canvas-board"))) {
      initImageModule();
    }
    if (__imageModuleBootAttempts >= 40 || (STATE.initialized && document.getElementById("canvas-board"))) {
      clearInterval(__imageModuleBootTimer);
    }
  }, 250);
  window.initImageModule = initImageModule;

  async function initImageModule() {
    const tab = document.getElementById("image");
    if (!tab) return;
    if (!STATE.boundWindowDebug) {
      STATE.boundWindowDebug = true;
      window.__IMAGE_CANVAS_STATE__ = STATE;
    }
    try {
      STATE.debugInfo.loadStateStatus = "init";
      STATE.debugInfo.loadStateMessage = "initImageModule:start";
      if (STATE.initialized) {
        if (!document.getElementById("canvas-board")) {
          STATE.debugInfo.loadStateMessage = "initImageModule:rebuild-workbench";
          buildImageWorkbench();
          bindWorkbenchEvents();
        }
        syncNodeModelDefaults();
        renderCanvas(); renderLeftPanel(); syncMeasuredPorts();
        STATE.debugInfo.loadStateStatus = "ready";
        STATE.debugInfo.loadStateMessage = `reused; sessions=${STATE.historySessions.length}; nodes=${STATE.nodes.length}`;
        return;
      }
      STATE.initialized = true;
      STATE.debugInfo.loadStateMessage = "initImageModule:inject-styles";
      injectCanvasStyles();
      STATE.debugInfo.loadStateMessage = "initImageModule:build-workbench";
      buildImageWorkbench();
      STATE.debugInfo.loadStateMessage = "initImageModule:bind-events";
      bindWorkbenchEvents();
      STATE.debugInfo.loadStateMessage = "initImageModule:sync-models";
      syncModelOptions();
      STATE.debugInfo.loadStateMessage = "initImageModule:after-sync-models";
      STATE.debugInfo.loadStateMessage = "initImageModule:load-state";
      await loadPersistedCanvasState();
      STATE.debugInfo.loadStateMessage = `initImageModule:loaded sessions=${STATE.historySessions.length}`;
      normalizeAssetLibrary();
      ensureHistorySession();
      migrateAllNodes();
      syncNodeModelDefaults();
      persistCurrentHistory();
      renderCanvas();
      renderLeftPanel();
      syncMeasuredPorts();
      STATE.debugInfo.loadStateStatus = "ready";
      STATE.debugInfo.loadStateMessage = `ready; sessions=${STATE.historySessions.length}; nodes=${STATE.nodes.length}`;
    } catch (error) {
      STATE.debugInfo.loadStateStatus = "init-error";
      STATE.debugInfo.loadStateMessage = String(error?.message || error);
      console.error("[canvas] initImageModule failed", error);
      try { renderCanvas(); } catch (_) {}
    }
  }

  function injectCanvasStyles() {
    if (document.getElementById("image-canvas-style")) return;
    const patch = document.createElement("style");
    patch.id = "image-canvas-style-patch-node-media";
    patch.textContent = `
      /* 连线：双层 stroke + 轻阴影 */
      .canvas-svg{z-index:6;pointer-events:auto;overflow:visible;}
      .canvas-svg .edge-visible{pointer-events:none;}
      .canvas-svg .edge-hit{stroke:rgba(255,255,255,.001);stroke-width:64;fill:none;pointer-events:stroke;cursor:pointer;}
      .canvas-svg .edge-hit:hover + .edge-outline{stroke:rgba(96,165,250,.55);}
      .canvas-svg .edge-core.edge-selected{filter:drop-shadow(0 2px 6px rgba(251,191,36,.35));}
      .canvas-svg .edge-core{filter:drop-shadow(0 2px 4px rgba(59,130,246,.22));}
      .canvas-node-layer{z-index:7;}
      .edge-dom-layer,.edge-dom-hit{display:none !important;}

      /* 节点：自适应宽高 */
      .node{position:absolute;background:transparent;border:none;border-radius:14px;overflow:visible;box-shadow:none;transition:box-shadow .15s ease;box-sizing:border-box;will-change:transform;}
      .node.is-selected{box-shadow:0 0 0 2px rgba(96,165,250,.55),0 0 0 8px rgba(59,130,246,.14),0 22px 48px rgba(0,0,0,.38);border-radius:18px;}
      .node.multi-selected{box-shadow:0 0 0 2px rgba(96,165,250,.95),0 24px 70px rgba(15,23,42,.55);}
      .node.node-link-highlight{box-shadow:0 0 0 2px rgba(52,211,153,.75),0 18px 40px rgba(0,0,0,.32);}

      .node-shell{position:relative;border-radius:14px;overflow:visible;background:transparent;}
      .node-image-wrap{position:relative;border-radius:14px;overflow:hidden;background:#0b1220;display:flex;align-items:center;justify-content:center;cursor:grab;user-select:none;-webkit-user-drag:none;box-shadow:0 18px 40px rgba(0,0,0,.28);}
      .node.is-selected .node-image-wrap{cursor:default;}
      .node-image-wrap img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none;-webkit-user-drag:none;user-select:none;-webkit-user-select:none;}
      .node-image-wrap.is-empty{background:#0b1220;border:1.5px dashed rgba(148,163,184,.3);box-shadow:0 18px 40px rgba(0,0,0,.22);}

      /* 空节点占位 + 大"+" */
      .node-empty-placeholder{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;color:#64748b;font-size:12px;text-align:center;}
      .node-upload-plus{width:72px;height:72px;border-radius:50%;border:2px dashed rgba(148,163,184,.35);background:rgba(30,41,59,.45);color:#cbd5e1;font-size:40px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .2s ease;padding:0;}
      .node-upload-plus:hover{background:rgba(59,130,246,.14);border-color:rgba(96,165,250,.65);color:#93c5fd;transform:scale(1.05);}
      .node-empty-hint{color:#64748b;line-height:1.5;}

      /* 悬浮工具栏（下载/宫格/关闭）与预览overlay */
      .node-image-overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(2,6,23,.6),rgba(2,6,23,.12) 45%,rgba(2,6,23,0));display:flex;align-items:flex-end;justify-content:flex-end;padding:12px;opacity:0;transition:opacity .18s ease;pointer-events:none;}
      .node-image-top-actions{position:absolute;top:10px;right:10px;display:flex;gap:6px;opacity:0;transition:opacity .18s ease;z-index:4;pointer-events:none;}
      .node.is-selected .node-image-wrap:hover .node-image-overlay,
      .node.is-selected .node-image-wrap:hover .node-image-top-actions{opacity:1;pointer-events:auto;}
      .node-image-top-actions .btn,.node-image-toolbar .btn{padding:7px 9px;background:rgba(15,23,42,.8);border:1px solid rgba(255,255,255,.16);color:#e2e8f0;backdrop-filter:blur(8px);border-radius:10px;pointer-events:auto;}
      .node-image-toolbar{display:flex;gap:8px;pointer-events:auto;}
      .node-linked-banner{position:absolute;left:12px;right:12px;top:12px;padding:8px 10px;border-radius:12px;background:rgba(15,23,42,.82);border:1px solid rgba(52,211,153,.24);color:#d1fae5;font-size:11px;backdrop-filter:blur(4px);z-index:3;pointer-events:none;}
      .node-upstream-badge{position:absolute;left:10px;bottom:10px;padding:3px 8px;border-radius:6px;background:rgba(15,23,42,.72);border:1px solid rgba(52,211,153,.3);color:#d1fae5;font-size:10px;font-weight:600;backdrop-filter:blur(4px);pointer-events:none;z-index:3;letter-spacing:.5px;}
      .node-upstream-only{background:linear-gradient(180deg,rgba(15,23,42,.8),rgba(11,18,32,.9));border:1.5px dashed rgba(52,211,153,.35);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;}
      .node-upstream-icon{width:56px;height:56px;border-radius:50%;background:rgba(52,211,153,.14);color:#34d399;display:flex;align-items:center;justify-content:center;font-size:26px;}
      .node-upstream-text{color:#d1fae5;font-weight:700;font-size:14px;}

      /* 选中才展开的表单 */
      .node-expand-body{display:none;margin-top:8px;border-radius:14px;background:#111827;border:1px solid rgba(148,163,184,.16);overflow:hidden;box-shadow:0 18px 40px rgba(0,0,0,.28);}
      .node.is-expanded .node-expand-body{display:block;}
      .node-resize-handle{position:absolute;right:-3px;bottom:-3px;width:14px;height:14px;cursor:nwse-resize;opacity:0;transition:opacity .15s ease;z-index:20;}
      .node-resize-handle::after{content:"";position:absolute;right:2px;bottom:2px;width:10px;height:10px;border-right:2px solid #93c5fd;border-bottom:2px solid #93c5fd;border-radius:0 0 4px 0;}
      .node:hover .node-resize-handle,.node.is-selected .node-resize-handle{opacity:1;}
      .node-divider{height:1px;background:rgba(148,163,184,.14);}
      .node-body{padding:12px 14px 14px;display:grid;gap:10px;}
      .node-body label{display:block;font-size:11px;color:#94a3b8;margin-bottom:3px;font-weight:600;}
      .node-body input,.node-body textarea,.node-body select{width:100%;box-sizing:border-box;border:1px solid rgba(148,163,184,.18);background:#0f172a;color:#fff;border-radius:10px;padding:8px 10px;outline:none;font-size:12px;pointer-events:auto;cursor:text;}
      .node-body textarea{resize:vertical;min-height:72px;}
      .node-body select{cursor:pointer;}
      .node-row{display:grid;gap:6px;}
      .node-grid-two{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
      .node-mini-field{display:grid;gap:3px;}
      .node-mini-field label{font-size:10px;margin-bottom:0;}
      .node-mini-field select,.node-mini-field input{padding:7px 9px;font-size:11px;border-radius:9px;}
      .node-actions{display:flex;gap:8px;flex-wrap:wrap;}
      .node-actions .btn{flex:1;min-width:100px;cursor:pointer;justify-content:center;}
      .canvas-node-model{display:flex;align-items:center;gap:8px;padding:4px 0;}
      .canvas-node-model-icon{width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:rgba(59,130,246,.15);color:#93c5fd;font-size:13px;}
      .canvas-node-model-text{min-width:0;overflow:hidden;}
      .canvas-node-model-name{font-size:12px;color:#cbd5e1;font-weight:600;}

      /* 端点：极简白点，默认隐藏；hover/selected/拉线中才显 */
      .port-handle{position:absolute;width:40px;height:40px;display:flex;align-items:center;justify-content:center;background:transparent;border:none;cursor:crosshair;z-index:12;pointer-events:none;opacity:0;transition:opacity .15s ease;}
      .port-handle.input{left:-20px;top:50%;transform:translate(0,-50%);}
      .port-handle.output{right:-20px;top:50%;transform:translate(0,-50%);}
      .port-handle::after{content:"";display:block;width:10px;height:10px;border-radius:999px;background:#fff;box-shadow:0 0 0 1.5px rgba(15,23,42,.85),0 0 0 5px rgba(255,255,255,.08);transition:all .14s ease;}
      .node:hover .port-handle,
      .node.is-selected .port-handle,
      .node.multi-selected .port-handle,
      body.dragging-connection .port-handle.input{opacity:1;pointer-events:auto;}
      .port-handle:hover::after{width:14px;height:14px;background:#bfdbfe;box-shadow:0 0 0 1.5px rgba(15,23,42,.85),0 0 0 8px rgba(147,197,253,.18);}
      body.dragging-connection .port-handle.output::after{background:#60a5fa;box-shadow:0 0 0 1.5px rgba(15,23,42,.85),0 0 0 7px rgba(96,165,250,.25);}

      /* 拖拽中 */
      .node.is-dragging{z-index:999;}
      body.node-dragging{cursor:grabbing;user-select:none;}
      body.node-dragging .node-image-wrap{cursor:grabbing;}

      /* 宫格节点 */
      .node.grid-node .grid-cells{display:grid;gap:4px;padding:12px;background:#0b1220;border-radius:14px;box-shadow:0 18px 40px rgba(0,0,0,.28);}
      .node.grid-node .grid-cell{position:relative;background:#111827;border:1px dashed rgba(148,163,184,.3);border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#475569;font-size:18px;}
      .node.grid-node .grid-cell.has-image{border:none;cursor:grab;}
      .node.grid-node .grid-cell.drag-over{border:2px dashed #60a5fa;background:rgba(59,130,246,.08);}
      .node.grid-node .grid-cell img{width:100%;height:100%;object-fit:cover;pointer-events:none;user-select:none;-webkit-user-drag:none;}
      .node.grid-node .grid-cell-plus{font-size:28px;opacity:.5;}

      /* 宫格选择弹窗 */
      body.node-dragging .node-image-top-actions,body.node-dragging .node-image-overlay,body.node-dragging .node-resize-handle{display:none !important;pointer-events:none !important;}
      .node.grid-node.is-editing{box-shadow:0 0 0 2px #34d399,0 0 0 8px rgba(52,211,153,.15),0 22px 48px rgba(0,0,0,.38);}
      .node.grid-node:not(.is-editing) .grid-cell{cursor:default;pointer-events:none;}
      .node.grid-node:not(.is-editing) .grid-cell.has-image{cursor:default;}
      .node.grid-node.is-editing .grid-cell{cursor:grab;}
      .node.grid-node.is-editing .grid-cell.has-image{cursor:grab;}
      .node-grid-edit-btn{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:4;opacity:0;transition:opacity .18s ease;}
      .node.grid-node:hover .node-grid-edit-btn,.node.grid-node.is-selected .node-grid-edit-btn,.node.grid-node.is-editing .node-grid-edit-btn{opacity:1;}
      .node-grid-edit-btn button{padding:7px 11px;background:rgba(15,23,42,.85);border:1px solid rgba(255,255,255,.16);color:#e2e8f0;backdrop-filter:blur(8px);border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;}
      .node.grid-node.is-editing .node-grid-edit-btn .btn-toggle-edit{background:rgba(52,211,153,.28);border-color:#34d399;color:#d1fae5;}
      /* 宫格拖出时跟随鼠标的预览（就是新节点本身，不需要额外 ghost） */
      .grid-create-overlay{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;}
      .grid-create-backdrop{position:absolute;inset:0;background:rgba(2,6,23,.7);backdrop-filter:blur(3px);}
      .grid-create-dialog{position:relative;z-index:1;width:min(440px,calc(100vw - 40px));background:#0f172a;border:1px solid rgba(148,163,184,.22);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.5);padding:22px 22px 18px;color:#e2e8f0;display:flex;flex-direction:column;gap:14px;}
      .grid-create-title{font-size:16px;font-weight:700;color:#fff;}
      .grid-create-section{display:flex;flex-direction:column;gap:8px;}
      .grid-create-label{font-size:12px;color:#94a3b8;font-weight:600;}
      .grid-create-buttons{display:flex;flex-wrap:wrap;gap:6px;}
      .grid-create-buttons button{border:1px solid rgba(148,163,184,.2);background:#111827;color:#cbd5e1;padding:7px 12px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:600;transition:all .15s ease;}
      .grid-create-buttons button:hover{border-color:rgba(96,165,250,.5);color:#93c5fd;}
      .grid-create-buttons button.active{background:rgba(59,130,246,.2);border-color:#60a5fa;color:#bfdbfe;}
      .grid-create-inputs{display:flex;align-items:center;gap:8px;}
      .grid-create-inputs input{flex:1;min-width:0;background:#0b1220;border:1px solid rgba(148,163,184,.22);color:#fff;border-radius:10px;padding:8px 10px;font-size:13px;outline:none;}
      .grid-create-inputs span{color:#64748b;font-weight:700;}
      .grid-create-preview{font-size:11px;color:#64748b;}
      .grid-create-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px;}
      .grid-create-actions .btn{padding:8px 16px;font-size:13px;}
      .grid-size-popover button{border:none;background:rgba(30,41,59,.7);color:#e2e8f0;padding:10px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}
      .grid-size-popover button:hover{background:rgba(59,130,246,.25);color:#bfdbfe;}

      body.debug-canvas-hit .port-handle::after{outline:2px solid rgba(239,68,68,.65);}
      body.debug-canvas-hit .edge-hit{stroke:rgba(250,204,21,.35) !important;}

      /* ── 画布外层布局 ── */
      #image{height:calc(100vh - 64px);overflow:hidden;position:relative;}
      .canvas-shell{display:flex;flex-direction:row;height:100%;background:#0b1020;color:#e5e7eb;position:relative;}
      .canvas-left{width:320px;border-right:1px solid rgba(148,163,184,.18);background:#0f172a;padding:16px;display:flex;flex-direction:column;gap:14px;overflow:hidden;flex-shrink:0;}
      .canvas-title{font-size:18px;font-weight:800;color:#fff;}
      .canvas-subtitle{font-size:12px;color:#94a3b8;line-height:1.6;}
      .canvas-panel{border:1px solid rgba(148,163,184,.12);background:rgba(15,23,42,.78);border-radius:16px;padding:14px;min-height:0;display:flex;flex-direction:column;}
      .canvas-panel-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px;}
      .canvas-panel-title{font-size:14px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px;}
      .canvas-panel-subtitle{font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:10px;}
      .canvas-library-toolbar{display:grid;gap:8px;margin-bottom:10px;}
      .canvas-library-toolbar .form-select,.canvas-library-toolbar .form-input{background:#0b1220;border:1px solid rgba(148,163,184,.18);color:#fff;}
      .canvas-library-list,.canvas-history-list{display:flex;flex-direction:column;gap:10px;overflow:auto;min-height:0;}
      .canvas-empty-card{border:1px dashed rgba(148,163,184,.18);border-radius:14px;padding:16px;text-align:center;color:#94a3b8;font-size:12px;line-height:1.7;background:rgba(15,23,42,.5);}
      .canvas-history-item{border:1px solid rgba(148,163,184,.12);border-radius:14px;background:#111827;transition:all .2s ease;}
      .canvas-history-item:hover{border-color:rgba(96,165,250,.28);}
      .canvas-history-body{padding:10px 12px;display:grid;gap:6px;}
      .canvas-item-title{font-size:13px;font-weight:700;color:#e5e7eb;}
      .canvas-item-meta{font-size:12px;color:#94a3b8;}
      .canvas-item-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px;}
      .canvas-item-actions .btn{padding:8px 12px;font-size:12px;}
      .canvas-history-item.active{border-color:#60a5fa;box-shadow:0 0 0 1px rgba(96,165,250,.18);}
      .canvas-main{flex:1;display:flex;flex-direction:column;min-width:0;}
      .canvas-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;background:#111827;border-bottom:1px solid rgba(148,163,184,.14);flex-shrink:0;}
      .canvas-topbar .left,.canvas-topbar .right{display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
      .canvas-topbar .badge{font-size:12px;padding:6px 10px;border-radius:999px;background:rgba(59,130,246,.16);color:#bfdbfe;border:1px solid rgba(96,165,250,.22);}
      .canvas-board-wrap{position:relative;flex:1;overflow:hidden;background:radial-gradient(circle at 1px 1px,rgba(148,163,184,.16) 1px,transparent 0) 0 0/24px 24px,linear-gradient(180deg,#0b1020,#0a0f1b);}
      .canvas-board{position:absolute;inset:0;overflow:hidden;cursor:grab;user-select:none;}
      .canvas-board.panning{cursor:grabbing;}
      .canvas-world{position:absolute;left:0;top:0;transform-origin:0 0;width:5000px;height:3600px;will-change:transform;}
      .canvas-svg{position:absolute;left:0;top:0;width:5000px;height:3600px;overflow:visible;z-index:6;pointer-events:auto;}
      .canvas-node-layer{position:absolute;left:0;top:0;width:5000px;height:3600px;z-index:7;}
      .edge-dom-layer{position:absolute;left:0;top:0;width:5000px;height:3600px;z-index:2;pointer-events:none;display:none;}
      .canvas-selection-box{position:absolute;border:1px solid rgba(96,165,250,.95);background:rgba(96,165,250,.14);pointer-events:none;z-index:25;border-radius:10px;}
      .canvas-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#94a3b8;font-size:14px;text-align:center;line-height:1.8;}
      .canvas-context-menu{position:absolute;z-index:60;min-width:180px;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:14px;box-shadow:0 18px 45px rgba(0,0,0,.35);padding:8px;}
      .canvas-context-menu button{width:100%;background:transparent;border:none;color:#e5e7eb;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:13px;}
      .canvas-context-menu button:hover{background:rgba(30,41,59,.95);}
      .canvas-toast{position:fixed;top:84px;right:20px;z-index:2000;padding:10px 14px;border-radius:12px;background:rgba(15,23,42,.96);color:#fff;border:1px solid rgba(96,165,250,.28);box-shadow:0 16px 36px rgba(0,0,0,.28);font-size:13px;opacity:0;transform:translateY(-8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease;}
      .canvas-toast.show{opacity:1;transform:translateY(0);}
      .image-preview-modal{position:fixed;inset:0;background:rgba(2,6,23,.82);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px;}
      .image-preview-modal.hidden{display:none;}
      .image-preview-backdrop{position:absolute;inset:0;}
      .image-preview-panel{position:relative;z-index:1;max-width:min(92vw,1400px);max-height:92vh;}
      .image-preview-panel img{max-width:100%;max-height:92vh;display:block;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.45);}
      .image-preview-close{position:absolute;top:-14px;right:-14px;width:40px;height:40px;border:none;border-radius:999px;background:#111827;color:#fff;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.35);}
      .asset-library-modal.hidden{display:none;}
      .asset-library-modal{position:fixed;inset:0;z-index:1600;}
      .asset-library-backdrop{position:absolute;inset:0;background:rgba(2,6,23,.7);backdrop-filter:blur(4px);}
      .asset-library-panel{position:relative;width:min(1100px,calc(100vw - 48px));height:min(760px,calc(100vh - 48px));margin:24px auto;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.45);display:grid;grid-template-columns:280px 1fr;overflow:hidden;}
      .asset-library-sidebar{padding:18px;border-right:1px solid rgba(148,163,184,.14);display:flex;flex-direction:column;gap:12px;background:#111827;min-height:0;}
      .asset-library-content{padding:18px;display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0;}
      .asset-grid{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow:auto;padding-right:4px;}
      .asset-card{display:flex;gap:12px;border:1px solid rgba(148,163,184,.12);border-radius:16px;overflow:hidden;background:#111827;min-height:124px;}
      .asset-card img{width:180px;height:124px;object-fit:cover;background:#0b1220;flex:0 0 180px;}
      .asset-card-body{padding:12px;display:flex;flex-direction:column;gap:8px;flex:1;min-width:0;justify-content:center;}
      .asset-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px;}
      .asset-modal-header.drag-handle{cursor:move;user-select:none;padding-bottom:4px;border-bottom:1px solid rgba(148,163,184,.1);}
      .asset-modal-actions{display:flex;gap:8px;flex-wrap:wrap;}
      @media (max-width:1100px){.canvas-left{display:none;}}
      .node-prompt-editor{position:relative;}
      .node-prompt-editor .prompt-input{width:100%;box-sizing:border-box;border:1px solid rgba(148,163,184,.18);background:#0f172a;color:#fff;border-radius:10px;padding:8px 10px;outline:none;font-size:12px;cursor:text;min-height:72px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;pointer-events:auto;}
      .node-prompt-editor .prompt-input:empty::before{content:attr(data-placeholder);color:#475569;pointer-events:none;}
      .node-prompt-editor .prompt-input:focus{border-color:rgba(96,165,250,.5);}
      .prompt-ref-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px 1px 8px;margin:0 2px;border-radius:8px;background:rgba(59,130,246,.18);border:1px solid rgba(96,165,250,.45);color:#dbeafe;font-size:11px;font-weight:600;line-height:1.3;vertical-align:baseline;user-select:none;-webkit-user-select:none;cursor:default;white-space:nowrap;}
      .prompt-ref-chip[data-stale="1"]{background:rgba(148,163,184,.16);border-color:rgba(148,163,184,.4);color:#94a3b8;text-decoration:line-through;}
      .prompt-ref-chip .chip-label{pointer-events:none;}
      .prompt-ref-chip .chip-thumb{width:14px;height:14px;border-radius:3px;object-fit:cover;display:inline-block;background:#0b1220;flex:none;}
      .prompt-ref-chip .chip-thumb-fallback{width:14px;height:14px;border-radius:3px;background:rgba(148,163,184,.3);display:inline-flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:9px;flex:none;}
      .prompt-mention-popup{position:absolute;z-index:50;min-width:180px;max-width:260px;background:#0f172a;border:1px solid rgba(96,165,250,.35);border-radius:10px;box-shadow:0 18px 40px rgba(0,0,0,.45);padding:6px;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto;}
      .prompt-mention-empty{padding:10px;color:#94a3b8;font-size:11px;text-align:center;}
      .prompt-mention-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;color:#e2e8f0;font-size:12px;background:transparent;border:none;text-align:left;width:100%;}
      .prompt-mention-item:hover,.prompt-mention-item.is-active{background:rgba(59,130,246,.18);}
      .prompt-mention-item img{width:24px;height:24px;border-radius:5px;object-fit:cover;flex:none;background:#0b1220;}
      .prompt-mention-item .mi-fallback{width:24px;height:24px;border-radius:5px;background:rgba(148,163,184,.25);display:flex;align-items:center;justify-content:center;color:#cbd5e1;font-size:11px;flex:none;}
      .prompt-mention-item .mi-label{font-weight:600;flex:none;}
      .prompt-mention-item .mi-meta{color:#94a3b8;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    `;
    patch.id = "image-canvas-style";
    document.head.appendChild(patch);
  }

  function buildImageWorkbench() {
    const tab = document.getElementById("image");
    if (!tab) return;
    tab.innerHTML = `
      <div class="canvas-shell">
        <aside class="canvas-left">
          <div><div class="canvas-title">无限画布</div></div>
          <section class="canvas-panel" style="flex:1.1;"><div class="canvas-panel-header"><div class="canvas-panel-title"><i class="fa fa-folder-open-o"></i> 素材库</div></div><div class="canvas-library-list custom-scrollbar" id="canvas-library-list"></div></section>
          <section class="canvas-panel" style="flex:0.9;"><div class="canvas-panel-header"><div class="canvas-panel-title"><i class="fa fa-history"></i> 历史会话记录</div><button class="btn btn-default" id="new-canvas-session-btn">新建</button></div><div class="canvas-panel-subtitle">所有画布记录都会保存到本地文件。</div><div class="canvas-history-list custom-scrollbar" id="canvas-history-list"></div></section>
        </aside>
        <section class="canvas-main">
          <div class="canvas-topbar"><div class="left"><span class="badge">双击创建节点</span><span class="badge">滚轮缩放</span><span class="badge">Ctrl+C / Ctrl+V / Ctrl+Z / Delete</span></div><div class="right"><button class="btn btn-default" id="open-panorama-viewer-btn"><i class="fa fa-globe"></i> 全景查看器</button><button class="btn btn-default" id="quick-add-node-btn">新建节点</button><span class="badge" id="canvas-zoom-badge">100%</span><button class="btn btn-default" id="reset-canvas-btn">清空画布</button></div></div>
          <div class="canvas-board-wrap" id="canvas-board-wrap"><div class="canvas-board" id="canvas-board"><div class="canvas-world" id="canvas-world"><svg class="canvas-svg" id="canvas-svg"></svg><div id="edge-dom-layer" class="edge-dom-layer"></div><div id="canvas-node-layer" class="canvas-node-layer"></div></div><div class="canvas-empty" id="canvas-empty-tip">双击画布、右键画布或直接粘贴图片来创建节点</div><div class="canvas-selection-box" id="canvas-selection-box" style="display:none"></div></div><div id="canvas-context-menu-root"></div></div>
        </section>
      </div>
      <div class="image-preview-modal hidden" id="image-preview-modal"><div class="image-preview-backdrop" data-close-preview="1"></div><div class="image-preview-panel"><button class="image-preview-close" type="button" data-close-preview="1">×</button><img id="image-preview-target" src="" alt="preview"></div></div>
      <div class="asset-library-modal hidden" id="asset-library-modal"><div class="asset-library-backdrop" data-close-asset-library="1"></div><div class="asset-library-panel draggable" id="asset-library-panel"><aside class="asset-library-sidebar"><div class="asset-modal-header drag-handle" data-drag-asset-library="1"><div><div class="canvas-title" style="font-size:16px;">素材库</div></div></div><div class="canvas-library-toolbar"><select class="form-select" id="asset-category-filter-modal"></select><div style="display:flex;gap:8px;"><button class="btn btn-default" id="create-asset-category-btn-modal">新建分类</button><button class="btn btn-default" type="button" id="rename-current-asset-category-btn">重命名分类</button></div></div></aside><section class="asset-library-content"><div class="asset-modal-header"><div><div class="canvas-title" style="font-size:16px;">素材内容</div></div><div class="asset-modal-actions"><button class="btn btn-danger" type="button" id="delete-current-asset-category-btn">删除当前分类</button><button class="btn btn-default" type="button" data-close-asset-library="1">完成</button></div></div><div class="asset-grid custom-scrollbar" id="asset-library-grid"></div></section></div></div><div class="asset-library-modal hidden" id="asset-category-modal"><div class="asset-library-backdrop" data-close-category-modal="1"></div><div class="asset-library-panel" style="grid-template-columns:1fr;max-width:520px;height:auto;"><section class="asset-library-content"><div class="asset-modal-header"><div><div class="canvas-title" style="font-size:16px;" id="asset-category-modal-title">新建分类</div><div class="canvas-subtitle" id="asset-category-modal-subtitle">填写分类名称并确认。</div></div><button class="btn btn-default" type="button" data-close-category-modal="1">关闭</button></div><div class="canvas-library-toolbar" style="display:grid;gap:12px;"><input class="form-input" id="asset-category-modal-input" placeholder="输入分类名称"><select class="form-select" id="asset-category-modal-select"></select></div><div class="asset-modal-actions"><button class="btn btn-default" type="button" data-close-category-modal="1">取消</button><button class="btn btn-primary" type="button" id="confirm-asset-category-modal-btn">确认</button></div></section></div></div><div class="canvas-toast" id="canvas-toast"></div>`;
  }

  function bindWorkbenchEvents() {
    const root = document.getElementById("image");
    const board = document.getElementById("canvas-board");
    if (!root || !board) return;
    if (root.dataset.canvasBound !== "1") {
      root.dataset.canvasBound = "1";

      root.addEventListener("click", async (event) => {
      const target = event.target;
      // 连线点击优先（SVG target 不是 HTMLElement）
      if (target && typeof target.closest === 'function') {
        const edgeHitEarly = target.closest(".edge-hit[data-edge-id]");
        if (edgeHitEarly) {
          event.preventDefault();
          event.stopPropagation();
          STATE.selectedEdgeId = edgeHitEarly.getAttribute("data-edge-id");
          STATE.selectedNodeId = null;
          STATE.selectedNodeIds = [];
          hideContextMenu(false);
          renderCanvas();
          return;
        }
      }
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.node-body select')) {
        event.stopPropagation();
        return;
      }
      if (target.closest("#toggle-canvas-debug-btn")) {
        document.body.classList.toggle("debug-canvas-hit");
        const badge = document.getElementById("canvas-debug-badge");
        if (badge) badge.style.display = document.body.classList.contains("debug-canvas-hit") ? "inline-flex" : "none";
        return;
      }
      if (target.closest("#reset-canvas-btn")) return resetCanvas();
      if (target.closest("#open-panorama-viewer-btn")) { if (window.PanoramaViewer) window.PanoramaViewer.open(); return; }
      if (target.closest("#quick-add-node-btn")) { const rect = getBoardRect(); const point = clientToCanvasPoint(rect.left + rect.width / 2, rect.top + Math.max(180, rect.height / 2)); return addNodeAt(point.x - NODE_WIDTH / 2, point.y - 120); }
      if (target.closest("#new-canvas-session-btn")) return createNewHistorySession();
      if (target.closest("#create-asset-category-btn")) return createAssetCategory();
      if (target.closest("#create-asset-category-btn-assets")) return createAssetCategory("assets");
      if (target.closest("#create-asset-category-btn-modal")) return openCategoryModal("create");
      if (target.closest("#confirm-asset-category-modal-btn")) return confirmCategoryModal();
      if (target.closest("[data-close-category-modal]")) return closeCategoryModal();
      if (target.closest("[data-open-asset-library]")) return openAssetLibraryModal();
      if (target.closest("[data-close-asset-library]")) return closeAssetLibraryModal();
      if (target.closest("[data-close-preview]")) return closeImagePreview();

      const runGenerate = target.closest("[data-run-generate]");
      if (runGenerate) {
        event.preventDefault();
        event.stopPropagation();
        return runGenerateNode(runGenerate.getAttribute("data-run-generate"));
      }

      const viewPanorama = target.closest("[data-view-panorama]");
      if (viewPanorama) {
        event.preventDefault();
        event.stopPropagation();
        const url = viewPanorama.getAttribute("data-view-panorama");
        if (url && window.PanoramaViewer) window.PanoramaViewer.openWithImage(url, "全景图");
        return;
      }

      const edgeHit = target instanceof SVGElement ? target.closest(".edge-hit[data-edge-id]") : target.closest(".edge-hit[data-edge-id]");
      if (edgeHit) {
        event.preventDefault();
        event.stopPropagation();
        STATE.selectedEdgeId = edgeHit.getAttribute("data-edge-id");
        STATE.selectedNodeId = null;
        hideContextMenu(false);
        renderCanvas();
        return;
      }

      const actionDownload = target.closest("[data-download-image]");
      if (actionDownload) return downloadImage(actionDownload.getAttribute("data-download-image"));
      const actionRemoveRef = target.closest("[data-remove-reference-image]");
      if (actionRemoveRef) return removeReferenceImage(actionRemoveRef.getAttribute("data-remove-reference-image"));
      const actionClearOutput = target.closest("[data-clear-output-images]");
      if (actionClearOutput) return clearNodeOutputImages(actionClearOutput.getAttribute("data-clear-output-images"));
      const actionPreview = target.closest("[data-image-preview]");
      if (actionPreview) return openImagePreview(actionPreview.getAttribute("data-image-preview"));
      const actionSave = target.closest("[data-save-image-to-library]");
      if (actionSave) return saveImageUrlToLibrary(actionSave.getAttribute("data-save-image-to-library"), actionSave.getAttribute("data-image-title") || "图片素材");

      // 空 grid cell 点击触发上传（只在编辑模式）
      const emptyCell = target.closest(".grid-cell:not(.has-image)");
      if (emptyCell) {
        const gid = emptyCell.getAttribute('data-grid-node') || '';
        const g = getNode(gid);
        if (g && g.editMode) {
          event.preventDefault();
          event.stopPropagation();
          openGridCellUpload(emptyCell);
          return;
        }
      }

      const gridCropBtn = target.closest("[data-grid-crop]");
      if (gridCropBtn) {
        event.preventDefault();
        event.stopPropagation();
        showGridSizePopover(gridCropBtn.getAttribute("data-grid-crop"), gridCropBtn);
        return;
      }
      const gridSizePick = target.closest("[data-grid-size]");
      if (gridSizePick) {
        event.preventDefault();
        event.stopPropagation();
        const n = Number(gridSizePick.getAttribute("data-grid-size")) || 3;
        const nodeId = gridSizePick.getAttribute("data-grid-source");
        hideGridSizePopover();
        createGridNodeFromImage(nodeId, n);
        return;
      }
      const gridMergeBtn = target.closest("[data-grid-merge]");
      if (gridMergeBtn) {
        event.preventDefault();
        event.stopPropagation();
        mergeGridNodeToImage(gridMergeBtn.getAttribute("data-grid-merge"));
        return;
      }
      const gridClearBtn = target.closest("[data-grid-clear]");
      if (gridClearBtn) {
        event.preventDefault();
        event.stopPropagation();
        clearGridNodeCells(gridClearBtn.getAttribute("data-grid-clear"));
        return;
      }
      const gridEditToggle = target.closest("[data-grid-toggle-edit]");
      if (gridEditToggle) {
        event.preventDefault();
        event.stopPropagation();
        const gid = gridEditToggle.getAttribute("data-grid-toggle-edit");
        const g = getNode(gid);
        if (g) {
          g.editMode = !g.editMode;
          persistCanvasStateDebounced();
          renderCanvas();
        }
        return;
      }
      const uploadBtn = target.closest("[data-upload-image]");
      if (uploadBtn) { const input = document.getElementById(`image-file-${uploadBtn.getAttribute("data-upload-image")}`); if (input) input.click(); return; }
      const addAssetBtn = target.closest("[data-add-asset]");
      if (addAssetBtn) return insertAssetAsNode(addAssetBtn.getAttribute("data-add-asset"));
      const folderBtn = target.closest("[data-select-asset-category]");
      if (folderBtn) { STATE.activeAssetCategory = folderBtn.getAttribute("data-select-asset-category") || "全部"; renderLeftPanel(); return; }
      const renameCategoryBtn = target.closest("[data-rename-asset-category]");
      if (renameCategoryBtn) return openCategoryModal("rename", { category: renameCategoryBtn.getAttribute("data-rename-asset-category") || "" });
      const moveAssetBtn = target.closest("[data-move-asset]");
      if (moveAssetBtn) return openCategoryModal("move", { assetId: moveAssetBtn.getAttribute("data-move-asset") || "", category: moveAssetBtn.getAttribute("data-asset-category") || DEFAULT_ASSET_CATEGORY });
      const deleteAssetBtn = target.closest("[data-delete-asset]");
      if (deleteAssetBtn) return deleteAsset(deleteAssetBtn.getAttribute("data-delete-asset") || "");
      if (target.closest("#delete-current-asset-category-btn")) return deleteCurrentCategory();
      const openHistoryBtn = target.closest("[data-open-history]");
      if (openHistoryBtn) return openHistorySession(openHistoryBtn.getAttribute("data-open-history"));
      const createFromContext = target.closest("[data-context-create-node]");
      if (createFromContext) return createNodeFromContextMenu();
      const openGridDialog = target.closest("[data-context-open-grid-dialog]");
      if (openGridDialog) {
        const point = STATE.contextMenu.canvasPoint || clientToCanvasPoint(event.clientX, event.clientY);
        hideContextMenu(false);
        openGridCreateDialog(point);
        return;
      }
      const contextPreview = target.closest("[data-context-preview]");
      if (contextPreview) return openImagePreview(contextPreview.getAttribute("data-context-preview"));
      const contextSave = target.closest("[data-context-save-library]");
      if (contextSave) return saveImageUrlToLibrary(contextSave.getAttribute("data-context-save-library"), contextSave.getAttribute("data-image-title") || "图片素材");

      const nodeEl = target.closest(".node");
      if (nodeEl && !target.closest('textarea, input, select, button, a, [contenteditable="true"]')) {
        // 如果刚刚经历了拖动，不修改展开状态
        if (STATE._suppressNextClick) {
          STATE._suppressNextClick = false;
          return;
        }
        const newId = nodeEl.getAttribute("data-node-id");
        STATE.selectedNodeId = newId;
        STATE.expandedNodeId = newId;
        STATE.selectedEdgeId = null;
        renderCanvas();
        return;
      }

      if (target.closest("#asset-library-modal, #asset-category-modal")) {
        return;
      }

      if (!target.closest('textarea, input, select, button, a, [contenteditable="true"], .canvas-context-menu')) {
        hideContextMenu();
        STATE.selectedNodeId = null;
        STATE.selectedEdgeId = null;
        STATE.expandedNodeId = null;
        renderCanvas();
      }
    });

      }

    board.addEventListener("dblclick", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest(".node") || target.closest("[data-edge-id]")) return;
      event.preventDefault();
      event.stopPropagation();
      const point = clientToCanvasPoint(event.clientX, event.clientY);
      addNodeAt(point.x, point.y);
    });

    board.addEventListener("dragover", (event) => {
      const cell = event.target instanceof HTMLElement ? event.target.closest('.grid-cell') : null;
      if (!cell) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      cell.classList.add('drag-over');
    });
    board.addEventListener("dragleave", (event) => {
      const cell = event.target instanceof HTMLElement ? event.target.closest('.grid-cell') : null;
      if (cell) cell.classList.remove('drag-over');
    });
    board.addEventListener("drop", (event) => {
      const cell = event.target instanceof HTMLElement ? event.target.closest('.grid-cell') : null;
      if (!cell) return;
      const gridId = cell.getAttribute('data-grid-node') || '';
      const assetId = event.dataTransfer && event.dataTransfer.getData('application/x-canvas-asset');
      if (assetId) {
        event.preventDefault();
        event.stopPropagation();
        cell.classList.remove('drag-over');
        handleGridCellDropAsset(cell, gridId, assetId);
        return;
      }
      handleGridCellDrop(cell, gridId, event);
    });

    document.addEventListener("dragstart", (event) => {
      const card = event.target instanceof HTMLElement ? event.target.closest('[data-drag-asset-id]') : null;
      if (!card || !event.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-canvas-asset', card.getAttribute('data-drag-asset-id') || '');
    });

    let _inputUndoTimer = null;
    root.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('[contenteditable="true"][data-field="prompt"]')) {
        if (!_inputUndoTimer) { pushUndoSnapshot(); _inputUndoTimer = setTimeout(() => { _inputUndoTimer = null; }, 1000); }
        const value = readPromptFromEditor(target);
        updateNodeField(target.getAttribute("data-node-id"), "prompt", value, { rerender: false });
        handlePromptMentionInput(target);
        return;
      }
      if (target.matches("textarea[data-field], input[data-field]")) {
        const field = target.getAttribute("data-field");
        let value = target.value;
        if (field === "count") value = Math.max(1, Math.min(4, Number(value || 1)));
        if (!_inputUndoTimer) { pushUndoSnapshot(); _inputUndoTimer = setTimeout(() => { _inputUndoTimer = null; }, 1000); }
        updateNodeField(target.getAttribute("data-node-id"), field, value, { rerender: false });
      }
    });

    root.addEventListener("change", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('select[data-field]')) return updateNodeField(target.getAttribute("data-node-id"), target.getAttribute("data-field"), target.value);
      if (target.id === 'asset-category-filter-modal') { STATE.activeAssetCategory = target.value || '全部'; renderLeftPanel(); return; }
      if (target.id === 'asset-category-modal-select') { STATE.categoryModal.category = target.value || DEFAULT_ASSET_CATEGORY; return; }
      if (target.matches('#asset-category-filter') || target.matches('#asset-category-filter-assets')) { STATE.activeAssetCategory = target.value || "全部"; renderLeftPanel(); return; }
      if (target.matches('input[type="file"][data-node-id]')) {
        const fileInput = target;
        if (fileInput.files && fileInput.files[0]) { await loadImageToNode(fileInput.getAttribute("data-node-id"), fileInput.files[0]); fileInput.value = ""; }
      }
    });

    root.addEventListener("focusout", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('.prompt-input[contenteditable="true"]')) {
        // 延迟关闭以允许 popup 内的点击先触发
        setTimeout(() => {
          if (!PROMPT_MENTION_STATE.popup) return;
          const active = document.activeElement;
          if (active === PROMPT_MENTION_STATE.popup || PROMPT_MENTION_STATE.popup.contains(active)) return;
          hidePromptMention();
        }, 80);
      }
    });
    root.addEventListener("paste", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches('.prompt-input[contenteditable="true"]')) return;
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData)?.getData('text/plain') || '';
      if (!text) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      sel.deleteFromDocument();
      const range = sel.getRangeAt(0);
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      // 触发 input 事件让 prompt 同步
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
    board.addEventListener("scroll", hidePromptMention, true);
    window.addEventListener("resize", hidePromptMention);

    board.addEventListener("contextmenu", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const imageEl = target.closest("[data-context-image]");
      if (imageEl) {
        event.preventDefault();
        showImageContextMenu(event.clientX, event.clientY, imageEl.getAttribute("data-context-image"), imageEl.getAttribute("data-image-title") || "图片素材");
        return;
      }
      const edgeHit = target instanceof SVGElement ? target.closest(".edge-hit[data-edge-id]") : target.closest(".edge-hit[data-edge-id]");
      if (edgeHit) {
        event.preventDefault();
        event.stopPropagation();
        STATE.selectedEdgeId = edgeHit.getAttribute("data-edge-id");
        STATE.selectedNodeId = null;
        renderCanvas();
        return;
      }
      if (target.closest(".node")) return;
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY);
    });

    root.addEventListener("mousedown", (event) => {
      const eventTarget = event.target;
      if (eventTarget instanceof HTMLElement && eventTarget.closest('.node-body select')) {
        event.stopPropagation();
        return;
      }
      // 宫格节点：编辑模式下格子可拖出
      const gridCellEl = event.target instanceof HTMLElement ? event.target.closest('.grid-cell.has-image') : null;
      if (gridCellEl && event.button === 0) {
        const gridId = gridCellEl.getAttribute('data-grid-node') || '';
        const gridNode = getNode(gridId);
        if (gridNode && gridNode.editMode) {
          handleGridCellMouseDown(gridCellEl, gridId, event);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // 非编辑模式：让事件继续往下传，走节点整体拖动
      }
      // 非编辑模式下，空 cell 的 + 按钮也被禁用
      const emptyGridCellEl = event.target instanceof HTMLElement ? event.target.closest('.grid-cell:not(.has-image)') : null;
      if (emptyGridCellEl) {
        const gridId = emptyGridCellEl.getAttribute('data-grid-node') || '';
        const gridNode = getNode(gridId);
        if (!gridNode || !gridNode.editMode) {
          // 让 mousedown 冒泡到节点拖动处理（编辑关闭时把整个宫格当普通节点拖）
        }
      }
      // 节点 resize
      const resizeHandle = event.target instanceof HTMLElement ? event.target.closest('[data-resize-node]') : null;
      if (resizeHandle && event.button === 0) {
        const rid = resizeHandle.getAttribute('data-resize-node');
        const resizeNode = getNode(rid);
        if (resizeNode) {
          const d = getNodeDisplaySize(resizeNode);
          STATE.resizingNode = {
            id: rid,
            startClientX: event.clientX, startClientY: event.clientY,
            startW: d.width, startH: d.imgHeight,
            aspect: d.imgWidth > 0 && d.imgHeight > 0 ? d.imgWidth / d.imgHeight : 1,
          };
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      const dragHandle = event.target instanceof HTMLElement ? event.target.closest("[data-drag-asset-library]") : null;
      if (dragHandle && STATE.isAssetLibraryOpen) {
        const panel = document.getElementById("asset-library-panel");
        if (panel) {
          const rect = panel.getBoundingClientRect();
          STATE.assetLibraryDrag = { active: true, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
          event.preventDefault();
          return;
        }
      }
      const target = event.target;
      // 连线命中优先（SVG 元素不是 HTMLElement，下面的 HTMLElement 判断会把它过滤掉）
      if (target && typeof target.closest === 'function') {
        const edgeHitEarly = target.closest(".edge-hit[data-edge-id]");
        if (edgeHitEarly) {
          event.preventDefault();
          event.stopPropagation();
          STATE.selectedEdgeId = edgeHitEarly.getAttribute("data-edge-id");
          STATE.selectedNodeId = null;
          STATE.selectedNodeIds = [];
          hideContextMenu(false);
          renderCanvas();
          return;
        }
      }
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('textarea, input, select, a, [contenteditable="true"], .canvas-context-menu')) { event.stopPropagation(); return; }
      const actionBtn = target.closest("button");
      const nodeHost = actionBtn ? actionBtn.closest('.node') : null;
      if (actionBtn && nodeHost) {
        const nodeData = getNode(nodeHost.getAttribute('data-node-id'));
        const selectedNow = nodeData && (STATE.selectedNodeId === nodeData.id || STATE.selectedNodeIds.includes(nodeData.id));
        const isUploadPlus = actionBtn.classList.contains('node-upload-plus') || actionBtn.hasAttribute('data-upload-image');
        const isGridEditToggle = actionBtn.hasAttribute('data-grid-toggle-edit');
        if (!selectedNow && !isUploadPlus && !isGridEditToggle) {
          // 未选中态：节点内的工具栏按钮不响应，落到节点拖拽
        } else {
          event.stopPropagation();
          return;
        }
      } else if (actionBtn) {
        event.stopPropagation();
        return;
      }
      const edgeHit = target instanceof SVGElement ? target.closest(".edge-hit[data-edge-id]") : target.closest(".edge-hit[data-edge-id]");
      if (edgeHit) {
        event.preventDefault();
        event.stopPropagation();
        STATE.selectedEdgeId = edgeHit.getAttribute("data-edge-id");
        STATE.selectedNodeId = null;
        hideContextMenu(false);
        renderCanvas();
        return;
      }
      const port = target.closest(".port-handle.output");
      if (port) { event.preventDefault(); beginConnectionDrag(port.getAttribute("data-node-id"), event.clientX, event.clientY); return; }
      const nodeEl = target.closest(".node");
      if (nodeEl && !target.closest('.port-handle')) {
        const node = getNode(nodeEl.getAttribute("data-node-id"));
        if (!node) return;
        if (event.button !== 0) return;
        event.preventDefault();
        const point = clientToCanvasPoint(event.clientX, event.clientY);
        STATE.draggingNodeId = node.id;
        STATE.dragMoved = false;
        STATE.dragOffsetX = point.x - node.x;
        STATE.dragOffsetY = point.y - node.y;
        // 记录节点的初始 x/y，作为 transform 位移的基准
        __dragBaseX = node.x;
        __dragBaseY = node.y;
        __cachedDragEl = nodeEl;
        __cachedDragElId = node.id;
        nodeEl.style.willChange = 'transform';
        document.body.classList.add('node-dragging');
        nodeEl.classList.add('is-dragging');
        // 立即更新 state + class（视觉即时反馈，不等 mouseup）
        const prevSelectedId = STATE.selectedNodeId;
        STATE.selectedNodeId = node.id;
        STATE.selectedNodeIds = [node.id];
        STATE.selectedEdgeId = null;
        if (prevSelectedId && prevSelectedId !== node.id) {
          const prevEl = document.querySelector(`.node[data-node-id="${prevSelectedId}"]`);
          if (prevEl) prevEl.classList.remove('selected', 'is-selected', 'multi-selected');
        }
        // 拖动开始：折叠所有 expanded 节点（包括当前），避免拖动时表单还在展开
        if (STATE.expandedNodeId) {
          const expEl = document.querySelector(`.node[data-node-id="${STATE.expandedNodeId}"]`);
          if (expEl) expEl.classList.remove('is-expanded');
          STATE.expandedNodeId = null;
        }
        nodeEl.classList.add('selected', 'is-selected');
        hideContextMenu(false);
        return;
      }
      const board = target.closest("#canvas-board");
      if (board && event.button === 1) {
        event.preventDefault();
        STATE.panning = true;
        STATE.panStartX = event.clientX - STATE.panX;
        STATE.panStartY = event.clientY - STATE.panY;
        STATE._cachedWorldEl = document.getElementById("canvas-world");
        board.classList.add("panning");
        hideContextMenu(false);
        return;
      }
      if (board && event.button === 0) {
        const rect = getBoardRect();
        STATE.selectionBox = { startX: event.clientX - rect.left, startY: event.clientY - rect.top, x: event.clientX - rect.left, y: event.clientY - rect.top, width: 0, height: 0 };
        STATE.selectedNodeId = null;
        STATE.selectedEdgeId = null;
        STATE.selectedNodeIds = [];
        updateSelectionBox();
        hideContextMenu(false);
      }
    });

    window.addEventListener("mousemove", (event) => {
      STATE._lastClientX = event.clientX;
      STATE._lastClientY = event.clientY;
      if (STATE.resizingNode) {
        const r = STATE.resizingNode;
        const dx = (event.clientX - r.startClientX) / STATE.zoom;
        let newW = Math.max(120, Math.min(1200, r.startW + dx));
        let newH = Math.round(newW / r.aspect);
        newH = Math.max(80, Math.min(1200, newH));
        const n = getNode(r.id);
        if (n) {
          n.displayWidth = newW;
          n.displayHeight = newH;
          const el = document.querySelector(`.node[data-node-id="${r.id}"]`);
          if (el) {
            el.style.width = `${newW}px`;
            const wrap = el.querySelector('.node-image-wrap, .grid-cells');
            if (wrap) { wrap.style.width = `${newW}px`; wrap.style.height = `${newH}px`; }
          }
          requestCanvasOverlayRefresh();
        }
        return;
      }
      if (__gridDragFromCell) { handleGridCellMouseMove(event); }
      if (STATE.assetLibraryDrag.active) {
        const panel = document.getElementById("asset-library-panel");
        if (!panel) return;
        const width = panel.offsetWidth || 1100;
        const height = panel.offsetHeight || 760;
        const left = Math.min(Math.max(16, event.clientX - STATE.assetLibraryDrag.offsetX), Math.max(16, window.innerWidth - width - 16));
        const top = Math.min(Math.max(16, event.clientY - STATE.assetLibraryDrag.offsetY), Math.max(16, window.innerHeight - height - 16));
        STATE.assetLibraryPosition = { left, top };
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.margin = "0";
        event.preventDefault();
        return;
      }
      if (STATE.draggingNodeId) {
        const point = clientToCanvasPoint(event.clientX, event.clientY);
        const node = getNode(STATE.draggingNodeId);
        if (!node) return;
        const nx = Math.round(point.x - STATE.dragOffsetX);
        const ny = Math.round(point.y - STATE.dragOffsetY);
        if (!STATE.dragMoved) {
          const dx = Math.abs(nx - node.x), dy = Math.abs(ny - node.y);
          if (dx + dy > 3) STATE.dragMoved = true;
        }
        node.x = nx;
        node.y = ny;
        updateDraggedNodePosition(node);
        requestCanvasOverlayRefresh();
        // 拖动时检测是否悬停在宫格 cell 上，高亮它
        updateGridCellHoverHighlight(STATE.draggingNodeId, event.clientX, event.clientY);
        return;
      }
      if (STATE.selectionBox) {
        const rect = getBoardRect();
        STATE.selectionBox.x = Math.min(STATE.selectionBox.startX, event.clientX - rect.left);
        STATE.selectionBox.y = Math.min(STATE.selectionBox.startY, event.clientY - rect.top);
        STATE.selectionBox.width = Math.abs((event.clientX - rect.left) - STATE.selectionBox.startX);
        STATE.selectionBox.height = Math.abs((event.clientY - rect.top) - STATE.selectionBox.startY);
        updateSelectionBox();
        updateSelectionMembership();
        return;
      }
      if (STATE.panning) {
        STATE.panX = event.clientX - STATE.panStartX;
        STATE.panY = event.clientY - STATE.panStartY;
        if (!STATE._cachedWorldEl) STATE._cachedWorldEl = document.getElementById("canvas-world");
        // 直接写 transform（快），由浏览器自己合成帧
        if (STATE._cachedWorldEl) STATE._cachedWorldEl.style.transform = `translate(${STATE.panX}px, ${STATE.panY}px) scale(${STATE.zoom})`;
        return;
      }
      if (STATE.connectionDrag) updateConnectionDrag(event.clientX, event.clientY);
    });

    window.addEventListener("mouseup", (event) => {
      if (STATE.resizingNode) {
        STATE.resizingNode = null;
        persistCanvasStateDebounced();
        renderCanvas();
        return;
      }
      if (__gridDragFromCell) { handleGridCellMouseUp(event); return; }
      if (STATE.assetLibraryDrag.active) {
        STATE.assetLibraryDrag.active = false;
        return;
      }
      if (STATE.draggingNodeId) {
        const dragId = STATE.draggingNodeId;
        const wasMoved = STATE.dragMoved;
        STATE.draggingNodeId = null;
        STATE.dragFramePending = false;
        commitDraggedNodePosition();
        __cachedDragEl = null;
        __cachedDragElId = null;
        document.body.classList.remove('node-dragging');
        document.querySelectorAll('.node.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
        if (wasMoved) {
          // 拖动结束：SVG 连线位置已在 requestCanvasOverlayRefresh 中更新，这里持久化
          // 如果目标落在宫格 cell 上，尝试放入
          STATE._suppressNextClick = true;
          clearGridCellHoverHighlight();
          handleNodeDropToGridCell(dragId, event);
          persistCanvasStateDebounced();
        } else {
          // 纯点击：展开表单
          STATE.expandedNodeId = dragId;
          const el = document.querySelector(`.node[data-node-id="${dragId}"]`);
          if (el) el.classList.add('is-expanded');
          persistCanvasStateDebounced();
        }
      }
      if (STATE.selectionBox) {
        hideSelectionBox();
        if (STATE.selectedNodeIds.length === 1) STATE.selectedNodeId = STATE.selectedNodeIds[0];
        STATE.selectionBox = null;
        renderCanvas();
      }
      if (STATE.panning) {
        STATE.panning = false;
        document.getElementById("canvas-board")?.classList.remove("panning");
        persistCanvasStateDebounced();
      }
      if (STATE.connectionDrag) {
        finishConnectionDrag(event.clientX, event.clientY);
        document.body.classList.remove('dragging-connection');
      }
    });

    const wheelBoard = document.getElementById("canvas-board");
    if (wheelBoard) {
      wheelBoard.addEventListener("wheel", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('select, input, textarea, [contenteditable="true"]')) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? -0.08 : 0.08;
        applyZoom(STATE.zoom + delta, event.clientX, event.clientY);
      }, { passive: false });
    }

    document.addEventListener("keydown", (event) => {
      const active = document.activeElement;
      const typing = active && (["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName) || active.getAttribute?.('contenteditable') === 'true');
      const inImageTab = document.getElementById("image")?.classList.contains("active");
      const meta = event.ctrlKey || event.metaKey;
      // 提示词 @ 提及气泡的导航/确认/关闭
      if (active && active.classList?.contains('prompt-input')) {
        if (handlePromptMentionKeydown(event)) return;
        if ((event.key === 'Backspace' || event.key === 'Delete') && handlePromptChipDeleteKey(active, event.key === 'Backspace')) {
          event.preventDefault();
          return;
        }
      }
      if (event.key === "Escape") {
        if (STATE.categoryModal.visible) { closeCategoryModal(); event.preventDefault(); return; }
        closeImagePreview();
      }
      if ((event.key === 'Enter' || event.key === 'NumpadEnter') && STATE.categoryModal.visible && !event.shiftKey) {
        if (active && active.id === 'asset-category-modal-input') {
          event.preventDefault();
          confirmCategoryModal();
          return;
        }
      }
      if (meta && event.key.toLowerCase() === "s" && inImageTab) {
        event.preventDefault();
        flushCanvasSaveNow({ toast: true });
        return;
      }
      if (meta && event.key.toLowerCase() === "z" && !typing && inImageTab) {
        event.preventDefault();
        undoCanvas();
        return;
      }
      if (meta && event.key.toLowerCase() === "c" && STATE.selectedNodeId && !typing && inImageTab) {
        // 如果有文字选区，不拦截浏览器原生复制
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        const node = getNode(STATE.selectedNodeId);
        if (node) {
          STATE.clipboardNode = JSON.parse(JSON.stringify(node));
          STATE._clipboardOwnsSystem = true; // 标记：本次系统剪贴板由画布节点占用
        }
        event.preventDefault();
      }
      // 注意：Ctrl+V 不在这里处理，统一交给下面的 paste 事件，
      // 这样系统剪贴板的图片/文字优先于 STATE.clipboardNode 节点克隆。
      if ((event.key === "Delete" || event.key === "Backspace") && !typing && inImageTab) {
        if (STATE.selectedEdgeId) { deleteEdge(STATE.selectedEdgeId); event.preventDefault(); return; }
        if (STATE.selectedNodeIds.length) { deleteSelectedNodes(); event.preventDefault(); return; }
        if (STATE.selectedNodeId) { deleteNode(STATE.selectedNodeId); event.preventDefault(); }
      }
    });

    // 系统剪贴板被外部"copy/cut"占用时，清空内部节点剪贴板（实现"最后一次复制覆盖前一次"）
    document.addEventListener("copy", () => {
      if (STATE._clipboardOwnsSystem) {
        STATE._clipboardOwnsSystem = false; // 仅本次画布复制保留 clipboardNode
        return;
      }
      STATE.clipboardNode = null;
    });
    document.addEventListener("cut", () => {
      STATE.clipboardNode = null;
      STATE._clipboardOwnsSystem = false;
    });

    document.addEventListener("paste", async (event) => {
      const inImageTab = document.getElementById("image")?.classList.contains("active");
      if (!inImageTab) return;
      const active = document.activeElement;
      if (active && (["INPUT", "TEXTAREA"].includes(active.tagName) || active.getAttribute?.('contenteditable') === 'true')) return;
      const items = event.clipboardData?.items || [];
      const sysText = (event.clipboardData?.getData?.('text/plain') || '').trim();
      let hasImage = false;
      // 系统剪贴板里有图片：创建图片节点，并覆盖内部节点剪贴板
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          hasImage = true;
          STATE.clipboardNode = null; // 系统剪贴板覆盖
          event.preventDefault();
          const point = clientToCanvasPoint(STATE._lastClientX || window.innerWidth / 2, STATE._lastClientY || window.innerHeight / 2);
          const node = createNode(point.x - NODE_DEFAULT_W / 2, point.y - NODE_DEFAULT_H / 2);
          STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; renderCanvas();
          await loadImageToNode(node.id, file);
          return;
        }
      }
      // 系统剪贴板有文本：覆盖内部节点剪贴板，不做画布操作
      if (sysText) {
        STATE.clipboardNode = null;
        return;
      }
      // 系统剪贴板空 → 才用内部节点剪贴板克隆
      if (STATE.clipboardNode) {
        event.preventDefault();
        const copy = JSON.parse(JSON.stringify(STATE.clipboardNode));
        copy.id = makeId();
        const mousePoint = clientToCanvasPoint(STATE._lastClientX || window.innerWidth / 2, STATE._lastClientY || window.innerHeight / 2);
        copy.x = mousePoint.x - (getNodeDisplaySize(copy).width / 2);
        copy.y = mousePoint.y - (getNodeDisplaySize(copy).imgHeight / 2);
        copy.outputImages = [...(copy.outputImages || [])];
        STATE.nodes.push(copy); STATE.selectedNodeId = copy.id; STATE.selectedEdgeId = null; renderCanvas(); renderLeftPanel();
      }
    });

    // touch long-press for asset library images (Android)
    let _assetLongPress = { timer: null, startX: 0, startY: 0, fired: false };
    const LONGPRESS_DELAY = 500;
    const LONGPRESS_MOVE_TOLERANCE = 15;

    root.addEventListener("touchstart", (e) => {
      const card = e.target instanceof HTMLElement ? e.target.closest(".asset-card") : null;
      if (!card) return;
      const touch = e.touches[0];
      _assetLongPress.startX = touch.clientX;
      _assetLongPress.startY = touch.clientY;
      _assetLongPress.fired = false;
      _assetLongPress.timer = setTimeout(() => {
        _assetLongPress.fired = true;
        showAssetTouchMenu(touch.clientX, touch.clientY, card);
      }, LONGPRESS_DELAY);
    }, { passive: true });

    root.addEventListener("touchmove", (e) => {
      if (!_assetLongPress.timer) return;
      const touch = e.touches[0];
      const dx = touch.clientX - _assetLongPress.startX;
      const dy = touch.clientY - _assetLongPress.startY;
      if (dx * dx + dy * dy > LONGPRESS_MOVE_TOLERANCE * LONGPRESS_MOVE_TOLERANCE) {
        clearTimeout(_assetLongPress.timer);
        _assetLongPress.timer = null;
      }
    }, { passive: true });

    root.addEventListener("touchend", (e) => {
      if (_assetLongPress.timer) { clearTimeout(_assetLongPress.timer); _assetLongPress.timer = null; }
      if (_assetLongPress.fired) { e.preventDefault(); }
    });

    root.addEventListener("touchcancel", () => {
      if (_assetLongPress.timer) { clearTimeout(_assetLongPress.timer); _assetLongPress.timer = null; }
    });

    document.addEventListener("click", (e) => {
      if (e.target instanceof HTMLElement && !e.target.closest(".asset-touch-menu")) {
        dismissAssetTouchMenu();
      }
    });
    document.addEventListener("touchstart", (e) => {
      if (e.target instanceof HTMLElement && !e.target.closest(".asset-touch-menu") && !e.target.closest(".asset-card")) {
        dismissAssetTouchMenu();
      }
    }, { passive: true });
  }

  function showAssetTouchMenu(clientX, clientY, card) {
    dismissAssetTouchMenu();
    const addBtn = card.querySelector("[data-add-asset]");
    const moveBtn = card.querySelector("[data-move-asset]");
    const previewBtn = card.querySelector("[data-image-preview]");
    const deleteBtn = card.querySelector("[data-delete-asset]");
    const assetId = addBtn?.getAttribute("data-add-asset") || "";
    const category = moveBtn?.getAttribute("data-asset-category") || "";
    const imageUrl = previewBtn?.getAttribute("data-image-preview") || "";
    const menu = document.createElement("div");
    menu.className = "asset-touch-menu";
    menu.innerHTML = `
      ${imageUrl ? `<button data-tm-preview="${imageUrl}"><i class="fa fa-search-plus"></i> 预览</button>` : ""}
      ${assetId ? `<button data-tm-add="${assetId}"><i class="fa fa-plus-circle"></i> 加入画布</button>` : ""}
      ${assetId ? `<button data-tm-move="${assetId}" data-tm-category="${escapeHtml(category)}"><i class="fa fa-exchange"></i> 移动分类</button>` : ""}
      ${assetId ? `<button data-tm-delete="${assetId}"><i class="fa fa-trash-o"></i> 删除</button>` : ""}
    `;
    const maxX = window.innerWidth - 200;
    const maxY = window.innerHeight - 220;
    menu.style.left = `${Math.min(clientX, maxX)}px`;
    menu.style.top = `${Math.min(clientY, maxY)}px`;
    document.body.appendChild(menu);
    menu.addEventListener("click", (e) => {
      const btn = e.target instanceof HTMLElement ? e.target.closest("button") : null;
      if (!btn) return;
      e.stopPropagation();
      if (btn.hasAttribute("data-tm-preview")) openImagePreview(btn.getAttribute("data-tm-preview"));
      else if (btn.hasAttribute("data-tm-add")) insertAssetAsNode(btn.getAttribute("data-tm-add"));
      else if (btn.hasAttribute("data-tm-move")) openCategoryModal("move", { assetId: btn.getAttribute("data-tm-move"), category: btn.getAttribute("data-tm-category") || DEFAULT_ASSET_CATEGORY });
      else if (btn.hasAttribute("data-tm-delete")) deleteAsset(btn.getAttribute("data-tm-delete"));
      dismissAssetTouchMenu();
    });
  }

  function dismissAssetTouchMenu() {
    document.querySelectorAll(".asset-touch-menu").forEach((el) => el.remove());
  }

  function getImageConfigList() {
    return (window.GLOBAL?.configList || []).filter((item) => ["image", "both"].includes(item.config_type));
  }
  function getImageConfigById(id) {
    return getImageConfigList().find((item) => String(item.id) === String(id)) || null;
  }
  function renderCanvasModelStatus() {}

  function syncModelOptions() {
    const boardReady = Boolean(document.getElementById("canvas-board") && document.getElementById("canvas-node-layer"));
    if (!boardReady) return;
    try {
      renderCanvas();
    } catch (error) {
      STATE.debugInfo.loadStateStatus = "sync-error";
      STATE.debugInfo.loadStateMessage = `syncModelOptions: ${String(error?.message || error)}`;
      throw error;
    }
  }
  function resetCanvas() { pushUndoSnapshot(); STATE.nodes = []; STATE.edges = []; STATE.selectedNodeId = null; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function addNodeAt(x, y) { pushUndoSnapshot(); const node = createNode(x, y); STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; persistCanvasStateDebounced(); renderCanvas(); renderLeftPanel(); }
  function createNode(x, y) {
    return {
      id: makeId(), type: "image",
      x: Math.round(x), y: Math.round(y),
      prompt: "", negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      width: 1024, height: 1024,
      count: 1,
      modelId: String(getDefaultImageConfigId() || ""),
      imageUrl: "", imageBase64: "", assetId: "",
      outputImages: [], busy: false,
    };
  }
  function createResultNodeFromSource(sourceNode, imageUrl, index, total) {
    const node = createNode(sourceNode.x + 460, sourceNode.y + (index * 80));
    // 结果节点没有上游连接，把源节点的 prompt 序列化为纯文本（"图片N" 已展开）
    node.prompt = serializePromptForApi(sourceNode.prompt || "", sourceNode.id);
    node.negativePrompt = sourceNode.negativePrompt || DEFAULT_NEGATIVE_PROMPT;
    node.width = Number(sourceNode.width) || 1024;
    node.height = Number(sourceNode.height) || 1024;
    node.modelId = String(sourceNode.modelId || getDefaultImageConfigId() || "");
    node.outputImages = imageUrl ? [imageUrl] : [];
    node.imageUrl = "";
    node.imageBase64 = "";
    return node;
  }
  function migrateNode(node) {
    if (!node || typeof node !== "object") return node;
    if (!node.type) node.type = "image";
    if ((node.width == null || node.height == null) && (node.resolution || node.ratio)) {
      const size = legacyResolveCanvasSize(node.resolution, node.ratio);
      node.width = size.width;
      node.height = size.height;
    }
    if (node.gptImageSize && (node.width == null || node.height == null)) {
      const parts = String(node.gptImageSize).split("x").map(Number);
      if (parts.length === 2 && parts[0] && parts[1]) {
        const size = clampCanvasSize(parts[0], parts[1]);
        node.width = size.width;
        node.height = size.height;
      }
    }
    if (node.width == null) node.width = 1024;
    if (node.height == null) node.height = 1024;
    delete node.resolution;
    delete node.ratio;
    delete node.gptImageSize;
    return node;
  }
  function migrateAllNodes() {
    if (Array.isArray(STATE.nodes)) STATE.nodes.forEach(migrateNode);
  }
  function getDefaultImageConfigId() { const list = getImageConfigList(); return String(list[0]?.id || ""); }
  function syncNodeModelDefaults() {
    const defaultId = getDefaultImageConfigId();
    if (!defaultId) return;
    let changed = false;
    for (const node of STATE.nodes) {
      if (!node.modelId) {
        node.modelId = defaultId;
        changed = true;
      }
    }
    if (changed) persistCanvasState();
  }
  function getNode(nodeId) { return STATE.nodes.find((node) => node.id === nodeId); }
  let __cachedDragEl = null;
  let __cachedDragElId = null;
  let __dragBaseX = 0;
  let __dragBaseY = 0;
  function updateDraggedNodePosition(node) {
    const el = __cachedDragEl;
    if (!el) return;
    const dx = node.x - __dragBaseX;
    const dy = node.y - __dragBaseY;
    el.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  function commitDraggedNodePosition() {
    if (!__cachedDragEl) return;
    // 把 transform 的位移合并到 left/top，清除 transform
    __cachedDragEl.style.transform = '';
    __cachedDragEl.style.willChange = '';
    const node = getNode(__cachedDragElId);
    if (node && __cachedDragEl) {
      __cachedDragEl.style.left = `${node.x}px`;
      __cachedDragEl.style.top = `${node.y}px`;
    }
  }
  function computeEdgeGeometry(edge) {
    const fromNode = getNode(edge.from), toNode = getNode(edge.to);
    if (!fromNode || !toNode) return null;
    const from = getPortPosition(fromNode, "output"), to = getPortPosition(toNode, "input");
    const dx = to.x - from.x, dy = to.y - from.y;
    const distance = Math.max(80, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.15);
    const c1x = from.x + distance, c2x = to.x - distance;
    const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
    const midX = (from.x + to.x) / 2, midY = (from.y + to.y) / 2;
    const length = Math.max(44, Math.hypot(dx, dy) * 0.35);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    return { d, midX, midY, length, angle };
  }
  function requestCanvasOverlayRefresh() {
    if (STATE.dragFramePending) return;
    STATE.dragFramePending = true;
    requestAnimationFrame(() => {
      STATE.dragFramePending = false;
      const svg = document.getElementById("canvas-svg");
      const edgeDomLayer = document.getElementById("edge-dom-layer");
      if (!svg || !edgeDomLayer) return;
      const dragId = STATE.draggingNodeId;
      const affectedEdges = dragId
        ? STATE.edges.filter((e) => e.from === dragId || e.to === dragId)
        : STATE.edges;
      let needsSvgRebuild = false;
      for (const edge of affectedEdges) {
        const hit = svg.querySelector(`path.edge-hit[data-edge-id="${edge.id}"]`);
        const visibles = svg.querySelectorAll(`path.edge-visible[data-edge-id="${edge.id}"]`);
        if (!hit || !visibles.length) { needsSvgRebuild = true; break; }
        const geom = computeEdgeGeometry(edge);
        if (!geom) continue;
        hit.setAttribute('d', geom.d);
        visibles.forEach((v) => v.setAttribute('d', geom.d));
      }
      if (needsSvgRebuild) {
        svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
      }
      if (dragId) {
        const domHitMap = {};
        edgeDomLayer.querySelectorAll('.edge-dom-hit[data-edge-id]').forEach((el) => {
          domHitMap[el.getAttribute('data-edge-id')] = el;
        });
        for (const edge of affectedEdges) {
          const geom = computeEdgeGeometry(edge);
          if (!geom) continue;
          const el = domHitMap[edge.id];
          if (!el) continue;
          el.style.left = `${geom.midX - geom.length / 2}px`;
          el.style.top = `${geom.midY - 14}px`;
          el.style.width = `${geom.length}px`;
          el.style.transform = `rotate(${geom.angle}deg)`;
        }
      } else {
        const existingDomHits = edgeDomLayer.querySelectorAll('.edge-dom-hit');
        if (existingDomHits.length !== STATE.edges.length) {
          edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
        } else {
          STATE.edges.forEach((edge, i) => {
            const geom = computeEdgeGeometry(edge);
            if (!geom) return;
            const el = existingDomHits[i];
            if (!el) return;
            el.style.left = `${geom.midX - geom.length / 2}px`;
            el.style.top = `${geom.midY - 14}px`;
            el.style.width = `${geom.length}px`;
            el.style.transform = `rotate(${geom.angle}deg)`;
          });
        }
      }
    });
  }
  function updateSelectionBox() {
    const box = document.getElementById("canvas-selection-box");
    if (!box || !STATE.selectionBox) return;
    box.style.display = "block";
    box.style.left = `${STATE.selectionBox.x}px`;
    box.style.top = `${STATE.selectionBox.y}px`;
    box.style.width = `${STATE.selectionBox.width}px`;
    box.style.height = `${STATE.selectionBox.height}px`;
  }
  function hideSelectionBox() {
    const box = document.getElementById("canvas-selection-box");
    if (box) box.style.display = "none";
  }
  function updateSelectionMembership() {
    if (!STATE.selectionBox) return;
    const rect = STATE.selectionBox;
    const left = (rect.x - STATE.panX) / STATE.zoom;
    const top = (rect.y - STATE.panY) / STATE.zoom;
    const right = (rect.x + rect.width - STATE.panX) / STATE.zoom;
    const bottom = (rect.y + rect.height - STATE.panY) / STATE.zoom;
    STATE.selectedNodeIds = STATE.nodes.filter((node) => node.x < right && node.x + NODE_WIDTH > left && node.y < bottom && node.y + 420 > top).map((node) => node.id);
    const nodeEls = document.querySelectorAll(".node[data-node-id]");
    nodeEls.forEach((el) => el.classList.toggle("multi-selected", STATE.selectedNodeIds.includes(el.getAttribute("data-node-id"))));
  }
  function deleteSelectedNodes() {
    const ids = new Set(STATE.selectedNodeIds);
    if (!ids.size) return;
    // 视觉立即：从 DOM 移除
    ids.forEach((id) => {
      const el = document.querySelector(`.node[data-node-id="${id}"]`);
      if (el) el.remove();
    });
    pushUndoSnapshot();
    STATE.nodes = STATE.nodes.filter((node) => !ids.has(node.id));
    STATE.edges = STATE.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
    STATE.selectedNodeIds = [];
    STATE.selectedNodeId = null;
    if (STATE.expandedNodeId && ids.has(STATE.expandedNodeId)) STATE.expandedNodeId = null;
    persistCanvasStateDebounced();
    renderCanvas();
    renderLeftPanel();
  }
  function updateNodeField(nodeId, field, value, options = {}) {
    const node = getNode(nodeId);
    if (!node) return;
    if (field === "sizePreset") {
      const raw = String(value || "");
      if (raw === "custom") return;
      const parts = raw.split("x").map(Number);
      if (parts.length !== 2 || !parts[0] || !parts[1]) return;
      const clamped = clampCanvasSize(parts[0], parts[1]);
      if (node.width === clamped.width && node.height === clamped.height) return;
      pushUndoSnapshot();
      node.width = clamped.width;
      node.height = clamped.height;
      persistCanvasStateDebounced();
      // 同步 input[data-field=width/height] 显示，不整体 rerender
      const el = document.querySelector(`.node[data-node-id="${node.id}"]`);
      if (el) {
        const w = el.querySelector('input[data-field="width"]');
        const h = el.querySelector('input[data-field="height"]');
        if (w) w.value = clamped.width;
        if (h) h.value = clamped.height;
      }
      return;
    }
    if (field === "width" || field === "height") {
      const n = Math.round(Number(value) || 0);
      if (!n) return;
      const nextW = field === "width" ? n : Number(node.width) || 1024;
      const nextH = field === "height" ? n : Number(node.height) || 1024;
      const clamped = clampCanvasSize(nextW, nextH);
      if (node.width === clamped.width && node.height === clamped.height) return;
      pushUndoSnapshot();
      node.width = clamped.width;
      node.height = clamped.height;
      persistCanvasStateDebounced();
      // clamp 后若数字被修正，同步 input 显示；不整体 rerender
      const el = document.querySelector(`.node[data-node-id="${node.id}"]`);
      if (el) {
        const w = el.querySelector('input[data-field="width"]');
        const h = el.querySelector('input[data-field="height"]');
        if (w && Number(w.value) !== clamped.width && document.activeElement !== w) w.value = clamped.width;
        if (h && Number(h.value) !== clamped.height && document.activeElement !== h) h.value = clamped.height;
        // 同步 sizePreset select
        const sel = el.querySelector('select[data-field="sizePreset"]');
        if (sel) {
          const match = `${clamped.width}x${clamped.height}`;
          const has = Array.from(sel.options).some((o) => o.value === match);
          sel.value = has ? match : 'custom';
        }
      }
      return;
    }
    const previousValue = node[field];
    if (field === "modelId") value = String(value || "");
    if (String(previousValue ?? "") === String(value ?? "")) return;
    if (options.rerender !== false) pushUndoSnapshot();
    node[field] = value;
    if (options.rerender === false) {
      persistCanvasStateDebounced();
    } else {
      persistCurrentHistory();
      persistCanvasState();
    }
    if (options.rerender !== false || field === "modelId") renderCanvas();
  }
  function deleteNode(nodeId) {
    // 视觉立即：直接从 DOM 移除节点元素
    const el = document.querySelector(`.node[data-node-id="${nodeId}"]`);
    if (el) el.remove();
    // 后台异步更新 state 和连线
    pushUndoSnapshot();
    STATE.nodes = STATE.nodes.filter((node) => node.id !== nodeId);
    STATE.edges = STATE.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    if (STATE.selectedNodeId === nodeId) STATE.selectedNodeId = null;
    if (STATE.expandedNodeId === nodeId) STATE.expandedNodeId = null;
    cleanupStalePromptRefs();
    persistCanvasStateDebounced();
    renderCanvas();
    renderLeftPanel();
  }
  function deleteEdge(edgeId) { pushUndoSnapshot(); STATE.edges = STATE.edges.filter((edge) => edge.id !== edgeId); if (STATE.selectedEdgeId === edgeId) STATE.selectedEdgeId = null; cleanupStalePromptRefs(); persistCanvasState(); renderCanvas(); }
  function cleanupStalePromptRefs() {
    STATE.nodes.forEach((node) => {
      if (!node || !node.prompt || !node.prompt.includes("{{img:")) return;
      const cleaned = pruneStalePromptRefs(node.prompt, node.id);
      if (cleaned !== node.prompt) node.prompt = cleaned;
    });
  }

  async function loadImageToNode(nodeId, file) {
    const base64Payload = await fileToBase64(file);
    const node = getNode(nodeId);
    if (!node) return;
    node.imageUrl = base64Payload.dataUrl; node.imageBase64 = base64Payload.base64;
    const img = await loadImageElement(base64Payload.dataUrl);
    if (img && img.naturalWidth && img.naturalHeight) {
      node.displayWidth = img.naturalWidth;
      node.displayHeight = img.naturalHeight;
      const clamped = clampCanvasSize(img.naturalWidth, img.naturalHeight);
      node.width = clamped.width;
      node.height = clamped.height;
    }
    renderCanvas();
    const asset = await saveAssetFile({ title: file.name || "粘贴图片", source: "素材库", category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY, mime_type: file.type || "image/png", image_base64: base64Payload.base64 });
    if (asset) { node.assetId = asset.id; node.imageUrl = asset.imageUrl || node.imageUrl; mergeAssetIntoLibrary(asset); }
    persistCanvasState(); renderCanvas(); renderLeftPanel();
  }

  async function selectCategoryForSave(title = "图片素材", imageUrl = "") {
    return new Promise((resolve) => {
      STATE.categoryModal = { visible: true, mode: "save", targetImageUrl: imageUrl || "", targetTitle: title || "图片素材", targetAssetId: "", initialValue: "", category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY, resolver: resolve };
      renderLeftPanel();
      requestAnimationFrame(() => document.getElementById("asset-category-modal-select")?.focus());
    });
  }

  async function saveAssetFile(payload) {
    try {
      const res = await fetch("/api/canvas/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await res.json();
      if (!res.ok || result.code !== 0) { alert(result.detail || result.message || "素材保存失败"); return null; }
      return result.data;
    } catch (error) { console.warn("[canvas] 素材保存失败", error); return null; }
  }

  async function saveImageUrlToLibrary(imageUrl, title = "图片素材") {
    if (!imageUrl) return;
    const base64 = await resolveImageToBase64(imageUrl);
    if (!base64) return alert("当前图片无法加入素材库");
    const category = await selectCategoryForSave(title, imageUrl);
    if (!category) return;
    const asset = await saveAssetFile({ title, source: "手动保存", category, mime_type: guessMimeTypeFromImageUrl(imageUrl), image_base64: base64 });
    if (asset) { mergeAssetIntoLibrary(asset); renderLeftPanel(); persistCanvasState(); showToast(`已加入素材库：${category}`); }
  }

  function beginConnectionDrag(nodeId, clientX, clientY) {
    const node = getNode(nodeId); if (!node) return;
    const inputPortPositions = {};
    STATE.nodes.forEach((n) => { inputPortPositions[n.id] = getPortPosition(n, "input"); });
    STATE.connectionDrag = { fromNodeId: nodeId, start: getPortPosition(node, "output"), current: clientToCanvasPoint(clientX, clientY), targetNodeId: null, inputPortPositions };
    document.body.classList.add('dragging-connection');
    renderCanvas();
  }
  function updateActiveConnectionVisuals() {
    const svg = document.getElementById("canvas-svg");
    if (!svg) return;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const targetId = STATE.connectionDrag ? STATE.connectionDrag.targetNodeId : null;
    let activePath = svg.querySelector('path.edge-visible[data-active="1"]');
    if (STATE.connectionDrag) {
      const from = STATE.connectionDrag.start;
      const to = targetId
        ? (STATE.connectionDrag.inputPortPositions && STATE.connectionDrag.inputPortPositions[targetId]) || getPortPosition(getNode(targetId), "input")
        : STATE.connectionDrag.current;
      const dx = to.x - from.x, dy = to.y - from.y;
      const distance = Math.max(80, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.15);
      const c1x = from.x + distance, c2x = to.x - distance;
      const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
      if (!activePath) {
        activePath = document.createElementNS(SVG_NS, 'path');
        activePath.setAttribute('class', 'edge-visible edge-active');
        activePath.setAttribute('data-active', '1');
        activePath.setAttribute('stroke', '#34d399');
        activePath.setAttribute('stroke-width', '2.4');
        activePath.setAttribute('stroke-dasharray', '10 6');
        activePath.setAttribute('stroke-linecap', 'round');
        activePath.setAttribute('fill', 'none');
        svg.appendChild(activePath);
      }
      activePath.setAttribute('d', d);
    } else if (activePath) {
      activePath.remove();
    }
    document.querySelectorAll(".node[data-node-id]").forEach((el) => {
      el.classList.toggle("node-link-highlight", el.getAttribute("data-node-id") === targetId);
    });
  }
  function updateConnectionDrag(clientX, clientY) { if (!STATE.connectionDrag) return; const point = clientToCanvasPoint(clientX, clientY); STATE.connectionDrag.current = point; const nearest = findNearestInputPort(point, STATE.connectionDrag.fromNodeId); STATE.connectionDrag.targetNodeId = nearest ? nearest.nodeId : null; updateActiveConnectionVisuals(); }
  function finishConnectionDrag(clientX, clientY) { if (!STATE.connectionDrag) return; updateConnectionDrag(clientX, clientY); const fromNodeId = STATE.connectionDrag.fromNodeId; let targetNodeId = STATE.connectionDrag.targetNodeId; const releasePoint = clientToCanvasPoint(clientX, clientY); if (!targetNodeId) { pushUndoSnapshot(); const newNode = createNode(releasePoint.x, releasePoint.y - 120); STATE.nodes.push(newNode); targetNodeId = newNode.id; } if (targetNodeId && targetNodeId !== fromNodeId) { const exists = STATE.edges.some((edge) => edge.from === fromNodeId && edge.to === targetNodeId); if (!exists) { pushUndoSnapshot(); STATE.edges.push({ id: makeId(), from: fromNodeId, to: targetNodeId }); const targetNode = getNode(targetNodeId); if (targetNode) targetNode.prompt = appendPromptRef(targetNode.prompt || "", fromNodeId); } STATE.selectedNodeId = targetNodeId; STATE.selectedEdgeId = null; persistCanvasState(); } STATE.connectionDrag = null; renderCanvas(); renderLeftPanel(); }
  function findNearestInputPort(point, excludeNodeId) {
    // 优先：光标落在某个节点矩形内
    for (const node of STATE.nodes) {
      if (node.id === excludeNodeId) continue;
      const d = getNodeDisplaySize(node);
      const x1 = node.x, y1 = node.y, x2 = node.x + d.width, y2 = node.y + d.imgHeight;
      if (point.x >= x1 && point.x <= x2 && point.y >= y1 && point.y <= y2) {
        return { nodeId: node.id, distance: 0 };
      }
    }
    // 兜底：最近 input port（<= SNAP_DISTANCE）
    const positions = STATE.connectionDrag && STATE.connectionDrag.inputPortPositions;
    let best = null;
    for (const node of STATE.nodes) {
      if (node.id === excludeNodeId) continue;
      const port = (positions && positions[node.id]) || getPortPosition(node, "input");
      const distance = Math.hypot(point.x - port.x, point.y - port.y);
      if (distance <= SNAP_DISTANCE && (!best || distance < best.distance)) best = { nodeId: node.id, distance };
    }
    return best;
  }
  function getLinkedImageNodes(nodeId) {
    return STATE.edges
      .filter((item) => item.to === nodeId)
      .map((edge) => getNode(edge.from))
      .filter(Boolean)
      .map((upstream) => {
        if (upstream.outputAssetId && Array.isArray(STATE.assetLibrary)) {
          const outputAsset = STATE.assetLibrary.find((item) => item.id === upstream.outputAssetId);
          const assetUrl = outputAsset && (outputAsset.imageUrl || outputAsset.displayImageUrl);
          if (assetUrl) return { ...upstream, imageUrl: assetUrl, imageBase64: "" };
        }
        if (upstream.outputImages && upstream.outputImages[0]) return { ...upstream, imageUrl: upstream.outputImages[0], imageBase64: extractBase64(upstream.outputImages[0]) || upstream.imageBase64 || "" };
        if (upstream.imageUrl) return upstream;
        if (upstream.displayImageUrl) return { ...upstream, imageUrl: upstream.displayImageUrl, imageBase64: "" };
        return null;
      })
      .filter(Boolean);
  }
  function resolveLinkedImageNode(nodeId) { return getLinkedImageNodes(nodeId)[0] || null; }

  async function runGenerateNode(nodeId) {
    console.log("[生成] runGenerateNode 被调用, nodeId:", nodeId);
    const node = getNode(nodeId);
    console.log("[生成] 找到节点:", node ? { id: node.id, prompt: (node.prompt||"").slice(0, 40), modelId: node.modelId, busy: node.busy } : null);
    if (!node || node.busy) { console.log("[生成] 提前返回: node不存在或正忙"); return; }
    const serializedPrompt = serializePromptForApi(node.prompt || "", node.id).trim();
    if (!serializedPrompt) { console.log("[生成] 提示词为空，弹出alert"); return alert("请先输入提示词"); }
    if (!node.modelId) { console.log("[生成] modelId为空，弹出alert"); return alert("请先配置图片模型"); }
    pushUndoSnapshot();
    node.busy = true;
    renderCanvas();
    const nodeCfg = getImageConfigById(node.modelId);
    const { width, height } = clampCanvasSize(Number(node.width) || 1024, Number(node.height) || 1024);
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    // 与 buildPromptRefIndexMap 保持完全一致的顺序：上游 + 自身图
    const refList = buildPromptRefIndexMap(node.id).linked;
    const refImages = (await Promise.all(
      refList.map((item) => item.imageBase64 || extractBase64(item.imageUrl) || resolveImageToBase64(item.imageUrl))
    )).filter(Boolean);
    const alreadyDisplayingImage = Boolean((node.outputImages && node.outputImages.length) || node.imageUrl);
    // 生成结果去向：只要节点已有图片或有上游引用，结果就放到新节点；只有空节点才在本节点展示
    const shouldCreateNewNode = alreadyDisplayingImage || linkedImageNodes.length > 0;
    console.log("[生成][参考图] 上游节点数:", linkedImageNodes.length, "本节点自带参考图:", Boolean(node.imageBase64), "最终 refImages 数量:", refImages.length, "image_base64_list_lengths:", refImages.map((item) => (item || "").length));
    try {
      const totalCount = Math.max(1, Number(node.count || 1));
      const jobs = Array.from({ length: totalCount }).map(async (_, index) => {
        console.log("[生成] 发起请求到 /api/image/generate, config_id:", node.modelId, "prompt:", serializedPrompt.slice(0, 60), "job:", index + 1, "/", totalCount);
        const res = await fetch("/api/image/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config_id: node.modelId, prompt: serializedPrompt, negative_prompt: node.negativePrompt || DEFAULT_NEGATIVE_PROMPT, width, height, image_base64: refImages[0] || null, image_base64_list: refImages, n: 1 }),
        });
        console.log("[生成] 响应状态:", res.status, "job:", index + 1);
        const result = await res.json();
        if (!res.ok || result.code !== 0) throw new Error(result.detail || result.message || `生成失败（第${index + 1}张）`);
        const images = (result.data || []).map((item) => normalizeImageResult(item)).filter(Boolean);
        const imageUrl = images[0] || "";
        if (!imageUrl) throw new Error(`生成结果为空（第${index + 1}张）`);
        if (shouldCreateNewNode) {
          const resultNode = createResultNodeFromSource(node, imageUrl, index, totalCount);
          resultNode.displayWidth = width;
          resultNode.displayHeight = height;
          STATE.nodes.push(resultNode);
          STATE.edges.push({ id: makeId(), from: node.id, to: resultNode.id });
          STATE.selectedNodeId = resultNode.id;
        } else if (index === 0) {
          node.outputImages = [imageUrl];
          node.displayWidth = width;
          node.displayHeight = height;
          STATE.selectedNodeId = node.id;
        } else {
          const resultNode = createResultNodeFromSource(node, imageUrl, index, totalCount);
          resultNode.displayWidth = width;
          resultNode.displayHeight = height;
          STATE.nodes.push(resultNode);
          STATE.edges.push({ id: makeId(), from: node.id, to: resultNode.id });
          STATE.selectedNodeId = resultNode.id;
        }
        renderCanvas();
        renderLeftPanel();
        return imageUrl;
      });
      await Promise.all(jobs);
      persistCanvasState();
    } catch (error) {
      alert(error.message || "生成失败");
    } finally {
      node.busy = false;
      renderCanvas();
      renderLeftPanel();
    }
  }

  let __renderCanvasRAF = null;
  function renderCanvas() {
    if (__renderCanvasRAF) return;
    __renderCanvasRAF = requestAnimationFrame(() => {
      __renderCanvasRAF = null;
      _renderCanvasImmediate();
    });
  }
  function renderCanvasSync() { if (__renderCanvasRAF) { cancelAnimationFrame(__renderCanvasRAF); __renderCanvasRAF = null; } _renderCanvasImmediate(); }
  function _renderCanvasImmediate() {
    const world = document.getElementById("canvas-world"), nodeLayer = document.getElementById("canvas-node-layer"), edgeDomLayer = document.getElementById("edge-dom-layer"), svg = document.getElementById("canvas-svg"), empty = document.getElementById("canvas-empty-tip"), menuRoot = document.getElementById("canvas-context-menu-root"), zoomBadge = document.getElementById("canvas-zoom-badge");
    if (!world || !nodeLayer || !edgeDomLayer || !svg || !menuRoot) return;
    world.style.transform = `translate(${STATE.panX}px, ${STATE.panY}px) scale(${STATE.zoom})`;
    if (zoomBadge) zoomBadge.textContent = `${Math.round(STATE.zoom * 100)}%`;
    renderCanvasModelStatus();
    if (empty) empty.style.display = STATE.nodes.length ? "none" : "flex";
    patchNodeLayer(nodeLayer);
    svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
    edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
    menuRoot.innerHTML = renderContextMenu();
    requestAnimationFrame(syncMeasuredPorts);
  }

  function patchNodeLayer(nodeLayer) {
    const existingMap = {};
    nodeLayer.querySelectorAll(':scope > .node[data-node-id]').forEach((el) => {
      existingMap[el.getAttribute('data-node-id')] = el;
    });
    const activeIds = new Set(STATE.nodes.map((n) => n.id));
    for (const id of Object.keys(existingMap)) {
      if (!activeIds.has(id)) existingMap[id].remove();
    }
    let prevEl = null;
    for (const node of STATE.nodes) {
      const existing = existingMap[node.id];
      if (existing) {
        const kept = patchExistingNode(existing, node);
        if (prevEl && prevEl.nextElementSibling !== kept) {
          nodeLayer.insertBefore(kept, prevEl.nextElementSibling);
        }
        prevEl = kept;
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = renderNode(node);
        const newEl = tmp.firstElementChild;
        if (newEl) { newEl._nodeSig = nodeSignature(node); applyNodeState(newEl, node); }
        if (prevEl && prevEl.nextElementSibling) {
          nodeLayer.insertBefore(newEl, prevEl.nextElementSibling);
        } else {
          nodeLayer.appendChild(newEl);
        }
        prevEl = newEl;
      }
    }
  }

  function nodeSignature(node) {
    if (!node) return "";
    const outputKey = (node.outputImages && node.outputImages[0]) ? String(node.outputImages[0]).slice(0, 64) : "";
    const imgKey = node.imageUrl ? String(node.imageUrl).slice(0, 64) : "";
    const busy = node.busy ? "1" : "0";
    if (node.type === "grid") {
      const cellKey = (node.cells || []).map((c) => String((c && c.imageUrl) || "").slice(0, 16)).join("|");
      return `grid|${node.grid}|${node.cellWidth}x${node.cellHeight}|${cellKey}|edit:${node.editMode ? 1 : 0}|busy:${busy}`;
    }
    // 上游引用也要进 signature：没自己图时节点会直接显示上游图
    let upstreamKey = "";
    if (!outputKey && !imgKey) {
      const linked = getLinkedImageNodes(node.id);
      const up = linked[0];
      if (up && up.imageUrl) upstreamKey = String(up.imageUrl).slice(0, 64);
    }
    // 上游 ID 顺序：变化时需要重渲染输入框里的"图片N"徽章
    const upstreamIdsKey = STATE.edges.filter((e) => e.to === node.id).map((e) => e.from).join(",");
    // prompt 中的引用占位符也要进 signature：用户编辑/删除徽章后需要重渲染
    const refTokensKey = (node.prompt || "").match(/\{\{img:[^}]+\}\}/g)?.join(",") || "";
    // 节点显示尺寸只依赖 displayWidth/Height，不依赖用户设置的 width/height
    return `img|${node.displayWidth || ''}x${node.displayHeight || ''}|${outputKey}|${imgKey}|${upstreamKey}|${upstreamIdsKey}|${refTokensKey}|${busy}|${node.modelId || ""}`;
  }

  function applyNodeState(el, node) {
    const selected = STATE.selectedNodeId === node.id;
    const multi = STATE.selectedNodeIds.includes(node.id);
    const linked = STATE.connectionDrag?.targetNodeId === node.id;
    const isSelected = selected || multi;
    const isExpanded = STATE.expandedNodeId === node.id;
    el.classList.toggle('selected', selected);
    el.classList.toggle('multi-selected', multi);
    el.classList.toggle('node-link-highlight', linked);
    el.classList.toggle('is-selected', isSelected);
    el.classList.toggle('is-expanded', isExpanded);
  }

  function patchExistingNode(el, node) {
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    const sig = nodeSignature(node);
    if (el._nodeSig !== sig) {
      // 替换前若用户正在编辑本节点的 prompt，跳过整体替换（避免丢光标）。
      // 仅当上游连线或引用变化触发的重渲染需要更新 prompt editor 时，由 syncPromptEditorRefs 单独刷新。
      const promptEditor = el.querySelector('[data-field="prompt"][contenteditable="true"]');
      if (promptEditor && document.activeElement === promptEditor) {
        // 仅同步徽章索引，文本内容保留用户实时输入
        syncPromptEditorRefs(promptEditor, node);
        el._nodeSig = sig;
        applyNodeState(el, node);
        return el;
      }
      const tmp = document.createElement('div');
      tmp.innerHTML = renderNode(node);
      const fresh = tmp.firstElementChild;
      if (!fresh) return el;
      fresh._nodeSig = sig;
      applyNodeState(fresh, node);
      el.replaceWith(fresh);
      return fresh;
    }
    applyNodeState(el, node);
    return el;
  }
  function syncPromptEditorRefs(editor, node) {
    if (!editor || !node) return;
    const { map, linked } = buildPromptRefIndexMap(node.id);
    const linkedById = new Map(linked.map((it) => [it.id, it]));
    editor.querySelectorAll('.prompt-ref-chip').forEach((chip) => {
      const refId = chip.getAttribute('data-ref-id') || '';
      const idx = map.get(refId);
      const ref = linkedById.get(refId);
      const labelEl = chip.querySelector('.chip-label');
      if (labelEl) labelEl.textContent = ref ? `图片${idx}` : `图片?`;
      chip.setAttribute('data-stale', ref ? '0' : '1');
      const oldImg = chip.querySelector('.chip-thumb, .chip-thumb-fallback');
      const thumb = getRefThumbUrl(ref);
      if (thumb) {
        if (oldImg && oldImg.tagName !== 'IMG') {
          const img = document.createElement('img');
          img.className = 'chip-thumb'; img.draggable = false; img.src = thumb;
          oldImg.replaceWith(img);
        } else if (oldImg && oldImg.getAttribute('src') !== thumb) {
          oldImg.setAttribute('src', thumb);
        }
      }
    });
  }

  let __renderLeftPanelRAF = null;
  function renderLeftPanel() {
    if (__renderLeftPanelRAF) return;
    __renderLeftPanelRAF = requestAnimationFrame(() => {
      __renderLeftPanelRAF = null;
      _renderLeftPanelImmediate();
    });
  }
  function _renderLeftPanelImmediate() {
    const library = document.getElementById("canvas-library-list"), history = document.getElementById("canvas-history-list"), categoryFilter = document.getElementById("asset-category-filter"), assetsRoot = document.getElementById("assets-library-root"), modalFilter = document.getElementById("asset-category-filter-modal"), folderList = document.getElementById("asset-folder-list"), assetGrid = document.getElementById("asset-library-grid"), currentFolder = document.getElementById("asset-library-current-folder"), modal = document.getElementById("asset-library-modal"), categoryModal = document.getElementById("asset-category-modal"), categoryModalTitle = document.getElementById("asset-category-modal-title"), categoryModalSubtitle = document.getElementById("asset-category-modal-subtitle"), categoryModalInput = document.getElementById("asset-category-modal-input"), categoryModalSelect = document.getElementById("asset-category-modal-select");
    const categories = getAssetCategories(), filteredAssets = getFilteredAssets();
    const sortedHistory = [...STATE.historySessions].sort((a, b) => {
      const aScore = ((a.snapshot?.nodes || []).length || 0) + (((a.snapshot?.edges || []).length || 0) * 0.1);
      const bScore = ((b.snapshot?.nodes || []).length || 0) + (((b.snapshot?.edges || []).length || 0) * 0.1);
      if (bScore !== aScore) return bScore - aScore;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    const categoryOptions = ["全部", ...categories].map((name) => `<option value="${escapeHtml(name)}" ${name === STATE.activeAssetCategory ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    const moveOptions = categories.map((name) => `<option value="${escapeHtml(name)}" ${name === (STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY) ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    if (categoryFilter) categoryFilter.innerHTML = categoryOptions;
    if (modalFilter) modalFilter.innerHTML = categoryOptions;
    if (library) library.innerHTML = `<button class="btn btn-default" type="button" data-open-asset-library="1" style="justify-content:flex-start;width:100%;padding:14px 16px;"><i class="fa fa-folder-open-o"></i> 打开素材库</button>`;
    if (assetsRoot) assetsRoot.innerHTML = ``;
    if (folderList) folderList.innerHTML = "";
    if (currentFolder) currentFolder.textContent = `${STATE.activeAssetCategory || "全部"} · ${filteredAssets.length} 个素材`;
    if (assetGrid) assetGrid.innerHTML = filteredAssets.length ? filteredAssets.map((item) => `<article class="asset-card" draggable="true" data-drag-asset-id="${item.id}">${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title || "素材")}" draggable="false">` : ""}<div class="asset-card-body"><div class="canvas-item-title">${escapeHtml(item.title || "未命名素材")}</div><div class="canvas-item-meta">${escapeHtml(item.category || DEFAULT_ASSET_CATEGORY)} · ${escapeHtml(item.source || item.type || "素材")}</div><div class="canvas-item-actions"><button class="btn btn-default" data-add-asset="${item.id}">加入画布</button><button class="btn btn-default" type="button" data-move-asset="${item.id}" data-asset-category="${escapeHtml(item.category || DEFAULT_ASSET_CATEGORY)}">移动分类</button><button class="btn btn-default" type="button" data-image-preview="${item.imageUrl || ""}">预览</button><button class="btn btn-danger" type="button" data-delete-asset="${item.id}">删除</button></div></div></article>`).join("") : `<div class="canvas-empty-card">当前分类还没有素材。<br>上传图片或把生成结果加入素材库后，这里会出现。</div>`;
    if (modal) modal.classList.toggle("hidden", !STATE.isAssetLibraryOpen);
    if (categoryModal) categoryModal.classList.toggle("hidden", !STATE.categoryModal.visible);
    if (categoryModalTitle) categoryModalTitle.textContent = STATE.categoryModal.mode === 'rename' ? '重命名分类' : (STATE.categoryModal.mode === 'move' ? '移动素材分类' : (STATE.categoryModal.mode === 'save' ? '选择保存分类' : '新建分类'));
    if (categoryModalSubtitle) categoryModalSubtitle.textContent = STATE.categoryModal.mode === 'rename' ? '输入新的分类名称，界面与本地文件夹都会同步更新。' : (STATE.categoryModal.mode === 'move' ? '选择一个目标分类，素材文件会移动到对应本地文件夹。' : (STATE.categoryModal.mode === 'save' ? '请选择这张图片要加入到哪个分类。' : '输入新的分类名称并确认。'));
    if (categoryModalInput) { categoryModalInput.style.display = (STATE.categoryModal.mode === 'move' || STATE.categoryModal.mode === 'save') ? 'none' : 'block'; categoryModalInput.value = STATE.categoryModal.initialValue || ''; }
    if (categoryModalSelect) { categoryModalSelect.style.display = (STATE.categoryModal.mode === 'move' || STATE.categoryModal.mode === 'save') ? 'block' : 'none'; categoryModalSelect.innerHTML = moveOptions; categoryModalSelect.value = STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY; }
    if (history) history.innerHTML = sortedHistory.length ? sortedHistory.map((item) => `<article class="canvas-history-item ${item.id === STATE.currentHistoryId ? "active" : ""}"><div class="canvas-history-body"><div class="canvas-item-title">${escapeHtml(item.title || "未命名会话")}</div><div class="canvas-item-meta">${escapeHtml(item.summary || "空白画布")}</div><div class="canvas-item-actions"><button class="btn btn-default" data-open-history="${item.id}">打开</button></div></div></article>`).join("") : `<div class="canvas-empty-card">还没有历史会话。<br>当前画布会自动保存为第一条记录。</div>`;

    const createCategoryBtn = document.getElementById('create-asset-category-btn-modal');
    if (createCategoryBtn) createCategoryBtn.onclick = (event) => { event.preventDefault(); event.stopPropagation(); openCategoryModal('create'); };
    const renameCurrentCategoryBtn = document.getElementById('rename-current-asset-category-btn');
    if (renameCurrentCategoryBtn) renameCurrentCategoryBtn.onclick = (event) => { event.preventDefault(); event.stopPropagation(); if (!STATE.activeAssetCategory || STATE.activeAssetCategory === '全部') return alert('请先选择一个分类'); openCategoryModal('rename', { category: STATE.activeAssetCategory }); };
    const confirmCategoryBtn = document.getElementById('confirm-asset-category-modal-btn');
    if (confirmCategoryBtn) confirmCategoryBtn.onclick = (event) => { event.preventDefault(); event.stopPropagation(); confirmCategoryModal(); };
    document.querySelectorAll('[data-close-category-modal]').forEach((el) => {
      el.onclick = (event) => { event.preventDefault(); event.stopPropagation(); closeCategoryModal(); };
    });
  }

  function openAssetLibraryModal() { STATE.isAssetLibraryOpen = true; renderLeftPanel(); applyAssetLibraryPosition(); }
  function closeAssetLibraryModal() { STATE.isAssetLibraryOpen = false; STATE.assetLibraryDrag.active = false; renderLeftPanel(); }
  function applyAssetLibraryPosition() { const panel = document.getElementById("asset-library-panel"); if (!panel) return; if (STATE.assetLibraryPosition && STATE.isAssetLibraryOpen) { panel.style.left = `${STATE.assetLibraryPosition.left}px`; panel.style.top = `${STATE.assetLibraryPosition.top}px`; panel.style.margin = "0"; } else { panel.style.left = ""; panel.style.top = ""; panel.style.margin = "24px auto"; } }
  async function deleteCurrentCategory() { const category = STATE.activeAssetCategory; if (!category || category === "全部" || category === DEFAULT_ASSET_CATEGORY) return alert("这个分类不能删除"); const count = STATE.assetLibrary.filter((item) => (item.category || DEFAULT_ASSET_CATEGORY) === category).length; if (!confirm(`删除分类「${category}」？这会同时删除该分类下的 ${count} 个素材。`)) return; try { const res = await fetch("/api/canvas/categories", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: category }) }); const result = await res.json(); if (!res.ok || result.code !== 0) return alert(result.detail || result.message || "删除分类失败"); STATE.categories = result.data.categories || STATE.categories; STATE.assetLibrary = result.data.assetLibrary || STATE.assetLibrary; STATE.activeAssetCategory = "全部"; renderLeftPanel(); persistCanvasState(); } catch (error) { alert(error.message || "删除分类失败"); } }
  async function deleteAsset(assetId) { const asset = STATE.assetLibrary.find((item) => item.id === assetId); if (!asset) return; if (!confirm(`删除素材「${asset.title || '未命名素材'}」？`)) return; try { const res = await fetch("/api/canvas/assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset_id: assetId }) }); const result = await res.json(); if (!res.ok || result.code !== 0) return alert(result.detail || result.message || "删除素材失败"); STATE.categories = result.data.categories || STATE.categories; STATE.assetLibrary = result.data.assetLibrary || STATE.assetLibrary; renderLeftPanel(); persistCanvasState(); } catch (error) { alert(error.message || "删除素材失败"); } }
  function openCategoryModal(mode = 'create', payload = {}) {
    STATE.categoryModal = { visible: true, mode, targetImageUrl: payload.imageUrl || '', targetTitle: payload.title || '', targetAssetId: payload.assetId || '', initialValue: payload.category || '', category: payload.category || DEFAULT_ASSET_CATEGORY };
    renderLeftPanel();
    requestAnimationFrame(() => {
      const input = document.getElementById('asset-category-modal-input');
      const select = document.getElementById('asset-category-modal-select');
      if (STATE.categoryModal.mode === 'move') select?.focus();
      else input?.focus();
    });
  }
  function closeCategoryModal() { STATE.categoryModal = { visible: false, mode: 'create', targetImageUrl: '', targetTitle: '', targetAssetId: '', initialValue: '', category: DEFAULT_ASSET_CATEGORY }; renderLeftPanel(); }
  async function confirmCategoryModal() {
    const confirmBtn = document.getElementById('confirm-asset-category-modal-btn');
    if (confirmBtn) confirmBtn.disabled = true;
    try {
    if (STATE.categoryModal.mode === 'create') {
      const name = String(document.getElementById('asset-category-modal-input')?.value || '').trim();
      if (!name) return alert('请输入分类名称');
      const res = await fetch('/api/canvas/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const result = await res.json();
      if (!res.ok || result.code !== 0) return alert(result.detail || result.message || '新建分类失败');
      STATE.categories = result.data.categories || STATE.categories;
      STATE.activeAssetCategory = result.data.name;
      STATE.pendingAssetCategory = result.data.name;
      closeCategoryModal();
      renderLeftPanel();
      return persistCanvasState();
    }
    if (STATE.categoryModal.mode === 'save') {
      const targetCategory = document.getElementById('asset-category-modal-select')?.value || DEFAULT_ASSET_CATEGORY;
      STATE.pendingAssetCategory = targetCategory;
      const resolver = STATE.categoryModal.resolver;
      closeCategoryModal();
      if (typeof resolver === 'function') resolver(targetCategory);
      return;
    }
    if (STATE.categoryModal.mode === 'rename') {
      const newName = String(document.getElementById('asset-category-modal-input')?.value || '').trim();
      if (!newName) return alert('请输入新的分类名称');
      const res = await fetch('/api/canvas/categories', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old_name: STATE.categoryModal.initialValue, new_name: newName }) });
      const result = await res.json();
      if (!res.ok || result.code !== 0) return alert(result.detail || result.message || '分类重命名失败');
      STATE.categories = result.data.categories || STATE.categories;
      STATE.assetLibrary = result.data.assetLibrary || STATE.assetLibrary;
      STATE.activeAssetCategory = result.data.name;
      closeCategoryModal();
      renderLeftPanel();
      return persistCanvasState();
    }
    if (STATE.categoryModal.mode === 'move') {
      const targetCategory = document.getElementById('asset-category-modal-select')?.value || DEFAULT_ASSET_CATEGORY;
      const res = await fetch('/api/canvas/assets/move', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ asset_id: STATE.categoryModal.targetAssetId, target_category: targetCategory }) });
      const result = await res.json();
      if (!res.ok || result.code !== 0) return alert(result.detail || result.message || '素材移动失败');
      STATE.categories = result.data.categories || STATE.categories;
      STATE.assetLibrary = result.data.assetLibrary || STATE.assetLibrary;
      closeCategoryModal();
      renderLeftPanel();
      return persistCanvasState();
    }
    } finally {
      if (confirmBtn) confirmBtn.disabled = false;
    }
  }

function downloadImage(imageUrl) {
    if (!imageUrl) return;
    const link = document.createElement("a");
    link.href = imageUrl;
    link.download = `canvas-image-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function removeReferenceImage(nodeId) {
    const node = getNode(nodeId);
    if (!node) return;
    node.imageUrl = "";
    node.imageBase64 = "";
    node.assetId = "";
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
  }

  function clearNodeOutputImages(nodeId) {
    const node = getNode(nodeId);
    if (!node) return;
    node.outputImages = [];
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
  }

  function getNodeModelMeta(node) {
    const modelCfg = getImageConfigById(node.modelId) || getImageConfigById(getDefaultImageConfigId());
    const rawModelIcon = modelCfg && window.renderModelIcon ? window.renderModelIcon(modelCfg.model_name || modelCfg.name || "", { size: 18, title: modelCfg.model_name || modelCfg.name || "" }) : "";
    return {
      modelCfg,
      modelIcon: `<div class="canvas-node-model-icon">${rawModelIcon || '<i class="fa fa-cube"></i>'}</div>`,
      modelName: escapeHtml(modelCfg?.model_name || modelCfg?.name || "未选择模型")
    };
  }

  function getNodeImageState(node) {
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const outputPreview = node.outputImages?.[0] || "";
    const ownReferenceImage = !outputPreview ? node.imageUrl : "";
    const displayImageUrl = outputPreview || ownReferenceImage;
    const showingGeneratedImage = Boolean(outputPreview);
    const showingOwnReferenceImage = Boolean(!outputPreview && node.imageUrl);
    const imageTitle = showingGeneratedImage ? `生成结果 · ${node.prompt || '画布图片'}` : (node.prompt || '画布图片');
    return { linkedImageNodes, linkedImageNode, outputPreview, ownReferenceImage, displayImageUrl, showingGeneratedImage, showingOwnReferenceImage, imageTitle };
  }

  function getNodeDisplaySize(node) {
    if (node && node.type === "grid") {
      const n = Math.max(2, Math.min(5, Number(node.grid) || 3));
      const cellW = Number(node.cellWidth) || 512;
      const cellH = Number(node.cellHeight) || 512;
      const ratio = cellW / cellH;
      // 最长边封顶
      const maxBound = NODE_DISPLAY_MAX_W - 24; // 减去 padding
      let cellDisplayW, cellDisplayH;
      if (ratio >= 1) {
        cellDisplayW = Math.floor(maxBound / n);
        cellDisplayH = Math.floor(cellDisplayW / ratio);
      } else {
        cellDisplayH = Math.floor(maxBound / n);
        cellDisplayW = Math.floor(cellDisplayH * ratio);
      }
      const totalW = cellDisplayW * n + (n - 1) * 4 + 24;
      const totalH = cellDisplayH * n + (n - 1) * 4 + 24;
      return { width: totalW, height: totalH, imgWidth: totalW - 24, imgHeight: totalH - 24, cellDisplayW, cellDisplayH };
    }
    const hasImage = Boolean((node?.outputImages && node.outputImages.length) || node?.imageUrl);
    // 节点显示尺寸优先按实际图片像素（displayWidth/Height），
    // 若缺失回退 node.width/height，均无时用默认 360×360
    const w = Number(node?.displayWidth) || (hasImage ? (Number(node?.width) || 0) : 0);
    const h = Number(node?.displayHeight) || (hasImage ? (Number(node?.height) || 0) : 0);
    if (!hasImage || !w || !h) {
      return { width: NODE_DEFAULT_W, height: NODE_DEFAULT_H, imgWidth: NODE_DEFAULT_W, imgHeight: NODE_DEFAULT_H };
    }
    const scale = Math.min(NODE_DISPLAY_MAX_W / w, NODE_DISPLAY_MAX_H / h, 1);
    // 如果用户手动设了 displayWidth/Height，直接用，不扩到 MIN
    const userSet = Boolean(node?.displayWidth && node?.displayHeight);
    let imgWidth = userSet ? Math.round(w * scale) : Math.max(NODE_DISPLAY_MIN, Math.round(w * scale));
    let imgHeight = userSet ? Math.round(h * scale) : Math.max(NODE_DISPLAY_MIN, Math.round(h * scale));
    return { width: imgWidth, height: imgHeight, imgWidth, imgHeight };
  }

  function renderSizeControls(node) {
    const presetOptions = CANVAS_SIZE_PRESETS.map((p) => {
      const isSelected = Number(node.width) === p.w && Number(node.height) === p.h;
      return `<option value="${p.w}x${p.h}" ${isSelected ? "selected" : ""}>${escapeHtml(p.label)}</option>`;
    }).join("");
    const isCustom = !CANVAS_SIZE_PRESETS.some((p) => p.w === Number(node.width) && p.h === Number(node.height));
    return `
      <div class="node-row">
        <div class="node-mini-field"><label>尺寸预设</label>
          <select data-node-id="${node.id}" data-field="sizePreset">
            ${presetOptions}
            <option value="custom" ${isCustom ? "selected" : ""}>自定义…</option>
          </select>
        </div>
      </div>
      <div class="node-grid-two">
        <div class="node-mini-field"><label>宽</label>
          <input type="number" step="16" min="256" max="3840" value="${Number(node.width) || 1024}" data-node-id="${node.id}" data-field="width">
        </div>
        <div class="node-mini-field"><label>高</label>
          <input type="number" step="16" min="256" max="3840" value="${Number(node.height) || 1024}" data-node-id="${node.id}" data-field="height">
        </div>
      </div>`;
  }

  function renderNode(node) {
    if (node && node.type === "grid") return renderGridNode(node);
    const isSelected = STATE.selectedNodeId === node.id || STATE.selectedNodeIds.includes(node.id);
    const isExpanded = STATE.expandedNodeId === node.id;
    const selectedCls = STATE.selectedNodeId === node.id ? "selected" : "";
    const multiSelected = STATE.selectedNodeIds.includes(node.id) ? "multi-selected" : "";
    const linkedHighlight = STATE.connectionDrag?.targetNodeId === node.id ? "node-link-highlight" : "";
    const modelOptions = (getImageConfigList().map((c) => `<option value="${c.id}" ${String(c.id) === String(node.modelId) ? "selected" : ""}>${escapeHtml(c.name)} · ${escapeHtml(c.model_name || "")}</option>`).join("")) || '<option value="">暂无图片模型</option>';
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const outputPreview = node.outputImages?.[0] || "";
    const ownReferenceImage = !outputPreview ? node.imageUrl : "";
    const displayImageUrl = outputPreview || ownReferenceImage;
    const showingGeneratedImage = Boolean(outputPreview);
    const showingOwnReferenceImage = Boolean(!outputPreview && node.imageUrl);
    const imageTitle = showingGeneratedImage ? `生成结果 · ${node.prompt || '画布图片'}` : (node.prompt || '画布图片');
    // 有上游引用但没自己图片 → 不展示图片，只显示"已引用 N 个上游节点"
    const hasOwnImage = Boolean(displayImageUrl);
    const hasUpstreamRef = !hasOwnImage && linkedImageNodes.length > 0;
    const hasImage = hasOwnImage;
    const isUpstreamOnly = hasUpstreamRef;
    const display = getNodeDisplaySize(node);

    const topActions = hasImage
      ? (showingOwnReferenceImage
        ? `<div class="node-image-top-actions"><button class="btn btn-default" type="button" data-download-image="${displayImageUrl}"><i class="fa fa-download"></i></button><button class="btn btn-default" type="button" data-grid-crop="${node.id}" title="宫格裁剪"><i class="fa fa-th"></i></button><button class="btn btn-danger" type="button" data-remove-reference-image="${node.id}"><i class="fa fa-times"></i></button></div>`
        : (showingGeneratedImage
          ? `<div class="node-image-top-actions"><button class="btn btn-default" type="button" data-download-image="${displayImageUrl}"><i class="fa fa-download"></i></button><button class="btn btn-default" type="button" data-grid-crop="${node.id}" title="宫格裁剪"><i class="fa fa-th"></i></button><button class="btn btn-danger" type="button" data-clear-output-images="${node.id}"><i class="fa fa-times"></i></button></div>`
          : `<div class="node-image-top-actions"><button class="btn btn-default" type="button" data-download-image="${displayImageUrl}"><i class="fa fa-download"></i></button><button class="btn btn-default" type="button" data-grid-crop="${node.id}" title="宫格裁剪"><i class="fa fa-th"></i></button></div>`))
      : "";

    const previewHtml = hasImage
      ? `<img src="${displayImageUrl}" alt="node-image" draggable="false" ondragstart="return false" data-context-image="${displayImageUrl}" data-image-title="${escapeHtml(imageTitle)}">${topActions}<div class="node-image-overlay"><div class="node-image-toolbar"><button class="btn btn-default" type="button" data-image-preview="${displayImageUrl}">预览</button><button class="btn btn-default" type="button" data-save-image-to-library="${displayImageUrl}" data-image-title="${escapeHtml(imageTitle)}">加入素材库</button></div></div>`
      : (hasUpstreamRef
        ? `<div class="node-image-empty node-upstream-only">
             <div class="node-upstream-icon"><i class="fa fa-link"></i></div>
             <div class="node-upstream-text">已引用 ${linkedImageNodes.length} 个上游节点</div>
             <div class="node-empty-hint">生成时将以上游图片为参考</div>
           </div>`
        : `<div class="node-image-empty node-empty-placeholder">
             <button type="button" class="node-upload-plus" data-upload-image="${node.id}" title="点击上传图片">+</button>
             <div class="node-empty-hint">点击 + 上传图片<br/>或接入上游节点</div>
           </div>`);

    const modelCfg = getImageConfigById(node.modelId) || getImageConfigById(getDefaultImageConfigId());
    const rawModelIcon = modelCfg && window.renderModelIcon ? window.renderModelIcon(modelCfg.model_name || modelCfg.name || "", { size: 18, title: modelCfg.model_name || modelCfg.name || "" }) : "";
    const modelIcon = `<div class="canvas-node-model-icon">${rawModelIcon || '<i class="fa fa-cube"></i>'}</div>`;
    const modelName = escapeHtml(modelCfg?.model_name || modelCfg?.name || "未选择模型");

    // 节点尺寸：有上游引用但无自己图时用默认占位；否则按显示尺寸
    let imgStyle, nodeStyle;
    if (hasUpstreamRef) {
      imgStyle = `width:${NODE_DEFAULT_W}px;height:${NODE_DEFAULT_H}px;`;
      nodeStyle = `left:${node.x}px;top:${node.y}px;width:${NODE_DEFAULT_W}px;`;
    } else {
      imgStyle = `width:${display.imgWidth}px;height:${display.imgHeight}px;`;
      nodeStyle = `left:${node.x}px;top:${node.y}px;width:${display.width}px;`;
    }

    const expandBody = `<div class="node-expand-body"><div class="node-divider"></div><div class="node-body">
      <div class="canvas-node-model">${modelIcon}<div class="canvas-node-model-text"><span class="canvas-node-model-name">${modelName}</span></div></div>
      <div class="node-row node-prompt-editor"><div class="prompt-input" contenteditable="true" data-node-id="${node.id}" data-field="prompt" data-placeholder="描述你想生成的画面，输入 @ 引用上游图片">${renderPromptHtmlForNode(node)}</div></div>
      ${renderSizeControls(node)}
      <div class="node-grid-two">
        <div class="node-mini-field"><label>张数</label><input type="number" min="1" max="4" value="${Number(node.count || 1)}" data-node-id="${node.id}" data-field="count"></div>
        <div class="node-mini-field"><label>模型选择</label><select data-node-id="${node.id}" data-field="modelId">${modelOptions}</select></div>
      </div>
      ${(() => {
        const viewPanoBtn = (node.isPanorama && node.outputImages && node.outputImages[0])
          ? `<button class="btn btn-default" type="button" data-view-panorama="${node.outputImages[0]}" title="在全景查看器打开"><i class="fa fa-globe"></i> 查看全景</button>`
          : "";
        return `<div class="node-actions"><button class="btn btn-primary" type="button" data-run-generate="${node.id}">${node.busy ? "生成中..." : "开始生成"}</button>${viewPanoBtn}</div>`;
      })()}
    </div></div>`;

    return `<div class="node ${selectedCls} ${multiSelected} ${linkedHighlight} ${isSelected ? 'is-selected' : ''} ${isExpanded ? 'is-expanded' : ''}" data-node-id="${node.id}" style="${nodeStyle}">
      <span class="port-handle input" data-node-id="${node.id}" data-side="input"></span>
      <span class="port-handle output" data-node-id="${node.id}" data-side="output"></span>
      <div class="node-shell">
        <div class="node-image-wrap${hasImage ? '' : ' is-empty'}" style="${imgStyle}">${previewHtml}<input type="file" accept="image/*" hidden id="image-file-${node.id}" data-node-id="${node.id}"></div>
        ${expandBody}
      </div>
      <div class="node-resize-handle" data-resize-node="${node.id}"></div>
    </div>`;
  }

  // ── 宫格节点 ────────────────────────────────
  function renderGridNode(node) {
    const isSelected = STATE.selectedNodeId === node.id || STATE.selectedNodeIds.includes(node.id);
    const isExpanded = STATE.expandedNodeId === node.id;
    const isEditing = Boolean(node.editMode);
    const selectedCls = STATE.selectedNodeId === node.id ? "selected" : "";
    const multiSelected = STATE.selectedNodeIds.includes(node.id) ? "multi-selected" : "";
    const linkedHighlight = STATE.connectionDrag?.targetNodeId === node.id ? "node-link-highlight" : "";
    const n = Math.max(2, Math.min(5, Number(node.grid) || 3));
    const display = getNodeDisplaySize(node);
    const nodeStyle = `left:${node.x}px;top:${node.y}px;width:${display.width}px;`;
    const cellW = display.cellDisplayW || Math.floor((display.width - 24 - (n - 1) * 4) / n);
    const cellH = display.cellDisplayH || cellW;
    const cellsHtml = (node.cells || []).map((cell) => {
      const has = Boolean(cell && cell.imageUrl);
      return `<div class="grid-cell ${has ? 'has-image' : ''}" data-grid-cell="${cell.row}-${cell.col}" data-grid-node="${node.id}" style="width:${cellW}px;height:${cellH}px;">${
        has ? `<img src="${cell.imageUrl}" draggable="false" ondragstart="return false" alt="cell">` : `<span class="grid-cell-plus">+</span>`
      }</div>`;
    }).join("");
    const editBtn = `<div class="node-grid-edit-btn"><button type="button" class="btn-toggle-edit" data-grid-toggle-edit="${node.id}">${isEditing ? '完成编辑' : '编辑'}</button></div>`;
    const expandBody = `<div class="node-expand-body"><div class="node-divider"></div><div class="node-body">
      <div class="canvas-node-model"><div class="canvas-node-model-text"><span class="canvas-node-model-name">宫格 ${n}×${n} · 单格 ${node.cellWidth || 0}×${node.cellHeight || 0}</span></div></div>
      <div class="node-actions">
        <button class="btn btn-primary" type="button" data-grid-merge="${node.id}">合成为整图</button>
        <button class="btn btn-default" type="button" data-grid-clear="${node.id}">清空</button>
      </div>
    </div></div>`;
    return `<div class="node grid-node ${selectedCls} ${multiSelected} ${linkedHighlight} ${isSelected ? 'is-selected' : ''} ${isExpanded ? 'is-expanded' : ''} ${isEditing ? 'is-editing' : ''}" data-node-id="${node.id}" style="${nodeStyle}">
      <span class="port-handle input" data-node-id="${node.id}" data-side="input"></span>
      <span class="port-handle output" data-node-id="${node.id}" data-side="output"></span>
      ${editBtn}
      <div class="node-shell">
        <div class="grid-cells" style="grid-template-columns:repeat(${n},${cellW}px);grid-template-rows:repeat(${n},${cellH}px);">${cellsHtml}</div>
        ${expandBody}
      </div>
      <div class="node-resize-handle" data-resize-node="${node.id}"></div>
    </div>`;
  }

  // ── 宫格尺寸选择气泡 ────────────────────────────────
  let __gridSizePopoverEl = null;
  function hideGridSizePopover() {
    if (__gridSizePopoverEl) { __gridSizePopoverEl.remove(); __gridSizePopoverEl = null; }
  }
  function showGridSizePopover(nodeId, anchorEl) {
    hideGridSizePopover();
    if (!nodeId || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'grid-size-popover';
    pop.innerHTML = [2, 3, 4, 5].map((n) => `<button type="button" data-grid-size="${n}" data-grid-source="${nodeId}">${n}×${n}</button>`).join("");
    pop.style.left = `${rect.left}px`;
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.position = 'fixed';
    document.body.appendChild(pop);
    __gridSizePopoverEl = pop;
    pop.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-grid-size]');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      const n = Number(btn.getAttribute('data-grid-size')) || 3;
      const srcId = btn.getAttribute('data-grid-source');
      hideGridSizePopover();
      createGridNodeFromImage(srcId, n);
    });
    setTimeout(() => {
      const closeHandler = (ev) => {
        if (!__gridSizePopoverEl) return;
        if (__gridSizePopoverEl.contains(ev.target)) return;
        hideGridSizePopover();
        document.removeEventListener('mousedown', closeHandler, true);
      };
      document.addEventListener('mousedown', closeHandler, true);
    }, 0);
  }

  // ── 从图片创建宫格节点 ────────────────────────────────
  async function createGridNodeFromImage(sourceNodeId, n) {
    const source = getNode(sourceNodeId);
    if (!source) return;
    const { displayImageUrl } = getNodeImageState(source);
    if (!displayImageUrl) { showToast('该节点没有图片'); return; }
    const img = await loadImageElement(displayImageUrl);
    if (!img) { showToast('图片加载失败'); return; }
    const cellW = Math.floor(img.naturalWidth / n);
    const cellH = Math.floor(img.naturalHeight / n);
    if (cellW < 16 || cellH < 16) { showToast('图片太小，无法切分'); return; }
    const cells = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const canvas = document.createElement('canvas');
        canvas.width = cellW;
        canvas.height = cellH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, col * cellW, row * cellH, cellW, cellH, 0, 0, cellW, cellH);
        cells.push({ row, col, imageUrl: canvas.toDataURL('image/png') });
      }
    }
    pushUndoSnapshot();
    const sourceDisplay = getNodeDisplaySize(source);
    const gridNode = {
      id: makeId(), type: 'grid',
      x: Math.round(source.x + sourceDisplay.width + 40),
      y: source.y,
      grid: n, cellWidth: cellW, cellHeight: cellH, cells,
    };
    STATE.nodes.push(gridNode);
    STATE.selectedNodeId = gridNode.id;
    persistCanvasState();
    renderCanvas();
  }

  function loadImageElement(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function mergeGridNodeToImage(gridNodeId) {
    const grid = getNode(gridNodeId);
    if (!grid || grid.type !== 'grid') return;
    const n = grid.grid;
    const cw = grid.cellWidth, ch = grid.cellHeight;
    if (!cw || !ch) return;
    const canvas = document.createElement('canvas');
    canvas.width = cw * n;
    canvas.height = ch * n;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    let anyImage = false;
    for (const cell of (grid.cells || [])) {
      if (!cell || !cell.imageUrl) continue;
      const img = await loadImageElement(cell.imageUrl);
      if (!img) continue;
      ctx.drawImage(img, cell.col * cw, cell.row * ch, cw, ch);
      anyImage = true;
    }
    if (!anyImage) { showToast('没有可合成的图片'); return; }
    pushUndoSnapshot();
    const merged = createNode(grid.x + getNodeDisplaySize(grid).width + 40, grid.y);
    merged.imageUrl = canvas.toDataURL('image/png');
    merged.imageBase64 = extractBase64(merged.imageUrl) || '';
    merged.width = canvas.width;
    merged.height = canvas.height;
    STATE.nodes.push(merged);
    STATE.selectedNodeId = merged.id;
    persistCanvasState();
    renderCanvas();
  }

  function clearGridNodeCells(gridNodeId) {
    const grid = getNode(gridNodeId);
    if (!grid || grid.type !== 'grid') return;
    if (!confirm('清空宫格所有格子？')) return;
    pushUndoSnapshot();
    (grid.cells || []).forEach((c) => { c.imageUrl = ''; c.imageBase64 = ''; c.assetId = ''; });
    persistCanvasState();
    renderCanvas();
  }

  // 从 cell 拖出生成新节点
  let __gridDragFromCell = null;
  function handleGridCellMouseDown(cellEl, nodeId, event) {
    const cellKey = cellEl.getAttribute('data-grid-cell') || '';
    const [row, col] = cellKey.split('-').map(Number);
    const grid = getNode(nodeId);
    if (!grid) return;
    const cell = (grid.cells || []).find((c) => c.row === row && c.col === col);
    if (!cell || !cell.imageUrl) return;
    __gridDragFromCell = {
      gridId: nodeId, row, col,
      startX: event.clientX, startY: event.clientY,
      moved: false,
      spawned: false, // 是否已创建新节点
    };
  }
  function handleGridCellMouseMove(event) {
    if (!__gridDragFromCell) return;
    const info = __gridDragFromCell;
    if (info.spawned) return; // 已转交给节点拖拽系统
    const dx = event.clientX - info.startX;
    const dy = event.clientY - info.startY;
    if (Math.abs(dx) + Math.abs(dy) > 6 && !info.spawned) {
      info.spawned = true;
      spawnNodeFromGridCellAndStartDrag(info, event);
    }
  }
  function handleGridCellMouseUp(event) {
    if (!__gridDragFromCell) return;
    __gridDragFromCell = null;
    // 如果已 spawn，节点拖拽系统会自己处理 mouseup
  }

  // 第一次移动超阈值时触发：从格子取图 → 创建新节点于鼠标位置 → 立即接入 STATE.draggingNodeId 拖拽流程
  function spawnNodeFromGridCellAndStartDrag(info, event) {
    const grid = getNode(info.gridId);
    if (!grid) return;
    const cell = (grid.cells || []).find((c) => c.row === info.row && c.col === info.col);
    if (!cell || !cell.imageUrl) return;
    const gridDisplay = getNodeDisplaySize(grid);
    const cellDispW = gridDisplay.cellDisplayW || 120;
    const cellDispH = gridDisplay.cellDisplayH || 120;
    const point = clientToCanvasPoint(event.clientX, event.clientY);
    pushUndoSnapshot();
    const newNode = createNode(Math.round(point.x - cellDispW / 2), Math.round(point.y - cellDispH / 2));
    newNode.imageUrl = cell.imageUrl;
    newNode.imageBase64 = cell.imageBase64 || extractBase64(cell.imageUrl) || '';
    newNode.width = grid.cellWidth;
    newNode.height = grid.cellHeight;
    newNode.displayWidth = cellDispW;
    newNode.displayHeight = cellDispH;
    cell.imageUrl = '';
    cell.imageBase64 = '';
    cell.assetId = '';
    STATE.nodes.push(newNode);
    STATE.selectedNodeId = newNode.id;
    // 先 renderCanvas 让新节点 DOM 出现
    renderCanvasSync();
    // 接入节点拖拽系统
    const nodeEl = document.querySelector(`.node[data-node-id="${newNode.id}"]`);
    if (!nodeEl) return;
    STATE.draggingNodeId = newNode.id;
    STATE.dragMoved = true;
    STATE.dragOffsetX = point.x - newNode.x;
    STATE.dragOffsetY = point.y - newNode.y;
    __dragBaseX = newNode.x;
    __dragBaseY = newNode.y;
    __cachedDragEl = nodeEl;
    __cachedDragElId = newNode.id;
    nodeEl.style.willChange = 'transform';
    document.body.classList.add('node-dragging');
    nodeEl.classList.add('is-dragging', 'selected', 'is-selected');
    persistCanvasStateDebounced();
  }

  // 拖入本地文件到 cell（HTML5 drag/drop）
  async function handleGridCellDrop(cellEl, gridNodeId, event) {
    event.preventDefault();
    event.stopPropagation();
    cellEl.classList.remove('drag-over');
    const grid = getNode(gridNodeId);
    if (!grid) return;
    const cellKey = cellEl.getAttribute('data-grid-cell') || '';
    const [row, col] = cellKey.split('-').map(Number);
    const cell = (grid.cells || []).find((c) => c.row === row && c.col === col);
    if (!cell) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (!file || !(file.type || '').startsWith('image/')) { showToast('只能拖入图片文件'); return; }
    const payload = await fileToBase64(file);
    const img = await loadImageElement(payload.dataUrl);
    if (!img) { showToast('图片读取失败'); return; }
    const targetRatio = grid.cellWidth / grid.cellHeight;
    const fileRatio = img.naturalWidth / img.naturalHeight;
    if (Math.abs(fileRatio - targetRatio) / targetRatio > 0.02) {
      showToast(`比例不符 · 需要 ${grid.cellWidth}:${grid.cellHeight}`);
      return;
    }
    pushUndoSnapshot();
    cell.imageUrl = payload.dataUrl;
    cell.imageBase64 = payload.base64;
    persistCanvasState();
    renderCanvas();
  }

  async function handleGridCellDropAsset(cellEl, gridNodeId, assetId) {
    const grid = getNode(gridNodeId);
    if (!grid) return;
    const cellKey = cellEl.getAttribute('data-grid-cell') || '';
    const [row, col] = cellKey.split('-').map(Number);
    const cell = (grid.cells || []).find((c) => c.row === row && c.col === col);
    if (!cell) return;
    const asset = STATE.assetLibrary.find((a) => a.id === assetId);
    if (!asset || !asset.imageUrl) { showToast('素材无图片'); return; }
    const img = await loadImageElement(asset.imageUrl);
    if (!img) { showToast('素材图片加载失败'); return; }
    const targetRatio = grid.cellWidth / grid.cellHeight;
    const fileRatio = img.naturalWidth / img.naturalHeight;
    if (Math.abs(fileRatio - targetRatio) / targetRatio > 0.02) {
      showToast(`比例不符 · 需要 ${grid.cellWidth}:${grid.cellHeight}`);
      return;
    }
    pushUndoSnapshot();
    cell.imageUrl = asset.imageUrl;
    cell.imageBase64 = extractBase64(asset.imageUrl) || '';
    cell.assetId = assetId;
    persistCanvasState();
    renderCanvas();
  }

  function openGridCellUpload(cellEl) {
    const gridNodeId = cellEl.getAttribute('data-grid-node') || '';
    if (!gridNodeId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      // 模拟 drop 事件
      await handleGridCellDrop(cellEl, gridNodeId, { preventDefault: () => {}, stopPropagation: () => {}, dataTransfer: { files: [file] } });
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  // 节点拖动结束时，如果落在宫格 cell 上，尝试放入
  let __hoveredGridCellEl = null;
  function updateGridCellHoverHighlight(nodeId, clientX, clientY) {
    const sourceNode = getNode(nodeId);
    if (!sourceNode || sourceNode.type === 'grid') return;
    const imgUrl = (sourceNode.outputImages && sourceNode.outputImages[0]) || sourceNode.imageUrl;
    if (!imgUrl) return;
    const nodeEl = document.querySelector(`.node[data-node-id="${nodeId}"]`);
    const prev = nodeEl ? nodeEl.style.display : '';
    if (nodeEl) nodeEl.style.display = 'none';
    let cellEl = null;
    if (typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(clientX, clientY);
      for (const el of stack) {
        const c = typeof el.closest === 'function' ? el.closest('.grid-cell') : null;
        if (c) { cellEl = c; break; }
      }
    }
    if (nodeEl) nodeEl.style.display = prev;
    if (__hoveredGridCellEl && __hoveredGridCellEl !== cellEl) {
      __hoveredGridCellEl.classList.remove('drag-over');
    }
    if (cellEl && cellEl !== __hoveredGridCellEl) {
      // 只在 grid.editMode 才高亮
      const gid = cellEl.getAttribute('data-grid-node');
      const g = getNode(gid);
      if (g && g.editMode) {
        cellEl.classList.add('drag-over');
      } else {
        cellEl = null;
      }
    }
    __hoveredGridCellEl = cellEl;
  }
  function clearGridCellHoverHighlight() {
    if (__hoveredGridCellEl) {
      __hoveredGridCellEl.classList.remove('drag-over');
      __hoveredGridCellEl = null;
    }
  }

  async function handleNodeDropToGridCell(nodeId, event) {
    const sourceNode = getNode(nodeId);
    if (!sourceNode || sourceNode.type === 'grid') return;
    const imgUrl = (sourceNode.outputImages && sourceNode.outputImages[0]) || sourceNode.imageUrl;
    if (!imgUrl) return;
    // 先隐藏被拖节点（含所有子元素），再用 elementsFromPoint 查 cell
    const nodeEl = document.querySelector(`.node[data-node-id="${nodeId}"]`);
    const prevDisplay = nodeEl ? nodeEl.style.display : '';
    if (nodeEl) nodeEl.style.display = 'none';
    // 用 elementsFromPoint 获取所有命中的元素，找第一个 .grid-cell
    let cellEl = null;
    if (typeof document.elementsFromPoint === 'function') {
      const stack = document.elementsFromPoint(event.clientX, event.clientY);
      for (const el of stack) {
        const c = typeof el.closest === 'function' ? el.closest('.grid-cell') : null;
        if (c) { cellEl = c; break; }
      }
    } else {
      const elAt = document.elementFromPoint(event.clientX, event.clientY);
      cellEl = elAt && typeof elAt.closest === 'function' ? elAt.closest('.grid-cell') : null;
    }
    if (nodeEl) nodeEl.style.display = prevDisplay;
    if (!cellEl) return;
    const gridNodeId = cellEl.getAttribute('data-grid-node');
    const grid = getNode(gridNodeId);
    if (!grid || grid.type !== 'grid') return;
    if (!grid.editMode) return; // 非编辑模式不接受拖入
    const cellKey = cellEl.getAttribute('data-grid-cell') || '';
    const [row, col] = cellKey.split('-').map(Number);
    const cell = (grid.cells || []).find((c) => c.row === row && c.col === col);
    if (!cell) return;
    const img = await loadImageElement(imgUrl);
    if (!img) { showToast('图片加载失败'); return; }
    const targetRatio = grid.cellWidth / grid.cellHeight;
    const fileRatio = img.naturalWidth / img.naturalHeight;
    if (Math.abs(fileRatio - targetRatio) / targetRatio > 0.02) {
      showToast(`比例不符 · 需要 ${grid.cellWidth}:${grid.cellHeight}`);
      return;
    }
    pushUndoSnapshot();
    cell.imageUrl = imgUrl;
    cell.imageBase64 = extractBase64(imgUrl) || sourceNode.imageBase64 || '';
    cell.assetId = sourceNode.assetId || '';
    // 删除被拖节点（视觉立即 + state 更新）
    if (nodeEl) nodeEl.remove();
    STATE.nodes = STATE.nodes.filter((n) => n.id !== nodeId);
    STATE.edges = STATE.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
    if (STATE.selectedNodeId === nodeId) STATE.selectedNodeId = grid.id;
    if (STATE.expandedNodeId === nodeId) STATE.expandedNodeId = null;
    persistCanvasStateDebounced();
    renderCanvas();
  }


  function renderEdge(edge) {
    const fromNode = getNode(edge.from), toNode = getNode(edge.to);
    if (!fromNode || !toNode) return "";
    const from = getPortPosition(fromNode, "output"), to = getPortPosition(toNode, "input");
    const dx = to.x - from.x, dy = to.y - from.y;
    const distance = Math.max(80, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.15);
    const c1x = from.x + distance, c2x = to.x - distance;
    const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
    const selected = STATE.selectedEdgeId === edge.id;
    const outerColor = selected ? "rgba(245,158,11,.25)" : "rgba(2,6,23,.55)";
    const innerColor = selected ? "#fbbf24" : "#93c5fd";
    const innerWidth = selected ? 3.0 : 2.4;
    return `<path class="edge-hit" data-edge-id="${edge.id}" d="${d}"></path><path class="edge-visible edge-outline" data-edge-id="${edge.id}" d="${d}" stroke="${outerColor}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"></path><path class="edge-visible edge-core ${selected ? 'edge-selected' : ''}" data-edge-id="${edge.id}" d="${d}" stroke="${innerColor}" stroke-width="${innerWidth}" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>`;
  }

  function renderEdgeDomHit(edge) {
    const fromNode = getNode(edge.from), toNode = getNode(edge.to);
    if (!fromNode || !toNode) return "";
    const from = getPortPosition(fromNode, "output"), to = getPortPosition(toNode, "input");
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const length = Math.max(44, Math.hypot(to.x - from.x, to.y - from.y) * 0.35);
    const angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
    return `<div class="edge-dom-hit ${STATE.selectedEdgeId === edge.id ? 'edge-selected' : ''}" data-edge-id="${edge.id}" style="left:${midX - length / 2}px;top:${midY - 14}px;width:${length}px;transform:rotate(${angle}deg);"></div>`;
  }

  function renderActiveConnection() {
    if (!STATE.connectionDrag) return "";
    const from = STATE.connectionDrag.start;
    const targetId = STATE.connectionDrag.targetNodeId;
    const to = targetId
      ? (STATE.connectionDrag.inputPortPositions && STATE.connectionDrag.inputPortPositions[targetId]) || getPortPosition(getNode(targetId), "input")
      : STATE.connectionDrag.current;
    const dx = to.x - from.x, dy = to.y - from.y;
    const distance = Math.max(80, Math.abs(dx) * 0.5 + Math.abs(dy) * 0.15);
    const c1x = from.x + distance, c2x = to.x - distance;
    return `<path class="edge-visible edge-active" data-active="1" d="M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}" stroke="#34d399" stroke-width="2.4" stroke-dasharray="10 6" fill="none" stroke-linecap="round"></path>`;
  }

  function getPortOffsetY(node) {
    const m = STATE.measuredNodeCenters[node.id];
    if (m && typeof m === "object") return m.y;
    const d = getNodeDisplaySize(node);
    return Math.round(d.imgHeight / 2);
  }
  function getPortPosition(node, side) {
    const m = STATE.measuredNodeCenters[node.id];
    const d = getNodeDisplaySize(node);
    const width = (m && typeof m === "object" && m.w) || d.width;
    const y = (m && typeof m === "object") ? m.y : Math.round(d.imgHeight / 2);
    return {
      x: side === "output" ? node.x + width + PORT_RADIUS : node.x - PORT_RADIUS,
      y: node.y + y,
    };
  }

  function syncMeasuredPorts() {
    const nodes = document.querySelectorAll(".node[data-node-id]");
    let changed = false;
    nodes.forEach((el) => {
      const id = el.getAttribute("data-node-id");
      const imgWrap = el.querySelector('.node-image-wrap');
      const imgHeight = imgWrap ? imgWrap.offsetHeight : el.offsetHeight;
      const y = Math.max(12, Math.round(imgHeight / 2));
      const w = el.offsetWidth;
      const prev = STATE.measuredNodeCenters[id];
      if (!prev || prev.y !== y || prev.w !== w) {
        STATE.measuredNodeCenters[id] = { y, w };
        changed = true;
      }
    });
    if (changed && !STATE.connectionDrag) {
      const svg = document.getElementById("canvas-svg");
      if (svg) svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
      const edgeDomLayer = document.getElementById("edge-dom-layer");
      if (edgeDomLayer) edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
    }
  }

  function applyZoom(nextZoom, clientX, clientY) { const oldZoom = STATE.zoom; const rect = getBoardRect(); const anchorX = clientX ?? (rect.left + rect.width / 2); const anchorY = clientY ?? (rect.top + rect.height / 2); const worldX = (anchorX - rect.left - STATE.panX) / oldZoom; const worldY = (anchorY - rect.top - STATE.panY) / oldZoom; STATE.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(nextZoom.toFixed(2)))); STATE.panX = anchorX - rect.left - worldX * STATE.zoom; STATE.panY = anchorY - rect.top - worldY * STATE.zoom; persistCurrentHistory(); renderCanvas(); }
  function openImagePreview(url) { if (!url) return; STATE.previewImageUrl = url; const modal = document.getElementById("image-preview-modal"), target = document.getElementById("image-preview-target"); if (modal && target) { target.src = url; modal.classList.remove("hidden"); hideContextMenu(false); } }
  function closeImagePreview() { STATE.previewImageUrl = ""; const modal = document.getElementById("image-preview-modal"), target = document.getElementById("image-preview-target"); if (modal && target) { modal.classList.add("hidden"); target.src = ""; } }
  function getBoardRect() { return document.getElementById("canvas-board-wrap")?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 }; }
  function clientToCanvasPoint(clientX, clientY) { const rect = getBoardRect(); return { x: (clientX - rect.left - STATE.panX) / STATE.zoom, y: (clientY - rect.top - STATE.panY) / STATE.zoom }; }
  function showContextMenu(clientX, clientY) { const rect = getBoardRect(); STATE.contextMenu = { visible: true, x: clientX - rect.left, y: clientY - rect.top, canvasPoint: clientToCanvasPoint(clientX, clientY), scope: "board", payload: null }; renderCanvas(); }
  function showImageContextMenu(clientX, clientY, imageUrl, title) { const rect = getBoardRect(); STATE.contextMenu = { visible: true, x: clientX - rect.left, y: clientY - rect.top, canvasPoint: clientToCanvasPoint(clientX, clientY), scope: "image", payload: { imageUrl, title } }; renderCanvas(); }
  function hideContextMenu(rerender = true) { if (!STATE.contextMenu.visible) return; STATE.contextMenu.visible = false; if (rerender) renderCanvas(); }
  function renderContextMenu() {
    if (!STATE.contextMenu.visible) return "";
    if (STATE.contextMenu.scope === "image" && STATE.contextMenu.payload) {
      return `<div class="canvas-context-menu" style="left:${STATE.contextMenu.x}px;top:${STATE.contextMenu.y}px;"><button data-context-preview="${STATE.contextMenu.payload.imageUrl}"><i class="fa fa-search-plus"></i> 预览图片</button><button data-context-save-library="${STATE.contextMenu.payload.imageUrl}" data-image-title="${escapeHtml(STATE.contextMenu.payload.title || '图片素材')}"><i class="fa fa-folder-open-o"></i> 加入素材库</button></div>`;
    }
    return `<div class="canvas-context-menu" style="left:${STATE.contextMenu.x}px;top:${STATE.contextMenu.y}px;">
      <button data-context-create-node="1"><i class="fa fa-plus-circle"></i> 新建节点</button>
      <div style="height:1px;background:rgba(148,163,184,.16);margin:4px 6px;"></div>
      <button data-context-open-grid-dialog="1"><i class="fa fa-th"></i> 新建宫格…</button>
    </div>`;
  }
  function createNodeFromContextMenu() { const point = STATE.contextMenu.canvasPoint || { x: 180, y: 160 }; hideContextMenu(false); addNodeAt(point.x, point.y); }
  function createEmptyGridFromContextMenu(n) {
    const point = STATE.contextMenu.canvasPoint || { x: 180, y: 160 };
    hideContextMenu(false);
    createGridAt(point, n, 512, 512);
  }

  function createGridAt(point, n, cellW, cellH) {
    pushUndoSnapshot();
    const cells = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        cells.push({ row: r, col: c, imageUrl: '', imageBase64: '', assetId: '' });
      }
    }
    const gridNode = {
      id: makeId(), type: 'grid',
      x: Math.round(point.x), y: Math.round(point.y),
      grid: n, cellWidth: cellW, cellHeight: cellH, cells,
    };
    STATE.nodes.push(gridNode);
    STATE.selectedNodeId = gridNode.id;
    STATE.expandedNodeId = gridNode.id;
    persistCanvasStateDebounced();
    renderCanvas();
  }

  const GRID_RATIO_PRESETS = [
    { label: '1:1', w: 512, h: 512 },
    { label: '16:9', w: 1024, h: 576 },
    { label: '9:16', w: 576, h: 1024 },
    { label: '4:3', w: 1024, h: 768 },
    { label: '3:4', w: 768, h: 1024 },
    { label: '3:2', w: 1152, h: 768 },
    { label: '2:3', w: 768, h: 1152 },
    { label: '21:9', w: 1344, h: 576 },
  ];
  let __gridCreateDialogEl = null;
  let __gridCreateDialogState = { n: 3, cellW: 512, cellH: 512, point: null };

  function openGridCreateDialog(point) {
    closeGridCreateDialog();
    __gridCreateDialogState.point = point;
    const overlay = document.createElement('div');
    overlay.className = 'grid-create-overlay';
    overlay.innerHTML = `
      <div class="grid-create-backdrop"></div>
      <div class="grid-create-dialog">
        <div class="grid-create-title">新建宫格节点</div>
        <div class="grid-create-section">
          <div class="grid-create-label">宫格数量</div>
          <div class="grid-create-buttons" data-gc-group="n">
            ${[2,3,4,5].map((v) => `<button type="button" data-gc-n="${v}" class="${v === __gridCreateDialogState.n ? 'active' : ''}">${v}×${v}</button>`).join("")}
          </div>
        </div>
        <div class="grid-create-section">
          <div class="grid-create-label">单元格比例</div>
          <div class="grid-create-buttons" data-gc-group="ratio">
            ${GRID_RATIO_PRESETS.map((p) => `<button type="button" data-gc-ratio="${p.w}x${p.h}" class="${(p.w === __gridCreateDialogState.cellW && p.h === __gridCreateDialogState.cellH) ? 'active' : ''}">${p.label}</button>`).join("")}
          </div>
        </div>
        <div class="grid-create-section">
          <div class="grid-create-label">自定义单元格分辨率</div>
          <div class="grid-create-inputs">
            <input type="number" min="64" max="2048" step="16" value="${__gridCreateDialogState.cellW}" data-gc-input="w" placeholder="宽">
            <span>×</span>
            <input type="number" min="64" max="2048" step="16" value="${__gridCreateDialogState.cellH}" data-gc-input="h" placeholder="高">
          </div>
          <div class="grid-create-preview" data-gc-preview>${__gridCreateDialogState.n}×${__gridCreateDialogState.n} · ${__gridCreateDialogState.cellW}×${__gridCreateDialogState.cellH}</div>
        </div>
        <div class="grid-create-actions">
          <button type="button" class="btn btn-default" data-gc-cancel>取消</button>
          <button type="button" class="btn btn-primary" data-gc-confirm>创建</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    __gridCreateDialogEl = overlay;
    const updatePreview = () => {
      const p = overlay.querySelector('[data-gc-preview]');
      if (p) p.textContent = `${__gridCreateDialogState.n}×${__gridCreateDialogState.n} · ${__gridCreateDialogState.cellW}×${__gridCreateDialogState.cellH}`;
    };
    const setActive = (group, valueKey) => {
      overlay.querySelectorAll(`[data-gc-group="${group}"] button`).forEach((b) => {
        const v = b.getAttribute(group === 'n' ? 'data-gc-n' : 'data-gc-ratio');
        b.classList.toggle('active', v === valueKey);
      });
    };
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('.grid-create-backdrop') || e.target.closest('[data-gc-cancel]')) {
        closeGridCreateDialog();
        return;
      }
      const nBtn = e.target.closest('[data-gc-n]');
      if (nBtn) {
        __gridCreateDialogState.n = Number(nBtn.getAttribute('data-gc-n')) || 3;
        setActive('n', String(__gridCreateDialogState.n));
        updatePreview();
        return;
      }
      const rBtn = e.target.closest('[data-gc-ratio]');
      if (rBtn) {
        const [rw, rh] = rBtn.getAttribute('data-gc-ratio').split('x').map(Number);
        __gridCreateDialogState.cellW = rw;
        __gridCreateDialogState.cellH = rh;
        setActive('ratio', `${rw}x${rh}`);
        const wi = overlay.querySelector('[data-gc-input="w"]');
        const hi = overlay.querySelector('[data-gc-input="h"]');
        if (wi) wi.value = rw;
        if (hi) hi.value = rh;
        updatePreview();
        return;
      }
      if (e.target.closest('[data-gc-confirm]')) {
        const w = Math.max(64, Math.min(2048, Math.round(Number(overlay.querySelector('[data-gc-input="w"]').value) / 16) * 16)) || 512;
        const h = Math.max(64, Math.min(2048, Math.round(Number(overlay.querySelector('[data-gc-input="h"]').value) / 16) * 16)) || 512;
        const n = __gridCreateDialogState.n;
        const p = __gridCreateDialogState.point || { x: 200, y: 200 };
        closeGridCreateDialog();
        createGridAt(p, n, w, h);
        return;
      }
    });
    overlay.addEventListener('input', (e) => {
      const input = e.target.closest('[data-gc-input]');
      if (!input) return;
      const w = Number(overlay.querySelector('[data-gc-input="w"]').value) || 0;
      const h = Number(overlay.querySelector('[data-gc-input="h"]').value) || 0;
      __gridCreateDialogState.cellW = w;
      __gridCreateDialogState.cellH = h;
      // 如果不匹配任何预设，就取消预设高亮
      setActive('ratio', `${w}x${h}`);
      updatePreview();
    });
  }

  function closeGridCreateDialog() {
    if (__gridCreateDialogEl) {
      __gridCreateDialogEl.remove();
      __gridCreateDialogEl = null;
    }
  }
  function pushUndoSnapshot() { STATE.undoStack.push(snapshotState()); if (STATE.undoStack.length > 50) STATE.undoStack.shift(); }
  function undoCanvas() { const snapshot = STATE.undoStack.pop(); if (!snapshot) return; restoreSnapshot(snapshot, { focus: false }); STATE.selectedNodeId = null; STATE.selectedEdgeId = null; STATE.selectedNodeIds = []; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  async function loadPersistedCanvasState() {
    const stateUrl = `${window.location.origin}/api/canvas/state`;
    STATE.debugInfo.loadStateUrl = stateUrl;
    STATE.debugInfo.loadStateStatus = "loading";
    STATE.debugInfo.loadStateMessage = "";
    try {
      const res = await fetch(stateUrl, { cache: "no-store" });
      const raw = await res.text();
      let result = null;
      try { result = JSON.parse(raw); } catch (parseError) { throw new Error(`state parse failed: ${String(parseError.message || parseError)} :: ${raw.slice(0, 160)}`); }
      if (!res.ok) throw new Error(`state http ${res.status}: ${raw.slice(0, 160)}`);
      if (result.code !== 0) throw new Error(`state code ${result.code}: ${JSON.stringify(result).slice(0, 160)}`);
      STATE.historySessions = result.data.sessions || [];
      STATE.assetLibrary = result.data.assetLibrary || [];
      STATE.categories = result.data.categories || [];
      STATE.debugInfo.loadStateStatus = "ok";
      STATE.debugInfo.loadStateMessage = `sessions=${STATE.historySessions.length}, assets=${STATE.assetLibrary.length}`;
      if (STATE.historySessions.length) {
        const preferred = STATE.historySessions.find((item) => (item.snapshot?.nodes || []).length || (item.snapshot?.edges || []).length) || STATE.historySessions[0];
        STATE.currentHistoryId = preferred.id;
        restoreSnapshot(preferred.snapshot, { focus: true });
      }
    } catch (error) {
      STATE.debugInfo.loadStateStatus = "error";
      STATE.debugInfo.loadStateMessage = String(error?.message || error);
      console.warn("[canvas] 读取本地状态失败", error);
    }
  }
  function ensureHistorySession() { if (STATE.currentHistoryId && STATE.historySessions.some((item) => item.id === STATE.currentHistoryId)) return; if (STATE.historySessions.length) { const preferred = STATE.historySessions.find((item) => (item.snapshot?.nodes || []).length || (item.snapshot?.edges || []).length) || STATE.historySessions[0]; STATE.currentHistoryId = preferred.id; restoreSnapshot(preferred.snapshot, { focus: true }); return; } const id = makeId(); STATE.historySessions = [{ id, title: "当前画布", summary: "空白画布", snapshot: snapshotState() }]; STATE.currentHistoryId = id; }
  function createNewHistorySession() { const id = makeId(); STATE.nodes = []; STATE.edges = []; STATE.selectedNodeId = null; STATE.selectedEdgeId = null; STATE.panX = 0; STATE.panY = 0; STATE.zoom = 1; STATE.historySessions.unshift({ id, title: `画布会话 ${STATE.historySessions.length + 1}`, summary: "空白画布", snapshot: snapshotState() }); STATE.currentHistoryId = id; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function isAnyNodeVisible() {
    if (!STATE.nodes.length) return false;
    const rect = getBoardRect();
    if (!rect.width || !rect.height) return false;
    for (const node of STATE.nodes) {
      const sx = Number(node.x || 0) * STATE.zoom + STATE.panX;
      const sy = Number(node.y || 0) * STATE.zoom + STATE.panY;
      const sw = NODE_WIDTH * STATE.zoom;
      const sh = 400 * STATE.zoom;
      if (sx + sw > 0 && sx < rect.width && sy + sh > 0 && sy < rect.height) return true;
    }
    return false;
  }
  function openHistorySession(id) { const item = STATE.historySessions.find((entry) => entry.id === id); if (!item) return; persistCurrentHistory(); STATE.currentHistoryId = id; restoreSnapshot(item.snapshot, { focus: false }); if (STATE.nodes.length && !isAnyNodeVisible()) focusNodesInView(); renderCanvas(); renderLeftPanel(); }
  function persistCurrentHistory() { if (!STATE.currentHistoryId) return; const summary = buildHistorySummary(); const index = STATE.historySessions.findIndex((item) => item.id === STATE.currentHistoryId); const payload = { id: STATE.currentHistoryId, title: index >= 0 ? (STATE.historySessions[index].title || `画布会话 ${index + 1}`) : "当前画布", summary, snapshot: snapshotState() }; if (index >= 0) STATE.historySessions[index] = payload; else STATE.historySessions.unshift(payload); }
  let _persistCanvasTimer = null;
  let _persistInFlight = false;
  let _persistPendingAgain = false;

  // ── Web Worker：只做重活 JSON.stringify，发送仍在主线程用 sendBeacon ──
  const _persistWorkerCode = "self.onmessage=function(e){var id=e.data.id;var state=e.data.state;try{var body=JSON.stringify(state);self.postMessage({id:id,body:body});}catch(err){self.postMessage({id:id,error:String(err&&err.message||err)});}};";
  let _persistWorker = null;
  let _persistWorkerTried = false;
  const _persistPending = new Map();
  let _persistReqId = 0;
  function _getPersistWorker() {
    if (_persistWorker || _persistWorkerTried) return _persistWorker;
    _persistWorkerTried = true;
    try {
      const blob = new Blob([_persistWorkerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      _persistWorker = new Worker(url);
      _persistWorker.onmessage = (e) => {
        const { id, body, error } = e.data || {};
        const cb = _persistPending.get(id);
        _persistPending.delete(id);
        if (!cb) return;
        cb(body, error);
      };
      _persistWorker.onerror = (e) => {
        console.warn('[canvas][worker] error', e.message || e);
      };
    } catch (e) {
      console.warn('[canvas] worker init failed', e);
      _persistWorker = null;
    }
    return _persistWorker;
  }

  function _sendBody(body) {
    const url = '/api/canvas/state';
    const size = body ? body.length : 0;
    // keepalive/sendBeacon 有 64KB body 限制，超过就用普通 fetch
    const SMALL_LIMIT = 60 * 1024;
    if (size <= SMALL_LIMIT) {
      let sent = false;
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          const blob = new Blob([body], { type: 'application/json' });
          sent = navigator.sendBeacon(url, blob);
        }
      } catch (_) {}
      if (sent) return;
      // 小 payload 退回到 keepalive fetch
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
        .catch((e) => console.warn('[canvas] 小 payload 保存失败', e));
      return;
    }
    // 大 payload：普通 fetch，不加 keepalive
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .catch((e) => console.warn('[canvas] 大 payload 保存失败', e));
  }

  function _canvasSaveAllowed() {
    // 只有已成功加载过磁盘 state 之后才允许保存。
    // loadStateStatus 状态机：booting → init → loading → ok → (后续) ready；失败会变 error / init-error。
    // 放行：ok / ready / sync-error（sync-error 发生在加载后，数据仍是从磁盘读的真实值）
    // 阻止：booting / init / loading / error / init-error —— 此时 STATE 可能为空，保存会覆盖磁盘
    try {
      const s = STATE && STATE.debugInfo && STATE.debugInfo.loadStateStatus;
      return s === "ok" || s === "ready" || s === "sync-error";
    } catch (_) { return false; }
  }

  function _doPersist() {
    if (!_canvasSaveAllowed()) {
      console.warn('[canvas] 跳过保存：画布状态未加载完成 (loadStateStatus=' + (STATE.debugInfo && STATE.debugInfo.loadStateStatus) + ')');
      _persistInFlight = false;
      _persistPendingAgain = false;
      return;
    }
    if (_persistInFlight) {
      _persistPendingAgain = true;
      return;
    }
    _persistInFlight = true;
    const runHeavy = () => {
      try {
        persistCurrentHistory();
        const payloadObj = { sessions: STATE.historySessions, assetLibrary: STATE.assetLibrary };
        const worker = _getPersistWorker();
        if (worker) {
          const id = ++_persistReqId;
          _persistPending.set(id, (body, error) => {
            if (error || !body) {
              // worker 出错：降级主线程 stringify
              try { _sendBody(JSON.stringify(payloadObj)); } catch (e) { console.warn('[canvas] fallback stringify 失败', e); }
            } else {
              _sendBody(body);
            }
            _persistInFlight = false;
            if (_persistPendingAgain) { _persistPendingAgain = false; _doPersist(); }
          });
          try {
            worker.postMessage({ id, state: payloadObj });
          } catch (e) {
            // postMessage 失败（比如 state 无法结构化克隆）
            console.warn('[canvas] worker postMessage 失败，降级主线程', e);
            _persistPending.delete(id);
            try { _sendBody(JSON.stringify(payloadObj)); } catch (_) {}
            _persistInFlight = false;
            if (_persistPendingAgain) { _persistPendingAgain = false; _doPersist(); }
          }
          // 超时兜底：5 秒后 worker 无响应，强制降级
          setTimeout(() => {
            if (_persistPending.has(id)) {
              _persistPending.delete(id);
              console.warn('[canvas] worker 超时，降级主线程');
              try { _sendBody(JSON.stringify(payloadObj)); } catch (_) {}
              _persistInFlight = false;
              if (_persistPendingAgain) { _persistPendingAgain = false; _doPersist(); }
            }
          }, 5000);
        } else {
          _sendBody(JSON.stringify(payloadObj));
          _persistInFlight = false;
          if (_persistPendingAgain) { _persistPendingAgain = false; _doPersist(); }
        }
      } catch (e) {
        console.warn('[canvas] persist failed', e);
        _persistInFlight = false;
        if (_persistPendingAgain) { _persistPendingAgain = false; _doPersist(); }
      }
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runHeavy, { timeout: 3000 });
    } else {
      setTimeout(runHeavy, 0);
    }
  }
  async function persistCanvasState() {
    // 运行时只更新 in-memory 历史快照，不发请求；保存由 Ctrl+S / tab 切换 / 页面卸载触发
    try { persistCurrentHistory(); } catch (_) {}
  }
  function persistCanvasStateDebounced() {
    try { persistCurrentHistory(); } catch (_) {}
  }
  function flushCanvasSaveNow(opts = {}) {
    if (_persistCanvasTimer) { clearTimeout(_persistCanvasTimer); _persistCanvasTimer = null; }
    if (!_canvasSaveAllowed()) {
      console.warn('[canvas] flushCanvasSaveNow 跳过：画布尚未加载完成');
      if (opts.toast) showToast('画布尚未加载完成，已跳过保存');
      return;
    }
    try { persistCurrentHistory(); } catch (_) {}
    _doPersist();
    if (opts.toast) showToast('画布已保存');
  }
  window.flushImageCanvasSave = flushCanvasSaveNow;

  // 外部入口：把 dataURL（如全景查看器截图）作为新节点放入画布。
  // 走和粘贴/上传一致的管线：写素材库 → 建节点 → 持久化。
  async function addImageNodeFromDataUrl(dataUrl, options = {}) {
    if (!dataUrl || typeof dataUrl !== "string") return null;
    const base64 = extractBase64(dataUrl);
    if (!base64) return null;
    pushUndoSnapshot();
    const rect = getBoardRect();
    const point = rect.width
      ? clientToCanvasPoint(rect.left + rect.width / 2, rect.top + Math.max(180, rect.height / 2))
      : { x: 200, y: 200 };
    const node = createNode(point.x - NODE_DEFAULT_W / 2, point.y - NODE_DEFAULT_H / 2);
    node.imageUrl = dataUrl;
    node.imageBase64 = base64;
    const img = await loadImageElement(dataUrl);
    if (img && img.naturalWidth && img.naturalHeight) {
      node.displayWidth = img.naturalWidth;
      node.displayHeight = img.naturalHeight;
      const clamped = clampCanvasSize(img.naturalWidth, img.naturalHeight);
      node.width = clamped.width;
      node.height = clamped.height;
    }
    STATE.nodes.push(node);
    STATE.selectedNodeId = node.id;
    STATE.selectedEdgeId = null;
    renderCanvas();
    const title = String(options.title || "全景截图").slice(0, 40);
    const mime = String(options.mime || "image/png");
    try {
      const asset = await saveAssetFile({
        title,
        source: "全景查看器",
        category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY,
        mime_type: mime,
        image_base64: base64,
      });
      if (asset) {
        node.assetId = asset.id;
        if (asset.imageUrl) node.imageUrl = asset.imageUrl;
        mergeAssetIntoLibrary(asset);
      }
    } catch (e) {
      console.warn("[canvas] 保存全景截图素材失败", e);
    }
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
    return node.id;
  }
  window.ImageCanvas = Object.assign(window.ImageCanvas || {}, { addImageNodeFromDataUrl });

  // 关闭页面/切后台时强制保存，防止数据丢失
  if (!window.__canvasUnloadBound) {
    window.__canvasUnloadBound = true;
    const flushOnExit = () => {
      if (_persistCanvasTimer) { clearTimeout(_persistCanvasTimer); _persistCanvasTimer = null; }
      if (!_canvasSaveAllowed()) {
        console.warn('[canvas] 离开页面时跳过保存：画布尚未加载完成');
        return;
      }
      try {
        persistCurrentHistory();
        const body = JSON.stringify({ sessions: STATE.historySessions, assetLibrary: STATE.assetLibrary });
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          const blob = new Blob([body], { type: 'application/json' });
          navigator.sendBeacon('/api/canvas/state', blob);
        } else {
          fetch('/api/canvas/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
        }
      } catch (_) {}
    };
    window.addEventListener('beforeunload', flushOnExit);
    window.addEventListener('pagehide', flushOnExit);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnExit(); });
  }
  function buildHistorySummary() { const generatedCount = STATE.nodes.reduce((sum, node) => sum + (node.outputImages || []).length, 0); if (generatedCount) return `已生成 ${generatedCount} 张图 · ${STATE.nodes.length} 个节点`; const promptNode = STATE.nodes.find((node) => (node.prompt || "").trim()); if (promptNode) return `${String(promptNode.prompt).trim().slice(0, 20)} · ${STATE.nodes.length} 个节点`; return STATE.nodes.length ? `${STATE.nodes.length} 个节点` : "空白画布"; }
  function snapshotState() {
    const nodes = STATE.nodes.map((n) => {
      const clone = { ...n };
      if (clone.outputImages && clone.outputImages.length) clone.outputImages = clone.outputImages.map((img) => String(img).length > 2000 ? img : img);
      return clone;
    });
    return { nodes, edges: STATE.edges.map((e) => ({ ...e })), panX: STATE.panX, panY: STATE.panY, zoom: STATE.zoom };
  }
  function focusNodesInView() {
    if (!STATE.nodes.length) return;
    const rect = getBoardRect();
    if (!rect.width || !rect.height) return;
    const xs = STATE.nodes.map((node) => Number(node.x || 0));
    const ys = STATE.nodes.map((node) => Number(node.y || 0));
    const minX = Math.min(...xs), maxX = Math.max(...xs) + NODE_WIDTH;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + 420;
    const contentW = Math.max(320, maxX - minX);
    const contentH = Math.max(220, maxY - minY);
    const targetZoom = Math.max(0.45, Math.min(1, Math.min((rect.width - 120) / contentW, (rect.height - 120) / contentH)));
    STATE.zoom = Number.isFinite(targetZoom) ? targetZoom : 1;
    STATE.panX = Math.round((rect.width - contentW * STATE.zoom) / 2 - minX * STATE.zoom);
    STATE.panY = Math.round((rect.height - contentH * STATE.zoom) / 2 - minY * STATE.zoom);
  }
  function restoreSnapshot(snapshot, options = {}) { STATE.nodes = JSON.parse(JSON.stringify(snapshot?.nodes || [])); STATE.edges = JSON.parse(JSON.stringify(snapshot?.edges || [])); STATE.panX = Number(snapshot?.panX || 0); STATE.panY = Number(snapshot?.panY || 0); STATE.zoom = Number(snapshot?.zoom || 1); migrateAllNodes(); if (options.focus !== false && STATE.nodes.length) focusNodesInView(); }
  function mergeAssetIntoLibrary(asset) { STATE.assetLibrary = [normalizeAsset(asset), ...STATE.assetLibrary.filter((item) => item.id !== asset.id)].slice(0, 120); }
  async function insertAssetAsNode(assetId) {
    const asset = STATE.assetLibrary.find((item) => item.id === assetId);
    if (!asset) return;
    const point = clientToCanvasPoint(getBoardRect().left + 280, getBoardRect().top + 220);
    const node = createNode(point.x, point.y);
    node.imageUrl = asset.imageUrl || "";
    node.imageBase64 = asset.imageBase64 || "";
    node.assetId = asset.id;
    if (node.imageUrl) {
      const img = await loadImageElement(node.imageUrl);
      if (img && img.naturalWidth && img.naturalHeight) {
        node.displayWidth = img.naturalWidth;
        node.displayHeight = img.naturalHeight;
        const clamped = clampCanvasSize(img.naturalWidth, img.naturalHeight);
        node.width = clamped.width;
        node.height = clamped.height;
      }
    }
    STATE.nodes.push(node);
    STATE.selectedNodeId = node.id;
    STATE.selectedEdgeId = null;
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
  }
  function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const dataUrl = String(reader.result || ""); resolve({ dataUrl, base64: extractBase64(dataUrl) || "" }); }; reader.onerror = reject; reader.readAsDataURL(file); }); }
  function extractBase64(value) { if (!value) return ""; if (String(value).startsWith("data:image") && String(value).includes(",")) return String(value).split(",", 2)[1]; return ""; }
  function normalizeImageResult(item) {
    if (!item) return "";
    if (item.url) return item.url;
    const raw = String(item.b64_json || item.base64 || "").trim();
    if (!raw) return "";
    if (raw.startsWith("data:image")) return raw;
    return `data:image/png;base64,${raw}`;
  }
  async function resolveImageToBase64(imageUrl) {
    if (!imageUrl) return "";
    const inline = extractBase64(imageUrl);
    if (inline) return inline;
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) return "";
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(extractBase64(String(reader.result || "")) || "");
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.warn("[canvas] 解析图片为base64失败", imageUrl, error);
      return "";
    }
  }
  function guessMimeTypeFromImageUrl(imageUrl) {
    const value = String(imageUrl || "");
    if (value.startsWith("data:image/") && value.includes(";base64,")) return value.slice(5, value.indexOf(";base64,"));
    if (/\.jpe?g($|\?)/i.test(value)) return "image/jpeg";
    if (/\.webp($|\?)/i.test(value)) return "image/webp";
    if (/\.gif($|\?)/i.test(value)) return "image/gif";
    return "image/png";
  }
  function makeId() { return `node_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  function normalizeAsset(asset) { return { ...asset, category: asset?.category || DEFAULT_ASSET_CATEGORY }; }
  function normalizeAssetLibrary() { STATE.assetLibrary = (STATE.assetLibrary || []).map(normalizeAsset); STATE.categories = [...new Set([DEFAULT_ASSET_CATEGORY, ...(STATE.categories || []), ...STATE.assetLibrary.map((item) => item.category || DEFAULT_ASSET_CATEGORY)])].sort((a, b) => a.localeCompare(b, "zh-CN")); }
  function getAssetCategories() { return [...new Set([...(STATE.categories || []), ...((STATE.assetLibrary || []).map((item) => item.category || DEFAULT_ASSET_CATEGORY)), DEFAULT_ASSET_CATEGORY])].sort((a, b) => a.localeCompare(b, "zh-CN")); }
  function getFilteredAssets() { return STATE.activeAssetCategory === "全部" ? STATE.assetLibrary : STATE.assetLibrary.filter((item) => (item.category || DEFAULT_ASSET_CATEGORY) === STATE.activeAssetCategory); }
  function createAssetCategory(source = "left") { return openCategoryModal("create"); }
  function escapeHtml(str = "") { return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;"); }

  // ── 提示词引用图占位符 ────────────────────────────
  // 内部存储格式：{{img:UPSTREAM_NODE_ID}}，渲染/发送时按 linkedImageNodes 顺序映射成"图片N"
  const PROMPT_REF_REGEX = /\{\{img:([A-Za-z0-9_\-:.]+)\}\}/g;
  function parsePromptTokens(text) {
    const source = String(text || ""); const tokens = []; let last = 0; let m;
    PROMPT_REF_REGEX.lastIndex = 0;
    while ((m = PROMPT_REF_REGEX.exec(source))) {
      if (m.index > last) tokens.push({ type: "text", value: source.slice(last, m.index) });
      tokens.push({ type: "ref", refId: m[1] });
      last = m.index + m[0].length;
    }
    if (last < source.length) tokens.push({ type: "text", value: source.slice(last) });
    return tokens;
  }
  function getSelfReferenceImage(node) {
    if (!node) return null;
    // 优先：节点已生成的输出图
    if (node.outputImages && node.outputImages[0]) {
      return { id: node.id, imageUrl: node.outputImages[0], imageBase64: extractBase64(node.outputImages[0]) || "", _self: true };
    }
    // 其次：上传的参考图
    if (node.imageUrl || node.imageBase64) {
      return { id: node.id, imageUrl: node.imageUrl || "", imageBase64: node.imageBase64 || extractBase64(node.imageUrl) || "", _self: true };
    }
    return null;
  }
  function buildPromptRefIndexMap(nodeId) {
    const node = getNode(nodeId);
    const linked = getLinkedImageNodes(nodeId);
    const map = new Map();
    const list = [...linked];
    linked.forEach((item, i) => { if (item && item.id) map.set(item.id, i + 1); });
    const selfRef = getSelfReferenceImage(node);
    if (selfRef) {
      const selfRefId = `self:${node.id}`;
      map.set(selfRefId, list.length + 1);
      list.push({ ...selfRef, id: selfRefId });
    }
    return { map, linked: list };
  }
  function serializePromptForApi(text, nodeId) {
    const { map } = buildPromptRefIndexMap(nodeId);
    return parsePromptTokens(text).map((t) => {
      if (t.type === "text") return t.value;
      const idx = map.get(t.refId);
      return idx ? `图片${idx}` : "";
    }).join("");
  }
  function pruneStalePromptRefs(text, nodeId) {
    const { map } = buildPromptRefIndexMap(nodeId);
    return parsePromptTokens(text).map((t) => {
      if (t.type === "text") return t.value;
      return map.has(t.refId) ? `{{img:${t.refId}}}` : "";
    }).join("");
  }
  function appendPromptRef(text, refId) {
    const base = String(text || "");
    const token = `{{img:${refId}}}`;
    if (base.includes(token)) return base;
    if (!base) return token;
    return /\s$/.test(base) ? base + token : base + " " + token;
  }
  function getRefThumbUrl(refNode) {
    if (!refNode) return "";
    if (refNode.outputAssetId && Array.isArray(STATE.assetLibrary)) {
      const a = STATE.assetLibrary.find((it) => it.id === refNode.outputAssetId);
      if (a && (a.imageUrl || a.displayImageUrl)) return a.imageUrl || a.displayImageUrl;
    }
    if (refNode.outputImages && refNode.outputImages[0]) return refNode.outputImages[0];
    if (refNode.imageUrl) return refNode.imageUrl;
    if (refNode.displayImageUrl) return refNode.displayImageUrl;
    return "";
  }
  function renderPromptChipHtml(refId, index, refNode) {
    const stale = !refNode ? "1" : "0";
    const thumb = getRefThumbUrl(refNode);
    const thumbHtml = thumb
      ? `<img class="chip-thumb" src="${escapeHtml(thumb)}" alt="" draggable="false">`
      : `<span class="chip-thumb-fallback"><i class="fa fa-image"></i></span>`;
    const label = refNode ? `图片${index}` : `图片?`;
    return `<span class="prompt-ref-chip" contenteditable="false" data-ref-id="${escapeHtml(refId)}" data-stale="${stale}"><span class="chip-label">${label}</span>${thumbHtml}</span>`;
  }
  function renderPromptHtmlForNode(node) {
    if (!node) return "";
    const { map, linked } = buildPromptRefIndexMap(node.id);
    const linkedById = new Map(linked.map((it) => [it.id, it]));
    return parsePromptTokens(node.prompt || "").map((t) => {
      if (t.type === "text") return escapeHtml(t.value).replace(/\n/g, "<br>");
      const idx = map.get(t.refId) || 0;
      return renderPromptChipHtml(t.refId, idx, linkedById.get(t.refId));
    }).join("");
  }
  function readPromptFromEditor(el) {
    if (!el) return "";
    let out = "";
    el.childNodes.forEach((node) => {
      out += readPromptNode(node);
    });
    // 折叠首尾换行毛刺
    return out.replace(/ /g, " ");
  }
  function readPromptNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    if (el.classList && el.classList.contains("prompt-ref-chip")) {
      const refId = el.getAttribute("data-ref-id") || "";
      return refId ? `{{img:${refId}}}` : "";
    }
    if (el.tagName === "BR") return "\n";
    if (el.tagName === "DIV" || el.tagName === "P") {
      let s = "";
      el.childNodes.forEach((c) => { s += readPromptNode(c); });
      return "\n" + s;
    }
    let s = "";
    el.childNodes.forEach((c) => { s += readPromptNode(c); });
    return s;
  }

  // ── @ 提及气泡 ────────────────────────────
  const PROMPT_MENTION_STATE = { editor: null, popup: null, items: [], activeIndex: 0, atRange: null, query: "" };
  function ensurePromptMentionPopup() {
    if (PROMPT_MENTION_STATE.popup) return PROMPT_MENTION_STATE.popup;
    const popup = document.createElement('div');
    popup.className = 'prompt-mention-popup';
    popup.style.display = 'none';
    document.body.appendChild(popup);
    popup.addEventListener('mousedown', (e) => { e.preventDefault(); });
    popup.addEventListener('click', (e) => {
      const item = e.target instanceof HTMLElement ? e.target.closest('.prompt-mention-item') : null;
      if (!item) return;
      const refId = item.getAttribute('data-ref-id') || '';
      if (refId) commitPromptMention(refId);
    });
    PROMPT_MENTION_STATE.popup = popup;
    return popup;
  }
  function hidePromptMention() {
    if (PROMPT_MENTION_STATE.popup) PROMPT_MENTION_STATE.popup.style.display = 'none';
    PROMPT_MENTION_STATE.editor = null;
    PROMPT_MENTION_STATE.atRange = null;
    PROMPT_MENTION_STATE.items = [];
    PROMPT_MENTION_STATE.query = "";
    PROMPT_MENTION_STATE.activeIndex = 0;
  }
  function findAtTriggerBeforeCaret(editor) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0).cloneRange();
    if (!editor.contains(range.endContainer)) return null;
    let container = range.endContainer;
    let offset = range.endOffset;
    if (container.nodeType !== Node.TEXT_NODE) {
      const childBefore = container.childNodes[offset - 1] || null;
      const textNode = findLastTextNodeWithin(childBefore) || findPrevTextNodeFromContainer(editor, container, offset);
      if (!textNode) return null;
      container = textNode;
      offset = (textNode.nodeValue || "").length;
    }
    const text = container.nodeValue || "";
    let i = offset - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        const query = text.slice(i + 1, offset);
        if (/[\s\n]/.test(query)) return null;
        const atRange = document.createRange();
        atRange.setStart(container, i);
        atRange.setEnd(container, offset);
        return { atRange, query };
      }
      if (/[\s\n]/.test(ch)) return null;
      i--;
    }
    return null;
  }
  function findLastTextNodeWithin(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return node;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const r = findLastTextNodeWithin(node.childNodes[i]);
      if (r) return r;
    }
    return null;
  }
  function findPrevTextNodeFromContainer(editor, container, offset) {
    // 在编辑器范围内倒序遍历找最近的 text 节点
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null);
    let last = null;
    let cur;
    const target = container.childNodes ? container.childNodes[offset] : null;
    while ((cur = walker.nextNode())) {
      if (target && (cur === target || (cur.compareDocumentPosition && (cur.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)))) break;
      last = cur;
    }
    return last;
  }
  function handlePromptMentionInput(editor) {
    const found = findAtTriggerBeforeCaret(editor);
    if (!found) { hidePromptMention(); return; }
    const nodeId = editor.getAttribute('data-node-id');
    const { linked } = buildPromptRefIndexMap(nodeId);
    if (!linked.length) { hidePromptMention(); return; }
    const q = (found.query || "").toLowerCase();
    const items = linked.map((ref, i) => ({ ref, index: i + 1 }))
      .filter(({ ref, index }) => {
        if (!q) return true;
        return String(index).includes(q) || `图片${index}`.includes(q) || `image${index}`.includes(q);
      });
    if (!items.length) { hidePromptMention(); return; }
    PROMPT_MENTION_STATE.editor = editor;
    PROMPT_MENTION_STATE.atRange = found.atRange;
    PROMPT_MENTION_STATE.query = found.query;
    PROMPT_MENTION_STATE.items = items;
    PROMPT_MENTION_STATE.activeIndex = 0;
    renderPromptMentionPopup();
  }
  function renderPromptMentionPopup() {
    const popup = ensurePromptMentionPopup();
    const { editor, items, activeIndex } = PROMPT_MENTION_STATE;
    if (!editor || !items.length) { popup.style.display = 'none'; return; }
    popup.innerHTML = items.map(({ ref, index }, i) => {
      const thumb = getRefThumbUrl(ref);
      const thumbHtml = thumb ? `<img src="${escapeHtml(thumb)}" alt="" draggable="false">` : `<span class="mi-fallback"><i class="fa fa-image"></i></span>`;
      return `<button type="button" class="prompt-mention-item ${i === activeIndex ? 'is-active' : ''}" data-ref-id="${escapeHtml(ref.id)}">${thumbHtml}<span class="mi-label">图片${index}</span></button>`;
    }).join('') || `<div class="prompt-mention-empty">没有匹配的引用图</div>`;
    const rect = editor.getBoundingClientRect();
    popup.style.display = 'flex';
    const popupRect = popup.getBoundingClientRect();
    let top = rect.bottom + 4;
    let left = rect.left;
    // 防止超出视口右侧
    if (left + popupRect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - popupRect.width - 8);
    // 若下方空间不足，弹到上方
    if (top + popupRect.height > window.innerHeight - 8) top = Math.max(8, rect.top - popupRect.height - 4);
    popup.style.top = `${top}px`;
    popup.style.left = `${left}px`;
  }
  function commitPromptMention(refId) {
    const { editor, atRange } = PROMPT_MENTION_STATE;
    if (!editor || !atRange) { hidePromptMention(); return; }
    const nodeId = editor.getAttribute('data-node-id');
    const node = getNode(nodeId);
    if (!node) { hidePromptMention(); return; }
    const { map, linked } = buildPromptRefIndexMap(nodeId);
    const linkedById = new Map(linked.map((it) => [it.id, it]));
    const idx = map.get(refId) || 0;
    const ref = linkedById.get(refId);
    // 删除"@xxx"文本
    atRange.deleteContents();
    // 插入 chip
    const tmp = document.createElement('div');
    tmp.innerHTML = renderPromptChipHtml(refId, idx, ref);
    const chip = tmp.firstElementChild;
    if (chip) {
      atRange.insertNode(chip);
      // 在 chip 后插入空格，光标定位其后
      const spaceNode = document.createTextNode(' ');
      chip.parentNode.insertBefore(spaceNode, chip.nextSibling);
      const sel = window.getSelection();
      const newRange = document.createRange();
      newRange.setStart(spaceNode, spaceNode.nodeValue.length);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);
    }
    // 同步 state
    pushUndoSnapshot();
    const value = readPromptFromEditor(editor);
    updateNodeField(nodeId, 'prompt', value, { rerender: false });
    hidePromptMention();
  }
  function handlePromptChipDeleteKey(editor, isBackspace) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return false;
    if (!range.collapsed) return false;
    const chip = isBackspace ? findChipBeforeCaret(editor, range) : findChipAfterCaret(editor, range);
    if (!chip) return false;
    const parent = chip.parentNode;
    const nextSibling = chip.nextSibling;
    parent.removeChild(chip);
    // 重置光标
    const newRange = document.createRange();
    if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
      newRange.setStart(nextSibling, 0);
    } else if (nextSibling) {
      newRange.setStartBefore(nextSibling);
    } else {
      newRange.selectNodeContents(parent);
      newRange.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(newRange);
    // 同步 state
    pushUndoSnapshot();
    const nodeId = editor.getAttribute('data-node-id');
    const value = readPromptFromEditor(editor);
    updateNodeField(nodeId, 'prompt', value, { rerender: false });
    return true;
  }
  function findChipBeforeCaret(editor, range) {
    let container = range.startContainer;
    let offset = range.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
      // 光标前紧邻 chip：要么 offset==0（前面只能是兄弟节点）；
      // 要么 offset==1 且 textNode 内容是单个空格/NBSP（chip 后追加的隔离空格）
      if (offset === 0) {
        const prev = container.previousSibling;
        return isChipNode(prev) ? prev : null;
      }
      const text = container.nodeValue || "";
      if (offset === 1 && /^[\s ]$/.test(text)) {
        const prev = container.previousSibling;
        return isChipNode(prev) ? prev : null;
      }
      return null;
    }
    if (container.nodeType === Node.ELEMENT_NODE) {
      const before = container.childNodes[offset - 1] || null;
      return isChipNode(before) ? before : null;
    }
    return null;
  }
  function findChipAfterCaret(editor, range) {
    let container = range.startContainer;
    let offset = range.startOffset;
    if (container.nodeType === Node.TEXT_NODE) {
      const text = container.nodeValue || "";
      if (offset >= text.length) {
        const next = container.nextSibling;
        return isChipNode(next) ? next : null;
      }
      return null;
    }
    if (container.nodeType === Node.ELEMENT_NODE) {
      const next = container.childNodes[offset] || null;
      return isChipNode(next) ? next : null;
    }
    return null;
  }
  function isChipNode(node) {
    return node && node.nodeType === Node.ELEMENT_NODE && node.classList && node.classList.contains('prompt-ref-chip');
  }
  function handlePromptMentionKeydown(event) {
    if (!PROMPT_MENTION_STATE.editor || !PROMPT_MENTION_STATE.items.length) return false;
    const items = PROMPT_MENTION_STATE.items;
    if (event.key === 'ArrowDown') {
      PROMPT_MENTION_STATE.activeIndex = (PROMPT_MENTION_STATE.activeIndex + 1) % items.length;
      renderPromptMentionPopup();
      event.preventDefault();
      return true;
    }
    if (event.key === 'ArrowUp') {
      PROMPT_MENTION_STATE.activeIndex = (PROMPT_MENTION_STATE.activeIndex - 1 + items.length) % items.length;
      renderPromptMentionPopup();
      event.preventDefault();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const sel = items[PROMPT_MENTION_STATE.activeIndex] || items[0];
      if (sel) commitPromptMention(sel.ref.id);
      event.preventDefault();
      return true;
    }
    if (event.key === 'Escape') {
      hidePromptMention();
      event.preventDefault();
      return true;
    }
    return false;
  }

  let __canvasToastTimer = null;
  function showToast(message) {
    const el = document.getElementById('canvas-toast');
    if (!el) return;
    el.textContent = message || '操作成功';
    el.classList.add('show');
    if (__canvasToastTimer) clearTimeout(__canvasToastTimer);
    __canvasToastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 1000);
  }

})();
