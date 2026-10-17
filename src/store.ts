import { create } from "zustand";
import type { AppData, Note } from "./types";
import * as backend from "./backend";
import { nowLocal, uid } from "./utils";
import type { AuthUser } from "./services/auth";
import { fetchQuota, isLocalAccount, AiError, type AiQuota, type AiErrorCode } from "./services/ai";

/* ---------------- 登录态本地持久化 ---------------- */
const AUTH_TOKEN_KEY = "microprompt.authToken";
const AUTH_USER_KEY = "microprompt.authUser";
const loadAuthToken = (): string | null => {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
};
const loadAuthUser = (): AuthUser | null => {
  try {
    const s = localStorage.getItem(AUTH_USER_KEY);
    return s ? (JSON.parse(s) as AuthUser) : null;
  } catch {
    return null;
  }
};
const saveAuthStorage = (token: string, user: AuthUser) => {
  try {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
};
const clearAuthStorage = () => {
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  } catch {
    /* ignore */
  }
};

/* ---------------- 登录有效期（30 天内有使用痕迹则自动登录） ---------------- */
const LAST_USED_KEY = "microprompt.lastUsedAt";
const SAVED_PWD_KEY = "microprompt.savedPassword";
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const loadLastUsed = (): number => {
  try {
    const v = localStorage.getItem(LAST_USED_KEY);
    return v ? Number(v) || 0 : 0;
  } catch {
    return 0;
  }
};
const touchLastUsed = () => {
  try {
    localStorage.setItem(LAST_USED_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
};
/** 超过 30 天未使用：清除登录态，仅保留用户名、清空密码 */
const expireLogin = () => {
  clearAuthStorage();
  try {
    localStorage.removeItem(LAST_USED_KEY);
    localStorage.removeItem(SAVED_PWD_KEY);
  } catch {
    /* ignore */
  }
};

/** 输入防抖：停止输入 500ms 落盘（与 C++ 版一致） */
const SAVE_DEBOUNCE_MS = 500;
/** 兜底：最大保存间隔（与 C++ 版 2s 检查脏标记对应） */
const SAVE_MAX_INTERVAL_MS = 2000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveMaxTimer: ReturnType<typeof setTimeout> | null = null;
let saving: Promise<void> | null = null;
let pendingPayload: string | null = null; // 最近一次待保存的载荷指纹

/** UI 缩放档位（0 小 / 1 中 / 2 大），默认中号，持久化到 localStorage */
const UI_SCALE_KEY = "microprompt.uiScale";
const loadUiScale = (): number => {
  try {
    const v = localStorage.getItem(UI_SCALE_KEY);
    const n = v === null ? 1 : Number(v);
    return n === 0 || n === 1 || n === 2 ? n : 1;
  } catch {
    return 1;
  }
};

/** 用户头像（data URL），null = 使用默认头像，持久化到 localStorage */
const AVATAR_KEY = "microprompt.avatar";
const loadAvatar = (): string | null => {
  try {
    return localStorage.getItem(AVATAR_KEY);
  } catch {
    return null;
  }
};

/** 护眼模式（全软件统一背景）：true=纸张黄，false=纯白。持久化到 localStorage */
const EYE_CARE_KEY = "microprompt.eyeCareMode";
const loadEyeCare = (): boolean => {
  try {
    return localStorage.getItem(EYE_CARE_KEY) === "1";
  } catch {
    return false;
  }
};

/** 编辑器默认字号（px），持久化到 localStorage */
const EDITOR_FONT_KEY = "microprompt.editorFontSize";
const loadEditorFont = (): number => {
  try {
    const v = localStorage.getItem(EDITOR_FONT_KEY);
    const n = v === null ? 13.33 : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 13.33;
  } catch {
    return 13.33;
  }
};

/** 是否显示字数统计，持久化到 localStorage（默认显示） */
const WORDCOUNT_KEY = "microprompt.showWordCount";
const loadShowWordCount = (): boolean => {
  try {
    const v = localStorage.getItem(WORDCOUNT_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};

/** 代码块自动识别开关，持久化到 localStorage（默认开启） */
const AUTO_DETECT_KEY = "microprompt.autoDetectCodeBlock";
const loadAutoDetect = (): boolean => {
  try {
    const v = localStorage.getItem(AUTO_DETECT_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};

/** 笔记列表是否显示时间，持久化到 localStorage（默认显示） */
const NOTE_TIME_KEY = "microprompt.showNoteTime";
const loadShowNoteTime = (): boolean => {
  try {
    const v = localStorage.getItem(NOTE_TIME_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
};

/** AI 自动润色开关（选中文本后出现润色按钮），持久化到 localStorage */
const AUTO_POLISH_KEY = "microprompt.autoPolish";
const loadAutoPolish = (): boolean => {
  try {
    return localStorage.getItem(AUTO_POLISH_KEY) === "1";
  } catch {
    return false;
  }
};

/** AI 润色框文字大小（pt，8/10/12），持久化到 localStorage（默认 8） */
const AI_FONT_KEY = "microprompt.aiFontSize";
const loadAiFont = (): number => {
  try {
    const v = localStorage.getItem(AI_FONT_KEY);
    const n = v === null ? 8 : Number(v);
    return n === 10 || n === 12 ? n : 8;
  } catch {
    return 8;
  }
};

/** 是否已展示首次欢迎页，持久化到 localStorage */
const WELCOME_KEY = "microprompt.welcomeDone";
const loadWelcomeDone = (): boolean => {
  try {
    return localStorage.getItem(WELCOME_KEY) === "1";
  } catch {
    return false;
  }
};

/** 可选软件主题色（--brand-rgb 用 "r, g, b" 形式） */
export const THEMES: {
  key: string;
  name: string;
  rgb: string;
  strong: string;
  hover: string;
  press: string;
}[] = [
  { key: "black", name: "墨黑", rgb: "31, 41, 55", strong: "17, 24, 39", hover: "#eef0f2", press: "#e2e6ea" },
  { key: "indigo", name: "靛蓝", rgb: "99, 102, 241", strong: "79, 70, 229", hover: "#eef2ff", press: "#e0e7ff" },
  { key: "emerald", name: "翠绿", rgb: "16, 185, 129", strong: "5, 150, 105", hover: "#ecfdf5", press: "#d1fae5" },
  { key: "rose", name: "玫红", rgb: "244, 63, 94", strong: "225, 29, 72", hover: "#fff1f2", press: "#ffe4e6" },
  { key: "amber", name: "琥珀", rgb: "245, 158, 11", strong: "217, 119, 6", hover: "#fffbeb", press: "#fef3c7" },
  { key: "violet", name: "紫罗兰", rgb: "139, 92, 246", strong: "124, 58, 237", hover: "#f5f3ff", press: "#ede9fe" },
  { key: "sky", name: "天蓝", rgb: "14, 165, 233", strong: "2, 132, 199", hover: "#f0f9ff", press: "#e0f2fe" },
];

/** 应用主题：改写根节点 CSS 变量 */
export function applyTheme(key: string) {
  const t = THEMES.find((x) => x.key === key) ?? THEMES[0];
  const root = document.documentElement;
  root.style.setProperty("--brand-rgb", t.rgb);
  root.style.setProperty("--brand-strong-rgb", t.strong);
  root.style.setProperty("--c-hover", t.hover);
  root.style.setProperty("--c-press", t.press);
}

const THEME_KEY = "microprompt.theme";
const loadTheme = (): string => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v && THEMES.some((t) => t.key === v) ? v : "black";
  } catch {
    return "black";
  }
};

/** 代码引用块的元信息（手动标题等），持久化到 localStorage，key = refblock uuid */
export type RefblockMetaEntry = { title: string; manualTitle: boolean };
const REFBLOCK_META_KEY = "microprompt.refblockMeta";
const loadRefblockMeta = (): Record<string, RefblockMetaEntry> => {
  try {
    const raw = localStorage.getItem(REFBLOCK_META_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object"
      ? (obj as Record<string, RefblockMetaEntry>)
      : {};
  } catch {
    return {};
  }
};
const persistRefblockMeta = (meta: Record<string, RefblockMetaEntry>) => {
  try {
    localStorage.setItem(REFBLOCK_META_KEY, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
};

interface StoreState {
  loaded: boolean;
  /** 登录态：token / 用户 / 是否已完成启动校验 */
  authToken: string | null;
  authUser: AuthUser | null;
  authReady: boolean;
  /** 登录页顶部提示（例如：旧的离线账号已停用，请用云端账号登录） */
  authNotice: string;
  /** 设置弹窗是否打开 / 是否只显示账号卡片（点击左上角头像） */
  settingsOpen: boolean;
  settingsAccountOnly: boolean;
  /** 笔记数据目录路径（首次欢迎页展示） */
  dataDir: string;
  /** 存储位置详情（4.6.0：设置页「存储」+ 文件管理台底部） */
  storage: backend.StorageInfo | null;
  /** 存储操作进行中（切换位置 / 搬移数据） */
  storageBusy: boolean;
  /** 文件管理台（4.6.0）是否打开 */
  notesManagerOpen: boolean;
  /** 是否已看过首次欢迎页 */
  welcomeDone: boolean;
  notes: Note[];
  refblocks: Record<string, string>;
  /** 代码引用块元信息（手动标题等），与 refblocks 用同一 uuid 关联 */
  refblockMeta: Record<string, RefblockMetaEntry>;
  currentId: string | null;
  pinned: boolean;
  maximized: boolean;
  /** UI 缩放档位：0 小 / 1 中 / 2 大 */
  uiScale: number;
  /** 用户头像 data URL；null = 默认头像 */
  avatar: string | null;
  /** 护眼模式：true=纸张黄，false=纯白（整个软件统一切换） */
  eyeCareMode: boolean;
  /** 编辑器默认字号（px） */
  editorFontSize: number;
  /** 是否显示右下角字数统计 */
  showWordCount: boolean;
  /** 粘贴时是否自动识别代码并询问是否添加为代码块 */
  autoDetectCodeBlock: boolean;
  /** 是否开启 AI 自动润色（选中文本后出现润色按钮） */
  autoPolish: boolean;
  /** AI 润色框文字大小（pt：8/10/12） */
  aiFontSize: number;
  /** AI 额度 / 会员状态（服务端为准；null=还没取到） */
  aiQuota: AiQuota | null;
  /** 取额度失败的原因（用于设置页提示，如离线账号/未登录） */
  aiQuotaError: string;
  /** 取额度失败的错误码（auth=需重新登录，local_account=离线账号，server_outdated=服务端没更新…） */
  aiQuotaErrorCode: AiErrorCode | "";
  /** 是否正在拉取额度 */
  aiQuotaLoading: boolean;
  /** 开通会员弹窗是否打开 */
  memberOpen: boolean;
  /** 笔记列表是否显示时间 */
  showNoteTime: boolean;
  /** 软件主题色 key（见 THEMES） */
  themeColor: string;
  /** 顶栏状态文字："编辑" / "保存中" / "" */
  statusText: string;
  /** 保存修订号：仅当保存时没有新改动才把状态切回"编辑" */
  rev: number;

  init: () => Promise<void>;
  setAuth: (token: string, user: AuthUser) => void;
  setAuthNotice: (v: string) => void;
  clearAuth: () => void;
  restoreAuth: () => Promise<void>;
  select: (id: string) => Promise<void>;
  updateContent: (id: string, content: string) => void;
  rename: (id: string, title: string) => void;
  setColor: (id: string, color: number) => void;
  setBackground: (id: string, background: number) => void;
  createNote: () => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  setRefblock: (uuid: string, code: string) => void;
  removeRefblock: (uuid: string) => void;
  /** 手动设置代码块标题（manualTitle=true，不再被自动识别覆盖） */
  setRefblockTitle: (uuid: string, title: string) => void;
  setPinned: (v: boolean) => void;
  setMaximized: (v: boolean) => void;
  setUiScale: (n: number) => void;
  setAvatar: (v: string | null) => void;
  setEyeCareMode: (v: boolean) => void;
  setEditorFontSize: (n: number) => void;
  setShowWordCount: (v: boolean) => void;
  setAutoDetectCodeBlock: (v: boolean) => void;
  setAutoPolish: (v: boolean) => void;
  setAiFontSize: (n: number) => void;
  /** 拉取 AI 额度 / 会员状态（登录后、润色后、打开设置时调用） */
  refreshAiQuota: () => Promise<void>;
  /** 用服务端随响应带回的额度直接更新（省一次请求） */
  setAiQuota: (q: AiQuota | null) => void;
  /** 打开 / 关闭「开通会员」弹窗 */
  openMember: () => void;
  closeMember: () => void;
  setShowNoteTime: (v: boolean) => void;
  setThemeColor: (key: string) => void;
  openSettings: (accountOnly?: boolean) => void;
  closeSettings: () => void;
  setDataDir: (v: string) => void;
  finishWelcome: () => void;
  flushSave: () => Promise<void>;
  /** 打开 / 关闭文件管理台 */
  openNotesManager: () => void;
  closeNotesManager: () => void;
  /** 重新读取存储信息（打开设置 / 切换位置后调用） */
  refreshStorage: () => Promise<void>;
  /** 切换笔记保存位置：moveData = 把现有笔记一起搬过去 */
  changeDataDir: (
    target: string,
    moveData: boolean,
  ) => Promise<backend.SwitchReport>;
  /** 恢复默认保存位置（安装目录\data） */
  restoreDefaultDataDir: (
    moveData: boolean,
  ) => Promise<backend.SwitchReport>;
  /** 从磁盘重新加载笔记（切换目录后） */
  reloadData: () => Promise<void>;
  /** 单条置顶 / 取消置顶 */
  setNotePinned: (id: string, v: boolean) => void;
  /** 批量置顶 */
  setNotesPinned: (ids: string[], v: boolean) => void;
  /** 批量改颜色 */
  setNotesColor: (ids: string[], color: number) => void;
  /** 批量删除 */
  removeNotes: (ids: string[]) => Promise<void>;
}

async function doSave(get: () => StoreState, set: (p: Partial<StoreState>) => void) {
  const { notes, refblocks, rev } = get();

  // 孤儿清理（对齐 C++ 版 clearOrphanRefblocks）：只保留当前笔记引用的引用块，
  // 删除文档中已不存在的代码原文，防止数据残留。
  const used = new Set<string>();
  const re = /data-refblock\s*=\s*["']([^"']+)["']/g;
  for (const n of notes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(n.content))) used.add(m[1]);
  }
  const cleanedRefblocks: Record<string, string> = {};
  for (const key of Object.keys(refblocks)) {
    if (used.has(key)) cleanedRefblocks[key] = refblocks[key];
  }

  // 直接复用 notes 引用（后端只读序列化），避免每次保存都全量浅拷贝带来的 GC 压力
  const payload: AppData = { notes, refblocks: cleanedRefblocks };
  const fingerprint = `${rev}`;
  pendingPayload = fingerprint;

  // 串行化：等待上一次保存完成（不阻塞新的编辑）
  if (saving) {
    try {
      await saving;
    } catch {
      /* 上一次失败不影响本次 */
    }
  }
  if (pendingPayload !== fingerprint) return; // 期间又有新改动，本次作废（下次保存）

  saving = backend
    .saveData(payload)
    .then(() => {
      if (pendingPayload === fingerprint) {
        pendingPayload = null;
        const now = get().rev;
        if (now === rev) set({ statusText: "编辑" });
      }
    })
    .catch((e) => {
      console.error("[save] 保存失败，等待下次重试:", e);
    })
    .finally(() => {
      saving = null;
    });
  return saving;
}

export const useStore = create<StoreState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void doSave(get, set);
    }, SAVE_DEBOUNCE_MS);
    if (!saveMaxTimer) {
      saveMaxTimer = setTimeout(() => {
        saveMaxTimer = null;
        saveTimer = null;
        void doSave(get, set);
      }, SAVE_MAX_INTERVAL_MS);
    }
  };

  const patchNote = (id: string, patch: Partial<Note>) => {
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    }));
  };

  return {
    loaded: false,
    authToken: loadAuthToken(),
    authUser: loadAuthUser(),
    authReady: false,
    authNotice: "",
    settingsOpen: false,
    settingsAccountOnly: false,
    dataDir: "",
    storage: null,
    storageBusy: false,
    notesManagerOpen: false,
    welcomeDone: loadWelcomeDone(),
    notes: [],
    refblocks: {},
    refblockMeta: loadRefblockMeta(),
    currentId: null,
    pinned: false,
    maximized: false,
    uiScale: loadUiScale(),
    avatar: loadAvatar(),
    eyeCareMode: loadEyeCare(),
    editorFontSize: loadEditorFont(),
    showWordCount: loadShowWordCount(),
    autoDetectCodeBlock: loadAutoDetect(),
    autoPolish: loadAutoPolish(),
    aiFontSize: loadAiFont(),
    aiQuota: null,
    aiQuotaError: "",
    aiQuotaErrorCode: "",
    aiQuotaLoading: false,
    memberOpen: false,
    showNoteTime: loadShowNoteTime(),
    themeColor: loadTheme(),
    statusText: "",
    rev: 0,

    init: async () => {
      let data: AppData = { notes: [], refblocks: {} };
      try {
        data = await backend.loadData();
      } catch (e) {
        console.error("[load] 加载失败:", e);
      }
      set({ notes: data.notes, refblocks: data.refblocks, loaded: true });

      try {
        const dir = await backend.getDataDir();
        set({ dataDir: dir });
      } catch {
        /* ignore */
      }

      void get().refreshStorage();

      // 有笔记则选中最近修改的一条（与 C++ 版启动行为一致）
      const notes = [...data.notes];
      if (notes.length > 0) {
        notes.sort((a, b) => (a.modified < b.modified ? 1 : -1));
        set({ currentId: notes[0].id, statusText: "编辑" });
      }

      try {
        const pinned = await backend.getPinned();
        set({ pinned });
      } catch {
        /* ignore */
      }
    },

    setAuth: (token: string, user: AuthUser) => {
      saveAuthStorage(token, user);
      touchLastUsed();
      set({ authToken: token, authUser: user });
      void get().refreshAiQuota();
    },

    setAuthNotice: (v: string) => set({ authNotice: v }),

    clearAuth: () => {
      clearAuthStorage();
      set({
        authToken: null,
        authUser: null,
        authNotice: "",
        aiQuota: null,
        aiQuotaError: "",
        aiQuotaErrorCode: "",
        memberOpen: false,
      });
    },

    openSettings: (accountOnly = false) => {
      set({ settingsOpen: true, settingsAccountOnly: accountOnly });
    },

    closeSettings: () => {
      set({ settingsOpen: false });
    },

    setDataDir: (v: string) => set({ dataDir: v }),

    finishWelcome: () => {
      try {
        localStorage.setItem(WELCOME_KEY, "1");
      } catch {
        /* ignore */
      }
      set({ welcomeDone: true });
    },

    restoreAuth: async () => {
      const token = loadAuthToken();
      if (!token) {
        set({ authReady: true });
        return;
      }

      // 4.0.3 起不再支持「本机离线账号」：遇到旧的 local:* / local-admin 登录态，
      // 直接清掉并要求用云端账号重新登录（否则 AI 润色必然不可用）。
      if (isLocalAccount(token)) {
        expireLogin();
        set({
          authToken: null,
          authUser: null,
          authReady: true,
          authNotice:
            "本机离线账号已停用：请用云端账号登录；没有账号就点下方「立即注册」，注册后即可使用 AI 润色",
        });
        return;
      }

      // 登录有效期：超过 30 天没有使用痕迹 → 需要重新登录
      // （清除密码，仅保留用户名，登录页会自动填用户名、让用户手输密码）
      // 登录有效期：仅当"明确超过 30 天"才要求重新登录；
      // 无最近使用记录时按有效处理（兼容旧数据，避免误登出）
      const last = loadLastUsed();
      if (last && Date.now() - last > THIRTY_DAYS_MS) {
        expireLogin();
        set({ authToken: null, authUser: null, authReady: true });
        return;
      }

      // 30 天内有使用痕迹：刷新"最近使用时间"，自动登录
      touchLastUsed();

      // 有 token 且 30 天内有使用痕迹 → 直接放行。
      // 不再请求后端校验：跨域校验请求会被服务器（Casdoor CSRF）拒绝，
      // 且网络波动会导致误登出；登录有效期统一由 lastUsedAt 控制。
      set({ authReady: true });
      // 登录态放行后顺手拉一次 AI 额度（失败不影响使用，设置页会显示原因）
      void get().refreshAiQuota();
    },

    select: async (id: string) => {
      if (get().currentId === id) return;
      await get().flushSave();
      set({ currentId: id });
    },

    updateContent: (id: string, content: string) => {
      // 仅内容变化才落盘
      const note = get().notes.find((n) => n.id === id);
      if (!note || note.content === content) return;
      patchNote(id, { content, modified: nowLocal() });
      set((s) => ({ statusText: "保存中", rev: s.rev + 1 }));
      scheduleSave();
    },

    rename: (id: string, title: string) => {
      if (!title.trim()) return;
      const note = get().notes.find((n) => n.id === id);
      if (!note || note.title === title) return;
      patchNote(id, { title, modified: nowLocal() });
      set((s) => ({ rev: s.rev + 1 }));
      scheduleSave();
    },

    setColor: (id: string, color: number) => {
      const note = get().notes.find((n) => n.id === id);
      if (!note || note.color === color) return;
      patchNote(id, { color, modified: nowLocal() });
      set((s) => ({ rev: s.rev + 1 }));
      scheduleSave();
    },

    setBackground: (id: string, background: number) => {
      const note = get().notes.find((n) => n.id === id);
      if (!note || note.background === background) return;
      patchNote(id, { background, modified: nowLocal() });
      set((s) => ({ rev: s.rev + 1 }));
      scheduleSave();
    },

    createNote: async () => {
      const now = nowLocal();
      const note: Note = {
        id: uid(),
        title: "新建笔记",
        content: "",
        background: 0,
        color: 0,
        created: now,
        modified: now,
      };
      set((s) => ({ notes: [note, ...s.notes] }));
      await get().flushSave();
      set({ currentId: note.id, statusText: "编辑" });
      scheduleSave();
    },

    removeNote: async (id: string) => {
      await get().flushSave();
      set((s) => ({
        notes: s.notes.filter((n) => n.id !== id),
        currentId: s.currentId === id ? null : s.currentId,
      }));
      scheduleSave();
    },

    setRefblock: (uuid: string, code: string) => {
      if (get().refblocks[uuid] === code) return;
      set((s) => ({ refblocks: { ...s.refblocks, [uuid]: code }, rev: s.rev + 1 }));
      scheduleSave();
    },

    removeRefblock: (uuid: string) => {
      if (!(uuid in get().refblocks)) return;
      set((s) => {
        const rb = { ...s.refblocks };
        delete rb[uuid];
        const meta = { ...s.refblockMeta };
        delete meta[uuid];
        persistRefblockMeta(meta);
        return { refblocks: rb, refblockMeta: meta, rev: s.rev + 1 };
      });
      scheduleSave();
    },

    setRefblockTitle: (uuid: string, title: string) => {
      const t = title.trim();
      set((s) => {
        const meta = { ...s.refblockMeta };
        if (!t) delete meta[uuid];
        else meta[uuid] = { title: t, manualTitle: true };
        persistRefblockMeta(meta);
        return { refblockMeta: meta };
      });
    },

    setPinned: (v: boolean) => {
      set({ pinned: v });
      void backend.setPinned(v).then((real) => set({ pinned: real }));
    },

    setMaximized: (v: boolean) => set({ maximized: v }),

    setUiScale: (n: number) => {
      const scale = n === 0 || n === 1 || n === 2 ? n : 1;
      try {
        localStorage.setItem(UI_SCALE_KEY, String(scale));
      } catch {
        /* ignore */
      }
      set({ uiScale: scale });
    },

    setAvatar: (v: string | null) => {
      try {
        if (v) localStorage.setItem(AVATAR_KEY, v);
        else localStorage.removeItem(AVATAR_KEY);
      } catch {
        /* ignore */
      }
      set({ avatar: v });
    },

    setEyeCareMode: (v: boolean) => {
      try {
        localStorage.setItem(EYE_CARE_KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
      set({ eyeCareMode: v });
    },

    setEditorFontSize: (n: number) => {
      const size = Number.isFinite(n) && n > 0 ? n : 13.33;
      try {
        localStorage.setItem(EDITOR_FONT_KEY, String(size));
      } catch {
        /* ignore */
      }
      set({ editorFontSize: size });
    },

    setShowWordCount: (v: boolean) => {
      try {
        localStorage.setItem(WORDCOUNT_KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
      set({ showWordCount: v });
    },

    setAutoDetectCodeBlock: (v: boolean) => {
      try {
        localStorage.setItem(AUTO_DETECT_KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
      set({ autoDetectCodeBlock: v });
    },

    setAutoPolish: (v: boolean) => {
      try {
        localStorage.setItem(AUTO_POLISH_KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
      set({ autoPolish: v });
    },

    setAiFontSize: (n: number) => {
      const size = n === 10 || n === 12 ? n : 8;
      try {
        localStorage.setItem(AI_FONT_KEY, String(size));
      } catch {
        /* ignore */
      }
      set({ aiFontSize: size });
    },

    /* ---------------- AI 额度 / 会员 ---------------- */
    refreshAiQuota: async () => {
      const token = get().authToken;
      if (!token) {
        set({
          aiQuota: null,
          aiQuotaError: "请先登录后使用 AI 功能",
          aiQuotaErrorCode: "auth",
        });
        return;
      }
      if (isLocalAccount(token)) {
        set({
          aiQuota: null,
          aiQuotaError: "当前是本机离线账号，AI 需要登录云端账号后使用",
          aiQuotaErrorCode: "local_account",
        });
        return;
      }
      set({ aiQuotaLoading: true });
      try {
        const quota = await fetchQuota(token);
        set({
          aiQuota: quota,
          aiQuotaError: "",
          aiQuotaErrorCode: "",
          aiQuotaLoading: false,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "无法获取 AI 额度";
        const code = e instanceof AiError ? e.code : "error";
        set({ aiQuotaError: msg, aiQuotaErrorCode: code, aiQuotaLoading: false });
      }
    },

    setAiQuota: (q: AiQuota | null) => {
      if (q) set({ aiQuota: q, aiQuotaError: "", aiQuotaErrorCode: "" });
    },

    openMember: () => set({ memberOpen: true }),
    closeMember: () => set({ memberOpen: false }),

    setShowNoteTime: (v: boolean) => {
      try {
        localStorage.setItem(NOTE_TIME_KEY, v ? "1" : "0");
      } catch {
        /* ignore */
      }
      set({ showNoteTime: v });
    },

    setThemeColor: (key: string) => {
      const k = THEMES.some((t) => t.key === key) ? key : "black";
      applyTheme(k);
      try {
        localStorage.setItem(THEME_KEY, k);
      } catch {
        /* ignore */
      }
      set({ themeColor: k });
    },

    flushSave: async () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      const s = get();
      if (s.rev === 0 && pendingPayload === null) return;
      await doSave(get, set);
    },

    /* ---------------- 文件管理台 / 存储位置（4.6.0） ---------------- */

    openNotesManager: () => set({ notesManagerOpen: true }),
    closeNotesManager: () => set({ notesManagerOpen: false }),

    refreshStorage: async () => {
      try {
        const info = await backend.getStorageInfo();
        set({ storage: info, dataDir: info.dir });
      } catch (e) {
        console.error("[storage] 读取存储信息失败:", e);
      }
    },

    changeDataDir: async (target: string, moveData: boolean) => {
      // 先把内存里的改动落盘，再搬移，避免丢掉最后几个字
      await get().flushSave();
      set({ storageBusy: true });
      try {
        const report = await backend.switchDataDir(target, moveData);
        await get().reloadData();
        await get().refreshStorage();
        return report;
      } finally {
        set({ storageBusy: false });
      }
    },

    restoreDefaultDataDir: async (moveData: boolean) => {
      await get().flushSave();
      set({ storageBusy: true });
      try {
        const report = await backend.resetDataDir(moveData);
        await get().reloadData();
        await get().refreshStorage();
        return report;
      } finally {
        set({ storageBusy: false });
      }
    },

    reloadData: async () => {
      try {
        const data = await backend.loadData();
        set((s) => ({
          notes: data.notes,
          refblocks: data.refblocks,
          currentId:
            s.currentId && data.notes.some((n) => n.id === s.currentId)
              ? s.currentId
              : (data.notes[0]?.id ?? null),
        }));
      } catch (e) {
        console.error("[load] 重新加载失败:", e);
      }
    },

    setNotePinned: (id: string, v: boolean) => {
      const note = get().notes.find((n) => n.id === id);
      if (!note || Boolean(note.pinned) === v) return;
      patchNote(id, { pinned: v, modified: nowLocal() });
      set((s) => ({ rev: s.rev + 1 }));
      scheduleSave();
    },

    setNotesPinned: (ids: string[], v: boolean) => {
      if (ids.length === 0) return;
      const set0 = new Set(ids);
      const now = nowLocal();
      set((s) => ({
        notes: s.notes.map((n) =>
          set0.has(n.id) && Boolean(n.pinned) !== v
            ? { ...n, pinned: v, modified: now }
            : n,
        ),
        rev: s.rev + 1,
      }));
      scheduleSave();
    },

    setNotesColor: (ids: string[], color: number) => {
      if (ids.length === 0) return;
      const set0 = new Set(ids);
      const now = nowLocal();
      set((s) => ({
        notes: s.notes.map((n) =>
          set0.has(n.id) && n.color !== color
            ? { ...n, color, modified: now }
            : n,
        ),
        rev: s.rev + 1,
      }));
      scheduleSave();
    },

    removeNotes: async (ids: string[]) => {
      if (ids.length === 0) return;
      await get().flushSave();
      const set0 = new Set(ids);
      set((s) => ({
        notes: s.notes.filter((n) => !set0.has(n.id)),
        currentId:
          s.currentId && set0.has(s.currentId) ? null : s.currentId,
      }));
      scheduleSave();
    },
  };
});
