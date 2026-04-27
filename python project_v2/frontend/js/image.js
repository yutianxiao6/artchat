(function () {
  document.addEventListener("DOMContentLoaded", () => {
    initImageModule();
  });

  window.initImageModule = function initImageModule() {
    const modeSelect = document.getElementById("image-mode");
    const sizeSelect = document.getElementById("image-size");
    const uploadBtn = document.getElementById("upload-btn");
    const uploadInput = document.getElementById("image-upload");
    const uploadArea = document.getElementById("image-upload-area");
    const customSizeArea = document.getElementById("custom-size-area");
    const generateBtn = document.getElementById("generate-image-btn");
    if (!modeSelect || !sizeSelect || !uploadInput || !uploadArea) return;

    toggleUploadArea(modeSelect.value);

    if (!modeSelect._bound) {
      modeSelect.addEventListener("change", () => {
        if (modeSelect.value === "image2image") toastImage("已切换到图生图，请上传参考图");
        toggleUploadArea(modeSelect.value);
      });
      modeSelect._bound = true;
    }

    if (!sizeSelect._bound) {
      sizeSelect.addEventListener("change", () => {
        if (!customSizeArea) return;
        const isCustom = sizeSelect.value === "custom";
        customSizeArea.classList.toggle("show", isCustom);
        customSizeArea.style.display = isCustom ? "block" : "none";
      });
      sizeSelect._bound = true;
    }

    if (!uploadInput._bound) {
      uploadInput.addEventListener("change", handleImageUpload);
      uploadInput._bound = true;
    }

    if (uploadBtn && !uploadBtn._bound) {
      uploadBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        uploadInput.click();
      });
      uploadBtn._bound = true;
    }

    if (!uploadArea._boundClick) {
      uploadArea.addEventListener("click", (e) => {
        if (e.target && !e.target.closest("button") && e.target.id !== "image-upload") uploadInput.click();
      });
      uploadArea._boundClick = true;
    }

    if (!uploadArea._boundDrag) {
      uploadArea.addEventListener("dragover", (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = "var(--primary-color)";
      });
      uploadArea.addEventListener("dragleave", () => {
        uploadArea.style.borderColor = "var(--border-color)";
      });
      uploadArea.addEventListener("drop", (e) => {
        e.preventDefault();
        uploadArea.style.borderColor = "var(--border-color)";
        const files = e.dataTransfer.files;
        if (files && files.length > 0 && files[0].type.startsWith("image/")) {
          try {
            const dt = new DataTransfer();
            dt.items.add(files[0]);
            uploadInput.files = dt.files;
          } catch {
            uploadInput._droppedFile = files[0];
          }
          handleImageUpload();
        }
      });
      uploadArea._boundDrag = true;
    }

    if (generateBtn && !generateBtn._bound) {
      generateBtn.addEventListener("click", (e) => {
        e.preventDefault();
        generateImage();
      });
      generateBtn._bound = true;
    }

    if (customSizeArea) {
      const isCustom = sizeSelect.value === "custom";
      customSizeArea.classList.toggle("show", isCustom);
      customSizeArea.style.display = isCustom ? "block" : "none";
    }
  };

  function toastImage(text) {
    let el = document.getElementById("image-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "image-toast";
      el.style.cssText = "position:fixed;left:50%;top:24px;transform:translateX(-50%);padding:10px 16px;border-radius:12px;background:rgba(15,23,42,.92);color:#fff;box-shadow:0 18px 40px rgba(2,6,23,.28);opacity:0;pointer-events:none;transition:all .2s ease;z-index:9999;";
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(el._timer);
    el._timer = setTimeout(() => (el.style.opacity = "0"), 1600);
  }

  function toggleUploadArea(modeValue) {
    const uploadArea = document.getElementById("image-upload-area");
    if (!uploadArea) return;
    const show = modeValue === "image2image";
    uploadArea.classList.toggle("hidden", !show);
    uploadArea.style.display = show ? "block" : "none";
    uploadArea.style.pointerEvents = show ? "auto" : "none";
  }

  async function handleImageUpload() {
    const uploadInput = document.getElementById("image-upload");
    const preview = document.getElementById("upload-preview");
    if (!uploadInput || !preview) return;

    let file = uploadInput.files && uploadInput.files[0];
    if (!file && uploadInput._droppedFile) {
      file = uploadInput._droppedFile;
      uploadInput._droppedFile = null;
    }
    if (!file) return;
    if (!file.type.startsWith("image/")) return alert("请选择图片文件（jpg/png/gif等）");
    if (file.size > 10 * 1024 * 1024) return alert("图片大小不能超过10MB");

    const formData = new FormData();
    formData.append("file", file);

    try {
      preview.innerHTML = `<div style="color:var(--text-secondary)"><i class="fa fa-spinner fa-spin"></i> 正在上传图片...</div>`;
      const res = await fetch("/api/image/upload", { method: "POST", body: formData });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (result.code === 0) {
        window.GLOBAL.currentImageBase64 = result.data.base64_data || "";
        const url = result.data.base64_url || (result.data.base64_data ? `data:image/png;base64,${result.data.base64_data}` : "");
        preview.innerHTML = url
          ? `<div style="display:flex;flex-direction:column;gap:10px;align-items:center;"><img src="${url}" style="max-height:220px;max-width:100%;border-radius:12px;" alt="预览图"><div style="color:var(--success-color)"><i class="fa fa-check-circle"></i> 上传成功，已作为参考图</div></div>`
          : `<div style="color:var(--text-secondary)">上传成功，但未返回可预览URL</div>`;
        toastImage("参考图上传成功");
      } else {
        preview.innerHTML = `<div style="color:var(--danger-color)">上传失败，请重试</div>`;
        alert("图片上传失败: " + (result.message || "未知错误"));
      }
    } catch (e) {
      console.error("[图片上传] 错误:", e);
      preview.innerHTML = `<div style="color:var(--danger-color)"><i class="fa fa-warning"></i> 图片上传失败：${e.message}</div>`;
      alert("图片上传失败: " + e.message);
    }
  }

  window.generateImage = async function generateImage() {
    if (GLOBAL.isGenerating) return;
    const configId = document.getElementById("image-config-select")?.value;
    const mode = document.getElementById("image-mode")?.value;
    const sizeValue = document.getElementById("image-size")?.value;
    const prompt = document.getElementById("prompt")?.value.trim();
    const negativePrompt = document.getElementById("negative-prompt")?.value.trim();
    const imageCount = parseInt(document.getElementById("image-count")?.value || "1");
    const resultDom = document.getElementById("image-result");
    const emptyTip = document.getElementById("image-empty-tip");
    const generateLoading = document.getElementById("generate-loading");
    const genBtn = document.getElementById("generate-image-btn");
    if (!configId) return alert("请先选择图片生成配置");
    if (!prompt) return alert("请输入正向提示词");
    if (mode === "image2image" && !GLOBAL.currentImageBase64) return alert("请先上传参考图片");
    if (!resultDom) return;

    let width = 1024, height = 1024;
    if (sizeValue === "custom") {
      width = parseInt(document.getElementById("image-width")?.value || "1024");
      height = parseInt(document.getElementById("image-height")?.value || "1024");
    } else {
      const parts = (sizeValue || "1024x1024").split("x").map(Number);
      width = parts[0] || 1024;
      height = parts[1] || 1024;
    }

    GLOBAL.isGenerating = true;
    if (genBtn) genBtn.disabled = true;
    if (generateLoading) generateLoading.classList.add("show");
    if (emptyTip) emptyTip.style.display = "none";
    resultDom.innerHTML = "";

    try {
      const res = await fetch("/api/image/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config_id: configId,
          prompt,
          negative_prompt: negativePrompt || "",
          width,
          height,
          image_base64: mode === "image2image" ? GLOBAL.currentImageBase64 : null,
          n: Math.max(1, Math.min(4, imageCount || 1)),
        }),
      });
      const result = await res.json();
      if (result.code === 0) {
        let html = "";
        (result.data || []).forEach((item, index) => {
          let imgSrc = "";
          if (item.b64_json) imgSrc = item.b64_json.startsWith("data:image") ? item.b64_json : "data:image/png;base64," + item.b64_json;
          else if (item.url) imgSrc = item.url;
          if (imgSrc) {
            html += `<div class="image-card"><img src="${imgSrc}" alt="生成的图片 ${index + 1}"><div class="image-card-footer"><span class="image-size">${width}×${height}</span><a href="${imgSrc}" download="ai-generated-${Date.now()}-${index}.png" class="btn btn-primary btn-sm"><i class="fa fa-download"></i> 下载</a></div></div>`;
          }
        });
        resultDom.innerHTML = html || `<div class="empty-tip" style="grid-column:1/-1;">未返回图片</div>`;
      } else {
        alert("图片生成失败: " + (result.message || "未知错误"));
      }
    } catch (e) {
      console.error("[图片生成] 错误:", e);
      alert("图片生成失败: " + e.message);
    } finally {
      GLOBAL.isGenerating = false;
      if (genBtn) genBtn.disabled = false;
      if (generateLoading) generateLoading.classList.remove("show");
      try { window.updateButtonStatus && window.updateButtonStatus(); } catch {}
    }
  };
})();
