(function () {
  window.ImageCanvasMobile = window.ImageCanvasMobile || {};

  window.ImageCanvasMobile.isMobileViewport = function isMobileViewport() {
    return window.matchMedia('(max-width: 768px)').matches;
  };

  window.ImageCanvasMobile.getResponsiveNodeWidth = function getResponsiveNodeWidth(defaultWidth) {
    return window.ImageCanvasMobile.isMobileViewport() ? 320 : defaultWidth;
  };
})();
