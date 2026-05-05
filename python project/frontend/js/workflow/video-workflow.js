/**
 * video-workflow.js — 视频工作流
 * 注册8种节点类型、生成逻辑、详情面板、入口
 */
(function () {
  "use strict";

  var NR = window.WF_NodeRegistry;
  var esc = window.WF_escapeHtml;

  function _getDisabledAttr(ctx, nodeType) {
    if (!ctx || !ctx.engine) return "";
    var segIdx = (ctx.segIndex !== undefined && ctx.segIndex !== null) ? ctx.segIndex : null;
    if (ctx.engine.isNodeRunning(nodeType, segIdx)) return " disabled";
    var wf = ctx.engine.current();
    if (!ctx.engine.canExecute(nodeType, segIdx, wf)) return " disabled";
    return "";
  }

  function _syncEditableFields(engine) {
    var els = document.querySelectorAll(".wf-editable");
    if (!els.length) return;
    var key = engine.selectedNodeKey;
    if (!key) return;
    var nd = window.WF_Renderer.getNodeDataByKey(engine, key);
    if (!nd) return;
    var changed = false;
    els.forEach(function (el) {
      var field = el.getAttribute("data-edit-field");
      if (!field) return;
      if (field === "userHint") {
        if (nd.userHint !== el.value) { nd.userHint = el.value; changed = true; }
        return;
      }
      var v = NR.getActiveVersion(nd);
      if (!v) return;
      var parts = field.split(".");
      var cur = v;
      for (var i = 0; i < parts.length - 1; i++) {
        var k = isNaN(parts[i]) ? parts[i] : parseInt(parts[i]);
        if (!cur[k]) return;
        cur = cur[k];
      }
      var last = isNaN(parts[parts.length - 1]) ? parts[parts.length - 1] : parseInt(parts[parts.length - 1]);
      if (cur[last] !== el.value) { cur[last] = el.value; changed = true; }
    });
    if (changed) engine.save();
  }

  function getConfigId(type, nodeType) {
    var gc = _getGlobalNodeConfigs();
    if (gc[nodeType]) {
      var key = type === "image" ? "imageConfigId" : "chatConfigId";
      if (gc[nodeType][key]) return gc[nodeType][key];
    }
    var sel = document.getElementById(type === "image" ? "image-config-select" : "chat-config-select");
    if (sel && sel.value) return sel.value;
    var list = (window.GLOBAL && window.GLOBAL.configList) || [];
    var allowed = type === "image" ? ["image", "both"] : ["chat", "both"];
    var c = list.find(function (c) { return allowed.indexOf(c.config_type) >= 0; });
    return c ? c.id : "";
  }

  function _getGlobalNodeConfigs() {
    try { return JSON.parse(localStorage.getItem("flowdraw:wfNodeConfigs") || "{}"); } catch (e) { return {}; }
  }

  function _saveGlobalNodeConfigs(configs) {
    localStorage.setItem("flowdraw:wfNodeConfigs", JSON.stringify(configs));
  }

  function getImageCount(nodeType) {
    var gc = _getGlobalNodeConfigs();
    return parseInt((gc[nodeType] || {}).imageCount) || 1;
  }

  function getStoryboardGrid() {
    var gc = _getGlobalNodeConfigs();
    return parseInt((gc.storyboard || {}).grid) || 4;
  }

  function getStoryboardResolution() {
    var gc = _getGlobalNodeConfigs();
    return (gc.storyboard || {}).resolution || "2160x3840";
  }

  function getStoryTemplateOrientation() {
    var gc = _getGlobalNodeConfigs();
    return (gc.storyTemplate || {}).orientation === "vertical" ? "vertical" : "horizontal";
  }

  function normalizeGridPrompts(arr) {
    if (!arr || !arr.length) return arr;
    return arr.map(function (item) {
      if (typeof item === "string") return item;
      return item.description || item.visual_prompt || item.text || JSON.stringify(item);
    });
  }

  async function callApi(url, body) {
    var res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var result = await res.json();
    if (result.code !== 0) throw new Error(result.message || result.detail || "生成失败");
    return result.data;
  }

  function renderRefImagesSection(nd, nodeType) {
    var refs = (nd && nd.refImages) || [];
    var html = '<div class="wf-detail-section"><div class="wf-detail-label">参考图（供生图模型参考）</div><div class="wf-ref-images-area">';
    refs.forEach(function (url, i) {
      html += '<div class="wf-ref-img-item"><img class="wf-ref-img wf-preview-img" src="' + esc(url) + '"><button class="wf-ref-del-btn" data-del-ref="' + i + '"><i class="fa fa-times"></i></button></div>';
    });
    html += '<label class="wf-upload-btn"><i class="fa fa-plus"></i> 添加参考图<input type="file" accept="image/*" class="wf-file-input" data-upload-ref="' + nodeType + '" style="display:none"></label>';
    html += '</div></div>';
    return html;
  }

  // 每个 item（人物/场景）下的独立参考图区块。itemPath 形如 "characters.0" / "scenes.2"。
  function renderItemRefImagesSection(item, itemPath) {
    var refs = (item && item.refImages) || [];
    var html = '<div class="wf-detail-sub-section"><div class="wf-detail-sub-label" style="font-size:11px;color:#64748b;margin-top:6px;">本项参考图</div><div class="wf-ref-images-area" style="gap:6px;">';
    refs.forEach(function (url, i) {
      html += '<div class="wf-ref-img-item"><img class="wf-ref-img wf-preview-img" src="' + esc(url) + '" style="max-height:60px;"><button class="wf-ref-del-btn" data-del-item-ref="' + itemPath + '" data-del-item-ref-idx="' + i + '"><i class="fa fa-times"></i></button></div>';
    });
    html += '<label class="wf-upload-btn" style="padding:4px 8px;font-size:11px;"><i class="fa fa-plus"></i> 添加<input type="file" accept="image/*" class="wf-file-input" data-upload-item-ref="' + itemPath + '" style="display:none"></label>';
    html += '</div></div>';
    return html;
  }

  /* ── Node: input ── */
  NR.register({
    id: "input", label: "输入", icon: "fa-pencil", color: "#8b5cf6",
    category: "global", allowMultiple: false,
    getPreview: function (nd) { return nd && nd.plot ? nd.plot.slice(0, 60) : ""; },
    renderDetail: function (nd, wf, ctx) {
      return '<div class="wf-detail-section"><div class="wf-detail-label">简要情节</div>'
        + '<textarea class="wf-detail-textarea" id="wf-input-plot" rows="4" placeholder="描述你的视频故事情节...">' + esc(wf.input.plot) + '</textarea></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">视频风格</div>'
        + '<input class="wf-detail-input" id="wf-input-style" placeholder="如：水墨国风、赛博朋克..." value="' + esc(wf.input.style) + '"></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">视频类型</div>'
        + '<input class="wf-detail-input" id="wf-input-type" placeholder="如：短剧、广告、MV..." value="' + esc(wf.input.type) + '"></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">段数（留空=AI自动）</div>'
        + '<input class="wf-detail-input" id="wf-input-segments" type="number" min="1" max="30" placeholder="AI自动决定" value="' + (wf.input.segmentCount || "") + '"></div>'
        + '<div class="wf-detail-actions"><button class="wf-tb-btn primary" id="wf-save-input">保存</button></div>';
    },
  });

  /* ── Node: script ── */
  NR.register({
    id: "script", label: "剧本生成", icon: "fa-file-text-o", color: "#3b82f6",
    category: "global", allowMultiple: true, maxCount: 5,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.fullText ? v.fullText.slice(0, 60) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var data = await callApi("/api/workflow/generate/script", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "script"),
        plot: wf.input.plot, style: wf.input.style, type: wf.input.type,
        segment_count: wf.input.segmentCount,
      });
      if (data.segments && data.segments.length) {
        var engine = window._wfEngine;
        if (engine) engine.createSegments(wf, data.segments);
      }
      var fullText = data.full_text || "";
      var tpl = (window.WF_Templates || []).find(function (t) { return t.id === wf.templateId; });
      var defaultTitle = tpl ? tpl.name : "新工作流";
      if (fullText && (wf.title === defaultTitle || wf.title === "新工作流")) {
        wf.title = fullText.replace(/[\n\r]/g, " ").slice(0, 20);
      }
      return {
        fullText: data.full_text || "",
        segments: data.segments || [],
        mainCharacters: data.main_characters || [],
      };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "script");
      var html = "";
      if (v) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">完整剧本</div>'
          + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="fullText" rows="8">' + esc(v.fullText || "") + '</textarea></div>';
        if (v.segments && v.segments.length) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">分段 (' + v.segments.length + '段)</div>';
          v.segments.forEach(function (s, i) {
            html += '<div class="wf-detail-text"><strong>段' + (i + 1) + '</strong> (' + (s.duration || 15) + 's)<br>' + esc(s.text) + '</div>';
          });
          html += '</div>';
        }
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="script"' + dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新生成" : "生成剧本") + '</button></div>';
      return html;
    },
  });

  /* ── Node: planCharactersScenes ── */
  NR.register({
    id: "planCharactersScenes", label: "人物场景规划", icon: "fa-magic", color: "#6366f1",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v) return "";
      var mc = v.mainCharacters || [];
      return mc.map(function (c) { return c.name; }).join("、") || "已规划";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var scriptV = NR.getActiveVersion((wf.scripts || [])[0]);
      if (!scriptV || !scriptV.fullText) throw new Error("请先生成剧本");
      var planNd = ctx.nodeData;
      var planV = NR.getActiveVersion(planNd);
      var data = await callApi("/api/workflow/generate/plan-characters-scenes", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "planCharactersScenes"),
        full_text: scriptV.fullText,
        segments: (scriptV.segments || []).map(function (s) { return { text: s.text }; }),
        style: wf.input.style, type: wf.input.type,
        user_hint: (planV && planV.userHint) || (planNd && planNd.userHint) || "",
      });
      var mainChars = data.main_characters || [];
      var segPlans = data.segments || [];
      var mcNd = (wf.mainCharacterss || [])[0];
      if (mcNd) NR.addVersion(mcNd, { characters: mainChars });
      (wf.segments || []).forEach(function (seg, i) {
        var sp = segPlans[i] || {};
        var minorNd = (seg.minorCharacterss || [])[0];
        if (minorNd) {
          var minors = sp.minor_characters || [];
          NR.addVersion(minorNd, { characters: minors });
          seg.hasMinor = minors.length > 0;
          seg.minorCharactersSkip = minors.length === 0;
        }
        var sceneNd = (seg.scenes || [])[0];
        if (sceneNd) NR.addVersion(sceneNd, { scenes: sp.scenes || [], sceneCount: (sp.scenes || []).length });
      });
      return { mainCharacters: mainChars, segments: segPlans };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "planCharactersScenes");
      var html = '';
      html += '<div class="wf-detail-section"><div class="wf-detail-label">补充指令</div>'
        + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="userHint" rows="2" placeholder="可选：补充风格、角色要求等...">' + esc((nd && nd.userHint) || "") + '</textarea></div>';
      html += '<div class="wf-detail-section"><div class="wf-detail-label">风格参考图</div>'
        + '<div class="wf-ref-images-area">';
      var refs = (nd && nd.refImages) || [];
      refs.forEach(function (url, i) {
        html += '<div class="wf-ref-img-item"><img class="wf-ref-img wf-preview-img" src="' + esc(url) + '"><button class="wf-ref-del-btn" data-del-ref="' + i + '"><i class="fa fa-times"></i></button></div>';
      });
      html += '<label class="wf-upload-btn"><i class="fa fa-plus"></i> 添加参考图<input type="file" accept="image/*" class="wf-file-input" data-upload-ref="planCharactersScenes" style="display:none"></label>';
      html += '</div></div>';
      if (v) {
        var mc = v.mainCharacters || [];
        if (mc.length) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">主要人物 (' + mc.length + ')</div>';
          mc.forEach(function (c) { html += '<div class="wf-detail-text">' + esc(c.name) + '</div>'; });
          html += '</div>';
        }
        var segs = v.segments || [];
        if (segs.length) {
          segs.forEach(function (sp, i) {
            var minors = sp.minor_characters || [];
            var scenes = sp.scenes || [];
            var parts = [];
            if (minors.length) parts.push('次要人物: ' + minors.map(function (c) { return esc(c.name); }).join("、"));
            if (scenes.length) parts.push('场景: ' + scenes.map(function (s) { return esc(s.name); }).join("、"));
            if (parts.length) html += '<div class="wf-detail-text" style="font-size:11px;color:#94a3b8;">段' + (i + 1) + ' — ' + parts.join(' | ') + '</div>';
          });
        }
        html += '<div class="wf-detail-text" style="font-size:11px;color:#64748b;margin-top:6px;">完整描述请查看对应节点</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="planCharactersScenes"' + dis + '><i class="fa fa-magic"></i> ' + (v ? "重新规划" : "开始规划") + '</button>'
        + (v ? '<button class="wf-review-btn" data-review-plan><i class="fa fa-search"></i> 审核规划</button>' : '')
        + '</div>';
      return html;
    },
  });

  /* ── Node: mainCharacters ── */
  NR.register({
    id: "mainCharacters", label: "主要人物", icon: "fa-users", color: "#f59e0b",
    category: "global", allowMultiple: true, maxCount: 5, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.characters ? v.characters.map(function (c) { return c.name; }).join("、") : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var chars = (v && v.characters) || [];
      if (!chars.length) throw new Error("请先运行规划或手动添加人物描述");
      var data = await callApi("/api/workflow/generate/main-characters", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "mainCharacters"),
        characters: chars, style: wf.input.style,
        ref_image_urls: nd.refImages || [],
        image_count: getImageCount("mainCharacters"),
      });
      var resultChars = data.characters || [];
      var errs = data.errors || [];
      var errMap = {};
      errs.forEach(function (e) { errMap[e.index] = e.message || "生成失败"; });
      if (ctx.engine) {
        resultChars.forEach(function (c, i) {
          var label = c.name || ("人物" + (i + 1));
          if (errMap[i]) {
            ctx.engine._addHistory(wf, "mainCharacters", 0, null, "error", errMap[i], label);
          } else if (c.imageUrl) {
            ctx.engine._addHistory(wf, "mainCharacters", 0, null, "done", null, label);
          }
        });
      }
      return { characters: resultChars };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "mainCharacters");
      var html = "";
      if (v && v.characters && v.characters.length) {
        v.characters.forEach(function (c, ci) {
          var charRunKey = "mainCharacters_0_char_" + ci;
          var charRunning = ctx.engine && ctx.engine.runningNodes[charRunKey];
          var charDis = charRunning ? " disabled" : dis;
          html += '<div class="wf-detail-section"><div class="wf-detail-label">' + esc(c.name)
            + ' <button class="wf-char-del-btn" data-del-char-item="' + ci + '" title="删除该人物" style="float:right;background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:12px;"><i class="fa fa-trash-o"></i></button>'
            + '</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="characters.' + ci + '.description" rows="3">' + esc(c.description) + '</textarea>'
            + (c.imageUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(c.imageUrl) + '">' : '')
            + renderItemRefImagesSection(c, "characters." + ci)
            + '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> 替换图片<input type="file" accept="image/*" class="wf-file-input" data-upload-field="characters.' + ci + '.imageUrl" style="display:none"></label>'
            + '<button class="wf-char-gen-btn" data-gen-char="' + ci + '" data-gen-char-type="mainCharacters"' + charDis + '>'
            + (charRunning ? '<i class="fa fa-spinner fa-spin"></i> 生成中' : '<i class="fa fa-refresh"></i> ' + (c.imageUrl ? '重新生成' : '生成图片'))
            + '</button></div>'
            + '</div>';
        });
      }
      if (!ctx.isPipelineNode) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">手动添加人物</div>'
          + '<input class="wf-detail-input wf-manual-label" placeholder="人物名称" style="margin-bottom:6px;">'
          + '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> 上传人物图<input type="file" accept="image/*" class="wf-file-input" data-upload-add="mainCharacters" style="display:none"></label></div></div>';
      }
      html += renderRefImagesSection(nd, "mainCharacters");
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="mainCharacters"' + dis + '><i class="fa fa-refresh"></i> ' + (v && v.characters && v.characters.some(function(c){return c.imageUrl;}) ? "全部重新生成" : "全部生成图片") + '</button></div>';
      return html;
    },
  });

  /* ── Node: minorCharacters ── */
  NR.register({
    id: "minorCharacters", label: "次要人物", icon: "fa-user", color: "#f97316",
    category: "segment", allowMultiple: true, maxCount: 5, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.characters ? v.characters.map(function (c) { return c.name; }).join("、") : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var chars = (v && v.characters) || [];
      if (!chars.length) return { has_minor: false, characters: [] };
      var data = await callApi("/api/workflow/generate/minor-characters", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "minorCharacters"),
        characters: chars, style: wf.input.style,
        ref_image_urls: nd.refImages || [],
        image_count: getImageCount("minorCharacters"),
      });
      var resultChars = data.characters || [];
      var errs = data.errors || [];
      var errMap = {};
      errs.forEach(function (e) { errMap[e.index] = e.message || "生成失败"; });
      if (ctx.engine) {
        resultChars.forEach(function (c, i) {
          var label = c.name || ("人物" + (i + 1));
          if (errMap[i]) {
            ctx.engine._addHistory(wf, "minorCharacters", 0, ctx.segIndex, "error", errMap[i], label);
          } else if (c.imageUrl) {
            ctx.engine._addHistory(wf, "minorCharacters", 0, ctx.segIndex, "done", null, label);
          }
        });
      }
      return { characters: resultChars };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var html = "";
      if (v && v.characters && v.characters.length) {
        v.characters.forEach(function (c, ci) {
          var charRunKey = "seg_" + ctx.segIndex + "_minorCharacters_0_char_" + ci;
          var charRunning = ctx.engine && ctx.engine.runningNodes[charRunKey];
          var charDis = charRunning ? " disabled" : _getDisabledAttr(ctx, "minorCharacters");
          html += '<div class="wf-detail-section"><div class="wf-detail-label">' + esc(c.name)
            + ' <button class="wf-char-del-btn" data-del-char-item="' + ci + '" title="删除该人物" style="float:right;background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:12px;"><i class="fa fa-trash-o"></i></button>'
            + '</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="characters.' + ci + '.description" rows="3">' + esc(c.description) + '</textarea>'
            + (c.imageUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(c.imageUrl) + '">' : '')
            + renderItemRefImagesSection(c, "characters." + ci)
            + '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> 替换图片<input type="file" accept="image/*" class="wf-file-input" data-upload-field="characters.' + ci + '.imageUrl" style="display:none"></label>'
            + '<button class="wf-char-gen-btn" data-gen-char="' + ci + '" data-gen-char-type="minorCharacters" data-gen-char-seg="' + ctx.segIndex + '"' + charDis + '>'
            + (charRunning ? '<i class="fa fa-spinner fa-spin"></i> 生成中' : '<i class="fa fa-refresh"></i> ' + (c.imageUrl ? '重新生成' : '生成图片'))
            + '</button></div>'
            + '</div>';
        });
      }
      if (!ctx.isPipelineNode) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">手动添加人物</div>'
          + '<input class="wf-detail-input wf-manual-label" placeholder="人物名称" style="margin-bottom:6px;">'
          + '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> 上传人物图<input type="file" accept="image/*" class="wf-file-input" data-upload-add="minorCharacters" style="display:none"></label></div></div>';
      }
      html += renderRefImagesSection(nd, "minorCharacters");
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "minorCharacters"); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="minorCharacters"' + _dis + '><i class="fa fa-refresh"></i> ' + (v && v.characters && v.characters.some(function(c){return c.imageUrl;}) ? "全部重新生成" : "全部生成图片") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: scene ── */
  NR.register({
    id: "scene", label: "场景设定", icon: "fa-image", color: "#10b981",
    category: "segment", allowMultiple: true, maxCount: 5, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.description ? v.description.slice(0, 50) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var scenes = (v && v.scenes) || [];
      if (!scenes.length) throw new Error("请先运行规划或手动添加场景描述");
      var prevScenes = [];
      if (ctx.segIndex > 0) {
        var prevSeg = wf.segments[ctx.segIndex - 1];
        if (prevSeg) {
          var prevV = NR.getActiveVersion((prevSeg.scenes || [])[0]);
          if (prevV && prevV.scenes) prevScenes = prevV.scenes;
        }
      }
      var data = await callApi("/api/workflow/generate/scene", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "scene"),
        scenes: scenes, prev_segment_scenes: prevScenes,
        style: wf.input.style, ref_image_urls: nd.refImages || [],
        image_count: getImageCount("scene"),
      });
      var resultScenes = data.scenes || [];
      var errs = data.errors || [];
      var errMap = {};
      errs.forEach(function (e) { errMap[e.index] = e.message || "生成失败"; });
      if (ctx.engine) {
        resultScenes.forEach(function (s, i) {
          var label = s.name || ("场景" + (i + 1));
          if (errMap[i]) {
            ctx.engine._addHistory(wf, "scene", 0, ctx.segIndex, "error", errMap[i], label);
          } else if (s.imageUrl) {
            ctx.engine._addHistory(wf, "scene", 0, ctx.segIndex, "done", null, label);
          }
        });
      }
      return { scenes: resultScenes, sceneCount: data.scene_count || 0 };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var html = "";
      var segIdx = (ctx.segIndex !== undefined && ctx.segIndex !== null) ? ctx.segIndex : null;
      if (v && v.scenes && v.scenes.length) {
        v.scenes.forEach(function (sc, i) {
          var sceneRunKey = "seg_" + segIdx + "_scene_0_item_" + i;
          var sceneRunning = ctx.engine && ctx.engine.runningNodes[sceneRunKey];
          var sceneDis = sceneRunning ? " disabled" : _getDisabledAttr(ctx, "scene");
          html += '<div class="wf-detail-section"><div class="wf-detail-label">场景' + (i + 1) + ': ' + esc(sc.name || "")
            + ' <button class="wf-scene-del-btn" data-del-scene-item="' + i + '" title="删除该场景" style="float:right;background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:12px;"><i class="fa fa-trash-o"></i></button>'
            + '</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="scenes.' + i + '.description" rows="3">' + esc(sc.description || "") + '</textarea>'
            + (sc.imageUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(sc.imageUrl) + '">' : '')
            + renderItemRefImagesSection(sc, "scenes." + i)
            + '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> 替换图片<input type="file" accept="image/*" class="wf-file-input" data-upload-field="scenes.' + i + '.imageUrl" style="display:none"></label>'
            + '<button class="wf-char-gen-btn" data-gen-scene="' + i + '" data-gen-scene-seg="' + segIdx + '"' + sceneDis + '>'
            + (sceneRunning ? '<i class="fa fa-spinner fa-spin"></i> 生成中' : '<i class="fa fa-refresh"></i> ' + (sc.imageUrl ? '重新生成' : '生成图片'))
            + '</button></div>'
            + '</div>';
        });
      } else if (v && v.description) {
        html += '<div class="wf-detail-section"><textarea class="wf-detail-textarea wf-editable" data-edit-field="description" rows="3">' + esc(v.description) + '</textarea>'
          + (v.imageUrl ? '<img class="wf-detail-img wf-preview-img" src="' + esc(v.imageUrl) + '">' : '') + '</div>';
      }
      if (!ctx.isPipelineNode) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">手动添加场景</div>'
          + '<input class="wf-detail-input wf-manual-label" placeholder="场景名称（如：竹林小径）" style="margin-bottom:6px;">'
          + '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> 上传场景图<input type="file" accept="image/*" class="wf-file-input" data-upload-add="scene" style="display:none"></label></div></div>';
      }
      html += renderRefImagesSection(nd, "scene");
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "scene"); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="scene"' + _dis + '><i class="fa fa-refresh"></i> ' + (v && v.scenes && v.scenes.some(function(s){return s.imageUrl;}) ? "全部重新生成" : "全部生成图片") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: planFrames ── */
  NR.register({
    id: "planFrames", label: "帧画面规划", icon: "fa-magic", color: "#8b5cf6",
    category: "segment", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v ? "已规划" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;
      var skipFF = !!(wf.firstFrameSkip || seg.firstFrameSkip);
      var skipSB = !!(wf.storyboardSkip || seg.storyboardSkip);
      var skipLF = !!(wf.lastFrameSkip || seg.lastFrameSkip);
      if (skipFF && skipSB && skipLF) return { firstFrame: {}, storyboard: {}, lastFrame: {} };
      var mcV = NR.getActiveVersion((wf.mainCharacterss || [])[0]);
      var minorV = NR.getActiveVersion((seg.minorCharacterss || [])[0]);
      var sceneV = NR.getActiveVersion((seg.scenes || [])[0]);
      var scenes = sceneV && sceneV.scenes ? sceneV.scenes : [];
      var isLast = ctx.segIndex === wf.segments.length - 1;
      var prevLastDesc = "";
      var prevPlanningHistory = [];
      var prevStoryboardUrl = "";
      if (ctx.segIndex > 0) {
        var prevSeg = wf.segments[ctx.segIndex - 1];
        if (prevSeg) {
          var prevLfV = NR.getActiveVersion((prevSeg.lastFrames || [])[0]);
          if (prevLfV) prevLastDesc = prevLfV.description || "";
          var prevPlanNd = (prevSeg.planFramess || [])[0];
          if (prevPlanNd) prevPlanningHistory = prevPlanNd.planningHistory || [];
          var prevSbNd = (prevSeg.storyboards || [])[0];
          var prevSbV = NR.getActiveVersion(prevSbNd);
          if (prevSbV && prevSbV.imageUrl) prevStoryboardUrl = prevSbV.imageUrl;
        }
      }
      var planNd = ctx.nodeData;
      var planV = NR.getActiveVersion(planNd);
      var data = await callApi("/api/workflow/generate/plan-frames", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "planFrames"),
        segment_text: seg.scriptText,
        segment_index: ctx.segIndex,
        characters: mcV ? mcV.characters : [],
        minor_characters: minorV ? minorV.characters : [],
        scenes: scenes, style: wf.input.style,
        grid: getStoryboardGrid(),
        resolution: getStoryboardResolution(),
        is_last_segment: isLast,
        prev_last_frame_desc: prevLastDesc,
        prev_planning_history: prevPlanningHistory,
        prev_storyboard_url: prevStoryboardUrl,
        user_hint: (planV && planV.userHint) || (planNd && planNd.userHint) || "",
        skip_first_frame: skipFF,
        skip_storyboard: skipSB,
        skip_last_frame: skipLF,
      });
      var ff = data.first_frame || {};
      var sb = data.storyboard || {};
      var lf = data.last_frame || {};

      // 保存规划历史记录
      if (data.planning_record) {
        if (!planNd.planningHistory) planNd.planningHistory = [];
        planNd.planningHistory.push(data.planning_record);
      }

      if (!skipFF && ff.description) {
        var ffNd = (seg.firstFrames || [])[0];
        if (ffNd) NR.addVersion(ffNd, { description: ff.description || "", visualPrompt: ff.visual_prompt || "" });
      }
      if (!skipSB && (sb.description || (sb.grid_prompts && sb.grid_prompts.length))) {
        var sbNd = (seg.storyboards || [])[0];
        if (sbNd) NR.addVersion(sbNd, { description: sb.description || "", gridPrompts: normalizeGridPrompts(sb.grid_prompts || []) });
      }
      if (!skipLF && lf.description) {
        var lfNd = (seg.lastFrames || [])[0];
        if (lfNd) NR.addVersion(lfNd, { description: lf.description || "", visualPrompt: lf.visual_prompt || "" });
      }
      return { firstFrame: ff, storyboard: sb, lastFrame: lf };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var seg = (ctx.segIndex !== null && ctx.segIndex !== undefined && wf.segments) ? wf.segments[ctx.segIndex] : null;
      var allSkipped = !!(wf.firstFrameSkip || (seg && seg.firstFrameSkip))
        && !!(wf.storyboardSkip || (seg && seg.storyboardSkip))
        && !!(wf.lastFrameSkip || (seg && seg.lastFrameSkip));
      var dis = _getDisabledAttr(ctx, "planFrames");
      var html = '';
      if (allSkipped) {
        html += '<div class="wf-detail-text" style="color:#f59e0b;">首帧、分镜、尾帧节点均已跳过，无需规划</div>';
        return html;
      }

      // 显示规划历史
      if (nd.planningHistory && nd.planningHistory.length > 0) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">规划历史 (' + nd.planningHistory.length + '次)</div>';
        html += '<div style="max-height:200px;overflow-y:auto;font-size:11px;color:#64748b;">';
        nd.planningHistory.forEach(function (record, i) {
          var date = new Date(record.timestamp * 1000);
          var timeStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
          html += '<div style="border-left:2px solid #e2e8f0;padding-left:8px;margin-bottom:8px;">';
          html += '<div style="font-weight:600;color:#475569;">第' + (i + 1) + '次规划 - ' + timeStr + '</div>';
          if (record.first_frame && record.first_frame.description) {
            html += '<div>首帧: ' + esc(record.first_frame.description.slice(0, 40)) + '...</div>';
          }
          if (record.storyboard && record.storyboard.grid_prompts) {
            html += '<div>分镜: ' + record.grid_label + ' (' + record.storyboard.grid_prompts.length + '格)</div>';
          }
          if (record.last_frame && record.last_frame.description) {
            html += '<div>尾帧: ' + esc(record.last_frame.description.slice(0, 40)) + '...</div>';
          }
          html += '</div>';
        });
        html += '</div></div>';
      }

      html += '<div class="wf-detail-section"><div class="wf-detail-label">补充指令</div>'
        + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="userHint" rows="2" placeholder="可选：补充构图、镜头要求等...">' + esc((nd && nd.userHint) || "") + '</textarea></div>';
      html += '<div class="wf-detail-section"><div class="wf-detail-label">风格参考图</div>'
        + '<div class="wf-ref-images-area">';
      var refs = (nd && nd.refImages) || [];
      refs.forEach(function (url, i) {
        html += '<div class="wf-ref-img-item"><img class="wf-ref-img wf-preview-img" src="' + esc(url) + '"><button class="wf-ref-del-btn" data-del-ref="' + i + '"><i class="fa fa-times"></i></button></div>';
      });
      html += '<label class="wf-upload-btn"><i class="fa fa-plus"></i> 添加参考图<input type="file" accept="image/*" class="wf-file-input" data-upload-ref="planFrames" style="display:none"></label>';
      html += '</div></div>';
      if (v) {
        var ff = v.firstFrame || {};
        var sb = v.storyboard || {};
        var lf = v.lastFrame || {};
        var parts = [];
        if (ff.description) parts.push('首帧');
        if (sb.grid_prompts && sb.grid_prompts.length) parts.push('分镜' + sb.grid_prompts.length + '格');
        if (lf.description) parts.push('尾帧');
        html += '<div class="wf-detail-text" style="font-size:11px;color:#94a3b8;">' + (parts.length ? parts.join(' + ') + ' 已规划' : '已规划') + '</div>';
        html += '<div class="wf-detail-text" style="font-size:11px;color:#64748b;">完整描述请查看对应节点</div>';
      }
      if (!ctx.isPipelineNode) { html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="planFrames"' + dis + '><i class="fa fa-magic"></i> ' + (v ? "重新规划" : "开始规划") + '</button>'
        + (v ? '<button class="wf-review-btn" data-review-frame-plan="' + ctx.segIndex + '"><i class="fa fa-search"></i> 审核规划</button>' : '')
        + '</div>'; }
      return html;
    },
  });

  /* ── Node: firstFrame ── */
  NR.register({
    id: "firstFrame", label: "首帧画面", icon: "fa-picture-o", color: "#a855f7",
    category: "segment", allowMultiple: true, maxCount: 5, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.description ? v.description.slice(0, 50) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var vp = (v && v.visualPrompt) || "";
      var desc = (v && v.description) || "";
      if (!vp) throw new Error("请先运行帧画面规划或手动填写描述");
      var mcV = !wf.mainCharactersSkip ? NR.getActiveVersion((wf.mainCharacterss || [])[0]) : null;
      var minorV = !wf.minorCharactersSkip ? NR.getActiveVersion((seg.minorCharacterss || [])[0]) : null;
      var sceneV = !wf.sceneSkip ? NR.getActiveVersion((seg.scenes || [])[0]) : null;
      var scenes = sceneV && sceneV.scenes ? sceneV.scenes : [];
      var data = await callApi("/api/workflow/generate/first-frame", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "firstFrame"),
        visual_prompt: vp, description: desc,
        characters: mcV ? mcV.characters : [],
        minor_characters: minorV ? minorV.characters : [],
        scenes: scenes, style: wf.input.style,
        ref_image_urls: nd.refImages || [],
        image_count: getImageCount("firstFrame"),
      });
      var urls = data.imageUrls || (data.imageUrl ? [data.imageUrl] : []);

      // 生成图片后锁定节点
      if (urls.length > 0) {
        nd.isLocked = true;
        nd.segmentIndex = ctx.segIndex;
      }

      return { description: desc || data.description || "", visualPrompt: vp, imageUrl: urls[0] || "", imageUrls: urls };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var html = "";
      if (v) {
        // 显示锁定状态
        if (nd.isLocked) {
          html += '<div class="wf-detail-section" style="background:#fef3c7;padding:8px;border-radius:4px;margin-bottom:8px;">'
            + '<i class="fa fa-lock" style="color:#f59e0b;"></i> <strong style="color:#f59e0b;">节点已锁定</strong> - 图片已生成，防止误操作'
            + '</div>';
        }
        html += '<div class="wf-detail-section"><div class="wf-detail-label">画面描述</div><textarea class="wf-detail-textarea wf-editable" data-edit-field="description" rows="3">' + esc(v.description || "") + '</textarea></div>';
        if (v.visualPrompt) html += '<div class="wf-detail-section"><div class="wf-detail-label">生图提示词</div><textarea class="wf-detail-textarea wf-editable" data-edit-field="visualPrompt" rows="2">' + esc(v.visualPrompt) + '</textarea></div>';
        if (v.imageUrls && v.imageUrls.length > 1) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">生成结果（点击选择）</div><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">';
          v.imageUrls.forEach(function (url, i) {
            var sel = url === v.imageUrl ? 'border:2px solid #8b5cf6;' : 'border:2px solid transparent;opacity:0.7;';
            html += '<img class="wf-detail-img wf-preview-img" src="' + esc(url) + '" data-pick-image="' + i + '" style="cursor:pointer;border-radius:6px;' + sel + '">';
          });
          html += '</div></div>';
        } else if (v.imageUrl) {
          html += '<img class="wf-detail-img wf-preview-img" src="' + esc(v.imageUrl) + '">';
        }
      }
      html += '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> ' + (v && v.imageUrl ? '替换图片' : '上传首帧图') + '<input type="file" accept="image/*" class="wf-file-input" data-upload-direct="firstFrame" style="display:none"></label></div>';
      html += renderRefImagesSection(nd, "firstFrame");
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "firstFrame"); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="firstFrame"' + _dis + '><i class="fa fa-refresh"></i> ' + (v && v.imageUrl ? "重新生成图片" : "生成图片") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: storyboard ── */
  NR.register({
    id: "storyboard", label: "分镜图", icon: "fa-th", color: "#06b6d4",
    category: "segment", allowMultiple: true, maxCount: 5, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.images ? v.images.length + "张分镜" : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var gridPrompts = normalizeGridPrompts((v && v.gridPrompts) || []);
      var desc = (v && v.description) || "";
      if (!desc && !gridPrompts.length) throw new Error("请先运行帧画面规划或手动填写描述");
      var mcV = !wf.mainCharactersSkip ? NR.getActiveVersion((wf.mainCharacterss || [])[0]) : null;
      var sceneV = !wf.sceneSkip ? NR.getActiveVersion((seg.scenes || [])[0]) : null;
      var ffV = !wf.firstFrameSkip ? NR.getActiveVersion((seg.firstFrames || [])[0]) : null;
      var scenes = sceneV && sceneV.scenes ? sceneV.scenes : [];

      // 获取前段分镜图URL作为参考
      var prevStoryboardUrl = "";
      if (ctx.segIndex > 0) {
        var prevSeg = wf.segments[ctx.segIndex - 1];
        if (prevSeg) {
          var prevSbNd = (prevSeg.storyboards || [])[0];
          var prevSbV = NR.getActiveVersion(prevSbNd);
          if (prevSbV && prevSbV.images && prevSbV.images.length) {
            prevStoryboardUrl = prevSbV.images[0];
          }
        }
      }

      var sbPrompt = "";
      if (gridPrompts.length) {
        sbPrompt = gridPrompts.map(function (gp, i) { return "第" + (i + 1) + "格：" + gp; }).join("，");
      } else {
        sbPrompt = desc;
      }
      var data = await callApi("/api/workflow/generate/storyboard", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "storyboard"),
        storyboard_prompt: sbPrompt,
        characters: mcV ? mcV.characters : [],
        scenes: scenes,
        first_frame_url: ffV ? (ffV.imageUrl || "") : "",
        prev_storyboard_url: prevStoryboardUrl,
        segment_index: ctx.segIndex,
        grid: getStoryboardGrid(),
        style: wf.input.style,
        ref_image_urls: nd.refImages || [],
        resolution: getStoryboardResolution(),
        image_count: getImageCount("storyboard"),
      });

      // 生成图片后锁定节点
      if (data.images && data.images.length > 0) {
        nd.isLocked = true;
        nd.segmentIndex = ctx.segIndex;
      }

      return { description: desc, gridPrompts: gridPrompts, images: data.images || [], grid: data.grid || 4, gridLabel: data.grid_label || "" };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var html = "";
      if (v && v.gridPrompts && v.gridPrompts.length) {
        // 显示锁定状态
        if (nd.isLocked) {
          html += '<div class="wf-detail-section" style="background:#fef3c7;padding:8px;border-radius:4px;margin-bottom:8px;">'
            + '<i class="fa fa-lock" style="color:#f59e0b;"></i> <strong style="color:#f59e0b;">节点已锁定</strong> - 分镜图已生成，防止误操作'
            + '</div>';
        }
        html += '<div class="wf-detail-section"><div class="wf-detail-label">分镜描述 (' + v.gridPrompts.length + '格)</div>';
        v.gridPrompts.forEach(function (gp, i) {
          html += '<div style="margin-bottom:6px;"><strong>格' + (i + 1) + '</strong>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="gridPrompts.' + i + '" rows="2" style="margin-top:2px;">' + esc(gp || "") + '</textarea></div>';
        });
        html += '</div>';
        // 对话历史
        var history = v.chatHistory || [];
        if (history.length) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">修改历史</div><div class="wf-chat-history" id="wf-sb-chat-history">';
          history.forEach(function (msg) {
            if (msg.role === "user") {
              html += '<div class="wf-chat-msg wf-chat-user"><span class="wf-chat-role">你:</span> ' + esc(msg.content) + '</div>';
            } else if (msg.role === "assistant") {
              var aiText = msg.content && msg.content !== "done" ? msg.content : "已根据要求修改分镜";
              html += '<div class="wf-chat-msg wf-chat-ai"><span class="wf-chat-role">AI:</span> ' + esc(aiText) + '</div>';
            }
          });
          html += '</div></div>';
        }
        // 对话输入
        html += '<div class="wf-detail-section"><div class="wf-detail-label">对话修改</div>'
          + '<div class="wf-chat-input-wrap">'
          + '<textarea class="wf-detail-textarea" id="wf-sb-chat-input" rows="2" placeholder="描述你想修改的内容，如：把第2格改成俯拍全景..."></textarea>'
          + '<button class="wf-tb-btn primary" id="wf-sb-chat-send" style="margin-top:6px;"><i class="fa fa-paper-plane"></i> 发送修改</button>'
          + '</div></div>';
      } else if (v && v.description) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">分镜描述</div><textarea class="wf-detail-textarea wf-editable" data-edit-field="description" rows="3">' + esc(v.description) + '</textarea></div>';
      }
      if (v && v.images && v.images.length) {
        var cols = Math.ceil(Math.sqrt(v.images.length));
        html += '<div style="display:grid;grid-template-columns:repeat(' + cols + ',1fr);gap:6px;">';
        v.images.forEach(function (url) { html += '<img class="wf-detail-img wf-preview-img" src="' + esc(url) + '">'; });
        html += '</div>';
      }
      html += '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> ' + (v && v.images && v.images.length ? '替换分镜图' : '上传分镜图') + '<input type="file" accept="image/*" class="wf-file-input" data-upload-direct="storyboard" style="display:none"></label></div>';
      html += renderRefImagesSection(nd, "storyboard");
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "storyboard"); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="storyboard"' + _dis + '><i class="fa fa-refresh"></i> ' + (v && v.images && v.images.length ? "重新生成图片" : "生成图片") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: lastFrame ── */
  NR.register({
    id: "lastFrame", label: "尾帧画面", icon: "fa-picture-o", color: "#f43f5e",
    category: "segment", allowMultiple: true, maxCount: 5, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.description ? v.description.slice(0, 50) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;
      var nd = ctx.nodeData;
      var v = NR.getActiveVersion(nd);
      var vp = (v && v.visualPrompt) || "";
      var desc = (v && v.description) || "";
      if (!vp) throw new Error("请先运行帧画面规划或手动填写描述");
      var mcV = !wf.mainCharactersSkip ? NR.getActiveVersion((wf.mainCharacterss || [])[0]) : null;
      var minorV = !wf.minorCharactersSkip ? NR.getActiveVersion((seg.minorCharacterss || [])[0]) : null;
      var sceneV = !wf.sceneSkip ? NR.getActiveVersion((seg.scenes || [])[0]) : null;
      var sbV = !wf.storyboardSkip ? NR.getActiveVersion((seg.storyboards || [])[0]) : null;
      var scenes = sceneV && sceneV.scenes ? sceneV.scenes : [];
      var data = await callApi("/api/workflow/generate/last-frame", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "lastFrame"),
        visual_prompt: vp, description: desc,
        characters: mcV ? mcV.characters : [],
        minor_characters: minorV ? minorV.characters : [],
        scenes: scenes, style: wf.input.style,
        storyboard_urls: sbV ? sbV.images : [],
        ref_image_urls: nd.refImages || [],
        image_count: getImageCount("lastFrame"),
      });
      var urls = data.imageUrls || (data.imageUrl ? [data.imageUrl] : []);

      // 生成图片后锁定节点
      if (urls.length > 0) {
        nd.isLocked = true;
        nd.segmentIndex = ctx.segIndex;
      }

      return { description: desc || data.description || "", visualPrompt: vp, imageUrl: urls[0] || "", imageUrls: urls };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var html = "";
      if (v) {
        // 显示锁定状态
        if (nd.isLocked) {
          html += '<div class="wf-detail-section" style="background:#fef3c7;padding:8px;border-radius:4px;margin-bottom:8px;">'
            + '<i class="fa fa-lock" style="color:#f59e0b;"></i> <strong style="color:#f59e0b;">节点已锁定</strong> - 图片已生成，防止误操作'
            + '</div>';
        }
        html += '<div class="wf-detail-section"><div class="wf-detail-label">画面描述</div><textarea class="wf-detail-textarea wf-editable" data-edit-field="description" rows="3">' + esc(v.description || "") + '</textarea></div>';
        if (v.visualPrompt) html += '<div class="wf-detail-section"><div class="wf-detail-label">生图提示词</div><textarea class="wf-detail-textarea wf-editable" data-edit-field="visualPrompt" rows="2">' + esc(v.visualPrompt) + '</textarea></div>';
        if (v.imageUrls && v.imageUrls.length > 1) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">生成结果（点击选择）</div><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;">';
          v.imageUrls.forEach(function (url, i) {
            var sel = url === v.imageUrl ? 'border:2px solid #f43f5e;' : 'border:2px solid transparent;opacity:0.7;';
            html += '<img class="wf-detail-img wf-preview-img" src="' + esc(url) + '" data-pick-image="' + i + '" style="cursor:pointer;border-radius:6px;' + sel + '">';
          });
          html += '</div></div>';
        } else if (v.imageUrl) {
          html += '<img class="wf-detail-img wf-preview-img" src="' + esc(v.imageUrl) + '">';
        }
      }
      html += '<div class="wf-upload-wrap"><label class="wf-upload-btn"><i class="fa fa-upload"></i> ' + (v && v.imageUrl ? '替换图片' : '上传尾帧图') + '<input type="file" accept="image/*" class="wf-file-input" data-upload-direct="lastFrame" style="display:none"></label></div>';
      html += renderRefImagesSection(nd, "lastFrame");
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "lastFrame"); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="lastFrame"' + _dis + '><i class="fa fa-refresh"></i> ' + (v && v.imageUrl ? "重新生成图片" : "生成图片") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: videoPrompt ── */
  NR.register({
    id: "videoPrompt", label: "视频提示词", icon: "fa-film", color: "#ec4899",
    category: "segment", allowMultiple: true, maxCount: 5,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      return v && v.fullText ? v.fullText.slice(0, 50) : "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;

      var mcSkip = wf.mainCharactersSkip;
      var minorSkip = wf.minorCharactersSkip || seg.minorCharactersSkip;
      var sceneSkip = wf.sceneSkip || seg.sceneSkip;
      var ffSkip = wf.firstFrameSkip || seg.firstFrameSkip;
      var sbSkip = wf.storyboardSkip || seg.storyboardSkip;
      var lfSkip = wf.lastFrameSkip || seg.lastFrameSkip;

      var mcArr = wf.mainCharacterss || [];
      var mcV = !mcSkip ? NR.getActiveVersion(mcArr[0]) : null;
      var minorV = !minorSkip ? NR.getActiveVersion((seg.minorCharacterss || [])[0]) : null;
      var sceneV = !sceneSkip ? NR.getActiveVersion((seg.scenes || [])[0]) : null;
      var sbV = !sbSkip ? NR.getActiveVersion((seg.storyboards || [])[0]) : null;
      var ffV = !ffSkip ? NR.getActiveVersion((seg.firstFrames || [])[0]) : null;
      var lfV = !lfSkip ? NR.getActiveVersion((seg.lastFrames || [])[0]) : null;

      // 收集所有段落的规划历史和执行进度
      var allSegmentsContext = [];
      for (var i = 0; i < wf.segments.length; i++) {
        var s = wf.segments[i];
        var planNd = (s.planFramess || [])[0];
        var planHistory = planNd ? (planNd.planningHistory || []) : [];
        var sbNd = (s.storyboards || [])[0];
        var sbVer = NR.getActiveVersion(sbNd);
        var ffNd = (s.firstFrames || [])[0];
        var ffVer = NR.getActiveVersion(ffNd);
        var lfNd = (s.lastFrames || [])[0];
        var lfVer = NR.getActiveVersion(lfNd);

        allSegmentsContext.push({
          segment_index: i,
          script_text: s.scriptText || "",
          planning_history: planHistory,
          first_frame_generated: !!(ffVer && ffVer.imageUrl),
          storyboard_generated: !!(sbVer && sbVer.images && sbVer.images.length),
          last_frame_generated: !!(lfVer && lfVer.imageUrl),
          executed_to: sbNd ? (sbNd.executedTo || null) : null
        });
      }

      var scenes = sceneV && sceneV.scenes ? sceneV.scenes : (sceneV && sceneV.description ? [{ name: "场景", description: sceneV.description, imageUrl: sceneV.imageUrl }] : []);
      var gridPrompts = normalizeGridPrompts((sbV && sbV.gridPrompts) ? sbV.gridPrompts : []);
      var data = await callApi("/api/workflow/generate/video-prompt", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "videoPrompt"),
        segment_text: seg.scriptText, segment_index: ctx.segIndex,
        total_segments: wf.segments.length,
        duration: seg.duration || 15,
        scenes: scenes,
        characters: mcV ? mcV.characters : [],
        minor_characters: minorV ? minorV.characters : [],
        storyboard_grid: !sbSkip ? getStoryboardGrid() : 0,
        storyboard_images: sbV ? sbV.images : [],
        grid_prompts: gridPrompts,
        first_frame: ffV ? { description: ffV.description, imageUrl: ffV.imageUrl } : {},
        last_frame: lfV ? { description: lfV.description, imageUrl: lfV.imageUrl } : {},
        style: wf.input.style, type: wf.input.type,
        all_segments_context: allSegmentsContext
      });
      return { fullText: data.full_text || "" };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var html = "";
      if (v) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">完整提示词</div><textarea class="wf-detail-textarea wf-editable" data-edit-field="fullText" rows="10" style="white-space:pre-wrap;">' + esc(v.fullText) + '</textarea></div>';
        // 对话历史
        var history = v.chatHistory || [];
        if (history.length) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">修改历史</div><div class="wf-chat-history" id="wf-chat-history">';
          history.forEach(function (msg) {
            if (msg.role === "user") {
              html += '<div class="wf-chat-msg wf-chat-user"><span class="wf-chat-role">你:</span> ' + esc(msg.content) + '</div>';
            } else if (msg.role === "assistant") {
              var vpAiText = msg.content && msg.content !== "done" ? msg.content : "已根据要求修改提示词";
              html += '<div class="wf-chat-msg wf-chat-ai"><span class="wf-chat-role">AI:</span> ' + esc(vpAiText) + '</div>';
            }
          });
          html += '</div></div>';
        }
        // 对话输入
        html += '<div class="wf-detail-section"><div class="wf-detail-label">对话修改</div>'
          + '<div class="wf-chat-input-wrap">'
          + '<textarea class="wf-detail-textarea" id="wf-vp-chat-input" rows="2" placeholder="描述你想修改的内容，如：把第2段的镜头改成俯拍..."></textarea>'
          + '<button class="wf-tb-btn primary" id="wf-vp-chat-send" style="margin-top:6px;"><i class="fa fa-paper-plane"></i> 发送修改</button>'
          + '</div></div>';
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "videoPrompt"); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="videoPrompt"' + _dis + '><i class="fa fa-refresh"></i> ' + (v ? "重新生成" : "生成") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: storyTemplate ── */
  NR.register({
    id: "storyTemplate", label: "故事模板", icon: "fa-th-large", color: "#f59e0b",
    category: "segment", allowMultiple: false, needsImage: true,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (v && v.imageUrl) return "已生成";
      return "";
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var seg = ctx.segment;
      var nd = ctx.nodeData;

      var mcV = NR.getActiveVersion((wf.mainCharacterss || [])[0]);
      var sceneV = NR.getActiveVersion((seg.scenes || [])[0]);
      var sbV = NR.getActiveVersion((seg.storyboards || [])[0]);
      var grid = getStoryboardGrid();
      var sbGridPrompts = normalizeGridPrompts((sbV && sbV.gridPrompts) || []);

      var data = await callApi("/api/workflow/generate/story-template", {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", "storyTemplate"),
        segment_text: seg.scriptText,
        segment_index: ctx.segIndex,
        total_segments: wf.segments.length,
        duration: seg.duration || 15,
        characters: mcV ? mcV.characters : [],
        scenes: sceneV && sceneV.scenes ? sceneV.scenes : [],
        storyboard_images: sbV ? (sbV.images || []) : [],
        storyboard_grid: grid,
        grid_prompts: sbGridPrompts,
        orientation: getStoryTemplateOrientation(),
        style: wf.input.style,
        image_count: getImageCount("storyTemplate"),
        extra_hint: (nd && nd.reviewHint) || "",
      });
      return { imageUrl: data.imageUrl || "", imageUrls: data.imageUrls || [], prompt: data.prompt || "" };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "storyTemplate");
      var html = "";
      if (v) {
        if (v.prompt) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">生成提示词</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="prompt" rows="4" style="white-space:pre-wrap;">' + esc(v.prompt) + '</textarea></div>';
        }
        if (v.imageUrl) {
          html += '<img class="wf-detail-img wf-preview-img" src="' + esc(v.imageUrl) + '">';
        }
      } else {
        html = '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      html += renderRefImagesSection(nd, "storyTemplate");
      if (!ctx.isPipelineNode) { html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="storyTemplate"' + dis + '><i class="fa fa-refresh"></i> ' + (v && v.imageUrl ? "重新生成" : "生成故事模板") + '</button></div>'; }
      return html;
    },
  });

  /* ── Node: output ── */
  NR.register({
    id: "output", label: "最终输出", icon: "fa-check-circle", color: "#22c55e",
    category: "global", allowMultiple: false,
    getPreview: function () { return ""; },
    renderDetail: function (nd, wf) {
      if (!wf.segments || !wf.segments.length) return '<div class="wf-detail-text" style="color:#64748b;">暂无输出</div>';
      var html = '<div class="wf-detail-section"><div class="wf-detail-label">输出总览 · ' + wf.segments.length + '段</div>';
      wf.segments.forEach(function (seg, i) {
        var vpArr = seg.videoPrompts || [];
        var vp = NR.getActiveVersion(vpArr[0]);
        html += '<div class="wf-detail-text"><strong>段' + (i + 1) + '</strong><br>' + esc(vp ? (vp.fullText || "").slice(0, 150) : "未生成") + '</div>';
      });
      html += '</div>';
      return html;
    },
  });

  /* ── Pipeline Definition ── */
  var VIDEO_PIPELINE = {
    id: "video",
    title: "视频工作流",
    pipeline: [
      { nodeType: "input", category: "global" },
      { nodeType: "script", category: "global" },
      { nodeType: "planCharactersScenes", category: "global" },
      { nodeType: "mainCharacters", category: "global" },
      { nodeType: "minorCharacters", category: "segment" },
      { nodeType: "scene", category: "segment" },
      { nodeType: "planFrames", category: "segment" },
      { nodeType: "firstFrame", category: "segment" },
      { nodeType: "storyboard", category: "segment" },
      { nodeType: "lastFrame", category: "segment" },
      { nodeType: "videoPrompt", category: "segment" },
      { nodeType: "storyTemplate", category: "segment" },
    ],
  };

  /* ── Template Registration ── */
  if (!window.WF_Templates) window.WF_Templates = [];
  window.WF_Templates.push({
    id: "video-short-drama",
    name: "通用短剧一键生成式工作流",
    icon: "fa-film",
    description: "从剧本到视频提示词的完整短剧制作流程",
    pipeline: VIDEO_PIPELINE,
  });

  /* ── Init ── */
  var _initialized = false;
  var _engine = null;
  var _rerender = null;

  async function initWorkflowModule() {
    if (!_initialized) {
      _initialized = true;
      _engine = new WF_Engine(VIDEO_PIPELINE);
      window._wfEngine = _engine;
      _engine.execRange = { from: "script", to: "storyTemplate", segments: "all" };
      _rerender = function () { WF_Renderer.render(_engine); };
      WF_Renderer.bindEvents(_engine, _rerender);
      bindVideoEvents(_engine, _rerender);
      await _engine.load();
    }
    _rerender();
  }

  function bindVideoEvents(engine, rerender) {
    document.addEventListener("click", function (e) {
      var wfRoot = e.target.closest && e.target.closest("#workflow");
      if (!wfRoot) return;

      if (e.target.closest && e.target.closest("#wf-save-input")) {
        var wf = engine.current();
        if (!wf) return;
        wf.input.plot = (document.getElementById("wf-input-plot") || {}).value || "";
        wf.input.style = (document.getElementById("wf-input-style") || {}).value || "";
        wf.input.type = (document.getElementById("wf-input-type") || {}).value || "";
        wf.input.segmentCount = parseInt((document.getElementById("wf-input-segments") || {}).value) || null;
        if (wf.input.plot) {
          var _tpl = (window.WF_Templates || []).find(function (t) { return t.id === wf.templateId; });
          var _defTitle = _tpl ? _tpl.name : "新工作流";
          if (wf.title === _defTitle || wf.title === "新工作流") {
            wf.title = wf.input.plot.replace(/[\n\r]/g, " ").slice(0, 20);
          }
        }
        engine.save();
        rerender();
        return;
      }

      var genGlobal = e.target.closest && e.target.closest("[data-gen-global]");
      if (genGlobal) {
        var nodeType = genGlobal.getAttribute("data-gen-global");
        if (engine.isNodeRunning(nodeType, null)) return;
        runSingleGlobal(engine, nodeType, rerender);
        return;
      }

      var genSeg = e.target.closest && e.target.closest("[data-gen-seg]");
      if (genSeg) {
        var segIdx = parseInt(genSeg.getAttribute("data-gen-seg"));
        var type = genSeg.getAttribute("data-gen-type");
        if (engine.isNodeRunning(type, segIdx)) return;
        runSingleSegment(engine, type, segIdx, rerender);
        return;
      }

      var genChar = e.target.closest && e.target.closest("[data-gen-char]");
      if (genChar) {
        var ci = parseInt(genChar.getAttribute("data-gen-char"));
        var charType = genChar.getAttribute("data-gen-char-type");
        var charSeg = genChar.getAttribute("data-gen-char-seg");
        var segIdx = (charSeg !== null && charSeg !== undefined && charSeg !== "") ? parseInt(charSeg) : null;
        runSingleCharacter(engine, charType, ci, segIdx, rerender);
        return;
      }

      var genScene = e.target.closest && e.target.closest("[data-gen-scene]");
      if (genScene) {
        var sceneIdx = parseInt(genScene.getAttribute("data-gen-scene"));
        var sceneSeg = parseInt(genScene.getAttribute("data-gen-scene-seg"));
        runSingleScene(engine, sceneSeg, sceneIdx, rerender);
        return;
      }

      if (e.target.closest && e.target.closest("#wf-vp-chat-send")) {
        iterateVideoPrompt(engine, rerender);
        return;
      }

      if (e.target.closest && e.target.closest("#wf-sb-chat-send")) {
        iterateStoryboard(engine, rerender);
        return;
      }

      var reviewPlanBtn = e.target.closest && e.target.closest("[data-review-plan]");
      if (reviewPlanBtn) {
        runManualReviewPlan(engine, rerender);
        return;
      }

      var reviewFrameBtn = e.target.closest && e.target.closest("[data-review-frame-plan]");
      if (reviewFrameBtn) {
        var si = parseInt(reviewFrameBtn.getAttribute("data-review-frame-plan"));
        runManualReviewFramePlan(engine, si, rerender);
        return;
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.target.id === "wf-vp-chat-input" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        iterateVideoPrompt(engine, rerender);
      }
      if (e.target.id === "wf-sb-chat-input" && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        iterateStoryboard(engine, rerender);
      }
    });
  }

  async function iterateVideoPrompt(engine, rerender) {
    var input = document.getElementById("wf-vp-chat-input");
    if (!input) return;
    var msg = input.value.trim();
    if (!msg) return;
    var key = engine.selectedNodeKey;
    if (!key) return;
    var nd = WF_Renderer.getNodeDataByKey(engine, key);
    var v = NR.getActiveVersion(nd);
    if (!v || !v.fullText) { alert("请先生成提示词"); return; }

    var btn = document.getElementById("wf-vp-chat-send");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 分析中...'; }
    input.disabled = true;

    try {
      var wf = engine.current();
      var segIdx = WF_Renderer.parseSegIndex(key);
      var seg = (segIdx !== null && wf && wf.segments) ? wf.segments[segIdx] : null;
      var scriptText = seg ? (seg.scriptText || "") : "";

      var refImageUrls = [];
      if (seg) {
        var ffV = NR.getActiveVersion((seg.firstFrames || [])[0]);
        if (ffV && ffV.imageUrl) refImageUrls.push(ffV.imageUrl);
        var sbV = NR.getActiveVersion((seg.storyboards || [])[0]);
        if (sbV && sbV.images) refImageUrls = refImageUrls.concat(sbV.images);
        var lfV = NR.getActiveVersion((seg.lastFrames || [])[0]);
        if (lfV && lfV.imageUrl) refImageUrls.push(lfV.imageUrl);
      }

      var prevHistory = v.chatHistory || [];
      var data = await callApi("/api/workflow/generate/video-prompt-iterate", {
        chat_config_id: getConfigId("chat", "videoPrompt"),
        current_text: v.fullText,
        script_text: scriptText,
        image_urls: refImageUrls,
        chat_history: prevHistory,
        user_message: msg,
      });
      var newText = data.full_text || "";
      if (!newText) { alert("模型返回空内容"); return; }
      var newHistory = prevHistory.slice();
      newHistory.push({ role: "user", content: msg });
      newHistory.push({ role: "assistant", content: data.analysis || "done" });
      NR.addVersion(nd, { fullText: newText, chatHistory: newHistory });
      engine.save();
      rerender();
      requestAnimationFrame(function () { var h = document.getElementById("wf-chat-history"); if (h) h.scrollTop = h.scrollHeight; });
    } catch (err) {
      alert("修改失败：" + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-paper-plane"></i> 发送修改'; }
      if (input) input.disabled = false;
    }
  }

  async function iterateStoryboard(engine, rerender) {
    var input = document.getElementById("wf-sb-chat-input");
    if (!input) return;
    var msg = input.value.trim();
    if (!msg) return;
    var key = engine.selectedNodeKey;
    if (!key) return;
    var nd = WF_Renderer.getNodeDataByKey(engine, key);
    var v = NR.getActiveVersion(nd);
    if (!v || !v.gridPrompts || !v.gridPrompts.length) { alert("请先生成分镜描述"); return; }

    var btn = document.getElementById("wf-sb-chat-send");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 分析中...'; }
    input.disabled = true;

    try {
      var wf = engine.current();
      var segIdx = WF_Renderer.parseSegIndex(key);
      var seg = (segIdx !== null && wf && wf.segments) ? wf.segments[segIdx] : null;
      var scriptText = seg ? (seg.scriptText || "") : "";
      var imageUrls = (v.images && v.images.length) ? v.images : [];
      var prevHistory = v.chatHistory || [];
      var data = await callApi("/api/workflow/generate/storyboard-iterate", {
        chat_config_id: getConfigId("chat", "planFrames"),
        grid_prompts: v.gridPrompts,
        description: v.description || "",
        script_text: scriptText,
        image_urls: imageUrls,
        chat_history: prevHistory,
        user_message: msg,
      });
      var newPrompts = normalizeGridPrompts(data.grid_prompts || v.gridPrompts);
      var newDesc = data.description || v.description || "";
      var newHistory = prevHistory.slice();
      newHistory.push({ role: "user", content: msg });
      newHistory.push({ role: "assistant", content: data.analysis || "done" });
      NR.addVersion(nd, { description: newDesc, gridPrompts: newPrompts, chatHistory: newHistory, images: v.images || [] });
      engine.save();
      rerender();
      requestAnimationFrame(function () { var h = document.getElementById("wf-sb-chat-history"); if (h) h.scrollTop = h.scrollHeight; });
    } catch (err) {
      alert("修改失败：" + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-paper-plane"></i> 发送修改'; }
      if (input) input.disabled = false;
    }
  }

  async function runSingleGlobal(engine, nodeType, rerender) {
    var wf = engine.current();
    if (!wf) return;
    if (engine.isNodeRunning(nodeType, null)) return;
    if (!engine.canExecute(nodeType, null, wf)) {
      alert("依赖节点尚未完成");
      return;
    }
    _syncEditableFields(engine);
    var step = { nodeType: nodeType, category: "global" };
    try {
      await engine._runGlobalStep(wf, step, rerender, true);
      engine.save();
    } catch (err) {
      alert("生成失败：" + err.message);
    } finally {
      rerender();
    }
  }

  async function runSingleSegment(engine, nodeType, segIdx, rerender) {
    var wf = engine.current();
    if (!wf) return;
    if (engine.isNodeRunning(nodeType, segIdx)) return;
    if (!engine.canExecute(nodeType, segIdx, wf)) {
      alert("依赖节点尚未完成");
      return;
    }
    _syncEditableFields(engine);
    var step = { nodeType: nodeType, category: "segment" };
    try {
      await engine._runSegmentStep(wf, step, segIdx, rerender, true);
      engine.save();
    } catch (err) {
      alert("生成失败：" + err.message);
    } finally {
      rerender();
    }
  }

  async function runSingleCharacter(engine, charType, charIndex, segIdx, rerender) {
    var wf = engine.current();
    if (!wf) return;
    _syncEditableFields(engine);
    var nd;
    if (segIdx !== null && segIdx !== undefined) {
      var seg = wf.segments[segIdx];
      if (!seg) return;
      nd = (seg[charType + "s"] || [])[0];
    } else {
      nd = (wf[charType + "s"] || [])[0];
    }
    if (!nd) return;
    var v = NR.getActiveVersion(nd);
    if (!v || !v.characters || !v.characters[charIndex]) return;

    var charRunKey = (segIdx !== null && segIdx !== undefined)
      ? "seg_" + segIdx + "_" + charType + "_0_char_" + charIndex
      : charType + "_0_char_" + charIndex;
    var state = engine._state(wf.id);
    if (state.runningNodes[charRunKey]) return;
    state.runningNodes[charRunKey] = true;
    rerender();

    var singleChar = v.characters[charIndex];
    var charLabel = singleChar.name || ("人物" + (charIndex + 1));
    try {
      // 合并节点级参考图 + 本项参考图，本项优先
      var nodeRefs = nd.refImages || [];
      var itemRefs = singleChar.refImages || [];
      var refImageUrls = itemRefs.concat(nodeRefs.filter(function (u) { return itemRefs.indexOf(u) < 0; }));
      var data = await callApi("/api/workflow/generate/" + (charType === "mainCharacters" ? "main-characters" : "minor-characters"), {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", charType),
        characters: [singleChar],
        style: wf.input.style,
        ref_image_urls: refImageUrls,
        image_count: getImageCount(charType),
      });
      var resultChars = data.characters || [];
      var errs = data.errors || [];
      if (errs.length) {
        engine._addHistory(wf, charType, 0, segIdx, "error", errs[0].message || "生成失败", charLabel);
      } else if (resultChars[0] && resultChars[0].imageUrl) {
        if (resultChars[0].imageUrl) v.characters[charIndex].imageUrl = resultChars[0].imageUrl;
        if (resultChars[0].imageUrls) v.characters[charIndex].imageUrls = resultChars[0].imageUrls;
        engine._addHistory(wf, charType, 0, segIdx, "done", null, charLabel);
      } else {
        engine._addHistory(wf, charType, 0, segIdx, "error", "未返回图片", charLabel);
      }
      engine.saveWorkflow(wf);
    } catch (err) {
      engine._addHistory(wf, charType, 0, segIdx, "error", err.message || "生成失败", charLabel);
      engine.saveWorkflow(wf);
      alert("生成失败：" + err.message);
    } finally {
      delete state.runningNodes[charRunKey];
      rerender();
    }
  }

  async function runSingleScene(engine, segIdx, sceneIndex, rerender) {
    var wf = engine.current();
    if (!wf) return;
    _syncEditableFields(engine);
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var nd = (seg.scenes || [])[0];
    if (!nd) return;
    var v = NR.getActiveVersion(nd);
    if (!v || !v.scenes || !v.scenes[sceneIndex]) return;

    var sceneRunKey = "seg_" + segIdx + "_scene_0_item_" + sceneIndex;
    var state = engine._state(wf.id);
    if (state.runningNodes[sceneRunKey]) return;
    state.runningNodes[sceneRunKey] = true;
    rerender();

    var singleScene = v.scenes[sceneIndex];
    var sceneLabel = singleScene.name || ("场景" + (sceneIndex + 1));
    try {
      var prevScenes = [];
      if (segIdx > 0) {
        var prevSeg = wf.segments[segIdx - 1];
        if (prevSeg) {
          var prevV = NR.getActiveVersion((prevSeg.scenes || [])[0]);
          if (prevV && prevV.scenes) prevScenes = prevV.scenes;
        }
      }
      var nodeRefs = nd.refImages || [];
      var itemRefs = singleScene.refImages || [];
      var refImageUrls = itemRefs.concat(nodeRefs.filter(function (u) { return itemRefs.indexOf(u) < 0; }));
      var data = await callApi("/api/workflow/generate/scene", {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", "scene"),
        scenes: [singleScene],
        prev_segment_scenes: prevScenes,
        style: wf.input.style,
        ref_image_urls: refImageUrls,
        image_count: getImageCount("scene"),
      });
      var resultScenes = data.scenes || [];
      var errs = data.errors || [];
      if (errs.length) {
        engine._addHistory(wf, "scene", 0, segIdx, "error", errs[0].message || "生成失败", sceneLabel);
      } else if (resultScenes[0] && resultScenes[0].imageUrl) {
        if (resultScenes[0].imageUrl) v.scenes[sceneIndex].imageUrl = resultScenes[0].imageUrl;
        if (resultScenes[0].imageUrls) v.scenes[sceneIndex].imageUrls = resultScenes[0].imageUrls;
        engine._addHistory(wf, "scene", 0, segIdx, "done", null, sceneLabel);
      } else {
        engine._addHistory(wf, "scene", 0, segIdx, "error", "未返回图片", sceneLabel);
      }
      engine.saveWorkflow(wf);
    } catch (err) {
      engine._addHistory(wf, "scene", 0, segIdx, "error", err.message || "生成失败", sceneLabel);
      engine.saveWorkflow(wf);
      alert("生成失败：" + err.message);
    } finally {
      delete state.runningNodes[sceneRunKey];
      rerender();
    }
  }

  /* ── Review Functions ── */

  function getMaxRetries() {
    return window.WF_Renderer && window.WF_Renderer.getReviewMaxRetries ? window.WF_Renderer.getReviewMaxRetries() : 2;
  }

  async function reviewPlanCharactersScenes(engine, wf, rerender) {
    var maxRetries = getMaxRetries();
    var pcsNd = (wf.planCharactersSceness || [])[0];
    if (!pcsNd) return;
    if (maxRetries <= 0) { pcsNd.reviewStatus = "passed"; return; }
    var v = NR.getActiveVersion(pcsNd);
    if (!v) { pcsNd.reviewStatus = "passed"; return; }
    var scriptV = NR.getActiveVersion((wf.scripts || [])[0]);
    if (!scriptV || !scriptV.fullText) { pcsNd.reviewStatus = "passed"; return; }
    var state = engine._state(wf.id);

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      engine.setNodeReviewing("planCharactersScenes", null, true, wf.id);
      engine._addHistory(wf, "planCharactersScenes", 0, null, "reviewing");
      if (rerender) rerender();
      try {
        var data = await callApi("/api/workflow/review/plan", {
          chat_config_id: getConfigId("chat", "planCharactersScenes"),
          full_text: scriptV.fullText,
          main_characters: v.mainCharacters || [],
          segments: v.segments || [],
          style: wf.input.style,
        });
        if (data.passed) {
          engine._updateLastReviewHistory(wf, "planCharactersScenes", null, "review_passed");
          pcsNd.reviewStatus = "passed";
          break;
        }
        engine._updateLastReviewHistory(wf, "planCharactersScenes", null, "review_failed", data.analysis || "审核不通过");
        if (data.revised_data) {
          if (data.revised_data.main_characters) v.mainCharacters = data.revised_data.main_characters;
          if (data.revised_data.segments) v.segments = data.revised_data.segments;
          var mcNd = (wf.mainCharacterss || [])[0];
          if (mcNd && data.revised_data.main_characters) NR.addVersion(mcNd, { characters: data.revised_data.main_characters });
          (wf.segments || []).forEach(function (seg, i) {
            var sp = (data.revised_data.segments || [])[i] || {};
            var minorNd = (seg.minorCharacterss || [])[0];
            if (minorNd && sp.minor_characters) NR.addVersion(minorNd, { characters: sp.minor_characters });
            var sceneNd = (seg.scenes || [])[0];
            if (sceneNd && sp.scenes) NR.addVersion(sceneNd, { scenes: sp.scenes, sceneCount: sp.scenes.length });
          });
          NR.addVersion(pcsNd, v);
          engine.saveWorkflow(wf);
        }
      } catch (err) {
        engine._addHistory(wf, "planCharactersScenes", 0, null, "error", "审核调用失败: " + err.message);
        break;
      } finally {
        engine.setNodeReviewing("planCharactersScenes", null, false, wf.id);
        delete state.runningNodes["planCharactersScenes_0"];
        if (rerender) rerender();
      }
    }
    pcsNd.reviewStatus = "passed";
    engine.saveWorkflow(wf);
  }

  async function reviewSceneImage(engine, wf, segIdx, rerender) {
    var maxRetries = getMaxRetries();
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var sceneNd = (seg.scenes || [])[0];
    if (!sceneNd) return;
    if (maxRetries <= 0) { sceneNd.reviewStatus = "passed"; return; }
    var v = NR.getActiveVersion(sceneNd);
    if (!v || !v.scenes || !v.scenes.length) { sceneNd.reviewStatus = "passed"; return; }
    if (!v.scenes.some(function(s){ return s.imageUrl; })) { sceneNd.reviewStatus = "passed"; return; }
    var state = engine._state(wf.id);

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      engine.setNodeReviewing("scene", segIdx, true, wf.id);
      engine._addHistory(wf, "scene", 0, segIdx, "reviewing");
      if (rerender) rerender();
      try {
        var data = await callApi("/api/workflow/review/scene-image", {
          chat_config_id: getConfigId("chat", "planCharactersScenes"),
          scenes: v.scenes,
          segment_text: seg.scriptText || "",
          style: wf.input.style,
        });
        if (data.passed) {
          engine._updateLastReviewHistory(wf, "scene", segIdx, "review_passed");
          sceneNd.reviewStatus = "passed";
          break;
        }
        engine._updateLastReviewHistory(wf, "scene", segIdx, "review_failed", data.analysis || "审核不通过");
        if (data.revised_scenes && data.revised_scenes.length) {
          data.revised_scenes.forEach(function (rs) {
            var idx = rs.index;
            if (idx !== undefined && v.scenes[idx] && rs.visual_prompt) {
              v.scenes[idx].visual_prompt = rs.visual_prompt;
            }
          });
          engine.saveWorkflow(wf);
          var step = { nodeType: "scene", category: "segment" };
          await engine._runSegmentStep(wf, step, segIdx, rerender, true);
          v = NR.getActiveVersion(sceneNd);
          if (!v || !v.scenes) break;
        } else { break; }
      } catch (err) {
        engine._addHistory(wf, "scene", 0, segIdx, "error", "审核调用失败: " + err.message);
        break;
      } finally {
        engine.setNodeReviewing("scene", segIdx, false, wf.id);
        delete state.runningNodes["seg_" + segIdx + "_scene_0"];
        if (rerender) rerender();
      }
    }
    sceneNd.reviewStatus = "passed";
    engine.saveWorkflow(wf);
  }

  // PLACEHOLDER_MORE_REVIEW_FUNCTIONS

  async function reviewFramePlan(engine, wf, segIdx, rerender) {
    var maxRetries = getMaxRetries();
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var pfNd = (seg.planFramess || [])[0];
    if (!pfNd) return;
    if (maxRetries <= 0) { pfNd.reviewStatus = "passed"; return; }
    var v = NR.getActiveVersion(pfNd);
    if (!v) { pfNd.reviewStatus = "passed"; return; }
    var state = engine._state(wf.id);

    var skipFF = !!(wf.firstFrameSkip || seg.firstFrameSkip);
    var skipSB = !!(wf.storyboardSkip || seg.storyboardSkip);
    var skipLF = !!(wf.lastFrameSkip || seg.lastFrameSkip);

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      engine.setNodeReviewing("planFrames", segIdx, true, wf.id);
      engine._addHistory(wf, "planFrames", 0, segIdx, "reviewing");
      if (rerender) rerender();
      try {
        var data = await callApi("/api/workflow/review/frame-plan", {
          chat_config_id: getConfigId("chat", "planFrames"),
          segment_text: seg.scriptText || "",
          first_frame: skipFF ? {} : (v.firstFrame || {}),
          storyboard: skipSB ? {} : (v.storyboard || {}),
          last_frame: skipLF ? {} : (v.lastFrame || {}),
          style: wf.input.style,
        });
        if (data.passed) {
          engine._updateLastReviewHistory(wf, "planFrames", segIdx, "review_passed");
          pfNd.reviewStatus = "passed";
          break;
        }
        engine._updateLastReviewHistory(wf, "planFrames", segIdx, "review_failed", data.analysis || "审核不通过");
        if (data.revised_data) {
          var rd = data.revised_data;
          if (!skipFF && rd.first_frame && rd.first_frame.description) {
            var ffNd = (seg.firstFrames || [])[0];
            if (ffNd) NR.addVersion(ffNd, { description: rd.first_frame.description, visualPrompt: rd.first_frame.visual_prompt || "" });
          }
          if (!skipSB && rd.storyboard && rd.storyboard.grid_prompts) {
            var sbNd = (seg.storyboards || [])[0];
            if (sbNd) NR.addVersion(sbNd, { description: rd.storyboard.description || "", gridPrompts: normalizeGridPrompts(rd.storyboard.grid_prompts) });
          }
          if (!skipLF && rd.last_frame && rd.last_frame.description) {
            var lfNd = (seg.lastFrames || [])[0];
            if (lfNd) NR.addVersion(lfNd, { description: rd.last_frame.description, visualPrompt: rd.last_frame.visual_prompt || "" });
          }
          engine.saveWorkflow(wf);
        } else { break; }
      } catch (err) {
        engine._addHistory(wf, "planFrames", 0, segIdx, "error", "审核调用失败: " + err.message);
        break;
      } finally {
        engine.setNodeReviewing("planFrames", segIdx, false, wf.id);
        delete state.runningNodes["seg_" + segIdx + "_planFrames_0"];
        if (rerender) rerender();
      }
    }
    pfNd.reviewStatus = "passed";
    engine.saveWorkflow(wf);
  }

  async function reviewImage(engine, wf, segIdx, nodeType, rerender) {
    var maxRetries = getMaxRetries();
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var nd = (seg[nodeType + "s"] || [])[0];
    if (!nd) return;
    if (maxRetries <= 0) { nd.reviewStatus = "passed"; return; }
    var v = NR.getActiveVersion(nd);
    if (!v) { nd.reviewStatus = "passed"; return; }
    var state = engine._state(wf.id);

    var imageUrls = [];
    if (nodeType === "storyboard") { imageUrls = v.images || []; }
    else { imageUrls = v.imageUrl ? [v.imageUrl] : (v.imageUrls || []); }
    if (!imageUrls.length) { nd.reviewStatus = "passed"; return; }

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      engine.setNodeReviewing(nodeType, segIdx, true, wf.id);
      engine._addHistory(wf, nodeType, 0, segIdx, "reviewing");
      if (rerender) rerender();
      try {
        var data = await callApi("/api/workflow/review/image", {
          chat_config_id: getConfigId("chat", "planFrames"),
          node_type: nodeType,
          image_urls: imageUrls,
          description: v.description || "",
          visual_prompt: v.visualPrompt || "",
          segment_text: seg.scriptText || "",
          style: wf.input.style,
        });
        if (data.passed) {
          engine._updateLastReviewHistory(wf, nodeType, segIdx, "review_passed");
          nd.reviewStatus = "passed";
          break;
        }
        engine._updateLastReviewHistory(wf, nodeType, segIdx, "review_failed", data.analysis || "审核不通过");
        if (data.revised_visual_prompt) {
          v.visualPrompt = data.revised_visual_prompt;
          engine.saveWorkflow(wf);
          var step = { nodeType: nodeType, category: "segment" };
          await engine._runSegmentStep(wf, step, segIdx, rerender, true);
          v = NR.getActiveVersion(nd);
          if (!v) break;
          if (nodeType === "storyboard") { imageUrls = v.images || []; }
          else { imageUrls = v.imageUrl ? [v.imageUrl] : (v.imageUrls || []); }
          if (!imageUrls.length) break;
        } else { break; }
      } catch (err) {
        engine._addHistory(wf, nodeType, 0, segIdx, "error", "审核调用失败: " + err.message);
        break;
      } finally {
        engine.setNodeReviewing(nodeType, segIdx, false, wf.id);
        delete state.runningNodes["seg_" + segIdx + "_" + nodeType + "_0"];
        if (rerender) rerender();
      }
    }
    nd.reviewStatus = "passed";
    engine.saveWorkflow(wf);
  }

  async function reviewVideoPrompt(engine, wf, segIdx, rerender) {
    var maxRetries = getMaxRetries();
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var vpNd = (seg.videoPrompts || [])[0];
    if (!vpNd) return;
    if (maxRetries <= 0) { vpNd.reviewStatus = "passed"; return; }
    var v = NR.getActiveVersion(vpNd);
    if (!v || !v.fullText) { vpNd.reviewStatus = "passed"; return; }
    var state = engine._state(wf.id);

    var ffV = NR.getActiveVersion((seg.firstFrames || [])[0]);
    var sbV = NR.getActiveVersion((seg.storyboards || [])[0]);
    var lfV = NR.getActiveVersion((seg.lastFrames || [])[0]);

    var refImageUrls = [];
    if (ffV && ffV.imageUrl) refImageUrls.push(ffV.imageUrl);
    if (sbV && sbV.images) refImageUrls = refImageUrls.concat(sbV.images);
    if (lfV && lfV.imageUrl) refImageUrls.push(lfV.imageUrl);

    for (var attempt = 0; attempt < maxRetries; attempt++) {
      engine.setNodeReviewing("videoPrompt", segIdx, true, wf.id);
      engine._addHistory(wf, "videoPrompt", 0, segIdx, "reviewing");
      if (rerender) rerender();
      var shouldRegen = false;
      var failAnalysis = "";
      try {
        var data = await callApi("/api/workflow/review/video-prompt", {
          chat_config_id: getConfigId("chat", "videoPrompt"),
          full_text: v.fullText,
          segment_text: seg.scriptText || "",
          style: wf.input.style,
          first_frame_url: ffV ? (ffV.imageUrl || "") : "",
          last_frame_url: lfV ? (lfV.imageUrl || "") : "",
          storyboard_urls: sbV ? (sbV.images || []) : [],
        });
        var analysis = (data.analysis || "").trim();
        if (data.passed) {
          engine._updateLastReviewHistory(wf, "videoPrompt", segIdx, "review_passed", analysis);
          vpNd.reviewStatus = "passed";
          break;
        }
        failAnalysis = analysis || "审核未通过但模型未给出具体原因";
        engine._updateLastReviewHistory(wf, "videoPrompt", segIdx, "review_failed", failAnalysis);

        if (data.revised_full_text && data.revised_full_text.trim()) {
          NR.addVersion(vpNd, { fullText: data.revised_full_text.trim() });
          engine.saveWorkflow(wf);
          v = NR.getActiveVersion(vpNd);
        } else {
          shouldRegen = true;
        }
      } catch (err) {
        engine._addHistory(wf, "videoPrompt", 0, segIdx, "error", "审核调用失败: " + err.message);
        break;
      } finally {
        engine.setNodeReviewing("videoPrompt", segIdx, false, wf.id);
        delete state.runningNodes["seg_" + segIdx + "_videoPrompt_0"];
        if (rerender) rerender();
      }

      if (!shouldRegen) continue;
      if (attempt === maxRetries - 1) break;

      try {
        var prevHistory = v.chatHistory || [];
        var iterData = await callApi("/api/workflow/generate/video-prompt-iterate", {
          chat_config_id: getConfigId("chat", "videoPrompt"),
          current_text: v.fullText,
          script_text: seg.scriptText || "",
          image_urls: refImageUrls,
          chat_history: prevHistory,
          user_message: failAnalysis,
        });
        var newText = (iterData.full_text || "").trim();
        if (!newText) break;
        var newHistory = prevHistory.slice();
        newHistory.push({ role: "user", content: "[自动审核反馈] " + failAnalysis });
        newHistory.push({ role: "assistant", content: iterData.analysis || "done" });
        NR.addVersion(vpNd, { fullText: newText, chatHistory: newHistory });
        engine.saveWorkflow(wf);
        v = NR.getActiveVersion(vpNd);
      } catch (err2) {
        engine._addHistory(wf, "videoPrompt", 0, segIdx, "error", "重新生成失败: " + err2.message);
        break;
      }
    }
    vpNd.reviewStatus = "passed";
    engine.saveWorkflow(wf);
  }

  async function reviewStoryTemplate(engine, wf, segIdx, rerender) {
    var maxRetries = getMaxRetries();
    var seg = wf.segments[segIdx];
    if (!seg) return;
    var stNd = (seg.storyTemplates || [])[0];
    if (!stNd) return;
    if (maxRetries <= 0) { stNd.reviewStatus = "passed"; return; }
    var v = NR.getActiveVersion(stNd);
    if (!v || !v.imageUrl) { stNd.reviewStatus = "passed"; return; }
    var state = engine._state(wf.id);

    var didPass = false;
    for (var attempt = 0; attempt < maxRetries; attempt++) {
      engine.setNodeReviewing("storyTemplate", segIdx, true, wf.id);
      engine._addHistory(wf, "storyTemplate", 0, segIdx, "reviewing");
      if (rerender) rerender();
      var shouldRegen = false;
      try {
        var sbV = NR.getActiveVersion((seg.storyboards || [])[0]);
        var sbUrls = sbV && sbV.images ? sbV.images : [];
        var sbGridPrompts = normalizeGridPrompts((sbV && sbV.gridPrompts) || []);
        var data = await callApi("/api/workflow/review/story-template", {
          chat_config_id: getConfigId("chat", "planFrames"),
          image_url: v.imageUrl,
          segment_text: seg.scriptText || "",
          style: wf.input.style,
          current_prompt: v.prompt || "",
          storyboard_urls: sbUrls,
          grid_prompts: sbGridPrompts,
        });
        var analysis = (data.analysis || "").trim();
        if (data.passed) {
          engine._updateLastReviewHistory(wf, "storyTemplate", segIdx, "review_passed", analysis || "审核通过");
          stNd.reviewStatus = "passed";
          stNd.reviewHint = "";
          didPass = true;
          break;
        }
        var hint = (data.revise_hint || "").trim();
        var failMsg = analysis || hint || "审核不通过（模型未给出具体原因）";
        engine._updateLastReviewHistory(wf, "storyTemplate", segIdx, "review_failed", failMsg);

        if (data.revised_prompt && data.revised_prompt.trim()) {
          v.prompt = data.revised_prompt.trim();
          stNd.reviewHint = hint;
          shouldRegen = true;
        } else if (hint) {
          stNd.reviewHint = hint;
          shouldRegen = true;
        } else {
          stNd.reviewHint = analysis || "请根据上一次审核意见进一步优化画面与分镜对照";
          shouldRegen = true;
        }
      } catch (err) {
        engine._addHistory(wf, "storyTemplate", 0, segIdx, "error", "审核调用失败: " + err.message);
        break;
      } finally {
        engine.setNodeReviewing("storyTemplate", segIdx, false, wf.id);
        delete state.runningNodes["seg_" + segIdx + "_storyTemplate_0"];
        if (rerender) rerender();
      }

      if (!shouldRegen) break;
      if (attempt === maxRetries - 1) break;

      try {
        engine.saveWorkflow(wf);
        var step = { nodeType: "storyTemplate", category: "segment" };
        await engine._runSegmentStep(wf, step, segIdx, rerender, true);
        v = NR.getActiveVersion(stNd);
        if (!v || !v.imageUrl) break;
      } catch (err2) {
        engine._addHistory(wf, "storyTemplate", 0, segIdx, "error", "重新生成失败: " + err2.message);
        break;
      }
    }
    stNd.reviewStatus = "passed";
    if (didPass) stNd.reviewHint = "";
    engine.saveWorkflow(wf);
  }

  /* ── Manual Review Handlers ── */

  async function runManualReviewPlan(engine, rerender) {
    var wf = engine.current();
    if (!wf) return;
    await reviewPlanCharactersScenes(engine, wf, rerender);
    engine.save();
    rerender();
  }

  async function runManualReviewFramePlan(engine, segIdx, rerender) {
    var wf = engine.current();
    if (!wf) return;
    await reviewFramePlan(engine, wf, segIdx, rerender);
    engine.save();
    rerender();
  }

  /* ── Hook reviews into one-click execution ── */
  window.WF_ReviewHooks = {
    afterNodeComplete: async function (engine, wf, nodeType, segIdx, rerender) {
      var maxRetries = getMaxRetries();
      if (maxRetries <= 0) return;
      switch (nodeType) {
        case "planCharactersScenes":
          await reviewPlanCharactersScenes(engine, wf, rerender);
          break;
        case "scene":
          if (segIdx !== null && segIdx !== undefined)
            await reviewSceneImage(engine, wf, segIdx, rerender);
          break;
        case "planFrames":
          if (segIdx !== null && segIdx !== undefined)
            await reviewFramePlan(engine, wf, segIdx, rerender);
          break;
        case "firstFrame":
        case "storyboard":
        case "lastFrame":
          if (segIdx !== null && segIdx !== undefined)
            await reviewImage(engine, wf, segIdx, nodeType, rerender);
          break;
        case "videoPrompt":
          if (segIdx !== null && segIdx !== undefined)
            await reviewVideoPrompt(engine, wf, segIdx, rerender);
          break;
        case "storyTemplate":
          if (segIdx !== null && segIdx !== undefined)
            await reviewStoryTemplate(engine, wf, segIdx, rerender);
          break;
      }
    }
  };

  window.initWorkflowModule = initWorkflowModule;
  window._getGlobalNodeConfigs = _getGlobalNodeConfigs;
  window._saveGlobalNodeConfigs = _saveGlobalNodeConfigs;
})();
