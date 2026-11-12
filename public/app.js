const DEFAULT_FOV = 70;
const DEFAULT_PITCH = -18;

const canvas = document.getElementById('view');
const dirForm = document.getElementById('dir-form');
const dirInput = document.getElementById('dir');
const countEl = document.getElementById('count');
const listEl = document.getElementById('list');
const errorEl = document.getElementById('error');
const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const loadingBar = document.getElementById('loading-bar');
const shotName = document.getElementById('shot-name');
const detailEl = document.getElementById('detail');
const anglesEl = document.getElementById('angles');
const fovInput = document.getElementById('fov');
const fovVal = document.getElementById('fov-val');
const qualityEl = document.getElementById('quality');
const autoBtn = document.getElementById('auto');

const gl = canvas.getContext('webgl2', {
  alpha: false,
  antialias: false,
  powerPreference: 'high-performance',
});

const state = {
  dir: '',
  images: [],
  index: -1,
  yaw: 0,
  pitch: deg(DEFAULT_PITCH),
  fov: deg(DEFAULT_FOV),
  auto: false,
  dragging: false,
  velYaw: 0,
  velPitch: 0,
  texture: null,
  maxEdge: 8192,
  token: 0,
  shown: null,
  ffmpeg: true,
};

const keys = new Set();
let controller = null;
let pinchDist = 0;
let lastHud = 0;
let viewW = 0;
let viewH = 0;

function deg(value) {
  return (value * Math.PI) / 180;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function wrapPi(angle) {
  const turn = Math.PI * 2;
  return (((angle + Math.PI) % turn) + turn) % turn - Math.PI;
}

function formatBytes(size) {
  if (!size) return '';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function shortDate(value) {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : '';
}

function setError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || '';
}

function showLoading(text) {
  loadingEl.hidden = false;
  loadingText.textContent = text;
  loadingBar.style.width = '0%';
}

function hideLoading() {
  loadingEl.hidden = true;
}

function showMessage(text) {
  listEl.replaceChildren();
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  listEl.append(p);
}

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || '着色器编译失败');
  }
  return shader;
}

let program;
let quad;
const loc = {};
let anisoExt = null;

function initGl() {
  if (!gl) return false;
  const vs = compile(gl.VERTEX_SHADER, `#version 300 es
    in vec2 aPos;
    out vec2 vClip;
    void main() {
      vClip = aPos;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `);
  const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    in vec2 vClip;
    uniform sampler2D uTex;
    uniform vec3 uForward;
    uniform vec3 uRight;
    uniform vec3 uUp;
    uniform float uTanHalfFov;
    uniform float uAspect;
    out vec4 oColor;
    const float PI = 3.141592653589793;
    void main() {
      vec3 rd = normalize(
        uForward
        + uRight * (vClip.x * uTanHalfFov * uAspect)
        + uUp * (vClip.y * uTanHalfFov)
      );
      float lon = atan(rd.x, rd.z);
      float lat = asin(clamp(rd.y, -1.0, 1.0));
      // ImageBitmap 上传不翻转，v=0 是图片顶部（天空）。
      oColor = texture(uTex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
    }
  `);
  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || '程序链接失败');
  }
  loc.forward = gl.getUniformLocation(program, 'uForward');
  loc.right = gl.getUniformLocation(program, 'uRight');
  loc.up = gl.getUniformLocation(program, 'uUp');
  loc.tanHalf = gl.getUniformLocation(program, 'uTanHalfFov');
  loc.aspect = gl.getUniformLocation(program, 'uAspect');
  loc.tex = gl.getUniformLocation(program, 'uTex');
  quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1, 1, 1,
  ]), gl.STATIC_DRAW);
  anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
  gl.clearColor(0.063, 0.075, 0.09, 1);
  gl.disable(gl.DEPTH_TEST);
  return true;
}

function cameraBasis(yaw, pitch) {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  return {
    forward: [sy * cp, sp, cy * cp],
    right: [cy, 0, -sy],
    up: [-sy * sp, cp, -cy * sp],
  };
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (w !== viewW || h !== viewH) {
    canvas.width = w;
    canvas.height = h;
    viewW = w;
    viewH = h;
  }
}

function render() {
  if (!gl) return;
  resize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!state.texture) return;
  const basis = cameraBasis(state.yaw, state.pitch);
  gl.useProgram(program);
  gl.uniform3fv(loc.forward, basis.forward);
  gl.uniform3fv(loc.right, basis.right);
  gl.uniform3fv(loc.up, basis.up);
  gl.uniform1f(loc.tanHalf, Math.tan(state.fov * 0.5));
  gl.uniform1f(loc.aspect, canvas.width / canvas.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  gl.uniform1i(loc.tex, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateHud() {
  const yaw = Math.round((wrapPi(state.yaw) * 180) / Math.PI);
  const pitch = Math.round((state.pitch * 180) / Math.PI);
  const fov = Math.round((state.fov * 180) / Math.PI);
  anglesEl.textContent = `转向 ${yaw}°   俯仰 ${pitch}°`;
  if (document.activeElement !== fovInput) fovInput.value = String(fov);
  fovVal.textContent = `${fov}°`;
}

function clearTexture() {
  if (state.texture && gl) gl.deleteTexture(state.texture);
  state.texture = null;
  state.shown = null;
  shotName.textContent = '尚未打开图片';
  detailEl.textContent = '';
  detailEl.classList.remove('copyable');
  delete detailEl.dataset.copy;
}

function uploadTexture(bitmap) {
  gl.getError();
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (anisoExt) {
    const max = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
  if (gl.getError() !== gl.NO_ERROR) {
    gl.deleteTexture(tex);
    throw new Error('显存不足，请把清晰度改为「流畅」后再打开。');
  }
  const prev = state.texture;
  state.texture = tex;
  if (prev) gl.deleteTexture(prev);
}

async function limitBitmap(bitmap) {
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  if (bitmap.width <= maxTex && bitmap.height <= maxTex) return bitmap;
  const scale = maxTex / Math.max(bitmap.width, bitmap.height);
  const resized = await createImageBitmap(bitmap, {
    resizeWidth: Math.max(2, Math.round(bitmap.width * scale)),
    resizeHeight: Math.max(2, Math.round(bitmap.height * scale)),
    resizeQuality: 'high',
  });
  bitmap.close();
  return resized;
}

function imageUrl(img) {
  const query = new URLSearchParams({
    path: img.path,
    max: String(state.maxEdge),
    v: String(Math.round(img.mtime || 0)),
  });
  return `/api/image?${query}`;
}

async function fetchBlob(url, signal, onProgress) {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let message = '图片读取失败';
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // 响应体不是 JSON
    }
    throw new Error(message);
  }
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  return new Blob(chunks, { type: res.headers.get('Content-Type') || 'image/jpeg' });
}

function formatDetail(img, shown) {
  const parts = [];
  const when = shortDate(img.meta?.date);
  if (when) parts.push(when);
  if (img.meta?.model) parts.push(img.meta.model);
  const rel = Number(img.meta?.relAlt);
  const abs = Number(img.meta?.absAlt);
  if (Number.isFinite(rel)) parts.push(`相对高度 ${rel.toFixed(0)} m`);
  if (Number.isFinite(abs)) parts.push(`海拔 ${abs.toFixed(0)} m`);
  const lat = Number(img.meta?.lat);
  const lon = Number(img.meta?.lon);
  let copy = '';
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    parts.push(`${Math.abs(lat).toFixed(6)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(6)}°${lon >= 0 ? 'E' : 'W'}`);
    copy = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  }
  if (img.width && img.height) {
    const ratio = img.width / img.height;
    const sizeText = shown
      ? `画面 ${shown.width}×${shown.height}（原图 ${img.width}×${img.height}）`
      : `${img.width}×${img.height}`;
    parts.push(sizeText);
    if (img.meta?.projection && img.meta.projection !== 'equirectangular') {
      parts.push('不是等距圆柱投影');
    } else if (Math.abs(ratio - 2) > 0.08) {
      parts.push('宽高比不是 2:1');
    }
  }
  detailEl.textContent = parts.join(' · ');
  detailEl.dataset.copy = copy;
  detailEl.classList.toggle('copyable', Boolean(copy));
  detailEl.title = copy ? '点击复制坐标' : '';
}

function renderList() {
  listEl.replaceChildren();
  if (!state.images.length) {
    showMessage('这个文件夹里没有 jpg、png 或 webp 图片。');
    return;
  }
  state.images.forEach((img, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `item${index === state.index ? ' active' : ''}`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = img.name.replace(/\.[^.]+$/, '');
    const sub = document.createElement('span');
    sub.className = 'sub';
    const bits = [];
    const when = shortDate(img.meta?.date);
    if (when) bits.push(when.slice(11) || when);
    const rel = Number(img.meta?.relAlt);
    if (Number.isFinite(rel)) bits.push(`${rel.toFixed(0)} m`);
    bits.push(formatBytes(img.size));
    sub.textContent = bits.join(' · ');
    btn.append(name, sub);
    btn.addEventListener('click', () => {
      openIndex(index).catch((error) => setError(error.message));
    });
    listEl.append(btn);
  });
  listEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

function markActive() {
  [...listEl.querySelectorAll('.item')].forEach((el, index) => {
    el.classList.toggle('active', index === state.index);
  });
  listEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

async function openIndex(index) {
  if (!state.images.length || !gl) return;
  state.index = (index + state.images.length) % state.images.length;
  state.velYaw = 0;
  state.velPitch = 0;
  markActive();
  const img = state.images[state.index];
  const my = ++state.token;
  controller?.abort();
  controller = new AbortController();
  shotName.textContent = `${state.index + 1} / ${state.images.length}  ${img.name.replace(/\.[^.]+$/, '')}`;
  document.title = `${img.name.replace(/\.[^.]+$/, '')} · 全景查看器`;
  formatDetail(img, null);
  setError('');
  showLoading(state.ffmpeg ? '正在准备画面…' : '正在读取原图…');
  try {
    const blob = await fetchBlob(imageUrl(img), controller.signal, (loaded, total) => {
      if (my !== state.token) return;
      if (!total) {
        loadingText.textContent = '正在下载…';
        return;
      }
      loadingText.textContent = `正在下载 ${formatBytes(loaded)} / ${formatBytes(total)}`;
      loadingBar.style.width = `${Math.round((loaded / total) * 100)}%`;
    });
    if (my !== state.token) return;
    loadingText.textContent = '正在解码…';
    let bitmap = await createImageBitmap(blob);
    if (my !== state.token) {
      bitmap.close();
      return;
    }
    bitmap = await limitBitmap(bitmap);
    if (my !== state.token) {
      bitmap.close();
      return;
    }
    const shown = { width: bitmap.width, height: bitmap.height };
    uploadTexture(bitmap);
    bitmap.close();
    state.shown = shown;
    formatDetail(img, shown);
    hideLoading();
    warm(state.index + 1);
  } catch (error) {
    if (error.name === 'AbortError' || my !== state.token) return;
    hideLoading();
    setError(error.message || '无法打开这张全景图');
  }
}

function warm(index) {
  const img = state.images[index];
  if (!img) return;
  fetch(imageUrl(img)).catch(() => {});
}

async function loadDir(dir) {
  const query = new URLSearchParams({ dir: dir.trim() });
  const res = await fetch(`/api/list?${query}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '无法打开文件夹');
  state.dir = data.dir;
  state.images = data.images;
  state.index = -1;
  dirInput.value = data.dir;
  localStorage.setItem('pano-dir', data.dir);
  countEl.textContent = data.images.length ? `${data.images.length} 张` : '没有图片';
  renderList();
  if (!data.images.length) {
    clearTexture();
    return;
  }
  await openIndex(0);
}

function resetView() {
  state.yaw = 0;
  state.pitch = deg(DEFAULT_PITCH);
  state.fov = deg(DEFAULT_FOV);
  state.velYaw = 0;
  state.velPitch = 0;
}

function setAuto(on) {
  state.auto = on;
  autoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

function bind() {
  dirForm.addEventListener('submit', (event) => {
    event.preventDefault();
    loadDir(dirInput.value).catch((error) => {
      showMessage(error.message);
      setError(error.message);
    });
  });

  document.getElementById('toggle-list').addEventListener('click', () => {
    document.body.classList.toggle('list-hidden');
    const hidden = document.body.classList.contains('list-hidden');
    document.getElementById('toggle-list').textContent = hidden ? '显示图集' : '隐藏图集';
  });
  document.getElementById('prev').addEventListener('click', () => openIndex(state.index - 1));
  document.getElementById('next').addEventListener('click', () => openIndex(state.index + 1));
  document.getElementById('level').addEventListener('click', () => {
    state.pitch = 0;
  });
  document.getElementById('down').addEventListener('click', () => {
    state.pitch = deg(-62);
  });
  document.getElementById('reset').addEventListener('click', resetView);
  autoBtn.addEventListener('click', () => setAuto(!state.auto));
  document.getElementById('full').addEventListener('click', () => {
    toggleFullscreen().catch(() => setError('无法进入全屏'));
  });
  fovInput.addEventListener('input', () => {
    state.fov = deg(Number(fovInput.value));
    fovVal.textContent = `${fovInput.value}°`;
  });
  qualityEl.addEventListener('change', () => {
    state.maxEdge = Number(qualityEl.value);
    localStorage.setItem('pano-quality', qualityEl.value);
    if (state.index >= 0) openIndex(state.index);
  });
  detailEl.addEventListener('click', async () => {
    if (!detailEl.dataset.copy) return;
    try {
      await navigator.clipboard.writeText(detailEl.dataset.copy);
      const old = detailEl.title;
      detailEl.title = '坐标已复制';
      setTimeout(() => {
        detailEl.title = old;
      }, 1200);
    } catch {
      setError('复制坐标失败');
    }
  });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    state.dragging = true;
    state.velYaw = 0;
    state.velPitch = 0;
    canvas.classList.add('dragging');
    canvas.dataset.x = String(event.clientX);
    canvas.dataset.y = String(event.clientY);
    canvas.dataset.t = String(performance.now());
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!state.dragging) return;
    const x = Number(canvas.dataset.x);
    const y = Number(canvas.dataset.y);
    const t = Number(canvas.dataset.t);
    const now = performance.now();
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    const sens = state.fov / Math.max(1, canvas.clientHeight);
    state.yaw += -dx * sens;
    state.pitch = clamp(state.pitch + dy * sens, -1.52, 1.52);
    const dt = Math.max(0.008, (now - t) / 1000);
    state.velYaw = (-dx * sens) / dt;
    state.velPitch = (dy * sens) / dt;
    canvas.dataset.x = String(event.clientX);
    canvas.dataset.y = String(event.clientY);
    canvas.dataset.t = String(now);
  });
  const endDrag = () => {
    state.dragging = false;
    canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => {
    toggleFullscreen().catch(() => {});
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    state.fov = clamp(state.fov * Math.exp(event.deltaY * 0.001), deg(35), deg(110));
  }, { passive: false });
  canvas.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      const [a, b] = event.touches;
      pinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', (event) => {
    if (event.touches.length !== 2 || !pinchDist) return;
    const [a, b] = event.touches;
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    state.fov = clamp(state.fov * (pinchDist / dist), deg(35), deg(110));
    pinchDist = dist;
  }, { passive: true });

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof Element && event.target.closest('input, select, textarea, button')) return;
    const look = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
      KeyA: 'left',
      KeyD: 'right',
      KeyW: 'up',
      KeyS: 'down',
    }[event.code];
    if (look) {
      keys.add(look);
      event.preventDefault();
    } else if (event.code === 'KeyN' || event.code === 'PageDown') {
      openIndex(state.index + 1);
    } else if (event.code === 'KeyP' || event.code === 'PageUp') {
      openIndex(state.index - 1);
    } else if (event.code === 'Space') {
      setAuto(!state.auto);
      event.preventDefault();
    } else if (event.code === 'KeyF') {
      toggleFullscreen().catch(() => {});
    } else if (event.code === 'KeyR') {
      resetView();
    }
  });
  window.addEventListener('keyup', (event) => {
    const look = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
      KeyA: 'left',
      KeyD: 'right',
      KeyW: 'up',
      KeyS: 'down',
    }[event.code];
    if (look) keys.delete(look);
  });
  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    state.texture = null;
    setError('显卡重置了画面，请重新选择一张图。');
  });
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!state.dragging) {
    state.yaw += state.velYaw * dt;
    state.pitch = clamp(state.pitch + state.velPitch * dt, -1.52, 1.52);
    const decay = Math.exp(-7 * dt);
    state.velYaw *= decay;
    state.velPitch *= decay;
    if (Math.abs(state.velYaw) < 0.01) state.velYaw = 0;
    if (Math.abs(state.velPitch) < 0.01) state.velPitch = 0;
  }
  if (state.auto && !state.dragging) state.yaw += dt * 0.12;
  const turn = state.fov * 0.7;
  if (keys.has('left')) state.yaw -= dt * turn;
  if (keys.has('right')) state.yaw += dt * turn;
  if (keys.has('up')) state.pitch = clamp(state.pitch + dt * turn, -1.52, 1.52);
  if (keys.has('down')) state.pitch = clamp(state.pitch - dt * turn, -1.52, 1.52);
  state.yaw = wrapPi(state.yaw);
  render();
  if (now - lastHud > 100) {
    updateHud();
    lastHud = now;
  }
  requestAnimationFrame(frame);
}

async function boot() {
  const savedQ = localStorage.getItem('pano-quality');
  if (savedQ === '4096' || savedQ === '8192' || savedQ === '16384') {
    qualityEl.value = savedQ;
    state.maxEdge = Number(savedQ);
  }
  const config = await fetch('/api/config').then((res) => res.json());
  state.ffmpeg = Boolean(config.ffmpeg);
  const queryDir = new URLSearchParams(location.search).get('dir');
  const dir = queryDir || localStorage.getItem('pano-dir') || config.dir || '';
  dirInput.value = dir;
  if (!gl) {
    setError('这个浏览器不支持 WebGL2，请换用 Chrome 或 Edge。');
    if (dir) {
      await loadDir(dir).catch((error) => showMessage(error.message));
    }
    return;
  }
  initGl();
  bind();
  requestAnimationFrame(frame);
  if (dir) await loadDir(dir);
}

boot().catch((error) => {
  showMessage(error.message || '启动失败');
  setError(error.message || '启动失败');
});
