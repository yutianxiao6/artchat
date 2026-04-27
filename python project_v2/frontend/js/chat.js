const CHAT_STORAGE_KEY = "my_ai_chat_sessions_v2";
let currentSessionId = null;
let currentController = null;
let isGenerating = false;
const MAX_CONTEXT_MESSAGES = 12;

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
  try { if (!window.marked) await loadScript("https://cdn.jsdelivr.net/npm/marked/marked.min.js"); } catch {}
  try {
    await loadCss("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css");
    if (!window.hljs) await loadScript("https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/highlight.min.js");
  } catch {}
}
function getSessions() { return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)) || {}; }
function setSessions(sessions) { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(sessions)); }
function initSessions() {
  let sessions = getSessions();
  if (!Object.keys(sessions).length) {
    const id = `s_${Date.now()}`;
    sessions[id] = { id, title: "新会话", messages: [] };
    setSessions(sessions);
  }
  currentSessionId = Object.keys(sessions)[0];
}
function getCurrentSession() { return getSessions()[currentSessionId] || null; }
function getMsg() { return getCurrentSession()?.messages || []; }
function setMsg(msgs) {
  const sessions = getSessions();
  if (!sessions[currentSessionId]) return;
  sessions[currentSessionId].messages = msgs;
  const firstUserMsg = msgs.find((m) => m.role === "user" && (m.content || "").trim());
  sessions[currentSessionId].title = firstUserMsg ? firstUserMsg.content.trim().slice(0, 24) : "新会话";
  setSessions(sessions);
  renderSessionList();
}
function newSession() {
  const sessions = getSessions();
  const id = `s_${Date.now()}`;
  sessions[id] = { id, title: "新会话", messages: [] };
  currentSessionId = id;
  setSessions(sessions);
  renderSessionList();
  renderMessages();
}
function deleteSession(id) {
  if (!confirm("确定删除这个会话吗？")) return;
  const sessions = getSessions();
  delete sessions[id];
  const ids = Object.keys(sessions);
  if (!ids.length) {
    const newId = `s_${Date.now()}`;
    sessions[newId] = { id: newId, title: "新会话", messages: [] };
    currentSessionId = newId;
  } else if (currentSessionId === id) {
    currentSessionId = ids[0];
  }
  setSessions(sessions);
  renderSessionList();
  renderMessages();
}
function switchSession(id) {
  if (isGenerating) {
    if (!confirm("当前正在生成回答，切换会话会终止当前输出，继续吗？")) return;
    stopGenerate();
  }
  currentSessionId = id;
  renderSessionList();
  renderMessages();
}
function escapeHtml(str = "") {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
}
function normalizeCodePayload(code, infostring) {
  if (typeof code === "string") return { text: code, lang: typeof infostring === "string" ? infostring : "" };
  if (code && typeof code === "object") {
    const text = typeof code.text === "string" ? code.text : String(code.raw || "");
    const lang = typeof code.lang === "string" ? code.lang : (typeof infostring === "string" ? infostring : infostring?.text || "");
    return { text, lang };
  }
  return { text: String(code || ""), lang: typeof infostring === "string" ? infostring : "" };
}
function configureMarked() {
  if (!window.marked) return;
  window.marked.setOptions({ gfm: true, breaks: true });
  const renderer = new window.marked.Renderer();
  renderer.code = (code, infostring) => {
    const payload = normalizeCodePayload(code, infostring);
    const lang = String(payload.lang || "").trim().split(/\s+/)[0];
    const langLabel = lang || guessCodeLanguage(payload.text) || "code";
    const escaped = escapeHtml(payload.text || "");
    const encoded = encodeURIComponent(payload.text || "");
    return `
      <div class="code-block">
        <div class="code-block-header">
          <span class="code-lang">${escapeHtml(langLabel)}</span>
          <button class="code-copy-btn" data-code="${encoded}" title="复制代码">
            <i class="fa fa-copy"></i>
            复制代码
          </button>
        </div>
        <pre><code class="hljs language-${escapeHtml(langLabel)}">${escaped}</code></pre>
      </div>`;
  };
  window.marked.use({ renderer });
}
function guessCodeLanguage(text = "") {
  const s = String(text || "").trim();
  if (!s) return "";
  if (/^\s*\{[\s\S]*\}\s*$/.test(s) || /^\s*\[[\s\S]*\]\s*$/.test(s)) return "json";
  if (/^\s*(def |import |from |class |print\()/.test(s)) return "python";
  if (/^\s*(function |const |let |var |import |export |console\.)/.test(s)) return "javascript";
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(s)) return "sql";
  if (/^\s*(<\?xml|<html|<div|<script|<style)/i.test(s)) return "html";
  if (/^\s*(curl |npm |pnpm |yarn |python3? |pip |git )/.test(s)) return "bash";
  return "";
}
function fmt(content = "") {
  if (!content) return "";
  if (window.marked) {
    try { return window.marked.parse(content); } catch {}
  }
  return escapeHtml(content).replace(/\n/g, "<br>");
}
async function copyText(text, ok = "已复制") {
  try { await navigator.clipboard.writeText(text); toast(ok); } catch { toast("复制失败"); }
}
async function copyMsg(text) { return copyText(text, "已复制回复"); }
async function copyCode(text) { return copyText(text, "代码已复制"); }
function toast(text) {
  let el = document.getElementById("chat-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "chat-toast";
    el.className = "chat-toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove("show"), 1500);
}
function autoResizeTextarea() {
  const ipt = document.getElementById("chat-input");
  if (!ipt) return;
  ipt.style.height = "auto";
  ipt.style.height = `${Math.min(ipt.scrollHeight, 200)}px`;
}
function renderSessionList() {
  const wrap = document.getElementById("session-list");
  if (!wrap) return;
  const sessions = Object.values(getSessions());
  wrap.innerHTML = sessions.map((s) => `
    <div class="session-item ${s.id === currentSessionId ? "active" : ""}" data-id="${s.id}">
      <div class="session-item-main">
        <div class="session-title">${escapeHtml(s.title || "新会话")}</div>
        <div class="session-meta">${(s.messages || []).length} 条消息</div>
      </div>
      <button class="session-delete" data-id="${s.id}" title="删除会话"><i class="fa fa-times"></i></button>
    </div>`).join("");
}
function renderMessages() {
  const container = document.getElementById("messages-container");
  if (!container) return;
  const msgs = getMsg();
  if (!msgs.length) {
    container.innerHTML = `<div class="chat-welcome"><div class="chat-welcome-badge"><i class="fa fa-magic"></i> Ready</div><h2>开始一段新的 AI 对话</h2><p>选择左侧模型配置，输入问题后即可开始流式聊天。支持 Markdown、代码高亮、代码复制和多会话保存。</p></div>`;
    return;
  }
  container.innerHTML = msgs.map((m) => {
    const isUser = m.role === "user";
    const cls = isUser ? "user" : "assistant";
    const avatar = isUser ? "你" : "AI";
    const actions = !isUser ? `<button class="message-action" data-copy="${encodeURIComponent(m.content || "")}"><i class="fa fa-copy"></i> 复制回复</button>` : "";
    return `<div class="message-row ${cls}"><div class="message-avatar ${cls}">${avatar}</div><div class="message-bubble ${cls}"><div class="message-toolbar"><span>${isUser ? "你" : "AI 助手"}</span><div class="message-actions">${actions}</div></div><div class="message-markdown">${fmt(m.content || (m.streaming ? "思考中..." : ""))}</div></div></div>`;
  }).join("");
  if (window.hljs) container.querySelectorAll("pre code").forEach((el) => window.hljs.highlightElement(el));
  const scroller = document.getElementById("chat-messages");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}
function patchLastAssistantMessage(content, streaming = true) {
  const msgs = [...getMsg()];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") {
      msgs[i].content = content;
      msgs[i].streaming = streaming;
      break;
    }
  }
  setMsg(msgs);
  renderMessages();
}
function finishLastAssistantMessage(content) { patchLastAssistantMessage(content, false); }
async function readStreamResponse(res, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return fullText;
      try {
        const json = JSON.parse(data);
        if (json.error) fullText += `\n${json.error}`;
        else {
          const delta = json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || "";
          if (delta) fullText += delta;
        }
        onChunk(fullText);
      } catch {}
    }
  }
  return fullText;
}
function stopGenerate() { if (currentController) currentController.abort(); currentController = null; isGenerating = false; updateSendBtnState(); }
function updateSendBtnState() {
  const btn = document.getElementById("send-chat-btn");
  if (!btn) return;
  btn.disabled = !document.getElementById("chat-config-select")?.value;
  btn.innerHTML = isGenerating ? '<i class="fa fa-stop"></i> 停止' : '<i class="fa fa-paper-plane"></i> 发送';
}
async function send() {
  if (isGenerating) { stopGenerate(); return; }
  const ipt = document.getElementById("chat-input");
  const sel = document.getElementById("chat-config-select");
  const temperature = parseFloat(document.getElementById("temperature")?.value || "0.7");
  if (!ipt || !sel) return;
  const text = ipt.value.trim();
  if (!text) return toast("请输入内容");
  if (!sel.value) return toast("请选择配置");
  const next = [...getMsg(), { role: "user", content: text }, { role: "assistant", content: "", streaming: true }];
  setMsg(next);
  renderMessages();
  ipt.value = "";
  autoResizeTextarea();
  isGenerating = true;
  updateSendBtnState();
  currentController = new AbortController();
  try {
    const payloadMessages = next.filter((m) => !(m.role === "assistant" && m.streaming)).map(({ role, content }) => ({ role, content })).filter((m) => m.content && String(m.content).trim()).slice(-MAX_CONTEXT_MESSAGES);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config_id: sel.value, messages: payloadMessages, stream: true, temperature }),
      signal: currentController.signal,
    });
    if (!res.ok) throw new Error(await res.text());
    const finalText = await readStreamResponse(res, (t) => patchLastAssistantMessage(t, true));
    finishLastAssistantMessage(finalText || "无返回内容");
  } catch (e) {
    if (e.name === "AbortError") finishLastAssistantMessage("已停止生成");
    else {
      finishLastAssistantMessage(`请求出错：${e.message}`);
      toast(`错误：${e.message}`);
    }
  } finally {
    isGenerating = false;
    currentController = null;
    updateSendBtnState();
  }
}
function clearCurrentChat() { if (!confirm("确定清空当前会话吗？")) return; setMsg([]); renderMessages(); }
function bindEvents() {
  document.getElementById("new-session-btn")?.addEventListener("click", newSession);
  document.getElementById("clear-chat-btn")?.addEventListener("click", clearCurrentChat);
  document.getElementById("send-chat-btn")?.addEventListener("click", send);
  document.getElementById("chat-config-select")?.addEventListener("change", updateSendBtnState);
  const ipt = document.getElementById("chat-input");
  if (ipt) {
    ipt.addEventListener("input", autoResizeTextarea);
    ipt.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }
  document.getElementById("session-list")?.addEventListener("click", (e) => {
    const del = e.target.closest(".session-delete");
    if (del) return deleteSession(del.dataset.id);
    const item = e.target.closest(".session-item");
    if (item) switchSession(item.dataset.id);
  });
  document.getElementById("messages-container")?.addEventListener("click", async (e) => {
    const msgBtn = e.target.closest(".message-action[data-copy]");
    if (msgBtn) return copyMsg(decodeURIComponent(msgBtn.dataset.copy || ""));
    const codeBtn = e.target.closest(".code-copy-btn[data-code]");
    if (codeBtn) return copyCode(decodeURIComponent(codeBtn.dataset.code || ""));
  });
}
document.addEventListener("DOMContentLoaded", async () => {
  await loadDeps();
  configureMarked();
  initSessions();
  bindEvents();
  renderSessionList();
  renderMessages();
  autoResizeTextarea();
  updateSendBtnState();
});
window.renderChatMessages = renderMessages;
