(function () {
  function patchInitialUx() {
    const openConfigIfNeeded = () => {
      const configs = window.__LIUHUI_ANDROID__?.readConfigs?.() || [];
      if (!configs.length && typeof window.openConfigModal === 'function') {
        setTimeout(() => window.openConfigModal(), 120);
      }
    };

    const activateDefaultTab = () => {
      if (window.innerWidth <= 900 && typeof window.activateTab === 'function') {
        window.activateTab('chat', { force: true });
      }
    };

    document.addEventListener('DOMContentLoaded', () => {
      openConfigIfNeeded();
      activateDefaultTab();
      ensureCanvasFab();
    });
  }

  function patchScrollFocus() {
    document.addEventListener('focusin', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.matches('textarea, input, select')) {
        setTimeout(() => {
          try { target.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
        }, 240);
      }
    });
  }

  function ensureCanvasFab() {
    if (window.innerWidth > 900) return;
    if (document.getElementById('canvas-floating-actions')) return;
    const root = document.createElement('div');
    root.id = 'canvas-floating-actions';
    root.className = 'canvas-floating-actions';
    root.innerHTML = `
      <button class="canvas-fab" id="canvas-fab-add" title="新建节点"><i class="fa fa-plus"></i></button>
      <button class="canvas-fab" id="canvas-fab-assets" title="素材库"><i class="fa fa-folder-open-o"></i></button>
      <button class="canvas-fab" id="canvas-fab-config" title="配置"><i class="fa fa-cog"></i></button>
    `;
    document.body.appendChild(root);

    root.addEventListener('click', (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.id === 'canvas-fab-config') {
        if (typeof window.openConfigModal === 'function') window.openConfigModal();
        return;
      }
      if (typeof window.activateTab === 'function') window.activateTab('image', { force: true });
      setTimeout(() => {
        if (target.id === 'canvas-fab-assets') {
          const btn = document.querySelector('[data-open-asset-library]');
          if (btn instanceof HTMLElement) btn.click();
          return;
        }
        if (target.id === 'canvas-fab-add') {
          const board = document.getElementById('canvas-board-wrap');
          if (board instanceof HTMLElement) {
            board.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: board.clientWidth / 2, clientY: board.clientHeight / 2 }));
          }
        }
      }, 80);
    });
  }

  patchInitialUx();
  patchScrollFocus();
})();
