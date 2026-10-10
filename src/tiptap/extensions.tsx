import { Extension, Node, mergeAttributes } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { analyzeCodeBlock } from "../utils/codeBlockAnalyzer";

/* ============================================================
 * 段落扩展：在默认 paragraph 基础上支持首行缩进（text-indent）
 * 用于右键菜单「首行缩进2字符」；随笔记 HTML 持久化
 * ============================================================ */
export const IndentParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      textIndent: {
        default: null as string | null,
        parseHTML: (el: HTMLElement) => el.style.textIndent || null,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.textIndent) return {};
          return { style: `text-indent:${attrs.textIndent}` };
        },
      },
      aiGenerated: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-ai") === "1",
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.aiGenerated) return {};
          return { "data-ai": "1", contenteditable: "false" };
        },
      },
      aiGenerating: {
        default: false,
        parseHTML: () => false,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.aiGenerating) return {};
          return { "data-ai-generating": "1" };
        },
      },
    };
  },
});

/* ============================================================
 * 字号 Mark（textStyle 全局属性）：<span style="font-size:10pt">
 * 档位与 C++ 版一致：8/10/12/14/16/18/20/24/28/32
 * ============================================================ */
export const FONT_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontSize: {
      setFontSize: (pt: number) => ReturnType;
      unsetFontSize: () => ReturnType;
    };
    refblock: {
      insertRefblock: (id: string) => ReturnType;
    };
  }
}

export const FontSize = Extension.create({
  name: "fontSize",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null as number | null,
            parseHTML: (el: HTMLElement) => {
              const v = el.style.fontSize;
              if (!v) return null;
              const m = /^([\d.]+)\s*pt$/i.exec(v);
              if (m) return Math.round(parseFloat(m[1]) * 100) / 100;
              return null;
            },
            renderHTML: (attrs: Record<string, unknown>) => {
              if (!attrs.fontSize) return {};
              return { style: `font-size: ${attrs.fontSize}pt` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontSize:
        (pt: number) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontSize: pt }).run(),
      unsetFontSize:
        () =>
        ({ chain }) =>
          chain()
            .setMark("textStyle", { fontSize: null })
            .removeEmptyTextStyle()
            .run(),
    };
  },
});

/* ============================================================
 * 分割线 Node：<hr data-style="N"/>
 *   4.0.0 起统一样式（细线，与 AI 润色框框线一致）；
 *   保留 data-style 以兼容旧笔记，n 不再影响显示。
 *   块高固定 22px（对齐 C++ kHrBlockHeight），线居中
 * ============================================================ */
export interface DividerAttrs {
  style: number;
}

export const DividerNode = Node.create({
  name: "divider",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      style: {
        default: 0,
        parseHTML: (el: HTMLElement) => {
          const v = parseInt(el.getAttribute("data-style") || "0", 10);
          return Number.isFinite(v) ? v : 0;
        },
        renderHTML: (attrs: { style: number }) => ({
          "data-style": String(attrs.style),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "hr" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["hr", HTMLAttributes];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DividerView);
  },
});

function DividerView({ selected }: NodeViewProps) {
  return (
    <NodeViewWrapper
      className={"mp-divider" + (selected ? " mp-divider-selected" : "")}
    />
  );
}

/* ============================================================
 * 引用块占位 Node：<span data-refblock="uuid">　</span>
 *   Phase 1 仅保证：加载不破坏既有内容、保存时原样序列化；
 *   展开/识别交互在 Phase 3 实现。
 * ============================================================ */
export const RefblockNode = Node.create({
  name: "refblock",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      refId: {
        default: "" as string,
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-refblock") || "",
        renderHTML: (attrs: { refId: string }) => ({
          "data-refblock": attrs.refId,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-refblock]",
        getAttrs: (el: HTMLElement) => ({
          refId: el.getAttribute("data-refblock") || "",
        }),
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "span",
      { "data-refblock": HTMLAttributes?.["data-refblock"] ?? "" },
      "　",
    ];
  },

  addCommands() {
    return {
      insertRefblock:
        (id: string) =>
        ({ chain }) =>
          chain()
            .insertContent({ type: this.name, attrs: { refId: id } })
            .run(),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(RefblockView);
  },
});

function RefblockView({
  node,
  getPos,
}: {
  node: unknown;
  getPos: () => number | undefined;
}) {
  const refId = (node as { attrs: { refId: string } }).attrs.refId;
  const code = useStore((s) => s.refblocks[refId]);
  const manual = useStore((s) => s.refblockMeta[refId]);

  const meta = useMemo(
    () =>
      analyzeCodeBlock(
        code ?? "",
        undefined,
        manual?.manualTitle ? manual.title : undefined,
      ),
    [code, manual?.manualTitle, manual?.title],
  );

  return (
    <NodeViewWrapper
      as="span"
      className="mp-refblock"
      data-refblock={refId}
      data-language={meta.language}
      title="代码引用（点击展开，可重命名/还原/删除）"
      contentEditable={false}
      onClick={(e: React.MouseEvent) => {
        e.preventDefault();
        const pos = getPos();
        window.dispatchEvent(
          new CustomEvent("mp-refblock-click", {
            detail: { uuid: refId, pos, x: e.clientX, y: e.clientY },
          }),
        );
      }}
    >
      <span className="mp-refblock-tag">{`<${meta.title}>`}</span>
    </NodeViewWrapper>
  );
}

/* ============================================================
 * AI 润色方框节点（4.0.0）：atom 只读节点，文本存于 attrs.text
 *   - 不可编辑、光标不可进入
 *   - 生成中：NodeView 带逐段生成 + 模糊
 * ============================================================ */
function AiBlockView({ node, editor, getPos }: NodeViewProps) {
  const attrs = node.attrs as {
    text?: string;
    generating?: boolean;
    collapsed?: boolean;
  };
  const text = String(attrs.text ?? "");
  const lines = text.split("\n");
  const title = (lines[0] ?? "").trim() || "AI 润色";
  const bodyLines = lines.slice(1);
  const collapsed = Boolean(attrs.collapsed);

  // 双击方框任意位置 → 复制润色后的完整文字
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  const copyText = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (attrs.generating) return;
      const payload = text.trim();
      if (!payload) return;
      const done = () => {
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 1200);
      };
      const fallback = () => {
        try {
          const ta = document.createElement("textarea");
          ta.value = payload;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          done();
        } catch {
          /* ignore */
        }
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(payload).then(done).catch(fallback);
      } else {
        fallback();
      }
    },
    [text, attrs.generating],
  );

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (pos === undefined || pos === null) return;
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        collapsed: !collapsed,
      }),
    );
  };

  return (
    <NodeViewWrapper
      className={
        "ai-block" +
        (attrs.generating ? " generating" : "") +
        (collapsed ? " collapsed" : "")
      }
      contentEditable={false}
      onDoubleClick={copyText}
    >
      <button
        className="ai-block-toggle"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        title={collapsed ? "展开" : "折叠"}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <span className="ai-block-title">{title}</span>
      <div className="ai-block-body" aria-hidden={collapsed}>
        <div className="ai-block-body-inner">
          {bodyLines.map((line, i) => (
            <span
              className="ai-block-line"
              key={i}
              style={{ "--i": i } as React.CSSProperties}
            >
              {line || "\u00A0"}
            </span>
          ))}
        </div>
      </div>
      {copied && <span className="ai-block-copied">已复制</span>}
    </NodeViewWrapper>
  );
}

export const AiBlockNode = Node.create({
  name: "aiBlock",
  group: "block",
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-ai-text") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-ai-text": String(attrs.text ?? ""),
        }),
      },
      generating: {
        default: false,
        parseHTML: () => false,
        renderHTML: () => ({}),
      },
      collapsed: {
        default: false,
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-ai-collapsed") === "1",
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.collapsed ? { "data-ai-collapsed": "1" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-ai-block]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-ai-block": "1" }),
      String(HTMLAttributes["data-ai-text"] ?? ""),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AiBlockView);
  },
});
