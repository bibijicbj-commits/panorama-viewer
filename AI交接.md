# 全景查看器 AI 交接

给下一位接手这个仓库的人。先读完「不要改反的两处」，再动渲染或拖拽。

## 这是什么

本机全景查看器。Node 标准库起一个只监听 `127.0.0.1` 的 HTTP 服务，浏览器打开 `public/` 里的页面，用 WebGL2 把等距圆柱全景贴到视角上。没有 npm 依赖，没有构建步骤。

开发时的试看目录是 `E:\小洋北\全景 2026-10-26`，里面是大疆 M3D 的 JPEG，约 14400×7200，二十张，每张约 30 MB。这些图不在仓库里，换机器后这个默认路径不存在。启动参数可以改默认目录：`node server.js "目录"`。`--no-open` 不自动开浏览器。

## 怎么跑

1. 安装 Node.js。预览大图需要 ffmpeg 在 `PATH` 里（Windows 用 `where.exe ffmpeg`）。
2. 双击 `启动查看器.bat`，或 `node server.js`。
3. 端口从 4173 开始，被占用就加一，最多试到 4192。只绑定 `127.0.0.1`。
4. 关掉弹出的命令行窗口，服务就停。浏览器会显示无法连接。

清晰度三档：流畅 4096、标准 8192、原图 16384。记在 `localStorage` 键 `pano-quality`。当前文件夹记在 `pano-dir`。地址栏 `?dir=` 优先于这两项。

ffmpeg 预览缓存在系统临时目录 `pano-viewer-cache`，按「路径 + 修改时间 + 大小 + 目标尺寸」做文件名。缩放用 lanczos，`-q:v 2`，并且 `-noautorotate`。没有 ffmpeg、生成失败、或图已经不大于目标边长时，直接发原图。

## 不要改反的两处

这两处都曾按「看起来更标准」的写法改过，结果用户看到的是反的。按当前符号保留。

**天空在上。** `public/app.js` 的片元着色器里，纬度到纹理 V 是 `0.5 - lat / PI`。`createImageBitmap` 再交给 `texImage2D` 时，WebGL 会忽略 `UNPACK_FLIP_Y_WEBGL`，所以纹理 `v = 0` 是图片顶部。这批大疆图的顶部是天空。改回 `lat / PI + 0.5` 会上下颠倒。`uploadTexture` 里那句 `UNPACK_FLIP_Y_WEBGL = true` 对 ImageBitmap 不起作用，不要靠它纠正方向。

**拖动跟着画面走。** `pointermove` 里 `pitch += dy * sens`，惯性 `velPitch` 同号。手指向下拖，俯仰增加，视线抬高，画面内容向下移动。水平是 `yaw += -dx`。键盘上方向键和 `W` 仍然是增加俯仰（抬头），和拖动不是同一套符号，不要为了和拖动一致去改键盘。

俯仰限制约 ±87°（`±1.52` 弧度）。默认视野 70°，默认俯仰 -18°。平视按钮把俯仰打到 0，俯视打到 -62°。

## 文件

| 文件 | 作用 |
| --- | --- |
| `server.js` | 列目录、读大疆 XMP、按需 ffmpeg 缩小、把图和静态页送出去 |
| `public/index.html` | 页面骨架 |
| `public/app.js` | 列表、加载、WebGL 视角、键鼠 |
| `public/style.css` | 界面 |
| `启动查看器.bat` | 检查 `node` 再启动，失败时 `pause` |
| `package.json` | 名字和 `npm start`，没有依赖 |

## 接口

都在本机。

- `GET /api/config` → `{ dir, ffmpeg }`
- `GET /api/list?dir=` → `{ dir, images }`。只扫这一层，不进子目录。扩展名：jpg、jpeg、png、webp、bmp。JPEG 才解析宽高和 XMP。按拍摄时间排序，没有时间则按中文文件名。
- `GET|HEAD /api/image?path=&max=&v=` → 图片字节。`path` 必须是已存在的图片文件。`max` 最大按 16384 截断。静态页带 `no-cache`，缩略结果缓存一天。
- `GET /`、`/index.html`、`/app.js`、`/style.css`

`/api/image` 接受本机任意图片绝对路径，没有登录。不要把监听地址改成 `0.0.0.0`，除非同时加访问限制。

JPEG 头里读取的 XMP 字段：`xmp:CreateDate`、`drone-dji:GpsLatitude`、`GpsLongitude`、`AbsoluteAltitude`、`RelativeAltitude`、`GimbalYawDegree`、`GimbalPitchDegree`、`tiff:Model`、`GPano:ProjectionType`。宽高来自 SOF，只读文件前 512 KB。点击底部详情会把经纬度复制到剪贴板。列表项展示拍摄时间、相对高度和文件大小。

## 渲染

全屏四边形，在片元里由视线算经纬度再采样，没有球体网格。

相机在 `cameraBasis`：`yaw` 绕竖直轴，`pitch` 抬头为正。视线 `forward + right * (clipX * tanHalfFov * aspect) + up * (clipY * tanHalfFov)`。`clipY = +1` 是屏幕上方。经度 `atan(rd.x, rd.z)`，纬度 `asin(rd.y)`。

纹理过大时用 `MAX_TEXTURE_SIZE` 再缩一次。上传失败提示用户改成「流畅」。各向异性过滤有就开，上限 8。换图时递增 `token`，过期的解码结果丢掉。相邻一张会预先 `fetch`。

## 已核对

- 原图像素是正的：天空在图片上方。
- 着色器用 `0.5 - lat / PI` 后，平视时天空在画面上方。
- 手指向下拖，俯仰角增大。
- 服务进程被关掉后，浏览器是 `ERR_CONNECTION_REFUSED`。重新 `node server.js` 即可，不用改代码。

## 不要放进仓库

全景原图、ffmpeg、Node 运行时、`pano-viewer-cache`。源码大约几十 KB。单张全景就有几十 MB，超过 GitHub 单文件建议，也没有必要：程序只是去读本机目录。

## 还没做

没有账号、没有多级文件夹、没有立方体贴图、没有打包成不依赖 Node 的 exe。若要做 exe，用 Node 单文件可执行程序包上 `server.js` 和 `public/`；ffmpeg 仍然外置。不要为了「标准等距圆柱公式」翻回纹理 V 或拖拽符号。
