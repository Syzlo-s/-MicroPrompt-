/* ============================================================
 * AI 润色 / 会员额度接口（4.0.2）
 *   - 服务端：轻提词 AI 中转（server_ai/ai_server.py，端口 2581）
 *   - 所有请求都带登录 token：Authorization: Bearer <Casdoor access_token>
 *   - 额度、会员、订单全部由服务端判定，客户端只做展示，改前端绕不过
 *
 * 接口：
 *   POST /ai/polish       { text, system? }  -> { result, quota }
 *   GET  /ai/quota                            -> { quota }
 *   POST /ai/order        { plan }            -> { order, quota }
 *   GET  /ai/order?id=                        -> { order, quota }
 *   POST /ai/order/claim  { id }              -> { order }
 *   GET  /ai/paycode.png                      -> 收款码图片
 * ============================================================ */

/** AI 中转服务地址。真实地址写在项目根目录 .env（VITE_AI_URL），
 *  模板见 .env.example；源码内不留真实服务器地址。 */
export const AI_URL =
  (import.meta.env.VITE_AI_URL as string | undefined) ||
  "http://127.0.0.1:2581";

/** 免费额度提示文案用的默认值（真实值以服务端返回为准） */
export const FREE_DAILY_QUOTA = 3;

/** 单次润色的字符上限（与服务端 ai_server.py 的 20000 保持一致）。
 *  「自动润色」默认润色整篇提示词，长笔记很容易超限 —— 客户端先预检，
 *  本地拦下并提示分段，避免白跑一次请求（服务端拒绝时不会扣额度）。 */
export const AI_MAX_CHARS = 20000;

/** 会员套餐（与欢迎页 / 服务端 PLANS 保持一致） */
export interface AiPlan {
  key: "day" | "month";
  name: string;
  desc: string;
  days: number;
  amount: number;
}

export const AI_PLANS: AiPlan[] = [
  { key: "day", name: "日卡", desc: "24 小时不限量", days: 1, amount: 2 },
  { key: "month", name: "月卡", desc: "30 天不限量", days: 30, amount: 8 },
];

/** 服务端返回的额度 / 会员状态 */
export interface AiQuota {
  member: boolean;
  /** 会员到期时间（秒级时间戳，0=未开通） */
  memberUntil: number;
  plan: "free" | "unlimited";
  /** 管理员在后台给这个账号开通的「免费不限量」（不受每天免费额度限制） */
  free?: boolean;
  /** 「免费不限量」账号今日已用次数 */
  unlimitedUsedToday?: number;
  freeQuota: number;
  freeUsedToday: number;
  memberCap: number;
  memberUsedToday: number;
  remainingToday: number;
  totalCalls: number;
  day?: string;
}

export interface AiOrder {
  id: string;
  plan: string;
  planName: string;
  days: number;
  amount: number;
  status: "pending" | "claimed" | "paid" | "canceled";
  created: number;
  paidAt: number;
}

/** AI 相关错误的错误码（与 ai_server.py 的 code 字段一一对应） */
export type AiErrorCode =
  | "auth" // 401 未登录 / 登录失效
  | "local_account" // 本机离线账号无法使用 AI
  | "free_exhausted" // 402 免费额度用完
  | "member_cap" // 402 会员防滥用上限
  | "rate_limited" // 429 调用太快
  | "too_long" // 400 单次文本过长
  | "bad_request"
  | "not_found"
  | "upstream" // 上游 AI 出错
  | "network" // 连不上中转服务
  | "server_outdated" // 服务端还是 4.0.0 旧版（没有额度/会员接口）
  | "error";

export class AiError extends Error {
  code: AiErrorCode;
  quota?: AiQuota | null;
  constructor(code: AiErrorCode, message: string, quota?: AiQuota | null) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.quota = quota ?? null;
  }
}

/** 本机离线账号（token 形如 local:xxx / local-admin）没有服务端身份 */
export function isLocalAccount(token: string | null | undefined): boolean {
  return !!token && (token.startsWith("local:") || token === "local-admin");
}

/** 额度/支付类错误：应引导用户开通会员 */
export function isQuotaError(code: AiErrorCode): boolean {
  return code === "free_exhausted" || code === "member_cap";
}

/**
 * 规范化 AI 输出：
 *   - 去掉每行行首的多余空白（缩进），避免每行前面都空一格
 *   - 3 个以上连续换行压成一个空行（只在需要时才空行）
 */
function normalizeResult(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^[ \t\u3000]+/, "").replace(/[ \t\u3000]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface RawResponse {
  ok?: boolean;
  error?: string;
  code?: string;
  quota?: AiQuota;
  order?: AiOrder;
  result?: string;
}

/** 统一请求：拼地址 + 带 token + 统一错误码 */
async function request(
  path: string,
  opts: {
    method?: "GET" | "POST";
    body?: unknown;
    token?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<RawResponse> {
  const token = opts.token ?? null;
  if (isLocalAccount(token)) {
    throw new AiError(
      "local_account",
      "当前是本机离线账号，AI 功能需要登录云端账号后使用",
    );
  }
  if (!token) {
    throw new AiError("auth", "请先登录后再使用 AI 功能");
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  let res: Response;
  try {
    res = await fetch(`${AI_URL}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
  } catch {
    throw new AiError("network", "AI 服务超时或无法连接，请稍后重试");
  } finally {
    clearTimeout(timer);
  }

  let data: RawResponse = {};
  try {
    data = (await res.json()) as RawResponse;
  } catch {
    data = {};
  }

  if (!res.ok || data.ok === false) {
    // 4.0.0 旧服务端：没有 /ai/quota、/ai/order 等接口（404/501），
    // 响应体里也没有 ok 字段。这种情况给出明确指引，别把英文 not found 甩给用户。
    const legacy = !("ok" in data);
    if (legacy || res.status === 404 || res.status === 501) {
      throw new AiError(
        "server_outdated",
        "AI 服务端还是旧版本：额度与会员暂不可用（AI 润色仍可正常使用）",
        null,
      );
    }
    const code = (data.code as AiErrorCode) || "error";
    const msg =
      data.error ||
      (code === "auth"
        ? "登录状态已失效，请重新登录"
        : code === "network"
          ? "无法连接 AI 服务"
          : "AI 服务请求失败");
    throw new AiError(code, msg, data.quota ?? null);
  }
  return data;
}

/** AI 润色：成功返回润色结果 + 最新额度 */
export async function polishText(
  text: string,
  token?: string | null,
): Promise<{ result: string; quota: AiQuota | null }> {
  const input = text.trim();
  if (!input) throw new AiError("bad_request", "没有可润色的内容");

  const data = await request("/ai/polish", {
    method: "POST",
    body: { text: input },
    token,
  });
  if (!data.result) throw new AiError("upstream", data.error || "AI 润色失败");
  return { result: normalizeResult(data.result), quota: data.quota ?? null };
}

/** 查询当前额度 / 会员状态（用 POST：见 server 端注释——旧版服务端对 GET 的 501 不带 CORS 头） */
export async function fetchQuota(token?: string | null): Promise<AiQuota> {
  const data = await request("/ai/quota", {
    method: "POST",
    body: {},
    token,
    timeoutMs: 15000,
  });
  if (!data.quota) throw new AiError("error", "无法获取 AI 额度");
  return data.quota;
}

/** 下单（日卡 / 月卡） */
export async function createOrder(
  plan: AiPlan["key"],
  token?: string | null,
): Promise<{ order: AiOrder; quota: AiQuota | null }> {
  const data = await request("/ai/order", {
    method: "POST",
    body: { plan },
    token,
    timeoutMs: 20000,
  });
  if (!data.order) throw new AiError("error", "下单失败，请稍后重试");
  return { order: data.order, quota: data.quota ?? null };
}

/** 用户点「我已完成支付」 */
export async function claimOrder(
  id: string,
  token?: string | null,
): Promise<AiOrder> {
  const data = await request("/ai/order/claim", {
    method: "POST",
    body: { id },
    token,
    timeoutMs: 20000,
  });
  if (!data.order) throw new AiError("error", "提交失败，请稍后重试");
  return data.order;
}

/** 轮询订单状态（开通后 status 变 paid） */
export async function fetchOrder(
  id: string,
  token?: string | null,
): Promise<{ order: AiOrder; quota: AiQuota | null }> {
  const data = await request(`/ai/order?id=${encodeURIComponent(id)}`, {
    token,
    timeoutMs: 15000,
  });
  if (!data.order) throw new AiError("error", "订单不存在");
  return { order: data.order, quota: data.quota ?? null };
}

/** 我最近的一笔订单：用于重开弹窗时恢复"等待确认"状态，
 *  避免用户已付款、客服还没确认时又下一单（可能被重复收款） */
export async function fetchMyOrder(
  token?: string | null,
): Promise<AiOrder | null> {
  const data = await request("/ai/orders/mine", {
    method: "POST",
    body: {},
    token,
    timeoutMs: 15000,
  });
  return data.order ?? null;
}

/** 收款方式（4.0.2 起：每个套餐可以各配一张微信 / 支付宝收款码） */
export type PayMethod = "wechat" | "alipay";

export interface PayCode {
  plan: string;
  method: string;
  /** 服务端返回的相对地址，如 /ai/paycode/month/wechat.png */
  url: string;
}

/** 收款码图片地址：给了套餐 + 方式就用对应的那张；否则回退到通用图（兼容老部署） */
export function paycodeUrl(plan?: string, method?: string): string {
  if (plan && method) return `${AI_URL}/ai/paycode/${plan}/${method}.png`;
  return `${AI_URL}/ai/paycode.png`;
}

/** 拉取服务端上有哪些收款码可用。
 *  老服务端没有 /ai/paycodes，会抛错 —— 调用方要兜底成"只用通用收款码"。 */
export async function fetchPayCodes(
  token?: string | null,
): Promise<{ codes: PayCode[]; legacyUrl: string }> {
  const data = (await request("/ai/paycodes", { token })) as {
    codes?: PayCode[];
    legacyUrl?: string;
  };
  return { codes: data.codes ?? [], legacyUrl: data.legacyUrl ?? "" };
}

/** 秒级时间戳 → "2026-11-09 08:47" */
export function formatMemberUntil(ts: number): string {
  if (!ts) return "未开通";
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 会员剩余天数（向上取整，0 表示已过期/未开通） */
export function memberDaysLeft(ts: number): number {
  if (!ts) return 0;
  const left = ts * 1000 - Date.now();
  return left <= 0 ? 0 : Math.ceil(left / 86400000);
}
