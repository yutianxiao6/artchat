(function () {
  if (window.__LIUHUI_TOUCH_GESTURES__) return;
  window.__LIUHUI_TOUCH_GESTURES__ = true;

  let pinchState = null;
  let panState = null;

  function isMobile() {
    return window.innerWidth <= 900;
  }

  function getTouches(event) {
    return Array.from(event.touches || []);
  }

  function distance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function midpoint(a, b) {
    return {
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    };
  }

  function getBoard() {
    return document.getElementById('canvas-board');
  }

  function getBoardWrap() {
    return document.getElementById('canvas-board-wrap');
  }

  function shouldIgnoreTarget(target) {
    return !!target.closest('textarea, input, select, button, a, .node, .asset-library-modal, .image-preview-modal, .canvas-context-menu');
  }

  function dispatchWheelZoom(clientX, clientY, deltaY) {
    const board = getBoard();
    if (!board) return;
    const evt = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      deltaY,
    });
    board.dispatchEvent(evt);
  }

  function dispatchMiddlePanMouseDown(clientX, clientY) {
    const board = getBoard();
    if (!board) return;
    board.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 1,
      buttons: 4,
    }));
  }

  function dispatchMouseMove(clientX, clientY, buttons = 4) {
    window.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button: 0,
      buttons,
    }));
  }

  function dispatchMouseUp(clientX, clientY, button = 1) {
    window.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      button,
      buttons: 0,
    }));
  }

  function bindCanvasGestures() {
    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: false });
    document.addEventListener('touchcancel', onTouchEnd, { passive: false });
  }

  function onTouchStart(event) {
    if (!isMobile()) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const board = target.closest('#canvas-board');
    if (!board) return;

    const touches = getTouches(event);
    if (touches.length === 2) {
      const [a, b] = touches;
      pinchState = {
        startDistance: distance(a, b),
        lastDistance: distance(a, b),
        center: midpoint(a, b),
      };
      panState = null;
      event.preventDefault();
      return;
    }

    if (touches.length === 1 && !shouldIgnoreTarget(target)) {
      const touch = touches[0];
      panState = {
        active: true,
        startedSyntheticPan: false,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        moved: false,
      };
    }
  }

  function onTouchMove(event) {
    if (!isMobile()) return;
    const touches = getTouches(event);

    if (touches.length === 2 && pinchState) {
      const [a, b] = touches;
      const currentDistance = distance(a, b);
      const center = midpoint(a, b);
      const delta = currentDistance - pinchState.lastDistance;
      if (Math.abs(delta) > 4) {
        dispatchWheelZoom(center.x, center.y, delta > 0 ? -120 : 120);
        pinchState.lastDistance = currentDistance;
      }
      event.preventDefault();
      return;
    }

    if (touches.length === 1 && panState?.active) {
      const touch = touches[0];
      const dx = touch.clientX - panState.startX;
      const dy = touch.clientY - panState.startY;
      const movedEnough = Math.abs(dx) > 8 || Math.abs(dy) > 8;
      if (movedEnough && !panState.startedSyntheticPan) {
        panState.startedSyntheticPan = true;
        panState.moved = true;
        dispatchMiddlePanMouseDown(panState.startX, panState.startY);
      }
      if (panState.startedSyntheticPan) {
        panState.lastX = touch.clientX;
        panState.lastY = touch.clientY;
        dispatchMouseMove(touch.clientX, touch.clientY, 4);
        event.preventDefault();
      }
    }
  }

  function onTouchEnd(event) {
    if (pinchState && (!event.touches || event.touches.length < 2)) {
      pinchState = null;
    }
    if (panState?.startedSyntheticPan && (!event.touches || event.touches.length === 0)) {
      dispatchMouseUp(panState.lastX, panState.lastY, 1);
      panState = null;
      event.preventDefault();
      return;
    }
    if (!event.touches || event.touches.length === 0) {
      panState = null;
    }
  }

  bindCanvasGestures();
})();
