(function () {
  const RESOLUTION_PRESETS = ["1K", "2K", "4K"];
  const RATIO_PRESETS = ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3"];
  const DEFAULT_NEGATIVE_PROMPT = "low quality, blurry, distorted, bad anatomy, extra fingers, watermark, text, cropped, artifacts";
  const NODE_WIDTH = 360;
  const PORT_RADIUS = 18;
  const SNAP_DISTANCE = 120;
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
    leftPanelOpen: false,
    activePointerId: null,
    activePointers: new Map(),
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    pinchCenterClientX: 0,
    pinchCenterClientY: 0,
    nodeLongPressTimer: null,
    nodeLongPressId: null,
    nodeLongPressScope: "node",
    assetLongPressTimer: null,
    assetLongPressId: "",
    connectionDragMoved: false,
    connectionDragStartClientX: 0,
    connectionDragStartClientY: 0,
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
  }, 180);
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
    style.textContent = " = `\n      #image{height:calc(100vh - 64px);overflow:hidden}\n      .canvas-shell{position:relative;display:flex;height:100%;background:#0b1020;color:#e5e7eb;overflow:hidden}.canvas-left-backdrop{position:absolute;inset:0;background:rgba(2,6,23,.46);opacity:0;pointer-events:none;transition:.22s;z-index:20}.canvas-shell.show-left-panel .canvas-left-backdrop{opacity:1;pointer-events:auto}.canvas-left{width:280px;border-right:1px solid rgba(148,163,184,.18);background:#0f172a;padding:10px;display:flex;flex-direction:column;gap:8px;overflow:hidden;z-index:30}.canvas-shell.is-mobile-drawer .canvas-left{position:absolute;left:0;top:0;bottom:0;width:min(60vw,280px);transform:translateX(-100%) !important;transition:transform .22s ease;box-shadow:0 24px 60px rgba(0,0,0,.35)}.canvas-shell.is-mobile-drawer.show-left-panel .canvas-left{transform:translateX(0) !important}\n      .canvas-title{font-size:18px;font-weight:800;color:#fff}.canvas-subtitle{font-size:12px;color:#94a3b8;line-height:1.6}.canvas-panel{border:1px solid rgba(148,163,184,.12);background:rgba(15,23,42,.78);border-radius:12px;padding:10px;min-height:0;display:flex;flex-direction:column}\n      .canvas-panel-header{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}.canvas-panel-title{font-size:12px;font-weight:700;color:#fff;display:flex;align-items:center;gap:6px}.canvas-panel-subtitle{font-size:10px;color:#94a3b8;line-height:1.45;margin-bottom:6px}\n      .canvas-library-toolbar{display:grid;gap:6px;margin-bottom:6px}.canvas-library-toolbar .form-select,.canvas-library-toolbar .form-input{background:#0b1220;border:1px solid rgba(148,163,184,.18);color:#fff}.canvas-library-list,.canvas-history-list{display:flex;flex-direction:column;gap:6px;overflow:auto;min-height:0}\n      .canvas-library-item,.canvas-history-item{border:1px solid rgba(148,163,184,.12);border-radius:12px;background:#111827;transition:all .2s ease}.canvas-library-item:hover,.canvas-history-item:hover{border-color:rgba(96,165,250,.28);transform:translateY(-1px)}\n      .canvas-library-thumb{width:100%;aspect-ratio:1.35/1;object-fit:cover;display:block;background:#0b1220;border-top-left-radius:14px;border-top-right-radius:14px}.canvas-library-body,.canvas-history-body{padding:10px 12px;display:grid;gap:6px}.canvas-item-title{font-size:13px;font-weight:700;color:#e5e7eb}\n      .canvas-item-meta{font-size:12px;color:#94a3b8}.canvas-item-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}.canvas-item-actions .btn{padding:8px 12px;font-size:12px}.canvas-history-item.active{border-color:#60a5fa;box-shadow:0 0 0 1px rgba(96,165,250,.18)}\n      .canvas-empty-card{border:1px dashed rgba(148,163,184,.18);border-radius:14px;padding:16px;text-align:center;color:#94a3b8;font-size:12px;line-height:1.7;background:rgba(15,23,42,.5)}.canvas-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}\n      .canvas-drawer-close{border:none;background:#eef2f7;color:#0f172a;border-radius:10px;padding:7px 9px;font-size:11px;font-weight:700;cursor:pointer}.canvas-fab-toggle{position:absolute;left:0;top:10px;z-index:45;width:28px;height:44px;border:none;border-top-right-radius:16px;border-bottom-right-radius:16px;border-top-left-radius:0;border-bottom-left-radius:0;background:rgba(15,23,42,.94);color:#fff;box-shadow:0 14px 34px rgba(0,0,0,.28);font-size:18px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0}\n      .node-grid-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.node-model-row{display:grid;gap:8px}.node-mini-field{display:grid;gap:4px}.node-mini-field label{font-size:11px;margin-bottom:0}.node-mini-field select,.node-mini-field input{padding:8px 10px;font-size:12px;border-radius:12px}\n      .canvas-toast{position:fixed;top:84px;right:20px;z-index:2000;padding:10px 14px;border-radius:12px;background:rgba(15,23,42,.96);color:#fff;border:1px solid rgba(96,165,250,.28);box-shadow:0 16px 36px rgba(0,0,0,.28);font-size:13px;opacity:0;transform:translateY(-8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease}.canvas-toast.show{opacity:1;transform:translateY(0)}\n      .canvas-board-wrap{position:relative;flex:1;min-height:0;overflow:hidden;background:radial-gradient(circle at 1px 1px, rgba(148,163,184,.16) 1px, transparent 0) 0 0/24px 24px,linear-gradient(180deg,#0b1020,#0a0f1b);touch-action:none}.canvas-board{position:absolute;inset:0;overflow:hidden;cursor:grab;user-select:none;touch-action:none}.canvas-board.panning{cursor:grabbing}.canvas-world{position:absolute;left:0;top:0;transform-origin:0 0;width:3000px;height:2400px;contain:layout style}\n      .canvas-selection-box{position:absolute;border:1px solid rgba(96,165,250,.95);background:rgba(96,165,250,.14);pointer-events:none;z-index:25;border-radius:10px}.node.multi-selected{box-shadow:0 0 0 2px rgba(96,165,250,.95),0 24px 70px rgba(15,23,42,.55)}\n      .asset-library-modal.hidden{display:none}.asset-library-modal{position:fixed;inset:0;z-index:1600}.asset-library-backdrop{position:absolute;inset:0;background:rgba(2,6,23,.7);backdrop-filter:blur(4px)}.asset-library-panel{position:relative;width:min(1100px,calc(100vw - 24px));height:min(760px,calc(100vh - 24px));margin:12px auto;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.45);display:grid;grid-template-columns:minmax(92px,116px) minmax(0,1fr);overflow:hidden}.asset-library-panel.draggable{cursor:default}.asset-library-sidebar{padding:10px 8px;border-right:1px solid rgba(148,163,184,.14);display:flex;flex-direction:column;gap:8px;background:#111827;min-height:0}.asset-library-content{padding:10px;display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}.asset-folder-list,.asset-grid{display:grid;gap:8px;overflow:auto}.asset-folder-list{flex:1;min-height:0;padding-right:2px;display:flex;flex-direction:column;gap:4px;overflow-y:auto}.asset-folder-item{display:flex;align-items:center;justify-content:space-between;gap:4px;padding:7px 8px;border-radius:8px;background:#111827;border:1px solid rgba(148,163,184,.12);cursor:pointer;font-size:11px;color:#e5e7eb;transition:all .15s ease;flex:0 0 auto}.asset-folder-item:hover{border-color:rgba(96,165,250,.28)}.asset-folder-item.active{border-color:#60a5fa;background:rgba(96,165,250,.1);color:#93c5fd}.asset-folder-item .folder-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.asset-folder-item .folder-rename-btn{flex:0 0 auto;padding:2px 6px;font-size:9px;border:none;border-radius:5px;background:rgba(96,165,250,.18);color:#93c5fd;cursor:pointer}.asset-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;flex:1;min-height:0;padding-right:2px;align-content:start}.asset-card{display:flex;flex-direction:column;gap:0;border:1px solid rgba(148,163,184,.12);border-radius:12px;overflow:hidden;background:#111827;min-height:0}.asset-card img{width:100%;height:auto;aspect-ratio:1/1;object-fit:cover;background:#0b1220;flex:none}.asset-card-body{padding:8px;display:flex;flex-direction:column;gap:6px;flex:1;min-width:0;justify-content:flex-start}.asset-modal-header{display:flex;align-items:center;justify-content:space-between;gap:8px}.asset-modal-header.drag-handle{cursor:move;user-select:none;padding-bottom:4px;border-bottom:1px solid rgba(148,163,184,.1)}.asset-folder-actions{display:flex;gap:6px;align-items:center}.asset-folder-actions .btn{padding:5px 7px;font-size:10px}.asset-modal-actions{display:flex;gap:6px;flex-wrap:wrap}\n      .canvas-debug{position:absolute;right:14px;bottom:14px;z-index:30;min-width:260px;max-width:360px;padding:10px 12px;border-radius:14px;background:rgba(2,6,23,.82);border:1px solid rgba(148,163,184,.22);box-shadow:0 14px 36px rgba(0,0,0,.35);font-size:12px;line-height:1.55;color:#cbd5e1;backdrop-filter:blur(8px)}.canvas-debug strong{color:#fff}.canvas-debug code{color:#93c5fd;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}\n      .canvas-svg{position:absolute;left:0;top:0;width:3000px;height:2400px;overflow:visible;z-index:1;pointer-events:none}.edge-hit{stroke:transparent;stroke-width:28;fill:none;pointer-events:none;cursor:pointer}.edge-visible{fill:none;stroke-linecap:round;pointer-events:none}.edge-selected{stroke:#f59e0b!important}.canvas-node-layer{position:absolute;left:0;top:0;width:3000px;height:2400px;z-index:3}.edge-dom-layer{position:absolute;left:0;top:0;width:3000px;height:2400px;z-index:2;pointer-events:none}.edge-dom-hit{position:absolute;height:28px;transform-origin:left center;pointer-events:auto;cursor:pointer;background:transparent}.edge-dom-hit.edge-selected{outline:2px solid rgba(245,158,11,.95);outline-offset:0;border-radius:999px}\n      .node{position:absolute;width:min(156px,42vw);background:#111827;border:1px solid rgba(96,165,250,.12);border-radius:14px;box-shadow:0 4px 12px rgba(2,6,23,.2);overflow:visible}.node.selected{border-color:#60a5fa;box-shadow:0 0 0 2px rgba(96,165,250,.55),0 0 0 8px rgba(59,130,246,.14),0 22px 48px rgba(0,0,0,.38)}.node-link-highlight{border-color:rgba(52,211,153,.75)!important;box-shadow:0 0 0 1px rgba(52,211,153,.18),0 18px 40px rgba(0,0,0,.32)!important}\n      .node-shell{position:relative;border-radius:14px;overflow:hidden;background:transparent}.node-image-wrap{position:relative;background:linear-gradient(180deg,#0f172a,#0b1220);min-height:88px;display:flex;align-items:center;justify-content:center;cursor:move}.node-image-wrap img{width:100%;height:100%;display:block;object-fit:cover;cursor:default}\n      .node-image-overlay{position:absolute;inset:0;background:linear-gradient(to top, rgba(2,6,23,.62), rgba(2,6,23,.12) 45%, rgba(2,6,23,0));display:flex;align-items:flex-end;justify-content:flex-end;padding:12px;opacity:0;transition:opacity .18s ease;pointer-events:none}.node-image-top-actions{position:absolute;top:10px;right:10px;display:flex;gap:8px;opacity:0;transition:opacity .18s ease;z-index:4}\n      .node-image-wrap:hover .node-image-overlay,.node-image-wrap:hover .node-image-top-actions,.output-card:hover .node-image-overlay{opacity:1}.node-image-toolbar{display:flex;gap:8px;pointer-events:auto}.node-image-toolbar .btn,.node-image-top-actions .btn{padding:8px 12px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.18);backdrop-filter:blur(6px)}\n      .node-image-empty{padding:10px;text-align:center;color:#64748b;line-height:1.5;font-size:11px}.node-image-actions{position:absolute;left:8px;right:8px;bottom:8px;display:flex;gap:6px;flex-wrap:wrap;z-index:3}.node-image-actions .btn{flex:1;min-width:0;justify-content:center;cursor:pointer;padding:7px 8px;font-size:11px}\n      .node-linked-banner{position:absolute;left:8px;right:8px;top:8px;padding:6px 8px;border-radius:10px;background:rgba(15,23,42,.82);border:1px solid rgba(52,211,153,.22);color:#d1fae5;font-size:10px;backdrop-filter:blur(4px);z-index:3}\n      .node-divider{height:1px;background:linear-gradient(90deg,transparent,rgba(148,163,184,.16),transparent)}.node-body{padding:7px 7px 8px;display:grid;gap:5px}.node-row{display:grid;gap:4px}.node-body label{display:block;font-size:9px;color:#9fb0c8;margin-bottom:1px;letter-spacing:.01em}\n      .node-body input,.node-body textarea,.node-body select{width:100%;border:1px solid rgba(148,163,184,.14);background:rgba(15,23,42,.96);color:#f8fafc;border-radius:8px;padding:6px 8px;outline:none;pointer-events:auto;cursor:text;transition:border-color .18s ease, box-shadow .18s ease, background .18s ease;font-size:11px}.node-body textarea{resize:vertical;min-height:44px;user-select:text;line-height:1.35}.node-body select{cursor:pointer;-webkit-appearance:none;appearance:none;background-image:linear-gradient(45deg,transparent 50%,#93c5fd 50%),linear-gradient(135deg,#93c5fd 50%,transparent 50%),linear-gradient(to right,rgba(59,130,246,.18),rgba(59,130,246,.18));background-position:calc(100% - 14px) calc(50% - 2px),calc(100% - 10px) calc(50% - 2px),calc(100% - 30px) 50%;background-size:5px 5px,5px 5px,1px 16px;background-repeat:no-repeat;padding-right:34px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03),0 6px 14px rgba(2,6,23,.10)}.node-body input:focus,.node-body textarea:focus,.node-body select:focus{border-color:rgba(96,165,250,.55);box-shadow:0 0 0 2px rgba(59,130,246,.14);background:#111b2f}\n      .node-body input,.node-body textarea,.node-body select,.node-body button,.node-image-actions button,.node-image-actions a,.output-card-actions a,.output-card-actions button,.node-image-toolbar button{position:relative;z-index:3}.node-grid-two{display:grid;grid-template-columns:1fr 1fr;gap:5px}.node-mini-field{display:grid;gap:3px}.node-mini-field label{font-size:9px;margin-bottom:0}.node-mini-field select,.node-mini-field input{padding:6px 8px;font-size:11px;border-radius:8px}\n      .node-actions{display:flex;gap:4px;flex-wrap:wrap}.node-actions button{flex:1;min-width:0;cursor:pointer;border-radius:8px;padding:7px 8px;font-size:11px;font-weight:700}.output-gallery{display:grid;grid-template-columns:1fr 1fr;gap:10px}.output-card{position:relative;border:1px solid rgba(148,163,184,.14);border-radius:14px;overflow:hidden;background:#0b1220}.output-card img{width:100%;display:block;aspect-ratio:1/1;object-fit:cover;cursor:default}\n      .output-card-actions{display:flex;gap:8px;padding:10px;flex-wrap:wrap}.output-card-actions a,.output-card-actions button{flex:1;text-align:center;text-decoration:none}.port-handle{position:absolute;width:${PORT_RADIUS * 2}px;height:${PORT_RADIUS * 2}px;border-radius:999px;background:#111827;border:2px solid #34d399;box-shadow:0 0 0 4px rgba(52,211,153,.12);cursor:crosshair;z-index:5}\n      .canvas-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#94a3b8;font-size:14px;text-align:center;line-height:1.8}.canvas-context-menu{position:absolute;z-index:60;min-width:180px;background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:14px;box-shadow:0 18px 45px rgba(0,0,0,.35);padding:8px}.canvas-context-menu button{width:100%;background:transparent;border:none;color:#e5e7eb;text-align:left;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:13px}.canvas-context-menu button:hover{background:rgba(30,41,59,.95)}\n      .custom-confirm-mask{position:fixed;inset:0;z-index:10000;background:rgba(2,6,23,.78);display:flex;align-items:center;justify-content:center;padding:24px}.custom-confirm-box{background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:16px;padding:20px;max-width:min(360px,90vw);width:100%;box-shadow:0 20px 50px rgba(0,0,0,.4)}.custom-confirm-msg{color:#e5e7eb;font-size:14px;line-height:1.6;margin-bottom:16px;text-align:center}.custom-confirm-actions{display:flex;gap:8px}.custom-confirm-actions .btn{flex:1;justify-content:center;padding:10px;font-size:13px;font-weight:600}.category-pick-list{display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;margin:8px 0;padding:2px}.category-pick-item{padding:8px 10px;border-radius:8px;background:#111827;border:1px solid rgba(148,163,184,.12);color:#e5e7eb;font-size:12px;cursor:pointer;transition:all .15s ease;text-align:left}.category-pick-item:hover{border-color:rgba(96,165,250,.28)}.category-pick-item.active{border-color:#60a5fa;background:rgba(96,165,250,.1);color:#93c5fd}.asset-modal-context-menu{position:fixed!important;z-index:1705!important;transform:translate(-12px,-12px)!important;max-width:min(220px,calc(100vw - 24px))!important}.image-preview-modal{position:fixed;inset:0;background:rgba(2,6,23,.82);display:flex;align-items:center;justify-content:center;z-index:9999;padding:24px}.image-preview-modal.hidden{display:none}.image-preview-backdrop{position:absolute;inset:0}.image-preview-container{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}.image-preview-container img{max-width:92vw;max-height:92vh;display:block;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.45);transform-origin:center center;transition:transform .15s ease;contain:layout style;user-select:none;-webkit-user-drag:none}\n      @media (max-width:1100px){.canvas-main{width:100%}.node{width:min(156px,42vw)}.output-gallery{grid-template-columns:1fr}.node-grid-two,.node-mini-row{grid-template-columns:1fr}}\n    ";
    document.head.appendChild(style);

    const patch = document.createElement("style");
    patch.id = "image-canvas-style-patch-node-media";
    patch.textContent = `
      .node{width:min(156px,42vw) !important;min-width:min(156px,42vw) !important;max-width:min(156px,42vw) !important;box-sizing:border-box !important;}
      .node-shell{width:100%;}
      .node-image-wrap{position:relative !important;width:100% !important;min-height:132px !important;height:auto !important;aspect-ratio:auto !important;max-height:none !important;overflow:hidden !important;display:flex !important;align-items:center !important;justify-content:center !important;background:#111827 !important;border-bottom:1px solid rgba(148,163,184,.14) !important;}
      .node-image-wrap img{position:relative !important;z-index:2 !important;width:100% !important;height:auto !important;max-width:none !important;max-height:none !important;object-fit:contain !important;object-position:center !important;display:block !important;visibility:visible !important;opacity:1 !important;background:#111827 !important;}
      .node-image-empty{display:flex !important;align-items:center !important;justify-content:center !important;width:100% !important;height:100% !important;min-height:132px !important;background:#0f172a !important;color:#94a3b8 !important;}
      .asset-grid{grid-template-columns:repeat(2,minmax(0,1fr)) !important;gap:10px !important;align-content:start !important;}
      .asset-card{position:relative !important;display:block !important;border:1px solid rgba(148,163,184,.18) !important;border-radius:14px !important;overflow:hidden !important;background:#111827 !important;min-height:148px !important;box-shadow:0 8px 22px rgba(0,0,0,.22) !important;}
      .asset-card img{position:relative !important;z-index:2 !important;display:block !important;width:100% !important;height:148px !important;min-height:148px !important;max-height:none !important;aspect-ratio:auto !important;object-fit:cover !important;object-position:center !important;visibility:visible !important;opacity:1 !important;background:#111827 !important;}
      .canvas-svg{z-index:6 !important;pointer-events:auto !important;overflow:visible !important;}
      .canvas-node-layer{z-index:7 !important;}
      .edge-dom-layer,.edge-dom-hit{display:none !important;}
      .edge-hit{stroke:rgba(255,255,255,0.001);stroke-width:72;fill:none;pointer-events:stroke;cursor:pointer !important;}
      .edge-visible{pointer-events:none !important;}
      .port-handle{position:absolute !important;display:flex !important;align-items:center !important;justify-content:center !important;width:40px !important;height:40px !important;border:none !important;background:transparent !important;box-shadow:none !important;z-index:12 !important;overflow:visible !important;}
      .port-handle::before{content:"";position:absolute;inset:0;border-radius:999px;background:rgba(52,211,153,.12);border:2px solid rgba(52,211,153,.24);box-shadow:0 0 18px rgba(52,211,153,.16);}
      .port-handle::after{content:"";position:absolute;width:14px;height:14px;border-radius:999px;background:#34d399;border:3px solid #0f172a;box-shadow:0 0 0 5px rgba(52,211,153,.14),0 0 10px rgba(52,211,153,.16);}
      .port-handle:hover::before{background:rgba(52,211,153,.20);border-color:rgba(52,211,153,.40);}
      body.debug-canvas-hit .port-handle{background:rgba(239,68,68,.18) !important;}
      body.debug-canvas-hit .edge-hit{stroke:rgba(250,204,21,.35) !important;}
      .node-image-overlay,.node-image-top-actions,.node-image-toolbar{display:none !important;}.node-close-image-btn{position:absolute;right:6px;bottom:6px;z-index:5;padding:4px 8px;font-size:10px;min-height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;gap:3px;background:rgba(245,63,63,.85);color:#fff;border:none;cursor:pointer;backdrop-filter:blur(4px);box-shadow:0 2px 8px rgba(0,0,0,.3)}
      .canvas-left{width:min(18vw,92px);padding:5px;gap:4px;background:linear-gradient(180deg,rgba(15,23,42,.99),rgba(10,15,27,.99));backdrop-filter:blur(16px)}
      .canvas-panel{border-radius:10px;padding:5px;background:rgba(15,23,42,.88)}
      .canvas-panel-header{margin-bottom:6px}.canvas-panel-title{font-size:12px;gap:5px}.canvas-panel-subtitle,.canvas-item-meta,.canvas-subtitle{font-size:10px;line-height:1.4;color:#8ea3bf}
      .canvas-item-title{font-size:10px}.canvas-library-body,.canvas-history-body{padding:6px 7px;gap:2px}.canvas-library-item,.canvas-history-item{border-radius:9px}
      .canvas-fab-toggle{top:10px;width:26px;height:42px;font-size:14px;border-top-right-radius:12px;border-bottom-right-radius:12px}
      .node{width:min(220px,52vw) !important;min-width:min(220px,52vw) !important;max-width:min(220px,52vw) !important;border-radius:12px;box-shadow:0 5px 12px rgba(2,6,23,.16)}
      .node.selected{box-shadow:0 0 0 1.5px rgba(96,165,250,.58),0 0 0 5px rgba(59,130,246,.10),0 14px 30px rgba(0,0,0,.24)}
      .node-shell{border-radius:12px;overflow:visible !important}.node-image-wrap{min-height:64px;overflow:hidden !important;height:auto !important}.node-image-wrap img{object-fit:contain !important;height:auto !important}
      .node-linked-banner{left:5px;right:5px;top:5px;padding:4px 5px;font-size:8px;border-radius:7px}
      .node-image-empty{padding:6px;font-size:9px;line-height:1.35}
      .node-image-actions{left:5px;right:5px;bottom:5px;gap:3px}.node-image-actions .btn{padding:5px 6px;font-size:9px;border-radius:7px}
      .node-body{padding:4px;gap:2px;overflow:visible !important}.node-row{gap:2px}.node-body label,.node-mini-field label{font-size:7px;color:#9cb0c9}
      .canvas-node-model{display:flex;align-items:center;gap:5px;padding:3px 5px;border-radius:8px;background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.12)}
      .canvas-node-model-icon{width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex:0 0 16px}.canvas-node-model-icon img,.canvas-node-model-icon svg{width:16px;height:16px}.canvas-node-model-name{font-size:9px;font-weight:700;line-height:1.15;color:#e8eef8}
      .node-grid-two{gap:2px}.node-mini-field{gap:1px}
      .node-body input,.node-body textarea,.node-body select{font-size:9px;padding:4px 6px;border-radius:6px}
      .node-body textarea{min-height:24px}
      .node-mini-field select,.node-mini-field input{padding:4px 6px;font-size:9px;border-radius:6px}
      .node-body select{background-position:calc(100% - 10px) calc(50% - 2px),calc(100% - 7px) calc(50% - 2px),calc(100% - 22px) 50%;background-size:4px 4px,4px 4px,1px 12px;padding-right:26px}
      .node-actions{gap:2px}.node-actions button{padding:4px 5px;font-size:8px;border-radius:6px;min-height:24px}.node-grid-compact{display:grid;grid-template-columns:1fr;gap:3px;align-items:start}.node-prompt-cell textarea{height:auto;min-height:46px}.node-compact-side{display:grid;grid-template-columns:1fr 1fr;gap:3px}.asset-modal-header{gap:6px}.asset-modal-actions{display:flex;gap:4px;flex-wrap:nowrap}.asset-modal-actions .btn,.asset-folder-actions .btn{padding:4px 8px;font-size:10px;border-radius:6px;white-space:nowrap}.canvas-library-toolbar .form-select,.canvas-library-toolbar .form-input{font-size:11px;padding:6px 8px;border-radius:8px}.canvas-title{font-size:15px}.asset-library-sidebar .canvas-title,.asset-library-content .canvas-title{font-size:12px !important}.asset-library-sidebar .canvas-subtitle,.asset-library-content .canvas-subtitle{font-size:10px}.asset-library-panel .canvas-library-toolbar{gap:4px}.asset-library-panel .canvas-library-toolbar > div{display:flex;gap:4px}.asset-library-panel .canvas-library-toolbar > div .btn{flex:1;padding:4px 6px;font-size:9px;min-width:0;text-align:center}.asset-library-sidebar{padding:8px 6px;gap:6px}.asset-library-content{padding:8px;gap:8px}.asset-card .canvas-item-actions{display:grid;grid-template-columns:1fr;gap:4px}.custom-select{position:relative}.custom-select-btn{width:100%;display:flex;align-items:center;justify-content:space-between;gap:6px;border:1px solid rgba(96,165,250,.18);background:linear-gradient(180deg,#0f172a,#111b2f);color:#f8fafc;border-radius:6px;padding:4px 6px;font-size:9px;min-height:28px;box-shadow:inset 0 1px 0 rgba(255,255,255,.03),0 6px 14px rgba(2,6,23,.10)}.custom-select-btn::after{content:"";width:8px;height:8px;border-right:2px solid #93c5fd;border-bottom:2px solid #93c5fd;transform:rotate(45deg);flex:0 0 auto;margin-top:-3px}.custom-select-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.custom-select-menu{position:absolute;left:0;right:0;top:calc(100% + 4px);background:#0f172a;border:1px solid rgba(96,165,250,.18);border-radius:10px;box-shadow:0 18px 45px rgba(0,0,0,.35);padding:4px;display:none;z-index:90;max-height:200px;overflow-y:auto;-webkit-overflow-scrolling:touch}.custom-select.open .custom-select-menu{display:block}.custom-select-option{width:100%;display:block;background:transparent;border:none;color:#e5e7eb;text-align:left;padding:7px 8px;border-radius:8px;font-size:10px;min-height:32px;cursor:pointer;line-height:1.4}.custom-select-option.active,.custom-select-option:hover{background:rgba(30,41,59,.95)}@media (max-width:1100px){.node-grid-compact{grid-template-columns:1fr}.node-compact-side{grid-template-columns:1fr 1fr}.asset-library-panel{grid-template-columns:78px minmax(0,1fr)}.canvas-left{width:min(18vw,92px)}.asset-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}.port-handle{display:flex!important;align-items:center!important;justify-content:center!important}.port-handle::before{display:none!important;content:none!important}.port-handle::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:4px!important;height:4px!important;border-radius:999px;background:#34d399!important;border:1px solid #34d399!important;box-shadow:none!important;pointer-events:none!important}
      .port-handle{width:34px !important;height:34px !important}.port-handle::before{inset:5px;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.16)}.port-handle::after{width:5px;height:5px;border-width:1px;box-shadow:0 0 0 2px rgba(52,211,153,.08),0 0 4px rgba(52,211,153,.12)}
      .canvas-context-menu{min-width:160px;border-radius:12px;padding:6px;touch-action:auto;z-index:60}.canvas-context-menu button{padding:9px 10px;font-size:12px;border-radius:8px;touch-action:auto}.canvas-open-assets-btn{width:100%;display:flex;align-items:center;justify-content:flex-start;gap:8px;padding:8px 8px;border:none;border-radius:10px;background:linear-gradient(180deg,#162033,#0f172a);color:#e5eefc;box-shadow:inset 0 1px 0 rgba(255,255,255,.04),0 6px 14px rgba(2,6,23,.18)}.canvas-open-assets-icon{width:24px;height:24px;border-radius:8px;display:flex;align-items:center;justify-content:center;background:rgba(96,165,250,.12);color:#93c5fd;font-size:12px}.canvas-open-assets-text{font-size:10px;font-weight:700;letter-spacing:.02em}.canvas-history-body{padding:6px 7px !important;gap:3px !important}.canvas-history-item{border-radius:10px !important}.canvas-history-item .btn{padding:5px 6px !important;font-size:10px !important}.canvas-item-title{font-size:11px !important}.canvas-item-meta{font-size:10px !important;line-height:1.3}
      @media (max-width:1100px){.node{width:min(186px,48vw) !important}.node-grid-two,.node-mini-row{grid-template-columns:1fr}.canvas-left{width:min(46vw,172px)}}
    `;
    document.head.appendChild(patch);
  }

  function buildImageWorkbench() {
    const tab = document.getElementById("image");
    if (!tab) return;
    tab.innerHTML = `
      <div class="canvas-shell" id="canvas-shell">
        <div class="canvas-left-backdrop" id="canvas-left-backdrop"></div><aside class="canvas-left">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;"><div class="canvas-title">无限画布</div></div>
          <section class="canvas-panel" style="flex:1.1;"><div class="canvas-panel-header"><div class="canvas-panel-title"><i class="fa fa-folder-open-o"></i> 素材库</div></div><div class="canvas-library-list custom-scrollbar" id="canvas-library-list"></div></section>
          <section class="canvas-panel" style="flex:0.9;"><div class="canvas-panel-header"><div class="canvas-panel-title"><i class="fa fa-history"></i> 历史会话记录</div><button class="btn btn-default" id="new-canvas-session-btn">新建</button></div><div class="canvas-panel-subtitle">所有画布记录都会保存到本地文件。</div><div class="canvas-history-list custom-scrollbar" id="canvas-history-list"></div></section>
        </aside>
        <section class="canvas-main">
          <div class="canvas-board-wrap" id="canvas-board-wrap"><button class="canvas-fab-toggle" id="canvas-left-floating-toggle" type="button">☰</button><div class="canvas-board" id="canvas-board"><div class="canvas-world" id="canvas-world"><svg class="canvas-svg" id="canvas-svg"></svg><div id="edge-dom-layer" class="edge-dom-layer"></div><div id="canvas-node-layer" class="canvas-node-layer"></div></div><div class="canvas-empty" id="canvas-empty-tip"></div><div class="canvas-selection-box" id="canvas-selection-box" style="display:none"></div></div><div id="canvas-context-menu-root"></div></div>
        </section>
      </div>
      <div class="image-preview-modal hidden" id="image-preview-modal"><div class="image-preview-container" id="image-preview-container"><img id="image-preview-target" src="" alt="preview"></div></div>
      <div class="asset-library-modal hidden" id="asset-library-modal"><div class="asset-library-backdrop" data-close-asset-library="1"></div><div class="asset-library-panel draggable" id="asset-library-panel"><aside class="asset-library-sidebar"><div class="asset-modal-header drag-handle" data-drag-asset-library="1"><div><div class="canvas-title" style="font-size:14px;">素材库</div></div><button class="btn btn-default" id="create-asset-category-btn-modal" style="flex:0 0 auto;padding:3px 8px;font-size:10px;min-height:0;">新建</button></div><div class="asset-folder-list custom-scrollbar" id="asset-folder-list"></div></aside><section class="asset-library-content"><div class="asset-modal-header"><div><div class="canvas-title" style="font-size:14px;">图片素材</div></div><div class="asset-modal-actions"><button class="btn btn-danger" type="button" id="delete-current-asset-category-btn">删分类</button><button class="btn btn-default" type="button" data-close-asset-library="1">完成</button></div></div><div class="asset-grid custom-scrollbar" id="asset-library-grid"></div></section></div></div><div class="asset-library-modal hidden" id="asset-category-modal"><div class="asset-library-backdrop" data-close-category-modal="1"></div><div class="asset-library-panel" style="grid-template-columns:1fr;max-width:520px;height:auto;"><section class="asset-library-content"><div class="asset-modal-header"><div><div class="canvas-title" style="font-size:16px;" id="asset-category-modal-title">新建分类</div><div class="canvas-subtitle" id="asset-category-modal-subtitle">填写分类名称并确认。</div></div><button class="btn btn-default" type="button" data-close-category-modal="1">关闭</button></div><div class="canvas-library-toolbar" style="display:grid;gap:12px;"><input class="form-input" id="asset-category-modal-input" placeholder="输入分类名称"><div class="category-pick-list" id="asset-category-modal-select"></div></div><div class="asset-modal-actions"><button class="btn btn-default" type="button" data-close-category-modal="1">取消</button><button class="btn btn-primary" type="button" id="confirm-asset-category-modal-btn">确认</button></div></section></div></div><div class="canvas-toast" id="canvas-toast"></div>`;
  }

  function toggleCanvasLeftPanel(force) {
    const shell = document.getElementById("canvas-shell");
    if (!shell) return;
    const next = typeof force === "boolean" ? force : !shell.classList.contains("show-left-panel");
    shell.classList.toggle("show-left-panel", next);
    STATE.leftPanelOpen = next;
  }

  function bindWorkbenchEvents() {
    const root = document.getElementById("image");
    const board = document.getElementById("canvas-board");
    if (!root || !board) return;
    if (root.dataset.canvasBound !== "1") {
      root.dataset.canvasBound = "1";

      const shell = document.getElementById("canvas-shell");
      if (shell) shell.classList.add("is-mobile-drawer");
      toggleCanvasLeftPanel(false);
      document.getElementById("canvas-left-floating-toggle")?.addEventListener("click", () => toggleCanvasLeftPanel());
      document.getElementById("canvas-left-backdrop")?.addEventListener("click", () => toggleCanvasLeftPanel(false));

      root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("[data-close-preview]")) {
        event.preventDefault();
        event.stopPropagation();
        closeImagePreview();
        return;
      }
      if (target.closest('.node-body textarea, .node-body input, .node-body select')) {
        return;
      }
      if (target.closest("#toggle-canvas-debug-btn")) {
        document.body.classList.toggle("debug-canvas-hit");
        const badge = document.getElementById("canvas-debug-badge");
        if (badge) badge.style.display = document.body.classList.contains("debug-canvas-hit") ? "inline-flex" : "none";
        return;
      }
      if (target.closest("#reset-canvas-btn")) return resetCanvas();
      if (target.closest("#new-canvas-session-btn")) return createNewHistorySession();
      if (target.closest("[data-select-asset-category]")) toggleCanvasLeftPanel(false);
      if (target.closest("[data-open-history]")) toggleCanvasLeftPanel(false);
      if (target.closest("#create-asset-category-btn")) return createAssetCategory();
      if (target.closest("#create-asset-category-btn-assets")) return createAssetCategory("assets");
      if (target.closest("#create-asset-category-btn-modal")) return openCategoryModal("create");
      var pickItem = target.closest("[data-pick-category]");
      if (pickItem) { STATE.categoryModal.category = pickItem.getAttribute("data-pick-category") || DEFAULT_ASSET_CATEGORY; document.querySelectorAll(".category-pick-item").forEach(function(el) { el.classList.toggle("active", el.getAttribute("data-pick-category") === STATE.categoryModal.category); }); return; }
      if (target.closest("#confirm-asset-category-modal-btn")) return confirmCategoryModal();
      if (target.closest("[data-close-category-modal]")) return closeCategoryModal();
      if (target.closest("[data-open-asset-library]")) return openAssetLibraryModal();
      if (target.closest("[data-close-asset-library]")) return closeAssetLibraryModal();
      const customSelectToggle = target.closest("[data-custom-select-toggle]");
      if (customSelectToggle) {
        event.preventDefault();
        event.stopPropagation();
        const select = customSelectToggle.closest("[data-custom-select]");
        document.querySelectorAll(".custom-select.open").forEach((el) => { if (el !== select) el.classList.remove("open"); });
        select?.classList.toggle("open");
        return;
      }
      const customSelectOption = target.closest("[data-custom-select-option]");
      if (customSelectOption) {
        event.preventDefault();
        event.stopPropagation();
        const select = customSelectOption.closest("[data-custom-select]");
        const nodeId = select?.getAttribute("data-node-id") || "";
        const field = select?.getAttribute("data-field") || "";
        const value = customSelectOption.getAttribute("data-custom-select-option") || "";
        if (nodeId && field) updateNodeField(nodeId, field, value);
        document.querySelectorAll(".custom-select.open").forEach((el) => el.classList.remove("open"));
        return;
      }

      const runGenerate = target.closest("[data-run-generate]");
      if (runGenerate) {
        event.preventDefault();
        event.stopPropagation();
        return runGenerateNode(runGenerate.getAttribute("data-run-generate"));
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
      const imageTap = target.closest("[data-context-image]");
      if (imageTap) return openImagePreview(imageTap.getAttribute("data-context-image"));
      const actionSave = target.closest("[data-save-image-to-library]");
      if (actionSave) return saveImageUrlToLibrary(actionSave.getAttribute("data-save-image-to-library"), actionSave.getAttribute("data-image-title") || "图片素材");

      const uploadBtn = target.closest("[data-upload-image]");
      if (uploadBtn) { const input = document.getElementById(`image-file-${uploadBtn.getAttribute("data-upload-image")}`); if (input) input.click(); return; }
      const assetThumb = target.closest("[data-asset-thumb]");
      if (assetThumb && !target.closest(".canvas-context-menu")) return openImagePreview(assetThumb.getAttribute("src") || "");
      const addAssetBtn = target.closest("[data-add-asset]");
      if (addAssetBtn) { hideContextMenu(false); return insertAssetAsNode(addAssetBtn.getAttribute("data-add-asset")); }
      const renameCategoryBtn = target.closest("[data-rename-asset-category]");
      if (renameCategoryBtn) { event.stopPropagation(); return openCategoryModal("rename", { category: renameCategoryBtn.getAttribute("data-rename-asset-category") || "" }); }
      const folderBtnModal = target.closest("[data-select-asset-category-modal]");
      if (folderBtnModal) { STATE.activeAssetCategory = folderBtnModal.getAttribute("data-select-asset-category-modal") || "\u5168\u90e8"; renderLeftPanel(); return; }
      const folderBtn = target.closest("[data-select-asset-category]");
      if (folderBtn) { STATE.activeAssetCategory = folderBtn.getAttribute("data-select-asset-category") || "全部"; renderLeftPanel(); return; }
      const moveAssetBtn = target.closest("[data-move-asset]");
      if (moveAssetBtn) { hideContextMenu(false); return openCategoryModal("move", { assetId: moveAssetBtn.getAttribute("data-move-asset") || "", category: moveAssetBtn.getAttribute("data-asset-category") || DEFAULT_ASSET_CATEGORY }); }
      const deleteAssetBtn = target.closest("[data-delete-asset]");
      if (deleteAssetBtn) { hideContextMenu(false); return deleteAsset(deleteAssetBtn.getAttribute("data-delete-asset") || ""); }
      if (target.closest("#delete-current-asset-category-btn")) return deleteCurrentCategory();
      const openHistoryBtn = target.closest("[data-open-history]");
      if (openHistoryBtn) return openHistorySession(openHistoryBtn.getAttribute("data-open-history"));
      const createFromContext = target.closest("[data-context-create-node]");
      if (createFromContext) return createNodeFromContextMenu();
      const deleteFromContext = target.closest("[data-context-delete-node]");
      if (deleteFromContext) { hideContextMenu(false); return deleteNode(deleteFromContext.getAttribute("data-context-delete-node")); }
      const contextPreview = target.closest("[data-context-preview]");
      if (contextPreview) { hideContextMenu(false); return openImagePreview(contextPreview.getAttribute("data-context-preview")); }
      const contextSave = target.closest("[data-context-save-library]");
      if (contextSave) { hideContextMenu(false); return saveImageUrlToLibrary(contextSave.getAttribute("data-context-save-library"), contextSave.getAttribute("data-image-title") || "图片素材"); }
      const contextDownload = target.closest("[data-context-download-image]");
      if (contextDownload) { hideContextMenu(false); return downloadImage(contextDownload.getAttribute("data-context-download-image")); }
      const contextDeleteImage = target.closest("[data-context-delete-image]");
      if (contextDeleteImage) { hideContextMenu(false); return removeNodeImage(contextDeleteImage.getAttribute("data-context-delete-image")); }

      const nodeEl = target.closest(".node");
      if (nodeEl && !target.closest("textarea, input, select, button, a")) {
        hideContextMenu(false);
        STATE.selectedNodeId = nodeEl.getAttribute("data-node-id");
        STATE.selectedEdgeId = null;
        renderCanvas();
        return;
      }

      if (target.closest("#asset-library-modal, #asset-category-modal")) {
        if (!target.closest(".canvas-context-menu")) hideContextMenu();
        return;
      }

      if (!target.closest("textarea, input, select, button, a, .canvas-context-menu, [data-custom-select]")) {
        hideContextMenu();
        document.querySelectorAll(".custom-select.open").forEach((el) => el.classList.remove("open"));
        STATE.selectedNodeId = null;
        STATE.selectedEdgeId = null;
        renderCanvas();
      }
    });

      }

    root.addEventListener("touchend", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("[data-close-preview]")) {
        event.preventDefault();
        event.stopPropagation();
        closeImagePreview();
      }
    }, { passive: false });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && STATE.previewImageUrl) {
        event.preventDefault();
        closeImagePreview();
      }
    });

    root.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const assetThumb = target.closest("[data-asset-thumb]");
      const assetEl = target.closest(".asset-card[data-asset-id]") || (assetThumb ? assetThumb.closest(".asset-card[data-asset-id]") : null);
      if (!assetEl) return;
      clearTimeout(STATE.assetLongPressTimer);
      STATE.assetLongPressId = assetEl.getAttribute("data-asset-id") || "";
      STATE.assetLongPressTimer = window.setTimeout(() => {
        const img = assetEl.querySelector("img[data-asset-thumb]");
        showAssetContextMenu(event.clientX, event.clientY, assetEl.getAttribute("data-asset-id") || "", img ? (img.getAttribute("src") || "") : "", assetEl.getAttribute("data-asset-title") || "素材", assetEl.getAttribute("data-asset-category") || DEFAULT_ASSET_CATEGORY);
      }, 420);
    });
    root.addEventListener("pointermove", () => { if (STATE.assetLongPressTimer) { clearTimeout(STATE.assetLongPressTimer); STATE.assetLongPressTimer = null; } });
    root.addEventListener("pointerup", () => { if (STATE.assetLongPressTimer) { clearTimeout(STATE.assetLongPressTimer); STATE.assetLongPressTimer = null; } });
    root.addEventListener("pointercancel", () => { if (STATE.assetLongPressTimer) { clearTimeout(STATE.assetLongPressTimer); STATE.assetLongPressTimer = null; } });

    board.addEventListener("dblclick", (event) => {
      const target = event.target;
      const nodeHit = target && target.closest ? target.closest(".node") : null;
      const edgeHit = target && target.closest ? target.closest("[data-edge-id]") : null;
      if (nodeHit || edgeHit) return;
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
      if (eventTarget instanceof HTMLElement && eventTarget.closest('.node-body textarea, .node-body input, .node-body select, .node-body button, .node-body label, .node-body option')) {
        return;
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
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("textarea, input, select, a, .canvas-context-menu")) { event.stopPropagation(); return; }
      const actionBtn = target.closest("button");
      if (actionBtn) {
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
      if (board && event.button === 0 && !STATE.panning && !STATE.draggingNodeId && !STATE.connectionDrag && !STATE.activePointerId) {
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
        updateWorldTransform();
        return;
      }
      if (STATE.connectionDrag) updateConnectionDrag(event.clientX, event.clientY);
    });

    window.addEventListener("mouseup", (event) => {
      if (STATE.assetLibraryDrag.active) {
        STATE.assetLibraryDrag.active = false;
        return;
      }
      if (STATE.draggingNodeId) { STATE.draggingNodeId = null; STATE.dragFramePending = false; persistCanvasState(); }
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

    const pointerBoard = document.getElementById("canvas-board-wrap") || document.getElementById("canvas-board");
    if (pointerBoard) {
      const syncPointer = (event) => {
        STATE.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY, target: event.target });
      };
      const clearPointer = (pointerId) => {
        STATE.activePointers.delete(pointerId);
      };
      const getPointerList = () => Array.from(STATE.activePointers.entries());
      const getDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const getCenter = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

      pointerBoard.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse") return;
        syncPointer(event);
        const target = event.target;
        if (STATE.contextMenu.visible) {
          if (target && target.closest && target.closest('.canvas-context-menu')) return;
          hideContextMenu();
          return;
        }
        const port = target && target.closest ? target.closest('.port-handle.output') : null;
        if (port && STATE.activePointers.size === 1) {
          STATE.activePointerId = event.pointerId;
          beginConnectionDrag(port.getAttribute("data-node-id"), event.clientX, event.clientY);
          if (pointerBoard.setPointerCapture) pointerBoard.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        if (STATE.activePointers.size >= 2) {
          const [, p1] = getPointerList()[0];
          const [, p2] = getPointerList()[1];
          STATE.panning = false;
          STATE.draggingNodeId = null;
          STATE.activePointerId = null;
          STATE.pinchStartDistance = getDistance(p1, p2) || 1;
          STATE.pinchStartZoom = STATE.zoom;
          const center = getCenter(p1, p2);
          STATE.pinchCenterClientX = center.x;
          STATE.pinchCenterClientY = center.y;
          event.preventDefault();
          return;
        }
        const nodeEl = target && target.closest ? target.closest('.node[data-node-id]') : null;
        const portEl = target && target.closest ? target.closest('.port-handle') : null;
        const formEl = target && target.closest ? target.closest('.node-body textarea, .node-body input, .node-body select, .node-body button, .node-body label, .node-body option') : null;
        if (portEl && !port) return;
        if (formEl) return;
        if (nodeEl) {
          const node = getNode(nodeEl.getAttribute("data-node-id"));
          STATE._lastTapTime = 0; STATE._lastTapTarget = null;
          if (!node) return;
          const point = clientToCanvasPoint(event.clientX, event.clientY);
          STATE.draggingNodeId = node.id;
          STATE.dragOffsetX = point.x - node.x;
          STATE.dragOffsetY = point.y - node.y;
          STATE.activePointerId = event.pointerId;
          STATE.dragMoved = false;
          if (pointerBoard.setPointerCapture) pointerBoard.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
        const isField = target && target.closest && target.closest('input, textarea, select, button, a, .canvas-left, .canvas-context-menu, .node-body');
        if (isField) return;
        if (document.activeElement && document.activeElement.matches('textarea, input, select')) document.activeElement.blur();
        const now = Date.now();
        if (STATE._lastTapTime && now - STATE._lastTapTime < 350 && STATE._lastTapTarget === 'board') {
          STATE._lastTapTime = 0;
          STATE._lastTapTarget = null;
          const pt = clientToCanvasPoint(event.clientX, event.clientY);
          addNodeAt(pt.x, pt.y);
          event.preventDefault();
          return;
        }
        STATE._lastTapTime = now;
        STATE._lastTapTarget = 'board';
        STATE.panning = true;
        STATE.dragMoved = false;
        STATE.activePointerId = event.pointerId;
        STATE.panStartX = event.clientX - STATE.panX;
        STATE.panStartY = event.clientY - STATE.panY;
        pointerBoard.classList.add("panning");
        if (pointerBoard.setPointerCapture) pointerBoard.setPointerCapture(event.pointerId);
        event.preventDefault();
      }, { passive: false });

      pointerBoard.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse") return;
        syncPointer(event);
        if (STATE.connectionDrag && STATE.activePointerId === event.pointerId) {
          updateConnectionDrag(event.clientX, event.clientY);
          event.preventDefault();
          return;
        }
        if (STATE.activePointers.size >= 2) {
          const [, p1] = getPointerList()[0];
          const [, p2] = getPointerList()[1];
          const distance = getDistance(p1, p2);
          const center = getCenter(p1, p2);
          const nextZoom = STATE.pinchStartZoom * (distance / Math.max(1, STATE.pinchStartDistance));
          applyZoom(nextZoom, center.x, center.y);
          event.preventDefault();
          return;
        }
        if (STATE.activePointerId !== event.pointerId) return;
        if (STATE.draggingNodeId) {
          const point = clientToCanvasPoint(event.clientX, event.clientY);
          const node = getNode(STATE.draggingNodeId);
          if (!node) return;
          node.x = point.x - STATE.dragOffsetX;
          node.y = point.y - STATE.dragOffsetY;
          STATE.dragMoved = true;
          updateDraggedNodePosition(node);
          requestCanvasOverlayRefresh();
          event.preventDefault();
          return;
        }
        if (STATE.panning) {
          STATE.dragMoved = true;
          STATE.panX = event.clientX - STATE.panStartX;
          STATE.panY = event.clientY - STATE.panStartY;
          updateWorldTransform();
          event.preventDefault();
        }
      }, { passive: false });

      const finishPointer = (event) => {
        if (STATE.connectionDrag && STATE.activePointerId === event.pointerId) {
          finishConnectionDrag(event.clientX, event.clientY);
        }
        if (STATE.activePointerId === event.pointerId) {
          if (STATE.draggingNodeId) {
            STATE.draggingNodeId = null;
            STATE.dragFramePending = false;
            persistCanvasState();
          }
          if (STATE.panning) {
            STATE.panning = false;
            pointerBoard.classList.remove("panning");
            if (!STATE.dragMoved && !STATE.contextMenu.visible) {
              STATE.selectedNodeId = null;
              STATE.selectedEdgeId = null;
              STATE.selectedNodeIds = [];
              renderCanvas();
            }
            persistCurrentHistory();
            persistCanvasState();
          }
          STATE.activePointerId = null;
        }
        clearPointer(event.pointerId);
        if (STATE.activePointers.size < 2) {
          STATE.pinchStartDistance = 0;
        }
      };
      pointerBoard.addEventListener("pointerup", finishPointer);
      pointerBoard.addEventListener("pointercancel", finishPointer);
    }

    const wheelBoard = document.getElementById("canvas-board");
    if (wheelBoard) {
      wheelBoard.addEventListener("wheel", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest('select, input, textarea')) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? -0.08 : 0.08;
        applyZoom(STATE.zoom + delta, event.clientX, event.clientY);
      }, { passive: false });
    }

    const menuRoot = document.getElementById("canvas-context-menu-root");
    if (menuRoot) {
      menuRoot.addEventListener("touchend", (event) => {
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target) return;
        const btn = target.closest(".canvas-context-menu button");
        if (btn) {
          event.preventDefault();
          btn.click();
        }
      });
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
      if (meta && event.key.toLowerCase() === "z" && !typing && inImageTab) {
        event.preventDefault();
        undoCanvas();
        return;
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
  function addNodeAt(x, y) { pushUndoSnapshot(); const node = createNode(x, y); STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function createNode(x, y) { return { id: makeId(), x: Math.round(x), y: Math.round(y), prompt: "", negativePrompt: DEFAULT_NEGATIVE_PROMPT, resolution: RESOLUTION_PRESETS[0], ratio: RATIO_PRESETS[0], count: 1, modelId: String(getDefaultImageConfigId() || ""), imageUrl: "", imageBase64: "", displayImageUrl: "", assetId: "", outputAssetId: "", outputImages: [], busy: false }; }
  function createResultNodeFromSource(sourceNode, imageUrl, index, total) { const node = createNode(sourceNode.x + 460, sourceNode.y + (index * 80)); node.prompt = sourceNode.prompt || ""; node.negativePrompt = sourceNode.negativePrompt || DEFAULT_NEGATIVE_PROMPT; node.resolution = sourceNode.resolution || RESOLUTION_PRESETS[0]; node.ratio = sourceNode.ratio || RATIO_PRESETS[0]; node.modelId = String(sourceNode.modelId || getDefaultImageConfigId() || ""); node.outputImages = imageUrl ? [imageUrl] : []; node.displayImageUrl = imageUrl || ""; node.imageUrl = ""; node.imageBase64 = ""; return node; }
  function getDefaultImageConfigId() { const list = getImageConfigList(); return String(list[0]?.id || ""); }
  function syncNodeModelDefaults() {
    STATE.nodes.forEach(function(n) { n.busy = false; });
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
  function canvasDebugLog(scope, message, extra) {
    try {
      console.log(`[canvas][${scope}] ${message}`, extra || "");
    } catch (error) {
      console.log("[canvas][debug] log failed", error && error.message ? error.message : error);
    }
  }

  function compactImageValue(value) {
    const text = String(value || "");
    if (!text) return "";
    if (text.startsWith("data:image/")) return "";
    if (text.length > 400000) return "";
    return text;
  }
  function sanitizeNodeForStorage(node) {
    return {
      ...node,
      imageUrl: compactImageValue(node.imageUrl),
      imageBase64: "",
      displayImageUrl: compactImageValue(node.displayImageUrl),
      outputAssetId: String(node.outputAssetId || ""),
      outputImages: [],
    };
  }
  function sanitizeAssetForStorage(asset) {
    return {
      ...asset,
      imageUrl: compactImageValue(asset.imageUrl),
      imageBase64: "",
      displayImageUrl: compactImageValue(asset.displayImageUrl)
    };
  }
  function getDirectDisplayImageUrl(value, base64 = "") {
    const direct = String(value || "").trim();
    if (direct) return direct;
    return base64 ? `data:image/png;base64,${base64}` : "";
  }

  function updateDraggedNodePosition(node) {
    const el = document.querySelector(`.node[data-node-id="${node.id}"]`);
    if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
  }
  function computeEdgeGeometry(edge) {
    const fromNode = getNode(edge.from), toNode = getNode(edge.to);
    if (!fromNode || !toNode) return null;
    const from = getPortPosition(fromNode, "output"), to = getPortPosition(toNode, "input");
    const distance = Math.max(140, Math.abs(to.x - from.x) * 0.42);
    const c1x = from.x + distance, c2x = to.x - distance;
    const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
    const midX = (from.x + to.x) / 2, midY = (from.y + to.y) / 2;
    const length = Math.max(44, Math.hypot(to.x - from.x, to.y - from.y) * 0.35);
    const angle = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
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
        const visible = svg.querySelector(`path.edge-visible[data-edge-id="${edge.id}"]`);
        if (!hit || !visible) { needsSvgRebuild = true; break; }
        const geom = computeEdgeGeometry(edge);
        if (!geom) continue;
        hit.setAttribute('d', geom.d);
        visible.setAttribute('d', geom.d);
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
    pushUndoSnapshot();
    STATE.nodes = STATE.nodes.filter((node) => !ids.has(node.id));
    STATE.edges = STATE.edges.filter((edge) => !ids.has(edge.from) && !ids.has(edge.to));
    STATE.selectedNodeIds = [];
    STATE.selectedNodeId = null;
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
  }
  function updateNodeField(nodeId, field, value, options = {}) {
    const node = getNode(nodeId);
    if (!node) return;
    const previousValue = node[field];
    if (field === "modelId") value = String(value || "");
    if (String(previousValue ?? "") === String(value ?? "")) return;
    pushUndoSnapshot();
    node[field] = value;
    persistCurrentHistory();
    persistCanvasState();
    if (options.rerender !== false || field === "modelId") renderCanvas();
  }
  function deleteNode(nodeId) { hideContextMenu(false); pushUndoSnapshot(); STATE.nodes = STATE.nodes.filter((node) => node.id !== nodeId); STATE.edges = STATE.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId); if (STATE.selectedNodeId === nodeId) STATE.selectedNodeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
  function deleteEdge(edgeId) { pushUndoSnapshot(); STATE.edges = STATE.edges.filter((edge) => edge.id !== edgeId); if (STATE.selectedEdgeId === edgeId) STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); }

  async function loadImageToNode(nodeId, file) {
    const base64Payload = await fileToBase64(file);
    const node = getNode(nodeId);
    if (!node) return;
    node.imageUrl = base64Payload.dataUrl; node.imageBase64 = base64Payload.base64; node.displayImageUrl = base64Payload.dataUrl; renderCanvas();
    var persistedUrl = await persistRuntimeImageUrl(base64Payload.dataUrl, "upload");
    if (persistedUrl && persistedUrl !== base64Payload.dataUrl) { node.imageUrl = persistedUrl; node.displayImageUrl = persistedUrl; node.imageBase64 = ""; }
    const asset = await saveAssetFile({ title: file.name || "粘贴图片", source: "素材库", category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY, mime_type: file.type || "image/png", image_base64: base64Payload.base64 });
    if (asset) { node.assetId = asset.id; if (asset.imageUrl) { node.imageUrl = asset.imageUrl; node.displayImageUrl = asset.imageUrl; } node.imageBase64 = ""; mergeAssetIntoLibrary(asset); }
    persistCanvasState(); renderCanvas(); renderLeftPanel();
  }

  async function selectCategoryForSave(title = "图片素材", imageUrl = "") {
    return new Promise((resolve) => {
      STATE.categoryModal = { visible: true, mode: "save", targetImageUrl: imageUrl || "", targetTitle: title || "图片素材", targetAssetId: "", initialValue: "", category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY, resolver: resolve };
      renderLeftPanel();
      requestAnimationFrame(() => document.getElementById("asset-category-modal-select")?.focus());
    });
  }

  async function persistRuntimeImageUrl(imageUrl, prefix = "asset") {
    const text = String(imageUrl || "");
    if (!text.startsWith("data:image/")) return text;
    const mimeMatch = text.match(/^data:(image\/[^;]+);base64,/i);
    const mimeType = mimeMatch ? mimeMatch[1] : "image/png";
    const base64 = text.includes(",") ? text.split(",")[1] : "";
    const saved = await persistImageBase64ToLocalFile(base64, mimeType, prefix);
    return saved || text;
  }

  async function persistImageBase64ToLocalFile(base64, mimeType = "image/png", prefix = "asset") {
    try {
      if (!base64 || !window.LiuHuiGallery || typeof window.LiuHuiGallery.saveBase64ToAppFile !== "function") return "";
      const result = String(window.LiuHuiGallery.saveBase64ToAppFile(base64, mimeType, prefix) || "");
      console.log("[canvas][file] native save result", result);
      if (!result.startsWith("OK:")) {
        console.warn("[canvas] saveBase64ToAppFile failed", result);
        return "";
      }
      const rawPath = result.slice(3);
      const finalUrl = (window.Capacitor && typeof window.Capacitor.convertFileSrc === "function") ? window.Capacitor.convertFileSrc(rawPath) : rawPath;
      console.log("[canvas][file] converted file src", { rawPath, finalUrl });
      return finalUrl;
    } catch (error) {
      console.warn("[canvas] persistImageBase64ToLocalFile error", error);
      return "";
    }
  }

  async function saveAssetFile(payload) {
    try {
      if (payload && payload.image_base64 && !payload.imageUrl) {
        const persisted = await persistImageBase64ToLocalFile(payload.image_base64, payload.mime_type || "image/png", "asset");
        payload.imageUrl = persisted || `data:image/png;base64,${payload.image_base64.replace(/^data:image\/[^;]+;base64,/, '')}`;
      }
      if (payload && payload.imageUrl && payload.imageUrl.startsWith("data:image/")) {
        const persisted = await persistRuntimeImageUrl(payload.imageUrl, "asset");
        if (persisted && !persisted.startsWith("data:")) payload.imageUrl = persisted;
      }
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
    STATE.connectionDragMoved = false;
    STATE.connectionDragStartClientX = clientX;
    STATE.connectionDragStartClientY = clientY;
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
      const distance = Math.max(140, Math.abs(to.x - from.x) * 0.42);
      const c1x = from.x + distance, c2x = to.x - distance;
      const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
      if (!activePath) {
        activePath = document.createElementNS(SVG_NS, 'path');
        activePath.setAttribute('class', 'edge-visible');
        activePath.setAttribute('data-active', '1');
        activePath.setAttribute('stroke', '#34d399');
        activePath.setAttribute('stroke-width', '3.5');
        activePath.setAttribute('stroke-dasharray', '8 6');
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
  function updateConnectionDrag(clientX, clientY) { if (!STATE.connectionDrag) return; const dx = clientX - STATE.connectionDragStartClientX; const dy = clientY - STATE.connectionDragStartClientY; if (!STATE.connectionDragMoved && Math.hypot(dx, dy) < 14) return; STATE.connectionDragMoved = true; const point = clientToCanvasPoint(clientX, clientY); STATE.connectionDrag.current = point; const nearest = findNearestInputPort(point, STATE.connectionDrag.fromNodeId); STATE.connectionDrag.targetNodeId = nearest ? nearest.nodeId : null; updateActiveConnectionVisuals(); }
  function finishConnectionDrag(clientX, clientY) { if (!STATE.connectionDrag) return; updateConnectionDrag(clientX, clientY); if (!STATE.connectionDragMoved) { STATE.connectionDrag = null; renderCanvas(); return; } const fromNodeId = STATE.connectionDrag.fromNodeId; let targetNodeId = STATE.connectionDrag.targetNodeId; const releasePoint = clientToCanvasPoint(clientX, clientY); if (!targetNodeId) { pushUndoSnapshot(); const newNode = createNode(releasePoint.x, releasePoint.y - 80); STATE.nodes.push(newNode); targetNodeId = newNode.id; } if (targetNodeId && targetNodeId !== fromNodeId) { const exists = STATE.edges.some((edge) => edge.from === fromNodeId && edge.to === targetNodeId); if (!exists) { pushUndoSnapshot(); STATE.edges.push({ id: makeId(), from: fromNodeId, to: targetNodeId }); } STATE.selectedNodeId = targetNodeId; STATE.selectedEdgeId = null; persistCanvasState(); } STATE.connectionDrag = null; STATE.connectionDragMoved = false; renderCanvas(); renderLeftPanel(); }
  function findNearestInputPort(point, excludeNodeId) { const positions = STATE.connectionDrag && STATE.connectionDrag.inputPortPositions; let best = null; for (const node of STATE.nodes) { if (node.id === excludeNodeId) continue; const port = (positions && positions[node.id]) || getPortPosition(node, "input"); const distance = Math.hypot(point.x - port.x, point.y - port.y); if (distance <= SNAP_DISTANCE && (!best || distance < best.distance)) best = { nodeId: node.id, distance }; } return best; }
  function getLinkedImageNodes(nodeId) {
    return STATE.edges
      .filter((item) => item.to === nodeId)
      .map((edge) => getNode(edge.from))
      .filter(Boolean)
      .map((upstream) => {
        if (upstream.outputAssetId) {
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
    if (!node.prompt?.trim()) { console.log("[生成] 提示词为空，弹出alert"); return alert("请先输入提示词"); }
    if (!node.modelId) { console.log("[生成] modelId为空，弹出alert"); return alert("请先配置图片模型"); }
    pushUndoSnapshot();
    node.busy = true;
    renderCanvas();
    const { width, height } = resolveCanvasSize(node.resolution, node.ratio);
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const refImages = (await Promise.all([
      ...linkedImageNodes.map((item) => item.imageBase64 || extractBase64(item.imageUrl) || resolveImageToBase64(item.imageUrl)),
      ...(node.imageBase64 ? [Promise.resolve(node.imageBase64)] : []),
    ])).filter(Boolean);
    const alreadyDisplayingImage = Boolean((node.outputImages && node.outputImages.length) || node.imageUrl);
    console.log("[生成][参考图] 上游节点数:", linkedImageNodes.length, "本节点自带参考图:", Boolean(node.imageBase64), "最终 refImages 数量:", refImages.length, "image_base64_list_lengths:", refImages.map((item) => (item || "").length), "refImages_previews:", refImages.map((item) => String(item || "").slice(0, 40)));
    try {
      const totalCount = Math.max(1, Number(node.count || 1));
      const jobs = Array.from({ length: totalCount }).map(async (_, index) => {
        console.log("[生成] 发起请求到 /api/image/generate, config_id:", node.modelId, "prompt:", node.prompt.slice(0, 60), "job:", index + 1, "/", totalCount);
        const res = await fetch("/api/image/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config_id: node.modelId, prompt: node.prompt, negative_prompt: node.negativePrompt || DEFAULT_NEGATIVE_PROMPT, width, height, image_base64: refImages[0] || null, image_base64_list: refImages, n: 1 }),
        });
        console.log("[生成] 响应状态:", res.status, "job:", index + 1);
        const result = await res.json();
        if (!res.ok || result.code !== 0) throw new Error(result.detail || result.message || `生成失败（第${index + 1}张）`);
        const images = (result.data || []).map((item) => normalizeImageResult(item)).filter(Boolean);
        let imageUrl = images[0] || "";
        imageUrl = await persistRuntimeImageUrl(imageUrl, "node");
        if (!imageUrl) throw new Error(`生成结果为空（第${index + 1}张）`);
        const generatedAsset = await saveAssetFile({ title: `${(node.prompt || "生成图片").trim().slice(0, 24) || "生成图片"}-${index + 1}`, source: "生成结果", category: STATE.pendingAssetCategory || DEFAULT_ASSET_CATEGORY, imageUrl });
        if (alreadyDisplayingImage) {
          const resultNode = createResultNodeFromSource(node, imageUrl, index, totalCount);
          if (generatedAsset) { resultNode.outputAssetId = generatedAsset.id; resultNode.imageUrl = generatedAsset.imageUrl || resultNode.imageUrl; resultNode.displayImageUrl = generatedAsset.imageUrl || resultNode.displayImageUrl; mergeAssetIntoLibrary(generatedAsset); }
          STATE.nodes.push(resultNode);
          STATE.edges.push({ id: makeId(), from: node.id, to: resultNode.id });
          STATE.selectedNodeId = resultNode.id;
        } else if (index === 0) {
          node.outputImages = [];
          node.outputAssetId = generatedAsset?.id || node.outputAssetId || "";
          node.displayImageUrl = (generatedAsset?.imageUrl || imageUrl || node.displayImageUrl || "");
          if (generatedAsset) { node.imageUrl = generatedAsset.imageUrl || node.imageUrl; mergeAssetIntoLibrary(generatedAsset); }
          STATE.selectedNodeId = node.id;
        } else {
          const resultNode = createResultNodeFromSource(node, imageUrl, index, totalCount);
          if (generatedAsset) { resultNode.outputAssetId = generatedAsset.id; resultNode.imageUrl = generatedAsset.imageUrl || resultNode.imageUrl; resultNode.displayImageUrl = generatedAsset.imageUrl || resultNode.displayImageUrl; mergeAssetIntoLibrary(generatedAsset); }
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

  function renderCanvas() {
    const world = document.getElementById("canvas-world"), nodeLayer = document.getElementById("canvas-node-layer"), edgeDomLayer = document.getElementById("edge-dom-layer"), svg = document.getElementById("canvas-svg"), empty = document.getElementById("canvas-empty-tip"), menuRoot = document.getElementById("canvas-context-menu-root");
    if (!world || !nodeLayer || !edgeDomLayer || !svg || !menuRoot) return;
    console.log(`[canvas][render] nodes=${STATE.nodes.length} edges=${STATE.edges.length} history=${STATE.historySessions.length} current=${STATE.currentHistoryId || ""}`);
    updateWorldTransform();
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
        patchExistingNode(existing, node);
        if (prevEl && prevEl.nextElementSibling !== existing) {
          nodeLayer.insertBefore(existing, prevEl.nextElementSibling);
        }
        prevEl = existing;
      } else {
        const tmp = document.createElement('div');
        tmp.innerHTML = renderNode(node);
        const newEl = tmp.firstElementChild;
        if (prevEl && prevEl.nextElementSibling) {
          nodeLayer.insertBefore(newEl, prevEl.nextElementSibling);
        } else {
          nodeLayer.appendChild(newEl);
        }
        prevEl = newEl;
      }
    }
  }

  function patchExistingNode(el, node) {
    el.style.left = `${node.x}px`;
    el.style.top = `${node.y}px`;
    const selected = STATE.selectedNodeId === node.id;
    const multiSelected = STATE.selectedNodeIds.includes(node.id);
    const linkedHighlight = STATE.connectionDrag?.targetNodeId === node.id;
    el.classList.toggle('selected', selected);
    el.classList.toggle('multi-selected', multiSelected);
    el.classList.toggle('node-link-highlight', linkedHighlight);
    const portOffsetY = getPortOffsetY(node);
    el.querySelectorAll('.port-handle').forEach((p) => { p.style.top = `${portOffsetY}px`; });
    const { outputPreview, displayImageUrl } = resolveNodeDisplayImage(node);
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const upstreamPreviewUrl = (!displayImageUrl && linkedImageNode && linkedImageNode.imageUrl) ? linkedImageNode.imageUrl : "";
    const effectivePreviewUrl = displayImageUrl || upstreamPreviewUrl;
    const imgWrap = el.querySelector('.node-image-wrap');
    if (imgWrap) {
      const img = imgWrap.querySelector('img[alt="node-image"], img[alt="upstream-image"]');
      if (displayImageUrl) {
        const imageTitle = outputPreview ? `生成结果 · ${node.prompt || '画布图片'}` : (node.prompt || '画布图片');
        if (img) {
          if (img.getAttribute('src') !== displayImageUrl) img.src = displayImageUrl;
          img.setAttribute('data-context-image', displayImageUrl);
          img.setAttribute('data-image-title', imageTitle);
          if (!imgWrap.querySelector('.node-close-image-btn')) { const cb = document.createElement('button'); cb.className = 'node-close-image-btn'; cb.type = 'button'; cb.setAttribute('data-context-delete-image', node.id); cb.innerHTML = '<i class="fa fa-times"></i> \u5173\u95ed'; imgWrap.appendChild(cb); }
        } else {
          const emptyDiv = imgWrap.querySelector('.node-image-empty');
          if (emptyDiv) emptyDiv.remove();
          const newImg = document.createElement('img');
          newImg.alt = 'node-image';
          newImg.src = displayImageUrl;
          newImg.setAttribute('data-context-image', displayImageUrl);
          newImg.setAttribute('data-image-title', imageTitle);
          imgWrap.insertBefore(newImg, imgWrap.firstChild);
        }
        const actionsDiv = imgWrap.querySelector('.node-image-actions');
        if (actionsDiv) actionsDiv.remove();
      } else if (upstreamPreviewUrl) {
        if (img) img.remove(); const _closeBtn = imgWrap.querySelector(".node-close-image-btn"); if (_closeBtn) _closeBtn.remove();
        let emptyDiv = imgWrap.querySelector('.node-image-empty');
        if (!emptyDiv) {
          emptyDiv = document.createElement('div');
          emptyDiv.className = 'node-image-empty';
          imgWrap.insertBefore(emptyDiv, imgWrap.firstChild);
        }
        emptyDiv.textContent = `已连接 ${linkedImageNodes.length} 个上游参考图，当前节点将使用它们生成。`;
        const actionsDiv = imgWrap.querySelector('.node-image-actions');
        if (actionsDiv) actionsDiv.remove();
      } else {
        if (img) img.remove(); const _closeBtn = imgWrap.querySelector(".node-close-image-btn"); if (_closeBtn) _closeBtn.remove();
        if (!imgWrap.querySelector('.node-image-empty')) {
          const emptyDiv = document.createElement('div');
          emptyDiv.className = 'node-image-empty';
          emptyDiv.textContent = linkedImageNodes.length ? `已连接 ${linkedImageNodes.length} 个上游参考图，当前节点将使用它们生成。` : '上传一张参考图，或者把一个带图片的上游节点连到这里。';
          imgWrap.insertBefore(emptyDiv, imgWrap.firstChild);
        }
        if (!linkedImageNode && !imgWrap.querySelector('.node-image-actions')) {
          const actions = document.createElement('div');
          actions.className = 'node-image-actions';
          actions.innerHTML = `<button class="btn btn-default" type="button" data-upload-image="${node.id}">上传参考图</button>`;
          imgWrap.appendChild(actions);
        }
      }
      const banner = imgWrap.querySelector('.node-linked-banner');
      if (linkedImageNodes.length && !banner) {
        const b = document.createElement('div');
        b.className = 'node-linked-banner';
        b.textContent = `已引用 ${linkedImageNodes.length} 个上游节点图片作为参考图`;
        imgWrap.appendChild(b);
      } else if (!linkedImageNodes.length && banner) {
        banner.remove();
      } else if (banner && linkedImageNodes.length) {
        banner.textContent = `已引用 ${linkedImageNodes.length} 个上游节点图片作为参考图`;
      }
    }
    el.querySelectorAll('[data-custom-select][data-field]').forEach(function(sel) {
      var field = sel.getAttribute('data-field');
      if (sel.getAttribute('data-node-id') !== node.id) return;
      var val = String(node[field] || '');
      var span = sel.querySelector('.custom-select-value');
      var opts = sel.querySelectorAll('.custom-select-option');
      opts.forEach(function(o) {
        var isActive = o.getAttribute('data-custom-select-option') === val;
        o.classList.toggle('active', isActive);
        if (isActive && span) span.textContent = o.textContent;
      });
    });
    var modelCfg = getImageConfigById(node.modelId) || getImageConfigById(getDefaultImageConfigId());
    var modelNameEl = el.querySelector('.canvas-node-model-name');
    if (modelNameEl) modelNameEl.textContent = modelCfg && (modelCfg.model_name || modelCfg.name) || '未选择模型';
    var modelIconEl = el.querySelector('.canvas-node-model-icon');
    if (modelIconEl && window.renderModelIcon) {
      var icon = window.renderModelIcon(modelCfg && (modelCfg.model_name || modelCfg.name) || '', { size: 18 });
      modelIconEl.innerHTML = icon || '<i class="fa fa-cube"></i>';
    }
    const genBtn = el.querySelector('[data-run-generate]');
    if (genBtn) genBtn.textContent = node.busy ? "生成中..." : "开始生成";
  }

  function renderLeftPanel() {
    const library = document.getElementById("canvas-library-list"), history = document.getElementById("canvas-history-list"), categoryFilter = document.getElementById("asset-category-filter"), assetsRoot = document.getElementById("assets-library-root"), modalFilter = document.getElementById("asset-category-filter-modal"), folderList = document.getElementById("asset-folder-list"), assetGrid = document.getElementById("asset-library-grid"), currentFolder = document.getElementById("asset-library-current-folder"), modal = document.getElementById("asset-library-modal"), categoryModal = document.getElementById("asset-category-modal"), categoryModalTitle = document.getElementById("asset-category-modal-title"), categoryModalSubtitle = document.getElementById("asset-category-modal-subtitle"), categoryModalInput = document.getElementById("asset-category-modal-input"), categoryModalSelect = document.getElementById("asset-category-modal-select");
    const categories = getAssetCategories(), filteredAssets = getFilteredAssets(), visibleAssets = filteredAssets.filter((item) => getDirectDisplayImageUrl(item.displayImageUrl) || getDirectDisplayImageUrl(item.imageUrl, item.imageBase64));
    const sortedHistory = [...STATE.historySessions].sort((a, b) => {
      const aScore = ((a.snapshot?.nodes || []).length || 0) + (((a.snapshot?.edges || []).length || 0) * 0.1);
      const bScore = ((b.snapshot?.nodes || []).length || 0) + (((b.snapshot?.edges || []).length || 0) * 0.1);
      if (bScore !== aScore) return bScore - aScore;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    const categoryOptions = ["全部", ...categories].map((name) => `<option value="${escapeHtml(name)}" ${name === STATE.activeAssetCategory ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    const moveOptions = categories.map((name) => `<option value="${escapeHtml(name)}" ${name === (STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY) ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
    if (categoryFilter) categoryFilter.innerHTML = categoryOptions;
    // modalFilter dropdown removed - using folder list
    if (library) library.innerHTML = `<button class="canvas-open-assets-btn" type="button" data-open-asset-library="1"><span class="canvas-open-assets-icon"><i class="fa fa-folder-open-o"></i></span><span class="canvas-open-assets-text">素材</span></button>`;
    if (assetsRoot) assetsRoot.innerHTML = ``;
    if (folderList) folderList.innerHTML = ["\u5168\u90e8", ...categories].map(function(name) { var isActive = name === STATE.activeAssetCategory; var count = name === "\u5168\u90e8" ? STATE.assetLibrary.length : STATE.assetLibrary.filter(function(a) { return (a.category || "\u672a\u5206\u7c7b") === name; }).length; var renameBtn = isActive && name !== "\u5168\u90e8" ? '<button class="folder-rename-btn" type="button" data-rename-asset-category="' + escapeHtml(name) + '">\u91cd\u547d\u540d</button>' : ""; return '<div class="asset-folder-item ' + (isActive ? "active" : "") + '" data-select-asset-category-modal="' + escapeHtml(name) + '"><span class="folder-name">' + escapeHtml(name) + ' (' + count + ')</span>' + renameBtn + '</div>'; }).join("");
    if (currentFolder) currentFolder.textContent = `${STATE.activeAssetCategory || "全部"} · ${filteredAssets.length} 个素材`;
    if (assetGrid) assetGrid.innerHTML = visibleAssets.length ? visibleAssets.map((item) => { const assetImage = getDirectDisplayImageUrl(item.displayImageUrl) || getDirectDisplayImageUrl(item.imageUrl, item.imageBase64); canvasDebugLog("asset", "render asset card", { id: item.id, title: item.title || "", category: item.category || DEFAULT_ASSET_CATEGORY, imageUrlLength: String(item.imageUrl || "").length, imageBase64Length: String(item.imageBase64 || "").length, finalAssetImageLength: String(assetImage || "").length, finalAssetImagePreview: String(assetImage || "").slice(0, 120) }); return `<article class="asset-card" data-asset-id="${item.id}" data-asset-category="${escapeHtml(item.category || DEFAULT_ASSET_CATEGORY)}" data-asset-title="${escapeHtml(item.title || "素材")}">${assetImage ? `<img src="${assetImage}" alt="${escapeHtml(item.title || "素材")}" data-asset-thumb="1" onerror="console.log('[canvas][img] asset img error', this.src)" onload="console.log('[canvas][img] asset img ok', this.src)">` : ``}</article>`; }).join("") : `<div class="canvas-empty-card">${filteredAssets.length ? '当前分类下有素材，但缺少可显示图片。' : (STATE.assetLibrary.length ? '当前筛选下没有匹配素材。' : '还没有素材。上传图片或把生成结果加入素材库后，这里会出现。')}</div>`;
    if (modal) modal.classList.toggle("hidden", !STATE.isAssetLibraryOpen);
    if (categoryModal) categoryModal.classList.toggle("hidden", !STATE.categoryModal.visible);
    if (categoryModalTitle) categoryModalTitle.textContent = STATE.categoryModal.mode === 'rename' ? '重命名分类' : (STATE.categoryModal.mode === 'move' ? '移动素材分类' : (STATE.categoryModal.mode === 'save' ? '选择保存分类' : '新建分类'));
    if (categoryModalSubtitle) categoryModalSubtitle.textContent = STATE.categoryModal.mode === 'rename' ? '输入新的分类名称，界面与本地文件夹都会同步更新。' : (STATE.categoryModal.mode === 'move' ? '选择一个目标分类，素材文件会移动到对应本地文件夹。' : (STATE.categoryModal.mode === 'save' ? '请选择这张图片要加入到哪个分类。' : '输入新的分类名称并确认。'));
    if (categoryModalInput) { categoryModalInput.style.display = (STATE.categoryModal.mode === 'move' || STATE.categoryModal.mode === 'save') ? 'none' : 'block'; categoryModalInput.value = STATE.categoryModal.initialValue || ''; }
    if (categoryModalSelect) { categoryModalSelect.style.display = (STATE.categoryModal.mode === 'move' || STATE.categoryModal.mode === 'save') ? 'block' : 'none'; categoryModalSelect.innerHTML = categories.map(function(name) { return '<div class="category-pick-item ' + (name === (STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY) ? "active" : "") + '" data-pick-category="' + escapeHtml(name) + '">' + escapeHtml(name) + '</div>'; }).join(""); }
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
  function showConfirmDialog(message) {
    return new Promise(function(resolve) {
      var mask = document.createElement("div");
      mask.className = "custom-confirm-mask";
      mask.innerHTML = '<div class="custom-confirm-box"><div class="custom-confirm-msg">' + message + '</div><div class="custom-confirm-actions"><button class="btn btn-default" data-confirm-result="cancel">\u53d6\u6d88</button><button class="btn btn-danger" data-confirm-result="ok">\u786e\u8ba4</button></div></div>';
      mask.addEventListener("click", function(e) {
        var btn = e.target.closest("[data-confirm-result]");
        if (!btn) return;
        mask.remove();
        resolve(btn.getAttribute("data-confirm-result") === "ok");
      });
      document.body.appendChild(mask);
    });
  }
  async function deleteCurrentCategory() { const category = STATE.activeAssetCategory; if (!category || category === "全部" || category === DEFAULT_ASSET_CATEGORY) return alert("这个分类不能删除"); const count = STATE.assetLibrary.filter((item) => (item.category || DEFAULT_ASSET_CATEGORY) === category).length; if (!(await showConfirmDialog(`删除分类「${category}」？这会同时删除该分类下的 ${count} 个素材。`))) return; try { const res = await fetch("/api/canvas/categories", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: category }) }); const result = await res.json(); if (!res.ok || result.code !== 0) return alert(result.detail || result.message || "删除分类失败"); STATE.categories = result.data.categories || STATE.categories; STATE.assetLibrary = result.data.assetLibrary || STATE.assetLibrary; STATE.activeAssetCategory = "全部"; renderLeftPanel(); persistCanvasState(); } catch (error) { alert(error.message || "删除分类失败"); } }
  async function deleteAsset(assetId) { const asset = STATE.assetLibrary.find((item) => item.id === assetId); if (!asset) return; if (!(await showConfirmDialog(`删除素材「${asset.title || '未命名素材'}」？`))) return; try { const res = await fetch("/api/canvas/assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ asset_id: assetId }) }); const result = await res.json(); if (!res.ok || result.code !== 0) return alert(result.detail || result.message || "删除素材失败"); STATE.categories = result.data.categories || STATE.categories; STATE.assetLibrary = result.data.assetLibrary || STATE.assetLibrary; renderLeftPanel(); persistCanvasState(); } catch (error) { alert(error.message || "删除素材失败"); } }
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
      const targetCategory = STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY;
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
      const targetCategory = STATE.categoryModal.category || DEFAULT_ASSET_CATEGORY;
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

async function downloadImage(imageUrl) {
    if (!imageUrl) return;
    try {
      const base64 = await resolveImageToBase64(imageUrl);
      const mimeType = guessMimeTypeFromImageUrl(imageUrl);
      if (window.LiuHuiGallery && typeof window.LiuHuiGallery.saveBase64Image === "function" && base64) {
        const result = String(window.LiuHuiGallery.saveBase64Image(base64, mimeType, "liuhui") || "");
        if (result.startsWith("OK:")) {
          if (typeof showToast === "function") showToast("已保存到系统图库");
          return;
        }
        console.warn("[canvas] native gallery save failed", result);
      }
      const res = await fetch(imageUrl, { cache: "no-store" });
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `canvas-image-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1200);
      if (typeof showToast === "function") showToast("已发起保存图片");
    } catch (error) {
      console.warn("[canvas] 保存图片失败", error);
      if (typeof showToast === "function") showToast("保存图片失败");
    }
  }

  function removeNodeImage(nodeId) {
    const node = getNode(nodeId);
    if (!node) return;
    hideContextMenu(false);
    node.outputImages = [];
    node.imageUrl = "";
    node.imageBase64 = "";
    node.displayImageUrl = "";
    node.assetId = "";
    node.outputAssetId = "";
    persistCanvasState();
    renderCanvas();
    renderLeftPanel();
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

  function renderCustomSelect(nodeId, field, value, options, placeholder = "请选择") {
    const current = options.find((item) => String(item.value) === String(value));
    const label = current ? current.label : placeholder;
    return `<div class="custom-select" data-custom-select data-node-id="${nodeId}" data-field="${field}"><button type="button" class="custom-select-btn" data-custom-select-toggle><span class="custom-select-value">${escapeHtml(label)}</span></button><div class="custom-select-menu">${options.map((item) => `<button type="button" class="custom-select-option ${String(item.value) === String(value) ? "active" : ""}" data-custom-select-option="${escapeHtml(item.value)}">${escapeHtml(item.label)}</button>`).join("")}</div></div>`;
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

  function resolveNodeDisplayImage(node) {
    const asset = node.assetId ? STATE.assetLibrary.find((item) => item.id === node.assetId) : null;
    const outputAsset = node.outputAssetId ? STATE.assetLibrary.find((item) => item.id === node.outputAssetId) : null;
    const outputPreview = getDirectDisplayImageUrl(outputAsset?.displayImageUrl) || getDirectDisplayImageUrl(outputAsset?.imageUrl, outputAsset?.imageBase64) || (Array.isArray(node.outputImages) ? (node.outputImages[0] || "") : (node.outputImages || ""));
    const assetImage = getDirectDisplayImageUrl(asset?.displayImageUrl) || getDirectDisplayImageUrl(asset?.imageUrl, asset?.imageBase64);
    const ownReferenceImage = getDirectDisplayImageUrl(node.imageUrl, node.imageBase64);
    const displayImageUrl = getDirectDisplayImageUrl(node.displayImageUrl) || outputPreview || ownReferenceImage || assetImage;
    canvasDebugLog("image", "resolveNodeDisplayImage", { nodeId: node.id, assetId: node.assetId || "", outputAssetId: node.outputAssetId || "", outputImagesType: Array.isArray(node.outputImages) ? "array" : typeof node.outputImages, outputPreviewLength: String(outputPreview || "").length, imageUrlLength: String(node.imageUrl || "").length, imageBase64Length: String(node.imageBase64 || "").length, displayImageUrlLength: String(displayImageUrl || "").length, directDisplayLength: String(node.displayImageUrl || "").length, assetImageUrlLength: String(asset?.imageUrl || "").length, assetDisplayImageUrlLength: String(asset?.displayImageUrl || "").length, finalPreview: String(displayImageUrl || "").slice(0, 160) });
    if (displayImageUrl && node.displayImageUrl !== displayImageUrl) node.displayImageUrl = displayImageUrl;
    if ((!node.imageUrl || node.imageUrl.startsWith("data:image/")) && assetImage && !outputPreview) node.imageUrl = assetImage;
    return { outputPreview, ownReferenceImage, displayImageUrl };
  }

  function getNodeImageState(node) {
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const { outputPreview, ownReferenceImage, displayImageUrl } = resolveNodeDisplayImage(node);
    const showingGeneratedImage = Boolean(outputPreview);
    const showingOwnReferenceImage = Boolean(!outputPreview && node.imageUrl);
    const imageTitle = showingGeneratedImage ? `生成结果 · ${node.prompt || '画布图片'}` : (node.prompt || '画布图片');
    return { linkedImageNodes, linkedImageNode, outputPreview, ownReferenceImage, displayImageUrl, showingGeneratedImage, showingOwnReferenceImage, imageTitle };
  }

  function renderNode(node) {
    console.log(`[canvas][node] enter id=${node?.id || ""} assetId=${node?.assetId || ""} imageUrlLen=${String(node?.imageUrl || "").length} displayLen=${String(node?.displayImageUrl || "").length} outputCount=${Array.isArray(node?.outputImages) ? node.outputImages.length : (node?.outputImages ? 1 : 0)}`);
    const selected = STATE.selectedNodeId === node.id ? "selected" : "";
    const multiSelected = STATE.selectedNodeIds.includes(node.id) ? "multi-selected" : "";
    const linkedHighlight = STATE.connectionDrag?.targetNodeId === node.id ? "node-link-highlight" : "";
    const modelOptions = getImageConfigList().map((c) => ({ value: String(c.id), label: `${c.name} · ${c.model_name || ""}` }));
    const resolutionOptions = RESOLUTION_PRESETS.map((size) => ({ value: size, label: size }));
    const ratioOptions = RATIO_PRESETS.map((ratio) => ({ value: ratio, label: ratio }));
    const linkedImageNodes = getLinkedImageNodes(node.id);
    const linkedImageNode = linkedImageNodes[0] || null;
    const { outputPreview, ownReferenceImage, displayImageUrl } = resolveNodeDisplayImage(node);
    const showingGeneratedImage = Boolean(outputPreview);
    const showingOwnReferenceImage = Boolean(!outputPreview && node.imageUrl);
    const imageTitle = showingGeneratedImage ? `生成结果 · ${node.prompt || '画布图片'}` : (node.prompt || '画布图片');
    const upstreamPreviewUrl = (!displayImageUrl && linkedImageNode && linkedImageNode.imageUrl) ? linkedImageNode.imageUrl : "";
    const effectivePreviewUrl = displayImageUrl;
    const effectivePreviewTitle = displayImageUrl ? imageTitle : "";
    console.log(`[canvas][node] render id=${node.id} assetId=${node.assetId || ""} src=${String(effectivePreviewUrl || "").slice(0, 180)}`);
    const previewHtml = effectivePreviewUrl ? `<img src="${effectivePreviewUrl}" alt="node-image" data-context-image="${effectivePreviewUrl}" data-image-title="${escapeHtml(effectivePreviewTitle)}" loading="lazy" decoding="async"><button class="node-close-image-btn" type="button" data-context-delete-image="${node.id}"><i class="fa fa-times"></i> \u5173\u95ed</button>` : `<div class="node-image-empty">${linkedImageNodes.length ? `已连接 ${linkedImageNodes.length} 个上游参考图，当前节点将使用它们生成。` : '上传一张参考图，或者把一个带图片的上游节点连到这里。'}</div>`;
    const overlayTop = linkedImageNodes.length ? `<div class="node-linked-banner">已引用 ${linkedImageNodes.length} 个上游节点图片作为参考图</div>` : "";
    const imageActions = (linkedImageNode || effectivePreviewUrl) ? "" : `<div class="node-image-actions"><button class="btn btn-default" type="button" data-upload-image="${node.id}">上传参考图</button></div>`;
    const modelCfg = getImageConfigById(node.modelId) || getImageConfigById(getDefaultImageConfigId());
    const rawModelIcon = modelCfg && window.renderModelIcon ? window.renderModelIcon(modelCfg.model_name || modelCfg.name || "", { size: 18, title: modelCfg.model_name || modelCfg.name || "" }) : "";
    const modelIcon = `<div class="canvas-node-model-icon">${rawModelIcon || '<i class="fa fa-cube"></i>'}</div>`;
    const modelName = escapeHtml(modelCfg?.model_name || modelCfg?.name || "未选择模型");
    return `<div class="node ${selected} ${multiSelected} ${linkedHighlight}" data-node-id="${node.id}" style="left:${node.x}px;top:${node.y}px;"><span class="port-handle input" data-node-id="${node.id}" data-side="input" style="top:${getPortOffsetY(node)}px;left:-${PORT_RADIUS}px;transform:translate(-50%,-50%);"></span><span class="port-handle output" data-node-id="${node.id}" data-side="output" style="top:${getPortOffsetY(node)}px;right:-${PORT_RADIUS}px;transform:translate(50%,-50%);"></span><div class="node-shell"><div class="node-image-wrap">${previewHtml}${overlayTop}${imageActions}<input type="file" accept="image/*" hidden id="image-file-${node.id}" data-node-id="${node.id}"></div><div class="node-divider"></div><div class="node-body"><div class="canvas-node-model">${modelIcon}<div class="canvas-node-model-text"><span class="canvas-node-model-name">${modelName}</span></div></div><div class="node-row node-prompt-cell"><textarea data-node-id="${node.id}" data-field="prompt" placeholder="描述画面，例如：霓虹夜景、电影感光影">${escapeHtml(node.prompt || "")}</textarea></div><div class="node-compact-side"><div class="node-mini-field"><label>分辨率</label>${renderCustomSelect(node.id, "resolution", node.resolution || RESOLUTION_PRESETS[0], resolutionOptions)}</div><div class="node-mini-field"><label>比例</label>${renderCustomSelect(node.id, "ratio", node.ratio || RATIO_PRESETS[0], ratioOptions)}</div><div class="node-mini-field"><label>张数</label><input type="number" min="1" max="4" value="${Number(node.count || 1)}" data-node-id="${node.id}" data-field="count"></div><div class="node-mini-field"><label>模型</label>${renderCustomSelect(node.id, "modelId", String(node.modelId || ""), modelOptions, "暂无图片模型")}</div></div><div class="node-actions"><button class="btn btn-primary" type="button" data-run-generate="${node.id}">${node.busy ? "生成中..." : "开始生成"}</button><button class="btn btn-danger" type="button" data-context-delete-node="${node.id}" title="删除节点"><i class="fa fa-trash"></i></button></div></div></div></div>`;
  }

  function renderEdge(edge) {
    const fromNode = getNode(edge.from), toNode = getNode(edge.to);
    if (!fromNode || !toNode) return "";
    const from = getPortPosition(fromNode, "output"), to = getPortPosition(toNode, "input");
    const distance = Math.max(140, Math.abs(to.x - from.x) * 0.42);
    const c1x = from.x + distance, c2x = to.x - distance;
    const d = `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
    const selected = STATE.selectedEdgeId === edge.id;
    const stroke = selected ? "#f59e0b" : "#60a5fa";
    const strokeWidth = selected ? 5 : 3.2;
    return `<path class="edge-hit" data-edge-id="${edge.id}" d="${d}"></path><path class="edge-visible ${selected ? 'edge-selected' : ''}" data-edge-id="${edge.id}" d="${d}" stroke="${stroke}" stroke-width="${strokeWidth}"></path>`;
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
    const distance = Math.max(140, Math.abs(to.x - from.x) * 0.42);
    const c1x = from.x + distance, c2x = to.x - distance;
    return `<path class="edge-visible" data-active="1" d="M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}" stroke="#34d399" stroke-width="3.5" stroke-dasharray="8 6"></path>`;
  }

  function getPortOffsetY(node) { return STATE.measuredNodeCenters[node.id] || 180; }
  function getNodeMeasuredWidth(nodeId) { const el = document.querySelector(`.node[data-node-id="${nodeId}"]`); return el ? el.offsetWidth : 186; }
  function getPortPosition(node, side) { const nodeWidth = getNodeMeasuredWidth(node.id); const pos = { x: side === "output" ? node.x + nodeWidth + PORT_RADIUS : node.x - PORT_RADIUS, y: node.y + getPortOffsetY(node) }; if (side === "output") canvasDebugLog("port", "getPortPosition", { nodeId: node.id, nodeX: node.x, nodeY: node.y, nodeWidth, portOffsetY: getPortOffsetY(node), pos }); return pos; }

  function syncMeasuredPorts() {
    const nodes = document.querySelectorAll(".node[data-node-id]");
    let changed = false;
    nodes.forEach((el) => {
      const id = el.getAttribute("data-node-id");
      const center = Math.round(el.offsetHeight / 2);
      if (id && STATE.measuredNodeCenters[id] !== center) { canvasDebugLog("port", "syncMeasuredPorts", { nodeId: id, offsetHeight: el.offsetHeight, center, width: el.offsetWidth }); STATE.measuredNodeCenters[id] = center; changed = true; }
    });
    if (changed && !STATE.connectionDrag) {
      const svg = document.getElementById("canvas-svg");
      if (svg) svg.innerHTML = [...STATE.edges.map(renderEdge), renderActiveConnection()].join("");
      const edgeDomLayer = document.getElementById("edge-dom-layer");
      if (edgeDomLayer) edgeDomLayer.innerHTML = STATE.edges.map(renderEdgeDomHit).join("");
      document.querySelectorAll(".port-handle").forEach((port) => { const nodeId = port.getAttribute("data-node-id"); port.style.top = `${STATE.measuredNodeCenters[nodeId] || 180}px`; });
    }
  }

  function updateWorldTransform() {
    const world = document.getElementById("canvas-world");
    if (world) world.style.transform = `translate(${STATE.panX}px, ${STATE.panY}px) scale(${STATE.zoom})`;
    requestCanvasOverlayRefresh();
  }

  function applyZoom(nextZoom, clientX, clientY) { const oldZoom = STATE.zoom; const rect = getBoardRect(); const anchorX = clientX ?? (rect.left + rect.width / 2); const anchorY = clientY ?? (rect.top + rect.height / 2); const worldX = (anchorX - rect.left - STATE.panX) / oldZoom; const worldY = (anchorY - rect.top - STATE.panY) / oldZoom; STATE.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(nextZoom.toFixed(2)))); STATE.panX = anchorX - rect.left - worldX * STATE.zoom; STATE.panY = anchorY - rect.top - worldY * STATE.zoom; updateWorldTransform(); persistCurrentHistory(); persistCanvasState(); }
  function openImagePreview(url) {
    if (!url) return;
    if (STATE.previewImageUrl === url) { closeImagePreview(); return; }
    STATE.previewImageUrl = url;
    const modal = document.getElementById("image-preview-modal"), target = document.getElementById("image-preview-target");
    if (modal && target) { target.src = url; modal.classList.remove("hidden"); hideContextMenu(false); resetPreviewZoom(); }
  }
  function closeImagePreview() { STATE.previewImageUrl = ""; const modal = document.getElementById("image-preview-modal"), target = document.getElementById("image-preview-target"); if (modal && target) { modal.classList.add("hidden"); target.src = ""; resetPreviewZoom(); } }

  var _pvZoom = 1, _pvPanX = 0, _pvPanY = 0, _pvPinchDist = 0, _pvPinchZoom = 1, _pvDrag = null, _pvLastTap = 0;
  function resetPreviewZoom() { _pvZoom = 1; _pvPanX = 0; _pvPanY = 0; applyPreviewTransform(); }
  function applyPreviewTransform() { var img = document.getElementById("image-preview-target"); if (img) img.style.transform = "translate(" + _pvPanX + "px," + _pvPanY + "px) scale(" + _pvZoom + ")"; }
  function _pvTouchDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }

  (function bindPreviewGestures() {
    var _pvTapTimer = null, _pvTapCount = 0, _pvTouchMoved = false, _pvTouchStartXY = null;
    function _pvIsPreviewTarget(t) {
      var modal = document.getElementById("image-preview-modal");
      if (!modal || modal.classList.contains("hidden")) return false;
      return t === modal || t.id === "image-preview-container" || t.id === "image-preview-target";
    }
    function _pvHandleTap() {
      _pvTapCount++;
      if (_pvTapTimer) clearTimeout(_pvTapTimer);
      _pvTapTimer = setTimeout(function() {
        if (_pvTapCount === 1) { closeImagePreview(); }
        else if (_pvTapCount >= 2) {
          if (_pvZoom > 1.05) { _pvZoom = 1; _pvPanX = 0; _pvPanY = 0; } else { _pvZoom = 2.5; }
          applyPreviewTransform();
        }
        _pvTapCount = 0;
      }, 180);
    }
    document.addEventListener("click", function(e) {
      if (_pvIsPreviewTarget(e.target)) { e.preventDefault(); e.stopPropagation(); _pvHandleTap(); }
    });
    document.addEventListener("touchstart", function(e) {
      if (!_pvIsPreviewTarget(e.target)) return;
      _pvTouchMoved = false;
      if (e.touches.length === 1) _pvTouchStartXY = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.touches.length === 2) {
        _pvPinchDist = _pvTouchDist(e.touches[0], e.touches[1]);
        _pvPinchZoom = _pvZoom;
        e.preventDefault();
      } else if (e.touches.length === 1 && _pvZoom > 1.05) {
        _pvDrag = { x: e.touches[0].clientX - _pvPanX, y: e.touches[0].clientY - _pvPanY };
        e.preventDefault();
      }
    }, { passive: false });
    document.addEventListener("touchmove", function(e) {
      var modal = document.getElementById("image-preview-modal");
      if (!modal || modal.classList.contains("hidden")) return;
      _pvTouchMoved = true;
      if (e.touches.length === 2 && _pvPinchDist > 0) {
        var d = _pvTouchDist(e.touches[0], e.touches[1]);
        _pvZoom = Math.max(0.5, Math.min(6, _pvPinchZoom * (d / _pvPinchDist)));
        applyPreviewTransform();
        e.preventDefault();
      } else if (e.touches.length === 1 && _pvDrag) {
        _pvPanX = e.touches[0].clientX - _pvDrag.x;
        _pvPanY = e.touches[0].clientY - _pvDrag.y;
        applyPreviewTransform();
        e.preventDefault();
      }
    }, { passive: false });
    document.addEventListener("touchend", function(e) {
      if (e.touches.length < 2) _pvPinchDist = 0;
      if (e.touches.length === 0) {
        var wasDrag = _pvDrag !== null;
        _pvDrag = null;
        if (!_pvTouchMoved && _pvIsPreviewTarget(e.target)) {
          e.preventDefault();
          _pvHandleTap();
        }
        _pvTouchMoved = false;
      }
    }, { passive: false });
  })();
  function getBoardRect() { return document.getElementById("canvas-board-wrap")?.getBoundingClientRect() || { left: 0, top: 0, width: 0, height: 0 }; }
  function clientToCanvasPoint(clientX, clientY) { const rect = getBoardRect(); return { x: (clientX - rect.left - STATE.panX) / STATE.zoom, y: (clientY - rect.top - STATE.panY) / STATE.zoom }; }
  function showContextMenu(clientX, clientY) { const rect = getBoardRect(); STATE.contextMenu = { visible: true, x: clientX - rect.left, y: clientY - rect.top, canvasPoint: clientToCanvasPoint(clientX, clientY), scope: "board", payload: null }; renderCanvas(); }
  function showImageContextMenu(clientX, clientY, imageUrl, title, nodeId = "") { const rect = getBoardRect(); STATE.contextMenu = { visible: true, x: clientX - rect.left, y: clientY - rect.top, canvasPoint: clientToCanvasPoint(clientX, clientY), scope: "image", payload: { imageUrl, title, nodeId } }; renderCanvas(); }
  function showAssetContextMenu(clientX, clientY, assetId, imageUrl, title, category) { STATE.contextMenu = { visible: true, x: clientX, y: clientY, canvasPoint: clientToCanvasPoint(clientX, clientY), scope: "asset", payload: { assetId, imageUrl, title, category } }; renderCanvas(); }
  function hideContextMenu(rerender = true) { STATE.contextMenu.visible = false; var _mr = document.getElementById("canvas-context-menu-root"); if (_mr) _mr.innerHTML = ""; if (rerender) renderCanvas(); }
  function renderContextMenu() {
    if (!STATE.contextMenu.visible) return "";
    if (STATE.contextMenu.scope === "image" && STATE.contextMenu.payload) {
      return `<div class="canvas-context-menu" style="left:${STATE.contextMenu.x}px;top:${STATE.contextMenu.y}px;"><button data-context-save-library="${STATE.contextMenu.payload.imageUrl}" data-image-title="${escapeHtml(STATE.contextMenu.payload.title || '\u56fe\u7247\u7d20\u6750')}"><i class="fa fa-folder-open-o"></i> \u52a0\u5165\u7d20\u6750\u5e93</button><button data-context-download-image="${STATE.contextMenu.payload.imageUrl}"><i class="fa fa-download"></i> \u4fdd\u5b58\u56fe\u7247</button></div>`;
    }

    if (STATE.contextMenu.scope === "asset" && STATE.contextMenu.payload?.assetId) { return `<div class="canvas-context-menu asset-modal-context-menu" style="left:${STATE.contextMenu.x}px;top:${STATE.contextMenu.y}px;"><button type="button" data-context-download-image="${STATE.contextMenu.payload.imageUrl || ""}"><i class="fa fa-download"></i> 保存图片</button><button type="button" data-add-asset="${STATE.contextMenu.payload.assetId}"><i class="fa fa-plus-circle"></i> 加入画布</button><button type="button" data-move-asset="${STATE.contextMenu.payload.assetId}" data-asset-category="${escapeHtml(STATE.contextMenu.payload.category || DEFAULT_ASSET_CATEGORY)}"><i class="fa fa-folder-open-o"></i> 移动分类</button><button type="button" data-delete-asset="${STATE.contextMenu.payload.assetId}"><i class="fa fa-trash"></i> 删除素材</button></div>`; }
    return `<div class="canvas-context-menu" style="left:${STATE.contextMenu.x}px;top:${STATE.contextMenu.y}px;"><button data-context-create-node="1"><i class="fa fa-plus-circle"></i> 新建节点</button></div>`;
  }
  function createNodeFromContextMenu() { const point = STATE.contextMenu.canvasPoint || { x: 180, y: 160 }; hideContextMenu(false); addNodeAt(point.x, point.y); }
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
  function openHistorySession(id) { const item = STATE.historySessions.find((entry) => entry.id === id); if (!item) return; STATE.currentHistoryId = id; restoreSnapshot(item.snapshot, { focus: true }); renderCanvas(); renderLeftPanel(); }
  function persistCurrentHistory() { if (!STATE.currentHistoryId) return; const summary = buildHistorySummary(); const index = STATE.historySessions.findIndex((item) => item.id === STATE.currentHistoryId); const payload = { id: STATE.currentHistoryId, title: index >= 0 ? (STATE.historySessions[index].title || `画布会话 ${index + 1}`) : "当前画布", summary, snapshot: snapshotState() }; if (index >= 0) STATE.historySessions[index] = payload; else STATE.historySessions.unshift(payload); }
  async function persistCanvasState() { persistCurrentHistory(); try { const sanitizedSessions = STATE.historySessions.map((session) => ({ ...session, snapshot: { ...(session.snapshot || {}), nodes: (session.snapshot?.nodes || []).map(sanitizeNodeForStorage), edges: JSON.parse(JSON.stringify(session.snapshot?.edges || [])) } })); const sanitizedAssets = STATE.assetLibrary.map(sanitizeAssetForStorage); canvasDebugLog("storage", "persistCanvasState payload", { sessions: sanitizedSessions.length, assets: sanitizedAssets.length, firstSessionNodeCount: sanitizedSessions[0]?.snapshot?.nodes?.length || 0 }); await fetch("/api/canvas/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessions: sanitizedSessions, assetLibrary: sanitizedAssets }) }); } catch (error) { console.warn("[canvas] 保存本地状态失败", error); } }
  function buildHistorySummary() { const generatedCount = STATE.nodes.reduce((sum, node) => sum + (node.outputImages || []).length, 0); if (generatedCount) return `已生成 ${generatedCount} 张图 · ${STATE.nodes.length} 个节点`; const promptNode = STATE.nodes.find((node) => (node.prompt || "").trim()); if (promptNode) return `${String(promptNode.prompt).trim().slice(0, 20)} · ${STATE.nodes.length} 个节点`; return STATE.nodes.length ? `${STATE.nodes.length} 个节点` : "空白画布"; }
  function snapshotState() { return { nodes: JSON.parse(JSON.stringify(STATE.nodes.map(sanitizeNodeForStorage))), edges: JSON.parse(JSON.stringify(STATE.edges)), panX: STATE.panX, panY: STATE.panY, zoom: STATE.zoom }; }
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
  function restoreSnapshot(snapshot, options = {}) { STATE.nodes = JSON.parse(JSON.stringify(snapshot?.nodes || [])).map((node) => { const asset = node.assetId ? STATE.assetLibrary.find((item) => item.id === node.assetId) : null; const outputAsset = node.outputAssetId ? STATE.assetLibrary.find((item) => item.id === node.outputAssetId) : null; const assetImage = getDirectDisplayImageUrl(asset?.displayImageUrl) || getDirectDisplayImageUrl(asset?.imageUrl, asset?.imageBase64); const outputImage = getDirectDisplayImageUrl(outputAsset?.displayImageUrl) || getDirectDisplayImageUrl(outputAsset?.imageUrl, outputAsset?.imageBase64); const hydrated = { ...node, busy: false, displayImageUrl: getDirectDisplayImageUrl(node.displayImageUrl) || outputImage || (Array.isArray(node.outputImages) ? (node.outputImages[0] || "") : (node.outputImages || "")) || getDirectDisplayImageUrl(node.imageUrl, node.imageBase64) || assetImage, imageUrl: outputImage || getDirectDisplayImageUrl(node.imageUrl, node.imageBase64) || assetImage || "", outputImages: [] }; console.log(`[canvas][restore] node id=${hydrated.id || ""} assetId=${hydrated.assetId || ""} imageUrlLen=${String(hydrated.imageUrl || "").length} displayLen=${String(hydrated.displayImageUrl || "").length} outputCount=${Array.isArray(hydrated.outputImages) ? hydrated.outputImages.length : (hydrated.outputImages ? 1 : 0)}`); return hydrated; }); STATE.edges = JSON.parse(JSON.stringify(snapshot?.edges || [])); STATE.panX = Number(snapshot?.panX || 0); STATE.panY = Number(snapshot?.panY || 0); STATE.zoom = Number(snapshot?.zoom || 1); canvasDebugLog("history", "restoreSnapshot", { nodes: STATE.nodes.map((node) => ({ id: node.id, assetId: node.assetId || "", imageUrlLength: String(node.imageUrl || "").length, imageBase64Length: String(node.imageBase64 || "").length, displayImageUrlLength: String(node.displayImageUrl || "").length, outputImages: Array.isArray(node.outputImages) ? node.outputImages.map((item) => String(item || "").length) : String(node.outputImages || "").length })), edgeCount: STATE.edges.length, zoom: STATE.zoom }); if (options.focus !== false && STATE.nodes.length) focusNodesInView(); }
  function mergeAssetIntoLibrary(asset) { STATE.assetLibrary = [normalizeAsset(asset), ...STATE.assetLibrary.filter((item) => item.id !== asset.id)].slice(0, 120); }
  function insertAssetAsNode(assetId) { const asset = STATE.assetLibrary.find((item) => item.id === assetId); if (!asset) return; const point = clientToCanvasPoint(getBoardRect().left + 280, getBoardRect().top + 220); const node = createNode(point.x, point.y); node.imageUrl = asset.imageUrl || ""; node.imageBase64 = ""; node.displayImageUrl = getDirectDisplayImageUrl(asset.displayImageUrl) || getDirectDisplayImageUrl(asset.imageUrl, asset.imageBase64); node.assetId = asset.id; node.outputAssetId = ""; STATE.nodes.push(node); STATE.selectedNodeId = node.id; STATE.selectedEdgeId = null; persistCanvasState(); renderCanvas(); renderLeftPanel(); }
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
  function normalizeAsset(asset) { const normalized = { ...asset, category: asset?.category || DEFAULT_ASSET_CATEGORY }; normalized.displayImageUrl = getDirectDisplayImageUrl(normalized.displayImageUrl) || getDirectDisplayImageUrl(normalized.imageUrl, normalized.imageBase64); return normalized; }
  function normalizeAssetLibrary() { STATE.assetLibrary = (STATE.assetLibrary || []).map(normalizeAsset); STATE.categories = [...new Set([DEFAULT_ASSET_CATEGORY, ...(STATE.categories || []), ...STATE.assetLibrary.map((item) => item.category || DEFAULT_ASSET_CATEGORY)])].sort((a, b) => a.localeCompare(b, "zh-CN")); }
  function getAssetCategories() { return [...new Set([...(STATE.categories || []), ...((STATE.assetLibrary || []).map((item) => item.category || DEFAULT_ASSET_CATEGORY)), DEFAULT_ASSET_CATEGORY])].sort((a, b) => a.localeCompare(b, "zh-CN")); }
  function getFilteredAssets() { return STATE.activeAssetCategory === "全部" ? STATE.assetLibrary : STATE.assetLibrary.filter((item) => (item.category || DEFAULT_ASSET_CATEGORY) === STATE.activeAssetCategory); }
  function createAssetCategory(source = "left") { return openCategoryModal("create"); }
  function escapeHtml(str = "") { return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;"); }

  function resolveCanvasSize(resolution = RESOLUTION_PRESETS[0], ratio = RATIO_PRESETS[0]) {
    const longSideMap = { "1K": 1024, "2K": 2048, "4K": 3840 };
    const longSide = longSideMap[String(resolution || "1K")] || 1024;
    const [rw, rh] = String(ratio || "1:1").split(":").map((v) => Math.max(1, Number(v || 1)));
    const landscape = rw >= rh;
    const ratioValue = rw / rh;
    let width, height;
    if (landscape) {
      width = longSide;
      height = Math.round(longSide / ratioValue);
    } else {
      height = longSide;
      width = Math.round(longSide * ratioValue);
    }
    width = Math.max(512, Math.round(width / 64) * 64);
    height = Math.max(512, Math.round(height / 64) * 64);
    return { width, height };
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
