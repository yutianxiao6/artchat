// 全景图查看器：纯 WebGL 渲染 equirectangular 全景，支持鼠标拖拽 / 滚轮缩放 / 截图（单图 / 2x2 / 3x3）
// 通过 window.PanoramaViewer.open() / openWithImage(url) 入口暴露。
(function () {
  const VERTEX_SRC = `
    attribute vec2 a_pos;
    varying vec2 v_uv;
    void main(){
      v_uv = a_pos;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;

  const FRAGMENT_SRC = `
    precision highp float;
    uniform sampler2D u_tex;
    uniform float u_yaw;
    uniform float u_pitch;
    uniform float u_fov;
    uniform vec2 u_res;
    varying vec2 v_uv;
    const float PI = 3.14159265358979;
    void main(){
      float aspect = u_res.x / u_res.y;
      float t = tan(u_fov * 0.5);
      vec3 ray = normalize(vec3(v_uv.x * t * aspect, v_uv.y * t, -1.0));
      float cp = cos(u_pitch), sp = sin(u_pitch);
      ray = vec3(ray.x, cp * ray.y - sp * ray.z, sp * ray.y + cp * ray.z);
      float cy = cos(u_yaw), sy = sin(u_yaw);
      ray = vec3(cy * ray.x + sy * ray.z, ray.y, -sy * ray.x + cy * ray.z);
      float lon = atan(ray.x, -ray.z);
      float lat = asin(clamp(ray.y, -1.0, 1.0));
      float u = fract(lon / (2.0 * PI) + 0.5);
      float v = clamp(0.5 - lat / PI, 0.0, 1.0);
      gl_FragColor = texture2D(u_tex, vec2(u, v));
    }`;

  const STATE = {
    built: false,
    canvas: null,
    gl: null,
    program: null,
    posBuf: null,
    texture: null,
    image: null,
    yaw: 0,
    pitch: 0,
    fov: 75 * Math.PI / 180,
    minFov: 30 * Math.PI / 180,
    maxFov: 110 * Math.PI / 180,
    dragging: false,
    lastX: 0,
    lastY: 0,
    fileName: "",
    captureMode: "single",
    rafPending: false,
  };

  function ensureStyles() {
    if (document.getElementById("panorama-viewer-style")) return;
    const style = document.createElement("style");
    style.id = "panorama-viewer-style";
    style.textContent = `
      .pano-modal{position:fixed;inset:0;z-index:5000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(2,6,23,.86);backdrop-filter:blur(6px);}
      .pano-modal.hidden{display:none;}
      .pano-panel{position:relative;width:min(1280px,calc(100vw - 48px));height:min(820px,calc(100vh - 48px));background:#0f172a;border:1px solid rgba(148,163,184,.18);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;}
      .pano-toolbar{display:flex;align-items:center;gap:10px;padding:12px 16px;background:#111827;border-bottom:1px solid rgba(148,163,184,.14);flex-wrap:wrap;}
      .pano-toolbar .pano-title{font-size:14px;font-weight:700;color:#e5e7eb;display:flex;align-items:center;gap:8px;}
      .pano-toolbar .pano-filename{font-size:12px;color:#94a3b8;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
      .pano-toolbar .spacer{flex:1;}
      .pano-toolbar .pano-btn{padding:8px 12px;border-radius:10px;background:rgba(30,41,59,.95);color:#e2e8f0;border:1px solid rgba(148,163,184,.22);cursor:pointer;font-size:12px;display:inline-flex;align-items:center;gap:6px;}
      .pano-toolbar .pano-btn:hover{background:rgba(51,65,85,.95);}
      .pano-toolbar .pano-btn.primary{background:rgba(59,130,246,.22);border-color:rgba(96,165,250,.45);color:#dbeafe;}
      .pano-toolbar .pano-btn.danger{background:rgba(239,68,68,.18);border-color:rgba(248,113,113,.4);color:#fecaca;}
      .pano-toolbar select{padding:7px 10px;border-radius:10px;background:#0b1220;color:#e5e7eb;border:1px solid rgba(148,163,184,.22);font-size:12px;}
      .pano-stage{flex:1;position:relative;background:#000;overflow:hidden;}
      .pano-canvas{display:block;width:100%;height:100%;cursor:grab;}
      .pano-canvas.dragging{cursor:grabbing;}
      .pano-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#94a3b8;font-size:14px;pointer-events:none;}
      .pano-hint{position:absolute;left:16px;bottom:14px;color:#cbd5e1;font-size:11px;background:rgba(15,23,42,.7);padding:6px 10px;border-radius:8px;border:1px solid rgba(148,163,184,.2);pointer-events:none;}
      .pano-fov{display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:12px;}
      .pano-fov input[type=range]{width:120px;}
    `;
    document.head.appendChild(style);
  }

  function build() {
    if (STATE.built) return;
    ensureStyles();
    const root = document.createElement("div");
    root.className = "pano-modal hidden";
    root.id = "pano-modal";
    root.innerHTML = `
      <div class="pano-panel">
        <div class="pano-toolbar">
          <div class="pano-title"><i class="fa fa-globe"></i> 全景图查看器</div>
          <span class="pano-filename" id="pano-filename"></span>
          <button class="pano-btn primary" id="pano-pick-btn"><i class="fa fa-folder-open-o"></i> 选择文件</button>
          <input type="file" accept="image/*" hidden id="pano-file-input">
          <div class="pano-fov"><span>视场</span><input type="range" id="pano-fov-range" min="30" max="110" step="1" value="75"><span id="pano-fov-label">75°</span></div>
          <div class="spacer"></div>
          <select id="pano-capture-mode" title="截图模式">
            <option value="single">单张</option>
            <option value="2x2">2 × 2 四方位</option>
            <option value="3x3">3 × 3 九方位</option>
          </select>
          <button class="pano-btn" id="pano-save-canvas-btn" title="把当前截图作为节点放入画布"><i class="fa fa-plus-square-o"></i> 保存到画布</button>
          <button class="pano-btn" id="pano-capture-btn" title="把当前截图下载为 PNG"><i class="fa fa-download"></i> 下载</button>
          <button class="pano-btn danger" id="pano-close-btn"><i class="fa fa-times"></i> 关闭</button>
        </div>
        <div class="pano-stage">
          <canvas class="pano-canvas" id="pano-canvas"></canvas>
          <div class="pano-empty" id="pano-empty"><i class="fa fa-image" style="font-size:32px;opacity:.6;"></i><div>点击「选择文件」打开一张全景图（推荐 2:1 等距矩形）</div></div>
          <div class="pano-hint">拖拽：旋转 · 滚轮：缩放 · 截图模式：单张 / 2×2 / 3×3</div>
        </div>
      </div>`;
    document.body.appendChild(root);

    STATE.canvas = root.querySelector("#pano-canvas");
    bindEvents(root);
    STATE.built = true;
  }

  function bindEvents(root) {
    root.querySelector("#pano-close-btn").addEventListener("click", close);
    root.addEventListener("click", (e) => { if (e.target === root) close(); });
    root.querySelector("#pano-pick-btn").addEventListener("click", () => root.querySelector("#pano-file-input").click());
    root.querySelector("#pano-file-input").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadFromFile(file);
      e.target.value = "";
    });
    root.querySelector("#pano-fov-range").addEventListener("input", (e) => {
      const deg = Number(e.target.value);
      STATE.fov = deg * Math.PI / 180;
      root.querySelector("#pano-fov-label").textContent = `${deg}°`;
      requestRender();
    });
    root.querySelector("#pano-capture-mode").addEventListener("change", (e) => { STATE.captureMode = e.target.value; });
    root.querySelector("#pano-capture-btn").addEventListener("click", capture);
    root.querySelector("#pano-save-canvas-btn").addEventListener("click", saveToCanvas);

    const cv = STATE.canvas;
    cv.addEventListener("mousedown", (e) => { if (!STATE.image) return; STATE.dragging = true; STATE.lastX = e.clientX; STATE.lastY = e.clientY; cv.classList.add("dragging"); });
    window.addEventListener("mousemove", (e) => {
      if (!STATE.dragging) return;
      const dx = e.clientX - STATE.lastX;
      const dy = e.clientY - STATE.lastY;
      STATE.lastX = e.clientX; STATE.lastY = e.clientY;
      const sensitivity = STATE.fov / cv.clientHeight;
      STATE.yaw -= dx * sensitivity;
      STATE.pitch -= dy * sensitivity;
      const limit = Math.PI / 2 - 0.01;
      if (STATE.pitch > limit) STATE.pitch = limit;
      if (STATE.pitch < -limit) STATE.pitch = -limit;
      requestRender();
    });
    window.addEventListener("mouseup", () => { if (STATE.dragging) { STATE.dragging = false; cv.classList.remove("dragging"); } });
    cv.addEventListener("wheel", (e) => {
      if (!STATE.image) return;
      e.preventDefault();
      const next = STATE.fov + (e.deltaY > 0 ? 0.05 : -0.05);
      STATE.fov = Math.min(STATE.maxFov, Math.max(STATE.minFov, next));
      const range = root.querySelector("#pano-fov-range");
      const label = root.querySelector("#pano-fov-label");
      const deg = Math.round(STATE.fov * 180 / Math.PI);
      if (range) range.value = String(deg);
      if (label) label.textContent = `${deg}°`;
      requestRender();
    }, { passive: false });

    window.addEventListener("resize", () => { if (!isOpen()) return; resizeCanvas(); requestRender(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) close(); });
  }

  function ensureGL() {
    if (STATE.gl) return STATE.gl;
    const gl = STATE.canvas.getContext("webgl", { preserveDrawingBuffer: true }) || STATE.canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
    if (!gl) { alert("当前浏览器不支持 WebGL，无法显示全景图"); return null; }
    STATE.gl = gl;

    const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
    if (!vs || !fs) { console.error("[panorama] shader 编译失败，终止初始化"); return null; }
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("[panorama] program link failed", gl.getProgramInfoLog(program));
      return null;
    }
    STATE.program = program;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    STATE.posBuf = buf;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // wrap 模式延后到 uploadTexture 根据图片是否 POT 来设
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    STATE.texture = tex;
    return gl;
  }

  function compileShader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error("[panorama] shader compile failed", gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  }

  function isPowerOfTwo(x) { return x > 0 && (x & (x - 1)) === 0; }

  function uploadTexture(image) {
    const gl = ensureGL();
    if (!gl) return;
    gl.bindTexture(gl.TEXTURE_2D, STATE.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } catch (e) {
      console.error("[panorama] texImage2D 失败（可能是跨域图片未带 CORS 头）", e);
      return;
    }
    // POT 才允许 REPEAT；NPOT 必须用 CLAMP_TO_EDGE，否则采样全黑
    const pot = isPowerOfTwo(image.naturalWidth || image.width) && isPowerOfTwo(image.naturalHeight || image.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, pot ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    STATE.textureWrapRepeat = pot;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) console.warn("[panorama] gl error after upload:", err);
  }

  function resizeCanvas() {
    const cv = STATE.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(cv.clientWidth * dpr));
    const h = Math.max(1, Math.floor(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  }

  function render() {
    const gl = ensureGL();
    if (!gl || !STATE.image) return;
    const cv = STATE.canvas;
    if (cv.width <= 1 || cv.height <= 1) return; // 容器尺寸还没就绪，跳过
    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(STATE.program);
    const aPos = gl.getAttribLocation(STATE.program, "a_pos");
    gl.bindBuffer(gl.ARRAY_BUFFER, STATE.posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, STATE.texture);
    gl.uniform1i(gl.getUniformLocation(STATE.program, "u_tex"), 0);
    gl.uniform1f(gl.getUniformLocation(STATE.program, "u_yaw"), STATE.yaw);
    gl.uniform1f(gl.getUniformLocation(STATE.program, "u_pitch"), STATE.pitch);
    gl.uniform1f(gl.getUniformLocation(STATE.program, "u_fov"), STATE.fov);
    gl.uniform2f(gl.getUniformLocation(STATE.program, "u_res"), cv.width, cv.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function requestRender() {
    if (STATE.rafPending) return;
    STATE.rafPending = true;
    requestAnimationFrame(() => { STATE.rafPending = false; render(); });
  }

  function loadFromFile(file) {
    STATE.fileName = file.name || "panorama";
    const url = URL.createObjectURL(file);
    loadFromUrl(url, () => URL.revokeObjectURL(url));
  }

  function loadFromUrl(url, done) {
    const img = new Image();
    // data URL / blob URL 同源，不应设 crossOrigin（部分浏览器会因此拒绝加载）
    if (typeof url === "string" && !/^(data:|blob:)/i.test(url)) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => {
      console.log("[panorama] 图片加载成功", { url: String(url).slice(0, 80), w: img.naturalWidth, h: img.naturalHeight });
      STATE.image = img;
      const empty = document.getElementById("pano-empty");
      if (empty) empty.style.display = "none";
      const fnEl = document.getElementById("pano-filename");
      if (fnEl) fnEl.textContent = STATE.fileName || "全景图";
      ensureGL();
      uploadTexture(img);
      // 容器可能还没拿到尺寸，多帧重试
      let retry = 0;
      const tick = () => {
        resizeCanvas();
        if (STATE.canvas.width > 1 && STATE.canvas.height > 1) {
          requestRender();
        } else if (retry++ < 30) {
          requestAnimationFrame(tick);
        } else {
          console.warn("[panorama] canvas 尺寸始终为 0，渲染跳过", { clientW: STATE.canvas.clientWidth, clientH: STATE.canvas.clientHeight });
        }
      };
      requestAnimationFrame(tick);
      if (typeof done === "function") done();
    };
    img.onerror = (e) => {
      console.error("[panorama] 图片加载失败", url, e);
      alert("图片加载失败（可能是跨域或路径错误）");
      if (typeof done === "function") done();
    };
    img.src = url;
  }

  // 临时改 canvas 尺寸渲染指定视角，返回截图后的 dataURL
  async function renderViewToDataURL(yaw, pitch, fov, w, h) {
    const cv = STATE.canvas;
    const oldW = cv.width, oldH = cv.height;
    const oldYaw = STATE.yaw, oldPitch = STATE.pitch, oldFov = STATE.fov;
    cv.width = w; cv.height = h;
    STATE.yaw = yaw; STATE.pitch = pitch; STATE.fov = fov;
    render();
    const dataUrl = cv.toDataURL("image/png");
    cv.width = oldW; cv.height = oldH;
    STATE.yaw = oldYaw; STATE.pitch = oldPitch; STATE.fov = oldFov;
    render();
    return dataUrl;
  }

  function loadDataUrlAsImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = dataUrl;
    });
  }

  async function captureGrid(views, cols, rows, cellW, cellH) {
    const out = document.createElement("canvas");
    out.width = cellW * cols;
    out.height = cellH * rows;
    const ctx = out.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, out.width, out.height);
    for (let i = 0; i < views.length; i++) {
      const v = views[i];
      const dataUrl = await renderViewToDataURL(v.yaw, v.pitch, v.fov, cellW, cellH);
      const img = await loadDataUrlAsImage(dataUrl);
      const r = Math.floor(i / cols);
      const c = i % cols;
      ctx.drawImage(img, c * cellW, r * cellH, cellW, cellH);
    }
    return out.toDataURL("image/png");
  }

  async function produceCapture() {
    if (!STATE.image) { alert("请先加载一张全景图"); return null; }
    const mode = STATE.captureMode;
    if (mode === "2x2") {
      const fov = 90 * Math.PI / 180;
      const yaws = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
      const views = yaws.map((y) => ({ yaw: y, pitch: 0, fov }));
      return { dataUrl: await captureGrid(views, 2, 2, 1024, 1024), suffix: "2x2" };
    }
    if (mode === "3x3") {
      const fov = 80 * Math.PI / 180;
      const yaws = [-Math.PI / 2, 0, Math.PI / 2];
      const pitches = [Math.PI / 4, 0, -Math.PI / 4];
      const views = [];
      for (const p of pitches) for (const y of yaws) views.push({ yaw: y, pitch: p, fov });
      return { dataUrl: await captureGrid(views, 3, 3, 768, 768), suffix: "3x3" };
    }
    const cv = STATE.canvas;
    const w = Math.max(1280, cv.width);
    const h = Math.max(720, Math.round(w * cv.height / Math.max(1, cv.width)));
    return { dataUrl: await renderViewToDataURL(STATE.yaw, STATE.pitch, STATE.fov, w, h), suffix: "single" };
  }

  async function capture() {
    const r = await produceCapture();
    if (!r) return;
    download(r.dataUrl, `panorama-${r.suffix}-${Date.now()}.png`);
  }

  async function saveToCanvas() {
    if (!window.ImageCanvas || typeof window.ImageCanvas.addImageNodeFromDataUrl !== "function") {
      alert("画布未就绪，请先打开图片画布页签后再试");
      return;
    }
    const r = await produceCapture();
    if (!r) return;
    const baseName = (STATE.fileName || "全景图").replace(/\.[^.]+$/, "");
    const title = `${baseName}·${r.suffix}`;
    try {
      const nodeId = await window.ImageCanvas.addImageNodeFromDataUrl(r.dataUrl, { title, mime: "image/png" });
      if (!nodeId) { alert("保存到画布失败：返回为空"); return; }
      console.log("[panorama] 已保存到画布", { nodeId, title });
    } catch (e) {
      console.error("[panorama] 保存到画布失败", e);
      alert("保存到画布失败：" + (e.message || e));
    }
  }

  function download(dataUrl, name) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function isOpen() {
    const root = document.getElementById("pano-modal");
    return Boolean(root && !root.classList.contains("hidden"));
  }

  function open() {
    build();
    const root = document.getElementById("pano-modal");
    root.classList.remove("hidden");
    requestAnimationFrame(() => { resizeCanvas(); if (STATE.image) requestRender(); });
  }

  function close() {
    const root = document.getElementById("pano-modal");
    if (root) root.classList.add("hidden");
  }

  function openWithImage(urlOrFile, fileName) {
    open();
    if (fileName) STATE.fileName = fileName;
    if (typeof urlOrFile === "string") loadFromUrl(urlOrFile);
    else if (urlOrFile instanceof Blob) loadFromFile(urlOrFile);
  }

  window.PanoramaViewer = { open, close, openWithImage };
})();
