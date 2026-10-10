/* ============================================================
 * 代码引用块：纯前端离线分析
 *   - detectLanguage：多规则评分识别语言
 *   - extractTitle：按语言提取短标题
 *   - analyzeCodeBlock：对外统一入口
 * 不联网、不执行用户代码、不使用 innerHTML 注入页面。
 * ============================================================ */

export type CodeParser =
  | "explicit"
  | "dom"
  | "postcss"
  | "babel"
  | "json"
  | "regex"
  | "fallback";

export interface CodeBlockMeta {
  language: string;
  title: string;
  lineCount: number;
  confidence: number;
  parser: CodeParser;
}

/** 语言展示名 */
export const LANGUAGE_LABELS: Record<string, string> = {
  html: "HTML",
  xml: "XML",
  css: "CSS",
  js: "JS",
  ts: "TS",
  json: "JSON",
  vue: "Vue",
  react: "React",
  python: "Python",
  java: "Java",
  go: "Go",
  rust: "Rust",
  sql: "SQL",
  shell: "Shell",
  yaml: "YAML",
  markdown: "MD",
  text: "TEXT",
};

/** 超过该长度降级为轻量识别，避免卡顿 */
const MAX_DEEP = 200 * 1024;

const ALIASES: Record<string, string> = {
  javascript: "js",
  jsx: "react",
  tsx: "react",
  node: "js",
  "node.js": "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  html5: "html",
  htm: "html",
  sass: "css",
  scss: "css",
  less: "css",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  md: "markdown",
  py: "python",
  golang: "go",
  json5: "json",
};

export function normalizeLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const k = lang.trim().toLowerCase().replace(/^\./, "");
  return ALIASES[k] ?? k;
}

export function countLines(code: string): number {
  if (!code) return 0;
  return code.split(/\r\n|\r|\n/).length;
}

export function labelOf(language: string): string {
  return LANGUAGE_LABELS[language] ?? language.toUpperCase();
}

interface Detection {
  language: string;
  confidence: number;
  parser: CodeParser;
}

/** 多规则评分识别语言 */
export function detectLanguage(code: string): Detection {
  const src = code ?? "";
  const trimmed = src.trim();
  if (!trimmed) return { language: "text", confidence: 0, parser: "fallback" };

  // JSON：能直接解析即为 JSON（最高可信）
  if (trimmed.length <= MAX_DEEP && /^[[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return { language: "json", confidence: 0.98, parser: "json" };
    } catch {
      /* not json */
    }
  }

  const scores: Record<string, number> = {
    html: 0,
    xml: 0,
    css: 0,
    js: 0,
    ts: 0,
    react: 0,
    vue: 0,
    python: 0,
    java: 0,
    go: 0,
    rust: 0,
    sql: 0,
    shell: 0,
    yaml: 0,
    markdown: 0,
  };
  const add = (k: string, v: number) => {
    scores[k] += v;
  };

  // html / xml
  if (/<!doctype\s+html/i.test(src)) add("html", 6);
  if (/<html[\s>]/i.test(src)) add("html", 4);
  if (/<body[\s>]/i.test(src)) add("html", 3);
  if (/<\/?[a-z][\w-]*(\s[^>]*)?>/i.test(src)) add("html", 2);
  if (/<(div|span|p|a|ul|li|section|header|footer|template)[\s>]/i.test(src)) add("html", 2);
  if (/\bclass=|\bid=|\bstyle=/i.test(src)) add("html", 1);
  if (/^\s*<\?xml/i.test(src)) add("xml", 6);
  if (/<[a-z]+:[\w-]+[\s>]/i.test(src)) add("xml", 2);

  // vue
  if (/<template[\s>]/i.test(src)) add("vue", 4);
  if (/<script\s+setup/i.test(src)) add("vue", 5);
  if (/\bdefineProps\b|\bdefineEmits\b|\bwithDefaults\b/.test(src)) add("vue", 3);
  if (/<template[\s>][\s\S]*<\/template>/i.test(src) && /<script[\s>]/i.test(src)) add("vue", 2);
  if (/\bref\(|\bcomputed\(|\bonMounted\(/.test(src) && /<template[\s>]/i.test(src)) add("vue", 2);

  // css
  if (/[^{}\n]+\{[^{}]*:[^{}]*;?[^{}]*\}/.test(src)) add("css", 3);
  if (/@media|@keyframes|@font-face|@import|@supports/i.test(src)) add("css", 3);
  if (/^[.#]?[\w-]+(?:\s*[^{}\n,]+)?\s*\{/m.test(src)) add("css", 2);
  if (/\b(color|background|margin|padding|display|font-size|border|width|height|flex|position)\s*:/i.test(src)) add("css", 2);
  if (/--[\w-]+\s*:/.test(src) && /\{/.test(src)) add("css", 1);

  // js
  if (/\b(function|const|let|var|class|import|export|return|async|await|new)\b/.test(src)) add("js", 3);
  if (/=>/.test(src)) add("js", 1);
  if (/\bconsole\.(log|error|warn)\s*\(/.test(src)) add("js", 3);

  // ts
  if (/\b(interface|type|enum|implements|namespace|declare)\b/.test(src)) add("ts", 4);
  if (/:\s*(string|number|boolean|void|any|unknown|never|object)\b/.test(src)) add("ts", 2);
  if (/\b(readonly|public|private|protected|as\s+\w+)\b/.test(src)) add("ts", 1);

  // react
  if (/from\s+["']react["']/.test(src) || /import\s+React\b/.test(src)) add("react", 5);
  if (/\b(useState|useEffect|useRef|useMemo|useCallback|useContext|useReducer)\s*\(/.test(src)) add("react", 3);
  if (/<[A-Z][\w]*[\s/>]/.test(src)) {
    add("react", 2);
    add("js", 1);
  }
  if (/export\s+default\s+function\s+[A-Z]/.test(src)) add("react", 2);

  // python
  if (/^\s*def\s+\w+\s*\(/m.test(src)) add("python", 4);
  if (/^\s*(import|from)\s+[\w.]/m.test(src)) add("python", 1);
  if (/^\s*class\s+\w+\s*(\([^)]*\))?\s*:/m.test(src)) add("python", 3);
  if (/if\s+__name__\s*==/.test(src)) add("python", 5);
  if (/^\s*(elif|else)\b.*:\s*$/m.test(src)) add("python", 1);
  if (/^\s*#.*$/m.test(src) && /:\s*$/m.test(src)) add("python", 1);

  // java
  if (/public\s+(class|interface|enum)\s/.test(src)) add("java", 4);
  if (/public\s+static\s+void\s+main\s*\(/.test(src)) add("java", 5);
  if (/^\s*package\s+[\w.]+\s*;/m.test(src)) add("java", 4);
  if (/System\.out\.print/.test(src)) add("java", 3);

  // go
  if (/^package\s+\w+/m.test(src)) add("go", 5);
  if (/\bfunc\s+\([^)]*\)?\s*\w+\s*\(/.test(src) || /\bfunc\s+\w+\s*\(/.test(src)) add("go", 3);
  if (/import\s*\(/.test(src)) add("go", 2);
  if (/\bfmt\./.test(src)) add("go", 2);

  // rust
  if (/\bfn\s+\w+\s*\(/.test(src)) add("rust", 3);
  if (/\blet\s+mut\b/.test(src)) add("rust", 3);
  if (/use\s+(std|crate)::/.test(src)) add("rust", 3);
  if (/\bpub\s+(fn|struct|enum|mod|use)\b/.test(src)) add("rust", 3);
  if (/\bimpl\s+\w+/.test(src)) add("rust", 2);

  // sql
  const upper = src.toUpperCase();
  if (/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/.test(upper)) add("sql", 4);
  if (/\b(FROM|WHERE|JOIN|GROUP\s+BY|ORDER\s+BY|VALUES|SET)\b/.test(upper)) add("sql", 2);

  // shell
  if (/^#!.*\b(sh|bash|zsh)\b/m.test(src)) add("shell", 5);
  if (/\b(echo|cd|ls|grep|sudo|chmod|export|cat|rm|mkdir)\s/.test(src)) add("shell", 2);
  if (/\b(npm|yarn|pnpm|git|docker|kubectl|curl|wget)\s/.test(src)) add("shell", 2);
  if (/^\s*\$\s/m.test(src)) add("shell", 1);

  // yaml
  if (/^\s*(apiVersion|kind|metadata|spec):/m.test(src)) add("yaml", 5);
  if (/^[\w-]+:\s*(\S.*)?$/m.test(src) && !/[;{}()]/.test(src)) add("yaml", 2);
  if (/^\s*-\s+\S/m.test(src) && !/<[a-z]/i.test(src)) add("yaml", 2);

  // markdown
  if (/^#{1,6}\s+\S/m.test(src)) add("markdown", 3);
  if (/^\s*[-*+]\s+\S/m.test(src) && !/<[a-z]/i.test(trimmed)) add("markdown", 1);
  if (/\[[^\]]+\]\([^)]+\)/.test(src)) add("markdown", 2);
  if (/```/.test(src)) add("markdown", 2);

  let best = "text";
  let bestScore = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) {
      bestScore = v;
      best = k;
    }
  }

  if (bestScore < 3) return { language: "text", confidence: 0.2, parser: "fallback" };
  if (best === "xml" && scores.html > scores.xml) best = "html";

  const parser: CodeParser =
    best === "html" || best === "xml" || best === "vue"
      ? "dom"
      : "regex";
  const confidence = Math.min(0.95, 0.45 + bestScore * 0.06);
  return { language: best, confidence, parser };
}

/* ---------------- 标题提取 ---------------- */

export function extractTitle(code: string, language: string): string {
  try {
    switch (language) {
      case "html":
      case "xml":
        return htmlTitle(code);
      case "css":
        return cssTitle(code);
      case "js":
      case "ts":
      case "react":
        return jsTitle(code, language);
      case "vue":
        return vueTitle(code);
      case "json":
        return jsonTitle(code);
      case "python":
        return pythonTitle(code);
      case "java":
        return javaTitle(code);
      case "go":
        return goTitle(code);
      case "rust":
        return rustTitle(code);
      case "sql":
        return sqlTitle(code);
      case "shell":
        return shellTitle(code);
      case "yaml":
        return yamlTitle(code);
      case "markdown":
        return markdownTitle(code);
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function htmlTitle(code: string): string {
  if (/<body[\s>]/i.test(code)) return "body";
  const doc = new DOMParser().parseFromString(code, "text/html");
  const roots = Array.from(doc.body.children);
  if (roots.length === 0) return "";
  const first = roots[0];
  const tag = first.tagName.toLowerCase();
  const id = first.getAttribute("id");
  if (id) return `#${id}`;
  const cls = first.getAttribute("class");
  if (cls && cls.trim()) return `.${cls.trim().split(/\s+/)[0]}`;
  if (roots.length > 1) return `${tag} · ${roots.length} 个元素`;
  return tag;
}

function cssTitle(code: string): string {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = src.match(/^\s*@([\w-]+)/);
  if (at) return at[1].toLowerCase();
  const sel = src.match(/(?:^|\})\s*([^{}@][^{}]*?)\s*\{/);
  if (sel) return stripSelector(sel[1]);
  return "";
}

function stripSelector(s: string): string {
  const first = s.split(",")[0].trim();
  const m = first.match(/[#.]([-\w]+)/);
  if (m) return m[1];
  const el = first.match(/^([a-zA-Z][\w-]*)/);
  if (el) return el[1];
  return first;
}

function jsTitle(code: string, language: string): string {
  const label = labelOf(language);
  let m: RegExpMatchArray | null;
  if ((m = code.match(/(?:export\s+default\s+|export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/))) return `${m[1]}()`;
  if ((m = code.match(/\bclass\s+([A-Za-z_$][\w$]*)/))) return m[1];
  if ((m = code.match(/\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) return m[1];
  if ((m = code.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/))) return `${m[1]}()`;
  if ((m = code.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) return m[1];
  if ((m = code.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)/))) return m[1];
  return label;
}

function vueTitle(code: string): string {
  let m = code.match(/\bname\s*:\s*["']([^"']+)["']/);
  if (m) return m[1];
  m = code.match(/defineOptions\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/);
  if (m) return m[1];
  m = code.match(/\bdefineComponent\s*\(\s*\{[\s\S]*?name\s*:\s*["']([^"']+)["']/);
  if (m) return m[1];

  const tpl = code.match(/<template>([\s\S]*?)<\/template>/i);
  if (tpl) {
    const inner = tpl[1].trim();
    const root = inner.match(/^<([a-zA-Z][\w-]*)([^>]*)>/);
    if (root) {
      const tag = root[1];
      const attrs = root[2] || "";
      const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/);
      if (id) return `#${id[1]}`;
      const cls = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/);
      if (cls) return `.${cls[1].trim().split(/\s+/)[0]}`;
      // 通用无意义标签（i/span/div 等）不直接当标题，尝试找首个带 class 的子元素
      const generic =
        /^(i|span|em|b|strong|div|section|ul|li|ol|p|a|button|img|svg|path|template|slot)$/i.test(
          tag,
        );
      if (!generic) return tag;
      const child = inner.match(
        /<([a-zA-Z][\w-]*)[^>]*\bclass\s*=\s*["']([^"']+)["']/,
      );
      if (child) return `.${child[2].trim().split(/\s+/)[0]}`;
    }
  }
  return "Vue";
}

function jsonTitle(code: string): string {
  try {
    const v = JSON.parse(code);
    if (Array.isArray(v)) return "JSON 数组";
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      if (keys.length >= 1) return keys[0];
      return "JSON 对象";
    }
    return "JSON";
  } catch {
    return "JSON";
  }
}

function pythonTitle(code: string): string {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/^\s*(?:async\s+)?def\s+(\w+)\s*\(/m))) return `${m[1]}()`;
  if ((m = code.match(/^\s*class\s+(\w+)/m))) return m[1];
  if ((m = code.match(/^\s*from\s+([\w.]+)\s+import/m))) return m[1];
  if ((m = code.match(/^\s*import\s+([\w.]+)/m))) return m[1];
  return "Python";
}

function javaTitle(code: string): string {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/\b(?:public\s+)?(?:final\s+)?class\s+(\w+)/))) return m[1];
  if ((m = code.match(/\binterface\s+(\w+)/))) return m[1];
  if ((m = code.match(/\benum\s+(\w+)/))) return m[1];
  if ((m = code.match(/\b(?:public|private|protected)?\s*(?:static\s+)?[\w<>[\],\s]+\s+(\w+)\s*\([^)]*\)\s*\{/))) return `${m[1]}()`;
  return "Java";
}

function goTitle(code: string): string {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/\bfunc\s+\([^)]*\)\s*(\w+)\s*\(/))) return `${m[1]}()`;
  if ((m = code.match(/\bfunc\s+(\w+)\s*\(/))) return `${m[1]}()`;
  if ((m = code.match(/\btype\s+(\w+)/))) return m[1];
  if ((m = code.match(/^package\s+(\w+)/m))) return m[1];
  return "Go";
}

function rustTitle(code: string): string {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/\bfn\s+(\w+)\s*\(/))) return `${m[1]}()`;
  if ((m = code.match(/\b(?:struct|enum|trait)\s+(\w+)/))) return m[1];
  if ((m = code.match(/\bmod\s+(\w+)/))) return m[1];
  return "Rust";
}

function sqlTitle(code: string): string {
  let m: RegExpMatchArray | null;
  if ((m = code.match(/\bFROM\s+([`"[]?[\w.]+[`"\]]?)/i))) return m[1].replace(/["`[\]]/g, "");
  if ((m = code.match(/\b(?:INSERT\s+INTO|UPDATE|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\s+([`"[]?[\w.]+[`"\]]?)/i)))
    return m[1].replace(/["`[\]]/g, "");
  return "SQL";
}

function shellTitle(code: string): string {
  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/^([\w./-]+)/);
    if (m) return m[1].split("/").pop() || m[1];
  }
  return "Shell";
}

function yamlTitle(code: string): string {
  const lines = code.split(/\r?\n/);
  for (const line of lines) {
    if (/^[\w-]+:/.test(line)) return line.split(":")[0].trim();
  }
  return "YAML";
}

function markdownTitle(code: string): string {
  const h = code.match(/^\s*#{1,6}\s+(.+)$/m);
  if (h) return h[1].trim().slice(0, 30);
  return "Markdown";
}

/* ---------------- 统一入口 ---------------- */

export function analyzeCodeBlock(
  code: string,
  explicitLanguage?: string,
  explicitTitle?: string,
): CodeBlockMeta {
  const src = code ?? "";
  const lineCount = countLines(src);
  const normExplicit = normalizeLanguage(explicitLanguage);

  let language: string;
  let confidence: number;
  let parser: CodeParser;

  if (normExplicit) {
    language = normExplicit;
    confidence = 1;
    parser = "explicit";
  } else {
    try {
      const d = detectLanguage(src);
      language = d.language;
      confidence = d.confidence;
      parser = d.parser;
    } catch {
      language = "text";
      confidence = 0;
      parser = "fallback";
    }
  }

  let autoTitle = "";
  try {
    autoTitle = extractTitle(src, language);
  } catch {
    autoTitle = "";
  }

  let title = (explicitTitle && explicitTitle.trim()) || autoTitle;
  if (!title) {
    title = language === "text" ? `代码 · ${lineCount} 行` : labelOf(language);
  }

  return { language, title, lineCount, confidence, parser };
}
