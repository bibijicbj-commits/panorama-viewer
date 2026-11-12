const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const PORT_START = 4173;
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(os.tmpdir(), 'pano-viewer-cache');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const args = process.argv.slice(2).filter((arg) => arg !== '--no-open');
const DEFAULT_DIR = args[0] || 'E:\\小洋北\\全景 2026-10-26';
const noOpen = process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};

const locks = new Map();

function findFfmpeg() {
  try {
    const out = execFileSync('where.exe', ['ffmpeg'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const line = out
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item && !item.startsWith('INFO:'));
    if (line && fs.existsSync(line)) return line;
  } catch {
    // 没有 ffmpeg 时直接发送原图
  }
  return null;
}

const ffmpegBin = findFfmpeg();

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function attr(xml, key) {
  const token = `${key}="`;
  const start = xml.indexOf(token);
  if (start < 0) return '';
  const from = start + token.length;
  const end = xml.indexOf('"', from);
  return end < 0 ? '' : xml.slice(from, end);
}

function parseHead(buf) {
  const xml = buf.toString('utf8');
  const meta = {};
  const fields = {
    date: 'xmp:CreateDate',
    lat: 'drone-dji:GpsLatitude',
    lon: 'drone-dji:GpsLongitude',
    absAlt: 'drone-dji:AbsoluteAltitude',
    relAlt: 'drone-dji:RelativeAltitude',
    yaw: 'drone-dji:GimbalYawDegree',
    pitch: 'drone-dji:GimbalPitchDegree',
    model: 'tiff:Model',
    projection: 'GPano:ProjectionType',
  };
  for (const [key, name] of Object.entries(fields)) {
    const value = attr(xml, name);
    if (value) meta[key] = value;
  }

  let width = null;
  let height = null;
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) break;
      while (buf[i] === 0xff && i < buf.length) i += 1;
      if (i >= buf.length) break;
      const marker = buf[i];
      i += 1;
      if (marker === 0xd9) break;
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 1 >= buf.length) break;
      const len = buf.readUInt16BE(i);
      if (len < 2) break;
      if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && i + 6 < buf.length) {
        height = buf.readUInt16BE(i + 3);
        width = buf.readUInt16BE(i + 5);
        break;
      }
      i += len;
    }
  }
  return { width, height, meta };
}

function listImages(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    const error = new Error(`找不到这个文件夹：${abs}`);
    error.status = 404;
    throw error;
  }
  const images = [];
  for (const name of fs.readdirSync(abs)) {
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const full = path.join(abs, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let width = null;
    let height = null;
    let meta = {};
    if (ext === '.jpg' || ext === '.jpeg') {
      try {
        const parsed = parseHead(readHead(full));
        width = parsed.width;
        height = parsed.height;
        meta = parsed.meta;
      } catch {
        meta = {};
      }
    }
    images.push({
      name,
      path: full,
      size: st.size,
      mtime: st.mtimeMs,
      width,
      height,
      meta,
    });
  }
  images.sort((a, b) => {
    const da = a.meta.date || '';
    const db = b.meta.date || '';
    if (da && db && da !== db) return da < db ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
  return { dir: abs, images };
}

function targetSize(width, height, maxEdge) {
  const edge = Math.max(width, height);
  if (!width || !height || !maxEdge || edge <= maxEdge) return null;
  const scale = maxEdge / edge;
  return {
    tw: Math.max(2, Math.round((width * scale) / 2) * 2),
    th: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}

function lock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

function ffmpegResize(src, dest, tw, th) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegBin,
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-noautorotate',
        '-i',
        src,
        '-vf',
        `scale=${tw}:${th}:flags=lanczos`,
        '-q:v',
        '2',
        dest,
      ],
      { windowsHide: true }
    );
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 && fs.existsSync(dest) && fs.statSync(dest).size > 0) resolve(dest);
      else reject(new Error((err || `ffmpeg 退出码 ${code}`).trim()));
    });
  });
}

async function imageToServe(file, maxEdge) {
  const ext = path.extname(file).toLowerCase();
  if (!ffmpegBin || !maxEdge || (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png')) return file;
  const st = fs.statSync(file);
  const { width, height } = parseHead(readHead(file));
  const target = targetSize(width, height, maxEdge);
  if (!target) return file;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = crypto
    .createHash('sha1')
    .update(`${file}|${st.mtimeMs}|${st.size}|${target.tw}x${target.th}`)
    .digest('hex')
    .slice(0, 20);
  const dest = path.join(CACHE_DIR, `${key}.jpg`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  await lock(dest, async () => {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
    const tmp = `${dest}.${process.pid}.part.jpg`;
    try {
      await ffmpegResize(file, tmp, target.tw, target.th);
      fs.renameSync(tmp, dest);
      console.log(`预览 ${path.basename(file)} ${width}x${height} -> ${target.tw}x${target.th}`);
    } catch (error) {
      fs.rmSync(tmp, { force: true });
      console.error(`预览生成失败，改为发送原图：${error.message}`);
    }
  });
  return fs.existsSync(dest) ? dest : file;
}

function pipeFile(req, res, file, contentType, cache) {
  const st = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': st.size,
    'Cache-Control': cache,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  const stop = () => stream.destroy();
  res.on('close', stop);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

function resolveImage(raw) {
  if (!raw || raw.includes('\0')) {
    const error = new Error('请提供图片路径');
    error.status = 400;
    throw error;
  }
  const file = path.resolve(raw);
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_EXT.has(ext) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    const error = new Error('不是可查看的图片');
    error.status = 400;
    throw error;
  }
  return file;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, { dir: DEFAULT_DIR, ffmpeg: Boolean(ffmpegBin) });
    return;
  }

  if (pathname === '/api/list' && req.method === 'GET') {
    const dir = url.searchParams.get('dir') || DEFAULT_DIR;
    sendJson(res, 200, listImages(dir));
    return;
  }

  if (pathname === '/api/image' && (req.method === 'GET' || req.method === 'HEAD')) {
    const file = resolveImage(url.searchParams.get('path'));
    let maxEdge = Number(url.searchParams.get('max') || 0);
    if (!Number.isFinite(maxEdge) || maxEdge <= 0) maxEdge = 0;
    if (maxEdge > 16384) maxEdge = 16384;
    const served = await imageToServe(file, maxEdge);
    const type = MIME[path.extname(served).toLowerCase()] || 'application/octet-stream';
    pipeFile(req, res, served, type, 'public, max-age=86400');
    return;
  }

  const staticName = STATIC[pathname];
  if (staticName && (req.method === 'GET' || req.method === 'HEAD')) {
    pipeFile(req, res, path.join(PUBLIC_DIR, staticName), MIME[path.extname(staticName)], 'no-cache');
    return;
  }

  sendJson(res, 404, { error: '没有这个地址' });
}

function onRequest(req, res) {
  route(req, res).catch((error) => {
    if (res.headersSent) return;
    sendJson(res, error.status || 500, { error: error.message || '服务器错误' });
  });
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function listen(port) {
  const server = http.createServer(onRequest);
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE' && port < PORT_START + 20) {
      listen(port + 1);
      return;
    }
    console.error(error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`全景查看器已启动  ${url}`);
    console.log(`默认目录  ${DEFAULT_DIR}`);
    console.log(ffmpegBin ? `预览工具  ${ffmpegBin}` : '未找到 ffmpeg，将直接发送原图');
    console.log('关闭此窗口即停止查看器');
    if (!noOpen) openBrowser(url);
  });
}

listen(PORT_START);
