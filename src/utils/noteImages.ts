import { readImage, saveImage } from "../backend";

/* ============================================================
 * 编辑器图片：校验 / 落盘 / 按需读取（4.9.0）
 * ------------------------------------------------------------
 * 设计要点：**图片二进制不进笔记 HTML，也不进 notes.json**。
 *   正文里只存 image id（<img data-mp-image="<id>">），NodeView 挂载时
 *   调 Rust 的 read_image 换回 data URL 显示。
 * 原因：notes.json 每次自动保存都会被整体序列化+写盘，如果把 base64 塞进
 *   正文，插几张图后每次打字都会搬运好几 MB，编辑器会越来越卡。
 * ============================================================ */

/** 支持的图片格式（与 Rust 端魔术字节校验保持一致） */
const SUPPORTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
];

/** 单张图片上限：与 Rust 端 save_image 的限制保持一致 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export const MAX_IMAGE_MB = Math.round(MAX_IMAGE_BYTES / (1024 * 1024));

/** 是否是可插入的图片文件（File.type 可能为空，退回扩展名判断） */
export function isSupportedImageFile(file: File): boolean {
  if (file.type && file.type.startsWith("image/")) {
    return SUPPORTED_IMAGE_TYPES.includes(file.type);
  }
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name);
}

/** 把 File 读成完整 data URL（用于插入后立刻显示 + 取 base64 交给后端） */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

/* 图片缓存：同一张图可能在多处出现（复制/粘贴、多篇笔记），
   用 Map + pending 去重，避免重复 IPC；上限 20 条，超出后淘汰最早的一张，
   被淘汰的图再次出现会重新读盘（不会报错，只是多一次 IPC）。 */
const IMAGE_CACHE_MAX = 20;
const imageCache = new Map<string, string>();
const imagePending = new Map<string, Promise<string>>();

function rememberImage(imageId: string, dataUrl: string): void {
  if (!imageId || !dataUrl) return;
  if (imageCache.size >= IMAGE_CACHE_MAX && !imageCache.has(imageId)) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(imageId, dataUrl);
}

/** 同步取已缓存的 data URL；没有则返回 null（NodeView 首帧用） */
export function peekImageDataUrl(imageId: string): string | null {
  return imageCache.get(imageId) ?? null;
}

/** 按 image id 读图片；命中缓存直接返回，未命中走 Rust read_image */
export function loadImageDataUrl(imageId: string): Promise<string> {
  const cached = imageCache.get(imageId);
  if (cached) return Promise.resolve(cached);
  const pending = imagePending.get(imageId);
  if (pending) return pending;

  const task = readImage(imageId)
    .then((dataUrl) => {
      rememberImage(imageId, dataUrl);
      return dataUrl;
    })
    .finally(() => imagePending.delete(imageId));
  imagePending.set(imageId, task);
  return task;
}

/** 把图片落盘，返回 image id；同时把 data URL 放进缓存，插入后立即可见 */
export async function persistImageFile(file: File): Promise<string> {
  if (!isSupportedImageFile(file)) {
    throw new Error("不支持的图片格式（支持 PNG/JPG/GIF/WebP/BMP）");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${MAX_IMAGE_MB}MB，请压缩后再插入`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("图片读取失败");
  const base64 = dataUrl.slice(comma + 1);
  const imageId = await saveImage(base64);
  // 后端按魔术字节识别真实格式，这里缓存前端读到的 data URL 只用于显示，等价可用
  rememberImage(imageId, dataUrl);
  return imageId;
}

/** 从 DataTransfer（粘贴 / 拖拽）里取出图片文件，顺序保持原样 */
export function imageFilesFromTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const files: File[] = [];
  if (dt.files) {
    for (const file of Array.from(dt.files)) {
      if (isSupportedImageFile(file)) files.push(file);
    }
  }
  // 有些来源（截图工具 / 浏览器）只放在 items 里，files 为空
  if (files.length === 0 && dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file && isSupportedImageFile(file)) files.push(file);
    }
  }
  return files;
}
