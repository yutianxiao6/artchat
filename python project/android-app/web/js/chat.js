const CHAT_STORAGE_KEY = "my_ai_chat_sessions_v2";
let currentSessionId = null;
const activeGenerations = new Map();
let smartFiles = [];
let runtimeSessions = null;
let chatImageLongPressTriggered = false;
let chatImageLongPressTimer = null;
let chatImageActionState = { visible: false, x: 0, y: 0, url: "" };

// Markdown Worker 初始化
let markdownWorker = null;
let workerTaskId = 0;
let workerCallbacks = new Map();
let markdownWorkerAvailable = false;

const CHAT_SCRIPT_URL = (function () {
  try {
    if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
      return document.currentScript.src;
    }
  } catch {}
  try {
    const found = Array.from(document.scripts || []).find((s) => /\/chat\.js(\?|$)/.test(s.src || ''));
    if (found && found.src) return found.src;
  } catch {}
  return typeof window !== 'undefined' ? window.location.href : '';
})();

function disableMarkdownWorker(reason) {
  if (reason) console.warn('[chat] Markdown worker disabled:', reason);
  markdownWorkerAvailable = false;
  if (markdownWorker) {
    try { markdownWorker.terminate(); } catch {}
  }
  markdownWorker = null;
  workerCallbacks.forEach(({ resolve }, id) => {
    try { resolve(fmt('')); } catch {}
  });
  workerCallbacks.clear();
}

function initMarkdownWorker() {
  if (typeof Worker === 'undefined') {
    console.warn('[chat] Worker not supported, fallback to main thread');
    return;
  }
  try {
    const workerUrl = new URL('./markdown-worker.js', CHAT_SCRIPT_URL || window.location.href);
    markdownWorker = new Worker(workerUrl);
    markdownWorkerAvailable = true;
    markdownWorker.onmessage = function(e) {
      const { id, html, success, error } = e.data || {};
      const callback = workerCallbacks.get(id);
      if (!callback) return;
      if (success) {
        callback.resolve(html);
      } else {
        callback.resolve(fmt(callback.text));
      }
      workerCallbacks.delete(id);
    };
    markdownWorker.onerror = function(error) {
      console.error('[chat] Worker error:', error);
      disableMarkdownWorker(error?.message || 'worker runtime error');
    };
    markdownWorker.onmessageerror = function(error) {
      console.error('[chat] Worker message error:', error);
      disableMarkdownWorker(error?.message || 'worker message error');
    };
  } catch (e) {
    console.warn('[chat] Worker init failed, fallback to main thread', e);
    disableMarkdownWorker(e?.message || 'worker init failed');
  }
}

function renderMarkdownAsync(text) {
  return new Promise((resolve) => {
    if (!markdownWorker || !markdownWorkerAvailable) {
      resolve(fmt(text));
      return;
    }

    const id = ++workerTaskId;
    workerCallbacks.set(id, { resolve, text });

    setTimeout(() => {
      if (workerCallbacks.has(id)) {
        const callback = workerCallbacks.get(id);
        workerCallbacks.delete(id);
        callback?.resolve(fmt(text));
      }
    }, 2000);

    try {
      markdownWorker.postMessage({ id, text, action: 'render' });
    } catch (error) {
      workerCallbacks.delete(id);
      disableMarkdownWorker(error?.message || 'worker postMessage failed');
      resolve(fmt(text));
    }
  });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  return new Promise((resolve, reject) => {
    if ([...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === href)) return resolve();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload = resolve;
    link.onerror = reject;
    document.head.appendChild(link);
  });
}

async function loadDeps() {
  try {
    if (!window.marked) {
      await loadScript("https://cdn.jsdelivr.net/npm/marked/marked.min.js");
    }
  } catch {}

  try {
    await loadCss("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css");
    if (!window.hljs) {
      await loadScript("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/highlight.min.js");
    }
  } catch {}
}

function getConfigMap() {
  const list = window.GLOBAL?.configList || [];
  return Object.fromEntries(list.map((cfg) => [String(cfg.id), cfg]));
}

function getProviderBadge(modelName = "") {
  const brand = window.detectModelBrand ? window.detectModelBrand(modelName) : { shortLabel: "AI", key: "default", label: "AI" };
  return { label: brand.shortLabel || "AI", cls: brand.key || "default", brand };
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmt(content = "") {
  if (!content) return "";
  if (window.marked) {
    try {
      const safeText = content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return window.marked.parse(safeText, { gfm: true, breaks: true });
    } catch {}
  }
  return escapeHtml(content).replace(/\n/g, "<br>");
}

function toast(text) {
  let el = document.getElementById("chat-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "chat-toast";
    el.style.cssText = "position:fixed;left:50%;top:22px;transform:translateX(-50%);background:rgba(15,23,42,.92);color:#fff;padding:10px 14px;border-radius:12px;font-size:13px;z-index:99999;opacity:0;transition:.2s;pointer-events:none;box-shadow:0 12px 30px rgba(0,0,0,.22);";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = "0";
  }, 1600);
}

async function copyMsg(text) {
  try {
    const value = String(text || "");
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      toast("已复制");
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    toast(ok ? "已复制" : "复制失败");
  } catch {
    toast("复制失败");
  }
}

function initSessions() {
  let sessions = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "{}");
  if (!Object.keys(sessions).length) {
    const id = "s_" + Date.now();
    sessions[id] = { id, title: "新会话", messages: [] };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sessions));
  }
  currentSessionId = Object.keys(sessions)[0];
}

function sanitizeSessionsForStorage(sessions) {
  const clone = JSON.parse(JSON.stringify(sessions || {}));
  Object.values(clone).forEach((session) => {
    if (!Array.isArray(session?.messages)) return;
    session.messages = session.messages.map((msg) => {
      var cleaned = msg;
      if (Array.isArray(msg?.user_files)) {
        cleaned = {
          ...cleaned,
          user_files: msg.user_files.map((file) => ({
            filename: file?.filename || "",
            content_type: file?.content_type || "",
            text_content: String(file?.text_content || "").slice(0, 2000),
            size: file?.size || 0,
            image_url: "",
            preview_url: String(file?.preview_url || file?.image_url || "").startsWith("data:") ? "" : String(file?.preview_url || file?.image_url || ""),
            preview_path: String(file?.preview_path || "")
          }))
        };
      }
      if (Array.isArray(cleaned?.images)) {
        cleaned = {
          ...cleaned,
          images: cleaned.images.map((img) => ({
            ...img,
            url: String(img?.url || "").startsWith("data:") ? "" : String(img?.url || ""),
            b64_json: ""
          })).filter((img) => img.url)
        };
      }
      return cleaned;
    });
  });
  return clone;
}

function getSessions() {
  if (runtimeSessions) return runtimeSessions;
  runtimeSessions = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "{}");
  return runtimeSessions;
}

function setSessions(sessions) {
  runtimeSessions = sessions;
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sanitizeSessionsForStorage(sessions)));
}

function resolveChatPreviewUrl(file = {}) {
  const direct = String(file.preview_url || file.image_url || "");
  if (direct) return direct;
  const rawPath = String(file.preview_path || "");
  if (!rawPath) return "";
  return (window.Capacitor && typeof window.Capacitor.convertFileSrc === "function") ? window.Capacitor.convertFileSrc(rawPath) : rawPath;
}

function getCurrentSession() {
  const sessions = getSessions();
  return sessions[currentSessionId] || null;
}

function getMsg() {
  return getCurrentSession()?.messages || [];
}

function setMsg(msgs, meta = {}, sessionId) {
  const sid = sessionId || currentSessionId;
  const sessions = getSessions();
  const session = sessions[sid];
  if (!session) return;
  session.messages = msgs;
  if (meta.model_name) session.model_name = meta.model_name;
  const firstUser = msgs.find((m) => m.role === "user" && (m.content || "").trim());
  if (firstUser) session.title = firstUser.content.trim().replace(/\n/g, " ").slice(0, 24) || "新会话";
  setSessions(sessions);
  renderSessionList();
  updateHeaderTitle();
}

function newSession() {
  const sessions = getSessions();
  const id = "s_" + Date.now();
  sessions[id] = { id, title: "新会话", messages: [] };
  currentSessionId = id;
  setSessions(sessions);
  renderSessionList();
  renderMessages();
  updateHeaderTitle();
}

function switchSession(id) {
  currentSessionId = id;
  renderSessionList();
  refreshModelPills();
  renderMessages();
  updateHeaderTitle();
  updateSendBtnState();
}

function delSession(id, e) {
  e?.stopPropagation();
  if (!confirm("确定删除这个会话吗？")) return;
  const sessions = getSessions();
  delete sessions[id];
  if (!Object.keys(sessions).length) {
    const newId = "s_" + Date.now();
    sessions[newId] = { id: newId, title: "新会话", messages: [] };
    currentSessionId = newId;
  } else if (currentSessionId === id) {
    currentSessionId = Object.keys(sessions)[0];
  }
  setSessions(sessions);
  renderSessionList();
  renderMessages();
  updateHeaderTitle();
}

function updateHeaderTitle() {
  const el = document.getElementById("chat-title-main");
  if (!el) return;
  el.textContent = getCurrentSession()?.title || "新会话";
}

function renderSessionList() {
  const host = document.getElementById("chat-session-list");
  if (!host) return;
  const sessions = Object.values(getSessions()).sort((a, b) => Number(String(b.id || "").replace(/^s_/, "")) - Number(String(a.id || "").replace(/^s_/, "")));
  host.innerHTML = sessions.map((session) => `
    <div class="oc-session-item ${session.id === currentSessionId ? "active" : ""}" data-session-id="${session.id}">
      <span class="oc-session-title">${escapeHtml(session.title || "新会话")}</span>
      <button type="button" class="oc-session-del" data-del-session="${session.id}" aria-label="删除会话">×</button>
    </div>
  `).join("");
}

function isSessionGenerating(sid) { return activeGenerations.has(sid || currentSessionId); }
function stopSessionGenerate(sid) {
  const gen = activeGenerations.get(sid);
  if (!gen) return;
  if (gen.controller) gen.controller.abort();
  if (gen.timeoutId) clearTimeout(gen.timeoutId);
  activeGenerations.delete(sid);
  const sessions = getSessions();
  const session = sessions[sid];
  if (session) {
    const msgs = session.messages || [];
    const last = msgs[msgs.length - 1];
    if (last && last.role === "assistant" && last.streaming) {
      last.streaming = false;
      if (!last.content) last.content = "已停止生成";
      setSessions(sessions);
    }
  }
  if (sid === currentSessionId) { renderMessages(); updateSendBtnState(); }
}

function updateSendBtnState() {
  const btn = document.getElementById("send-chat-btn");
  if (!btn) return;
  const generating = isSessionGenerating(currentSessionId);
  btn.disabled = false;
  btn.textContent = generating ? "停止" : "发送";
  btn.classList.toggle("is-stop", generating);
}

function autoResizeTextarea() {
  const ipt = document.getElementById("chat-input");
  if (!ipt) return;
  ipt.style.height = "auto";
  ipt.style.height = Math.min(ipt.scrollHeight, 180) + "px";
}

async function persistChatImageFile(file) {
  try {
    if (!file) return "";
    if (window.LiuHuiGallery && typeof window.LiuHuiGallery.saveBase64ToAppFile === "function") {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(`图片读取失败：${file.name}`));
        reader.readAsDataURL(file);
      });
      const match = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) return String(dataUrl || "");
      const saved = String(window.LiuHuiGallery.saveBase64ToAppFile(match[2], match[1], "chat") || "");
      if (!saved.startsWith("OK:")) return "";
      const rawPath = saved.slice(3);
      return (window.Capacitor && typeof window.Capacitor.convertFileSrc === "function") ? `${window.Capacitor.convertFileSrc(rawPath)}||RAW||${rawPath}` : rawPath;
    }
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/chat/upload-image", { method: "POST", body: formData });
    if (!res.ok) return "";
    const result = await res.json();
    if (result.code === 0 && result.data?.url) return result.data.url;
    return "";
  } catch (error) {
    console.warn("[chat][file] persistChatImageFile error", error);
    return "";
  }
}

async function extractPdfText(file) {
  try {
    const formData = new FormData();
    formData.append("file", file);
    console.log("[chat][file] PDF uploading to backend for parsing:", file.name, file.size);
    const res = await fetch("/api/chat/parse-pdf", { method: "POST", body: formData });
    if (!res.ok) {
      console.warn("[chat][file] PDF backend returned", res.status);
      return null;
    }
    const result = await res.json();
    if (result.code === 0 && result.data && result.data.text) {
      console.log("[chat][file] PDF backend extraction OK, pages:", result.data.pages, "length:", result.data.text.length);
      return result.data.text;
    }
    console.warn("[chat][file] PDF backend returned empty result");
    return null;
  } catch (error) {
    console.error("[chat][file] PDF backend extraction failed:", error);
    return null;
  }
}

async function readSmartFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const supportedTextExts = new Set(["txt", "md", "json", "csv", "py", "js", "ts", "html", "css", "xml", "yaml", "yml", "log", "ini", "cfg", "sql", "java", "kt", "go", "rs", "sh"]);
  const isPdf = ext === "pdf";
  const isWord = ext === "doc" || ext === "docx";
  const isImage = (file.type || "").startsWith("image/");
  const canReadAsText = supportedTextExts.has(ext) || ["text/", "application/json", "application/javascript", "application/xml"].some((prefix) => (file.type || "").startsWith(prefix) || file.type === prefix);
  if (!canReadAsText && !isPdf && !isWord && !isImage) {
    throw new Error(`暂不支持该文件类型：${file.name}。目前只支持图片、txt/md/json/csv/pdf/doc/docx 及常见代码文本文件。`);
  }
  if (isImage) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(`图片读取失败：${file.name}`));
      reader.readAsDataURL(file);
    });
    const persistedValue = await persistChatImageFile(file);
    const [persistedUrl, persistedRawPath = ""] = String(persistedValue || "").split("||RAW||");
    console.log("[chat][file] extracted image", { name: file.name, ext, size: file.size, dataLength: dataUrl.length, persisted: !!persistedUrl });
    return { filename: file.name, content_type: file.type || "image/png", image_url: dataUrl, preview_url: persistedUrl || dataUrl, preview_path: persistedRawPath || "", text_content: `[图片已上传：${file.name}]`, size: file.size };
  }
  if (canReadAsText) {
    let text = "";
    try { text = await file.text(); } catch {}
    if (!text) {
      try {
        const buf = await file.arrayBuffer();
        text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      } catch {}
    }
    text = String(text || "").replace(/\u0000/g, "").trim();
    
    // 检查文件内容大小限制（50MB 字符，约 12.5M tokens）
    const MAX_CHARS = 50000000;
    if (text.length > MAX_CHARS) {
      throw new Error(`文件 ${file.name} 内容过大（${text.length} 字符），超出限制（${MAX_CHARS} 字符）。请使用较小的文件或分段上传。`);
    }
    
    const finalText = text || `[文件已上传：${file.name}，但未能读取到文本内容。]`;
    console.log("[chat][file] extracted text", { name: file.name, ext, size: file.size, extractedLength: finalText.length, preview: finalText.slice(0, 120) });
    return { filename: file.name, content_type: file.type || "text/plain", text_content: finalText, size: file.size };
  }
  
  // PDF 文件处理
  if (isPdf) {
    const pdfText = await extractPdfText(file);
    if (pdfText && pdfText.length > 0) {
      // 检查 PDF 内容大小
      const MAX_CHARS = 50000000;
      if (pdfText.length > MAX_CHARS) {
        throw new Error(`PDF 文件 ${file.name} 内容过大（${pdfText.length} 字符），超出限制（${MAX_CHARS} 字符）。请使用较小的文件或分段上传。`);
      }
      console.log("[chat][file] extracted PDF", { name: file.name, ext, size: file.size, extractedLength: pdfText.length, preview: pdfText.slice(0, 120) });
      return { filename: file.name, content_type: file.type || "application/pdf", text_content: pdfText, size: file.size };
    }
    // PDF 解析失败，返回占位符
    const placeholder = `[PDF 文件已上传：${file.name}。PDF 解析失败，请确保文件未加密或损坏。]`;
    console.log("[chat][file] PDF extraction failed", { name: file.name, ext, size: file.size });
    return { filename: file.name, content_type: file.type || "application/pdf", text_content: placeholder, size: file.size };
  }
  
  // Word 文件占位符
  const placeholder = `[Word 文件已上传：${file.name}。当前版本暂未解析 DOC/DOCX 正文，请结合文件名和问题回答。]`;
  console.log("[chat][file] placeholder only", { name: file.name, ext, size: file.size, extractedLength: placeholder.length });
  return { filename: file.name, content_type: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text_content: placeholder, size: file.size };
}

async function collectSmartFiles() {
  const fileInput = document.getElementById("chat-file-input");
  const files = Array.from(fileInput?.files || []);

  try {
    for (const file of files) {
      smartFiles.push(await readSmartFile(file));
    }
    renderSmartFiles();
  } catch (error) {
    if (fileInput) fileInput.value = "";
    renderSmartFiles();
    toast(error.message || "文件处理失败");
    console.error("[chat][file] collectSmartFiles error", error);
  }
}

function renderSmartFiles() {
  const host = document.getElementById("chat-file-list");
  if (!host) return;
  if (!smartFiles.length) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }
  host.style.display = "flex";
  host.innerHTML = smartFiles.map((file, index) => `
    <span class="oc-file-chip">
      <span>${escapeHtml(file.filename || `附件${index + 1}`)}</span>
      <button type="button" data-remove-smart-file="${index}">×</button>
    </span>
  `).join("");
}

function renderMessageItem(m, index, totalCount) {
  const isUser = m.role === "user";
  const html = fmt(m.content || "");
  const isLastAssistant = !isUser && !m.streaming && index === totalCount - 1;
  const userFiles = Array.isArray(m.user_files) ? m.user_files : [];
  if (isUser && userFiles.length) console.log("[chat][image] render user files", userFiles.map((f) => ({ name: f.filename, preview: !!f.preview_url, previewPath: !!f.preview_path, image: !!f.image_url, type: f.content_type })));
  const filePreview = isUser && userFiles.length ? `
    <div class="oc-file-preview-list">
      ${userFiles.map((file, i) => {
        const previewSrc = resolveChatPreviewUrl(file);
        return String(file.content_type || "").startsWith("image/") && previewSrc
          ? `<button type="button" class="oc-image-card oc-image-card-inline" data-chat-image-preview="${escapeHtml(previewSrc)}" data-chat-image-save="${escapeHtml(file.image_url || previewSrc || "")}"><img src="${escapeHtml(previewSrc)}" alt="user-file-${i + 1}" onerror="console.warn('[chat][image] preview load failed', this.src)"></button>`
          : `<span class="oc-file-chip static"><span>${escapeHtml(file.filename || `附件${i + 1}`)}</span></span>`;
      }).join("")}
    </div>
  ` : "";
  const images = Array.isArray(m.images) && m.images.length ? `
    <div class="oc-image-grid">
      ${m.images.map((img, i) => `<button type="button" class="oc-image-card" data-chat-image-preview="${escapeHtml(img.url)}" data-chat-image-save="${escapeHtml(img.url)}"><img src="${escapeHtml(img.url)}" alt="image-${i + 1}"></button>`).join("")}
    </div>
  ` : "";
  const selectedChatId = document.getElementById("chat-config-select")?.value || "";
  const session = getSessions()?.[currentSessionId] || {};
  const modelHint = m.model_name || session.model_name || ((window.GLOBAL?.configList || []).find((item) => String(item.id) === String(selectedChatId))?.model_name) || "";
  const cfg = (window.GLOBAL?.configList || []).find((item) => String(item.id) === String(selectedChatId));
  const badge = isUser ? { label: "我", cls: "user" } : getProviderBadge(modelHint || cfg?.model_name || "");
  const assistantAvatar = !isUser && window.renderModelIcon
    ? window.renderModelIcon(modelHint || cfg?.model_name || "", { size: 22, title: badge.brand?.label || modelHint || cfg?.model_name || "AI" })
    : `<div class="oc-avatar ${isUser ? "" : `provider-${badge.cls}`} ">${badge.label}</div>`;
  const regenerateBtn = !isUser && !m.streaming && isLastAssistant ? `<div class="oc-regen-wrap oc-regen-last"><button type="button" class="oc-regen-btn" data-regen-idx="${index}" title="重新生成"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button></div>` : "";
  return `
    <div class="oc-msg-row ${isUser ? "user" : "assistant"}" data-idx="${index}" data-role="${m.role}" data-streaming="${m.streaming ? "1" : "0"}">
      ${isUser ? `<div class="oc-avatar">${badge.label}</div>` : assistantAvatar}
      <div class="oc-bubble ${isUser ? "user" : "assistant"}">
        <div class="oc-markdown">${html || (!isUser ? '<span class="oc-dim">...</span>' : "")}</div>
        ${filePreview}${images}
      </div>
      ${regenerateBtn}
    </div>
  `;
}

function ensureChatImagePreviewModal() {
  let modal = document.getElementById("chat-image-preview-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "chat-image-preview-modal";
  modal.className = "oc-image-preview-modal hidden";
  modal.innerHTML = `
    <div class="oc-image-preview-dialog" id="chat-image-preview-dialog">
      <img id="chat-image-preview-target" src="" alt="preview">
    </div>
  `;
  var _cpZoom = 1, _cpPanX = 0, _cpPanY = 0, _cpPinchDist = 0, _cpPinchZoom = 1, _cpDrag = null;
  function _cpApply() { var img = modal.querySelector("#chat-image-preview-target"); if (img) img.style.transform = "translate(" + _cpPanX + "px," + _cpPanY + "px) scale(" + _cpZoom + ")"; }
  function _cpReset() { _cpZoom = 1; _cpPanX = 0; _cpPanY = 0; _cpApply(); }
  function _cpDist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  var _cpTapTimer = null, _cpTapCount = 0, _cpTouchMoved = false;
  function _cpIsTarget(t) { return t === modal || t.id === "chat-image-preview-dialog" || t.id === "chat-image-preview-target"; }
  function _cpHandleTap() {
    _cpTapCount++;
    if (_cpTapTimer) clearTimeout(_cpTapTimer);
    _cpTapTimer = setTimeout(function() {
      if (_cpTapCount === 1) { closeChatImagePreview(); _cpReset(); }
      else if (_cpTapCount >= 2) {
        if (_cpZoom > 1.05) { _cpZoom = 1; _cpPanX = 0; _cpPanY = 0; } else { _cpZoom = 2.5; }
        _cpApply();
      }
      _cpTapCount = 0;
    }, 180);
  }
  modal.addEventListener("click", function(e) { if (_cpIsTarget(e.target)) { e.preventDefault(); e.stopPropagation(); _cpHandleTap(); } });
  modal.addEventListener("touchstart", function(e) {
    if (!_cpIsTarget(e.target)) return;
    _cpTouchMoved = false;
    if (e.touches.length === 2) { _cpPinchDist = _cpDist(e.touches[0], e.touches[1]); _cpPinchZoom = _cpZoom; e.preventDefault(); }
    else if (e.touches.length === 1 && _cpZoom > 1.05) { _cpDrag = { x: e.touches[0].clientX - _cpPanX, y: e.touches[0].clientY - _cpPanY }; e.preventDefault(); }
  }, { passive: false });
  modal.addEventListener("touchmove", function(e) {
    _cpTouchMoved = true;
    if (e.touches.length === 2 && _cpPinchDist > 0) { var d = _cpDist(e.touches[0], e.touches[1]); _cpZoom = Math.max(0.5, Math.min(6, _cpPinchZoom * (d / _cpPinchDist))); _cpApply(); e.preventDefault(); }
    else if (e.touches.length === 1 && _cpDrag) { _cpPanX = e.touches[0].clientX - _cpDrag.x; _cpPanY = e.touches[0].clientY - _cpDrag.y; _cpApply(); e.preventDefault(); }
  }, { passive: false });
  modal.addEventListener("touchend", function(e) {
    if (e.touches.length < 2) _cpPinchDist = 0;
    if (e.touches.length === 0) {
      _cpDrag = null;
      if (!_cpTouchMoved && _cpIsTarget(e.target)) { e.preventDefault(); _cpHandleTap(); }
      _cpTouchMoved = false;
    }
  }, { passive: false });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      closeChatImagePreview();
    }
  });
  document.body.appendChild(modal);
  return modal;
}

function ensureChatImageActionBar() {
  let bar = document.getElementById("chat-image-action-bar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "chat-image-action-bar";
  bar.className = "oc-image-action-bar hidden";
  bar.innerHTML = `
    <button type="button" class="oc-image-action-btn" data-chat-image-action="save">
      <i class="fa fa-download"></i>
      <span>保存图片</span>
    </button>
    <button type="button" class="oc-image-action-btn ghost" data-chat-image-action="preview">
      <i class="fa fa-search-plus"></i>
      <span>预览</span>
    </button>
  `;
  bar.addEventListener("click", (event) => {
    const action = event.target.closest("[data-chat-image-action]")?.getAttribute("data-chat-image-action");
    if (!action) return;
    const url = chatImageActionState.url || "";
    hideChatImageActionBar();
    if (action === "save") saveChatImageToGallery(url);
    if (action === "preview") openChatImagePreview(url);
  });
  document.body.appendChild(bar);
  return bar;
}

function showChatImageActionBar(url, anchorRect) {
  if (!url || !anchorRect) return;
  const bar = ensureChatImageActionBar();
  chatImageActionState = { visible: true, x: anchorRect.right - 8, y: anchorRect.top + 10, url };
  bar.classList.remove("hidden");
  bar.style.left = `${Math.max(12, Math.min(window.innerWidth - 180, chatImageActionState.x - 148))}px`;
  bar.style.top = `${Math.max(12, Math.min(window.innerHeight - 64, chatImageActionState.y))}px`;
}

function hideChatImageActionBar() {
  const bar = document.getElementById("chat-image-action-bar");
  if (bar) bar.classList.add("hidden");
  chatImageActionState = { visible: false, x: 0, y: 0, url: "" };
}

function openChatImagePreview(url) {
  const modal = ensureChatImagePreviewModal();
  const target = modal.querySelector("#chat-image-preview-target");
  if (!url || !target) return;
  if (!modal.classList.contains("hidden") && target.src === url) { closeChatImagePreview(); return; }
  target.src = url;
  modal.classList.remove("hidden");
  modal.style.display = "block";
  target.style.transform = "";
}

function closeChatImagePreview() {
  const modal = document.getElementById("chat-image-preview-modal");
  const target = document.getElementById("chat-image-preview-target");
  if (target) target.src = "";
  if (modal) {
    modal.classList.add("hidden");
    modal.style.display = "none";
  }
}

async function saveChatImageToGallery(imageUrl) {
  try {
    if (!imageUrl) return;
    const match = String(imageUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (window.LiuHuiGallery && typeof window.LiuHuiGallery.saveBase64Image === "function" && match) {
      const result = String(window.LiuHuiGallery.saveBase64Image(match[2], match[1], "liuhui-chat") || "");
      if (result.startsWith("OK:")) return toast("已保存到相册");
      throw new Error(result || "保存失败");
    }
    const res = await fetch(imageUrl);
    const blob = await res.blob();
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const m = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (window.LiuHuiGallery && typeof window.LiuHuiGallery.saveBase64Image === "function" && m) {
        const result = String(window.LiuHuiGallery.saveBase64Image(m[2], m[1], "liuhui-chat") || "");
        if (result.startsWith("OK:")) toast("已保存到相册");
        else toast("保存失败");
      }
    };
    reader.readAsDataURL(blob);
  } catch (error) {
    console.warn("[chat][image] save failed", error);
    toast("保存失败");
  }
}

function getRenderableMessages() {
  return getMsg().filter((m) => ((m.content || "").trim() !== "") || (Array.isArray(m.images) && m.images.length) || m.streaming);
}

function renderMessages() {
  const wrap = document.getElementById("chat-message-list");
  if (!wrap) return;
  const msgs = getRenderableMessages();
  if (!msgs.length) {
    wrap.innerHTML = `
      <div class="oc-empty">
        <div class="oc-empty-title">欢迎来到流绘</div>
        <div class="oc-empty-desc">在这里对话、整理想法，或切到画布继续展开。</div>
        <div style="margin-top:20px;"><a href="https://space.bilibili.com/496010777" target="_blank" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:rgba(0,161,214,.08);border:1px solid rgba(0,161,214,.2);color:#00a1d6;font-size:12px;text-decoration:none;font-weight:600;transition:all .2s;"><svg viewBox="0 0 24 24" width="14" height="14" fill="#00a1d6"><path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z"/></svg>作者B站主页</a></div>
        <div style="margin-top:12px;font-size:9px;color:rgba(148,163,184,.5);">未经本人允许禁止二次分发 · 严禁转卖</div>
      </div>
    `;
    return;
  }
  wrap.innerHTML = msgs.map((m, i) => renderMessageItem(m, i, msgs.length)).join("");
  enhanceAllMessages(wrap);
  wrap.scrollTop = wrap.scrollHeight;
}

let streamingThrottle = null;
let pendingStreamText = null;
let isRendering = false;

async function patchStreamingBubble(fullText, streaming = true) {
  const wrap = document.getElementById("chat-message-list");
  if (!wrap) return;
  
  // 保存待更新的文本
  pendingStreamText = fullText;
  
  // 如果正在渲染，跳过本次更新
  if (isRendering) return;
  
  // 节流：每 200ms 更新一次（降低频率但保持流畅感）
  if (streamingThrottle) return;
  
  streamingThrottle = setTimeout(async () => {
    streamingThrottle = null;
    
    if (isRendering || !pendingStreamText) return;
    isRendering = true;
    
    try {
      const rows = [...wrap.querySelectorAll('.oc-msg-row[data-role="assistant"]')];
      const row = [...rows].reverse().find((node) => node.getAttribute("data-streaming") === "1") || rows[rows.length - 1];
      if (!row) {
        isRendering = false;
        return;
      }
      
      const md = row.querySelector(".oc-markdown");
      const tip = row.querySelector(".oc-streaming-tip");
      
      if (md && pendingStreamText !== null) {
        // 使用 Worker 异步渲染 markdown
        const html = await renderMarkdownAsync(pendingStreamText);
        md.innerHTML = html;
      }
      if (tip) tip.textContent = streaming ? "正在生成..." : "";
      row.setAttribute("data-streaming", streaming ? "1" : "0");
      
      // 延迟增强，避免阻塞
      requestAnimationFrame(() => {
        enhanceAllMessages(row);
        wrap.scrollTop = wrap.scrollHeight;
        isRendering = false;
      });
      
      pendingStreamText = null;
    } catch (e) {
      console.error('[chat] Render error:', e);
      isRendering = false;
    }
  }, 200);
}

function patchLastAssistantMessage(text, streaming = true, sessionId) {
  const sid = sessionId || currentSessionId;
  const sessions = getSessions();
  const session = sessions[sid];
  if (!session) return;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "assistant" && m.streaming) {
      m.content = text;
      m.streaming = streaming;
      break;
    }
  }
  setSessions(sessions);
  if (sid === currentSessionId) patchStreamingBubble(text, streaming);
}

function finishLastAssistantMessage(text, extra = {}, sessionId) {
  const sid = sessionId || currentSessionId;
  const sessions = getSessions();
  const session = sessions[sid];
  if (!session) return;
  const msgs = [...(session.messages || [])];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && msgs[i].streaming) {
      msgs[i].content = text;
      msgs[i].streaming = false;
      if (extra.images) msgs[i].images = extra.images;
      if (extra.model_name) msgs[i].model_name = extra.model_name;
      break;
    }
  }
  setMsg(msgs, { model_name: extra.model_name }, sid);
  if (sid === currentSessionId) renderMessages();
  if (extra.images && extra.images.length) persistChatImages(msgs, sid);
}

async function persistChatImages(msgs, sid) {
  var changed = false;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!Array.isArray(m.images)) continue;
    for (var j = 0; j < m.images.length; j++) {
      var img = m.images[j];
      var url = img.url || img.b64_json || "";
      if (!url || !url.startsWith("data:image/")) continue;
      var persisted = await persistChatImageToFile(url);
      if (persisted && persisted !== url) {
        m.images[j] = { ...img, url: persisted, b64_json: "" };
        changed = true;
      }
    }
  }
  if (changed) setMsg(msgs, {}, sid);
}

async function persistChatImageToFile(dataUrl) {
  try {
    if (!dataUrl || !dataUrl.startsWith("data:image/")) return dataUrl;
    if (window.LiuHuiGallery && typeof window.LiuHuiGallery.saveBase64ToAppFile === "function") {
      var match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) return dataUrl;
      var result = String(window.LiuHuiGallery.saveBase64ToAppFile(match[2], match[1], "chat-img") || "");
      if (result.startsWith("OK:")) {
        var rawPath = result.slice(3);
        return (window.Capacitor && typeof window.Capacitor.convertFileSrc === "function") ? window.Capacitor.convertFileSrc(rawPath) : rawPath;
      }
      return dataUrl;
    }
    var res = await fetch("/api/chat/upload-image-base64", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image_base64: dataUrl }) });
    if (!res.ok) return dataUrl;
    var json = await res.json();
    return (json.code === 0 && json.data?.url) ? json.data.url : dataUrl;
  } catch (e) {
    console.warn("[chat] persistChatImageToFile error", e);
    return dataUrl;
  }
}

async function regenerateFromIndex(assistantIdx) {
  const sendSessionId = currentSessionId;
  if (isSessionGenerating(sendSessionId)) return;
  const allMsgs = getRenderableMessages();
  const fullMsgs = [...getMsg()];
  let userMsg = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (allMsgs[i] && allMsgs[i].role === "user") { userMsg = allMsgs[i]; break; }
  }
  if (!userMsg) return toast("找不到对应的用户消息");
  const userText = userMsg.content || "";
  const userFiles = Array.isArray(userMsg.user_files) ? userMsg.user_files : [];
  const assistantMsg = allMsgs[assistantIdx];
  const fullIdx = fullMsgs.indexOf(assistantMsg);
  if (fullIdx < 0) return;

  const userFullIdx = fullMsgs.indexOf(userMsg);
  const historyMsgs = userFullIdx > 0
    ? fullMsgs.slice(0, userFullIdx).filter((m) => m.role && typeof m.content === "string" && !m.streaming).map(({ role, content }) => ({ role, content: content.trim() })).filter((m) => m.content)
    : [];

  const chatSel = document.getElementById("chat-config-select");
  const imageSel = document.getElementById("image-config-select");
  if (!chatSel?.value) return toast("请选择聊天配置");
  const currentCfg = (window.GLOBAL?.configList || []).find((item) => String(item.id) === String(chatSel.value));
  const currentModelName = currentCfg?.model_name || currentCfg?.name || "";

  fullMsgs[fullIdx] = { role: "assistant", content: "", streaming: true, model_name: currentModelName };
  fullMsgs.length = fullIdx + 1;
  setMsg(fullMsgs, { model_name: currentModelName }, sendSessionId);
  renderMessages();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  activeGenerations.set(sendSessionId, { controller, timeoutId });
  updateSendBtnState();
  try {
    const res = await fetch("/api/chat/smart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: userText, messages: historyMsgs, chat_config_id: chatSel.value, image_config_id: imageSel?.value || null, stream: true, files: userFiles }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`请求失败 [${res.status}]：${await res.text()}`);
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const result = await res.json();
      if (result.mode === "image") {
        const imageCount = Array.isArray(result?.data?.images) ? result.data.images.length : 0;
        if (result.code !== 0 || imageCount === 0) {
          finishLastAssistantMessage(result?.message || "图片接口返回成功，但没有解析到可显示图片。", {}, sendSessionId);
        } else {
          finishLastAssistantMessage(`图片已生成完成。\n\n提示词：${result?.data?.prompt || userText}\n尺寸：${result?.data?.image_size || "1024x1024"}\n数量：${imageCount} 张`, { images: result?.data?.images || [], model_name: currentModelName }, sendSessionId);
        }
      } else {
        finishLastAssistantMessage(result?.data?.choices?.[0]?.message?.content || result?.message || "处理完成", { model_name: currentModelName }, sendSessionId);
      }
    } else {
      const finalText = res.body ? await readStreamResponse(res, (fullText) => patchLastAssistantMessage(fullText, true, sendSessionId)) : "";
      finishLastAssistantMessage(finalText || "无返回内容", { model_name: currentModelName }, sendSessionId);
    }
  } catch (e) {
    if (e.name === "AbortError") {
      const s = getSessions()[sendSessionId];
      const msgs = s?.messages || [];
      const last = msgs[msgs.length - 1];
      const hasContent = last && last.role === "assistant" && (last.content || "").trim();
      if (hasContent) { finishLastAssistantMessage(last.content, {}, sendSessionId); }
      else { finishLastAssistantMessage("请求超时，请重试", {}, sendSessionId); toast("请求超时"); }
    } else { finishLastAssistantMessage(`请求出错：${e.message}`, {}, sendSessionId); toast(`错误：${e.message}`); }
  } finally {
    clearTimeout(timeoutId);
    activeGenerations.delete(sendSessionId);
    updateSendBtnState();
  }
}

function extractContentFromJson(obj) {
  if (!obj) return "";
  if (obj.error) return `错误：${obj.error.message || obj.error}`;
  if (obj.choices?.length) {
    const choice = obj.choices[0];
    if (typeof choice?.delta?.content === "string") return choice.delta.content;
    if (typeof choice?.message?.content === "string") return choice.message.content;
  }
  return obj.content || "";
}

async function readStreamResponse(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const chunk = extractContentFromJson(json);
        if (chunk) {
          fullText += chunk;
          onDelta(fullText, chunk);
        }
      } catch {
        fullText += data;
        onDelta(fullText, data);
      }
    }
  }
  return fullText;
}

function buildPayloadMessages(msgs) {
  const result = [];
  for (const m of msgs) {
    if (!m.role || m.streaming) continue;
    const text = String(m.content || "").trim();
    if (!text && !Array.isArray(m.user_files) && !Array.isArray(m.images)) continue;

    const imageUrls = [];
    if (Array.isArray(m.user_files)) {
      for (const f of m.user_files) {
        if (String(f.content_type || "").startsWith("image/")) {
          const url = f.image_url || f.preview_url || "";
          if (url) imageUrls.push(url);
        }
      }
    }
    if (Array.isArray(m.images)) {
      for (const img of m.images) {
        if (img.url) imageUrls.push(img.url);
      }
    }

    if (imageUrls.length) {
      result.push({ role: m.role, content: text, image_urls: imageUrls });
    } else if (text) {
      result.push({ role: m.role, content: text });
    }
  }
  return result;
}

async function send() {
  const sendSessionId = currentSessionId;
  if (isSessionGenerating(sendSessionId)) {
    stopSessionGenerate(sendSessionId);
    return;
  }
  const ipt = document.getElementById("chat-input");
  const chatSel = document.getElementById("chat-config-select");
  const imageSel = document.getElementById("image-config-select");
  const text = ipt?.value.trim();
  if (!ipt || !chatSel) return;
  if (!chatSel.value) return toast("请选择聊天配置");

  const pendingFiles = smartFiles.map((file) => ({ ...file }));
  if (!text && !pendingFiles.length) return toast("请输入内容或选择附件");
  smartFiles = [];
  const fileInput = document.getElementById("chat-file-input");
  if (fileInput) fileInput.value = "";
  renderSmartFiles();

  const prevMsgs = getMsg();
  const currentCfg = (window.GLOBAL?.configList || []).find((item) => String(item.id) === String(chatSel.value));
  const currentModelName = currentCfg?.model_name || currentCfg?.name || "";
  const userText = text || (pendingFiles.length ? "[附件]" : "");
  const nextMsgs = [...prevMsgs, { role: "user", content: userText, user_files: pendingFiles }, { role: "assistant", content: "", streaming: true, model_name: currentModelName }];
  setMsg(nextMsgs, { model_name: currentModelName }, sendSessionId);
  ipt.value = "";
  autoResizeTextarea();
  renderMessages();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 600000);
  activeGenerations.set(sendSessionId, { controller, timeoutId });
  updateSendBtnState();

  try {
    const payloadMessages = buildPayloadMessages(prevMsgs);

    const res = await fetch("/api/chat/smart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        messages: payloadMessages,
        chat_config_id: chatSel.value,
        image_config_id: imageSel?.value || null,
        stream: true,
        files: pendingFiles
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`请求失败 [${res.status}]：${errorText}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const result = await res.json();
      if (result.mode === "image") {
        const imageCount = Array.isArray(result?.data?.images) ? result.data.images.length : 0;
        if (result.code !== 0 || imageCount === 0) {
          finishLastAssistantMessage(result?.message || "图片接口返回成功，但没有解析到可显示图片。", {}, sendSessionId);
        } else {
          finishLastAssistantMessage(`图片已生成完成。\n\n提示词：${result?.data?.prompt || text}\n尺寸：${result?.data?.image_size || "1024x1024"}\n数量：${imageCount} 张`, { images: result?.data?.images || [], model_name: currentModelName }, sendSessionId);
        }
      } else {
        const textResult = result?.data?.choices?.[0]?.message?.content || result?.message || "处理完成";
        finishLastAssistantMessage(textResult, { model_name: currentModelName }, sendSessionId);
      }
    } else {
      const finalText = res.body ? await readStreamResponse(res, (fullText) => patchLastAssistantMessage(fullText, true, sendSessionId)) : "";
      finishLastAssistantMessage(finalText || "无返回内容", { model_name: currentModelName }, sendSessionId);
    }

  } catch (e) {
    if (e.name === "AbortError") {
      const s = getSessions()[sendSessionId];
      const msgs = s?.messages || [];
      const last = msgs[msgs.length - 1];
      const hasContent = last && last.role === "assistant" && (last.content || "").trim();
      if (hasContent) {
        finishLastAssistantMessage(last.content, {}, sendSessionId);
      } else {
        finishLastAssistantMessage("请求超时，请重试", {}, sendSessionId);
        toast("请求超时");
      }
    } else {
      finishLastAssistantMessage(`请求出错：${e.message}`, {}, sendSessionId);
      toast(`错误：${e.message}`);
    }
  } finally {
    clearTimeout(timeoutId);
    activeGenerations.delete(sendSessionId);
    updateSendBtnState();
  }
}

function enhanceAllMessages(container) {
  if (!container) return;
  
  // 先处理代码块结构（不高亮）
  enhanceCodeBlocks(container);
  
  // 延迟代码高亮，避免阻塞主线程
  if (window.hljs) {
    requestIdleCallback(() => {
      try {
        container.querySelectorAll("pre code:not(.hljs)").forEach((block) => {
          if (!block.dataset.highlighted) {
            window.hljs.highlightElement(block);
            block.dataset.highlighted = "true";
          }
        });
      } catch (e) {
        console.warn('[chat] Code highlight error:', e);
      }
    }, { timeout: 1000 });
  }
}

function enhanceCodeBlocks(container) {
  const pres = [...container.querySelectorAll("pre")];
  pres.forEach((pre) => {
    if (pre._enhanced) return;
    const code = pre.querySelector("code");
    const codeText = code ? code.textContent : pre.textContent || "";
    const wrapper = document.createElement("div");
    wrapper.className = "oc-code-wrap";
    const header = document.createElement("div");
    header.className = "oc-code-head";
    header.innerHTML = `<span>code</span><button type="button" class="oc-copy-code" data-copy-code="${escapeHtml(codeText)}">复制代码</button>`;
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
    pre._enhanced = true;
  });
}

function refreshModelPills() {
  const chatSel = document.getElementById("chat-config-select");
  const imageSel = document.getElementById("image-config-select");
  const chatCfg = (window.GLOBAL?.configList || []).find((item) => String(item.id) === String(chatSel?.value || ""));
  const imageCfg = (window.GLOBAL?.configList || []).find((item) => String(item.id) === String(imageSel?.value || ""));
  const chatBadge = getProviderBadge(chatCfg?.model_name || "");
  const imageBadge = getProviderBadge(imageCfg?.model_name || "");
  const chatPill = document.getElementById("chat-model-pill");
  const imagePill = document.getElementById("image-model-pill");
  if (window.ensureModelBrandStyles) window.ensureModelBrandStyles();
  if (chatPill) {
    chatPill.dataset.brand = chatBadge.cls;
    chatPill.style.borderColor = chatBadge.cls === 'default' ? '#e6ebf2' : 'rgba(59,130,246,.25)';
  }
  if (imagePill) {
    imagePill.dataset.brand = imageBadge.cls;
    imagePill.style.borderColor = imageBadge.cls === 'default' ? '#e6ebf2' : 'rgba(16,185,129,.25)';
  }
  if (window.updateButtonStatus) window.updateButtonStatus();
}

function toggleSessionDrawer(force) {
  const shell = document.querySelector(".oc-chat-shell");
  if (!shell) return;
  const next = typeof force === "boolean" ? force : !shell.classList.contains("show-session-drawer");
  shell.classList.toggle("show-session-drawer", next);
}

function toggleModelPanel(force) {
  const shell = document.querySelector(".oc-chat-shell");
  if (!shell) return;
  const next = typeof force === "boolean" ? force : !shell.classList.contains("show-model-panel");
  shell.classList.toggle("show-model-panel", next);
}

function bindEvents() {
  const sendBtn = document.getElementById("send-chat-btn");
  const input = document.getElementById("chat-input");
  const clearBtn = document.getElementById("clear-chat-btn");
  const fileInput = document.getElementById("chat-file-input");
  const sessionList = document.getElementById("chat-session-list");
  const msgWrap = document.getElementById("chat-message-list");
  const newBtn = document.getElementById("chat-new-session-btn");
  const chatSelect = document.getElementById("chat-config-select");
  const sessionToggle = document.getElementById("chat-session-toggle-btn");
  const modelToggle = document.getElementById("chat-model-toggle-btn");
  const sessionBackdrop = document.getElementById("chat-session-backdrop");
  const plusBtn = document.getElementById("chat-plus-btn");
  const plusMenu = document.getElementById("chat-plus-menu");

  if (chatSelect && !chatSelect._pillBound) {
    chatSelect.addEventListener("change", () => { refreshModelPills(); renderMessages(); });
    chatSelect._pillBound = true;
  }

  if (sessionToggle && !sessionToggle._bound) {
    sessionToggle.addEventListener("click", () => toggleSessionDrawer());
    sessionToggle._bound = true;
  }
  if (modelToggle && !modelToggle._bound) {
    modelToggle.addEventListener("click", () => toggleModelPanel());
    modelToggle._bound = true;
  }
  if (sessionBackdrop && !sessionBackdrop._bound) {
    sessionBackdrop.addEventListener("click", () => toggleSessionDrawer(false));
    sessionBackdrop._bound = true;
  }

  if (sendBtn && !sendBtn._bound) {
    sendBtn.addEventListener("click", send);
    sendBtn._bound = true;
  }
  if (input && !input._bound) {
    input.addEventListener("input", autoResizeTextarea);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    input._bound = true;
  }
  if (clearBtn && !clearBtn._bound) {
    clearBtn.addEventListener("click", () => {
      if (isSessionGenerating(currentSessionId)) stopSessionGenerate(currentSessionId);
      setMsg([]);
      renderMessages();
    });
    clearBtn._bound = true;
  }
  if (fileInput && !fileInput._bound) {
    fileInput.addEventListener("change", async () => {
      await collectSmartFiles();
      fileInput.value = "";
    });
    fileInput._bound = true;
  }
  if (plusBtn && !plusBtn._bound) {
    plusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const fi = document.getElementById("chat-file-input");
      if (fi) fi.click();
    });
    plusBtn._bound = true;
  }
  if (newBtn && !newBtn._bound) {
    newBtn.addEventListener("click", newSession);
    newBtn._bound = true;
  }
  if (sessionList && !sessionList._bound) {
    sessionList.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del-session]");
      if (del) return delSession(del.getAttribute("data-del-session"), e);
      const item = e.target.closest("[data-session-id]");
      if (item) {
        switchSession(item.getAttribute("data-session-id"));
        toggleSessionDrawer(false);
      }
    });
    sessionList._bound = true;
  }
  if (msgWrap && !msgWrap._bound) {
    msgWrap.addEventListener("click", (e) => {
      const previewImage = e.target.closest("[data-chat-image-preview]");
      if (chatImageLongPressTriggered) {
        chatImageLongPressTriggered = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!previewImage && !e.target.closest("#chat-image-action-bar")) hideChatImageActionBar();
      if (previewImage) {
        const previewSrc = previewImage.querySelector("img")?.currentSrc || previewImage.getAttribute("data-chat-image-preview") || "";
        return openChatImagePreview(previewSrc);
      }
      const previewClose = e.target.closest("[data-chat-preview-close]");
      if (previewClose) return closeChatImagePreview();
      const copyCode = e.target.closest("[data-copy-code]");
      if (copyCode) return copyMsg(copyCode.getAttribute("data-copy-code") || "");
      const copyBtn = e.target.closest(".oc-copy-btn");
      if (copyBtn) {
        const row = e.target.closest(".oc-msg-row");
        const idx = Number(row?.dataset.idx || -1);
        const msgs = getRenderableMessages();
        if (msgs[idx]) copyMsg(msgs[idx].content || "");
      }
      const regenBtn = e.target.closest("[data-regen-idx]");
      if (regenBtn) {
        e.preventDefault();
        e.stopPropagation();
        regenerateFromIndex(Number(regenBtn.getAttribute("data-regen-idx")));
      }
    });
    msgWrap.addEventListener("touchstart", (e) => {
      const image = e.target.closest("[data-chat-image-save]");
      if (!image) return;
      chatImageLongPressTriggered = false;
      clearTimeout(chatImageLongPressTimer);
      chatImageLongPressTimer = setTimeout(() => {
        const saveUrl = image.getAttribute("data-chat-image-save") || image.getAttribute("data-chat-image-preview") || "";
        chatImageLongPressTriggered = true;
        showChatImageActionBar(saveUrl, image.getBoundingClientRect());
      }, 550);
    }, { passive: true });
    msgWrap.addEventListener("touchend", () => { clearTimeout(chatImageLongPressTimer); }, { passive: true });
    msgWrap.addEventListener("touchcancel", () => { clearTimeout(chatImageLongPressTimer); }, { passive: true });
    msgWrap._bound = true;
  }
  const fileList = document.getElementById("chat-file-list");
  if (fileList && !fileList._bound) {
    fileList.addEventListener("click", (e) => {
      const removeFile = e.target.closest("[data-remove-smart-file]");
      if (removeFile) {
        const idx = Number(removeFile.getAttribute("data-remove-smart-file"));
        smartFiles = smartFiles.filter((_, i) => i !== idx);
        const input = document.getElementById("chat-file-input");
        if (input) input.value = "";
        renderSmartFiles();
      }
    });
    fileList._bound = true;
  }
}

function buildChatUI() {
  const tab = document.getElementById("chat");
  if (!tab) return;
  tab.innerHTML = `
    <div class="oc-chat-shell">
      <div class="oc-session-backdrop" id="chat-session-backdrop"></div>
      <aside class="oc-sidebar">
        <div class="oc-sidebar-top">
          <div class="oc-brand-row">
            <div class="oc-brand">流绘</div>
            <button class="oc-close-drawer" id="chat-close-session-btn" type="button">✕</button>
          </div>
          <button class="oc-new-chat" id="chat-new-session-btn" type="button">+ 新建会话</button>
        </div>
        <div class="oc-session-list" id="chat-session-list"></div>
      </aside>
      <section class="oc-main">
        <div class="oc-topbar">
          <div class="oc-topbar-main">
            <div class="oc-topbar-head">
              <button class="oc-icon-toggle" id="chat-session-toggle-btn" type="button">☰ 会话</button>
              <div class="oc-title-wrap">
                <div class="oc-title" id="chat-title-main">新会话</div>
                <div class="oc-subtitle">竖屏聊天布局 · 抽屉会话 · 可折叠模型面板</div>
              </div>
              <button class="oc-icon-toggle" id="chat-model-toggle-btn" type="button">⌄ 模型</button>
            </div>
            <div class="oc-toolbar-panel">
              <div class="oc-toolbar">
                <div class="oc-field-inline model-pill compact" id="chat-model-pill">
                  <label>当前模型</label>
                  <div class="oc-model-pill-head">
                    <div class="oc-model-select-wrap"><select id="chat-config-select" class="form-select"></select></div>
                  </div>
                </div>
                <div class="oc-field-inline model-pill compact" id="image-model-pill">
                  <label>图片模型</label>
                  <div class="oc-model-pill-head">
                    <div class="oc-model-select-wrap"><select id="image-config-select" class="form-select"></select></div>
                  </div>
                </div>
                <button class="oc-toolbar-btn ghost" id="clear-chat-btn" type="button">清空</button>
              </div>
            </div>
          </div>
        </div>
        <input type="file" class="oc-hidden-file-input" id="chat-file-input" multiple accept="image/*,.txt,.md,.json,.csv,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.log,.ini,.cfg,.sql,.java,.kt,.go,.rs,.sh,.pdf,.doc,.docx">
        <div class="oc-message-wrap custom-scrollbar" id="chat-message-list"></div>
        <div class="oc-input-wrap">
          <div class="oc-input-box">
            <div class="oc-plus-wrap">
              <button class="oc-plus-btn" id="chat-plus-btn" type="button">+</button>
            </div>
            <textarea class="oc-input" id="chat-input" rows="1" placeholder="输入你的问题。Enter 发送，Shift + Enter 换行"></textarea>
            <button class="oc-send-btn" id="send-chat-btn" type="button">发送</button>
          </div>
          <div class="oc-file-list" id="chat-file-list" style="display:none;"></div>
        </div>
      </section>
    </div>
  `;

  const closeBtn = document.getElementById("chat-close-session-btn");
  if (closeBtn && !closeBtn._bound) {
    closeBtn.addEventListener("click", () => toggleSessionDrawer(false));
    closeBtn._bound = true;
  }
}

function injectStyles() {
  if (document.getElementById("oc-chat-rebuild-style")) return;
  const style = document.createElement("style");
  style.id = "oc-chat-rebuild-style";
  style.innerHTML = `
    #chat { height: calc(100vh - 64px); }
    .oc-chat-shell { position:relative; display:flex; height:100%; background:#f5f7fb; color:#0f172a; overflow:hidden; }
    .oc-session-backdrop{position:absolute;inset:0;background:rgba(15,23,42,.36);opacity:0;pointer-events:none;transition:.22s;z-index:20}
    .oc-chat-shell.show-session-drawer .oc-session-backdrop{opacity:1;pointer-events:auto}
    .oc-sidebar { position:absolute; inset:0 auto 0 0; width:min(60vw,320px); background:#ffffff; border-right:1px solid #e6ebf2; display:flex; flex-direction:column; z-index:30; transform:translateX(-100%); transition:transform .24s ease; box-shadow:0 24px 60px rgba(15,23,42,.18); }
    .oc-chat-shell.show-session-drawer .oc-sidebar{transform:translateX(0)}
    .oc-sidebar-top { padding:18px 14px 12px; border-bottom:1px solid #eef2f7; }
    .oc-brand-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    .oc-brand { font-size:18px; font-weight:800; color:#0f172a; }
    .oc-close-drawer,.oc-icon-toggle{border:none;background:#eef2f7;color:#0f172a;border-radius:10px;padding:7px 9px;cursor:pointer;font-weight:700;font-size:11px}
    .oc-new-chat { width:100%; border:none; background:#111827; color:#fff; border-radius:14px; padding:12px 14px; cursor:pointer; font-weight:700; }
    .oc-session-list { flex:1; overflow:auto; padding:12px; }
    .oc-session-item { width:100%; border:1px solid #e7edf4; background:#fff; border-radius:14px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; cursor:pointer; text-align:left; }
    .oc-session-item.active { border-color:#cfe0ff; background:#eef4ff; }
    .oc-session-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:600; color:#0f172a; }
    .oc-session-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .oc-session-del { flex:0 0 auto; border:none; background:transparent; color:#94a3b8; font-size:18px; line-height:1; padding:0; width:18px; height:18px; display:flex; align-items:center; justify-content:center; }
    .oc-main { flex:1; min-width:0; display:flex; flex-direction:column; width:100%; min-height:0; height:100%; overflow:hidden; }
    .oc-topbar { padding:4px 8px 4px; border-bottom:1px solid #eef2f7; background:rgba(255,255,255,.97); }
    .oc-topbar-main{width:100%;max-width:920px;margin:0 auto}
    .oc-topbar-head { display:flex; align-items:center; gap:4px; min-height:26px; }
    .oc-title-wrap{flex:1;min-width:0}
    .oc-title { font-size:11px; font-weight:700; color:#0f172a; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .oc-subtitle { display:none; }
    .oc-toolbar-panel{display:none;padding-top:4px}
    .oc-chat-shell.show-model-panel .oc-toolbar-panel{display:block}
    .oc-toolbar { display:flex; flex-direction:column; align-items:stretch; gap:4px; }
    .oc-field-inline { min-width:0; display:flex; flex-direction:column; }
    .oc-field-inline label { display:block; font-size:9px; color:#64748b; margin-bottom:3px; font-weight:600; }
    .oc-field-inline .form-select,.oc-field-inline .form-input{height:30px;border-radius:9px;font-size:10px;padding:0 8px}
    .oc-field-inline.model-pill{padding:5px 7px;border:1px solid #e6ebf2;border-radius:10px;background:linear-gradient(180deg,rgba(255,255,255,.96),rgba(248,250,252,.92));box-shadow:0 6px 14px rgba(15,23,42,.04)}
    .oc-model-pill-head{display:flex;align-items:center;gap:10px}
    .oc-model-select-wrap{flex:1;min-width:140px}
    .oc-model-select-wrap .form-select{height:28px}
    .oc-toolbar-btn{height:28px;border:none;border-radius:9px;padding:0 8px;font-size:10px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
    .oc-toolbar-btn.ghost{background:#f8fafc;color:#475569;border:1px solid #e2e8f0}
    .oc-toolbar-btn.ghost:hover{background:#eef2f7;color:#0f172a}
    .oc-hidden-file-input { display:none; }
    .oc-file-list { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .oc-file-chip { display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border-radius:999px; border:1px solid #d6e4ff; background:#edf4ff; color:#1d4ed8; font-size:12px; font-weight:700; }
    .oc-file-chip button { border:none; background:transparent; color:#1d4ed8; cursor:pointer; font-size:14px; }
    .oc-message-wrap { flex:1 1 auto; overflow:auto; min-height:0; padding:6px 0 132px; }
    .oc-empty { max-width:640px; margin:92px auto 0; text-align:center; color:#64748b; padding:0 20px; }
    .oc-empty-title { font-size:24px; font-weight:800; color:#111827; margin-bottom:10px; }
    .oc-empty-desc { font-size:14px; line-height:1.8; }
    .oc-msg-row { width:calc(100% - 10px); max-width:920px; margin:0 auto 8px; display:flex; gap:6px; align-items:flex-start; }
    .oc-msg-row.user { flex-direction:row-reverse; }
    .oc-avatar { width:22px; height:22px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:9px; font-weight:800; flex-shrink:0; }
    .oc-msg-row.user .oc-avatar { background:#dbeafe; color:#1d4ed8; }
    .oc-msg-row.assistant .oc-avatar { background:#111827; color:#fff; width:22px; height:22px; font-size:9px; }
    .oc-bubble { max-width:calc(100% - 28px); border-radius:12px; padding:5px 7px; box-shadow:0 4px 12px rgba(15,23,42,.05); overflow:hidden; }
    .oc-bubble.user { background:linear-gradient(135deg,#1677ff,#3b82f6); color:#fff; border-bottom-right-radius:8px; }
    .oc-bubble.assistant { background:#fff; color:#0f172a; border:1px solid #e7edf4; border-bottom-left-radius:8px; }
    .oc-markdown { line-height:1.2; font-size:11px; word-break:break-word; }
    .oc-markdown p { margin:0 0 4px; }
    .oc-markdown p:last-child { margin-bottom:0; }
    .oc-markdown ul, .oc-markdown ol { margin:6px 0 6px 18px; }
    .oc-markdown code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; padding:2px 6px; border-radius:8px; background:rgba(15,23,42,.08); }
    .oc-bubble.user .oc-markdown code { background:rgba(255,255,255,.16); }
    .oc-markdown pre { background:#0b1220; color:#e5e7eb; border-radius:14px; padding:12px; overflow:auto; margin:10px 0; }
    .oc-markdown pre code { background:transparent; padding:0; color:inherit; }
    .oc-code-wrap { border-radius:14px; overflow:hidden; margin:10px 0; border:1px solid #132238; }
    .oc-code-head { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#0a0f1a; color:#94a3b8; font-size:12px; }
    .oc-copy-code { border:none; border-radius:8px; padding:4px 8px; cursor:pointer; background:#1f2a44; color:#fff; }
    .oc-streaming-tip { color:#64748b; display:block; margin-top:6px; font-size:10px; }
    .oc-dim { opacity:.6; }
    .oc-image-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin-top:12px; }
    .oc-image-card { display:block; overflow:hidden; border-radius:14px; border:1px solid #e5e7eb; background:#fff; padding:0; appearance:none; -webkit-appearance:none; position:relative; }
    .oc-image-action-bar.hidden { display:none; }
    .oc-image-action-bar { position:fixed; z-index:100000; display:flex; gap:8px; padding:8px; border-radius:14px; background:rgba(15,23,42,.94); border:1px solid rgba(148,163,184,.2); box-shadow:0 18px 44px rgba(2,6,23,.34); backdrop-filter:blur(10px); }
    .oc-image-action-btn { border:none; border-radius:10px; background:linear-gradient(180deg,#2563eb,#1d4ed8); color:#fff; display:inline-flex; align-items:center; gap:6px; padding:10px 12px; font-size:12px; font-weight:700; }
    .oc-image-action-btn.ghost { background:rgba(255,255,255,.08); color:#e2e8f0; }
    .oc-image-preview-modal.hidden { display:none; }
    .oc-image-preview-modal { position:fixed; inset:0; z-index:99999; background:rgba(2,6,23,.82); }
    .oc-image-preview-dialog { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; overflow:hidden; touch-action:none; }
    .oc-image-preview-dialog img { max-width:92vw; max-height:92vh; border-radius:16px; background:#111827; object-fit:contain; transform-origin:center center; transition:transform .15s ease; will-change:transform; user-select:none; -webkit-user-drag:none; }
    .oc-image-card img { display:block; width:100%; height:auto; object-fit:cover; }
    .oc-image-card-inline { width:min(132px,44vw); }
    .oc-image-card-inline img { aspect-ratio:1 / 1; height:auto; max-height:132px; object-fit:cover; }
    .oc-plus-wrap { position:relative; flex:0 0 auto; }
    .oc-plus-btn { width:30px; height:30px; border:none; border-radius:9px; background:#eef2f7; color:#0f172a; font-size:18px; line-height:1; cursor:pointer; }
    .oc-plus-menu { position:absolute; left:0; bottom:36px; min-width:120px; background:#fff; border:1px solid #dbe2ea; border-radius:10px; box-shadow:0 14px 32px rgba(15,23,42,.14); padding:5px; display:grid; gap:4px; }
    .oc-plus-menu.hidden { display:none; }
    .oc-plus-menu button { border:none; background:#fff; color:#0f172a; text-align:left; border-radius:8px; padding:7px 8px; font-size:10px; cursor:pointer; }
    .oc-plus-menu button:hover { background:#f8fafc; }
    .oc-file-list { display:flex; flex-wrap:wrap; gap:6px; width:100%; max-width:920px; margin:6px auto 0; }
    .oc-file-chip { display:inline-flex; align-items:center; gap:6px; padding:6px 8px; border-radius:999px; border:1px solid #d6e4ff; background:#edf4ff; color:#1d4ed8; font-size:11px; font-weight:700; max-width:100%; }
    .oc-file-chip button { border:none; background:transparent; color:#1d4ed8; cursor:pointer; font-size:13px; }
    .oc-file-chip.static { cursor:default; }
    .oc-file-preview-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .oc-input-wrap { flex:0 0 auto; position:absolute; left:0; right:0; bottom:0; z-index:15; padding:6px 8px calc(18px + env(safe-area-inset-bottom)); border-top:1px solid #e6ebf2; background:rgba(255,255,255,.995); }
    .oc-input-box { width:100%; max-width:920px; margin:0 auto; display:flex; align-items:flex-end; gap:5px; background:#fff; border:1px solid #dbe2ea; border-radius:12px; padding:6px; box-shadow:0 6px 16px rgba(15,23,42,.05); min-height:46px; overflow:visible; }
    .oc-input { flex:1; min-height:32px; max-height:120px; resize:none; border:none; outline:none; background:transparent; color:#0f172a; font-size:12px; line-height:1.24; padding:6px 0; font-family:inherit; pointer-events:auto; }
    .oc-send-btn { height:30px; border:none; border-radius:9px; padding:0 10px; background:#111827; color:#fff; font-size:10px; font-weight:700; cursor:pointer; flex:0 0 auto; }
    .oc-send-btn.is-stop { background:#ef4444; }
    .oc-regen-wrap { display:none; margin-left:28px; margin-top:-4px; }
    .oc-regen-wrap.oc-regen-last { display:block; }
    .oc-regen-btn { border:none; background:transparent; color:#94a3b8; cursor:pointer; padding:4px 6px; border-radius:8px; display:inline-flex; align-items:center; gap:4px; font-size:12px; transition:color .15s,background .15s; }
    .oc-regen-btn:active { color:#3b82f6; background:rgba(59,130,246,.08); transform:scale(.92); }
    @media (min-width: 901px) {
      .oc-sidebar{width:300px}
      .oc-msg-row{width:min(920px,calc(100% - 32px))}
      .oc-bubble{max-width:min(78%,760px)}
      .oc-toolbar{flex-direction:row;flex-wrap:wrap;align-items:flex-end}
      .oc-field-inline{min-width:220px;flex:1}
      .oc-image-grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
    }
  `;
  document.head.appendChild(style);
}

function initChatModule() {
  injectStyles();
  if (window.ensureModelBrandStyles) window.ensureModelBrandStyles();
  buildChatUI();
  initSessions();
  bindEvents();
  renderSessionList();
  renderMessages();
  refreshModelPills();
  updateHeaderTitle();
  
  // 初始化 Markdown Worker
  initMarkdownWorker();
  updateSendBtnState();
  autoResizeTextarea();
  if (window.updateConfigSelectOptions) window.updateConfigSelectOptions();
  
  // 通知主模块聊天界面已就绪
  if (window.__chatModuleReady) window.__chatModuleReady();
}

window.newSession = newSession;
window.switchSession = switchSession;
window.delSession = delSession;
window.copyMsg = copyMsg;
window.renderChatMessages = renderMessages;

document.addEventListener("DOMContentLoaded", async () => {
  try { await loadDeps(); } catch {}
  initChatModule();
});
