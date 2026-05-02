(function () {
  if (window.__LIUHUI_TOUCH_DRAG_PATCH__) return;
  window.__LIUHUI_TOUCH_DRAG_PATCH__ = true;

  let dragState = null;

  function isMobile() {
    return window.innerWidth <= 900;
  }

  function bindNodeTouchDrag() {
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('touchcancel', clearDragState, { passive: true });
  }

  function onTouchStart(event) {
    if (!isMobile()) return;
    if (event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const node = target.closest('.node');
    if (!node) return;
    if (target.closest('textarea, input, select, button, a, .port-handle')) return;
    const touch = event.touches[0];
    dragState = {
      node,
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      dragging: false,
    };
  }

  function onTouchMove(event) {
    if (!dragState || !event.touches.length) return;
    const touch = event.touches[0];
    const dx = touch.clientX - dragState.startX;
    const dy = touch.clientY - dragState.startY;
    const movedEnough = Math.abs(dx) > 8 || Math.abs(dy) > 8;

    if (movedEnough && !dragState.dragging) {
      dragState.dragging = true;
      dispatchNodeMouseDown(dragState.node, dragState.startX, dragState.startY);
    }

    if (dragState.dragging) {
      dragState.lastX = touch.clientX;
      dragState.lastY = touch.clientY;
      dispatchMouseMove(touch.clientX, touch.clientY, 1);
      event.preventDefault();
    }
  }

  function onTouchEnd(event) {
    if (dragState?.dragging) {
      dispatchMouseUp(dragState.lastX, dragState.lastY, 0);
      clearDragState();
      event.preventDefault();
      return;
    }
    clearDragState();
  }

  function dispatchNodeMouseDown(node, clientX, clientY) {
    node.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      buttons: 1,
    }));
  }

  function dispatchMouseMove(clientX, clientY, buttons = 1) {
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      buttons,
    }));
  }

  function dispatchMouseUp(clientX, clientY, button = 0) {
    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
      buttons: 0,
    }));
  }

  function clearDragState() {
    dragState = null;
  }

  bindNodeTouchDrag();
})();
