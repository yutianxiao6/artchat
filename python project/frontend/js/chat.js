const CHAT_STORAGE_KEY = "my_ai_chat_sessions_v2";
let currentSessionId = null;
let currentController = null;
let isGenerating = false;
let smartFiles = [];

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
  const name = String(modelName || "").toLowerCase();
  if (name.includes("gpt") || name.includes("o3") || name.includes("dall")) return { label: "OA", cls: "openai" };
  if (name.includes("claude")) return { label: "CL", cls: "claude" };
  if (name.includes("gemini") || name.includes("imagen")) return { label: "GM", cls: "gemini" };
  if (name.includes("deepseek")) return { label: "DS", cls: "deepseek" };
  if (name.includes("qwen")) return { label: "QW", cls: "qwen" };
  if (name.includes("glm")) return { label: "GL", cls: "glm" };
  if (name.includes("flux")) return { label: "FX", cls: "flux" };
  if (name.includes("sdxl") || name.includes("stable")) return { label: "SD", cls: "sd" };
  return { label: "AI", cls: "default" };
}

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
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    toast("已复制");
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

function getSessions() {
  return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || "{}");
}

function setSessions(sessions) {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sessions));
}

function getCurrentSession() {
  const sessions = getSessions();
  return sessions[currentSessionId] || null;
}

function getMsg() {
  return getCurrentSession()?.messages || [];
}

function setMsg(msgs) {
  const sessions = getSessions();
  const session = sessions[currentSessionId];
  if (!session) return;
  session.messages = msgs;
  const firstUser = msgs.find((m) => m.role === "user" && (m.content || "").trim());
  if (firstUser) session.title = firstUser.content.trim().replace(/\n/g, " ").slice(0, 24) || "新会话";
  setSessions(sessions);
  renderSessionList();
  updateHeaderTitle();
}

function newSession() {
  if (isGenerating) stopGenerate();
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
  if (isGenerating) {
    const ok = confirm("当前正在生成回答，切换会话会停止当前生成，是否继续？");
    if (!ok) return;
    stopGenerate();
  }
  currentSessionId = id;
  renderSessionList();
  renderMessages();
  updateHeaderTitle();
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

function updateSendBtnState() {
  const btn = document.getElementById("send-chat-btn");
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = isGenerating ? "停止" : "发送";
  btn.classList.toggle("is-stop", isGenerating);
}

function autoResizeTextarea() {
  const ipt = document.getElementById("chat-input");
  if (!ipt) return;
  ipt.style.height = "auto";
  ipt.style.height = Math.min(ipt.scrollHeight, 180) + "px";
}

async function readSmartFile(file) {
  const textTypes = ["text/", "application/json", "application/javascript", "application/xml"];
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const canReadAsText = textTypes.some((prefix) => file.type.startsWith(prefix) || file.type === prefix) || /\.(txt|md|json|csv|py|js|ts|html|css|xml|yaml|yml|log|ini|cfg)$/i.test(file.name);
  if (canReadAsText) {
    const text = await file.text();
    return { filename: file.name, content_type: file.type || "text/plain", text_content: text.slice(0, 20000), size: file.size };
  }
  if (ext === "pdf") {
    return { filename: file.name, content_type: file.type || "application/pdf", text_content: `[PDF 文件已上传：${file.name}。当前版本暂未解析 PDF 正文，请结合文件名和问题回答。]`, size: file.size };
  }
  if (ext === "doc" || ext === "docx") {
    return { filename: file.name, content_type: file.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text_content: `[Word 文件已上传：${file.name}。当前版本暂未解析 DOC/DOCX 正文，请结合文件名和问题回答。]`, size: file.size };
  }
  return { filename: file.name, content_type: file.type || "application/octet-stream", text_content: `[暂不支持直接解析该文件类型，仅记录文件名：${file.name}]`, size: file.size };
}

async function collectSmartFiles() {
  const fileInput = document.getElementById("chat-file-input");
  const files = Array.from(fileInput?.files || []);
  smartFiles = [];
  for (const file of files) {
    smartFiles.push(await readSmartFile(file));
  }
  renderSmartFiles();
  return smartFiles;
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
    <div class="oc-file-chip">
      <span>${escapeHtml(file.filename)}</span>
      <button type="button" data-remove-smart-file="${index}">×</button>
    </div>
  `).join("");
}

function renderSessionList() {
  const list = document.getElementById("chat-session-list");
  if (!list) return;
  const sessions = Object.values(getSessions()).sort((a, b) => (b.id > a.id ? 1 : -1));
  list.innerHTML = sessions.map((item) => {
    const active = item.id === currentSessionId;
    return `
      <button class="oc-session-item ${active ? "active" : ""}" data-session-id="${item.id}" type="button">
        <span class="oc-session-text">${escapeHtml(item.title || "新会话")}</span>
        <span class="oc-session-del" data-delete-session="${item.id}">×</span>
      </button>
    `;
  }).join("");
}

function renderMessageItem(m, index) {
  const isUser = m.role === "user";
  const html = fmt(m.content || "");
  const images = Array.isArray(m.images) && m.images.length ? `
    <div class="oc-image-grid">
      ${m.images.map((img, i) => `<a class="oc-image-card" href="${escapeHtml(img.url)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(img.url)}" alt="image-${i + 1}"></a>`).join("")}
    </div>
  ` : "";
  const selectedChatId = document.getElementById("chat-config-select")?.value || "";
  const cfg = (window.GLOBAL?.configList || []).find((item) => String(item.id) === String(selectedChatId));
  const badge = isUser ? { label: "我", cls: "user" } : getProviderBadge(cfg?.model_name || "");
  return `
    <div class="oc-msg-row ${isUser ? "user" : "assistant"}" data-idx="${index}" data-role="${m.role}" data-streaming="${m.streaming ? "1" : "0"}">
      <div class="oc-avatar ${isUser ? "" : `provider-${badge.cls}`} ">${badge.label}</div>
      <div class="oc-bubble ${isUser ? "user" : "assistant"}">
        <div class="oc-markdown">${html || (!isUser ? '<span class="oc-dim">...</span>' : "")}</div>
        ${images}
        <div class="oc-bubble-footer">
          <span class="oc-streaming-tip">${!isUser && m.streaming ? '正在生成...' : ''}</span>
          <button class="oc-copy-btn" type="button">复制</button>
        </div>
      </div>
    </div>
  `;
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
      </div>
    `;
    return;
  }
  wrap.innerHTML = msgs.map((m, i) => renderMessageItem(m, i)).join("");
  enhanceAllMessages(wrap);
  wrap.scrollTop = wrap.scrollHeight;
}

function patchStreamingBubble(fullText, streaming = true) {
  const wrap = document.getElementById("chat-message-list");
  if (!wrap) return;
  const rows = [...wrap.querySelectorAll('.oc-msg-row[data-role="assistant"]')];
  const row = [...rows].reverse().find((node) => node.getAttribute("data-streaming") === "1") || rows[rows.length - 1];
  if (!row) return;
  const md = row.querySelector(".oc-markdown");
  const tip = row.querySelector(".oc-streaming-tip");
  if (md) md.innerHTML = fmt(fullText);
  if (tip) tip.textContent = streaming ? "正在生成..." : "";
  row.setAttribute("data-streaming", streaming ? "1" : "0");
  enhanceAllMessages(row);
  wrap.scrollTop = wrap.scrollHeight;
}

function patchLastAssistantMessage(text, streaming = true) {
  const sessions = getSessions();
  const session = sessions[currentSessionId];
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
  patchStreamingBubble(text, streaming);
}

function finishLastAssistantMessage(text, extra = {}) {
  const msgs = [...getMsg()];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant" && msgs[i].streaming) {
      msgs[i].content = text;
      msgs[i].streaming = false;
      if (extra.images) msgs[i].images = extra.images;
      break;
    }
  }
  setMsg(msgs);
  renderMessages();
}

function stopGenerate() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  isGenerating = false;
  updateSendBtnState();
  const msgs = [...getMsg()];
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    last.streaming = false;
    if (!last.content) last.content = "已停止生成";
    setMsg(msgs);
    renderMessages();
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

async function send() {
  if (isGenerating) {
    stopGenerate();
    return;
  }
  const ipt = document.getElementById("chat-input");
  const chatSel = document.getElementById("chat-config-select");
  const imageSel = document.getElementById("image-config-select");
  const tempInput = document.getElementById("temperature");
  const text = ipt?.value.trim();
  if (!ipt || !chatSel) return;
  if (!text) return toast("请输入内容");
  if (!chatSel.value) return toast("请选择聊天配置");

  await collectSmartFiles();

  const prevMsgs = getMsg();
  const isImageIntent = /(生成|画|绘制|做一张|来一张|图片|海报|插画|头像|壁纸|配图)/.test(text);
  const placeholder = isImageIntent ? "正在识别任务并生成图片，请稍等..." : "";
  const nextMsgs = [...prevMsgs, { role: "user", content: text }, { role: "assistant", content: placeholder, streaming: true }];
  setMsg(nextMsgs);
  ipt.value = "";
  autoResizeTextarea();
  renderMessages();

  isGenerating = true;
  updateSendBtnState();
  currentController = new AbortController();

  try {
    const payloadMessages = prevMsgs
      .filter((m) => m.role && typeof m.content === "string")
      .map(({ role, content }) => ({ role, content: content.trim() }))
      .filter((m) => m.content);

    const res = await fetch("/api/chat/smart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        messages: payloadMessages,
        chat_config_id: chatSel.value,
        image_config_id: imageSel?.value || null,
        temperature: Number(tempInput?.value || 0.7),
        stream: true,
        files: smartFiles
      }),
      signal: currentController.signal
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
          finishLastAssistantMessage(result?.message || "图片接口返回成功，但没有解析到可显示图片。");
        } else {
          finishLastAssistantMessage(`我已经判断这是图片生成任务，并直接帮你生成好了。\n\n提示词：${result?.data?.prompt || text}\n尺寸：${result?.data?.image_size || "1024x1024"}\n数量：${result?.data?.image_count || imageCount || 1}\n\n共返回 ${imageCount} 张图片。`, { images: result?.data?.images || [] });
        }
      } else {
        const textResult = result?.data?.choices?.[0]?.message?.content || result?.message || "处理完成";
        finishLastAssistantMessage(textResult);
      }
    } else {
      const finalText = res.body ? await readStreamResponse(res, (fullText) => patchLastAssistantMessage(fullText, true)) : "";
      finishLastAssistantMessage(finalText || "无返回内容");
    }

    smartFiles = [];
    const fileInput = document.getElementById("chat-file-input");
    if (fileInput) fileInput.value = "";
    renderSmartFiles();
  } catch (e) {
    if (e.name !== "AbortError") {
      finishLastAssistantMessage(`请求出错：${e.message}`);
      toast(`错误：${e.message}`);
    } else {
      finishLastAssistantMessage("已停止生成");
    }
  } finally {
    isGenerating = false;
    currentController = null;
    updateSendBtnState();
  }
}

function enhanceAllMessages(container) {
  if (!container) return;
  try {
    if (window.hljs) {
      container.querySelectorAll("pre code").forEach((block) => window.hljs.highlightElement(block));
    }
  } catch {}
  enhanceCodeBlocks(container);
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

function bindEvents() {
  const sendBtn = document.getElementById("send-chat-btn");
  const input = document.getElementById("chat-input");
  const clearBtn = document.getElementById("clear-chat-btn");
  const fileInput = document.getElementById("chat-file-input");
  const sessionList = document.getElementById("chat-session-list");
  const msgWrap = document.getElementById("chat-message-list");
  const newBtn = document.getElementById("chat-new-session-btn");

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
      if (isGenerating) stopGenerate();
      setMsg([]);
      renderMessages();
    });
    clearBtn._bound = true;
  }
  if (fileInput && !fileInput._bound) {
    fileInput.addEventListener("change", () => collectSmartFiles());
    fileInput._bound = true;
  }
  if (newBtn && !newBtn._bound) {
    newBtn.addEventListener("click", newSession);
    newBtn._bound = true;
  }
  if (sessionList && !sessionList._bound) {
    sessionList.addEventListener("click", (e) => {
      const del = e.target.closest("[data-delete-session]");
      if (del) return delSession(del.getAttribute("data-delete-session"), e);
      const item = e.target.closest("[data-session-id]");
      if (item) switchSession(item.getAttribute("data-session-id"));
    });
    sessionList._bound = true;
  }
  if (msgWrap && !msgWrap._bound) {
    msgWrap.addEventListener("click", (e) => {
      const copyCode = e.target.closest("[data-copy-code]");
      if (copyCode) return copyMsg(copyCode.getAttribute("data-copy-code") || "");
      const copyBtn = e.target.closest(".oc-copy-btn");
      if (copyBtn) {
        const row = e.target.closest(".oc-msg-row");
        const idx = Number(row?.dataset.idx || -1);
        const msgs = getRenderableMessages();
        if (msgs[idx]) copyMsg(msgs[idx].content || "");
      }
      const removeFile = e.target.closest("[data-remove-smart-file]");
      if (removeFile) {
        const idx = Number(removeFile.getAttribute("data-remove-smart-file"));
        smartFiles = smartFiles.filter((_, i) => i !== idx);
        const input = document.getElementById("chat-file-input");
        if (input) input.value = "";
        renderSmartFiles();
      }
    });
    msgWrap._bound = true;
  }
}

function buildChatUI() {
  const tab = document.getElementById("chat");
  if (!tab) return;
  tab.innerHTML = `
    <div class="oc-chat-shell">
      <aside class="oc-sidebar">
        <div class="oc-sidebar-top">
          <div class="oc-brand">AI Chat</div>
          <button class="oc-new-chat" id="chat-new-session-btn" type="button">+ 新建会话</button>
        </div>
        <div class="oc-session-list" id="chat-session-list"></div>
      </aside>
      <section class="oc-main">
        <div class="oc-topbar">
          <div>
            <div class="oc-title" id="chat-title-main">新会话</div>
            <div class="oc-subtitle">主流 AI 聊天布局 · 稳定多轮对话 · 支持图片与文件任务</div>
          </div>
          <div class="oc-toolbar">
            <div class="oc-field-inline">
              <label>聊天模型</label>
              <select id="chat-config-select" class="form-select"></select>
            </div>
            <div class="oc-field-inline small">
              <label>温度</label>
              <input type="number" class="form-input" id="temperature" min="0" max="2" step="0.1" value="0.7">
            </div>
            <button class="btn btn-danger" id="clear-chat-btn" type="button">清空对话</button>
          </div>
        </div>
        <div class="oc-filebar">
          <input type="file" class="form-input" id="chat-file-input" multiple accept=".txt,.md,.json,.csv,.py,.js,.ts,.html,.css,.xml,.yaml,.yml,.log,.ini,.cfg,.pdf,.doc,.docx">
          <div class="oc-file-list" id="chat-file-list" style="display:none;"></div>
        </div>
        <div class="oc-message-wrap custom-scrollbar" id="chat-message-list"></div>
        <div class="oc-input-wrap">
          <div class="oc-input-box">
            <textarea class="oc-input" id="chat-input" rows="1" placeholder="输入你的问题。Enter 发送，Shift + Enter 换行"></textarea>
            <button class="oc-send-btn" id="send-chat-btn" type="button">发送</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function injectStyles() {
  if (document.getElementById("oc-chat-rebuild-style")) return;
  const style = document.createElement("style");
  style.id = "oc-chat-rebuild-style";
  style.innerHTML = `
    #chat { height: calc(100vh - 64px); }
    .oc-chat-shell { display:flex; height:100%; background:#f5f7fb; color:#0f172a; }
    .oc-sidebar { width:280px; background:#ffffff; border-right:1px solid #e6ebf2; display:flex; flex-direction:column; }
    .oc-sidebar-top { padding:20px 16px 14px; border-bottom:1px solid #eef2f7; }
    .oc-brand { font-size:18px; font-weight:800; color:#0f172a; margin-bottom:12px; }
    .oc-new-chat { width:100%; border:none; background:#111827; color:#fff; border-radius:14px; padding:12px 14px; cursor:pointer; font-weight:700; }
    .oc-session-list { flex:1; overflow:auto; padding:12px; }
    .oc-session-item { width:100%; border:1px solid #e7edf4; background:#fff; border-radius:14px; padding:12px; display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; cursor:pointer; text-align:left; }
    .oc-session-item.active { border-color:#cfe0ff; background:#eef4ff; }
    .oc-session-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:600; color:#0f172a; }
    .oc-session-del { color:#94a3b8; font-size:18px; line-height:1; }
    .oc-main { flex:1; min-width:0; display:flex; flex-direction:column; }
    .oc-topbar { padding:18px 22px; border-bottom:1px solid #e6ebf2; background:rgba(255,255,255,.92); display:flex; align-items:flex-end; justify-content:space-between; gap:16px; }
    .oc-title { font-size:18px; font-weight:800; color:#0f172a; }
    .oc-subtitle { font-size:12px; color:#64748b; margin-top:4px; }
    .oc-toolbar { display:flex; align-items:flex-end; gap:12px; flex-wrap:wrap; }
    .oc-field-inline { min-width:220px; }
    .oc-field-inline.small { min-width:110px; }
    .oc-field-inline label { display:block; font-size:12px; color:#64748b; margin-bottom:6px; font-weight:600; }
    .oc-filebar { padding:12px 22px 0; background:transparent; }
    .oc-file-list { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
    .oc-file-chip { display:inline-flex; align-items:center; gap:8px; padding:7px 10px; border-radius:999px; border:1px solid #d6e4ff; background:#edf4ff; color:#1d4ed8; font-size:12px; font-weight:700; }
    .oc-file-chip button { border:none; background:transparent; color:#1d4ed8; cursor:pointer; font-size:14px; }
    .oc-message-wrap { flex:1; overflow:auto; padding:24px 0; }
    .oc-empty { max-width:640px; margin:120px auto 0; text-align:center; color:#64748b; padding:0 20px; }
    .oc-empty-title { font-size:28px; font-weight:800; color:#111827; margin-bottom:10px; }
    .oc-empty-desc { font-size:14px; line-height:1.8; }
    .oc-msg-row { width:min(920px, calc(100% - 32px)); margin:0 auto 18px; display:flex; gap:12px; align-items:flex-start; }
    .oc-msg-row.user { flex-direction:row-reverse; }
    .oc-avatar { width:34px; height:34px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:800; flex-shrink:0; }
    .oc-msg-row.user .oc-avatar { background:#dbeafe; color:#1d4ed8; }
    .oc-msg-row.assistant .oc-avatar { background:#111827; color:#fff; }
    .oc-avatar.provider-openai{background:linear-gradient(135deg,#10b981,#065f46);color:#fff}.oc-avatar.provider-claude{background:linear-gradient(135deg,#fb923c,#9a3412);color:#fff}.oc-avatar.provider-gemini{background:linear-gradient(135deg,#60a5fa,#4f46e5);color:#fff}.oc-avatar.provider-deepseek{background:linear-gradient(135deg,#38bdf8,#0f766e);color:#fff}.oc-avatar.provider-qwen{background:linear-gradient(135deg,#a78bfa,#6d28d9);color:#fff}.oc-avatar.provider-glm{background:linear-gradient(135deg,#f472b6,#be185d);color:#fff}.oc-avatar.provider-flux,.oc-avatar.provider-sd{background:linear-gradient(135deg,#f59e0b,#b45309);color:#fff}.oc-avatar.provider-default{background:#111827;color:#fff}
    .oc-bubble { max-width:min(78%, 760px); border-radius:20px; padding:14px 16px; box-shadow:0 6px 20px rgba(15,23,42,.06); overflow:hidden; }
    .oc-bubble.user { background:linear-gradient(135deg,#1677ff,#3b82f6); color:#fff; border-bottom-right-radius:8px; }
    .oc-bubble.assistant { background:#fff; color:#0f172a; border:1px solid #e7edf4; border-bottom-left-radius:8px; }
    .oc-markdown { line-height:1.8; font-size:14px; word-break:break-word; }
    .oc-markdown p { margin:0 0 10px; }
    .oc-markdown p:last-child { margin-bottom:0; }
    .oc-markdown ul, .oc-markdown ol { margin:8px 0 8px 20px; }
    .oc-markdown code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; padding:2px 6px; border-radius:8px; background:rgba(15,23,42,.08); }
    .oc-bubble.user .oc-markdown code { background:rgba(255,255,255,.16); }
    .oc-markdown pre { background:#0b1220; color:#e5e7eb; border-radius:14px; padding:12px; overflow:auto; margin:10px 0; }
    .oc-markdown pre code { background:transparent; padding:0; color:inherit; }
    .oc-code-wrap { border-radius:14px; overflow:hidden; margin:10px 0; border:1px solid #132238; }
    .oc-code-head { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#0a0f1a; color:#94a3b8; font-size:12px; }
    .oc-copy-code { border:none; border-radius:8px; padding:4px 8px; cursor:pointer; background:#1f2a44; color:#fff; }
    .oc-bubble-footer { display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:12px; font-size:12px; }
    .oc-streaming-tip { color:#64748b; }
    .oc-copy-btn { border:none; background:#f1f5f9; color:#475569; border-radius:10px; padding:6px 10px; cursor:pointer; }
    .oc-bubble.user .oc-copy-btn { background:rgba(255,255,255,.16); color:#fff; }
    .oc-dim { opacity:.6; }
    .oc-image-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:12px; }
    .oc-image-card { display:block; overflow:hidden; border-radius:14px; border:1px solid #e5e7eb; background:#fff; }
    .oc-image-card img { display:block; width:100%; height:auto; object-fit:cover; }
    .oc-input-wrap { padding:16px 22px 22px; border-top:1px solid #e6ebf2; background:rgba(255,255,255,.92); }
    .oc-input-box { width:min(920px, 100%); margin:0 auto; display:flex; align-items:flex-end; gap:12px; background:#fff; border:1px solid #dbe2ea; border-radius:18px; padding:12px; box-shadow:0 8px 24px rgba(15,23,42,.05); }
    .oc-input { flex:1; min-height:24px; max-height:180px; resize:none; border:none; outline:none; background:transparent; color:#0f172a; font-size:14px; line-height:1.8; padding:4px 2px; font-family:inherit; }
    .oc-send-btn { height:44px; border:none; border-radius:12px; padding:0 18px; background:#111827; color:#fff; font-size:14px; font-weight:700; cursor:pointer; }
    .oc-send-btn.is-stop { background:#ef4444; }
    @media (max-width: 900px) {
      .oc-sidebar { display:none; }
      .oc-topbar { flex-direction:column; align-items:stretch; }
      .oc-toolbar { width:100%; }
      .oc-field-inline { min-width:unset; flex:1; }
      .oc-bubble { max-width:100%; }
      .oc-msg-row { width:calc(100% - 20px); }
      .oc-input-box { width:100%; }
    }
  `;
  document.head.appendChild(style);
}

function initChatModule() {
  injectStyles();
  buildChatUI();
  initSessions();
  bindEvents();
  renderSessionList();
  renderMessages();
  updateHeaderTitle();
  updateSendBtnState();
  autoResizeTextarea();
  if (window.updateConfigSelectOptions) window.updateConfigSelectOptions();
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
