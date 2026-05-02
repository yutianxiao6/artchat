(function () {
  const CONFIG_STORAGE_KEY = 'liuhui:mobile:model-configs';
  const CANVAS_STATE_KEY = 'liuhui:mobile:canvas-state';
  let memoryCanvasState = { sessions: [], assetLibrary: [], categories: ['未分类'] };
  const DEFAULT_CANVAS_STATE = { sessions: [], assetLibrary: [], categories: [] };

  function safePreview(value, max = 280) {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      if (!text) return '';
      return text.length > max ? `${text.slice(0, max)}…` : text;
    } catch {
      return '[unserializable]';
    }
  }

  function redactSecrets(value) {
    try {
      return JSON.parse(JSON.stringify(value, (key, val) => {
        if (key === 'api_key' || key === 'Authorization') {
          if (!val) return val;
          const text = String(val);
          return text.length <= 12 ? '***' : `${text.slice(0, 6)}***${text.slice(-4)}`;
        }
        return val;
      }));
    } catch {
      return value;
    }
  }

  function log(level, scope, message, extra) {
    const prefix = `[mobile-api][${scope}] ${message}`;
    if (typeof extra === 'undefined') {
      console[level] ? console[level](prefix) : console.log(prefix);
      return;
    }
    console[level] ? console[level](prefix, extra) : console.log(prefix, extra);
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      log('error', 'storage', `failed to read json for key=${key}`, e);
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      log('info', 'storage', `saved key=${key}`, {
        size: safePreview(JSON.stringify(value), 120).length,
      });
    } catch (e) {
      log('error', 'storage', `failed to write json for key=${key}`, e);
      throw e;
    }
  }

  function readConfigs() { return readJson(CONFIG_STORAGE_KEY, []); }
  function writeConfigs(configs) { writeJson(CONFIG_STORAGE_KEY, configs || []); }

  function readCanvasState() {
    const raw = readJson(CANVAS_STATE_KEY, null);
    const state = raw && typeof raw === 'object' ? raw : memoryCanvasState;
    memoryCanvasState = {
      sessions: Array.isArray(state.sessions) ? state.sessions : [],
      assetLibrary: Array.isArray(state.assetLibrary) ? state.assetLibrary : [],
      categories: Array.isArray(state.categories) && state.categories.length ? state.categories : deriveCategories(Array.isArray(state.assetLibrary) ? state.assetLibrary : []),
    };
    return memoryCanvasState;
  }

  function shrinkCanvasStateForStorage(state) {
    return {
      sessions: Array.isArray(state.sessions) ? state.sessions.map((session) => ({
        id: session.id,
        title: session.title || '画布会话',
        summary: session.summary || '',
        snapshot: {
          panX: Number(session.snapshot?.panX || 0),
          panY: Number(session.snapshot?.panY || 0),
          zoom: Number(session.snapshot?.zoom || 1),
          nodes: Array.isArray(session.snapshot?.nodes) ? session.snapshot.nodes.map((node) => ({
            ...node,
            imageUrl: '',
            imageBase64: '',
            outputImages: [],
          })) : [],
          edges: Array.isArray(session.snapshot?.edges) ? session.snapshot.edges : [],
        }
      })) : [],
      assetLibrary: Array.isArray(state.assetLibrary) ? state.assetLibrary.map((item) => ({
        ...item,
        imageUrl: '',
        imageBase64: '',
      })) : [],
      categories: Array.isArray(state.categories) ? state.categories : ['未分类'],
    };
  }

  function writeCanvasState(state) {
    const normalized = {
      sessions: Array.isArray(state?.sessions) ? state.sessions : [],
      assetLibrary: Array.isArray(state?.assetLibrary) ? state.assetLibrary : [],
      categories: Array.isArray(state?.categories) ? state.categories : deriveCategories(state?.assetLibrary || []),
    };
    writeJson(CANVAS_STATE_KEY, normalized);
    log('info', 'canvas', 'canvas state updated', {
      sessions: normalized.sessions.length,
      assetLibrary: normalized.assetLibrary.length,
      categories: normalized.categories.length,
    });
    return normalized;
  }

  function deriveCategories(assetLibrary) {
    const set = new Set(['未分类']);
    for (const item of assetLibrary || []) {
      const cat = (item?.category || '未分类').trim() || '未分类';
      set.add(cat);
    }
    return Array.from(set);
  }

  async function getJsonBody(request) {
    try {
      const body = await request.json();
      return body;
    } catch (e) {
      log('warn', 'request', `request json parse failed for ${request.method || 'UNKNOWN'} ${request.url || ''}`, e);
      return {};
    }
  }

  function json(data, init = {}) {
    return new Response(JSON.stringify(data), {
      status: init.status || 200,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  }

  function ok(data = {}, message = '') { return json({ code: 0, message, data }); }
  function fail(message, status = 400) {
    log(status >= 500 ? 'error' : 'warn', 'response', `fail status=${status} message=${message}`);
    return json({ code: -1, message, detail: message }, { status });
  }
  function findConfig(configId) { return readConfigs().find((c) => String(c.id) === String(configId)); }

  function normalizeRequestUrl(input) {
    try {
      return new URL(input, window.location.origin);
    } catch {
      return new URL(String(input || ''), window.location.origin);
    }
  }

  function normalizeChatMessages(messages = [], files = [], latestMessage = "") {
    const merged = [...messages];
    const normalizedFiles = Array.isArray(files) ? files : [];
    const imageFiles = normalizedFiles.filter((f) => String(f?.content_type || "").startsWith("image/") && f?.image_url);
    const textFiles = normalizedFiles.filter((f) => !(String(f?.content_type || "").startsWith("image/") && f?.image_url));
    const text = String(latestMessage || "").trim();
    if (text) merged.push({ role: "user", content: text });
    if (textFiles.length) {
      const appendText = textFiles.map((f) => {
        const name = f?.filename || f?.name || '未命名文件';
        const content = String(f?.text_content || f?.content || '').trim();
        return content ? `\n\n[附件内容开始: ${name}]\n${content}\n[附件内容结束: ${name}]` : `\n\n[附件: ${name}]`;
      }).join('\n');
      if (merged.length && merged[merged.length - 1]?.role === 'user') {
        const prevContent = merged[merged.length - 1].content;
        if (Array.isArray(prevContent)) {
          prevContent.unshift({ type: 'text', text: appendText.trim() });
        } else {
          merged[merged.length - 1] = { ...merged[merged.length - 1], content: String(prevContent || '') + appendText };
        }
      } else {
        merged.push({ role: 'user', content: appendText.trim() });
      }
    }
    if (imageFiles.length) {
      const lastUserIndex = [...merged].map((m, i) => [m, i]).reverse().find(([m]) => m?.role === 'user')?.[1];
      const baseText = lastUserIndex != null ? merged[lastUserIndex].content : '';
      const parts = [];
      if (typeof baseText === 'string' && baseText.trim()) parts.push({ type: 'text', text: baseText.trim() });
      imageFiles.forEach((f) => {
        parts.push({ type: 'text', text: `[图片附件: ${f.filename || '未命名图片'}]` });
        parts.push({ type: 'image_url', image_url: { url: f.image_url || f.preview_url } });
      });
      if (lastUserIndex != null) merged[lastUserIndex] = { ...merged[lastUserIndex], content: parts };
      else merged.push({ role: 'user', content: parts });
    }
    return merged;
  }

function normalizeImageItems(raw) {
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.images) ? raw.images : [];
    return list.map((item, index) => {
      if (!item) return null;
      const url = item.url || item.imageUrl || item.image_url || '';
      const b64 = item.b64_json || item.base64 || item.b64 || '';
      return { id: item.id || `img_${Date.now()}_${index}`, url, b64_json: b64 };
    }).filter(Boolean);
  }

  async function handleConfigs(request) {
    const method = (request.method || 'GET').toUpperCase();
    const url = normalizeRequestUrl(request.url);
    const configs = readConfigs();
    log('info', 'configs', `handleConfigs method=${method} path=${url.pathname}`, { count: configs.length });

    if (method === 'GET') return ok(configs);
    if (method === 'POST') {
      const body = await getJsonBody(request);
      log('info', 'configs', 'saving config', redactSecrets({ id: body?.id, config_type: body?.config_type, api_base: body?.api_base, model_name: body?.model_name }));
      const idx = configs.findIndex((c) => String(c.id) === String(body.id));
      if (idx >= 0) configs[idx] = body; else configs.push(body);
      writeConfigs(configs);
      return ok(body, '配置保存成功');
    }
    if (method === 'DELETE') {
      const parts = url.pathname.split('/');
      const configId = decodeURIComponent(parts[parts.length - 1] || '');
      log('info', 'configs', `deleting config id=${configId}`);
      writeConfigs(configs.filter((c) => String(c.id) !== String(configId)));
      return ok({}, '配置删除成功');
    }
    return fail('不支持的请求方法', 405);
  }

  const nativeFetch = window.fetch.bind(window);

  async function fetchJsonOrText(response, scope) {
    const text = await response.text();
    try {
      const parsed = text ? JSON.parse(text) : {};
      log('info', scope, `response received status=${response.status}`, { ok: response.ok, body: redactSecrets(parsed) });
      return parsed;
    } catch (e) {
      log(response.ok ? 'warn' : 'error', scope, `response is not valid json status=${response.status}`, {
        ok: response.ok,
        preview: safePreview(text, 400),
      });
      return { detail: text || `HTTP ${response.status} ${response.statusText}` };
    }
  }

  async function callChatApi(config, payload, stream) {
    const chatUrl = config.api_base.replace(/\/$/, '') + '/chat/completions';
    log('info', 'chat', 'sending chat request', redactSecrets({
      url: chatUrl,
      model: payload.model,
      stream,
      messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
      max_tokens: payload.max_tokens,
    }));
    const response = await nativeFetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify(payload),
    });
    if (stream) {
      if (!response.ok) {
        const errorData = await fetchJsonOrText(response, 'chat-stream-error');
        const errorMessage = errorData?.detail || errorData?.error?.message || errorData?.message || `聊天流式请求失败 (${response.status})`;
        log('error', 'chat', `stream response status=${response.status}`, { ok: response.ok, errorMessage });
        throw new Error(errorMessage);
      }
      log('info', 'chat', `stream response status=${response.status}`, { ok: response.ok });
      return response;
    }
    const data = await fetchJsonOrText(response, 'chat');
    if (!response.ok) throw new Error(data?.detail || data?.error?.message || '聊天请求失败');
    return json(data);
  }

  async function handleChat(request) {
    const body = await getJsonBody(request);
    log('info', 'chat', 'handleChat received', { config_id: body.config_id || body.chat_config_id, stream: !!body.stream });
    const config = findConfig(body.config_id || body.chat_config_id);
    if (!config) return fail('配置不存在', 404);
    const payload = {
      model: config.model_name,
      messages: body.messages || [],
      temperature: body.temperature ?? 0.7,
      stream: !!body.stream,
      max_tokens: body.max_tokens || undefined,
    };
    try { return await callChatApi(config, payload, !!body.stream); }
    catch (e) {
      log('error', 'chat', 'handleChat failed', e);
      return fail(String(e.message || e), 500);
    }
  }

  async function handleChatSmart(request) {
    const body = await getJsonBody(request);
    log('info', 'chat-smart', 'handleChatSmart received', {
      chat_config_id: body.chat_config_id || body.config_id,
      image_config_id: body.image_config_id,
      hasFiles: Array.isArray(body.files || body.smart_files) && (body.files || body.smart_files).length > 0,
      stream: !!body.stream,
      messagePreview: safePreview(body.message || '', 100),
    });
    const chatConfig = findConfig(body.chat_config_id || body.config_id);
    if (!chatConfig) return fail('聊天配置不存在', 404);

    const text = String(body.message || '').trim();
    const imageConfig = findConfig(body.image_config_id);

    // Layer 1: fast-path pure chat (no LLM call needed)
    var simpleChatKeywords = ['你好','hi','hello','在吗','介绍一下','解释一下','帮我写','帮我改','翻译','润色','总结','怎么','为什么','如何','是什么','啥意思','代码','报错','排查','优化','修复','什么是','告诉我','请问','谢谢','好的','明白'];
    var isSimpleChat = !imageConfig || (text.length <= 80 && simpleChatKeywords.some(function(k) { return text.indexOf(k) >= 0 || text.toLowerCase().indexOf(k) >= 0; }));
    log('info', 'chat-smart', 'layer1 simple chat check', { isSimpleChat: isSimpleChat, textLen: text.length, hasImageConfig: !!imageConfig });

    if (!isSimpleChat) {
      // Layer 2: LLM classifier
      try {
        var classifierMessages = [
          { role: 'system', content: '你是任务路由器。根据用户最新输入判断任务类型，只能返回JSON，不要输出多余文字。\n任务类型: chat = 普通问答、写作、分析、翻译、代码讨论、生成提示词等; image = 明确要求生成/画/绘制一张具体的图片; file = 明确要求读取、总结、分析已上传文件内容。\n注意：如果用户要求"写一个提示词""生成提示词""描述一个画面"等，这是chat任务而非image任务。只有用户明确想要得到一张图片时才是image。\n如果是图片任务，根据用户描述提取：image_size(从用户指定的分辨率/比例推断，可选1024x1024/1536x1024/1024x1536/2048x2048/2048x1152/2160x3840/3840x2160，默认1024x1024)和image_count(用户指定的张数，1-4，默认1)。用户可能说横屏/竖屏/正方形/4K/2K等，请合理映射。\n输出格式: {"task_type":"chat|image|file","reason":"简短原因","rewritten_prompt":"如果是image给出优化提示词否则为空","image_size":"","image_count":1}' }
        ];
        var contextMsgs = (body.messages || []).slice(-6);
        classifierMessages = classifierMessages.concat(contextMsgs);
        classifierMessages.push({ role: 'user', content: text });

        var classifyUrl = chatConfig.api_base.replace(/\/$/, '') + '/chat/completions';
        log('info', 'chat-smart', 'calling LLM classifier', { url: classifyUrl, model: chatConfig.model_name });
        var classifyRes = await nativeFetch(classifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + chatConfig.api_key },
          body: JSON.stringify({ model: chatConfig.model_name, messages: classifierMessages, temperature: 0.1, stream: false, max_tokens: 200 }),
        });
        var classifyData = await fetchJsonOrText(classifyRes, 'chat-smart-classify');
        var classifyContent = String((classifyData.choices && classifyData.choices[0] && classifyData.choices[0].message && classifyData.choices[0].message.content) || '{}');
        var jsonMatch = classifyContent.match(/\{[\s\S]*\}/);
        var route = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
        log('info', 'chat-smart', 'classifier result', route);

        if (route.task_type === 'image' && imageConfig) {
          var prompt = route.rewritten_prompt || text;
          var sizeStr = route.image_size || '1024x1024';
          var sizeMatch = sizeStr.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/i);
          var width = sizeMatch ? Number(sizeMatch[1]) : 1024;
          var height = sizeMatch ? Number(sizeMatch[2]) : 1024;
          var imageCount = Math.max(1, Math.min(4, Number(route.image_count || 1)));
          var imageUrl = imageConfig.api_base.replace(/\/$/, '') + '/images/generations';
          log('info', 'chat-smart', 'routing to image generation via classifier', { prompt: prompt.slice(0, 60), width: width, height: height });
          var imgResponse = await nativeFetch(imageUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + imageConfig.api_key },
            body: JSON.stringify({ model: imageConfig.model_name, prompt: prompt, size: width + 'x' + height, n: imageCount }),
          });
          var imgRaw = await fetchJsonOrText(imgResponse, 'chat-smart-image');
          if (!imgResponse.ok) throw new Error(imgRaw.detail || (imgRaw.error && imgRaw.error.message) || '图片生成失败');
          var images = normalizeImageItems(imgRaw);
          return json({ code: 0, mode: 'image', data: { prompt: prompt, image_size: width + 'x' + height, image_count: images.length, images: images } });
        }
      } catch (classifyError) {
        log('warn', 'chat-smart', 'classifier failed, falling back to chat', classifyError);
      }
    }

    const payload = {
      model: chatConfig.model_name,
      messages: normalizeChatMessages(body.messages || [], body.files || body.smart_files || [], body.message || ""),
      temperature: body.temperature ?? 0.7,
      stream: !!body.stream,
      max_tokens: body.max_tokens || undefined,
    };

    try {
      return await callChatApi(chatConfig, payload, !!body.stream);
    } catch (e) {
      log('error', 'chat-smart', 'chat branch failed', e);
      return fail(String(e.message || e), 500);
    }
  }

  async function handleImage(request) {
    const body = await getJsonBody(request);
    log('info', 'image', 'handleImage received', {
      config_id: body.config_id || body.image_config_id,
      width: body.width,
      height: body.height,
      n: body.n,
      hasImageBase64: !!body.image_base64,
      imageBase64ListCount: Array.isArray(body.image_base64_list) ? body.image_base64_list.length : 0,
      promptPreview: safePreview(body.prompt || '', 120),
    });
    const config = findConfig(body.config_id || body.image_config_id);
    if (!config) return fail('配置不存在', 404);

    const size = `${body.width || 1024}x${body.height || 1024}`;
    const imageUrl = config.api_base.replace(/\/$/, '') + '/images/generations';
    const payload = {
      model: config.model_name,
      prompt: body.prompt || '',
      size,
      n: body.n || 1,
    };

    if (body.negative_prompt) payload.negative_prompt = body.negative_prompt;

    function ensureDataUrl(val) {
      if (!val) return '';
      const s = String(val).replace(/\s+/g, '');
      if (!s) return '';
      return s.startsWith('data:image') ? s : `data:image/png;base64,${s}`;
    }

    const refImages = (Array.isArray(body.image_base64_list) && body.image_base64_list.length)
      ? body.image_base64_list.map(ensureDataUrl).filter(Boolean)
      : (body.image_base64 ? [ensureDataUrl(body.image_base64)].filter(Boolean) : []);
    if (refImages.length > 1) payload.image = refImages;
    else if (refImages.length === 1) payload.image = refImages[0];

    try {
      log('info', 'image', 'sending image request', redactSecrets({ url: imageUrl, payload: { ...payload, image: payload.image ? '[base64]' : undefined, image_base64_list: payload.image_base64_list ? `[${payload.image_base64_list.length}]` : undefined } }));
      const response = await nativeFetch(imageUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}` },
        body: JSON.stringify(payload),
      });
      const raw = await fetchJsonOrText(response, 'image');
      if (!response.ok) throw new Error(raw?.detail || raw?.error?.message || '图片生成失败');
      const normalized = normalizeImageItems(raw);
      log('info', 'image', 'image generation normalized', { imageCount: normalized.length });
      return ok(normalized, '生成成功');
    } catch (e) {
      log('error', 'image', 'handleImage failed', e);
      return fail(String(e.message || e), 500);
    }
  }

  async function handleTest(request) {
    const body = await getJsonBody(request);
    const testUrl = body.config_type === 'image'
      ? body.api_base.replace(/\/$/, '') + '/images/generations'
      : body.api_base.replace(/\/$/, '') + '/chat/completions';
    const testPayload = body.config_type === 'image'
      ? { model: body.model_name, prompt: 'test', size: '1024x1024', n: 1 }
      : { model: body.model_name, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 };
    try {
      log('info', 'test', 'starting config test', redactSecrets({
        config_type: body.config_type,
        api_base: body.api_base,
        model_name: body.model_name,
        testUrl,
        payload: testPayload,
      }));
      const response = await nativeFetch(testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.api_key}` },
        body: JSON.stringify(testPayload),
      });
      const raw = await fetchJsonOrText(response, 'test');
      if (response.ok) return ok({}, '✅ 连接测试成功，配置可用');
      return fail(raw?.detail || raw?.error?.message || safePreview(raw, 300) || '连接失败，请检查配置');
    } catch (e) {
      log('error', 'test', 'config test failed', e);
      return fail(String(e.message || e));
    }
  }

  async function handleCanvasState(request) {
    const method = (request.method || 'GET').toUpperCase();
    log('info', 'canvas', `handleCanvasState method=${method}`);
    if (method === 'GET') return ok(readCanvasState());
    if (method === 'POST') {
      const body = await getJsonBody(request);
      const current = readCanvasState();
      const mergedCategories = Array.from(new Set([...(current.categories || []), ...deriveCategories(body.assetLibrary ?? current.assetLibrary)]));
      const next = writeCanvasState({
        sessions: body.sessions ?? current.sessions,
        assetLibrary: body.assetLibrary ?? current.assetLibrary,
        categories: mergedCategories,
      });
      return ok(next, '保存成功');
    }
    return fail('不支持的请求方法', 405);
  }

  function normalizeAssetPayload(body) {
    return {
      id: body.id || `asset_${Date.now()}`,
      title: body.title || body.name || '未命名素材',
      imageUrl: body.imageUrl || body.image_url || body.url || '',
      imageBase64: '',
      prompt: body.prompt || '',
      source: body.source || body.type || '素材',
      category: body.category || '未分类',
      createdAt: body.createdAt || new Date().toISOString(),
    };
  }

  async function handleCanvasAssets(request) {
    const method = (request.method || 'GET').toUpperCase();
    const state = readCanvasState();
    log('info', 'canvas-assets', `handleCanvasAssets method=${method}`, {
      assets: state.assetLibrary.length,
      categories: state.categories.length,
    });
    if (method === 'POST') {
      const body = await getJsonBody(request);
      const item = normalizeAssetPayload(body);
      state.assetLibrary.unshift(item);
      state.categories = Array.from(new Set([...(state.categories || []), ...deriveCategories(state.assetLibrary)]));
      writeCanvasState(state);
      return ok(item, '素材已保存');
    }
    if (method === 'DELETE') {
      const body = await getJsonBody(request);
      log('info', 'canvas-assets', 'deleting asset', { asset_id: body.asset_id });
      state.assetLibrary = state.assetLibrary.filter((item) => String(item.id) !== String(body.asset_id));
      state.categories = Array.from(new Set([...(state.categories || []), ...deriveCategories(state.assetLibrary)]));
      writeCanvasState(state);
      return ok({ assetLibrary: state.assetLibrary, categories: state.categories }, '素材已删除');
    }
    return fail('不支持的请求方法', 405);
  }

  async function handleCanvasCategories(request) {
    const method = (request.method || 'GET').toUpperCase();
    const state = readCanvasState();
    const body = await getJsonBody(request);
    log('info', 'canvas-categories', `handleCanvasCategories method=${method}`, {
      body: safePreview(body, 220),
      categories: state.categories,
    });
    if (method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name) return fail('分类名称不能为空');
      if (!state.categories.includes(name)) state.categories.push(name);
      writeCanvasState(state);
      return ok({ name, categories: state.categories, assetLibrary: state.assetLibrary }, '分类已创建');
    }
    if (method === 'PUT') {
      const oldName = String(body.old_name || '').trim();
      const newName = String(body.new_name || '').trim();
      if (!oldName || !newName) return fail('分类名称不能为空');
      state.categories = state.categories.map((name) => name === oldName ? newName : name);
      state.assetLibrary = state.assetLibrary.map((item) => ({ ...item, category: item.category === oldName ? newName : item.category }));
      writeCanvasState(state);
      return ok({ name: newName, categories: state.categories, assetLibrary: state.assetLibrary }, '分类已更新');
    }
    if (method === 'DELETE') {
      const name = String(body.name || '').trim();
      if (!name || name === '未分类') return fail('这个分类不能删除');
      state.assetLibrary = state.assetLibrary.filter((item) => item.category !== name);
      state.categories = state.categories.filter((c) => c !== name);
      writeCanvasState(state);
      return ok({ categories: state.categories, assetLibrary: state.assetLibrary }, '分类已删除');
    }
    return fail('不支持的请求方法', 405);
  }

  async function handleCanvasAssetsMove(request) {
    const body = await getJsonBody(request);
    const state = readCanvasState();
    const targetCategory = String(body.target_category || '未分类').trim() || '未分类';
    log('info', 'canvas-assets', 'moving asset', { asset_id: body.asset_id, targetCategory });
    state.assetLibrary = state.assetLibrary.map((item) => String(item.id) === String(body.asset_id) ? { ...item, category: targetCategory } : item);
    state.categories = Array.from(new Set([...(state.categories || []), ...deriveCategories(state.assetLibrary)]));
    writeCanvasState(state);
    return ok({ categories: state.categories, assetLibrary: state.assetLibrary }, '素材已移动');
  }

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input?.url || '';
    const request = input instanceof Request ? input : new Request(rawUrl, init);
    const url = normalizeRequestUrl(rawUrl || request.url);
    const pathname = url.pathname;
    log('info', 'router', `intercept fetch ${request.method || 'GET'} ${pathname}`);

    if (pathname === '/api/configs/test') return handleTest(request.clone());
    if (pathname === '/api/configs' || pathname === '/api/configs/') return handleConfigs(request.clone());
    if (pathname.startsWith('/api/configs/')) return handleConfigs(request.clone());
    if (pathname === '/api/chat' || pathname === '/api/chat/') return handleChat(request.clone());
    if (pathname === '/api/chat/smart' || pathname === '/api/chat/smart/') return handleChatSmart(request.clone());
    if (pathname === '/api/image/generate' || pathname === '/api/image/generate/') return handleImage(request.clone());
    if (pathname === '/api/canvas/state' || pathname === '/api/canvas/state/') return handleCanvasState(request.clone());
    if (pathname === '/api/canvas/assets' || pathname === '/api/canvas/assets/') return handleCanvasAssets(request.clone());
    if (pathname === '/api/canvas/categories' || pathname === '/api/canvas/categories/') return handleCanvasCategories(request.clone());
    if (pathname === '/api/canvas/assets/move' || pathname === '/api/canvas/assets/move/') return handleCanvasAssetsMove(request.clone());
    log('info', 'router', `passthrough native fetch ${request.method || 'GET'} ${pathname}`);
    return nativeFetch(input, init);
  };

  window.__LIUHUI_ANDROID__ = {
    readConfigs,
    writeConfigs,
    readCanvasState,
    writeCanvasState,
  };
})();
