(function () {
  const MODEL_PRESETS = window.MODEL_PRESETS || { chat: [], image: [] };
  const MODAL_MAP = {
    "edit-config-id": "edit-config-id-modal",
    "config-name": "config-name-modal",
    "config-type": "config-type-modal",
    "api-base": "api-base-modal",
    "api-key": "api-key-modal",
    "model-name": "model-name-modal",
    "config-desc": "config-desc-modal",
    "test-result": "test-result-modal",
    "config-list-body": "config-list-body-modal",
    "form-title": "form-title-modal",
    "new-config-btn": "new-config-btn-modal",
    "save-config-btn": "save-config-btn-modal",
    "reset-form-btn": "reset-form-btn-modal",
    "test-config-btn": "test-config-btn-modal"
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindConfigEvents();
    if ((window.GLOBAL?.configList || []).length) renderConfigList();
  });

  function getEl(id) {
    return document.getElementById(MODAL_MAP[id] || id);
  }

  function bindConfigEvents() {
    if (document._configEventsBound) return;
    document._configEventsBound = true;

    injectConfigStyles();
    bindModelPresetControls();

    getEl("new-config-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      resetForm();
    });
    getEl("save-config-btn")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await saveConfig();
    });
    getEl("reset-form-btn")?.addEventListener("click", (e) => {
      e.preventDefault();
      resetForm();
    });
    getEl("test-config-btn")?.addEventListener("click", async (e) => {
      e.preventDefault();
      await testConfig();
    });

    const tbody = getEl("config-list-body");
    if (tbody && !tbody._delegated) {
      tbody.addEventListener("click", async (e) => {
        const editBtn = e.target.closest(".cfg-edit");
        const delBtn = e.target.closest(".cfg-delete");
        if (editBtn) {
          const id = editBtn.getAttribute("data-id");
          const cfg = (window.GLOBAL?.configList || []).find((c) => String(c.id) === String(id));
          if (cfg) populateForm(cfg);
        } else if (delBtn) {
          await deleteConfig(delBtn.getAttribute("data-id"));
        }
      });
      tbody._delegated = true;
    }
  }

  function bindModelPresetControls() {
    const modelInput = getEl("model-name");
    const typeSelect = getEl("config-type");
    if (!modelInput || !typeSelect) return;
    if (window.ensureModelBrandStyles) window.ensureModelBrandStyles();
    if (document.getElementById("model-name-preset")) return;
    const wrap = document.createElement("div");
    wrap.className = "form-group config-model-preset-group";
    wrap.innerHTML = `<label class="form-label">主流模型快捷选择</label><select class="form-select" id="model-name-preset"><option value="">选择一个常用模型</option></select><div id="model-preset-preview" class="config-model-preview" style="margin-top:10px;"></div>`;
    modelInput.parentNode.insertAdjacentElement("beforebegin", wrap);
    const presetSelect = wrap.querySelector("select");
    const preview = wrap.querySelector("#model-preset-preview");
    const refreshPreview = () => {
      const current = presetSelect.value || modelInput.value || "";
      const usageText = typeSelect.value === "image" ? "绘图模型" : typeSelect.value === "both" ? "通用模型" : "聊天模型";
      if (preview) {
        preview.innerHTML = current
          ? (window.renderModelChip ? window.renderModelChip(current, { text: current, subtext: usageText, iconSize: 20 }) : escapeHtml(current))
          : `<span class="config-model-preview-empty">选择后会在这里显示当前模型标识</span>`;
      }
    };
    const refresh = () => {
      const kind = typeSelect.value === "image" ? "image" : "chat";
      presetSelect.innerHTML = `<option value="">选择一个常用模型</option>` + (MODEL_PRESETS[kind] || []).map((name) => `<option value="${name}">${name}</option>`).join("");
      refreshPreview();
    };
    typeSelect.addEventListener("change", refresh);
    modelInput.addEventListener("input", refreshPreview);
    presetSelect.addEventListener("change", () => { if (presetSelect.value) modelInput.value = presetSelect.value; refreshPreview(); });
    refresh();
  }

  function injectConfigStyles() {
    if (document.getElementById("oc-config-enhance-style")) return;
    const style = document.createElement("style");
    style.id = "oc-config-enhance-style";
    style.textContent = `
      .config-model-preset-group{padding:14px;border:1px solid rgba(226,232,240,.95);border-radius:16px;background:linear-gradient(180deg,#ffffff,#f8fafc)}
      .config-model-preview{min-height:44px;display:flex;align-items:center}
      .config-model-preview-empty{font-size:12px;color:#94a3b8;font-weight:600}
      #config-modal .table td .oc-model-chip,#config .table td .oc-model-chip{min-width:220px;max-width:100%;background:rgba(248,250,252,.92);border-color:rgba(226,232,240,.95)}
      #config-modal .table-container,#config .table-container{border:1px solid rgba(226,232,240,.95);border-radius:16px;background:#fff}
      #config-modal .table td,#config .table td{vertical-align:middle}
      #config-modal .card-body.modal-stack{gap:18px}
    `;
    document.head.appendChild(style);
  }

  function renderConfigList() {
    const tbody = getEl("config-list-body");
    if (!tbody) return;
    const list = window.GLOBAL?.configList || [];

    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-tip"><i class="fa fa-folder-open-o"></i><p>还没有配置，先为流绘添加一个模型入口</p></div></td></tr>`;
      return;
    }

    tbody.innerHTML = list.map((c) => {
      const typeMap = { chat: "仅聊天模型", image: "仅图片模型", both: "聊天+图片通用" };
      const modelChip = window.renderModelChip
        ? window.renderModelChip(c.model_name || c.name || "", { text: c.model_name || "-", subtext: c.name || typeMap[c.config_type] || "模型配置", iconSize: 18 })
        : escapeHtml(c.model_name || "-");
      return `
        <tr>
          <td>${escapeHtml(c.name || `配置 ${c.id}`)}</td>
          <td>${escapeHtml(typeMap[c.config_type] || c.config_type || "-")}</td>
          <td>${modelChip}</td>
          <td>
            <div class="table-action">
              <button class="table-btn edit cfg-edit" data-id="${c.id}"><i class="fa fa-pencil"></i> 编辑</button>
              <button class="table-btn delete cfg-delete" data-id="${c.id}"><i class="fa fa-trash"></i> 删除</button>
            </div>
          </td>
        </tr>`;
    }).join("");
  }

  function collectForm() {
    return {
      id: (getEl("edit-config-id")?.value || "").trim(),
      name: (getEl("config-name")?.value || "").trim(),
      config_type: getEl("config-type")?.value || "chat",
      api_base: (getEl("api-base")?.value || "").trim(),
      api_key: (getEl("api-key")?.value || "").trim(),
      model_name: (getEl("model-name")?.value || "").trim(),
      description: (getEl("config-desc")?.value || "").trim(),
    };
  }

  function validateForm(data) {
    if (!data.name) return "请填写配置名称";
    if (!data.config_type) return "请选择配置类型";
    if (!data.api_base) return "请填写 API Base 地址";
    if (!/^https?:\/\//i.test(data.api_base)) return "API Base 必须以 http(s):// 开头";
    if (!data.api_key) return "请填写 API Key";
    if (!data.model_name) return "请填写模型名称";
    return "";
  }

  function resetForm() {
    setFormTitle("新增配置");
    setFormValues({ id: "", name: "", config_type: "chat", api_base: "", api_key: "", model_name: "", description: "" });
    const testResult = getEl("test-result");
    if (testResult) testResult.textContent = "";
  }

  function populateForm(cfg) {
    setFormTitle("编辑配置");
    setFormValues({
      id: cfg.id || "",
      name: cfg.name || "",
      config_type: cfg.config_type || "chat",
      api_base: cfg.api_base || "",
      api_key: cfg.api_key || "",
      model_name: cfg.model_name || "",
      description: cfg.description || cfg.desc || "",
    });
    window.openConfigModal && window.openConfigModal();
  }

  function setFormTitle(title) {
    const titleEl = getEl("form-title");
    if (titleEl) titleEl.innerHTML = `<i class="fa fa-edit"></i> ${escapeHtml(title)}`;
  }

  function setFormValues(values) {
    const map = {
      "edit-config-id": values.id,
      "config-name": values.name,
      "config-type": values.config_type,
      "api-base": values.api_base,
      "api-key": values.api_key,
      "model-name": values.model_name,
      "config-desc": values.description,
    };
    Object.entries(map).forEach(([id, val]) => {
      const el = getEl(id);
      if (el) el.value = val || "";
    });
  }

  async function saveConfig() {
    const data = collectForm();
    const err = validateForm(data);
    if (err) return alert(err);

    try {
      const payload = {
        id: data.id || (window.GLOBAL?.uuid?.v4 ? window.GLOBAL.uuid.v4() : String(Date.now())),
        name: data.name,
        config_type: data.config_type,
        api_base: data.api_base,
        api_key: data.api_key,
        model_name: data.model_name,
        description: data.description,
      };

      const res = await fetch("/api/configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await res.json();
      if (result.code !== 0) throw new Error(result.message || "未知错误");

      await (window.loadAllConfigs?.() || Promise.resolve());
      renderConfigList();
      alert(data.id ? "配置已更新" : "配置已创建");
      resetForm();
      window.closeConfigModal && window.closeConfigModal();
    } catch (e) {
      console.error("[保存配置] 错误：", e);
      alert(`保存失败：${e.message}`);
    }
  }

  async function deleteConfig(id) {
    if (!id || !confirm("确定删除该配置吗？")) return;
    try {
      const res = await fetch(`/api/configs/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await res.json();
      if (result.code !== 0) throw new Error(result.message || "未知错误");
      await (window.loadAllConfigs?.() || Promise.resolve());
      renderConfigList();
      alert("配置已删除");
    } catch (e) {
      console.error("[删除配置] 错误：", e);
      alert(`删除失败：${e.message}`);
    }
  }

  async function testConfig() {
    const data = collectForm();
    const err = validateForm(data);
    if (err) return alert(err);

    const resultEl = getEl("test-result");
    if (resultEl) {
      resultEl.style.color = "#94A3B8";
      resultEl.textContent = "测试中...";
    }

    try {
      const res = await fetch("/api/configs/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: data.id || undefined,
          api_base: data.api_base,
          api_key: data.api_key,
          model_name: data.model_name,
          config_type: data.config_type,
        }),
      });
      const result = await res.json();
      const ok = result.code === 0;
      if (resultEl) {
        resultEl.style.color = ok ? "#00B42A" : "#F53F3F";
        resultEl.textContent = ok ? "连接成功" : `连接失败：${result.message || "未知错误"}`;
      }
    } catch (e) {
      console.error("[测试配置] 错误：", e);
      if (resultEl) {
        resultEl.style.color = "#F53F3F";
        resultEl.textContent = `连接失败：${e.message}`;
      }
    }
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  window.renderConfigList = renderConfigList;
})();
