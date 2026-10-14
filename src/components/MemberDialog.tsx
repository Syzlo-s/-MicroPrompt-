import React from "react";
import { useStore } from "../store";
import {
  AI_PLANS,
  AI_URL,
  claimOrder,
  createOrder,
  fetchMyOrder,
  fetchOrder,
  fetchPayCodes,
  formatMemberUntil,
  memberDaysLeft,
  paycodeUrl,
  type AiOrder,
  type AiPlan,
  type PayCode,
  type PayMethod,
} from "../services/ai";

/** 客服反馈邮箱（与设置页 / 欢迎页保持一致） */
const SUPPORT_EMAIL = "Songyizhen5565@outlook.com";
/** 轮询订单状态的间隔 */
const POLL_MS = 4000;

/**
 * 开通 AI 会员弹窗（4.0.2）
 *   1) 选套餐（日卡 2 元 / 月卡 8 元）
 *   2) 生成订单 → 展示订单号 + 金额 + 收款码
 *   3) 用户付款后点「我已完成支付」→ 自动轮询，客服确认后即刻开通
 *
 * 支付目前是「半自动」：通道接入后由服务端回调自动开通，客户端这段流程不用改。
 */
export default function MemberDialog({ onClose }: { onClose: () => void }) {
  const authToken = useStore((s) => s.authToken);
  const quota = useStore((s) => s.aiQuota);
  const aiQuotaError = useStore((s) => s.aiQuotaError);
  const setAiQuota = useStore((s) => s.setAiQuota);
  const refreshAiQuota = useStore((s) => s.refreshAiQuota);
  const authUser = useStore((s) => s.authUser);
  const uiScale = useStore((s) => s.uiScale);

  // 随软件窗口大小同步缩放（与设置弹窗同一套规则，避免溢出窗口）
  const [panelZoom, setPanelZoom] = React.useState(1);
  React.useEffect(() => {
    const appZoom = [1, 1.15, 1.3][uiScale] ?? 1;
    const compute = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const s = Math.min((w - 48) / (340 * appZoom), (h - 48) / (520 * appZoom));
      setPanelZoom(Math.max(0.5, Math.min(1, s)));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [uiScale]);

  const [plan, setPlan] = React.useState<AiPlan["key"]>("month");
  const [order, setOrder] = React.useState<AiOrder | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [paycodeOk, setPaycodeOk] = React.useState(true);
  const [payCodes, setPayCodes] = React.useState<PayCode[]>([]);
  const [payMethod, setPayMethod] = React.useState<PayMethod>("wechat");
  const [srcIdx, setSrcIdx] = React.useState(0);
  const [paid, setPaid] = React.useState(false);
  const pollRef = React.useRef<number | null>(null);

  const current = AI_PLANS.find((p) => p.key === plan) ?? AI_PLANS[1];

  // 当前订单套餐下可用的收款方式 / 收款码；列表为空时退回通用收款码
  const planCodes = payCodes.filter((c) => c.plan === (order?.plan ?? ""));
  const methods = Array.from(new Set(planCodes.map((c) => c.method))) as PayMethod[];
  const activeMethod: PayMethod = methods.includes(payMethod)
    ? payMethod
    : ((methods[0] as PayMethod | undefined) ?? "wechat");
  const activeCode = planCodes.find((c) => c.method === activeMethod);
  const qrCandidates = [
    ...(activeCode ? [`${AI_URL}${activeCode.url}`] : []),
    paycodeUrl(),
  ];
  const qrSrc = qrCandidates[Math.min(srcIdx, qrCandidates.length - 1)];

  React.useEffect(() => {
    setSrcIdx(0);
    setPaycodeOk(true);
  }, [payMethod, order?.plan]);

  // 服务端有哪些收款码（每个套餐可各配微信/支付宝两 张）。
  // 老服务端没有 /ai/paycodes → 清单为空 → 自动退回通用收款码 paycode.png
  React.useEffect(() => {
    let alive = true;
    void fetchPayCodes(authToken)
      .then((r) => {
        if (alive) setPayCodes(r.codes);
      })
      .catch(() => {
        if (alive) setPayCodes([]);
      });
    return () => {
      alive = false;
    };
  }, [authToken]);

  const stopPoll = React.useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 进入弹窗时刷新一次额度
  React.useEffect(() => {
    void refreshAiQuota();
    return stopPoll;
  }, [refreshAiQuota, stopPoll]);

  // 恢复我最近的一笔未完成订单：
  //   已经点过「我已完成支付」→ 直接进入"等待确认"并继续轮询（不会重复下单、重复付款）
  //   2 小时内刚下但还没付 → 回到付款页（同一个订单号）
  React.useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const o = await fetchMyOrder(authToken);
        if (!alive || !o) return;
        const ageH = (Date.now() / 1000 - o.created) / 3600;
        if (o.status === "claimed" || (o.status === "pending" && ageH < 2)) {
          setOrder((cur) => cur ?? o);
          setPlan((cur) => (o.plan === "day" || o.plan === "month" ? o.plan : cur));
          if (o.status === "claimed") setMsg("已提交，正在等待确认开通…");
        }
      } catch {
        /* 额度卡片会给出更准确的提示，这里静默 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [authToken]);

  // 已提交支付后轮询订单状态
  React.useEffect(() => {
    if (!order || order.status === "paid") {
      stopPoll();
      return;
    }
    if (order.status !== "claimed") return;

    const tick = async () => {
      try {
        const { order: latest, quota: q } = await fetchOrder(order.id, authToken);
        setOrder(latest);
        if (q) setAiQuota(q);
        if (latest.status === "paid") {
          setPaid(true);
          stopPoll();
          void refreshAiQuota();
        }
      } catch {
        /* 网络抖动忽略，下一轮再试 */
      }
    };
    pollRef.current = window.setInterval(() => void tick(), POLL_MS);
    return stopPoll;
  }, [order, authToken, setAiQuota, refreshAiQuota, stopPoll]);

  const handleCreate = async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await createOrder(plan, authToken);
      setOrder(r.order);
      if (r.quota) setAiQuota(r.quota);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "下单失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const handleClaim = async () => {
    if (!order) return;
    setBusy(true);
    setMsg("");
    try {
      const o = await claimOrder(order.id, authToken);
      setOrder(o);
      setMsg("已提交，正在等待确认开通…");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "提交失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = async () => {
    if (order) {
      try {
        const { order: latest, quota: q } = await fetchOrder(order.id, authToken);
        setOrder(latest);
        if (q) setAiQuota(q);
        if (latest.status === "paid") {
          setPaid(true);
          stopPoll();
        }
        setMsg(latest.status === "paid" ? "" : "还没有收到开通确认，稍后再试或联系客服");
      } catch (e) {
        setMsg(e instanceof Error ? e.message : "刷新失败");
      }
    }
    void refreshAiQuota();
  };

  const statusLine = quota
    ? quota.free
      ? "免费不限量 · 管理员已为你的账号开通，无需购买"
      : quota.member
        ? `会员 · 有效期至 ${formatMemberUntil(quota.memberUntil)}（剩余 ${memberDaysLeft(quota.memberUntil)} 天）`
        : `免费版 · 今日剩余 ${quota.remainingToday}/${quota.freeQuota} 次`
    : aiQuotaError || "正在获取额度…";

  return (
    <div
      className="dialog-overlay settings-overlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-panel member-panel" style={{ zoom: panelZoom }}>
        <div className="member-head">
          <div className="dialog-title">开通 AI 会员</div>
          <button className="member-close" title="关闭" onClick={onClose}>
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="member-status">{statusLine}</div>

        {paid ? (
          <div className="member-success">
            <div className="member-success-title">开通成功 🎉</div>
            <div className="member-success-sub">
              {quota?.member
                ? `有效期至 ${formatMemberUntil(quota.memberUntil)}，AI 润色已不限量使用`
                : "AI 润色已不限量使用"}
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                void refreshAiQuota();
                onClose();
              }}
            >
              开始使用
            </button>
          </div>
        ) : (
          <>
            {/* 套餐选择 */}
            <div className="member-plans">
              {AI_PLANS.map((p) => (
                <button
                  key={p.key}
                  className={"member-plan" + (plan === p.key ? " on" : "")}
                  onClick={() => setPlan(p.key)}
                  disabled={!!order}
                >
                  <span className="member-plan-name">{p.name}</span>
                  <span className="member-plan-price">¥{p.amount}</span>
                  <span className="member-plan-desc">{p.desc}</span>
                </button>
              ))}
            </div>

            {!order ? (
              <>
                <div className="member-hint">
                  未开通用户每天可免费使用 {quota?.freeQuota ?? 3} 次 AI 润色；
                  开通后不限量（正常使用）。
                </div>
                <div className="member-actions">
                  <button className="btn btn-primary" disabled={busy} onClick={() => void handleCreate()}>
                    {busy ? "正在生成订单…" : `生成订单（¥${current.amount}）`}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="member-order">
                  <div className="member-order-row">
                    <span>订单号</span>
                    <b>{order.id}</b>
                  </div>
                  <div className="member-order-row">
                    <span>套餐</span>
                    <b>
                      {order.planName}（{order.days} 天）
                    </b>
                  </div>
                  <div className="member-order-row">
                    <span>应付金额</span>
                    <b className="member-amount">¥{order.amount.toFixed(2)}</b>
                  </div>
                  <div className="member-order-row">
                    <span>账号</span>
                    <b>{authUser?.username ?? "当前账号"}</b>
                  </div>
                </div>

                {order.status === "pending" ? (
                  <>
                    <div className="member-pay">
                      {methods.length > 1 && (
                        <div className="member-pay-methods">
                          {methods.map((m) => (
                            <button
                              key={m}
                              type="button"
                              className={
                                "member-pay-method" +
                                (m === activeMethod ? " active" : "")
                              }
                              onClick={() => setPayMethod(m)}
                            >
                              {m === "wechat" ? "微信支付" : "支付宝"}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="member-pay-tip">
                        付款时请备注订单号后 4 位：
                        <b>{order.id.slice(-4)}</b>
                      </div>
                      {paycodeOk ? (
                        <img
                          className="member-paycode"
                          src={qrSrc}
                          alt="收款码"
                          onError={() => {
                            if (srcIdx < qrCandidates.length - 1) {
                              setSrcIdx(srcIdx + 1);
                            } else {
                              setPaycodeOk(false);
                            }
                          }}
                        />
                      ) : (
                        <div className="member-paycode-fallback">
                          <div>收款码未上传</div>
                          <div className="member-hint">
                            请扫码或联系客服获取收款方式：
                            <br />
                            {SUPPORT_EMAIL}
                          </div>
                        </div>
                      )}
                    </div>
                    <div className="member-actions">
                      <button
                        className="btn"
                        onClick={() => setOrder(null)}
                        disabled={busy}
                      >
                        重新选套餐
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => void handleClaim()}
                      >
                        {busy ? "提交中…" : "我已完成支付"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="member-waiting">
                      已提交付款信息，正在等待确认开通（通常几分钟内）。
                      <br />
                      若长时间未开通，请把订单号发给客服：{SUPPORT_EMAIL}
                    </div>
                    <div className="member-actions">
                      <button className="btn" onClick={() => void handleRefresh()}>
                        刷新状态
                      </button>
                      <button className="btn btn-primary" onClick={() => void handleRefresh()}>
                        我已开通，刷新额度
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {msg && <div className="set-hint member-msg">{msg}</div>}
          </>
        )}
      </div>
    </div>
  );
}
