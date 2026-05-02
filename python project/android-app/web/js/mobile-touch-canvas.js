(function () {
  const LONG_PRESS_MS = 420;
  let pressTimer = null;
  let pressStart = null;

  function clearPressTimer() {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
    pressStart = null;
  }

  function bindTouchCanvasEnhancements() {
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerup', clearPressTimer, { passive: true });
    document.addEventListener('pointercancel', clearPressTimer, { passive: true });
  }

  function onPointerDown(event) {
    if (window.innerWidth > 900) return;
    if (event.pointerType !== 'touch') return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const board = target.closest('#canvas-board');
    if (!board) return;
    if (target.closest('textarea, input, select, button, a, .canvas-context-menu, .asset-library-modal, .image-preview-modal')) return;

    pressStart = {
      x: event.clientX,
      y: event.clientY,
      target,
    };

    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      tryOpenLongPressMenu(event, target);
      clearPressTimer();
    }, LONG_PRESS_MS);
  }

  function onPointerMove(event) {
    if (!pressStart) return;
    const dx = Math.abs(event.clientX - pressStart.x);
    const dy = Math.abs(event.clientY - pressStart.y);
    if (dx > 10 || dy > 10) clearPressTimer();
  }

  function tryOpenLongPressMenu(event, target) {
    if (typeof window.activateTab === 'function') window.activateTab('image', { force: true });

    const imageTarget = target.closest('[data-context-image]');
    if (imageTarget) {
      dispatchContextMenu(imageTarget, event.clientX, event.clientY);
      return;
    }

    const nodeTarget = target.closest('.node');
    if (nodeTarget) return;

    dispatchContextMenu(target, event.clientX, event.clientY);
  }

  function dispatchContextMenu(target, clientX, clientY) {
    const evt = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 2,
    });
    target.dispatchEvent(evt);
  }

  function patchVisualHints() {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.innerWidth > 900) return;
      const style = document.createElement('style');
      style.textContent = `
        @media (max-width: 900px) {
          #canvas-board, .canvas-board { touch-action: none; }
          .node-image-wrap, .node, .port-handle, .asset-card, .btn, .tab-btn { touch-action: manipulation; }
        }
      `;
      document.head.appendChild(style);
    });
  }

  bindTouchCanvasEnhancements();
  patchVisualHints();
})();
