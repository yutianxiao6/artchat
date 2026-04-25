const CHAT_STORAGE_KEY = "my_ai_chat_sessions";
let currentSessionId = null;
let currentController = null;
let isGenerating = false;
let smartFiles = [];

/* =========================
 * 依赖注入（marked + highlight.js）
 * ========================= */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
async function loadDeps() {
  // marked
  try {
    if (!window.marked) {
      await loadScript("https://cdn.jsdelivr.net/npm/marked/marked.min.js");
    }
  } catch {}

  // highlight.js（修复：不要加载 lib/common.min.js，它会 require()）
  try {
    await loadCss("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css");
    if (!window.hljs) {
      await loadScript("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/highlight.min.js");
    }
  } catch {}
}


/* =========================
 * 会话存储（逻辑无修改，保留）
 * ========================= */
function initSessions() {
  let sessions = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)) || {};
  if (Object.keys(sessions).length === 0) {
    const id = "s_" + Date.now();
    sessions[id] = { id, title: "新会话", messages: [] };
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sessions));
  }
  currentSessionId = Object.keys(sessions)[0];
}

function getSessions() {
  return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)) || {};
}

function setSessions(sessions) {
  localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sessions));
}

function newSession() {
  const sessions = getSessions();
  const id = "s_" + Date.now();
  sessions[id] = { id, title: "新会话", messages: [] };
  currentSessionId = id;
  setSessions(sessions);
  renderList();
  renderMsg();
  updateHeaderTitle();
}

function delSession(id, e) {
  e?.stopPropagation();
  if (!confirm("确定删除这个会话吗？")) return;

  const sessions = getSessions();
  delete sessions[id];

  const ids = Object.keys(sessions);
  if (ids.length === 0) {
    const newId = "s_" + Date.now();
    sessions[newId] = { id: newId, title: "新会话", messages: [] };
    currentSessionId = newId;
  } else {
    currentSessionId = ids[0];
  }

  setSessions(sessions);
  renderList();
  renderMsg();
  updateHeaderTitle();
}

function switchSession(id) {
  if (isGenerating) {
    const ok = confirm("当前正在生成回答，切换会话会停止当前生成，是否继续？");
    if (!ok) return;
    stopGenerate();
  }
  currentSessionId = id;
  renderList();
  renderMsg();
  updateHeaderTitle();
}

function getCurrentSession() {
  const sessions = getSessions();
  return sessions[currentSessionId] || null;
}

function getMsg() {
  const session = getCurrentSession();
  return session ? session.messages : [];
}

function setMsg(msgs) {
  const sessions = getSessions();
  const session = sessions[currentSessionId];
  if (!session) return;

  session.messages = msgs;

  const firstUserMsg = msgs.find(m => m.role === "user" && (m.content || "").trim());
  if (firstUserMsg) {
    session.title = firstUserMsg.content.trim().replace(/\n/g, " ").slice(0, 20) || "新会话";
  }

  setSessions(sessions);
  renderList();
  updateHeaderTitle();
}

/* =========================
 * 工具函数（XSS/排版/复制）
 * ========================= */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Markdown 渲染：默认把原始 HTML 字符转义，防止 XSS
function fmt(content = "") {
  if (!content) return "";
  // 使用 marked 渲染 Markdown（先转义原始 HTML，避免注入）
  if (window.marked) {
    try {
      const safeText = content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const html = window.marked.parse(safeText, { gfm: true, breaks: true });
      return html;
    } catch {
      // 兜底
    }
  }
  // 兜底：纯转义 + 换行
  return escapeHtml(content).replace(/\n/g, "<br>");
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

function toast(text) {
  let el = document.getElementById("chat-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "chat-toast";
    el.style.cssText = `
      position:fixed;
      left:50%;
      top:24px;
      transform:translateX(-50%);
      background:rgba(17,24,39,.92);
      color:#fff;
      padding:10px 16px;
      border-radius:10px;
      font-size:13px;
      z-index:9999;
      box-shadow:0 8px 24px rgba(0,0,0,.18);
      opacity:0;
      transition:.25s;
      pointer-events:none;
    `;
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = "1";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => {
    el.style.opacity = "0";
  }, 1600);
}

function autoResizeTextarea() {
  const ipt = document.getElementById("chat-input");
  if (!ipt) return;
  ipt.style.height = "auto";
  ipt.style.height = Math.min(ipt.scrollHeight, 160) + "px";
}

function updateHeaderTitle() {
  const titleEl = document.getElementById("chat-header-title");
  if (!titleEl) return;
  const session = getCurrentSession();
  titleEl.textContent = session?.title || "AI 助手";
}

function updateSendBtnState() {
  const btn = document.getElementById("send-chat-btn");
  if (!btn) return;
  btn.style.pointerEvents = "auto";
  btn.disabled = false;
  if (isGenerating) {
    btn.textContent = "停止";
    btn.style.background = "#ef4444";
  } else {
    btn.textContent = "发送";
    btn.style.background = "linear-gradient(135deg,#1677ff,#3b82f6)";
  }
}

async function readSmartFile(file) {
  const textTypes = [
    "text/",
    "application/json",
    "application/javascript",
    "application/xml"
  ];
  const canReadAsText = textTypes.some(prefix => file.type.startsWith(prefix) || file.type === prefix) || /\.(txt|md|json|csv|py|js|ts|html|css|xml|yaml|yml|log|ini|cfg)$/i.test(file.name);
  if (!canReadAsText) {
    return {
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      text_content: `[暂不支持直接解析该文件类型，仅记录文件名：${file.name}]`,
      size: file.size
    };
  }
  const text = await file.text();
  return {
    filename: file.name,
    content_type: file.type || "text/plain",
    text_content: text.slice(0, 20000),
    size: file.size
  };
}

async function collectSmartFiles() {
  const fileInput = document.getElementById("chat-file-input");
  const files = Array.from(fileInput?.files || []);
  smartFiles = [];
  for (const file of files) {
    smartFiles.push(await readSmartFile(file));
  }
  renderSmartFileList();
  return smartFiles;
}

function renderSmartFileList() {
  const host = document.getElementById("chat-smart-file-list");
  if (!host) return;
  if (!smartFiles.length) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }
  host.style.display = "flex";
  host.innerHTML = smartFiles.map((file, index) => `
    <div class="smart-file-chip">
      <span>${escapeHtml(file.filename)}</span>
      <button type="button" data-remove-smart-file="${index}">×</button>
    </div>
  `).join("");
}

/* =========================
 * UI 初始化（主流布局）
 * ========================= */
function initPanel() {
  const tab = document.getElementById("chat");
  if (!tab) return;

  const oldInput = document.getElementById("chat-input");
  const oldBtn = document.getElementById("send-chat-btn");
  const oldSel = document.getElementById("chat-config-select");

  if (!oldInput || !oldBtn || !oldSel) {
    console.warn("缺少 #chat-input / #send-chat-btn / #chat-config-select 元素");
    return;
  }

  tab.innerHTML = "";
  tab.style.cssText = `
    width:100%;
    height:100%;
    min-height:680px;
    display:flex;
    background:linear-gradient(180deg,#f8fafc 0%,#f1f5f9 100%);
    border:1px solid #e5e7eb;
    border-radius:20px;
    overflow:hidden;
    box-shadow:0 12px 30px rgba(15,23,42,.06);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  `;

  // 左侧栏
  const sidebar = document.createElement("div");
  sidebar.style.cssText = `
    width:280px;
    background:rgba(255,255,255,.9);
    border-right:1px solid #e5e7eb;
    display:flex;
    flex-direction:column;
    backdrop-filter:blur(10px);
  `;

  const sideTop = document.createElement("div");
  sideTop.style.cssText = `
    padding:18px 16px 12px;
    border-bottom:1px solid #eef2f7;
  `;

  const brand = document.createElement("div");
  brand.textContent = "我的 AI";
  brand.style.cssText = `
    font-size:18px;
    font-weight:800;
    color:#0f172a;
    margin-bottom:12px;
  `;

  const addBtn = document.createElement("button");
  addBtn.textContent = "+ 新建会话";
  addBtn.onclick = newSession;
  addBtn.style.cssText = `
    width:100%;
    border:none;
    border-radius:14px;
    padding:12px 14px;
    cursor:pointer;
    color:#fff;
    font-size:14px;
    font-weight:700;
    background:linear-gradient(135deg,#1677ff,#3b82f6);
    box-shadow:0 10px 24px rgba(22,119,255,.22);
  `;

  sideTop.appendChild(brand);
  sideTop.appendChild(addBtn);

  const list = document.createElement("div");
  list.id = "session-list-ui";
  list.style.cssText = `
    flex:1;
    overflow:auto;
    padding:14px 12px 16px;
  `;

  sidebar.appendChild(sideTop);
  sidebar.appendChild(list);

  // 右侧区域
  const main = document.createElement("div");
  main.style.cssText = `
    flex:1;
    min-width:0;
    display:flex;
    flex-direction:column;
    background:
      radial-gradient(circle at top right, rgba(59,130,246,.06), transparent 26%),
      linear-gradient(180deg,#f8fafc 0%, #f8fafc 100%);
  `;

  const header = document.createElement("div");
  header.style.cssText = `
    height:68px;
    flex-shrink:0;
    display:flex;
    align-items:center;
    justify-content:space-between;
    padding:0 20px;
    border-bottom:1px solid #e5e7eb;
    background:rgba(255,255,255,.72);
    backdrop-filter:blur(10px);
  `;

  const headerLeft = document.createElement("div");
  headerLeft.innerHTML = `
    <div id="chat-header-title" style="font-size:16px;font-weight:800;color:#0f172a;">AI 助手</div>
    <div style="font-size:12px;color:#64748b;margin-top:2px;">支持流式回复 · Markdown/代码高亮</div>
  `;

  const headerRight = document.createElement("div");
  headerRight.style.cssText = `
    display:flex;
    align-items:center;
    gap:10px;
  `;

  oldSel.style.cssText = `
    height:40px;
    min-width:160px;
    border:1px solid #dbe2ea;
    border-radius:12px;
    padding:0 12px;
    background:#fff;
    color:#334155;
    outline:none;
    font-size:14px;
  `;

  headerRight.appendChild(oldSel);
  header.appendChild(headerLeft);
  header.appendChild(headerRight);

  const smartFileBar = document.createElement("div");
  smartFileBar.id = "chat-smart-file-list";
  smartFileBar.style.cssText = "display:none;flex-wrap:wrap;gap:8px;padding:12px 22px 0;max-width:980px;margin:0 auto;width:100%;";

  const wrap = document.createElement("div");
  wrap.id = "msg-wrap";
  wrap.style.cssText = `
    flex:1;
    overflow:auto;
    padding:24px 22px;
    display:flex;
    flex-direction:column;
    gap:16px;
    scroll-behavior:smooth;
    box-sizing:border-box;
    width:100%;
  `;

  const inputArea = document.createElement("div");
  inputArea.style.cssText = `
    flex-shrink:0;
    padding:16px 20px 20px;
    border-top:1px solid #e5e7eb;
    background:rgba(255,255,255,.9);
    backdrop-filter:blur(8px);
  `;

  const inputBox = document.createElement("div");
  inputBox.style.cssText = `
    display:flex;
    align-items:flex-end;
    gap:12px;
    background:#fff;
    border:1px solid #dbe2ea;
    border-radius:18px;
    padding:12px;
    box-shadow:0 10px 30px rgba(15,23,42,.05);
    box-sizing:border-box;
    width:100%;
  `;

  oldInput.style.cssText = `
    flex:1;
    min-height:24px;
    max-height:160px;
    resize:none;
    border:none;
    outline:none;
    background:transparent;
    font-size:14px;
    line-height:1.7;
    color:#0f172a;
    padding:6px 4px;
    overflow:auto;
    font-family:inherit;
    white-space:pre-wrap;
    word-break:break-word;
  `;
  oldInput.placeholder = "输入消息，Enter 发送，Shift + Enter 换行";

  oldBtn.style.cssText = `
    height:44px;
    padding:0 18px;
    border:none;
    border-radius:12px;
    cursor:pointer;
    color:#fff;
    font-size:14px;
    font-weight:700;
    white-space:nowrap;
    background:linear-gradient(135deg,#1677ff,#3b82f6);
    box-shadow:0 8px 20px rgba(22,119,255,.22);
    pointer-events:auto;
    flex-shrink:0;
  `;
  oldBtn.onclick = send;

  inputBox.appendChild(oldInput);
  inputBox.appendChild(oldBtn);
  inputArea.appendChild(inputBox);

  main.appendChild(header);
  main.appendChild(smartFileBar);
  main.appendChild(wrap);
  main.appendChild(inputArea);

  tab.appendChild(sidebar);
  tab.appendChild(main);

  oldInput.addEventListener("input", autoResizeTextarea);
  oldInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  const fileInput = document.getElementById("chat-file-input");
  if (fileInput && !fileInput._boundSmartUpload) {
    fileInput.addEventListener("change", () => collectSmartFiles());
    fileInput._boundSmartUpload = true;
  }

  bindMsgEventsOnce();
  updateHeaderTitle();
  updateSendBtnState();
  autoResizeTextarea();
}

/* =========================
 * 渲染逻辑（主流排版 + 增量渲染）
 * ========================= */
function renderList() {
  const list = document.getElementById("session-list-ui");
  if (!list) return;

  const sessions = getSessions();
  const arr = Object.values(sessions).sort((a, b) => (b.id > a.id ? 1 : -1));

  list.innerHTML = arr.map(item => {
    const active = item.id === currentSessionId;
    return `
      <div
        onclick="switchSession('${item.id}')"
        style="
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          padding:12px 12px;
          margin-bottom:8px;
          border-radius:14px;
          cursor:pointer;
          transition:.2s;
          background:${active ? "linear-gradient(135deg,#e8f1ff,#f4f8ff)" : "#fff"};
          border:1px solid ${active ? "#cfe0ff" : "#edf2f7"};
          box-shadow:${active ? "0 10px 24px rgba(59,130,246,.08)" : "none"};
        "
      >
        <div style="flex:1;min-width:0;">
          <div style="
            font-size:14px;
            font-weight:${active ? "700" : "600"};
            color:${active ? "#1660d6" : "#0f172a"};
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          ">${escapeHtml(item.title || "新会话")}</div>
        </div>
        <button
          onclick="delSession('${item.id}',event)"
          style="
            border:none;
            background:transparent;
            color:${active ? "#1660d6" : "#94a3b8"};
            width:26px;
            height:26px;
            border-radius:8px;
            cursor:pointer;
            font-size:16px;
          "
          title="删除"
        >×</button>
      </div>
    `;
  }).join("");
}

function renderMsg() {
  const wrap = document.getElementById("msg-wrap");
  if (!wrap) return;

  const msgs = getMsg();
  const validMsgs = msgs.filter(m => (m.content || "").trim() !== "");

  if (validMsgs.length === 0) {
    wrap.innerHTML = `
      <div class="empty-chat-tip">
        <div class="empty-tip-title">开始一个新对话</div>
        <div class="empty-tip-desc">
          选择模型，输入你的问题，即可开始聊天。<br>
          支持 Markdown 与代码高亮，回复会流式显示。
        </div>
      </div>
    `;
    return;
  }

  wrap.innerHTML = validMsgs.map((m, i) => renderOneMsg(m, i)).join("");
  enhanceAllMessages(wrap);
  setTimeout(() => {
    wrap.scrollTop = wrap.scrollHeight;
  }, 0);
}

function renderOneMsg(m, index) {
  const isUser = m.role === "user";
  const html = fmt(m.content || "");
  return `
  <div class="chat-row ${isUser ? "chat-row-user" : "chat-row-ai"}" data-idx="${index}">
    <div class="chat-avatar">${isUser ? "我" : "AI"}</div>
    <div class="chat-bubble ${isUser ? "bubble-user" : "bubble-ai"}">
      <div class="chat-md">${html || (m.role === "assistant" ? '<span class="chat-dim">...</span>' : "")}</div>
      <div class="chat-bubble-footer">
        ${(!isUser && m.streaming) ? `<span class="chat-streaming">生成中<span class="chat-dotting">...</span></span>` : `<span></span>`}
        <button class="btn-copy-msg" type="button">复制</button>
      </div>
    </div>
  </div>`;
}

function bindMsgEventsOnce() {
  const wrap = document.getElementById("msg-wrap");
  if (!wrap || wrap._bound) return;
  wrap._bound = true;

  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-copy-msg");
    if (!btn) return;
    const row = e.target.closest(".chat-row");
    if (!row) return;
    const idx = Number(row.dataset.idx);
    const msgs = getMsg().filter(m => (m.content || "").trim() !== "");
    const m = msgs[idx];
    if (!m) return;
    copyMsg(m.content || "");
  });

  wrap.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-copy-code]");
    if (!btn) return;
    const code = btn.getAttribute("data-copy-code") || "";
    copyMsg(code);
  });
}

/* 增强当前容器中的所有 markdown：代码高亮 + 代码块复制按钮 */
function enhanceAllMessages(container) {
  if (!container) return;
  // 高亮
  try {
    if (window.hljs) {
      container.querySelectorAll("pre code").forEach(block => window.hljs.highlightElement(block));
    }
  } catch {}
  // 代码块复制按钮
  enhanceCodeBlocks(container);
}

function enhanceCodeBlocks(container) {
  if (!container) return;
  const pres = [...container.querySelectorAll("pre")];
  pres.forEach(pre => {
    if (pre._enhanced) return;
    const code = pre.querySelector("code");
    const langClass = code?.className || "";
    const m = langClass.match(/language-([\w-]+)/i);
    const lang = m ? m[1] : "code";
    const codeText = code ? code.textContent : pre.textContent || "";

    const wrapper = document.createElement("div");
    wrapper.className = "code-block-container";
    const header = document.createElement("div");
    header.className = "code-block-header";
    header.innerHTML = `
      <span>${escapeHtml(lang)}</span>
      <button class="btn-copy-code" data-copy-code="${escapeHtml(codeText)}" type="button">复制代码</button>
    `;

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
    pre._enhanced = true;
  });
}

/* 仅更新最后一条 assistant 的 DOM（流式不卡顿） */
function patchLastAssistantDom(fullText, streaming = true) {
  const wrap = document.getElementById("msg-wrap");
  if (!wrap) return;

  const rows = wrap.querySelectorAll(".chat-row-ai");
  const lastRow = rows[rows.length - 1];
  if (!lastRow) return;

  const md = lastRow.querySelector(".chat-md");
  if (!md) return;

  md.innerHTML = fmt(fullText);
  // 高亮 + 复制增强
  enhanceAllMessages(lastRow);

  const tip = lastRow.querySelector(".chat-streaming");
  if (tip) tip.style.display = streaming ? "" : "none";

  wrap.scrollTop = wrap.scrollHeight;
}

function patchLastAssistantMessage(text, streaming = true) {
  const sessions = getSessions();
  const session = sessions[currentSessionId];
  if (!session) return;

  const msgs = session.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      msgs[i].content = text;
      msgs[i].streaming = streaming;
      break;
    }
  }
  // 只更新最后一条 DOM
  patchLastAssistantDom(text, streaming);
}

function finishLastAssistantMessage(text) {
  const msgs = [...getMsg()];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      msgs[i].content = text;
      msgs[i].streaming = false;
      setMsg(msgs);
      renderMsg();
      return;
    }
  }
}

/* =========================
 * 流式解析（SSE）
 * ========================= */
function extractContentFromJson(obj) {
  if (!obj) return "";
  if (obj.error) return `错误：${obj.error.message || obj.error}`;
  if (obj.choices && obj.choices.length > 0) {
    const choice = obj.choices[0];
    if (choice.delta && typeof choice.delta.content === "string") return choice.delta.content;
    if (choice.message && typeof choice.message.content === "string") return choice.message.content;
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
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      if (trimmedLine.startsWith("data:")) {
        const data = trimmedLine.slice(5).trim();
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
  }

  if (buffer.trim()) {
    const data = buffer.trim().startsWith("data:") ? buffer.trim().slice(5).trim() : buffer.trim();
    if (data && data !== "[DONE]") {
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

/* =========================
 * 停止生成（状态重置）
 * ========================= */
function stopGenerate() {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
  isGenerating = false;
  updateSendBtnState();

  const msgs = [...getMsg()];
  const last = msgs[msgs.length - 1];
  if (last && last.role === "assistant") {
    last.streaming = false;
    if (!last.content) last.content = "已停止生成";
    setMsg(msgs);
    renderMsg();
  }
}

/* =========================
 * 发送消息（流式请求 + 上下文保留）
 * ========================= */
async function send() {
  if (isGenerating) {
    stopGenerate();
    return;
  }

  const ipt = document.getElementById("chat-input");
  const sel = document.getElementById("chat-config-select");
  const imageSel = document.getElementById("image-config-select");
  const tempInput = document.getElementById("temperature");
  const text = ipt?.value.trim();

  if (!ipt || !sel) return;
  if (!text) return toast("请输入内容");
  if (!sel.value) return toast("请选择配置");

  await collectSmartFiles();

  const msgs = getMsg();
  const newMsgs = [...msgs, { role: "user", content: text }, { role: "assistant", content: "", streaming: true }];
  setMsg(newMsgs);

  ipt.value = "";
  autoResizeTextarea();
  renderMsg();

  isGenerating = true;
  updateSendBtnState();
  currentController = new AbortController();

  try {
    const payloadMessages = msgs
      .filter(m => m.role && typeof m.content === "string")
      .map(({ role, content }) => ({ role, content: content.trim() }))
      .filter(m => m.content);

    const res = await fetch("/api/chat/smart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        messages: payloadMessages,
        chat_config_id: sel.value,
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
        finishLastAssistantMessage(`我判断这是图片生成任务，已帮你整理提示词：\n\n${result.data.prompt}\n\n请切到“图片生成”页直接生成，或我下一步也可以继续帮你优化提示词。`);
      } else {
        finishLastAssistantMessage(result.message || "处理完成");
      }
    } else {
      let finalText = "";
      if (res.body) {
        finalText = await readStreamResponse(res, (fullText) => {
          patchLastAssistantMessage(fullText, true);
        });
      }
      finishLastAssistantMessage(finalText || "无返回内容");
    }

    smartFiles = [];
    const fileInput = document.getElementById("chat-file-input");
    if (fileInput) fileInput.value = "";
    renderSmartFileList();
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

/* =========================
 * 暴露到全局
 * ========================= */
window.newSession = newSession;
window.delSession = delSession;
window.switchSession = switchSession;
window.copyMsg = copyMsg;

/* =========================
 * 页面初始化 + 样式
 * ========================= */
document.addEventListener("DOMContentLoaded", async () => {
  injectExtraStyle();
  try { await loadDeps(); } catch {}
  initSessions();
  initPanel();
  renderList();
  renderMsg();
  updateHeaderTitle();
});

function injectExtraStyle() {
  if (document.getElementById("chat-extra-style")) return;

  const style = document.createElement("style");
  style.id = "chat-extra-style";
  style.innerHTML = `
    /* 滚动条样式优化 */
    #msg-wrap::-webkit-scrollbar,
    #session-list-ui::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    #msg-wrap::-webkit-scrollbar-thumb,
    #session-list-ui::-webkit-scrollbar-thumb {
      background: #cbd5e1;
      border-radius: 999px;
    }
    #msg-wrap::-webkit-scrollbar-track,
    #session-list-ui::-webkit-scrollbar-track {
      background: transparent;
    }

    /* 加载中点点动画 */
    .chat-dotting {
      display:inline-block;
      width:18px;
      overflow:hidden;
      vertical-align:bottom;
      animation:chat-dotting 1.2s steps(4,end) infinite;
    }
    @keyframes chat-dotting {
      0% { width: 0; }
      100% { width: 18px; }
    }

    /* 主流聊天布局 */
    .chat-row{
      display:flex;
      gap:12px;
      align-items:flex-start;
      width:100%;
      max-width: 980px;
      margin: 0 auto;
    }
    .chat-row-user{ flex-direction: row-reverse; }
    .chat-avatar{
      width:32px;height:32px;border-radius:999px;
      display:flex;align-items:center;justify-content:center;
      font-weight:800;font-size:12px;
      background:#e2e8f0;color:#0f172a;
      flex-shrink:0;
    }
    .chat-row-user .chat-avatar{ background:#dbeafe;color:#1d4ed8; }

    .chat-bubble{
      flex:1;
      border-radius:16px;
      padding:12px 14px;
      box-shadow:0 6px 18px rgba(15,23,42,.05);
      border:1px solid #e7edf3;
      overflow:hidden;
    }
    .bubble-ai{ background:#fff; color:#0f172a; }
    .bubble-user{
      background:linear-gradient(135deg,#1677ff,#3b82f6);
      color:#fff;
      border:none;
    }

    .chat-md { line-height:1.75; font-size:14px; }
    .chat-md p{ margin: 0 0 10px; }
    .chat-md p:last-child{ margin-bottom:0; }
    .chat-md a{ color:inherit; text-decoration:underline; }
    .chat-md ul, .chat-md ol{ margin: 8px 0 8px 18px; }
    .chat-md code{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      padding: 2px 6px;
      border-radius: 8px;
      background: rgba(15,23,42,.08);
    }
    .bubble-user .chat-md code{ background: rgba(255,255,255,.18); }

    .chat-md pre{
      background:#0b1220;
      border:1px solid #1f2a44;
      border-radius:14px;
      padding:12px;
      overflow:auto;
      margin:10px 0;
    }
    .chat-md pre code{
      background:transparent;
      padding:0;
      color:#e5e7eb;
      white-space:pre;
    }

    .code-block-container {
      background:#0b1220;
      border:1px solid #1f2a44;
      border-radius:14px;
      overflow:hidden;
      margin:10px 0;
      width:100%;
      box-sizing:border-box;
    }
    .code-block-header {
      display:flex;
      justify-content:space-between;
      align-items:center;
      padding:8px 12px;
      font-size:12px;
      color:#94a3b8;
      background:#0a0f1a;
      border-bottom:1px solid #132238;
    }
    .code-block-header .btn-copy-code{
      border:none;
      border-radius:8px;
      padding:4px 8px;
      font-size:12px;
      cursor:pointer;
      background:#1f2a44;
      color:#e5e7eb;
    }

    .chat-bubble-footer{
      margin-top:10px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:10px;
      font-size:12px;
      opacity:.9;
    }
    .btn-copy-msg{
      border:none;
      border-radius:10px;
      padding:6px 10px;
      font-size:12px;
      cursor:pointer;
      background:#f1f5f9;
      color:#475569;
    }
    .bubble-user .btn-copy-msg{
      background: rgba(255,255,255,.18);
      color:#fff;
    }
    .chat-dim{ opacity:.6; }
    .chat-streaming{ color:#64748b; }

    /* 空会话提示 */
    .empty-chat-tip {
      margin:auto;
      text-align:center;
      color:#64748b;
      max-width:520px;
      padding:40px 20px;
    }
    .empty-tip-title {
      font-size:24px;
      font-weight:800;
      color:#0f172a;
      margin-bottom:10px;
    }
    .empty-tip-desc {
      font-size:14px;
      line-height:1.8;
    }
    .smart-file-chip{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:6px 10px;
      background:#e8f1ff;
      color:#1d4ed8;
      border:1px solid #cfe0ff;
      border-radius:999px;
      font-size:12px;
      font-weight:600;
    }
    .smart-file-chip button{
      border:none;
      background:transparent;
      color:#1d4ed8;
      cursor:pointer;
      font-size:14px;
      line-height:1;
    }

    /* 全局安全/排版修复 */
    #msg-wrap * { box-sizing:border-box !important; }
    .msg-bubble { width:100%; overflow:hidden; }
    .msg-content { overflow:hidden; word-wrap:break-word; }
    pre { overflow-x:auto; max-width:100%; }
    button, select { flex-shrink:0; }
  `;
  document.head.appendChild(style);
}