(function () {
  window.MODEL_PRESETS = {
    chat: [
      "gpt-3.5-turbo","gpt-4","gpt-4-turbo","gpt-4o","o1","o3",
      "claude-2","claude-2.1","claude-3-haiku","claude-3-sonnet","claude-3-opus",
      "gemini-pro","gemini-ultra","gemini-2.5-pro","gemini-3.1",
      "grok-2","grok-3","grok-4",
      "command-r","command-r-plus",
      "llama-2-7b","llama-2-13b","llama-2-70b","llama-3-8b","llama-3-70b","llama-4-moe",
      "mistral-7b","mixtral-8x7b","mistral-large-latest","dbrx","gpt-neo","gpt-neox","pythia",
      "ernie-4.0","ernie-5.0","ernie-6.0","qwen-3.5","qwen-4","qwen-plus","doubao-pro","hunyuan-3.0",
      "glm-4","glm-4.5","glm-5.1","kimi-k2","spark-x2","pangu","360gpt-pro","sensechat","abab6.5",
      "deepseek-6.7b","deepseek-67b","deepseek-v3","baichuan-7b","baichuan-13b","baichuan-4",
      "internlm2","internlm2.5","minicpm","yi-6b","yi-34b","zi-dong-tai-chu"
    ],
    image: [
      "gpt-image-1","dall-e-3","flux.1-dev","flux.1-schnell","sdxl","recraft-v3","imagen-3"
    ]
  };

  window.GLOBAL = window.GLOBAL || {
    configList: [],
    chatMessages: [],
    currentImageBase64: "",
    isGenerating: false,
    isChatting: false,
    selectedChatConfigId: localStorage.getItem("flowdraw:selectedChatConfigId") || "",
    selectedImageConfigId: localStorage.getItem("flowdraw:selectedImageConfigId") || "",
    linkedUniversalConfigId: localStorage.getItem("flowdraw:linkedUniversalConfigId") || "",
    defaultNegativePrompt:
      "低分辨率, 模糊, 画质差, 噪点, 水印, 文字, 签名, 变形, 畸形, 肢体残缺, 多余手指, 多余肢体, 五官错位, 面部扭曲, 过曝, 欠曝, 色差, 构图混乱, 丑陋, 低俗, 卡通, 手绘, 二次元, 非写实, 低细节, 虚化背景, 模糊边缘",
    uuid: {
      v4: () =>
        "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
          const r = (Math.random() * 16) | 0;
          const v = c === "x" ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        }),
    },
  };

  document.addEventListener("DOMContentLoaded", async () => {
    bindTabClicksOnce();
    bindConfigModal();

    const negativePromptInput = document.getElementById("negative-prompt");
    if (negativePromptInput && !negativePromptInput.value) {
      negativePromptInput.value = GLOBAL.defaultNegativePrompt;
    }

    bindSelects();
    await loadAllConfigs();

    activateTab("chat", { force: true });
    updateButtonStatus();
    const hasConfigs = Array.isArray(GLOBAL.configList) && GLOBAL.configList.length > 0;
    if (!hasConfigs) openConfigModal();
  });

  function bindConfigModal() {
    const openBtn = document.getElementById("open-config-modal-btn");
    const closeBtn = document.getElementById("close-config-modal-btn");
    const modal = document.getElementById("config-modal");
    if (openBtn && !openBtn._bound) {
      openBtn.addEventListener("click", () => openConfigModal());
      openBtn._bound = true;
    }
    if (closeBtn && !closeBtn._bound) {
      closeBtn.addEventListener("click", () => closeConfigModal());
      closeBtn._bound = true;
    }
    if (modal && !modal._bound) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeConfigModal();
      });
      modal._bound = true;
    }
  }

  function openConfigModal() {
    document.getElementById("config-modal")?.classList.add("active");
    window.renderConfigList && window.renderConfigList();
  }

  function closeConfigModal() {
    document.getElementById("config-modal")?.classList.remove("active");
  }

  function bindSelects() {
    const chatSelect = document.getElementById("chat-config-select");
    const imageSelect = document.getElementById("image-config-select");

    if (chatSelect && !chatSelect._bound) {
      chatSelect.addEventListener("change", () => {
        GLOBAL.selectedChatConfigId = chatSelect.value || "";
        localStorage.setItem("flowdraw:selectedChatConfigId", GLOBAL.selectedChatConfigId);
        const cfg = (GLOBAL.configList || []).find((c) => String(c.id) === String(chatSelect.value || ""));
        if (cfg && ["both", "chat"].includes(cfg.config_type)) {
          GLOBAL.linkedUniversalConfigId = cfg.id || "";
          localStorage.setItem("flowdraw:linkedUniversalConfigId", String(GLOBAL.linkedUniversalConfigId || ""));
          const bothImage = (GLOBAL.configList || []).find((c) => String(c.id) === String(cfg.id) && ["both", "image"].includes(c.config_type));
          if (bothImage && imageSelect) {
            imageSelect.value = String(bothImage.id);
            GLOBAL.selectedImageConfigId = String(bothImage.id);
            localStorage.setItem("flowdraw:selectedImageConfigId", GLOBAL.selectedImageConfigId);
          }
        }
        updateButtonStatus();
        window.refreshModelPills && window.refreshModelPills();
      }, { passive: true });
      chatSelect._bound = true;
    }
    if (imageSelect && !imageSelect._bound) {
      imageSelect.addEventListener("change", () => {
        GLOBAL.selectedImageConfigId = imageSelect.value || "";
        localStorage.setItem("flowdraw:selectedImageConfigId", GLOBAL.selectedImageConfigId);
        const cfg = (GLOBAL.configList || []).find((c) => String(c.id) === String(imageSelect.value || ""));
        if (cfg && ["both", "image"].includes(cfg.config_type)) {
          GLOBAL.linkedUniversalConfigId = cfg.id || "";
          localStorage.setItem("flowdraw:linkedUniversalConfigId", String(GLOBAL.linkedUniversalConfigId || ""));
          const bothChat = (GLOBAL.configList || []).find((c) => String(c.id) === String(cfg.id) && ["both", "chat"].includes(c.config_type));
          if (bothChat && chatSelect) {
            chatSelect.value = String(bothChat.id);
            GLOBAL.selectedChatConfigId = String(bothChat.id);
            localStorage.setItem("flowdraw:selectedChatConfigId", GLOBAL.selectedChatConfigId);
          }
        }
        updateButtonStatus();
        window.refreshModelPills && window.refreshModelPills();
        if (window.initImageModule) requestAnimationFrame(() => window.initImageModule());
      }, { passive: true });
      imageSelect._bound = true;
    }
  }

  function bindTabClicksOnce() {
    if (document._tabStrictBound) return;
    document._tabStrictBound = true;

    const nav = document.querySelector(".tab-nav");
    if (!nav) return;

    nav.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab-btn");
      if (!btn || !nav.contains(btn)) return;
      e.preventDefault();
      const tabId = btn.getAttribute("data-tab");
      if (tabId) activateTab(tabId);
    });
  }

  window.activateTab = function activateTab(tabId, opts = {}) {
    document.querySelectorAll(".tab-nav .tab-btn").forEach((b) => {
      const isActive = b.getAttribute("data-tab") === tabId;
      b.classList.toggle("active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
    });

    let targetPanel = null;
    document.querySelectorAll(".tab-content").forEach((panel) => {
      const match = panel.id === tabId;
      if (match) targetPanel = panel;
      panel.classList.toggle("active", match);
      panel.style.display = match ? "block" : "none";
    });
    if (!targetPanel) return;

    if (tabId === "config") {
      window.renderConfigList && window.renderConfigList();
    } else if (tabId === "chat") {
      window.renderChatMessages && window.renderChatMessages();
    } else if (tabId === "image") {
      requestAnimationFrame(() => {
        window.initImageModule && window.initImageModule();
        updateButtonStatus();
      });
    } else if (tabId === "assets") {
      requestAnimationFrame(() => {
        window.initImageModule && window.initImageModule();
      });
    }

    if (!opts.noReApply) {
      requestAnimationFrame(() => {
        if (getActivePanelId() !== tabId) activateTab(tabId, { noReApply: true });
      });
    }
  };

  function getActivePanelId() {
    const byClass = document.querySelector(".tab-content.active");
    if (byClass) return byClass.id;
    for (const p of document.querySelectorAll(".tab-content")) {
      if (window.getComputedStyle(p).display !== "none") return p.id;
    }
    return null;
  }

  async function loadAllConfigs() {
    try {
      const res = await fetch("/api/configs");
      const result = await res.json();
      if (result.code === 0) {
        GLOBAL.configList = Array.isArray(result.data) ? result.data : [];
        updateConfigSelectOptions();
        window.renderConfigList && window.renderConfigList();
        updateButtonStatus();
      }
    } catch (e) {
      console.error("配置加载失败:", e);
    }
  }

  function getPreferredChatConfigId(chatConfigs = []) {
    const exactModel = chatConfigs.find((c) => (c.model_name || "").trim() === "deepseek-v4-pro");
    if (exactModel) return exactModel.id;
    const deepseekNamed = chatConfigs.find((c) => /deepseek/i.test(`${c.name || ""} ${c.model_name || ""}`));
    if (deepseekNamed) return deepseekNamed.id;
    return chatConfigs[0]?.id || "";
  }

  function updateConfigSelectOptions() {
    if (window.ensureModelBrandStyles) window.ensureModelBrandStyles();
    const chatSelect = document.getElementById("chat-config-select");
    if (chatSelect) {
      const chatConfigs = GLOBAL.configList.filter((c) => ["chat", "both"].includes(c.config_type));
      const preferredChatId = getPreferredChatConfigId(chatConfigs);
      const previousValue = GLOBAL.selectedChatConfigId || chatSelect.value;
      chatSelect.innerHTML = chatConfigs.length
        ? chatConfigs.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.model_name)})</option>`).join("")
        : `<option value="">请先在配置管理中创建聊天模型配置</option>`;
      chatSelect.value = chatConfigs.some((c) => String(c.id) === String(previousValue)) ? String(previousValue) : String(preferredChatId || "");
      GLOBAL.selectedChatConfigId = chatSelect.value || "";
      localStorage.setItem("flowdraw:selectedChatConfigId", GLOBAL.selectedChatConfigId);
    }

    const imageSelect = document.getElementById("image-config-select");
    if (imageSelect) {
      const imageConfigs = GLOBAL.configList.filter((c) => ["image", "both"].includes(c.config_type));
      const previousValue = GLOBAL.selectedImageConfigId || imageSelect.value;
      imageSelect.innerHTML = imageConfigs.length
        ? imageConfigs.map((c) => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.model_name)})</option>`).join("")
        : `<option value="">请先在配置管理中创建图片模型配置</option>`;
      imageSelect.value = imageConfigs.some((c) => String(c.id) === String(previousValue)) ? String(previousValue) : String(imageConfigs[0]?.id || "");
      GLOBAL.selectedImageConfigId = imageSelect.value || "";
      localStorage.setItem("flowdraw:selectedImageConfigId", GLOBAL.selectedImageConfigId);
    }

    if (window.refreshModelPills) window.refreshModelPills();
    if (window.initImageModule) requestAnimationFrame(() => window.initImageModule());
  }

  function updateButtonStatus() {
    const chatSelect = document.getElementById("chat-config-select");
    const sendBtn = document.getElementById("send-chat-btn");
    if (chatSelect && sendBtn) sendBtn.disabled = !chatSelect.value || GLOBAL.isChatting;

    const imageSelect = document.getElementById("image-config-select");
    const generateBtn = document.getElementById("generate-image-btn");
    if (imageSelect && generateBtn) generateBtn.disabled = !imageSelect.value || GLOBAL.isGenerating;
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  window.loadAllConfigs = loadAllConfigs;
  window.updateConfigSelectOptions = updateConfigSelectOptions;
  window.updateButtonStatus = updateButtonStatus;
  window.openConfigModal = openConfigModal;
  window.closeConfigModal = closeConfigModal;
})();
