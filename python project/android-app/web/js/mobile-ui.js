(function () {
  function injectMobileStyles() {
    if (document.getElementById('liuhui-android-mobile-style')) return;
    const style = document.createElement('style');
    style.id = 'liuhui-android-mobile-style';
    style.textContent = `
      :root {
        --safe-bottom: max(env(safe-area-inset-bottom), 12px);
        --safe-top: max(env(safe-area-inset-top), 0px);
      }
      html, body {
        overscroll-behavior: none;
        -webkit-tap-highlight-color: transparent;
      }
      body {
        padding-bottom: var(--safe-bottom);
      }
      .app-shell {
        min-height: 100dvh;
      }
      @media (max-width: 900px) {
        body { overflow: hidden; }
        .header, .topbar, .app-header, .page-header {
          padding: calc(4px + var(--safe-top)) 10px 4px !important;
          height: auto !important;
          min-height: 46px;
          align-items: center !important;
          flex-direction: row !important;
          gap: 8px;
        }
        .header-logo {
          font-size: 14px !important;
          letter-spacing: .02em;
        }
        .header-logo i {
          font-size: 16px !important;
          margin-right: 6px !important;
        }
        .header-actions {
          width: auto;
          justify-content: flex-end;
          gap: 6px !important;
        }
        .icon-btn {
          width: 30px !important;
          height: 30px !important;
          border-radius: 10px !important;
          font-size: 14px !important;
        }
        .tab-nav {
          position: static;
          z-index: 50;
          display: grid !important;
          grid-template-columns: repeat(4, 1fr);
          gap: 4px;
          width: auto;
          flex: 1;
          padding: 0;
          background: transparent;
        }
        .tab-nav .tab-btn {
          min-height: 30px;
          font-size: 10px;
          padding: 6px 4px;
          border-radius: 10px;
          justify-content: center;
          gap: 4px;
        }
        .tab-nav .tab-btn span {
          display: inline !important;
          font-size: 10px;
        }
        .main-container, .content-wrap, .page-content {
          height: calc(100dvh - 46px - var(--safe-bottom)) !important;
          padding: 0 !important;
        }
        .tab-content {
          height: 100% !important;
        }
        .card, .panel, .config-panel, .chat-panel {
          border-radius: 12px !important;
        }
        .card-body, .chat-header, .chat-input-wrap, .image-toolbar, .image-main {
          padding-left: 8px !important;
          padding-right: 8px !important;
        }
        .chat-header {
          padding-top: 12px !important;
          padding-bottom: 12px !important;
        }
        .chat-messages {
          height: calc(100dvh - 280px) !important;
          padding: 14px 12px 100px !important;
        }
        .message-content {
          max-width: 94% !important;
          font-size: 14px;
        }
        .chat-input-wrap {
          position: sticky;
          bottom: 0;
          background: rgba(15, 23, 42, .98) !important;
          backdrop-filter: blur(14px);
          padding-top: 10px !important;
          padding-bottom: calc(10px + var(--safe-bottom)) !important;
          z-index: 40;
        }
        .chat-input-container {
          max-width: none !important;
        }
        #chat-input, .chat-input {
          min-height: 52px;
          font-size: 16px;
          padding-right: 92px !important;
          border-radius: 16px !important;
        }
        .chat-send-btn {
          right: 8px !important;
          bottom: 8px !important;
          height: 36px !important;
          padding: 8px 14px !important;
          border-radius: 12px !important;
        }
        .modal-mask {
          align-items: flex-end !important;
          padding: 0 !important;
        }
        .modal-card {
          width: 100% !important;
          max-width: none !important;
          max-height: 92dvh !important;
          border-radius: 22px 22px 0 0 !important;
          margin: 0 !important;
          overflow: auto !important;
        }
        #config-modal .card-header {
          position: sticky;
          top: 0;
          z-index: 3;
          background: #fff;
        }
        .table-container {
          overflow-x: auto;
        }
        .table {
          min-width: 720px;
        }
        .toolbar-grid {
          grid-template-columns: 1fr !important;
        }
        .image-main {
          height: calc(100dvh - 170px) !important;
          padding-bottom: calc(84px + var(--safe-bottom)) !important;
        }
        .generate-btn-wrap {
          position: sticky;
          bottom: 0;
          background: linear-gradient(180deg, rgba(15,23,42,0), rgba(15,23,42,.92) 32%, rgba(15,23,42,.98) 100%);
          padding: 16px 0 calc(8px + var(--safe-bottom));
          z-index: 10;
        }
        .generate-btn {
          width: 100%;
          justify-content: center;
        }
        .canvas-shell {
          display: block !important;
        }
        .canvas-shell.is-mobile-drawer .canvas-left {
          display: flex !important;
          width: min(74vw, 280px) !important;
          padding: 10px !important;
          gap: 8px !important;
        }
        .canvas-main {
          min-height: calc(100dvh - 46px - var(--safe-bottom));
        }
        .canvas-topbar {
          padding: 10px 12px !important;
          gap: 8px !important;
          align-items: flex-start !important;
          flex-direction: column !important;
          position: sticky;
          top: 0;
          z-index: 20;
        }
        .canvas-topbar .left,
        .canvas-topbar .right {
          width: 100%;
          overflow-x: auto;
          flex-wrap: nowrap !important;
        }
        .canvas-topbar .badge,
        .canvas-topbar .btn {
          flex: 0 0 auto;
          min-height: 40px;
        }
        .canvas-board-wrap {
          min-height: calc(100dvh - 180px);
        }
        .canvas-empty {
          padding: 0 24px;
        }
        .node {
          width: min(88vw, 340px) !important;
        }
        .port-handle {
          transform: scale(1.2);
        }
        .asset-library-panel {
          width: 100% !important;
          height: 100dvh !important;
          max-height: 100dvh !important;
          border-radius: 0 !important;
          margin: 0 !important;
          left: 0 !important;
          top: 0 !important;
          grid-template-columns: 1fr !important;
        }
        .asset-library-sidebar {
          border-right: none !important;
          border-bottom: 1px solid rgba(148,163,184,.14);
          padding: 14px !important;
        }
        .asset-library-content {
          padding: 14px !important;
        }
        .asset-card {
          flex-direction: column;
          min-height: auto;
        }
        .asset-card img {
          width: 100% !important;
          height: auto !important;
          aspect-ratio: 1.35 / 1;
          flex: 0 0 auto !important;
        }
        .asset-modal-actions .btn,
        .canvas-library-toolbar .btn,
        .asset-folder-actions .btn {
          min-height: 42px;
        }
        .image-preview-panel {
          max-width: 100vw !important;
          max-height: 100dvh !important;
        }
        .image-preview-panel img {
          max-height: 84dvh !important;
          border-radius: 12px !important;
        }
        .canvas-floating-actions {
          position: fixed;
          right: 14px;
          bottom: calc(18px + var(--safe-bottom));
          z-index: 70;
          display: grid;
          gap: 10px;
        }
        .canvas-fab {
          width: 52px;
          height: 52px;
          border-radius: 999px;
          border: 1px solid rgba(96,165,250,.25);
          background: rgba(15,23,42,.96);
          color: #fff;
          box-shadow: 0 16px 36px rgba(0,0,0,.35);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  document.addEventListener('DOMContentLoaded', injectMobileStyles);
})();
