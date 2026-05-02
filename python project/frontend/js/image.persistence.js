(function () {
  window.ImageCanvasPersistence = window.ImageCanvasPersistence || {};

  window.ImageCanvasPersistence.snapshotState = function snapshotState(state) {
    return {
      nodes: JSON.parse(JSON.stringify(state.nodes || [])),
      edges: JSON.parse(JSON.stringify(state.edges || [])),
      panX: state.panX,
      panY: state.panY,
      zoom: state.zoom,
    };
  };

  window.ImageCanvasPersistence.buildHistorySummary = function buildHistorySummary(state) {
    const generatedCount = (state.nodes || []).reduce((sum, node) => sum + ((node.outputImages || []).length), 0);
    if (generatedCount) return `已生成 ${generatedCount} 张图 · ${(state.nodes || []).length} 个节点`;
    const promptNode = (state.nodes || []).find((node) => String(node.prompt || '').trim());
    if (promptNode) return `${String(promptNode.prompt).trim().slice(0, 20)} · ${(state.nodes || []).length} 个节点`;
    return (state.nodes || []).length ? `${(state.nodes || []).length} 个节点` : '空白画布';
  };
})();
