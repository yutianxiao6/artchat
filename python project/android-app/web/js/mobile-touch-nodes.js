(function () {
  if (window.__LIUHUI_TOUCH_NODE_PATCH__) return;
  window.__LIUHUI_TOUCH_NODE_PATCH__ = true;

  let tapState = null;

  function isMobile() {
    return window.innerWidth <= 900;
  }

  function getBoardWrap() {
    return document.getElementById('canvas-board-wrap');
  }

  function boardCenterClientPoint() {
    const board = getBoardWrap();
    if (!board) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const rect = board.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.max(120, rect.height / 2) };
  }

  function createNodeAtCenter() {
    const board = getBoardWrap();
    if (!board) return;
    const p = boardCenterClientPoint();
    board.dispatchEvent(new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: p.x,
      clientY: p.y,
      button: 0,
    }));
  }

  function bindFabEnhance() {
    document.addEventListener('click', (event) => {
      const target = event.target instanceof HTMLElement ? event.target.closest('#canvas-fab-add') : null;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof window.activateTab === 'function') window.activateTab('image', { force: true });
      setTimeout(createNodeAtCenter, 80);
    }, true);
  }

  function bindTouchTapSelection() {
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('touchcancel', clearTapState, { passive: true });
  }

  function onTouchStart(event) {
    if (!isMobile()) return;
    if (event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const node = target.closest('.node');
    const board = target.closest('#canvas-board');
    if (!node && !board) return;
    if (target.closest('textarea, input, select, button, a')) return;
    const touch = event.touches[0];
    tapState = {
      startX: touch.clientX,
      startY: touch.clientY,
      nodeId: node?.getAttribute('data-node-id') || '',
      board: !!board,
      moved: false,
    };
  }

  function onTouchMove(event) {
    if (!tapState || !event.touches.length) return;
    const touch = event.touches[0];
    const dx = Math.abs(touch.clientX - tapState.startX);
    const dy = Math.abs(touch.clientY - tapState.startY);
    if (dx > 8 || dy > 8) tapState.moved = true;
  }

  function onTouchEnd(event) {
    if (!tapState || tapState.moved) {
      clearTapState();
      return;
    }
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      clearTapState();
      return;
    }
    if (tapState.nodeId) {
      const node = document.querySelector(`.node[data-node-id="${tapState.nodeId}"]`);
      if (node instanceof HTMLElement) {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        event.preventDefault();
      }
      clearTapState();
      return;
    }
    if (tapState.board && target.closest('#canvas-board') && !target.closest('.node, .canvas-context-menu')) {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      event.preventDefault();
    }
    clearTapState();
  }

  function clearTapState() {
    tapState = null;
  }

  bindFabEnhance();
  bindTouchTapSelection();
})();
