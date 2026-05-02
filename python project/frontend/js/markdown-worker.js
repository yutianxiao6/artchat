// Markdown Worker - 在独立线程中处理 markdown 渲染
self.postMessage({ action: 'ready' });
self.onmessage = function(e) {
  const { id, text, action } = e.data;

  if (action === 'render') {
    try {
      // 简单的 markdown 渲染（不依赖外部库）
      let html = text
        // 代码块
        .replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
          const language = lang || 'code';
          return `<pre><code class="language-${language}">${escapeHtml(code.trim())}</code></pre>`;
        })
        // 行内代码
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        // 标题
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        // 粗体
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // 斜体
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        // 链接
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        // 换行
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>');
      
      html = '<p>' + html + '</p>';
      
      self.postMessage({ id, html, success: true });
    } catch (error) {
      self.postMessage({ id, error: error.message, success: false });
    }
  }
};

function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
