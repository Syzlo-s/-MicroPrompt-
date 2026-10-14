import React from "react";
import { useStore, THEMES } from "../store";
import { uploadAvatar, updateProfile } from "../services/auth";
import { formatMemberUntil, memberDaysLeft } from "../services/ai";
import { fileToAvatarDataUrl, MAX_AVATAR_BYTES } from "../utils";
import defaultAvatar from "../assets/icons/default-avatar.svg";

const UI_MARKS = ["小", "中", "大"];
/** 单个面板设计宽度（缩放基准） */
const PANEL_W = 320;
/** 客服反馈邮箱 */
const SUPPORT_EMAIL = "Songyizhen5565@outlook.com";

/** 说明提示：文字右侧的小感叹号，鼠标悬停 1 秒后显示作用说明 */
function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" data-tip={text}>
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <circle cx="12" cy="7.6" r="0.7" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}

/** 迷你 UI 预览窗口：随开关 / 主题实时变化 */
function MiniUI({
  kind,
  on = true,
}: {
  kind: "eyecare" | "count" | "time" | "theme";
  on?: boolean;
}) {
  if (kind === "time") {
    return (
      <div className={"mini-bubble" + (on ? " on" : "")}>
        <span className="mini-bubble-title">我的笔记</span>
        {on && <span className="mini-bubble-date">2026-09-29 12:00</span>}
      </div>
    );
  }
  const cls =
    "mini-ui mini-editor" +
    (kind === "eyecare" ? " mini-eyecare" : "") +
    (kind === "theme" ? " mini-theme" : "") +
    (on ? " on" : "");
  return (
    <div className={cls}>
      <div className="mini-topbar">
        <span className="mini-dot" />
        <span className="mini-dot" />
        <span className="mini-dot" />
      </div>
      <div className="mini-body">
        <div className="mini-line" style={{ width: "70%" }} />
        <div className="mini-line" style={{ width: "92%" }} />
        <div className="mini-line" style={{ width: "60%" }} />
      </div>
      {kind === "count" && <div className="mini-count">123 字</div>}
      {kind === "theme" && (
        <div className="mini-actions">
          <span className="mini-btn" />
          <span className="mini-chip" />
        </div>
      )}
    </div>
  );
}

/** 一级分类菜单图标（线性风格，颜色随文字） */
const ICONS: Record<string, React.ReactNode> = {
  user: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </svg>
  ),
  display: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  ),
  ai: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 5.4L19 10.5l-5.1 2.1L12 18l-1.9-5.4L5 10.5l5.1-2.1L12 3z" />
    </svg>
  ),
  page: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.6" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <path d="M3 15l5-4 3.5 2.8L16 9.5l5 5" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <circle cx="12" cy="7.6" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  ),
};

type ViewKey =
  | "root"
  | "user"
  | "display"
  | "ai"
  | "page"
  | "about";

const MENU: { key: ViewKey; name: string; desc: string }[] = [
  { key: "user", name: "用户", desc: "头像与用户名" },
  { key: "display", name: "显示", desc: "护眼模式、字数统计、笔记时间" },
  { key: "ai", name: "AI 助手", desc: "会员额度、自动润色、代码块识别" },
  { key: "page", name: "页面设置", desc: "主题配色、页面大小" },
  { key: "about", name: "关于", desc: "版本与反馈信息" },
];

/**
 * 设置弹窗：
 *   - 普通模式：主卡片为一级分类菜单；点击某项 → 二级卡片从右侧滑出、
 *     主卡片向左让位。二级卡片与主卡片同尺寸。
 *   - 仅账号模式（accountOnly，点击主界面左上角头像）：只显示「用户」卡片
 *   - Esc 关闭（二级卡片时先收回）；点击卡片外区域关闭；随窗口同步缩放
 */
export default function SettingsDialog({
  onClose,
  accountOnly = false,
}: {
  onClose: () => void;
  accountOnly?: boolean;
}) {
  const uiScale = useStore((s) => s.uiScale);
  const setUiScale = useStore((s) => s.setUiScale);
  const avatar = useStore((s) => s.avatar);
  const setAvatar = useStore((s) => s.setAvatar);
  const eyeCare = useStore((s) => s.eyeCareMode);
  const setEyeCare = useStore((s) => s.setEyeCareMode);
  const themeColor = useStore((s) => s.themeColor);
  const setThemeColor = useStore((s) => s.setThemeColor);
  const showWordCount = useStore((s) => s.showWordCount);
  const setShowWordCount = useStore((s) => s.setShowWordCount);
  const autoDetect = useStore((s) => s.autoDetectCodeBlock);
  const setAutoDetect = useStore((s) => s.setAutoDetectCodeBlock);
  const autoPolish = useStore((s) => s.autoPolish);
  const setAutoPolish = useStore((s) => s.setAutoPolish);
  const aiFontSize = useStore((s) => s.aiFontSize);
  const setAiFontSize = useStore((s) => s.setAiFontSize);
  const aiQuota = useStore((s) => s.aiQuota);
  const aiQuotaError = useStore((s) => s.aiQuotaError);
  const aiQuotaErrorCode = useStore((s) => s.aiQuotaErrorCode);
  const aiQuotaLoading = useStore((s) => s.aiQuotaLoading);
  const refreshAiQuota = useStore((s) => s.refreshAiQuota);
  const openMember = useStore((s) => s.openMember);
  const showNoteTime = useStore((s) => s.showNoteTime);
  const setShowNoteTime = useStore((s) => s.setShowNoteTime);
  const authToken = useStore((s) => s.authToken);
  const authUser = useStore((s) => s.authUser);
  const setAuth = useStore((s) => s.setAuth);
  const clearAuth = useStore((s) => s.clearAuth);

  const username = authUser?.username ?? "用户";

  const [view, setView] = React.useState<ViewKey>(accountOnly ? "user" : "root");
  const [subView, setSubView] = React.useState<ViewKey>("user");

  const openSub = React.useCallback((key: ViewKey) => {
    setSubView(key);
    setView(key);
  }, []);

  // 关闭动画：先播放淡出，再真正卸载
  const [closing, setClosing] = React.useState(false);
  const closingRef = React.useRef(false);
  const requestClose = React.useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(onClose, 300);
  }, [onClose]);

  // 随软件窗口大小同步缩放
  const [panelZoom, setPanelZoom] = React.useState(1);
  React.useEffect(() => {
    const appZoom = [1, 1.15, 1.3][uiScale] ?? 1;
    const compute = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const s = Math.min(
        (w - 48) / (PANEL_W * appZoom),
        (h - 48) / (520 * appZoom),
      );
      setPanelZoom(Math.max(0.5, Math.min(1, s)));
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, [uiScale]);

  // 打开设置时刷新一次 AI 额度 / 会员状态
  React.useEffect(() => {
    void refreshAiQuota();
  }, [refreshAiQuota]);

  // Esc：二级卡片先收回，主菜单再关闭
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!accountOnly && view !== "root") setView("root");
      else requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, view, accountOnly]);

  const handleLogout = () => {
    clearAuth();
    requestClose();
  };

  /** AI 接口返回"登录状态已失效"时：清掉本地登录态 → 回到登录页重新登录 */
  const handleRelogin = () => {
    clearAuth();
    requestClose();
  };

  // ---- 用户信息 ----
  // 4.0.3 起只有云端 Casdoor 账号（本机离线账号与内置管理员已移除）
  const isCloud = !!authToken;
  const [accName, setAccName] = React.useState(username);
  const [accMsg, setAccMsg] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setAccName(username);
  }, [username]);

  const handleAvatarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAccMsg("");
    if (file.size > MAX_AVATAR_BYTES) {
      setAccMsg("图片过大，请选择小于 2MB 的图片");
      return;
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(file, 256);
      setAvatar(dataUrl);
    } catch {
      setAccMsg("图片处理失败，请换一张试试");
      return;
    }
    // 云端账号：同步头像到 Casdoor
    if (isCloud && authToken) {
      const token = authToken;
      try {
        const url = await uploadAvatar(token, file);
        await updateProfile(token, { avatar: url });
        setAccMsg("头像已同步到云端");
      } catch (err) {
        setAccMsg(
          "已保存到本地；云端同步失败：" +
            (err instanceof Error ? err.message : ""),
        );
      }
    }
  };

  const handleSaveAccount = async () => {
    setAccMsg("");
    const token = authToken;
    if (!token) {
      setAccMsg("未登录，请重新登录");
      return;
    }
    const newName = accName.trim();
    if (!newName) {
      setAccMsg("用户名不能为空");
      return;
    }
    // 云端账号（Casdoor）：同步显示名
    setSaving(true);
    try {
      await updateProfile(token, { displayName: newName });
      setAuth(authToken, {
        ...(authUser ?? {}),
        id: authUser?.id ?? newName,
        username: newName,
      });
      try {
        localStorage.setItem("microprompt.savedUsername", newName);
      } catch {
        /* ignore */
      }
      setAccMsg("已保存并同步到云端");
    } catch (err) {
      setAccMsg(
        "云端同步失败：" + (err instanceof Error ? err.message : ""),
      );
    } finally {
      setSaving(false);
    }
  };

  const copySupportEmail = async () => {
    try {
      await navigator.clipboard.writeText(SUPPORT_EMAIL);
      setAccMsg("客服邮箱已复制：" + SUPPORT_EMAIL);
    } catch {
      setAccMsg("客服邮箱：" + SUPPORT_EMAIL);
    }
  };

  // 用户信息内容（账号卡片 / 「用户」设置页共用）
  const accountFields = (
    <>
      <div className="acc-avatar-row">
        <label className="acc-avatar" title="点击更换头像（正方形，≤2MB）">
          <img src={avatar ?? defaultAvatar} alt="头像" />
          <input type="file" accept="image/*" onChange={handleAvatarFile} />
        </label>
        {avatar && (
          <button
            className="btn acc-avatar-reset"
            onClick={() => setAvatar(null)}
          >
            恢复默认头像
          </button>
        )}
      </div>

      <div className="set-section">
        <div className="set-label">用户名</div>
        <input
          className="dialog-input"
          value={accName}
          placeholder="用户名"
          onChange={(e) => setAccName(e.target.value)}
        />
      </div>

      <div className="set-section">
        <div className="set-label">修改密码</div>
        <div className="set-contact">
          <span className="set-contact-text">如需修改密码，请联系客服</span>
          <button className="btn" onClick={copySupportEmail}>
            复制邮箱
          </button>
        </div>
      </div>

      {accMsg && <div className="set-hint acc-msg">{accMsg}</div>}

      <div className="dialog-actions settings-actions">
        <button className="btn btn-logout" onClick={handleLogout}>
          退出登录
        </button>
        <button
          className="btn btn-primary"
          disabled={saving}
          onClick={handleSaveAccount}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </>
  );

  // ---- 二级设置页内容 ----
  const viewDisplay = (
    <>
      <div className="set-section">
        <div className="set-row">
          <span className="label-text">
            护眼模式
            <InfoTip text="关闭为纯白背景，打开为纸张黄护眼背景，整个软件统一生效" />
          </span>
          <label className="toggle">
            <input
              type="checkbox"
              className="toggle-state"
              checked={eyeCare}
              onChange={(e) => setEyeCare(e.target.checked)}
            />
            <span className="indicator" />
          </label>
        </div>
        <MiniUI kind="eyecare" on={eyeCare} />
      </div>

      <div className="set-section">
        <div className="set-row">
          <span className="label-text">显示字数统计</span>
          <label className="toggle">
            <input
              type="checkbox"
              className="toggle-state"
              checked={showWordCount}
              onChange={(e) => setShowWordCount(e.target.checked)}
            />
            <span className="indicator" />
          </label>
        </div>
        <MiniUI kind="count" on={showWordCount} />
      </div>

      <div className="set-section">
        <div className="set-row">
          <span className="label-text">显示笔记时间</span>
          <label className="toggle">
            <input
              type="checkbox"
              className="toggle-state"
              checked={showNoteTime}
              onChange={(e) => setShowNoteTime(e.target.checked)}
            />
            <span className="indicator" />
          </label>
        </div>
        <MiniUI kind="time" on={showNoteTime} />
      </div>
    </>
  );

  const viewAi = (
    <div className="set-section">
      {/* ===== AI 会员 / 额度（4.0.2）===== */}
      <div className="set-label">AI 会员</div>
      <div className="ai-member-card">
        <div className={"ai-member-line" + (aiQuotaErrorCode && !aiQuota ? " warn" : "")}>
          {aiQuota
            ? aiQuota.member
              ? `会员 · 有效期至 ${formatMemberUntil(aiQuota.memberUntil)}`
              : `免费版 · 今日剩余 ${aiQuota.remainingToday}/${aiQuota.freeQuota} 次`
            : aiQuotaError || (aiQuotaLoading ? "正在获取额度…" : "尚未获取额度")}
        </div>
        {aiQuota?.member && (
          <div className="ai-member-sub">
            剩余 {memberDaysLeft(aiQuota.memberUntil)} 天 · 今日已用{" "}
            {aiQuota.memberUsedToday}/{aiQuota.memberCap} 次 · 正常使用不限量
          </div>
        )}
        <div className="ai-member-actions">
          <button className="btn" onClick={() => void refreshAiQuota()}>
            {aiQuotaLoading ? "刷新中…" : "刷新"}
          </button>
          {/* 登录失效 → 直接给一个重新登录入口；离线账号 / 服务端旧版 → 下单也没用，禁掉 */}
          {aiQuotaErrorCode === "auth" ? (
            <button className="btn btn-primary" onClick={handleRelogin}>
              重新登录
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={openMember}
              disabled={!aiQuota}
              title={aiQuota ? "" : "额度信息不可用时无法下单"}
            >
              {aiQuota?.member ? "续费 / 升级" : "开通会员"}
            </button>
          )}
        </div>
        {!aiQuota?.member && aiQuota && (
          <div className="set-hint">
            免费版每天 {aiQuota?.freeQuota ?? 3} 次；日卡 ¥2（24 小时）、月卡 ¥8（30 天）
          </div>
        )}
        {/* 有缓存额度但这次没取到 → 明确告诉用户上面是旧数据，别当成实时额度 */}
        {aiQuota && aiQuotaError && (
          <div className="set-hint ai-member-stale">
            暂时连不上 AI 服务，上面显示的是上次获取到的额度
          </div>
        )}
      </div>

      <div className="set-row">
        <span className="label-text">
          自动润色
          <InfoTip text="开启后选中文本会出现「AI 润色」小按钮；无论开关如何，右键菜单中始终有「AI 润色」" />
        </span>
        <label className="toggle">
          <input
            type="checkbox"
            className="toggle-state"
            checked={autoPolish}
            onChange={(e) => setAutoPolish(e.target.checked)}
          />
          <span className="indicator" />
        </label>
      </div>
      <div className="set-row">
        <span className="label-text">润色框文字大小</span>
        <div
          className="seg-toggle"
          data-scale={aiFontSize === 8 ? 0 : aiFontSize === 10 ? 1 : 2}
        >
          <span className="seg-thumb" />
          {[8, 10, 12].map((pt) => (
            <button
              key={pt}
              className={"seg-item" + (aiFontSize === pt ? " on" : "")}
              onClick={() => setAiFontSize(pt)}
            >
              {pt}
            </button>
          ))}
        </div>
      </div>
      <div className="set-row">
        <span className="label-text">
          代码块自动识别
          <InfoTip text="打开后粘贴代码会询问是否添加为代码块；关闭后只能手动添加" />
        </span>
        <label className="toggle">
          <input
            type="checkbox"
            className="toggle-state"
            checked={autoDetect}
            onChange={(e) => setAutoDetect(e.target.checked)}
          />
          <span className="indicator" />
        </label>
      </div>
    </div>
  );

  const viewPage = (
    <>
      <div className="set-section">
        <div className="set-label">主题色</div>
        <div className="theme-row">
          {THEMES.map((t) => (
            <button
              key={t.key}
              className={"theme-dot" + (themeColor === t.key ? " on" : "")}
              style={{ background: `rgb(${t.rgb})` }}
              title={t.name}
              onClick={() => setThemeColor(t.key)}
            >
              <svg viewBox="0 0 24 24" className="theme-check">
                <path
                  d="M5 13l4 4L19 7"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ))}
        </div>
      </div>

      <div className="set-section">
        <div className="set-row">
          <span className="label-text">页面大小</span>
          <div className="seg-toggle" data-scale={uiScale}>
            <span className="seg-thumb" />
            {UI_MARKS.map((m, i) => (
              <button
                key={m}
                className={"seg-item" + (uiScale === i ? " on" : "")}
                onClick={() => setUiScale(i)}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="set-section">
        <div className="set-label">效果预览</div>
        <div className="page-preview">
          <div
            className="page-preview-inner"
            style={
              { "--pv-scale": [0.82, 1, 1.16][uiScale] } as React.CSSProperties
            }
          >
            <div className="pv-topbar">
              <span className="pv-dot" />
              <span className="pv-name">页面预览</span>
            </div>
            <div className="pv-body">
              <div className="pv-card">
                <span className="pv-card-title">笔记标题</span>
                <span className="pv-card-date">2026-09-30 12:00</span>
              </div>
              <div className="pv-line" style={{ width: "82%" }} />
              <div className="pv-line" style={{ width: "62%" }} />
            </div>
            <div className="pv-toolbar">
              <span className="pv-tool" />
              <span className="pv-tool" />
              <span className="pv-tool" />
            </div>
          </div>
        </div>
      </div>
    </>
  );

  const viewAbout = (
    <div className="set-section set-about">
      <div className="set-hint">轻提词 测试 4.0.2 · 本地桌面速记 · AI 额度与会员制</div>
      <div className="set-hint">
        AI 免费版每天 {aiQuota?.freeQuota ?? 3} 次 · 日卡 ¥2（24 小时）/ 月卡 ¥8（30 天）
      </div>
      <div className="set-hint">反馈邮箱：{SUPPORT_EMAIL}</div>
    </div>
  );

  const SUB_CONTENT: Record<string, React.ReactNode> = {
    user: accountFields,
    display: viewDisplay,
    ai: viewAi,
    page: viewPage,
    about: viewAbout,
  };

  const subTitle = MENU.find((m) => m.key === subView)?.name ?? "设置";

  const accountPanel = (
    <div className="dialog-panel account-panel">
      <div className="dialog-title">用户</div>
      {accountFields}
    </div>
  );

  const subOpen = !accountOnly && view !== "root";

  return (
    <div
      className={
        "dialog-overlay settings-overlay" + (closing ? " closing" : "")
      }
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      {accountOnly ? (
        <div
          className="settings-stack account-only"
          style={{ zoom: panelZoom }}
        >
          {accountPanel}
        </div>
      ) : (
        <div
          className={"settings-stack" + (subOpen ? " sub-open" : "")}
          style={{ zoom: panelZoom }}
        >
          {/* 主卡片：一级分类菜单 */}
          <div className="dialog-panel settings-panel">
            <div className="settings-head">
              <div className="dialog-title">设置</div>
              <div className="head-user">
                <span className="head-username" title={username}>
                  {username}
                </span>
                <button
                  className="head-avatar-btn"
                  title="用户设置"
                  onClick={() => openSub("user")}
                >
                  <img src={avatar ?? defaultAvatar} alt="头像" />
                </button>
              </div>
            </div>

            <div className="set-menu">
              {MENU.map((item) => (
                <button
                  key={item.key}
                  className="set-menu-item"
                  onClick={() => openSub(item.key)}
                >
                  <span className="set-menu-ico">{ICONS[item.key]}</span>
                  <span className="set-menu-body">
                    <span className="set-menu-name">
                      {item.name}
                      {item.key === "ai" && !aiQuota?.member && (
                        <span className="set-menu-badge">会员</span>
                      )}
                    </span>
                    <span className="set-menu-desc">{item.desc}</span>
                  </span>
                  <svg
                    className="set-menu-chev"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          {/* 二级卡片：从主卡片右侧滑出 */}
          <div className="settings-sub-layer">
            <div className="dialog-panel settings-panel sub-panel">
              <div className="settings-head">
                <div className="set-sub-head">
                  <button
                    className="set-back"
                    title="返回"
                    onClick={() => setView("root")}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="16"
                      height="16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M15 6l-6 6 6 6" />
                    </svg>
                  </button>
                  <div className="dialog-title">{subTitle}</div>
                </div>
              </div>
              <div className="set-sub-body" key={subView}>
                {SUB_CONTENT[subView]}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
