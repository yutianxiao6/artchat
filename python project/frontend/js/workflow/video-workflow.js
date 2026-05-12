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
      if (field === "promptTemplate") {
        if (nd.promptTemplate !== el.value) { nd.promptTemplate = el.value; changed = true; }
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

  // 取出本段 planFrames 规划得到的"出场人物名"集合；未规划过返回 null（表示退回全部）
  function getAppearingCharNames(seg) {
    var pfNd = (seg && seg.planFramess || [])[0];
    if (!pfNd) return null;
    var pfV = NR.getActiveVersion(pfNd);
    if (pfV && Array.isArray(pfV.appearingCharacters)) return pfV.appearingCharacters;
    var hist = pfNd.planningHistory || [];
    for (var i = hist.length - 1; i >= 0; i--) {
      var rec = hist[i] || {};
      if (Array.isArray(rec.appearing_characters)) return rec.appearing_characters;
    }
    return null;
  }

  // 按出场人物名过滤角色列表；未规划返回原列表，明确空数组则返回空
  function filterCharsByAppearing(allChars, appearingNames) {
    if (!Array.isArray(allChars)) return [];
    if (!Array.isArray(appearingNames)) return allChars;
    if (appearingNames.length === 0) return [];
    var nameSet = {};
    appearingNames.forEach(function (n) { if (typeof n === "string") nameSet[n.trim()] = true; });
    return allChars.filter(function (c) { return c && nameSet[(c.name || "").trim()]; });
  }

  async function callApi(url, body) {
    var res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var result = await res.json();
    if (result.code !== 0) throw new Error(result.message || result.detail || "生成失败");
    return result.data;
  }

  // ── 多剧集辅助 ─────────────────────────────
  // 取出当前剧集之前的所有剧集摘要（剧本/主要人物/场景），供续写时参考
  function getPrevEpisodesContext(wf) {
    if (!wf || !wf.episodes || wf.episodes.length < 2) return null;
    var curId = wf.currentEpisodeId;
    var curIdx = wf.episodes.findIndex(function (e) { return e.id === curId; });
    if (curIdx <= 0) return null;
    var prev = wf.episodes.slice(0, curIdx);
    // 主要人物已提升为跨集共享，从 wf 顶层读
    var sharedMcV = NR.getActiveVersion((wf.mainCharacterss || [])[0]);
    var sharedMain = sharedMcV && sharedMcV.characters ? sharedMcV.characters : [];
    var summaries = prev.map(function (ep) {
      var scriptV = NR.getActiveVersion((ep.scripts || [])[0]);
      var lastSeg = (ep.segments || [])[(ep.segments || []).length - 1];
      var lastLfV = lastSeg ? NR.getActiveVersion((lastSeg.lastFrames || [])[0]) : null;
      return {
        index: ep.index,
        title: ep.title || ("第" + (ep.index + 1) + "集"),
        plot: ep.plot || "",
        full_text: scriptV ? (scriptV.fullText || "") : "",
        segments: scriptV ? (scriptV.segments || []).map(function (s) { return { text: s.text || "" }; }) : [],
        main_characters: sharedMain.map(function (c) {
          return { name: c.name, description: c.description || "", visual_prompt: c.visual_prompt || "", imageUrl: c.imageUrl || "" };
        }),
        last_frame_desc: lastLfV ? (lastLfV.description || "") : "",
      };
    });
    // 收集所有前集 + 各段的场景（按 name 去重，保留最早的图）
    var prevScenes = [];
    var seenScene = {};
    prev.forEach(function (ep) {
      (ep.segments || []).forEach(function (seg) {
        var sV = NR.getActiveVersion((seg.scenes || [])[0]);
        if (sV && sV.scenes) {
          sV.scenes.forEach(function (sc) {
            var nm = (sc.name || "").trim();
            if (!nm || seenScene[nm]) return;
            seenScene[nm] = true;
            prevScenes.push({
              name: nm,
              description: sc.description || "",
              visual_prompt: sc.visual_prompt || "",
              imageUrl: sc.imageUrl || "",
              imageUrls: sc.imageUrls || [],
            });
          });
        }
      });
    });
    return { episodes: summaries, prev_scenes: prevScenes, all_main_characters: sharedMain };
  }

  // ── 预设缓存（character / storyTemplate） ─────────────────────────────
  // 兜底：即使后端 /api/workflow/presets 没启动或失败，前端也能用
  var _PRESETS_FALLBACK = {
    character: [
      {
        id: "default",
        name: "四视图角色模型图",
        width: 1152, height: 2048,
        template: "{style}风格，2x2四视图网格，角色模型图，白色背景，直立姿势，正面/侧面/背面/四分之三角度，{description}",
      },
      {
        id: "realPhoto",
        name: "真人写实设定集",
        width: 3840, height: 2160,
        template: "基于参考图中的角色和背景，制作一份类似官方设定集的角色视觉参考表。\n核心要求：绝对真实的真人摄影级质感，极致的真人皮肤纹理与真实物理光影。\n具体内容需包含：\n1) 该真人角色的正面、侧面、背面的全身三面图；\n2) 不同面部表情特写（清晰的毛孔级写实特写）；\n3) 服装和装备的详细部件高分辨率真实材质拆解展示；\n4) 色彩搭配色板；\n5) 画面边缘加入简短的世界观文字排版说明。\n排版与参数：整体排版整洁有序，纯白背景，图解风排版格式。\n画面比例 16:9，8K超高分辨率，顶级商业摄影棚实拍画质。\n角色描述：{description}",
      },
    ],
    storyTemplate: [
      { id: "boardImage", name: "电影故事板（图文设计图）", kind: "image", template: "" },
      {
        id: "shotListMd",
        name: "11栏分镜表（Markdown）",
        kind: "text",
        system_prompt: "Role: 资深分镜师 (Senior Storyboard Artist)\nProfile: 你是一名拥有 10 年经验的专业电影分镜师，擅长将文字剧本转化为视觉化的分镜表格。你精通镜头语言、构图美学、节奏把控以及音效设计。\n\nTask: 我将提供一段剧本内容，请你将其拆解并转化为标准的【分镜表】。\n核心目标：确保剧本中的每一段文字（包括动作描述、环境描写、对白）都有对应的镜头呈现，严禁遗漏任何剧情细节。\n\n输出格式必须为 Markdown 表格，必须包含以下 11 列，顺序不可变：[镜头号，时长，角色，场景，景别，拍摄角度，运镜，构图，画面描述，对白，音效]\n\n关键规则：\n- 角色栏填写画面中可见的所有角色（不仅仅是说话者）。\n- 一句话≈一个镜头，长台词必须拆分。\n- 动作/环境必须独立成镜头。\n- 拍摄角度独立成列，禁止连续 3 个镜头使用相同角度。\n- 对白格式：【角色名】(情绪)：台词内容；纯动作或环境镜头填\"——\"。\n- 优先使用过肩镜头建立空间关系，交替正反打。",
        user_template: "[在此处粘贴你的剧本]",
      },
    ],
  };
  var _PRESETS_CACHE = _PRESETS_FALLBACK;   // 默认就用 fallback，加载后再覆盖
  var _PRESETS_LOADING = null;
  async function loadPresets() {
    if (_PRESETS_CACHE) return _PRESETS_CACHE;
    if (_PRESETS_LOADING) return _PRESETS_LOADING;
    _PRESETS_LOADING = (async function () {
      try {
        var res = await fetch("/api/workflow/presets");
        var json = await res.json();
        if (json.code === 0) _PRESETS_CACHE = json.data || { character: [], storyTemplate: [] };
      } catch (e) {}
      if (!_PRESETS_CACHE) _PRESETS_CACHE = { character: [], storyTemplate: [] };
      _PRESETS_LOADING = null;
      // 加载完成后触发一次重渲染，确保已经打开的详情面板能看到所有预设
      try {
        if (window._wfEngine && window.WF_Renderer && window.WF_Renderer.render) {
          window.WF_Renderer.render(window._wfEngine);
        }
      } catch (e) {}
      return _PRESETS_CACHE;
    })();
    return _PRESETS_LOADING;
  }
  function presetsSync() { return _PRESETS_CACHE || { character: [], storyTemplate: [] }; }
  function findPreset(kind, id) {
    var list = (presetsSync()[kind]) || [];
    return list.find(function (p) { return p.id === id; }) || list[0] || null;
  }
  // 启动时主动拉一次
  loadPresets();
  window.WF_loadPresets = loadPresets;
  window.WF_findPreset = findPreset;
  window.WF_presetsSync = presetsSync;

  function renderPresetSelector(nd, kind, defaultId, onChangeAttr, ctx, nodeType) {
    var presets = (presetsSync()[kind]) || [];
    if (!presets.length) return "";
    // pipeline 顶部节点 nd 是空对象，从第一个 segment 节点取真实状态
    var probe = nd;
    if (ctx && ctx.isPipelineNode && nodeType && ctx.engine) {
      var wf = ctx.engine.current();
      if (wf) {
        var def = NR.get(nodeType);
        if (def && def.category === "segment") {
          var firstSeg = (wf.segments || [])[0];
          var arr = firstSeg ? (firstSeg[nodeType + "s"] || []) : [];
          if (arr[0]) probe = arr[0];
        } else if (def && def.category === "global") {
          var garr = wf[nodeType + "s"] || [];
          if (garr[0]) probe = garr[0];
        }
      }
    }
    var curId = (probe && probe.presetId) || defaultId || presets[0].id;
    var template = (probe && probe.promptTemplate) || "";
    if (!template) {
      var p = presets.find(function (x) { return x.id === curId; }) || presets[0];
      template = (p && (p.template || p.system_prompt)) || "";
    }
    var opts = presets.map(function (p) {
      var sel = p.id === curId ? " selected" : "";
      return '<option value="' + esc(p.id) + '"' + sel + '>' + esc(p.name) + '</option>';
    }).join("");
    var html = '<div class="wf-detail-section"><div class="wf-detail-label">预设</div>'
      + '<div style="display:flex;gap:6px;align-items:center;">'
      + '<select class="wf-detail-input" data-preset-select="' + esc(kind) + '" data-preset-target="' + esc(onChangeAttr) + '" style="flex:1;">' + opts + '</select>'
      + '<button class="wf-tb-btn" data-preset-reset="' + esc(kind) + '" title="恢复该预设默认模板"><i class="fa fa-undo"></i></button>'
      + '</div></div>'
      + '<div class="wf-detail-section"><div class="wf-detail-label">提示词模板（可编辑，{style}/{description} 为占位符）</div>'
      + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="promptTemplate" rows="6" placeholder="留空则使用预设默认模板">' + esc(template) + '</textarea>'
      + '</div>';
    return html;
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
      var eng = window._wfEngine;
      var curEp = (eng && eng.currentEpisode) ? eng.currentEpisode(wf) : null;
      var isSequel = curEp && curEp.index > 0;
      var epPlot = (curEp && curEp.plot) || "";
      var html = '<div class="wf-detail-section"><div class="wf-detail-label">' + (isSequel ? '本集情节简述（续写第' + (curEp.index + 1) + '集）' : '简要情节') + '</div>'
        + '<textarea class="wf-detail-textarea" id="wf-input-plot" rows="4" placeholder="描述你的视频故事情节...">' + esc(isSequel ? epPlot : wf.input.plot) + '</textarea></div>';
      if (isSequel) {
        html += '<div class="wf-detail-text" style="font-size:11px;color:#64748b;margin-top:-8px;">提示：本集的风格、类型沿用下方全局设置，剧本会自动参考前集结局承接。</div>';
      }
      html += '<div class="wf-detail-section"><div class="wf-detail-label">视频风格（全集通用）</div>'
        + '<input class="wf-detail-input" id="wf-input-style" placeholder="如：水墨国风、赛博朋克..." value="' + esc(wf.input.style) + '"></div>'
        + '<div class="wf-detail-section"><div class="wf-detail-label">视频类型（全集通用）</div>'
        + '<input class="wf-detail-input" id="wf-input-type" placeholder="如：短剧、广告、MV..." value="' + esc(wf.input.type) + '"></div>';
      if (!isSequel) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">集数（>1 时由"剧集规划"节点拆分；留空或 1 则直接生成单集剧本）</div>'
          + '<input class="wf-detail-input" id="wf-input-episodes" type="number" min="1" max="20" placeholder="留空=单集" value="' + (wf.input.episodeCount || "") + '"></div>';
      }
      html += '<div class="wf-detail-section"><div class="wf-detail-label">每集段数（留空=AI自动；多集时所有集段数相同）</div>'
        + '<input class="wf-detail-input" id="wf-input-segments" type="number" min="1" max="30" placeholder="AI自动决定" value="' + (wf.input.segmentCount || "") + '"></div>'
        + '<div class="wf-detail-actions"><button class="wf-tb-btn primary" id="wf-save-input">保存</button></div>';
      return html;
    },
  });

  /* ── Node: episodePlan ── */
  // 智能规划剧集：拆分大剧本到多集的 plot，避免 script 节点 token 超限。
  // - 集数 <= 1：节点视为"已就绪"（由 engine.isNodeComplete 处理），跳过生成
  // - 集数 > 1：模型把总情节均匀分配到 N 集，填充各 episode.plot
  NR.register({
    id: "episodePlan", label: "剧集规划", icon: "fa-sitemap", color: "#0ea5e9",
    category: "global", allowMultiple: false,
    getPreview: function (nd) {
      var v = NR.getActiveVersion(nd);
      if (!v) return "";
      var eps = v.episodes || [];
      if (!eps.length) return "";
      return "已规划 " + eps.length + " 集：" + eps.map(function (e) { return e.title || ("第" + (e.index + 1) + "集"); }).slice(0, 3).join(" / ") + (eps.length > 3 ? " ..." : "");
    },
    generate: async function (ctx) {
      var wf = ctx.workflow;
      var engine = window._wfEngine;
      var epCount = parseInt(wf.input.episodeCount) || 1;
      var plot = wf.input.plot || "";
      if (!plot) throw new Error("请先填写输入情节");

      var data = await callApi("/api/workflow/generate/episode-plan", {
        chat_config_id: getConfigId("chat", "episodePlan"),
        plot: plot,
        style: wf.input.style,
        type: wf.input.type,
        episode_count: epCount,
      });
      var episodes = (data.episodes || []).slice(0, Math.max(1, epCount));
      if (!episodes.length) throw new Error("模型未返回分集大纲");

      // 把拆分结果落到 wf.episodes
      // 现有 wf.episodes[0] 作为第1集；多出来的集创建 addEpisode
      if (engine && wf.episodes && wf.episodes.length) {
        var firstEp = wf.episodes[0];
        firstEp.plot = episodes[0].plot || plot;
        firstEp.title = episodes[0].title || firstEp.title || "第1集";
        // 续集：只在当前只有 1 集时创建，避免覆盖已有续写
        if (wf.episodes.length === 1) {
          for (var ei = 1; ei < episodes.length; ei++) {
            var ep = engine.addEpisode(episodes[ei].title || ("第" + (ei + 1) + "集"));
            if (ep) {
              ep.plot = episodes[ei].plot || "";
            }
          }
          engine.switchEpisode(firstEp.id);
        }
      }

      return { episodes: episodes };
    },
    renderDetail: function (nd, wf, ctx) {
      var dis = _getDisabledAttr(ctx, "episodePlan");
      var epCount = parseInt(wf.input.episodeCount) || 1;
      var v = NR.getActiveVersion(nd);
      var html = "";
      if (epCount <= 1) {
        html += '<div class="wf-detail-text" style="color:#64748b;">当前集数为 1，无需拆分；本节点自动通过，直接进入剧本生成。</div>';
        html += '<div class="wf-detail-text" style="color:#94a3b8;font-size:11px;margin-top:6px;">提示：如果你的情节篇幅较长，建议在上一节点填写集数（≥ 2），让 AI 把剧本均匀分配到多集，避免一次性生成导致超限。</div>';
        return html;
      }
      html += '<div class="wf-detail-text" style="color:#64748b;margin-bottom:6px;">将把总情节拆分为 ' + epCount + ' 集的分集大纲。每集结果会写入对应剧集的"简要情节"，之后每集可独立生成剧本。</div>';
      if (v && v.episodes && v.episodes.length) {
        html += '<div class="wf-detail-section"><div class="wf-detail-label">分集大纲</div>';
        v.episodes.forEach(function (ep, i) {
          html += '<div class="wf-detail-text" style="margin-bottom:6px;"><strong>' + esc(ep.title || ("第" + (i + 1) + "集")) + '</strong><br>' + esc(ep.plot || "") + '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="wf-detail-text" style="color:#94a3b8;">尚未规划</div>';
      }
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="episodePlan"' + dis + '><i class="fa fa-magic"></i> ' + (v ? "重新规划" : "智能规划剧集") + '</button></div>';
      return html;
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
      var engine = window._wfEngine;
      var curEp = (engine && engine.currentEpisode && engine.currentEpisode(wf)) || null;

      // 规划过的集（episodePlan 已生成且包含本集）：plot 已自洽，不再传前集剧本。
      // 未规划过的续写集（用户手动"新增剧集"扩出来）：按原有逻辑传前集上下文保证衔接。
      var epPlanV = NR.getActiveVersion((wf.episodePlans || [])[0]);
      var curIdx = curEp ? curEp.index : 0;
      var plannedEpisodes = (epPlanV && epPlanV.episodes) || [];
      var isPlanned = plannedEpisodes.some(function (e) { return (e.index | 0) === curIdx; });
      var prevCtx = isPlanned ? null : getPrevEpisodesContext(wf);

      var data = await callApi("/api/workflow/generate/script", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "script"),
        plot: (curEp && curEp.plot) || wf.input.plot,
        style: wf.input.style, type: wf.input.type,
        segment_count: wf.input.segmentCount,
        episode_index: curIdx,
        prev_episodes: prevCtx ? prevCtx.episodes : [],
      });
      if (data.segments && data.segments.length) {
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
        // 对话修改历史
        var history = v.chatHistory || [];
        if (history.length) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">修改历史</div><div class="wf-chat-history" id="wf-script-chat-history">';
          history.forEach(function (msg) {
            if (msg.role === "user") {
              html += '<div class="wf-chat-msg wf-chat-user"><span class="wf-chat-role">你:</span> ' + esc(msg.content) + '</div>';
            } else if (msg.role === "assistant") {
              var aiText = msg.content && msg.content !== "done" ? msg.content : "已根据要求修改剧本";
              html += '<div class="wf-chat-msg wf-chat-ai"><span class="wf-chat-role">AI:</span> ' + esc(aiText) + '</div>';
            }
          });
          html += '</div></div>';
        }
        // 对话输入
        html += '<div class="wf-detail-section"><div class="wf-detail-label">对话修改剧本</div>'
          + '<div class="wf-chat-input-wrap">'
          + '<textarea class="wf-detail-textarea" id="wf-script-chat-input" rows="2" placeholder="描述你想修改的内容，如：把第2段改成下雨的场景，给主角加点犹豫..."></textarea>'
          + '<button class="wf-tb-btn primary" id="wf-script-chat-send" style="margin-top:6px;"' + dis + '><i class="fa fa-paper-plane"></i> 发送修改</button>'
          + '</div></div>';
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
      var prevCtx = getPrevEpisodesContext(wf);
      var allMain = prevCtx ? (prevCtx.all_main_characters || []) : [];
      var prevScenes = prevCtx ? (prevCtx.prev_scenes || []) : [];
      var data = await callApi("/api/workflow/generate/plan-characters-scenes", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "planCharactersScenes"),
        full_text: scriptV.fullText,
        segments: (scriptV.segments || []).map(function (s) { return { text: s.text }; }),
        style: wf.input.style, type: wf.input.type,
        user_hint: (planV && planV.userHint) || (planNd && planNd.userHint) || "",
        prev_main_characters: allMain,
        prev_episode_scenes: prevScenes,
      });
      var newMainChars = data.main_characters || [];
      var segPlans = data.segments || [];

      // 主要人物：跨集共享（合并到 wf 顶层 mainCharacterss）
      var mcArr = wf.mainCharacterss || [];
      if (!mcArr.length) { mcArr = [NR.createNodeData()]; wf.mainCharacterss = mcArr; }
      var mcNd = mcArr[0];
      var mergedMain = allMain.slice();
      var existingNames = {};
      mergedMain.forEach(function (c) { existingNames[(c.name || "").trim()] = c; });
      newMainChars.forEach(function (c) {
        var nm = (c.name || "").trim();
        if (!nm) return;
        var hit = existingNames[nm];
        if (hit) {
          // 沿用已有图片/描述，不覆盖
          if (!hit.description && c.description) hit.description = c.description;
          if (!hit.visual_prompt && c.visual_prompt) hit.visual_prompt = c.visual_prompt;
        } else {
          mergedMain.push(c);
          existingNames[nm] = c;
        }
      });
      NR.addVersion(mcNd, { characters: mergedMain });

      // 段级：场景复用——按名字匹配已有场景，直接引用
      var prevSceneByName = {};
      prevScenes.forEach(function (sc) { prevSceneByName[(sc.name || "").trim()] = sc; });

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
        if (sceneNd) {
          var rawScenes = sp.scenes || [];
          var resolvedScenes = rawScenes.map(function (sc) {
            var nm = (sc.name || "").trim();
            var hit = prevSceneByName[nm];
            if (hit) {
              return {
                name: hit.name,
                description: hit.description || sc.description || "",
                visual_prompt: hit.visual_prompt || sc.visual_prompt || "",
                imageUrl: hit.imageUrl || "",
                imageUrls: hit.imageUrls || [],
                _reused: true,
              };
            }
            return sc;
          });
          NR.addVersion(sceneNd, { scenes: resolvedScenes, sceneCount: resolvedScenes.length });
        }
      });
      return { mainCharacters: mergedMain, segments: segPlans };
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
      var gridMerge = nd._gridMerge; delete nd._gridMerge;
      if (gridMerge) {
        chars.forEach(function (c) {
          if (c.imageUrl) c.prevImageUrl = c.imageUrl;
          delete c.imageUrl; delete c.imageUrls; delete c.gridInfo;
        });
      }
      var preset = findPreset("character", nd.presetId || "default");
      var data = await callApi("/api/workflow/generate/main-characters", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "mainCharacters"),
        characters: chars, style: wf.input.style,
        ref_image_urls: nd.refImages || [],
        image_count: getImageCount("mainCharacters"),
        preset_id: nd.presetId || "default",
        prompt_template: nd.promptTemplate || "",
        width: preset && preset.width,
        height: preset && preset.height,
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
      var html = renderPresetSelector(nd, "character", "default", "mainCharacters", ctx, "mainCharacters");
      if (v && v.characters && v.characters.length) {
        v.characters.forEach(function (c, ci) {
          var charRunKey = "mainCharacters_0_char_" + ci;
          var charRunning = ctx.engine && ctx.engine.runningNodes[charRunKey];
          var charDis = charRunning ? " disabled" : dis;
          var gridTag = (c.gridInfo && c.gridInfo.isGrid) ? '<span style="font-size:10px;background:#e0e7ff;color:#4338ca;padding:1px 5px;border-radius:3px;margin-left:6px;">' + c.gridInfo.gridSize + '宫格·' + esc(c.gridInfo.positionLabel || '') + '</span>' : '';
          html += '<div class="wf-detail-section"><div class="wf-detail-label">' + esc(c.name) + gridTag
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
      var _hasImg = v && v.characters && v.characters.some(function(c){return c.imageUrl;});
      html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-global="mainCharacters"' + dis + '><i class="fa fa-refresh"></i> ' + (_hasImg ? "全部重新生成" : "全部生成图片") + '</button>';
      if (v && v.characters && v.characters.length > 4) {
        html += ' <button class="wf-tb-btn" data-grid-merge="mainCharacters"' + dis + ' style="margin-left:6px;"><i class="fa fa-th"></i> 合并为宫格</button>';
      }
      html += '</div>';
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
      var gridMerge = nd._gridMerge; delete nd._gridMerge;
      if (gridMerge) {
        chars.forEach(function (c) {
          if (c.imageUrl) c.prevImageUrl = c.imageUrl;
          delete c.imageUrl; delete c.imageUrls; delete c.gridInfo;
        });
      }
      var preset = findPreset("character", nd.presetId || "default");
      var data = await callApi("/api/workflow/generate/minor-characters", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "minorCharacters"),
        characters: chars, style: wf.input.style,
        ref_image_urls: nd.refImages || [],
        image_count: getImageCount("minorCharacters"),
        preset_id: nd.presetId || "default",
        prompt_template: nd.promptTemplate || "",
        width: preset && preset.width,
        height: preset && preset.height,
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
      var html = renderPresetSelector(nd, "character", "default", "minorCharacters", ctx, "minorCharacters");
      if (v && v.characters && v.characters.length) {
        v.characters.forEach(function (c, ci) {
          var charRunKey = "seg_" + ctx.segIndex + "_minorCharacters_0_char_" + ci;
          var charRunning = ctx.engine && ctx.engine.runningNodes[charRunKey];
          var charDis = charRunning ? " disabled" : _getDisabledAttr(ctx, "minorCharacters");
          var gridTag = (c.gridInfo && c.gridInfo.isGrid) ? '<span style="font-size:10px;background:#fff7ed;color:#c2410c;padding:1px 5px;border-radius:3px;margin-left:6px;">' + c.gridInfo.gridSize + '宫格·' + esc(c.gridInfo.positionLabel || '') + '</span>' : '';
          html += '<div class="wf-detail-section"><div class="wf-detail-label">' + esc(c.name) + gridTag
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
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "minorCharacters"); var _hasMinorImg = v && v.characters && v.characters.some(function(c){return c.imageUrl;}); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="minorCharacters"' + _dis + '><i class="fa fa-refresh"></i> ' + (_hasMinorImg ? "全部重新生成" : "全部生成图片") + '</button>'; if (v && v.characters && v.characters.length > 2) { html += ' <button class="wf-tb-btn" data-grid-merge="minorCharacters" data-grid-merge-seg="' + ctx.segIndex + '"' + _dis + ' style="margin-left:6px;"><i class="fa fa-th"></i> 合并为宫格</button>'; } html += '</div>'; }
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
      var gridMerge = nd._gridMerge; delete nd._gridMerge;
      if (gridMerge) {
        scenes.forEach(function (s) {
          if (s.imageUrl) s.prevImageUrl = s.imageUrl;
          delete s.imageUrl; delete s.imageUrls; delete s.gridInfo;
        });
      }
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
          var gridTag = (sc.gridInfo && sc.gridInfo.isGrid) ? '<span style="font-size:10px;background:#d1fae5;color:#065f46;padding:1px 5px;border-radius:3px;margin-left:6px;">' + sc.gridInfo.gridSize + '宫格·' + esc(sc.gridInfo.positionLabel || '') + '</span>' : '';
          html += '<div class="wf-detail-section"><div class="wf-detail-label">场景' + (i + 1) + ': ' + esc(sc.name || "") + gridTag
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
      if (!ctx.isPipelineNode) { var _dis = _getDisabledAttr(ctx, "scene"); var _hasSceneImg = v && v.scenes && v.scenes.some(function(s){return s.imageUrl;}); html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="scene"' + _dis + '><i class="fa fa-refresh"></i> ' + (_hasSceneImg ? "全部重新生成" : "全部生成图片") + '</button>'; if (v && v.scenes && v.scenes.length > 4) { html += ' <button class="wf-tb-btn" data-grid-merge="scene" data-grid-merge-seg="' + ctx.segIndex + '"' + _dis + ' style="margin-left:6px;"><i class="fa fa-th"></i> 合并为宫格</button>'; } html += '</div>'; }
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
      var prevSegmentText = "";
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
          // 同一集内不传 prev_segment_text，保持原行为
        }
      } else {
        // 当前段是本集第1段：跨集参考——从上一集最后一段拿尾帧、分镜图、剧情文本
        var _eng = window._wfEngine;
        if (_eng && _eng.currentEpisode) {
          var curEp = _eng.currentEpisode(wf);
          if (curEp && curEp.index > 0 && wf.episodes && wf.episodes[curEp.index - 1]) {
            var prevEp = wf.episodes[curEp.index - 1];
            var prevEpSegs = prevEp.segments || [];
            var prevEpLastSeg = prevEpSegs[prevEpSegs.length - 1];
            if (prevEpLastSeg) {
              var prevEpLfV = NR.getActiveVersion((prevEpLastSeg.lastFrames || [])[0]);
              if (prevEpLfV) prevLastDesc = prevEpLfV.description || "";
              var prevEpPlanNd = (prevEpLastSeg.planFramess || [])[0];
              if (prevEpPlanNd) prevPlanningHistory = prevEpPlanNd.planningHistory || [];
              var prevEpSbV = NR.getActiveVersion((prevEpLastSeg.storyboards || [])[0]);
              if (prevEpSbV && prevEpSbV.imageUrl) prevStoryboardUrl = prevEpSbV.imageUrl;
              prevSegmentText = prevEpLastSeg.scriptText || "";
            }
          }
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
        prev_segment_text: prevSegmentText,
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
      var appearing = Array.isArray(data.appearing_characters) ? data.appearing_characters : [];

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
      return { firstFrame: ff, storyboard: sb, lastFrame: lf, appearingCharacters: appearing };
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
        var appearing = Array.isArray(v.appearingCharacters) ? v.appearingCharacters : [];
        var parts = [];
        if (ff.description) parts.push('首帧');
        if (sb.grid_prompts && sb.grid_prompts.length) parts.push('分镜' + sb.grid_prompts.length + '格');
        if (lf.description) parts.push('尾帧');
        html += '<div class="wf-detail-text" style="font-size:11px;color:#94a3b8;">' + (parts.length ? parts.join(' + ') + ' 已规划' : '已规划') + '</div>';
        if (appearing.length) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">本段出场人物 (' + appearing.length + ')</div>'
            + '<div style="display:flex;flex-wrap:wrap;gap:4px;">'
            + appearing.map(function (n) { return '<span style="font-size:11px;background:#ede9fe;color:#6d28d9;padding:2px 6px;border-radius:4px;">' + esc(n) + '</span>'; }).join('')
            + '</div></div>';
        } else {
          html += '<div class="wf-detail-text" style="font-size:11px;color:#94a3b8;">本段无出场人物</div>';
        }
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
      var appearingNames = getAppearingCharNames(seg);
      var mcChars = filterCharsByAppearing(mcV ? mcV.characters : [], appearingNames);
      var minorChars = filterCharsByAppearing(minorV ? minorV.characters : [], appearingNames);
      var data = await callApi("/api/workflow/generate/first-frame", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "firstFrame"),
        visual_prompt: vp, description: desc,
        characters: mcChars,
        minor_characters: minorChars,
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
      var minorV = !wf.minorCharactersSkip ? NR.getActiveVersion((seg.minorCharacterss || [])[0]) : null;
      var sceneV = !wf.sceneSkip ? NR.getActiveVersion((seg.scenes || [])[0]) : null;
      var ffV = !wf.firstFrameSkip ? NR.getActiveVersion((seg.firstFrames || [])[0]) : null;
      var scenes = sceneV && sceneV.scenes ? sceneV.scenes : [];
      var appearingNames = getAppearingCharNames(seg);
      var mcChars = filterCharsByAppearing(mcV ? mcV.characters : [], appearingNames);
      var minorChars = filterCharsByAppearing(minorV ? minorV.characters : [], appearingNames);
      var sbCharacters = mcChars.concat(minorChars);

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
        characters: sbCharacters,
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
      var appearingNames = getAppearingCharNames(seg);
      var mcChars = filterCharsByAppearing(mcV ? mcV.characters : [], appearingNames);
      var minorChars = filterCharsByAppearing(minorV ? minorV.characters : [], appearingNames);
      var data = await callApi("/api/workflow/generate/last-frame", {
        workflow_id: wf.id, image_config_id: getConfigId("image", "lastFrame"),
        visual_prompt: vp, description: desc,
        characters: mcChars,
        minor_characters: minorChars,
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
      var appearingNames = getAppearingCharNames(seg);
      var mcChars = filterCharsByAppearing(mcV ? mcV.characters : [], appearingNames);
      var minorChars = filterCharsByAppearing(minorV ? minorV.characters : [], appearingNames);
      var data = await callApi("/api/workflow/generate/video-prompt", {
        workflow_id: wf.id, chat_config_id: getConfigId("chat", "videoPrompt"),
        segment_text: seg.scriptText, segment_index: ctx.segIndex,
        total_segments: wf.segments.length,
        duration: seg.duration || 15,
        scenes: scenes,
        characters: mcChars,
        minor_characters: minorChars,
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
      var preset = findPreset("storyTemplate", nd.presetId || "boardImage");
      var presetKind = preset ? preset.kind : "image";

      var mcV = NR.getActiveVersion((wf.mainCharacterss || [])[0]);
      var minorV = NR.getActiveVersion((seg.minorCharacterss || [])[0]);
      var sceneV = NR.getActiveVersion((seg.scenes || [])[0]);
      var sbV = NR.getActiveVersion((seg.storyboards || [])[0]);
      var grid = getStoryboardGrid();
      var sbGridPrompts = normalizeGridPrompts((sbV && sbV.gridPrompts) || []);
      var appearingNames = getAppearingCharNames(seg);
      var mcChars = filterCharsByAppearing(mcV ? mcV.characters : [], appearingNames);
      var minorChars = filterCharsByAppearing(minorV ? minorV.characters : [], appearingNames);

      var prevLastDesc = "";
      var nextFirstDesc = "";
      if (ctx.segIndex > 0) {
        var prevSeg = wf.segments[ctx.segIndex - 1];
        var prevLfV = prevSeg ? NR.getActiveVersion((prevSeg.lastFrames || [])[0]) : null;
        if (prevLfV) prevLastDesc = prevLfV.description || "";
      }
      if (ctx.segIndex < wf.segments.length - 1) {
        var nextSeg = wf.segments[ctx.segIndex + 1];
        var nextFfV = nextSeg ? NR.getActiveVersion((nextSeg.firstFrames || [])[0]) : null;
        if (nextFfV) nextFirstDesc = nextFfV.description || "";
      }

      var body = {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", "storyTemplate"),
        chat_config_id: getConfigId("chat", "storyTemplate"),
        segment_text: seg.scriptText,
        segment_index: ctx.segIndex,
        total_segments: wf.segments.length,
        duration: seg.duration || 15,
        characters: mcChars,
        minor_characters: minorChars,
        scenes: sceneV && sceneV.scenes ? sceneV.scenes : [],
        storyboard_images: sbV ? (sbV.images || []) : [],
        storyboard_grid: grid,
        grid_prompts: sbGridPrompts,
        orientation: getStoryTemplateOrientation(),
        style: wf.input.style,
        image_count: getImageCount("storyTemplate"),
        extra_hint: (nd && nd.reviewHint) || "",
        preset_id: nd.presetId || "boardImage",
        prompt_template: nd.promptTemplate || "",
        prev_last_frame_desc: prevLastDesc,
        next_first_frame_desc: nextFirstDesc,
      };
      // 图片类预设需要 characters 合并列表（兼容后端旧路径）
      if (presetKind !== "text") {
        body.characters = mcChars.concat(minorChars);
      }

      var data = await callApi("/api/workflow/generate/story-template", body);
      if ((data.kind || "image") === "text") {
        return { kind: "text", markdown: data.markdown || "", prompt: data.prompt || "", presetId: data.preset_id || body.preset_id };
      }
      return { kind: "image", imageUrl: data.imageUrl || "", imageUrls: data.imageUrls || [], prompt: data.prompt || "", presetId: body.preset_id };
    },
    renderDetail: function (nd, wf, ctx) {
      var v = NR.getActiveVersion(nd);
      var dis = _getDisabledAttr(ctx, "storyTemplate");
      var html = renderPresetSelector(nd, "storyTemplate", "boardImage", "storyTemplate", ctx, "storyTemplate");
      if (v) {
        if (v.prompt) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">生成提示词</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="prompt" rows="4" style="white-space:pre-wrap;">' + esc(v.prompt) + '</textarea></div>';
        }
        if (v.kind === "text" && v.markdown) {
          html += '<div class="wf-detail-section"><div class="wf-detail-label">分镜表（Markdown）</div>'
            + '<textarea class="wf-detail-textarea wf-editable" data-edit-field="markdown" rows="14" style="font-family:monospace;white-space:pre;">' + esc(v.markdown) + '</textarea>'
            + '<button class="wf-tb-btn" data-copy-markdown style="margin-top:6px;"><i class="fa fa-copy"></i> 复制</button>'
            + '</div>';
        } else if (v.imageUrl) {
          html += '<img class="wf-detail-img wf-preview-img" src="' + esc(v.imageUrl) + '">';
        }
      } else {
        html += '<div class="wf-detail-text" style="color:#64748b;">尚未生成</div>';
      }
      html += renderRefImagesSection(nd, "storyTemplate");
      if (!ctx.isPipelineNode) {
        var isText = v && v.kind === "text";
        var btnLabel = v ? (isText ? "重新生成分镜表" : (v.imageUrl ? "重新生成" : "生成故事模板")) : "生成故事模板";
        html += '<div class="wf-detail-actions"><button class="wf-tb-btn primary" data-gen-seg="' + ctx.segIndex + '" data-gen-type="storyTemplate"' + dis + '><i class="fa fa-refresh"></i> ' + btnLabel + '</button></div>';
      }
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
      { nodeType: "episodePlan", category: "global" },
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
      // 先渲染一次（summary 态），让列表立刻出现；当前工作流详情异步加载完再刷新一次
      _rerender();
      if (_engine.currentId) {
        _engine.ensureDetail(_engine.currentId).then(function () { _rerender(); }).catch(function () {});
      }
      return;
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
        var plotVal = (document.getElementById("wf-input-plot") || {}).value || "";
        var curEp = engine.currentEpisode ? engine.currentEpisode(wf) : null;
        if (curEp && curEp.index > 0) {
          curEp.plot = plotVal;
        } else {
          wf.input.plot = plotVal;
          if (curEp) curEp.plot = plotVal;
        }
        wf.input.style = (document.getElementById("wf-input-style") || {}).value || "";
        wf.input.type = (document.getElementById("wf-input-type") || {}).value || "";
        wf.input.segmentCount = parseInt((document.getElementById("wf-input-segments") || {}).value) || null;
        var epEl = document.getElementById("wf-input-episodes");
        if (epEl) {
          var newEpCount = parseInt(epEl.value) || null;
          // 仅在首次（仅有一集且尚未生成剧本）允许调整 episodeCount，避免覆盖已有续写
          var firstEp = wf.episodes && wf.episodes[0];
          var firstScriptV = firstEp && NR.getActiveVersion((firstEp.scripts || (wf.scripts || []))[0] || (wf.scripts || [])[0]);
          var canEditEpCount = (wf.episodes || []).length <= 1 && !firstScriptV;
          if (canEditEpCount) wf.input.episodeCount = newEpCount;
        }
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

      var gridMergeBtn = e.target.closest && e.target.closest("[data-grid-merge]");
      if (gridMergeBtn) {
        var mergeType = gridMergeBtn.getAttribute("data-grid-merge");
        var mergeSeg = gridMergeBtn.getAttribute("data-grid-merge-seg");
        var mergeSegIdx = (mergeSeg !== null && mergeSeg !== undefined && mergeSeg !== "") ? parseInt(mergeSeg) : null;
        if (engine.isNodeRunning(mergeType, mergeSegIdx)) return;
        if (mergeSegIdx !== null) {
          runSingleSegment(engine, mergeType, mergeSegIdx, rerender, { gridMerge: true });
        } else {
          runSingleGlobal(engine, mergeType, rerender, { gridMerge: true });
        }
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

      if (e.target.closest && e.target.closest("#wf-script-chat-send")) {
        iterateScript(engine, rerender);
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

  async function iterateScript(engine, rerender) {
    var input = document.getElementById("wf-script-chat-input");
    if (!input) return;
    var msg = input.value.trim();
    if (!msg) return;
    var key = engine.selectedNodeKey;
    if (!key) return;
    var nd = WF_Renderer.getNodeDataByKey(engine, key);
    var v = NR.getActiveVersion(nd);
    if (!v || (!v.fullText && !(v.segments && v.segments.length))) { alert("请先生成剧本"); return; }

    var btn = document.getElementById("wf-script-chat-send");
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> 修改中...'; }
    input.disabled = true;

    try {
      var wf = engine.current();
      var prevHistory = v.chatHistory || [];
      var oldSegments = (v.segments || []).map(function (s) {
        return { index: s.index, text: s.text || "", duration: s.duration || 15 };
      });
      var data = await callApi("/api/workflow/generate/script-iterate", {
        chat_config_id: getConfigId("chat", "script"),
        full_text: v.fullText || "",
        segments: oldSegments,
        chat_history: prevHistory,
        user_message: msg,
        style: wf.input.style,
        type: wf.input.type,
      });
      var newFullText = data.full_text || v.fullText || "";
      var newSegments = Array.isArray(data.segments) && data.segments.length
        ? data.segments.map(function (s, i) {
            return { index: i, text: s.text || "", duration: s.duration || (oldSegments[i] ? oldSegments[i].duration : 15) };
          })
        : oldSegments;
      var newHistory = prevHistory.slice();
      newHistory.push({ role: "user", content: msg });
      newHistory.push({ role: "assistant", content: data.analysis || "done" });
      NR.addVersion(nd, {
        fullText: newFullText,
        segments: newSegments,
        mainCharacters: v.mainCharacters || [],
        chatHistory: newHistory,
      });
      // 同步分段文本到 wf.segments，避免下游节点继续用旧文本
      if (wf && wf.segments && wf.segments.length === newSegments.length) {
        newSegments.forEach(function (s, i) {
          wf.segments[i].scriptText = s.text || "";
          if (s.duration) wf.segments[i].duration = s.duration;
        });
      }
      engine.save();
      rerender();
      requestAnimationFrame(function () { var h = document.getElementById("wf-script-chat-history"); if (h) h.scrollTop = h.scrollHeight; });
    } catch (err) {
      alert("修改失败：" + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-paper-plane"></i> 发送修改'; }
      if (input) input.disabled = false;
    }
  }

  async function runSingleGlobal(engine, nodeType, rerender, options) {
    var wf = engine.current();
    if (!wf) return;
    if (engine.isNodeRunning(nodeType, null)) return;
    if (!engine.canExecute(nodeType, null, wf)) {
      alert("依赖节点尚未完成");
      return;
    }
    _syncEditableFields(engine);
    // 标记宫格合并模式到 nodeData 上，generate 函数会读取并清除
    if (options && options.gridMerge) {
      var arr = wf[nodeType + "s"] || [];
      if (arr[0]) arr[0]._gridMerge = true;
    }
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

  async function runSingleSegment(engine, nodeType, segIdx, rerender, options) {
    var wf = engine.current();
    if (!wf) return;
    if (engine.isNodeRunning(nodeType, segIdx)) return;
    if (!engine.canExecute(nodeType, segIdx, wf)) {
      alert("依赖节点尚未完成");
      return;
    }
    _syncEditableFields(engine);
    if (options && options.gridMerge) {
      var seg = wf.segments && wf.segments[segIdx];
      if (seg) {
        var ndArr = seg[nodeType + "s"] || [];
        if (ndArr[0]) ndArr[0]._gridMerge = true;
      }
    }
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
      var preset = findPreset("character", nd.presetId || "default");
      var data = await callApi("/api/workflow/generate/" + (charType === "mainCharacters" ? "main-characters" : "minor-characters"), {
        workflow_id: wf.id,
        image_config_id: getConfigId("image", charType),
        characters: [singleChar],
        style: wf.input.style,
        ref_image_urls: refImageUrls,
        image_count: getImageCount(charType),
        preset_id: nd.presetId || "default",
        prompt_template: nd.promptTemplate || "",
        width: preset && preset.width,
        height: preset && preset.height,
      });
      var resultChars = data.characters || [];
      var errs = data.errors || [];
      if (errs.length) {
        engine._addHistory(wf, charType, 0, segIdx, "error", errs[0].message || "生成失败", charLabel);
      } else if (resultChars[0] && resultChars[0].imageUrl) {
        if (resultChars[0].imageUrl) v.characters[charIndex].imageUrl = resultChars[0].imageUrl;
        if (resultChars[0].imageUrls) v.characters[charIndex].imageUrls = resultChars[0].imageUrls;
        // 单独生成视为退出宫格：清除自身 gridInfo，并让原宫格内其他成员失去该 imageUrl 引用
        var oldGridInfo = v.characters[charIndex].gridInfo;
        delete v.characters[charIndex].gridInfo;
        if (oldGridInfo && oldGridInfo.isGrid) {
          var groupNames = oldGridInfo.groupItems || [];
          v.characters.forEach(function (other, oi) {
            if (oi === charIndex) return;
            var ogi = other.gridInfo;
            if (ogi && ogi.isGrid && groupNames.indexOf(other.name) >= 0) {
              ogi.groupItems = (ogi.groupItems || []).filter(function (n) { return n !== v.characters[charIndex].name; });
            }
          });
        }
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
        var oldGridInfo = v.scenes[sceneIndex].gridInfo;
        delete v.scenes[sceneIndex].gridInfo;
        if (oldGridInfo && oldGridInfo.isGrid) {
          var groupNames = oldGridInfo.groupItems || [];
          v.scenes.forEach(function (other, oi) {
            if (oi === sceneIndex) return;
            var ogi = other.gridInfo;
            if (ogi && ogi.isGrid && groupNames.indexOf(other.name) >= 0) {
              ogi.groupItems = (ogi.groupItems || []).filter(function (n) { return n !== v.scenes[sceneIndex].name; });
            }
          });
        }
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
    if (!v) { stNd.reviewStatus = "passed"; return; }
    // 文本预设（分镜表 Markdown）不走图片审核
    if (v.kind === "text") { stNd.reviewStatus = "passed"; return; }
    if (!v.imageUrl) { stNd.reviewStatus = "passed"; return; }
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
