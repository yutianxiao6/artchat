(function () {
  window.ImageCanvasAssets = window.ImageCanvasAssets || {};

  window.ImageCanvasAssets.getAssetCategories = function getAssetCategories(state, defaultCategory) {
    const categories = new Set([defaultCategory, ...(state.categories || [])]);
    (state.assetLibrary || []).forEach((item) => categories.add(item.category || defaultCategory));
    return Array.from(categories).filter(Boolean);
  };

  window.ImageCanvasAssets.getFilteredAssets = function getFilteredAssets(state, defaultCategory) {
    const current = state.activeAssetCategory || '全部';
    return (state.assetLibrary || []).filter((item) => current === '全部' ? true : (item.category || defaultCategory) === current);
  };
})();
