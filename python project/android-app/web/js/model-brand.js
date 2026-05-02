(function () {
  const BRAND_MAP = [
    { key: "gpt", label: "GPT", aliases: ["gpt", "o1", "o3", "o4", "dall", "gpt-image", "openai", "chatgpt"], logo: "assets/model-icons/runtime/gpt.png", shortLabel: "GPT", colors: ["#10b981", "#065f46"] },
    { key: "gemini", label: "Gemini", aliases: ["gemini", "google", "imagen"], logo: "assets/model-icons/runtime/gemini.png", shortLabel: "Gemini", colors: ["#60a5fa", "#4f46e5"] },
    { key: "deepseek", label: "DeepSeek", aliases: ["deepseek"], logo: "assets/model-icons/runtime/deepseek.png", shortLabel: "DeepSeek", colors: ["#38bdf8", "#0f766e"] },
    { key: "grok", label: "Grok", aliases: ["grok", "xai"], logo: "assets/model-icons/runtime/grok.png", shortLabel: "Grok", colors: ["#111827", "#334155"] },
    { key: "llama", label: "Llama", aliases: ["llama"], logo: "assets/model-icons/runtime/Llama.png", shortLabel: "Llama", colors: ["#14b8a6", "#0f766e"] }
  ];

  function normalize(text = "") {
    return String(text || "").trim().toLowerCase();
  }

  function escapeHtml(str = "") {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function detectModelBrand(modelName = "", fallbackName = "") {
    const haystack = `${normalize(modelName)} ${normalize(fallbackName)}`.trim();
    const brand = BRAND_MAP.find((item) => item.aliases.some((alias) => haystack.includes(alias)));
    if (brand) return brand;
    return {
      key: "default",
      label: modelName || fallbackName || "AI",
      aliases: [],
      logo: "",
      shortLabel: "AI",
      colors: ["#334155", "#0f172a"]
    };
  }

  function renderModelIcon(modelName = "", options = {}) {
    const brand = detectModelBrand(modelName, options.fallbackName || "");
    const size = Number(options.size || 28);
    const title = escapeHtml(options.title || brand.label || modelName || "AI");
    const style = `--oc-icon-size:${size}px;--oc-icon-c1:${brand.colors[0]};--oc-icon-c2:${brand.colors[1]};`;
    const fallbackGlyph = escapeHtml(brand.shortLabel || "AI");
    const imageHtml = brand.logo
      ? `<img class="oc-model-icon-img" src="${escapeHtml(brand.logo)}" alt="${title}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">`
      : "";
    return `<span class="oc-model-icon brand-${escapeHtml(brand.key)}" style="${style}" title="${title}" aria-label="${title}">${imageHtml}<span class="oc-model-icon-fallback" style="${brand.logo ? 'display:none;' : ''}">${fallbackGlyph}</span></span>`;
  }

  function renderModelChip(modelName = "", options = {}) {
    const brand = detectModelBrand(modelName, options.fallbackName || "");
    const icon = renderModelIcon(modelName, { size: options.iconSize || 22, title: brand.label, fallbackName: options.fallbackName || "" });
    const text = escapeHtml(options.text || modelName || options.fallbackName || brand.label || "未选择模型");
    const subtext = options.subtext ? `<span class="oc-model-chip-subtext">${escapeHtml(options.subtext)}</span>` : "";
    return `<span class="oc-model-chip brand-${escapeHtml(brand.key)}">${icon}<span class="oc-model-chip-text"><span class="oc-model-chip-label">${text}</span>${subtext}</span></span>`;
  }

  function ensureModelBrandStyles() {
    if (document.getElementById("oc-model-brand-style")) return;
    const style = document.createElement("style");
    style.id = "oc-model-brand-style";
    style.textContent = `
      .oc-model-icon{width:var(--oc-icon-size,28px);height:var(--oc-icon-size,28px);border-radius:999px;display:inline-flex;align-items:center;justify-content:center;position:relative;overflow:hidden;background:linear-gradient(135deg,var(--oc-icon-c1,#334155),var(--oc-icon-c2,#0f172a));box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 8px 22px rgba(15,23,42,.16);color:#fff;flex:0 0 auto}
      .oc-model-icon::after{content:"";position:absolute;inset:1px;border-radius:inherit;border:1px solid rgba(255,255,255,.12)}
      .oc-model-icon-img{position:relative;z-index:1;width:100%;height:100%;object-fit:cover;border-radius:inherit;background:#fff}
      .oc-model-icon-fallback{position:relative;z-index:1;width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:calc(var(--oc-icon-size,28px) * .32);font-weight:800;letter-spacing:.01em;line-height:1;padding:0 4px;text-transform:uppercase}
      .oc-model-chip{display:inline-flex;align-items:center;gap:10px;min-width:0;padding:8px 10px;border-radius:14px;border:1px solid rgba(148,163,184,.16);background:rgba(255,255,255,.82)}
      .oc-model-chip-text{display:flex;flex-direction:column;min-width:0}
      .oc-model-chip-label,.oc-model-chip-subtext{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .oc-model-chip-label{font-size:13px;font-weight:700;color:#0f172a}
      .oc-model-chip-subtext{font-size:11px;color:#64748b;margin-top:2px}
    `;
    document.head.appendChild(style);
  }

  window.detectModelBrand = detectModelBrand;
  window.renderModelIcon = renderModelIcon;
  window.renderModelChip = renderModelChip;
  window.ensureModelBrandStyles = ensureModelBrandStyles;
})();
