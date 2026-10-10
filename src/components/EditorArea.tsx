import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextStyle from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import {
  FontSize,
  FONT_SIZES,
  DividerNode,
  RefblockNode,
  IndentParagraph,
  AiBlockNode,
} from "../tiptap/extensions";
import { useStore } from "../store";
import { clamp, uid } from "../utils";
import { analyzeCodeBlock } from "../utils/codeBlockAnalyzer";
import { handleCodeRefblockCopy } from "../utils/clipboardCodeBlock";
import { polishText, AiError } from "../services/ai";
import Icon from "./Icon";
import { ContextMenu } from "./context-menu";
import { ConfirmDialog, InputDialog } from "./dialogs";
import brushSvg from "../assets/icons/format-brush.svg";
import fontSvg from "../assets/icons/font-size.svg";
import boldSvg from "../assets/icons/bold.svg";
import underlineSvg from "../assets/icons/underline.svg";
import strikeSvg from "../assets/icons/strikethrough.svg";
import dividerSvg from "../assets/icons/divider.svg";
import paletteSvg from "../assets/icons/palette.svg";
import aiSvg from "../assets/icons/ai.svg";
import arrowDownSvg from "../assets/icons/arrow-down.svg";
import codeSvg from "../assets/icons/code.svg";
import shanchuSvg from "../assets/icons/shanchu.svg";
import cutSvg from "../assets/icons/cut.svg";
import copySvg from "../assets/icons/copy.svg";

/**
 * 编辑器扩展必须在组件外（模块级）定义，保证引用稳定。
 * 若内联在 useEditor 里，每次渲染都会生成新的扩展实例，TipTap 的
 * compareOptions 会判定扩展已变化并调用 setOptions 重建编辑器，
 * 导致内容被清空——表现为“点一下文字就消失、光标也不出现”。
 */
const EDITOR_EXTENSIONS = [
  StarterKit.configure({ horizontalRule: false, paragraph: false }),
  IndentParagraph,
  Underline,
  TextStyle,
  Color,
  FontSize,
  DividerNode,
  RefblockNode,
  AiBlockNode,
];

/**
 * 粘贴规范化：去除外部 HTML 带来的字体 / 字号 / 颜色 / 背景 / 行距等内联样式，
 * 以及 class / id / 对齐等属性，只保留语义标签（strong / u / s 等），
 * 让粘贴进来的文字回落为软件统一格式，避免"从别处复制导致格式乱七八糟"。
 */
function sanitizePastedHtml(html: string): string {
  if (!html) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.body.querySelectorAll<HTMLElement>("*").forEach((el) => {
      el.removeAttribute("style");
      el.removeAttribute("class");
      el.removeAttribute("id");
      el.removeAttribute("color");
      el.removeAttribute("face");
      el.removeAttribute("size");
      el.removeAttribute("width");
      el.removeAttribute("height");
      el.removeAttribute("align");
      el.removeAttribute("bgcolor");
    });
    return doc.body.innerHTML;
  } catch {
    return html;
  }
}

/**
 * 把纯文本代码转成"安全 HTML"再插入编辑器：
 *   - 转义 < > &，避免代码被当作 HTML 解析/插入（也就不会被"执行"）
 *   - 换行转 <br>，保留原始换行结构
 *   - 统一 \r\n / \r 为 \n，避免出现多余空行
 */
/**
 * 把纯文本代码转成 ProseMirror 可插入的「文本节点 + 硬换行」数组。
 * 完全不走 HTML 解析，因此不会出现 &lt; &amp; 之类的实体乱码，也不会执行代码。
 */
function codeToContent(code: string): Array<Record<string, any>> {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const nodes: Array<Record<string, any>> = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push({ type: "hardBreak" });
    if (line.length > 0) nodes.push({ type: "text", text: line });
  });
  return nodes;
}

function insertPlainCode(
  ed: Editor,
  code: string,
  mode: "replace" | "insert",
  pos?: number,
) {
  const nodes = codeToContent(code);
  const chain = ed.chain().focus();
  if (mode === "replace" && pos !== undefined) {
    chain.deleteRange({ from: pos, to: pos + 1 });
  }
  if (nodes.length > 0) chain.insertContent(nodes);
  chain.run();
}

/**
 * 统计字数：正文文本 + 代码引用块里的原始代码（均不计空白字符）。
 * 代码引用块是原子节点，光用 doc.textContent 只会算到一个占位空白，
 * 所以这里遍历文档，遇到 refblock 时改取其原始代码的字数。
 */
function computeWordCount(ed: Editor, refblocks: Record<string, string>): number {
  let count = 0;
  ed.state.doc.descendants((node) => {
    if (node.isText) {
      count += (node.text ?? "").replace(/\s+/g, "").length;
    } else if (node.type.name === "refblock") {
      const id = (node.attrs as { refId?: string }).refId ?? "";
      count += (refblocks[id] ?? "").replace(/\s+/g, "").length;
    }
  });
  return count;
}

/**
 * 解析 Markdown 围栏代码段（```lang ... ```）。
 * 用于把"本软件复制出去的、已展开的代码块"在粘贴回来时原样还原为引用块，
 * 避免又被当成新代码二次识别、或把结构拆散。
 */
function parseFenced(
  text: string,
): Array<{ type: "text" | "code"; value: string }> {
  const re = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  const segs: Array<{ type: "text" | "code"; value: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const t = text.slice(last, m.index);
      if (t) segs.push({ type: "text", value: t });
    }
    let code = m[2];
    if (code.endsWith("\n")) code = code.slice(0, -1);
    segs.push({ type: "code", value: code });
    last = re.lastIndex;
  }
  if (last < text.length) {
    const t = text.slice(last);
    if (t) segs.push({ type: "text", value: t });
  }
  return segs;
}

/** 文字颜色（与 C++ 版一致，5 色） */
const TEXT_COLORS: { name: string; value: string }[] = [
  { name: "红色", value: "#E53935" },
  { name: "蓝色", value: "#4A90D9" },
  { name: "绿色", value: "#43A047" },
  { name: "白色", value: "#FFFFFF" },
  { name: "黑色", value: "#212121" },
];

interface PopoverState {
  kind: "size" | "color" | "divider" | "code";
  x: number;
  y: number;
  w: number;
  h: number;
  /** 分割线节点位置（ProseMirror pos） */
  pos?: number;
  /** 代码引用块 uuid（kind === "code" 时使用） */
  uuid?: string;
}

/** 通用弹层：锚定在按钮下方，点击外部关闭，viewport 内自动翻转 */
function Popover({
  anchor,
  onClose,
  children,
}: {
  anchor: PopoverState;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: anchor.x, y: anchor.y + anchor.h + 6 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 等渲染完成后测量并夹取到视口内
    const layout = () => {
      const r = el.getBoundingClientRect();
      let x = clamp(anchor.x, 4, window.innerWidth - r.width - 8);
      let y = anchor.y + anchor.h + 6;
      if (y + r.height > window.innerHeight - 8) {
        y = Math.max(4, anchor.y - r.height - 6);
      }
      setPos({ x, y });
    };
    layout();
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key === "Escape") onClose();
        return;
      }
      const t = e.target as HTMLElement;
      // 点击工具栏按钮时交给按钮自身做开/关切换，避免"关了又被重新打开"
      if (t.closest?.(".tool-btn")) return;
      if (!ref.current?.contains(t)) onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** 编辑器内容区：开启/关闭编辑时向外发出 HTML */
export default function EditorArea() {
  const loaded = useStore((s) => s.loaded);
  const notes = useStore((s) => s.notes);
  const currentId = useStore((s) => s.currentId);
  const updateContent = useStore((s) => s.updateContent);
  const refblocks = useStore((s) => s.refblocks);
  const refblockMeta = useStore((s) => s.refblockMeta);
  const setRefblock = useStore((s) => s.setRefblock);
  const removeRefblock = useStore((s) => s.removeRefblock);
  const setRefblockTitle = useStore((s) => s.setRefblockTitle);
  const eyeCare = useStore((s) => s.eyeCareMode);
  const editorFontSize = useStore((s) => s.editorFontSize);
  const showWordCount = useStore((s) => s.showWordCount);
  const aiFontSize = useStore((s) => s.aiFontSize);
  const aiQuota = useStore((s) => s.aiQuota);

  /** 「AI 润色」按钮的悬浮说明：让用户点之前就知道额度情况 */
  const aiQuotaTip = aiQuota
    ? aiQuota.member
      ? `AI 润色（会员，今日已用 ${aiQuota.memberUsedToday}/${aiQuota.memberCap} 次）`
      : `AI 润色（今日剩余 ${aiQuota.remainingToday}/${aiQuota.freeQuota} 次）`
    : "AI 润色";

  const note = notes.find((n) => n.id === currentId);
  const currentIdRef = useRef<string | null>(currentId);
  currentIdRef.current = currentId;

  const [fade, setFade] = useState<"idle" | "out" | "in">("idle");
  const firstRun = useRef(true);
  const [popover, setPopover] = useState<PopoverState | null>(null);
  const [renamingRef, setRenamingRef] = useState<{ id: string; title: string } | null>(null);
  const [brushActive, setBrushActive] = useState(false);
  const brushRef = useRef<{
    bold: boolean;
    underline: boolean;
    strike: boolean;
    color: string | null;
    fontSize: number | null;
  } | null>(null);
  const [refMenu, setRefMenu] = useState<{ x: number; y: number } | null>(null);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const scrollEndTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前笔记字数（不含空白字符） */
  const [wordCount, setWordCount] = useState(0);

  /** AI 润色：按钮显示状态 / 位置 / 处理中 / 提示文字 */
  const [aiBtn, setAiBtn] = useState<{ from: number; to: number } | null>(null);
  const [aiBtnPos, setAiBtnPos] = useState({ x: 0, y: 0 });
  const [aiBusy, setAiBusy] = useState(false);
  const [aiToast, setAiToast] = useState("");
  const aiHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 上下模糊效果的显隐：
  //   - 滚动文字 / 点击回到顶部·回到底部 → 淡入显示
  //   - 编辑打字（页面未大幅移动）→ 淡出隐藏
  const [blurActive, setBlurActive] = useState(false);
  const blurHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const revealBlur = useCallback(() => {
    if (blurHideTimer.current) {
      clearTimeout(blurHideTimer.current);
      blurHideTimer.current = null;
    }
    setBlurActive(true);
  }, []);

  const hideBlur = useCallback(() => {
    if (blurHideTimer.current) {
      clearTimeout(blurHideTimer.current);
      blurHideTimer.current = null;
    }
    setBlurActive(false);
  }, []);

  const scheduleHideBlur = useCallback((delay: number) => {
    if (blurHideTimer.current) clearTimeout(blurHideTimer.current);
    blurHideTimer.current = setTimeout(() => {
      blurHideTimer.current = null;
      setBlurActive(false);
    }, delay);
  }, []);

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: "",
    autofocus: false,
    editorProps: {
      transformPastedHTML: (html) => sanitizePastedHtml(html),
    },
    onUpdate: ({ editor: ed }) => {
      const id = currentIdRef.current;
      if (id) updateContent(id, ed.getHTML());
      setWordCount(computeWordCount(ed, useStore.getState().refblocks));
      // 编辑打字：页面没有大幅移动时隐藏模糊效果
      hideBlur();
    },
  });

  // AI 润色：输入停滞后显示「AI 润色」按钮（渐入渐出）
  // 计算按钮位置（视口坐标：与最后一段文字左对齐、贴在末行下方）
  const updateAiBtnPos = useCallback(
    (from: number, to: number) => {
      const ed = editor;
      if (!ed) return;
      try {
        const cEnd = ed.view.coordsAtPos(to - 1 >= from ? to - 1 : from);
        // 贴在末行文字末尾，垂直中心与文字行中心精确对齐
        const lineH = cEnd.bottom - cEnd.top;
        const rightX = cEnd.right ?? cEnd.left;
        const btnH = 21;
        setAiBtnPos({
          x: Math.round(rightX + 5),
          y: Math.round(cEnd.top + lineH / 2 - btnH / 2),
        });
      } catch {
        /* ignore */
      }
    },
    [editor],
  );

  // 取「最后一个分割点之后」的提示词范围：
  // 分割点包括可见分割线（divider）与 AI 润色框（aiBlock），
  // 它们会切断上下文——AI 只润色其下方新编辑的内容；
  // 因此：润色框存在且下方无新内容时，按钮不会出现（需求 1、3）。
  const getDocRange = useCallback((ed: Editor) => {
    const doc = ed.state.doc;
    const nodes: { type: string; offset: number; size: number }[] = [];
    doc.forEach((node, offset) => {
      nodes.push({ type: node.type.name, offset, size: node.nodeSize });
    });
    let startIdx = 0;
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodes[i].type === "divider" || nodes[i].type === "aiBlock") {
        startIdx = i + 1;
        break;
      }
    }
    let from = -1;
    let to = -1;
    for (let i = startIdx; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== "paragraph") continue;
      const node = doc.nodeAt(n.offset);
      if (!node || !node.textContent.trim()) continue;
      if (from < 0) from = n.offset;
      to = n.offset + n.size;
    }
    return from >= 0 && to >= 0 ? { from, to } : null;
  }, []);

  const showAiHint = useCallback(() => {
    const ed = editor;
    if (!ed) return;
    if (!useStore.getState().autoPolish) return;
    const r = getDocRange(ed);
    if (!r) {
      setAiBtn(null);
      return;
    }
    setAiBtn(r);
    updateAiBtnPos(r.from, r.to);
  }, [editor, getDocRange, updateAiBtnPos]);

  const scheduleAiHint = useCallback(() => {
    if (aiHintTimer.current) clearTimeout(aiHintTimer.current);
    setAiBtn(null);
    aiHintTimer.current = setTimeout(() => {
      aiHintTimer.current = null;
      showAiHint();
    }, 1200);
  }, [showAiHint]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => scheduleAiHint();
    const onBlur = () => {
      if (aiHintTimer.current) clearTimeout(aiHintTimer.current);
      setAiBtn(null);
    };
    editor.on("update", onUpdate);
    editor.on("blur", onBlur);
    return () => {
      editor.off("update", onUpdate);
      editor.off("blur", onBlur);
    };
  }, [editor, scheduleAiHint]);

  // 滚动时让按钮跟随文字移动
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const onScroll = () => {
      if (aiBtn) updateAiBtnPos(aiBtn.from, aiBtn.to);
    };
    sc.addEventListener("scroll", onScroll);
    return () => sc.removeEventListener("scroll", onScroll);
  }, [aiBtn, updateAiBtnPos]);

  // AI 润色：立即插入只读方框（显示"正在润色"），AI 返回后逐段填充
  const polishRange = useCallback(
    async (from: number, to: number) => {
      const ed = editor;
      if (!ed) return;
      const text = ed.state.doc.textBetween(from, to, "\n").trim();
      if (!text) return;
      if (aiHintTimer.current) clearTimeout(aiHintTimer.current);
      setAiBtn(null);
      setAiBusy(true);
      setAiToast("");

      // 插入点：选区末尾所在段落之后（避免插入到文字中间导致错位）
      const $to = ed.state.doc.resolve(to);
      let endPos = to;
      for (let d = $to.depth; d > 0; d--) {
        if ($to.node(d).type.name === "paragraph") {
          endPos = $to.after(d);
          break;
        }
      }
      ed.chain()
        .focus()
        .insertContentAt(endPos, {
          type: "aiBlock",
          attrs: { text: "AI 正在润色…", generating: true },
        })
        .run();
      const pos = endPos;
      const setBox = (t: string, generating: boolean) => {
        const cur = ed.state.doc.nodeAt(pos);
        if (!cur) return;
        ed.view.dispatch(
          ed.state.tr.setNodeMarkup(pos, undefined, {
            ...cur.attrs,
            text: t,
            generating,
          }),
        );
      };
      // 立即写入"正在润色"，保证方框一定显示内容
      setBox("AI 正在润色…", true);

      try {
        const store = useStore.getState();
        const { result, quota } = await polishText(text, store.authToken);
        store.setAiQuota(quota);
        const lines = result.split("\n");
        let acc = "";
        for (let i = 0; i < lines.length; i++) {
          await new Promise((r) => setTimeout(r, i === 0 ? 60 : 90));
          acc = i === 0 ? lines[i] : acc + "\n" + lines[i];
          setBox(acc, true);
        }
        // 稍作停留，让最后一行也呈现模糊后再统一变清晰
        await new Promise((r) => setTimeout(r, 450));
        setBox(result, false);
        // 方框下方确保有一个空段落，供用户继续编辑
        const boxSize = ed.state.doc.nodeAt(pos)?.nodeSize ?? 0;
        const after = pos + boxSize;
        const next = ed.state.doc.nodeAt(after);
        if (
          !next ||
          !(next.type.name === "paragraph" && next.textContent.trim() === "")
        ) {
          ed.chain().insertContentAt(after, { type: "paragraph" }).run();
        }
        ed.commands.focus(after + 1);
      } catch (e) {
        const code = e instanceof AiError ? e.code : "error";
        const msg = e instanceof Error ? e.message : "AI 润色失败";
        setBox("AI 润色失败：" + msg, false);
        setAiToast(msg);
        window.setTimeout(() => setAiToast(""), 3000);
        // 免费额度用完 → 直接弹出开通会员窗口；
        // 会员达到防滥用上限则不再弹（他已经是会员），只提示联系客服
        if (code === "free_exhausted") {
          const store = useStore.getState();
          store.openMember();
          void store.refreshAiQuota();
        } else {
          void useStore.getState().refreshAiQuota();
        }
      } finally {
        setAiBusy(false);
      }
    },
    [editor],
  );

  // 把当前选区折叠为引用块（对齐 C++ 版 foldToRefBlock）：选区纯文本存 refblocks，占位替换选区。
  const foldSelectionToRefBlock = (ed = editor) => {
    if (!ed) return false;
    const { from, to } = ed.state.selection;
    if (from === to) return false;
    const code = ed.state.doc.textBetween(from, to, "\n");
    if (!code.trim()) return false;
    const uuid = uid();
    setRefblock(uuid, code);
    ed.chain().focus().insertContent({ type: "refblock", attrs: { refId: uuid } }).run();
    return true;
  };

  // 把折叠的引用块还原为普通文本（撤销折叠）：删除占位，代码原文插回光标处，并清掉数据。
  const restoreRefblock = () => {
    if (!editor) return;
    if (popover?.kind !== "code" || !popover.uuid) return;
    const pos = popover.pos;
    if (pos === undefined) return;
    const code = refblocks[popover.uuid] ?? "";
    insertPlainCode(editor, code, "replace", pos);
    removeRefblock(popover.uuid);
    setPopover(null);
  };

  // 彻底删除引用块：移除占位与代码原文。
  const deleteRefblock = () => {
    if (!editor) return;
    if (popover?.kind !== "code" || !popover.uuid) return;
    const pos = popover.pos;
    if (pos !== undefined) {
      editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run();
    }
    removeRefblock(popover.uuid);
    setPopover(null);
  };

  // 复制选中内容（优先原生富文本复制，失败则回退纯文本）
  const copySelection = () => {
    if (!editor) return;
    const sel = editor.state.selection;
    if (sel.empty) return;
    const ok = document.execCommand("copy");
    if (!ok) {
      const text = editor.state.doc.textBetween(sel.from, sel.to, "\n");
      navigator.clipboard?.writeText(text).catch(() => {});
    }
  };

  // 剪切选中内容（原生 cut 失败则复制纯文本后删除选区）
  const cutSelection = () => {
    if (!editor) return;
    const sel = editor.state.selection;
    if (sel.empty) return;
    const ok = document.execCommand("cut");
    if (!ok) {
      const text = editor.state.doc.textBetween(sel.from, sel.to, "\n");
      navigator.clipboard?.writeText(text).catch(() => {});
      editor.chain().focus().deleteSelection().run();
    }
  };

  // 回到笔记底部：滚动编辑区滚动容器（.editor-scroll），而非 ProseMirror 内容元素
  const scrollToBottom = () => {
    const sc = scrollRef.current;
    if (sc) {
      revealBlur();
      sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
    }
  };

  // 回到笔记顶部
  const scrollToTop = () => {
    const sc = scrollRef.current;
    if (sc) {
      revealBlur();
      sc.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // 删除本页笔记中的空白行（空段落 + 段落内多余换行）
  const removeEmptyLines = () => {
    if (!editor) return;
    const { state, view } = editor;
    const { doc, schema } = state;
    // 空白判定：普通空白 + 不换行空格(\u00A0) + 全角空格(\u3000)
    // + 零宽字符，避免 Tab 缩进残留的 \u00A0 让空行"删不掉"
    const isBlank = (t: string) =>
      t.replace(/[\s\u00A0\u3000\u200B\uFEFF]+/g, "") === "";

    // 1) 空段落：整段删除
    const empties: { pos: number; size: number }[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && isBlank(node.textContent)) {
        empties.push({ pos, size: node.nodeSize });
      }
    });
    const emptyStarts = new Set(empties.map((e) => e.pos));

    // 2) 非空段落里多余的换行：段首/段尾换行全删，连续换行只留一个
    const breaks: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "paragraph" || emptyStarts.has(pos)) return;
      const items: { type: string; offset: number }[] = [];
      node.forEach((child, offset) => {
        items.push({ type: child.type.name, offset });
      });
      let i = 0;
      while (i < items.length) {
        if (items[i].type !== "hardBreak") {
          i++;
          continue;
        }
        let j = i;
        while (j < items.length && items[j].type === "hardBreak") j++;
        const head = i === 0;
        const tail = j === items.length;
        const start = head || tail ? i : i + 1;
        for (let k = start; k < j; k++) {
          breaks.push(pos + 1 + items[k].offset);
        }
        i = j;
      }
    });

    if (empties.length === 0 && breaks.length === 0) return;

    const ranges = [
      ...empties.map((e) => ({ from: e.pos, to: e.pos + e.size })),
      ...breaks.map((p) => ({ from: p, to: p + 1 })),
    ].sort((a, b) => b.from - a.from);

    const tr = state.tr;
    for (const r of ranges) tr.delete(r.from, r.to);
    // 若整篇被删空，补回一个空段落，保证文档始终可用
    if (tr.doc.childCount === 0) {
      tr.insert(0, schema.nodes.paragraph.create());
    }
    view.dispatch(tr);
    view.focus();
  };

  // 设置本页笔记所有段落首行缩进 2 字符
  const setFirstLineIndent = () => {
    if (!editor) return;
    const { state, view } = editor;
    const { doc } = state;
    const tr = state.tr;
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph") {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, textIndent: "2em" });
      }
    });
    view.dispatch(tr);
  };

  // 切换笔记：淡出 180ms OutCubic → 换内容 → 淡入 300ms OutCubic（首帧不播）
  useEffect(() => {
    if (!editor) return;
    if (!note) {
      editor.commands.setContent("", false);
      setWordCount(0);
      return;
    }
    if (firstRun.current) {
      firstRun.current = false;
      editor.commands.setContent(note.content || "", false);
      setWordCount(computeWordCount(editor, useStore.getState().refblocks));
      if (!note.content) editor.commands.focus();
      return;
    }
    setFade("out");
  }, [note?.id, editor]);

  const onFadeEnd = (e: React.AnimationEvent) => {
    if (e.animationName === "mp-fade-out") {
      editor?.commands.setContent(note?.content ?? "", false);
      setWordCount(
        editor ? computeWordCount(editor, useStore.getState().refblocks) : 0,
      );
      if (note && !note.content) editor?.commands.focus();
      setFade("in");
    } else if (e.animationName === "mp-fade-in") {
      setFade("idle");
    }
  };

  // 格式刷：鼠标拖选完成 / Esc 取消
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onUp = () => {
      if (!brushRef.current) return;
      const sel = editor.state.selection;
      if (sel.empty) return;
      applyBrush(editor);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && brushRef.current) cancelBrush();
    };
    dom.addEventListener("mouseup", onUp);
    dom.addEventListener("keydown", onKey);
    return () => {
      dom.removeEventListener("mouseup", onUp);
      dom.removeEventListener("keydown", onKey);
    };
  }, [editor]);

  // 引用块占位被点击（NodeView 发来自定义事件）→ 打开代码展开弹层
  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail as { uuid: string; pos?: number; x: number; y: number };
      setPopover({ kind: "code", x: d.x, y: d.y, w: 0, h: 0, pos: d.pos, uuid: d.uuid });
    };
    window.addEventListener("mp-refblock-click", h);
    return () => window.removeEventListener("mp-refblock-click", h);
  }, []);

  // 编辑器内右键：弹出操作菜单（有选区含剪切/复制等，无选区也可做整页操作）
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onCtx = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setRefMenu({ x: e.clientX, y: e.clientY });
    };
    dom.addEventListener("contextmenu", onCtx);
    return () => dom.removeEventListener("contextmenu", onCtx);
  }, [editor]);

  // 粘贴/输入智能识别长代码（对齐 C++ 版 detectLongCode）：≥3 行且含代码结构符号
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onPaste = (e: ClipboardEvent) => {
      // 关闭“代码块自动识别”时，粘贴不做任何检测，只能由用户手动添加代码块
      if (!useStore.getState().autoDetectCodeBlock) return;
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(
        /\r\n?/g,
        "\n",
      );
      if (!text.trim()) return;

      // 1) 含 Markdown 围栏（本软件复制出去的代码块）：原样还原，不再二次识别
      const segs = parseFenced(text);
      if (segs.some((s) => s.type === "code")) {
        e.preventDefault();
        e.stopPropagation();
        for (const seg of segs) {
          if (seg.type === "text") {
            if (seg.value) insertPlainCode(editor, seg.value, "insert");
          } else {
            const uuid = uid();
            setRefblock(uuid, seg.value);
            editor
              .chain()
              .focus()
              .insertContent({ type: "refblock", attrs: { refId: uuid } })
              .run();
          }
        }
        return;
      }

      // 2) 普通长代码：弹框询问是否折叠
      const lineCount = text.split("\n").length;
      const hasCode = /[<{\[]|function|SELECT|const|var |<\?xml|json|<html/i.test(text);
      if (lineCount >= 3 && hasCode) {
        e.preventDefault();
        e.stopPropagation();
        setPendingCode(text);
      }
    };
    // 捕获阶段监听：抢在 ProseMirror 处理粘贴之前拦截，
    // 否则 ProseMirror 会先插入一份原文，弹框确认后又插入折叠块，导致重复
    dom.addEventListener("paste", onPaste, true);
    return () => dom.removeEventListener("paste", onPaste, true);
  }, [editor]);

  // Tab 键：在光标处插入 2 个空白字符（缩进）
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        e.preventDefault();
        editor.chain().focus().insertContent("\u00A0\u00A0").run();
      }
    };
    dom.addEventListener("keydown", onKey);
    return () => dom.removeEventListener("keydown", onKey);
  }, [editor]);

  // 监听编辑区滚动：到底部切换按钮 / 偏离顶部顶部渐隐 / 滚动中导航栏缩成细线
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const sync = () => {
      setAtBottom(sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4);
      setScrolled(sc.scrollTop > 2);
    };
    // 鼠标滚轮滚动文字：淡入显示上下模糊，停止后由 scrollend / 兜底定时器淡出
    const onWheel = () => {
      revealBlur();
      scheduleHideBlur(900);
    };
    // 滚动结束（含点击回到顶部/回到底部按钮的平滑滚动）：延迟淡出
    const onScrollEnd = () => scheduleHideBlur(300);
    const onScroll = () => {
      sync();
      setScrolling(true);
      if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
      scrollEndTimer.current = setTimeout(() => setScrolling(false), 600);
    };
    sc.addEventListener("wheel", onWheel, { passive: true });
    sc.addEventListener("scroll", onScroll);
    sc.addEventListener("scrollend", onScrollEnd as EventListener);
    sync();
    return () => {
      sc.removeEventListener("wheel", onWheel);
      sc.removeEventListener("scroll", onScroll);
      sc.removeEventListener("scrollend", onScrollEnd as EventListener);
      if (scrollEndTimer.current) clearTimeout(scrollEndTimer.current);
      if (blurHideTimer.current) clearTimeout(blurHideTimer.current);
    };
  }, [editor, note?.id, revealBlur, scheduleHideBlur]);

  // 光标接近底部工具栏时自动轻微上滚，避免正在编辑的文字被工具栏遮挡
  useEffect(() => {
    const ed = editor;
    if (!ed) return;
    let raf = 0;
    const ensure = () => {
      const sc = scrollRef.current;
      const toolbar = document.querySelector(
        ".editor-toolbar",
      ) as HTMLElement | null;
      if (!sc || !toolbar) return;
      const sel = ed.state.selection;
      if (!sel || !sel.empty) return;
      let coords;
      try {
        coords = ed.view.coordsAtPos(sel.from);
      } catch {
        return;
      }
      const tTop = toolbar.getBoundingClientRect().top;
      const gap = 14;
      const overflow = coords.bottom + gap - tTop;
      if (overflow > 0.5) {
        const max = sc.scrollHeight - sc.clientHeight;
        sc.scrollTop = Math.min(sc.scrollTop + overflow, max);
      }
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(ensure);
    };
    const onSel = () => schedule();
    ed.on("selectionUpdate", onSel);
    return () => {
      cancelAnimationFrame(raf);
      ed.off("selectionUpdate", onSel);
    };
  }, [editor]);

  // 复制包含代码引用块的选区时，剪贴板写入完整原始代码（而非折叠占位）
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onCopy = (e: ClipboardEvent) => {
      try {
        const state = useStore.getState();
        handleCodeRefblockCopy(e, editor, {
          getCode: (id) => state.refblocks[id],
        });
      } catch {
        /* 失败则走浏览器默认复制 */
      }
    };
    dom.addEventListener("copy", onCopy);
    return () => dom.removeEventListener("copy", onCopy);
  }, [editor]);

  if (!editor) return null;

  // 仅当整段选区「全部」应用了某 mark 时才算激活（混合状态不算），
  // 避免 TipTap 默认 rangeHasMark 在部分应用时误判为激活。
  const isMarkFullyActive = (type: string) => {
    const { from, to, empty } = editor.state.selection;
    const markType = editor.state.schema.marks[type];
    if (!markType) return false;
    if (empty) {
      return !!markType.isInSet(
        editor.state.storedMarks || editor.state.selection.$from.marks(),
      );
    }
    let has = false;
    let all = true;
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) {
        has = true;
        if (!markType.isInSet(node.marks)) all = false;
      }
    });
    return has && all;
  };

  const openPopover = (
    kind: PopoverState["kind"],
    rect: DOMRect | null,
    pos?: number,
  ) => {
    if (!rect) return;
    setPopover({ kind, x: rect.left, y: rect.top, w: rect.width, h: rect.height, pos });
  };

  const cancelBrush = () => {
    brushRef.current = null;
    setBrushActive(false);
  };

  // 格式刷：把源格式完整套用到目标选区（有则加、无则去），
  // 用 ProseMirror 事务一次性处理，跨段、多 mark 都可靠
  const applyBrush = (ed = editor) => {
    const b = brushRef.current;
    if (!b || !ed) return;
    const { state } = ed;
    const { from, to } = state.selection;
    if (from === to) {
      cancelBrush();
      return;
    }
    const { tr, schema } = state;
    const apply = (name: string, on: boolean, attrs?: Record<string, unknown>) => {
      const mt = schema.marks[name];
      if (!mt) return;
      if (on) tr.addMark(from, to, mt.create(attrs));
      else tr.removeMark(from, to, mt);
    };
    apply("bold", b.bold);
    apply("underline", b.underline);
    apply("strike", b.strike);
    apply("textStyle", !!(b.color || b.fontSize), {
      color: b.color ?? null,
      fontSize: b.fontSize ?? null,
    });
    ed.view.dispatch(tr);
    ed.view.focus();
    cancelBrush();
  };

  const onBrushClick = () => {
    if (brushActive) {
      cancelBrush();
      return;
    }
    const ts = editor.getAttributes("textStyle") as {
      color?: string;
      fontSize?: number;
    };
    brushRef.current = {
      bold: editor.isActive("bold"),
      underline: editor.isActive("underline"),
      strike: editor.isActive("strike"),
      color: ts.color ?? null,
      fontSize: ts.fontSize ?? null,
    };
    setBrushActive(true);
  };

  const textStyle = editor.getAttributes("textStyle") as {
    color?: string;
    fontSize?: number;
  };
  const tsColor = TEXT_COLORS.find((c) => c.value === textStyle.color);
  const tsSize = textStyle.fontSize ?? null;

  const bg = eyeCare ? "#FFF8E7" : "#FFFFFF";

  return (
    <>
    <div
      className={
        "editor-panel" +
        (scrolled ? " scrolled" : "") +
        (blurActive ? " blur-active" : "")
      }
      style={
        {
          background: bg,
          "--editor-bg": bg,
          "--editor-font-size": `${editorFontSize}px`,
          "--ai-font-size": `${aiFontSize}pt`,
        } as React.CSSProperties
      }
    >
      {/* ===== 编辑区 ===== */}
      <div
        ref={scrollRef}
        className={
          "editor-scroll" +
          (fade === "out" ? " mp-fade-out" : fade === "in" ? " mp-fade-in" : "")
        }
        onAnimationEnd={onFadeEnd}
        onMouseDown={(e) => {
          // 仅左键；点击编辑区任意位置（含文字之外的空白）都能聚焦并出现光标
          if (e.button !== 0) return;
          const t = e.target as HTMLElement;
          if (t.closest(".ProseMirror")) return; // 内容区交给 ProseMirror 自行处理
          const res = editor.view.posAtCoords({
            left: e.clientX,
            top: e.clientY,
          });
          if (res && typeof res.pos === "number") {
            editor.chain().focus(res.pos).run();
          } else {
            editor.commands.focus("end");
          }
        }}
      >
        <EditorContent editor={editor} className="editor-content" />
        <div className="editor-boundary" aria-hidden="true" />
        {note && showWordCount && wordCount > 0 && (
          <div className="editor-wordcount">{wordCount} 字</div>
        )}
        {!note && loaded && (
          <div className="editor-empty">
            <div className="editor-empty-tip">暂无笔记 · 点击左上角 + 新建</div>
          </div>
        )}
      </div>

      {/* ===== 弹层 ===== */}
      {popover?.kind === "size" && (
        <Popover anchor={popover} onClose={() => setPopover(null)}>
          <div className="pop-menu pop-size">
            {FONT_SIZES.map((pt) => (
              <div
                key={pt}
                className={
                  "pop-row" + (tsSize === pt ? " pop-row-on" : "")
                }
                onClick={() => {
                  editor.chain().focus().setFontSize(pt).run();
                  setPopover(null);
                }}
              >
                <span>{pt}</span>
                <span className="pop-row-unit">pt</span>
                {tsSize === pt && <span className="pop-row-check">✓</span>}
              </div>
            ))}
          </div>
        </Popover>
      )}
      {popover?.kind === "color" && (
        <Popover anchor={popover} onClose={() => setPopover(null)}>
          <div className="pop-menu pop-color">
            {TEXT_COLORS.map((c) => (
              <div
                key={c.value}
                className={"pop-row" + (tsColor?.value === c.value ? " pop-row-on" : "")}
                onClick={() => {
                  editor.chain().focus().setColor(c.value).run();
                  setPopover(null);
                }}
              >
                <span className="pop-dot" style={{ background: c.value }} />
                <span>{c.name}</span>
                {tsColor?.value === c.value && <span className="pop-row-check">✓</span>}
              </div>
            ))}
          </div>
        </Popover>
      )}
      {popover?.kind === "code" && popover.uuid && (
        <Popover anchor={popover} onClose={() => setPopover(null)}>
          <div className="pop-menu pop-code">
            <div className="pop-code-head">
              <span>代码引用块</span>
              <span className="pop-code-meta">
                {refblocks[popover.uuid]
                  ? `${refblocks[popover.uuid].split("\n").length} 行`
                  : "（无内容）"}
              </span>
            </div>
            <pre>{(refblocks[popover.uuid] ?? "").replace(/\r\n?/g, "\n") || "（无内容）"}</pre>
            <div className="pop-code-actions">
              <button
                className="btn"
                onClick={() => {
                  const id = popover.uuid!;
                  const code = refblocks[id] ?? "";
                  const manual = refblockMeta[id];
                  const meta = analyzeCodeBlock(
                    code,
                    undefined,
                    manual?.manualTitle ? manual.title : undefined,
                  );
                  setRenamingRef({ id, title: meta.title });
                }}
              >
                重命名
              </button>
              <button className="btn" onClick={restoreRefblock}>
                还原为文本
              </button>
              <button className="btn btn-danger" onClick={deleteRefblock}>
                删除
              </button>
            </div>
          </div>
        </Popover>
      )}

      {renamingRef && (
        <InputDialog
          title="重命名代码块"
          initial={renamingRef.title}
          onConfirm={(v) => {
            setRefblockTitle(renamingRef.id, v);
            setRenamingRef(null);
            setPopover(null);
          }}
          onCancel={() => setRenamingRef(null)}
        />
      )}

      {/* 编辑器右键菜单：选中文字后的常用操作 */}
      {createPortal(
        <button
          className={"ai-polish-fab" + (aiBtn && !aiBusy ? " show" : "")}
          style={{ left: aiBtnPos.x, top: aiBtnPos.y }}
          title={aiQuotaTip}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (aiBtn && !aiBusy) void polishRange(aiBtn.from, aiBtn.to);
          }}
        >
          <Icon src={aiSvg} size={12} />
          AI 润色
        </button>,
        document.body,
      )}

      {aiToast &&
        createPortal(<div className="ai-toast">{aiToast}</div>, document.body)}

      {refMenu && (
        <ContextMenu
          x={refMenu.x}
          y={refMenu.y}
          items={[
            {
              row: [
                {
                  label: "格式刷",
                  icon: <Icon src={brushSvg} size={16} />,
                  onClick: () => onBrushClick(),
                },
                {
                  label: "剪切",
                  icon: <Icon src={cutSvg} size={16} />,
                  onClick: () => cutSelection(),
                },
                {
                  label: "复制",
                  icon: <Icon src={copySvg} size={16} />,
                  onClick: () => copySelection(),
                },
                {
                  label: "删除",
                  icon: <Icon src={shanchuSvg} size={16} />,
                  danger: true,
                  onClick: () => editor.chain().focus().deleteSelection().run(),
                },
              ],
            },
            { separator: true },
            {
              label: "加粗",
              icon: <Icon src={boldSvg} size={15} />,
              onClick: () => editor.chain().focus().toggleBold().run(),
            },
            {
              label: "下划线",
              icon: <Icon src={underlineSvg} size={15} />,
              onClick: () => editor.chain().focus().toggleUnderline().run(),
            },
            {
              label: "删除线",
              icon: <Icon src={strikeSvg} size={15} />,
              onClick: () => editor.chain().focus().toggleStrike().run(),
            },
            {
              label: "文字大小",
              icon: <Icon src={fontSvg} size={15} />,
              children: FONT_SIZES.map((pt) => ({
                label: `${pt} pt`,
                onClick: () => editor.chain().focus().setFontSize(pt).run(),
              })),
            },
            {
              label: "文字颜色",
              icon: <Icon src={paletteSvg} size={15} />,
              children: TEXT_COLORS.map((c) => ({
                label: c.name,
                icon: <span className="ctx-dot" style={{ background: c.value }} />,
                onClick: () => editor.chain().focus().setColor(c.value).run(),
              })),
            },
            { separator: true },
            {
              label: "删除空白行",
              onClick: () => removeEmptyLines(),
            },
            {
              label: "首行缩进2字符",
              onClick: () => setFirstLineIndent(),
            },
            { separator: true },
            {
              label: aiBusy ? "AI 润色中…" : "AI 润色",
              icon: <Icon src={aiSvg} size={15} />,
              onClick: () => {
                if (aiBusy) return;
                const { from, to } = editor.state.selection;
                if (from !== to) {
                  void polishRange(from, to);
                  return;
                }
                // 若选区已丢失，则退回整篇提示词
                const r = getDocRange(editor);
                if (r) void polishRange(r.from, r.to);
              },
            },
            {
              label: "折叠为代码引用块",
              icon: <Icon src={codeSvg} size={15} />,
              onClick: () => foldSelectionToRefBlock(),
            },
          ]}
          onClose={() => setRefMenu(null)}
        />
      )}

      {/* 粘贴长代码智能识别：确认是否折叠为引用块 */}
      {pendingCode !== null && (
        <ConfirmDialog
          title="检测到长代码"
          message="检测到长代码，是否折叠为引用块？"
          confirmText="折叠"
          onConfirm={() => {
            const uuid = uid();
            setRefblock(uuid, pendingCode);
            editor.chain().focus().insertContent({ type: "refblock", attrs: { refId: uuid } }).run();
            setPendingCode(null);
          }}
          onCancel={() => {
            if (pendingCode) insertPlainCode(editor, pendingCode, "insert");
            setPendingCode(null);
          }}
        />
      )}
    </div>

    {/* ===== 底部工具栏（贯穿横条正上方） ===== */}
    <div
      className={"editor-toolbar" + (scrolling ? " scrolling" : "")}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button
        className={"tool-btn" + (brushActive ? " tool-checked" : "")}
        title="格式刷（点击后选中要应用格式的文字）"
        onClick={onBrushClick}
      >
        <Icon src={brushSvg} size={18} />
      </button>
      <button
        className="tool-btn"
        title="文字大小"
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          if (popover?.kind === "size") setPopover(null);
          else openPopover("size", rect);
        }}
      >
        <Icon src={fontSvg} size={18} />
      </button>
      <div className="tool-vline" />
      <button
        className={"tool-btn" + (isMarkFullyActive("bold") ? " tool-checked" : "")}
        title="加粗"
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Icon src={boldSvg} size={18} />
      </button>
      <button
        className={"tool-btn" + (isMarkFullyActive("underline") ? " tool-checked" : "")}
        title="下划线"
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <Icon src={underlineSvg} size={18} />
      </button>
      <button
        className={"tool-btn" + (isMarkFullyActive("strike") ? " tool-checked" : "")}
        title="删除线"
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Icon src={strikeSvg} size={18} />
      </button>
      <button
        className="tool-btn"
        title="插入分割线"
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertContent([{ type: "divider" }, { type: "paragraph" }])
            .run()
        }
      >
        <Icon src={dividerSvg} size={18} />
      </button>
      <div className="tool-vline" />
      <button
        className="tool-btn"
        title="文字颜色"
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          if (popover?.kind === "color") setPopover(null);
          else openPopover("color", rect);
        }}
      >
        <Icon src={paletteSvg} size={18} />
        <span
          className="tool-color-bar"
          style={{ background: tsColor?.value ?? "#212121" }}
        />
      </button>
      <div className="tool-vline" />
      <button
        className="tool-btn"
        title={atBottom ? "回到顶部" : "回到底部"}
        onClick={atBottom ? scrollToTop : scrollToBottom}
      >
        <Icon
          src={arrowDownSvg}
          size={18}
          className={"tool-icon-rot" + (atBottom ? " tool-icon-flip" : "")}
        />
      </button>
    </div>
    </>
  );
}
