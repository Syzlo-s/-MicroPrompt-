import type { Note } from "../types";

/* ============================================================
 * 笔记「纯文本」工具（文件管理台的列表摘要 / 详情预览 / 导出用）
 * ------------------------------------------------------------
 * 笔记正文是 TipTap 的 HTML，列表里只需要一行摘要，
 * 详情里需要可读的纯文本预览，导出成 .txt 也要纯文本。
 * 这里统一做：去标签、保留换行结构、额外把引用块的代码原文接回去
 * （与编辑器右下角「字数统计」口径一致：都不计空白字符）。
 * ============================================================ */

/** 取正文里引用到的引用块 uuid（按出现顺序，去重） */
export function refIdsOf(html: string): string[] {
  const out: string[] = [];
  const re = /data-refblock\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** HTML → 纯文本（<p>/<div>/<br>/<hr> 转成换行，<li> 前加 ·） */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  let s = html;
  // 引用块占位符：正文里只留一个标记，代码原文另外接
  s = s.replace(
    /<span[^>]*data-refblock\s*=\s*["'][^"']+["'][^>]*>[\s\S]*?<\/span>/gi,
    "",
  );
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr[^>]*>/gi, "\n────────\n");
  s = s.replace(/<li[^>]*>/gi, "\n· ");
  s = s.replace(/<\/(p|div|li|h1|h2|h3|h4|h5|h6|blockquote|tr)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  // 实体
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
  // 压缩多余空行
  return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** 笔记纯文本（正文 + 引用块代码按原位展开） */
export function notePlainText(
  note: Note,
  refblocks: Record<string, string>,
): string {
  const src = note.content ?? "";
  // 按引用块占位符切开：占位处插入代码原文，其余按 HTML 转纯文本
  const re = /<span[^>]*data-refblock\s*=\s*["']([^"']+)["'][^>]*>[\s\S]*?<\/span>/gi;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(htmlToPlainText(src.slice(last, m.index)));
    const code = refblocks[m[1]] ?? "";
    if (code) out.push(`\n\`\`\`\n${code}\n\`\`\`\n`);
    last = re.lastIndex;
  }
  if (last < src.length) out.push(htmlToPlainText(src.slice(last)));
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** 列表摘要：把换行压成空格，截断到 n 个字 */
export function noteSummary(
  note: Note,
  refblocks: Record<string, string>,
  n = 60,
): string {
  const t = notePlainText(note, refblocks).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 字数（不计空白字符，与编辑器右下角一致） */
export function noteCharCount(
  note: Note,
  refblocks: Record<string, string>,
): number {
  const ids = refIdsOf(note.content);
  const body = htmlToPlainText(note.content);
  let count = body.replace(/\s+/g, "").length;
  for (const id of ids) count += (refblocks[id] ?? "").replace(/\s+/g, "").length;
  return count;
}

/** 导出用的文件正文（带标题与元信息的纯文本） */
export function noteExportText(
  note: Note,
  refblocks: Record<string, string>,
): string {
  const t = notePlainText(note, refblocks);
  return [
    note.title || "未命名笔记",
    "=".repeat(24),
    `建立时间：${note.created.replace("T", " ")}`,
    `修改时间：${note.modified.replace("T", " ")}`,
    "",
    t,
    "",
  ].join("\r\n");
}

/** 字节数 → 可读大小 */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 毫秒时间戳 → "yyyy-MM-dd HH:mm"（0 → "—"） */
export function msToLocal(ms: number): string {
  if (!ms || ms <= 0) return "—";
  const d = new Date(ms);
  const p = (n: number) => (n < 10 ? "0" : "") + n;
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}
