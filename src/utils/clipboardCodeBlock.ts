/* ============================================================
 * 代码引用块：复制增强
 *   当选中区域包含代码引用块时，剪贴板里写入代码块的【完整原始代码】，
 *   而不是 DOM 上折叠后的占位内容。
 *   数据从 store（refblocks 映射）读取，不依赖 DOM 可见文本。
 * ============================================================ */
import type { Editor } from "@tiptap/react";
import { DOMSerializer } from "@tiptap/pm/model";
import { analyzeCodeBlock } from "./codeBlockAnalyzer";

export interface RefblockResolver {
  /** 根据 refblock 占位 id 取完整原始代码 */
  getCode(id: string): string | undefined;
}

/** 选区是否与任意代码块占位相交 */
function collectIntersectingRefblocks(editor: Editor): HTMLElement[] {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    const dom = editor.view.dom;
    const anc = range.commonAncestorContainer;
    if (anc !== dom && !dom.contains(anc)) return [];
    const nodes = Array.from(dom.querySelectorAll<HTMLElement>("[data-refblock]"));
    return nodes.filter((el) => {
      try {
        return range.intersectsNode(el);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function fence(code: string, language: string): string {
  const lang = language && language !== "text" ? language : "";
  return "```" + lang + "\n" + code + "\n```";
}

/**
 * 处理 copy 事件。
 * @returns true 表示已接管（调用方无需再处理），false 表示走浏览器默认复制。
 */
export function handleCodeRefblockCopy(
  e: ClipboardEvent,
  editor: Editor,
  resolve: RefblockResolver,
): boolean {
  if (!e.clipboardData) return false;

  const hits = collectIntersectingRefblocks(editor);
  if (hits.length === 0) return false;

  const { from, to } = editor.state.selection;
  if (from === to) return false;

  // text/plain：普通文字保留，代码块用 Markdown 围栏包裹
  let plain = "";
  try {
    plain = editor.state.doc.textBetween(from, to, "\n", (node) => {
      if (node.type.name === "refblock") {
        const id = (node.attrs as { refId?: string }).refId ?? "";
        const code = resolve.getCode(id) ?? "";
        const meta = analyzeCodeBlock(code);
        return `\n${fence(code, meta.language)}\n`;
      }
      return "";
    });
  } catch {
    plain = "";
  }

  // text/html：代码块渲染为 <pre><code class="language-xxx">，其余保留段落结构
  let html = "";
  try {
    const serializer = DOMSerializer.fromSchema(editor.state.schema);
    const fragment = serializer.serializeFragment(
      editor.state.doc.slice(from, to).content,
    );
    const container = document.createElement("div");
    container.appendChild(fragment);
    container.querySelectorAll("[data-refblock]").forEach((el) => {
      const id = el.getAttribute("data-refblock") || "";
      const code = resolve.getCode(id) ?? "";
      const meta = analyzeCodeBlock(code);
      const pre = document.createElement("pre");
      const codeEl = document.createElement("code");
      codeEl.className = `language-${meta.language}`;
      codeEl.textContent = code; // 安全：textContent 不解析 HTML
      pre.appendChild(codeEl);
      el.replaceWith(pre);
    });
    html = container.innerHTML;
  } catch {
    html = "";
  }

  try {
    if (plain) e.clipboardData.setData("text/plain", plain);
    if (html) e.clipboardData.setData("text/html", html);
    e.preventDefault();
    return true;
  } catch {
    // 写入失败：降级为浏览器默认行为
    return false;
  }
}
