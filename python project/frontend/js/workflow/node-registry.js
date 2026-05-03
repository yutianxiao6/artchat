/**
 * node-registry.js — 通用节点类型注册表
 * 管理节点类型定义，提供注册、查询、版本管理等通用能力
 */
(function () {
  "use strict";

  const _types = {};

  function register(def) {
    if (!def || !def.id) throw new Error("NodeType must have an id");
    _types[def.id] = Object.assign({
      label: def.id,
      icon: "fa-circle",
      color: "#64748b",
      category: "global",
      allowMultiple: false,
      maxCount: 5,
      generate: null,
      renderDetail: null,
      getPreview: () => "",
    }, def);
  }

  function get(id) { return _types[id] || null; }
  function all() { return Object.values(_types); }
  function ids() { return Object.keys(_types); }

  function makeVersionId() {
    return "v_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  }

  function createNodeData(id) {
    return { id: id || makeVersionId(), status: "idle", versions: [], activeVersionId: null };
  }

  function getActiveVersion(node) {
    if (!node || !node.versions || !node.versions.length) return null;
    return node.versions.find(function (v) { return v.id === node.activeVersionId; })
      || node.versions[node.versions.length - 1];
  }

  function addVersion(node, data) {
    var vid = makeVersionId();
    var version = Object.assign({ id: vid, createdAt: new Date().toISOString() }, data);
    node.versions.push(version);
    node.activeVersionId = vid;
    node.status = "done";
    return version;
  }

  function setActiveVersion(node, versionId) {
    if (!node || !node.versions) return;
    var found = node.versions.find(function (v) { return v.id === versionId; });
    if (found) node.activeVersionId = versionId;
  }

  window.WF_NodeRegistry = {
    register: register,
    get: get,
    all: all,
    ids: ids,
    makeVersionId: makeVersionId,
    createNodeData: createNodeData,
    getActiveVersion: getActiveVersion,
    addVersion: addVersion,
    setActiveVersion: setActiveVersion,
  };
})();
