(function () {
  const SIZE_PRESETS = ["1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"];
  const DEFAULT_NEGATIVE_PROMPT = "low quality, blurry, distorted, bad anatomy, extra fingers, watermark, text, cropped, artifacts";
  const NODE_WIDTH = 360;
  const PORT_RADIUS = 11;
  const SNAP_DISTANCE = 86;
  const MIN_ZOOM = 0.45;
  const MAX_ZOOM = 1.8;
  const DEFAULT_ASSET_CATEGORY = "未分类";

  const STATE = {
    initialized: false,
    nodes: [],
    edges: [],
    selectedNodeId: null,
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
    const style = document.createElement("style");
    style.id = "image-canvas-style";
    style.textContent = `
      #image{height:calc(100vh - 64px);overflow:hidden}
      .canvas-shell{display:flex;height:100%;background:#0b1020;color:#e5e7eb}.canvas-left{width:320px;border-right:1px solid rgba(148,163,184,.18);background:#0f172a;padding:16px;display:flex;flex-direction:column;gap:14px;overflow:hidden}
      .canvas-title{font-size:18px;font-weight:800;color:#fff}.canvas-subtitle{font-size:12px;color:#94a3b8;line-height:1.6}.canvas-panel{border:1px solid rgba(148,163,184,.12);background:rgba(15,23,42,.78);border-radius:16px;padding:14px;min-height:0;display:flex;flex-direction:column}
      .canvas-panel-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.canvas-panel-title{font-size:14px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px}.canvas-panel-subtitle{font-size:12px;color:#94a3b8;line-height:1.6;margin-bottom:10px}
      .canvas-library-toolbar{display:grid;gap:8px;margin-bottom:10px}.canvas-library-toolbar .form-select,.canvas-library-toolbar .form-input{background:#0b1220;border:1px solid rgba(148,163,184,.18);color:#fff}.canvas-library-list,.canvas-history-list{display:flex;flex-direction:column;gap:10px;overflow:auto;min-height:0}
      .canvas-library-item,.canvas-history-item{border:1px solid rgba(148,163,184,.12);border-radius:14px;background:#111827;transition:all .2s ease}.canvas-library-item:hover,.canvas-history-item:hover{border-color:rgba(96,165,250,.28);transform:translateY(-1px)}
      .canvas-library-thumb{width:100%;aspect-ratio:1.35/1;object-fit:cover;display:block;background:#0b1220;border-top-left-radius:14px;border-top-right-radius:14px}.canvas-library-body,.canvas-history-body{padding:10px 12px;display:grid;gap:6px}.canvas-item-title{font-size:13px;font-weight:700;color:#e5e7eb}
      .canvas-item-meta{font-size:12px;color:#94a3b8}.canvas-item-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}.canvas-item-actions .btn{padding:8px 12px;font-size:12px}.canvas-history-item.active{border-color:#60a5fa;box-shadow:0 0 0 1px rgba(96,165,250,.18)}
      .canvas-empty-card{border:1px dashed rgba(148,163,184,.18);border-radius:14px;padding:16px;text-align:center;color:#94a3b8;font-size:12px;line-height:1.7;background:rgba(15,23,42,.5)}.canvas-main{flex:1;display:flex;flex-direction:column;min-width:0}
      .canvas-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;background:#111827;border-bottom:1px solid rgba(148,163,184,.14)}.canvas-topbar .left,.canvas-topbar .right{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.canvas-topbar .badge{font-size:12px;padding:6px 10px;border-radius:999px;background:rgba(59,130,246,.16);color:#bfdbfe;border:1px solid rgba(96,165,250,.22)}
      .canvas-board-wrap{position:relative;flex:1;overflow:hidden;background:radial-gradient(circle at 1px 1px, rgba(148,163,184,.16) 1px, transparent 0) 0 0/24px 24px,linear-gradient(180deg,#0b1020,#0a0f1b)}.canvas-board{position:absolute;inset:0;overflow:hidden;cursor:grab;user-select:none}.canvas-board.panning{cursor:grabbing}.canvas-world{position:absolute;left:0;top:0;transform-origin:0 0;width:5000px;height:3600px;will-change:transform}
      .canvas-selection-box{position:absolute;border:1px solid rgba(96,165,250,.95);background:rgba(96,165,250,.14);pointer-events:none;z-index:25;border-radius:10px}.node.multi-selected{box-shadow:0 0 0 2px rgba(96,165,250,.95),0 24px 70px rgba(15,23,42,.55)}
      .asset-library-modal.hidden{display:none}.asset-library-modal{position:fixed;inset:0;z-index:1600}.asset-library-backdrop{position:absolute;inset:0;background:rgba(2,6,23,.7);backdrop-filter:blur(4px)}.asset-library-panel{position:relative;width:min(1100px,calc(100vw - 48px));height:min(760px,calc(100vh - 48px));margin:24px auto;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:20px;box-shadow:0 30px 80px rgba(0,0,0,.45);display:grid;grid-template-columns:280px 1fr;overflow:hidden}.asset-library-panel.draggable{cursor:default}.asset-library-sidebar{padding:18px;border-right:1px solid rgba(148,163,184,.14);display:flex;flex-direction:column;gap:12px;background:#111827;min-height:0}.asset-library-content{padding:18px;display:flex;flex-direction:column;gap:14px;min-width:0;min-height:0}.asset-folder-list,.asset-grid{display:grid;gap:10px;overflow:auto}.asset-folder-list{flex:1;min-height:0;padding-right:4px}.asset-grid{grid-template-columns:repeat(auto-fill,minmax(200px,1fr));flex:1;min-height:0;align-content:start;padding-right:4px}.asset-card{border:1px solid rgba(148,163,184,.12);border-radius:16px;overflow:hidden;background:#111827}.asset-card img{width:100%;aspect-ratio:1.2/1;object-fit:cover;background:#0b1220}.asset-card-body{padding:12px;display:grid;gap:8px}.asset-modal-header{display:flex;align-items:center;justify-content:space-between;gap:12px}.asset-modal-header.drag-handle{cursor:move;user-select:none;padding-bottom:4px;border-bottom:1px solid rgba(148,163,184,.1)}.asset-folder-actions{display:flex;gap:6px;align-items:center}.asset-folder-actions .btn{padding:6px 10px;font-size:12px}.asset-modal-actions{display:flex;gap:8px;flex-wrap:wrap}
      .canvas-debug{position:absolute;right:14px;bottom:14px;z-index:30;min-width:260px;max-width:360px;padding:10px 12px;border-radius:14px;background:rgba(2,6,23,.82);border:1px solid rgba(148,163,184,.22);box-shadow:0 14px 36px rgba(0,0,0,.35);font-size:12px;line-height:1.55;color:#cbd5e1;backdrop-filter:blur(8px)}.canvas-debug strong{color:#fff}.canvas-debug code{color:#93c5fd;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
      .canvas-svg{position:absolute;left:0;top:0;width:5000px;height:3600px;overflow:visible;z-index:1;pointer-events:none}.edge-hit{stroke:transparent;stroke-width:28;fill:none;pointer-events:none;cursor:pointer}.edge-visible{fill:none;stroke-linecap:round;pointer-events:none}.edge-selected{stroke:#f59e0b!important}.canvas-node-layer{position:absolute;left:0;top:0;width:5000px;height:3600px;z-index:3}.edge-dom-layer{position:absolute;left:0;top:0;width:5000px;height:3600px;z-index:2;pointer-events:none}.edge-dom-hit{position:absolute;height:28px;transform-origin:left center;pointer-events:auto;cursor:pointer;background:transparent}.edge-dom-hit.edge-selected{outline:2px solid rgba(245,158,11,.95);outline-offset:0;border-radius:999px}
      .node{position:absolute;width:${NODE_WIDTH}px;background:#111827;border:1px solid rgba(148,163,184,.16);border-radius:22px;box-shadow:0 18px 40px rgba(0,0,0,.28);overflow:visible}.node.selected{border-color:#60a5fa;box-shadow:0 0 0 2px rgba(96,165,250,.55),0 0 0 8px rgba(59,130,246,.14),0 22px 48px rgba(0,0,0,.38)}.node-link-highlight{border-color:rgba(52,211,153,.75)!important;box-shadow:0 0 0 1px rgba(52,211,153,.18),0 18px 40px rgba(0,0,0,.32)!important}
      .node-shell{position:relative;border-radius:22px;overflow:hidden;background:#111827}.node-image-wrap{position:relative;background:#0b1220;min-height:240px;display:flex;align-items:center;justify-content:center;cursor:move}.node-image-wrap img{width:100%;height:100%;display:block;object-fit:cover;cursor:default}
      .node-image-overlay{position:absolute;inset:0;background:linear-gradient(to top, rgba(2,6,23,.62), rgba(2,6,23,.12) 45%, rgba(2,6,23,0));display:flex;align-items:flex-end;justify-content:flex-end;padding:12px;opacity:0;transition:opacity .18s ease;pointer-events:none}.node-image-top-actions{position:absolute;top:10px;right:10px;display:flex;gap:8px;opacity:0;transition:opacity .18s ease;z-index:4}
      .node-image-wrap:hover .node-image-overlay,.node-image-wrap:hover .node-image-top-actions,.output-card:hover .node-image-overlay{opacity:1}.node-image-toolbar{display:flex;gap:8px;pointer-events:auto}.node-image-toolbar .btn,.node-image-top-actions .btn{padding:8px 12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(6px)}
      .node-image-empty{padding:18px;text-align:center;color:#64748b;line-height:1.7;font-size:13px}.node-image-actions{position:absolute;left:12px;right:12px;bottom:12px;display:flex;gap:8px;flex-wrap:wrap;z-index:3}.node-image-actions .btn{flex:1;min-width:110px;justify-content:center;cursor:pointer}
      .node-linked-banner{position:absolute;left:12px;right:12px;top:12px;padding:10px 12px;border-radius:12px;background:rgba(15,23,42,.82);border:1px solid rgba(52,211,153,.24);color:#d1fae5;font-size:12px;backdrop-filter:blur(4px);z-index:3}
      .node-divider{height:1px;background:rgba(148,163,184,.14)}.node-body{padding:14px 16px 16px;display:grid;gap:12px}.node-row{display:grid;gap:8px}.node-body label{display:block;font-size:12px;color:#94a3b8;margin-bottom:4px}
      .node-body input,.node-body textarea,.node-body select{width:100%;border:1px solid rgba(148,163,184,.16);background:#0f172a;color:#fff;border-radius:12px;padding:10px 12px;outline:none;pointer-events:auto;cursor:text}.node-body textarea{resize:vertical;min-height:92px;user-select:text}.node-body select{cursor:pointer}
      .node-body input,.node-body textarea,.node-body select,.node-body button,.node-image-actions button,.node-image-actions a,.output-card-actions a,.output-card-actions button,.node-image-toolbar button{position:relative;z-index:3}.node-mini-row{display:grid;grid-template-columns:1.1fr .9fr 1fr;gap:8px}.node-mini-field{display:grid;gap:4px}.node-mini-field label{font-size:11px;margin-bottom:0}.node-mini-field select,.node-mini-field input{padding:9px 10px;font-size:12px;border-radius:12px}
      .node-actions{display:flex;gap:8px;flex-wrap:wrap}.node-actions button{flex:1;min-width:120px;cursor:pointer}.output-gallery{display:grid;grid-template-columns:1fr 1fr;gap:10px}.output-card{position:relative;border:1px solid rgba(148,163,184,.14);border-radius:14px;overflow:hidden;background:#0b1220}.output-card img{width:100%;display:block;aspect-ratio:1/1;object-fit:cover;cursor:default}
      .output-card-actions{display:flex;gap:8px;padding:10px;flex-wrap:wrap}.output-card-actions a,.output-card-actions button{flex:1;text-align:center;text-decoration:none}.port-handle{position:absolute;width:${PORT_RADIUS * 2}px;height:${PORT_RADIUS * 2}px;border-radius:999px;background:#111827;border:2px solid #34d399;box-shadow:0 0 0 4px rgba(52,211,153,.12);cursor:crosshair;z-index:5}
      .canvas-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#94a3b8;font-size:14px;text-align:center;line-height:1.8}.canvas-context-menu{position:absolute;z-index:60;min-width:180px;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:14px;box-shadow:0 18px 45px rgba(0,0,0,.35);padding:8px}.canvas-context-menu button{width:100%;background:transparent;border:none;color:#e5e7eb;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:13px}.canvas-context-menu button:hover{background:rgba(30,41,59,.95)}
      .image-preview-modal{position:fixed;inset:0;background:rgba(2,6,23,.82);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px}.image-preview-modal.hidden{display:none}.image-preview-backdrop{position:absolute;inset:0}.image-preview-panel{position:relative;z-index:1;max-width:min(92vw,1400px);max-height:92vh}.image-preview-panel img{max-width:100%;max-height:92vh;display:block;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.45)}.image-preview-close{position:absolute;top:-14px;right:-14px;width:40px;height:40px;border:none;border-radius:999px;background:#111827;color:#fff;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.35)}
      @media (max-width:1100px){.canvas-left{display:none}.node{width:320px}.output-gallery{grid-template-columns:1fr}.node-mini-row{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function buildImageWorkbench() {
    const tab = document.getElementById("image");
    if (!tab) return;
    tab.innerHTML = `
      <div class="canvas-shell">
        <aside class="canvas-left">
          <div><div class="canvas-title">无限画布</div><div class="canvas-subtitle">左侧只保留功能和历史会话。双击画布、右键或直接粘贴图片来创建节点。</div></div>
          <section class="canvas-panel" style="flex:1.1;"><div class="canvas-panel-header"><div class="canvas-panel-title"><i class="fa fa-folder-open-o"></i> 素材库</div></div><div class="canvas-panel-subtitle">素材库已独立到上方「素材库」标签页。</div><div class="canvas-library-list custom-scrollbar" id="canvas-library-list"></div></section>
          <section class="canvas-panel" style="flex:0.9;"><div class="canvas-panel-header"><div class="canvas-panel-title"><i class="fa fa-history"></i> 历史会话记录</div><button class="btn btn-default" id="new-canvas-session-btn">新建</button></div><div class="canvas-panel-subtitle">所有画布记录都会保存到本地文件。</div><div class="canvas-history-list custom-scrollbar" id="canvas-history-list"></div></section>
        </aside>
        <section class="canvas-main">
          <div class="canvas-topbar"><div class="left"><span class="badge">双击创建节点</span><span class="badge">滚轮缩放</span><span class="badge">Ctrl+C / Ctrl+V / Delete</span></div><div class="right"><button class="btn btn-default" id="quick-add-node-btn">新建节点</button><span class="badge" id="canvas-zoom-badge">100%</span><button class="btn btn-default" id="reset-canvas-btn">清空画布</button></div></div>
          <div class="canvas-board-wrap" id="canvas-board-wrap"><div class="canvas-board" id="canvas-board"><div class="canvas-world" id="canvas-world"><svg class="canvas-svg" id="canvas-svg"></svg><div id="edge-dom-layer" class="edge-dom-layer"></div><div id="canvas-node-layer" class="canvas-node-layer"></div></div><div class="canvas-empty" id="canvas-empty-tip">双击画布、右键画布或直接粘贴图片来创建节点</div><div class="canvas-selection-box" id="canvas-selection-box" style="display:none"></div></div><div id="canvas-context-menu-root"></div></div>
        </section>
      </div>
      <div class="image-preview-modal hidden" id="image-preview-modal"><div class="image-preview-backdrop" data-close-preview="1"></div><div class="image-preview-panel"><button class="image-preview-close" type="button" data-close-preview="1">×</button><img id="image-preview-target" src="" alt="preview"></div></div>
      <div class="asset-library-modal hidden" id="asset-library-modal"><div class="asset-library-backdrop" data-close-asset-library="1"></div><div class="asset-library-panel draggable" id="asset-library-panel"><aside class="asset-library-sidebar"><div class="asset-modal-header drag-handle" data-drag-asset-library="1"><div><div class="canvas-title" style="font-size:16px;">素材库</div><div class="canvas-subtitle">按分类浏览素材，加入画布并管理分类。</div></div><button class="btn btn-default" type="button" data-close-asset-library="1">关闭</button></div><div class="canvas-library-toolbar"><select class="form-select" id="asset-category-filter-modal"></select><button class="btn btn-default" id="create-asset-category-btn-modal">新建分类</button></div><div class="asset-folder-list custom-scrollbar" id="asset-folder-list"></div></aside><section class="asset-library-content"><div class="asset-modal-header"><div><div class="canvas-title" style="font-size:16px;">素材内容</div><div class="canvas-subtitle" id="asset-library-current-folder">选择一个分类查看素材</div></div><div class="asset-modal-actions"><button class="btn btn-danger" type="button" id="delete-current-asset-category-btn">删除当前分类</button><button class="btn btn-default" type="button" data-close-asset-library="1">完成</button></div></div><div class="asset-grid custom-scrollbar" id="asset-library-grid"></div></section></div></div><div class="asset-library-modal hidden" id="asset-category-modal"><div class="asset-library-backdrop" data-close-category-modal="1"></div><div class="asset-library-panel" style="grid-template-columns:1fr;max-width:520px;height:auto;"><section class="asset-library-content"><div class="asset-modal-header"><div><div class="canvas-title" style="font-size:16px;" id="asset-category-modal-title">新建分类</div><div class="canvas-subtitle" id="asset-category-modal-subtitle">填写分类名称并确认。</div></div><button class="btn btn-default" type="button" data-close-category-modal="1">关闭</button></div><div class="canvas-library-toolbar" style="display:grid;gap:12px;"><input class="form-input" id="asset-category-modal-input" placeholder="输入分类名称"><select class="form-select" id="asset-category-modal-select"></select></div><div class="asset-modal-actions"><button class="btn btn-default" type="button" data-close-category-modal="1">取消</button><button class="btn btn-primary" type="button" id="confirm-asset-category-modal-btn">确认</button></div></section></div></div>`;
  }

  function bindWorkbenchEvents() {
    const root = document.getElementById("image");
    const board = document.getElementById("canvas-board");
    if (!root || !board) return;
    if (root.dataset.canvasBound !== "1") {
      root.dataset.canvasBound = "1";

      root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("#reset-canvas-btn")) return resetCanvas();
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

      const edgeHit = target.closest("[data-edge-id]");
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
      const contextPreview = target.closest("[data-context-preview]");
      if (contextPreview) return openImagePreview(contextPreview.getAttribute("data-context-preview"));
      const contextSave = target.closest("[data-context-save-library]");
      if (contextSave) return saveImageUrlToLibrary(contextSave.getAttribute("data-context-save-library"), contextSave.getAttribute("data-image-title") || "图片素材");

      const nodeEl = target.closest(".node");
      if (nodeEl && !target.closest("textarea, input, select, button, a")) {
        STATE.selectedNodeId = nodeEl.getAttribute("data-node-id");
        STATE.selectedEdgeId = null;
        renderCanvas();
        return;
      }

      if (target.closest("#asset-library-modal, #asset-category-modal")) {
        return;
      }

      if (!target.closest("textarea, input, select, button, a, .canvas-context-menu")) {
        hideContextMenu();
        STATE.selectedNodeId = null;
        STATE.selectedEdgeId = null;
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

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches("textarea[data-field], input[data-field]")) {
        const field = target.getAttribute("data-field");
        let value = target.value;
        if (field === "count") value = Math.max(1, Math.min(4, Number(value || 1)));
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

    board.addEventListener("contextmenu", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const imageEl = target.closest("[data-context-image]");
      if (imageEl) {
        event.preventDefault();
        showImageContextMenu(event.clientX, event.clientY, imageEl.getAttribute("data-context-image"), imageEl.getAttribute("data-image-title") || "图片素材");
        return;
      }
      const edgeHit = target.closest("[data-edge-id]");
      if (edgeHit) {
        event.preventDefault();
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
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("textarea, input, select, a, .canvas-context-menu")) { event.stopPropagation(); return; }
      const actionBtn = target.closest("button");
      if (actionBtn) {
        event.stopPropagation();
        return;
      }
      const edgeHit = target.closest("[data-edge-id]");
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
        const point = clientToCanvasPoint(event.clientX, event.clientY);
        STATE.draggingNodeId = node.id;
        STATE.dragMoved = false;
        STATE.dragOffsetX = point.x - node.x;
        STATE.dragOffsetY = point.y - node.y;
        if (!STATE.selectedNodeIds.includes(node.id)) STATE.selectedNodeIds = [node.id];
        STATE.selectedNodeId = node.id;
        STATE.selectedEdgeId = null;
        hideContextMenu(false);
        return;
      }
      const board = target.closest("#canvas-board");
      if (board && event.button === 1) {
        event.preventDefault();
        STATE.panning = true;
        STATE.panStartX = event.clientX - STATE.panX;
        STATE.panStartY = event.clientY - STATE.panY;
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
        node.x = point.x - STATE.dragOffsetX;
        node.y = point.y - STATE.dragOffsetY;
        STATE.dragMoved = true;
        updateDraggedNodePosition(node);
        requestCanvasOverlayRefresh();
        persistCurrentHistory();
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
        const world = document.getElementById("canvas-world");
        if (world) world.style.transform = `translate(${STATE.panX}px, ${STATE.panY}px) scale(${STATE.zoom})`;
        const zoomBadge = document.getElementById("canvas-zoom-badge");
        if (zoomBadge) zoomBadge.textContent = `${Math.round(STATE.zoom * 100)}%`;
        return;
      }
      if (STATE.connectionDrag) updateConnectionDrag(event.clientX, event.clientY);
    });

    window.addEventListener("mouseup", (event) => {
      if (STATE.assetLibraryDrag.active) {
        STATE.assetLibraryDrag.active = false;
        return;
      }
      if (STATE.draggingNodeId) { STATE.draggingNodeId = null; STATE.dragFramePending = false; renderCanvas(); persistCanvasState(); }
      if (STATE.selectionBox) {
        hideSelectionBox();
        if (STATE.selectedNodeIds.length === 1) STATE.selectedNodeId = STATE.selectedNodeIds[0];
        STATE.selectionBox = null;
        renderCanvas();
      }
      if (STATE.panning) {
        STATE.panning = false;
        document.getElementById("canvas-board")?.classList.remove("panning");
        persistCurrentHistory();
        persistCanvasState();
      }
      if (STATE.connectionDrag) finishConnectionDrag(event.clientX, event.clientY);
    });

    const wheelBoard = document.getElementById("canvas-board");
    if (wheelBoard) {
      wheelBoard.addEventListener("wheel", (event) => {
        event.preventDefault();
        const delta = event.deltaY > 0 ? -0.08 : 0.08;
        applyZoom(STATE.zoom + delta, event.clientX, event.clientY);
      }, { passive: false });
    }

    document.addEventListener("keydown", (event) => {
      const active = document.activeElement;
      const typing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
      const inImageTab = document.getElementById("image")?.classList.contains("active");
      const meta = event.ctrlKey || event.metaKey;
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
      if (meta && event.key.toLowerCase() === "c" && STATE.selectedNodeId && !typing) {
        const node = getNode(STATE.selectedNodeId);
        if (node) STATE.clipboardNode = JSON.parse(JSON.stringify(node));
        event.preventDefault();
      }
      if (meta && event.key.toLowerCase() === "v" && !typing && STATE.clipboardNode) {
        const copy = JSON.parse(JSON.stringify(STATE.clipboardNode));
        copy.id = makeId(); copy.x += 40; copy.y += 40; copy.outputImages = [...(copy.outputImages || [])];
        STATE.nodes.push(copy); STATE.selectedNodeId = copy.id; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); event.preventDefault();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !typing && inImageTab) {
        if (STATE.selectedEdgeId) { deleteEdge(STATE.selectedEdgeId); event.preventDefault(); return; }
        if (STATE.selectedNodeIds.length) { deleteSelectedNodes(); event.preventDefault(); return; }
        if (STATE.selectedNodeId) { deleteNode(STATE.selectedNodeId); event.preventDefault(); }
      }
    });

    document.addEventListener("paste", async (event) => {
      const active = document.activeElement;
      if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return;
      const items = event.clipboardData?.items || [];
      for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (!file) continue;
          event.preventDefault();
          const point = STATE.contextMenu.canvasPoint || clientToCanvasPoint(window.innerWidth / 2, window.innerHeight / 2);
          const node = createNode(point.x, point.y);
          STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; renderCanvas();
          await loadImageToNode(node.id, file);
          break;
        }
      }
    });
  }

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
  function resetCanvas() { STATE.nodes = []; STATE.edges = []; STATE.selectedNodeId = null; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function addNodeAt(x, y) { const node = createNode(x, y); STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function createNode(x, y) { return { id: makeId(), x: Math.round(x), y: Math.round(y), prompt: "", negativePrompt: DEFAULT_NEGATIVE_PROMPT, size: SIZE_PRESETS[0], count: 1, modelId: getDefaultImageConfigId(), imageUrl: "", imageBase64: "", assetId: "", outputImages: [], busy: false }; }
  function getDefaultImageConfigId() { const list = (window.GLOBAL?.configList || []).filter((item) => ["image", "both"].includes(item.config_type)); return list[0]?.id || ""; }
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
  function updateDraggedNodePosition(node) {
    const el = document.querySelector(`.node[data-node-id="${node.id}"]`);
    if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
  }
  function requestCanvasOverlayRefresh() {
    if (STATE.dragFramePending) return;
    STATE.dragFramePending = true;
    requestAnimationFrame(() => {
      STATE.dragFramePending = false;
      const svg = document.getElementById("canvas-svg");
      const edgeDomLayer = document.getElementById("edge-dom-layer");
      if (svg) svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
      if (edgeDomLayer) edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
      syncMeasuredPorts();
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
    STATE.nodes = STATE.nodes.filter((node) => !ids.has(node.id));
    STATE.edges = STATE.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
    STATE.selectedNodeIds = [];
    STATE.selectedNodeId = null;
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
  }
  function updateNodeField(nodeId, field, value, options = {}) { const node = getNode(nodeId); if (!node) return; node[field] = value; persistCurrentHistory(); if (options.rerender !== false) renderCanvas(); persistCanvasState(); }
  function deleteNode(nodeId) { STATE.nodes = STATE.nodes.filter((node) => node.id !== nodeId); STATE.edges = STATE.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId); if (STATE.selectedNodeId === nodeId) STATE.selectedNodeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function deleteEdge(edgeId) { STATE.edges = STATE.edges.filter((edge) => edge.id !== edgeId); if (STATE.selectedEdgeId === edgeId) STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); }

  async function loadImageToNode(nodeId, file) {
    const base64Payload = await fileToBase64(file);
    const node = getNode(nodeId);
    if (!node) return;
    node.imageUrl = base64Payload.dataUrl; node.imageBase64 = base64Payload.base64; renderCanvas();
    const asset = await saveAssetFile({ title: file.name || "粘贴图片", source: "素材库", category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY, mime_type: file.type || "image/png", image_base64: base64Payload.base64 });
    if (asset) { node.assetId = asset.id; node.imageUrl = asset.imageUrl || node.imageUrl; mergeAssetIntoLibrary(asset); }
    persistCanvasState(); renderCanvas(); renderLeftPanel();
  }

  async function selectCategoryForSave() { return Promise.resolve(STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY); }

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
    const category = await selectCategoryForSave();
    if (!category) return;
    const asset = await saveAssetFile({ title, source: "手动保存", category, mime_type: guessMimeTypeFromImageUrl(imageUrl), image_base64: base64 });
    if (asset) { mergeAssetIntoLibrary(asset); renderLeftPanel(); persistCanvasState(); }
  }

  function beginConnectionDrag(nodeId, clientX, clientY) {
    const node = getNode(nodeId); if (!node) return;
    STATE.connectionDrag = { fromNodeId: nodeId, start: getPortPosition(node, "output"), current: clientToCanvasPoint(clientX, clientY), targetNodeId: null };
    renderCanvas();
  }
  function updateConnectionDrag(clientX, clientY) { if (!STATE.connectionDrag) return; const point = clientToCanvasPoint(clientX, clientY); STATE.connectionDrag.current = point; const nearest = findNearestInputPort(point, STATE.connectionDrag.fromNodeId); STATE.connectionDrag.targetNodeId = nearest ? nearest.nodeId : null; renderCanvas(); }
  function finishConnectionDrag(clientX, clientY) { if (!STATE.connectionDrag) return; updateConnectionDrag(clientX, clientY); const fromNodeId = STATE.connectionDrag.fromNodeId; let targetNodeId = STATE.connectionDrag.targetNodeId; const releasePoint = clientToCanvasPoint(clientX, clientY); if (!targetNodeId) { const newNode = createNode(releasePoint.x, releasePoint.y - 120); STATE.nodes.push(newNode); targetNodeId = newNode.id; } if (targetNodeId && targetNodeId !== fromNodeId) { const exists = STATE.edges.some((edge) => edge.from === fromNodeId && edge.to === targetNodeId); if (!exists) STATE.edges.push({ id: makeId(), from: fromNodeId, to: targetNodeId }); STATE.selectedNodeId = targetNodeId; STATE.selectedEdgeId = null; persistCanvasState(); } STATE.connectionDrag = null; renderCanvas(); renderLeftPanel(); }
  function findNearestInputPort(point, excludeNodeId) { let best = null; for (const node of STATE.nodes) { if (node.id === excludeNodeId) continue; const port = getPortPosition(node, "input"); const distance = Math.hypot(point.x - port.x, point.y - port.y); if (distance <= SNAP_DISTANCE && (!best || distance < best.distance)) best = { nodeId: node.id, distance }; } return best; }
  function getLinkedImageNodes(nodeId) {
    return STATE.edges
      .filter((item) => item.to === nodeId)
      .map((edge) => getNode(edge.from))
      .filter(Boolean)
      .map((upstream) => {
        if (upstream.outputImages && upstream.outputImages[0]) return { ...upstream, imageUrl: upstream.outputImages[0], imageBase64: extractBase64(upstream.outputImages[0]) || upstream.imageBase64 || "" };
        if (upstream.imageUrl) return upstream;
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
    if (!node.prompt?.trim()) { console.log("[生成] 提示词为空，弹出alert"); return alert("请先输入提示词"); }
    if (!node.modelId) { console.log("[生成] modelId为空，弹出alert"); return alert("请先配置图片模型"); }
    node.busy = true;
    renderCanvas();
    const [width, height] = String(node.size || SIZE_PRESETS[0]).split("x").map((n) => Number(n || 1024));
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const refImages = [...linkedImageNodes.map((item) => item.imageBase64 || extractBase64(item.imageUrl)).filter(Boolean), ...(node.imageBase64 ? [node.imageBase64] : [])];
    const refImage = refImages[0] || "";
    try {
      console.log("[生成] 发起请求到 /api/image/generate, config_id:", node.modelId, "prompt:", node.prompt.slice(0, 60));
      const res = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config_id: node.modelId, prompt: node.prompt, negative_prompt: node.negativePrompt || DEFAULT_NEGATIVE_PROMPT, width, height, image_base64: refImage || null, image_base64_list: refImages, n: Number(node.count || 1) }),
      });
      console.log("[生成] 响应状态:", res.status);
      const result = await res.json();
      if (!res.ok || result.code !== 0) throw new Error(result.detail || result.message || "生成失败");
      node.outputImages = (result.data || []).map((item) => normalizeImageResult(item)).filter(Boolean);
      persistCanvasState();
    } catch (error) {
      alert(error.message || "生成失败");
    } finally {
      node.busy = false;
      renderCanvas();
      renderLeftPanel();
    }
  }

  function renderCanvas() {
    const world = document.getElementById("canvas-world"), nodeLayer = document.getElementById("canvas-node-layer"), edgeDomLayer = document.getElementById("edge-dom-layer"), svg = document.getElementById("canvas-svg"), empty = document.getElementById("canvas-empty-tip"), menuRoot = document.getElementById("canvas-context-menu-root"), zoomBadge = document.getElementById("canvas-zoom-badge");
    if (!world || !nodeLayer || !edgeDomLayer || !svg || !menuRoot) return;
    world.style.transform = `translate(${STATE.panX}px, ${STATE.panY}px) scale(${STATE.zoom})`;
    if (zoomBadge) zoomBadge.textContent = `${Math.round(STATE.zoom * 100)}%`;
    if (empty) empty.style.display = STATE.nodes.length ? "none" : "flex";
    nodeLayer.innerHTML = STATE.nodes.map(renderNode).join("");
    svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
    edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
    menuRoot.innerHTML = renderContextMenu();
    requestAnimationFrame(syncMeasuredPorts);
  }

  function renderLeftPanel() {
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
    if (library) library.innerHTML = `<button class="btn btn-default" type="button" data-open-asset-library="1" style="justify-content:flex-start;width:100%;padding:14px 16px;"><i class="fa fa-folder-open-o"></i> 打开素材库</button><div class="canvas-empty-card">素材库改为弹窗浏览。<br>点击上方入口按分类查看素材，并将素材加入画布或移动分类。</div>`;
    if (assetsRoot) assetsRoot.innerHTML = `<div class="canvas-empty-card">素材库已迁移为弹窗入口。<br>请在图片画布左侧点击「打开素材库」进行浏览和操作。</div>`;
    if (folderList) folderList.innerHTML = ["全部", ...categories].map((name) => {
      const count = name === "全部" ? STATE.assetLibrary.length : STATE.assetLibrary.filter((item) => (item.category || DEFAULT_ASSET_CATEGORY) === name).length;
      const renameBtn = name !== "全部" ? `<button class="btn btn-default" type="button" data-rename-asset-category="${escapeHtml(name)}">重命名</button>` : "";
      return `<div class="asset-folder-item ${name === STATE.activeAssetCategory ? "active" : ""}"><button type="button" style="all:unset;cursor:pointer;flex:1;display:flex;align-items:center;justify-content:space-between;gap:10px;" data-select-asset-category="${escapeHtml(name)}"><span><i class="fa fa-folder-open-o"></i> ${escapeHtml(name)}</span><span class="badge">${count}</span></button>${renameBtn}</div>`;
    }).join("");
    if (currentFolder) currentFolder.textContent = `${STATE.activeAssetCategory || "全部"} · ${filteredAssets.length} 个素材`;
    if (assetGrid) assetGrid.innerHTML = filteredAssets.length ? filteredAssets.map((item) => `<article class="asset-card">${item.imageUrl ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title || "素材")}">` : ""}<div class="asset-card-body"><div class="canvas-item-title">${escapeHtml(item.title || "未命名素材")}</div><div class="canvas-item-meta">${escapeHtml(item.category || DEFAULT_ASSET_CATEGORY)} · ${escapeHtml(item.source || item.type || "素材")}</div><div class="canvas-item-actions"><button class="btn btn-default" data-add-asset="${item.id}">加入画布</button><button class="btn btn-default" type="button" data-move-asset="${item.id}" data-asset-category="${escapeHtml(item.category || DEFAULT_ASSET_CATEGORY)}">移动分类</button><button class="btn btn-default" type="button" data-image-preview="${item.imageUrl || ""}">预览</button><button class="btn btn-danger" type="button" data-delete-asset="${item.id}">删除</button></div></div></article>`).join("") : `<div class="canvas-empty-card">当前分类还没有素材。<br>上传图片或把生成结果加入素材库后，这里会出现。</div>`;
    if (modal) modal.classList.toggle("hidden", !STATE.isAssetLibraryOpen);
    if (categoryModal) categoryModal.classList.toggle("hidden", !STATE.categoryModal.visible);
    if (categoryModalTitle) categoryModalTitle.textContent = STATE.categoryModal.mode === 'rename' ? '重命名分类' : (STATE.categoryModal.mode === 'move' ? '移动素材分类' : '新建分类');
    if (categoryModalSubtitle) categoryModalSubtitle.textContent = STATE.categoryModal.mode === 'rename' ? '输入新的分类名称，界面与本地文件夹都会同步更新。' : (STATE.categoryModal.mode === 'move' ? '选择一个目标分类，素材文件会移动到对应本地文件夹。' : '输入新的分类名称并确认。');
    if (categoryModalInput) { categoryModalInput.style.display = STATE.categoryModal.mode === 'move' ? 'none' : 'block'; categoryModalInput.value = STATE.categoryModal.initialValue || ''; }
    if (categoryModalSelect) { categoryModalSelect.style.display = STATE.categoryModal.mode === 'move' ? 'block' : 'none'; categoryModalSelect.innerHTML = moveOptions; categoryModalSelect.value = STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY; }
    if (history) history.innerHTML = sortedHistory.length ? sortedHistory.map((item) => `<article class="canvas-history-item ${item.id === STATE.currentHistoryId ? "active" : ""}"><div class="canvas-history-body"><div class="canvas-item-title">${escapeHtml(item.title || "未命名会话")}</div><div class="canvas-item-meta">${escapeHtml(item.summary || "空白画布")}</div><div class="canvas-item-actions"><button class="btn btn-default" data-open-history="${item.id}">打开</button></div></div></article>`).join("") : `<div class="canvas-empty-card">还没有历史会话。<br>当前画布会自动保存为第一条记录。</div>`;

    const createCategoryBtn = document.getElementById('create-asset-category-btn-modal');
    if (createCategoryBtn) createCategoryBtn.onclick = (event) => { event.preventDefault(); event.stopPropagation(); openCategoryModal('create'); };
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

  function renderNode(node) {
    const selected = STATE.selectedNodeId === node.id ? "selected" : "";
    const multiSelected = STATE.selectedNodeIds.includes(node.id) ? "multi-selected" : "";
    const linkedHighlight = STATE.connectionDrag?.targetNodeId === node.id ? "node-link-highlight" : "";
    const modelOptions = ((window.GLOBAL?.configList || []).filter((c) => ["image", "both"].includes(c.config_type)).map((c) => `<option value="${c.id}" ${c.id === node.modelId ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("")) || '<option value="">暂无图片模型</option>';
    const sizeOptions = SIZE_PRESETS.map((size) => `<option value="${size}" ${size === node.size ? "selected" : ""}>${size}</option>`).join("");
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const outputPreview = node.outputImages?.[0] || "";
    const ownReferenceImage = !outputPreview ? node.imageUrl : "";
    const displayImageUrl = outputPreview || ownReferenceImage;
    const showingGeneratedImage = Boolean(outputPreview);
    const showingOwnReferenceImage = Boolean(!outputPreview && node.imageUrl);
    const imageTitle = showingGeneratedImage ? `生成结果 · ${node.prompt || '画布图片'}` : (node.prompt || '画布图片');
    const topActions = showingOwnReferenceImage ? `<div class="node-image-top-actions"><button class="btn btn-default" type="button" data-download-image="${displayImageUrl}"><i class="fa fa-download"></i> 下载</button><button class="btn btn-danger" type="button" data-remove-reference-image="${node.id}"><i class="fa fa-times"></i> 关闭</button></div>` : (showingGeneratedImage ? `<div class="node-image-top-actions"><button class="btn btn-default" type="button" data-download-image="${displayImageUrl}"><i class="fa fa-download"></i> 下载</button><button class="btn btn-danger" type="button" data-clear-output-images="${node.id}"><i class="fa fa-times"></i> 关闭</button></div>` : (displayImageUrl ? `<div class="node-image-top-actions"><button class="btn btn-default" type="button" data-download-image="${displayImageUrl}"><i class="fa fa-download"></i> 下载</button></div>` : ""));
    const previewHtml = displayImageUrl ? `<img src="${displayImageUrl}" alt="node-image" data-context-image="${displayImageUrl}" data-image-title="${escapeHtml(imageTitle)}">${topActions}<div class="node-image-overlay"><div class="node-image-toolbar"><button class="btn btn-default" type="button" data-image-preview="${displayImageUrl}">预览</button><button class="btn btn-default" type="button" data-save-image-to-library="${displayImageUrl}" data-image-title="${escapeHtml(imageTitle)}">加入素材库</button></div></div>` : `<div class="node-image-empty">${linkedImageNodes.length ? `已连接 ${linkedImageNodes.length} 个上游参考图，当前节点将使用它们生成。` : '上传一张参考图，或者把一个带图片的上游节点连到这里。'}</div>`;
    const overlayTop = linkedImageNodes.length ? `<div class="node-linked-banner">已引用 ${linkedImageNodes.length} 个上游节点图片作为参考图</div>` : "";
    const imageActions = (linkedImageNode || showingGeneratedImage || showingOwnReferenceImage) ? "" : `<div class="node-image-actions"><button class="btn btn-default" type="button" data-upload-image="${node.id}">上传参考图</button></div>`;
    return `<div class="node ${selected} ${multiSelected} ${linkedHighlight}" data-node-id="${node.id}" style="left:${node.x}px;top:${node.y}px;"><span class="port-handle input" data-node-id="${node.id}" data-side="input" style="top:${getPortOffsetY(node)}px;left:-${PORT_RADIUS}px;transform:translate(-50%,-50%);"></span><span class="port-handle output" data-node-id="${node.id}" data-side="output" style="top:${getPortOffsetY(node)}px;right:-${PORT_RADIUS}px;transform:translate(50%,-50%);"></span><div class="node-shell"><div class="node-image-wrap">${previewHtml}${overlayTop}${imageActions}<input type="file" accept="image/*" hidden id="image-file-${node.id}" data-node-id="${node.id}"></div><div class="node-divider"></div><div class="node-body"><div class="node-row"><textarea data-node-id="${node.id}" data-field="prompt" placeholder="描述你想生成的画面，比如：赛博朋克夜景，霓虹街道，电影感光影">${escapeHtml(node.prompt || "")}</textarea></div><div class="node-mini-row"><div class="node-mini-field"><label>分辨率</label><select data-node-id="${node.id}" data-field="size">${sizeOptions}</select></div><div class="node-mini-field"><label>张数</label><input type="number" min="1" max="4" value="${Number(node.count || 1)}" data-node-id="${node.id}" data-field="count"></div><div class="node-mini-field"><label>模型</label><select data-node-id="${node.id}" data-field="modelId">${modelOptions}</select></div></div><div class="node-actions"><button class="btn btn-primary" type="button" data-run-generate="${node.id}">${node.busy ? "生成中..." : "开始生成"}</button></div></div></div></div>`;
  }

  function renderEdge(edge) {
    const fromNode = getNode(edge.from), toNode = getNode(edge.to);
    if (!fromNode || !toNode) return "";
    const from = getPortPosition(fromNode, "output"), to = getPortPosition(toNode, "input");
    const distance = Math.max(140, Math.abs(to.x - from.x) * 0.42);
    const c1x = from.x + distance, c2x = to.x - distance;
    const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
    return `<path class="edge-hit" data-edge-id="${edge.id}" d="${d}"></path><path class="edge-visible ${STATE.selectedEdgeId === edge.id ? 'edge-selected' : ''}" d="${d}" stroke="#60a5fa" stroke-width="3"></path>`;
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
    const to = STATE.connectionDrag.targetNodeId ? getPortPosition(getNode(STATE.connectionDrag.targetNodeId), "input") : STATE.connectionDrag.current;
    const distance = Math.max(140, Math.abs(to.x - from.x) * 0.42);
    const c1x = from.x + distance, c2x = to.x - distance;
    return `<path class="edge-visible" d="M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}" stroke="#34d399" stroke-width="3.5" stroke-dasharray="8 6"></path>`;
  }

  function getPortOffsetY(node) { return STATE.measuredNodeCenters[node.id] || 180; }
  function getPortPosition(node, side) { return { x: side === "output" ? node.x + NODE_WIDTH + PORT_RADIUS : node.x - PORT_RADIUS, y: node.y + getPortOffsetY(node) }; }

  function syncMeasuredPorts() {
    const nodes = document.querySelectorAll(".node[data-node-id]");
    let changed = false;
    nodes.forEach((el) => {
      const id = el.getAttribute("data-node-id");
      const center = Math.round(el.offsetHeight / 2);
      if (id && STATE.measuredNodeCenters[id] !== center) { STATE.measuredNodeCenters[id] = center; changed = true; }
    });
    if (changed && !STATE.connectionDrag) {
      const svg = document.getElementById("canvas-svg");
      if (svg) svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
      const edgeDomLayer = document.getElementById("edge-dom-layer");
      if (edgeDomLayer) edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
      document.querySelectorAll(".port-handle").forEach((port) => { const nodeId = port.getAttribute("data-node-id"); port.style.top = `${STATE.measuredNodeCenters[nodeId] || 180}px`; });
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
    return `<div class="canvas-context-menu" style="left:${STATE.contextMenu.x}px;top:${STATE.contextMenu.y}px;"><button data-context-create-node="1"><i class="fa fa-plus-circle"></i> 新建节点</button></div>`;
  }
  function createNodeFromContextMenu() { const point = STATE.contextMenu.canvasPoint || { x: 180, y: 160 }; hideContextMenu(false); addNodeAt(point.x, point.y); }
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
  function openHistorySession(id) { const item = STATE.historySessions.find((entry) => entry.id === id); if (!item) return; STATE.currentHistoryId = id; restoreSnapshot(item.snapshot, { focus: true }); renderCanvas(); renderLeftPanel(); }
  function persistCurrentHistory() { if (!STATE.currentHistoryId) return; const summary = buildHistorySummary(); const index = STATE.historySessions.findIndex((item) => item.id === STATE.currentHistoryId); const payload = { id: STATE.currentHistoryId, title: index >= 0 ? (STATE.historySessions[index].title || `画布会话 ${index + 1}`) : "当前画布", summary, snapshot: snapshotState() }; if (index >= 0) STATE.historySessions[index] = payload; else STATE.historySessions.unshift(payload); }
  async function persistCanvasState() { persistCurrentHistory(); try { await fetch("/api/canvas/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessions: STATE.historySessions, assetLibrary: STATE.assetLibrary }) }); } catch (error) { console.warn("[canvas] 保存本地状态失败", error); } }
  function buildHistorySummary() { const generatedCount = STATE.nodes.reduce((sum, node) => sum + (node.outputImages || []).length, 0); if (generatedCount) return `已生成 ${generatedCount} 张图 · ${STATE.nodes.length} 个节点`; const promptNode = STATE.nodes.find((node) => (node.prompt || "").trim()); if (promptNode) return `${String(promptNode.prompt).trim().slice(0, 20)} · ${STATE.nodes.length} 个节点`; return STATE.nodes.length ? `${STATE.nodes.length} 个节点` : "空白画布"; }
  function snapshotState() { return { nodes: JSON.parse(JSON.stringify(STATE.nodes)), edges: JSON.parse(JSON.stringify(STATE.edges)), panX: STATE.panX, panY: STATE.panY, zoom: STATE.zoom }; }
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
  function restoreSnapshot(snapshot, options = {}) { STATE.nodes = JSON.parse(JSON.stringify(snapshot?.nodes || [])); STATE.edges = JSON.parse(JSON.stringify(snapshot?.edges || [])); STATE.panX = Number(snapshot?.panX || 0); STATE.panY = Number(snapshot?.panY || 0); STATE.zoom = Number(snapshot?.zoom || 1); if (options.focus !== false && STATE.nodes.length) focusNodesInView(); }
  function mergeAssetIntoLibrary(asset) { STATE.assetLibrary = [normalizeAsset(asset), ...STATE.assetLibrary.filter((item) => item.id !== asset.id)].slice(0, 120); }
  function insertAssetAsNode(assetId) { const asset = STATE.assetLibrary.find((item) => item.id === assetId); if (!asset) return; const point = clientToCanvasPoint(getBoardRect().left + 280, getBoardRect().top + 220); const node = createNode(point.x, point.y); node.imageUrl = asset.imageUrl || ""; node.imageBase64 = asset.imageBase64 || ""; node.assetId = asset.id; STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
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
})();
