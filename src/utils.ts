/** 头像文件大小上限：2MB */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;

/** 本地时间 ISO8601："2026-08-31T09:00:00"（与 C++ 版 QString::toString(Qt::ISODate) 一致） */
export function nowLocal(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** 卡片日期："yyyy-MM-dd HH:mm"（与 C++ 版 NoteListGroup 显示一致） */
export function cardDate(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** UUID：小写带连字符，与 C++ 版 QUuid::toString(QUuid::WithoutBraces) 一致（如 ed15c0c2-bc46-4230-aaa0-8af9ce8f9f91） */
export function uid(): string {
  return crypto.randomUUID();
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 读取图片文件并压缩为头像 data URL（≤ max 边长，JPEG），
 * 避免原图过大导致 localStorage 写入失败（头像丢失）。
 */
export function fileToAvatarDataUrl(file: File, max = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => {
      const src = String(reader.result ?? "");
      const img = new Image();
      img.onerror = () => reject(new Error("解码图片失败"));
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            resolve(src);
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        } catch {
          resolve(src);
        }
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}
