(function () {
  window.ImageCanvasRender = window.ImageCanvasRender || {};

  window.ImageCanvasRender.getNodeModelMeta = function getNodeModelMeta(node, deps) {
    const modelCfg = deps.getImageConfigById(node.modelId) || deps.getImageConfigById(deps.getDefaultImageConfigId());
    const rawModelIcon = modelCfg && window.renderModelIcon ? window.renderModelIcon(modelCfg.model_name || modelCfg.name || "", { size: 18, title: modelCfg.model_name || modelCfg.name || "" }) : "";
    return {
      modelCfg,
      modelIcon: `<div class="canvas-node-model-icon">${rawModelIcon || '<i class="fa fa-cube"></i>'}</div>`,
      modelName: deps.escapeHtml(modelCfg?.model_name || modelCfg?.name || "未选择模型")
    };
  };
})();
