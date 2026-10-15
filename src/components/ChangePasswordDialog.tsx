import React from "react";
import { changePassword } from "../services/auth";

/** 密码最短 / 最长（与服务端注册、改密规则一致） */
const PWD_MIN = 8;
const PWD_MAX = 128;

/** 眼睛图标：切换「显示密码」 */
function EyeIcon({ off = false }: { off?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.6" />
      {off && <path d="M4 20L20 4" />}
    </svg>
  );
}

/** 单个密码输入框：右侧带「显示/隐藏」按钮 */
function PwdField({
  label,
  value,
  onChange,
  placeholder,
  show,
  onToggleShow,
  autoFocus = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  show: boolean;
  onToggleShow: () => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="pwd-field">
      <div className="pwd-field-label">{label}</div>
      <div className="pwd-input-wrap">
        <input
          className="dialog-input pwd-input"
          type={show ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className={"pwd-eye" + (show ? " on" : "")}
          title={show ? "隐藏密码" : "显示密码"}
          aria-label={show ? "隐藏密码" : "显示密码"}
          onClick={onToggleShow}
        >
          <EyeIcon off={show} />
        </button>
      </div>
    </div>
  );
}

/**
 * 修改密码（二级界面，4.1.8）
 *
 * 为什么单独做成一层小窗而不是直接铺在「用户」页里：
 *   · 三个输入框 + 规则说明会把设置页撑得很长；
 *   · 改密码是「一次性、有风险」的操作，值得一层独立的确认空间；
 *   · 出错信息（原密码不对 / 两次不一致）贴着输入框显示，不污染其它设置。
 *
 * 校验分两道：这里先做本地校验（长度、两次一致、新旧不同），
 * 服务端还会再校验一遍原密码与新密码规则（前端校验只是省一次往返，不作为安全边界）。
 */
export default function ChangePasswordDialog({
  token,
  onClose,
  onChanged,
}: {
  token: string;
  onClose: () => void;
  /** 改密成功：把服务端补发的新令牌交回上层保存 */
  onChanged: (newToken: string) => void;
}) {
  const [oldPwd, setOldPwd] = React.useState("");
  const [newPwd, setNewPwd] = React.useState("");
  const [confirmPwd, setConfirmPwd] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [ok, setOk] = React.useState(false);

  const closingRef = React.useRef(false);
  const close = React.useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    onClose();
  }, [onClose]);

  // 本地校验：返回第一条不通过的原因（通过则返回空串）
  const localError = React.useMemo(() => {
    if (!oldPwd) return "请输入原密码";
    if (!newPwd) return "请输入新密码";
    if (newPwd.length < PWD_MIN) return `新密码至少 ${PWD_MIN} 位`;
    if (newPwd.length > PWD_MAX) return `新密码最长 ${PWD_MAX} 位`;
    if (newPwd === oldPwd) return "新密码不能与原密码相同";
    if (!confirmPwd) return "请再输入一次新密码";
    if (confirmPwd !== newPwd) return "两次输入的新密码不一致";
    return "";
  }, [oldPwd, newPwd, confirmPwd]);

  const submit = async () => {
    if (busy) return;
    if (localError) {
      setOk(false);
      setMsg(localError);
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const fresh = await changePassword(token, oldPwd, newPwd);
      setOk(true);
      setMsg("密码已修改：其它设备上的登录已失效，本机继续保持登录");
      onChanged(fresh);
      window.setTimeout(close, 1400);
    } catch (err) {
      setOk(false);
      setMsg(err instanceof Error ? err.message : "修改密码失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  // 提示区文案：优先显示服务端/提交时的结果，其次是「三个框都填了」之后的实时校验，
  // 最后是规则说明。按钮不因为校验未通过而禁用 —— 禁用了人不知道为什么点不动。
  const filledAll = !!oldPwd && !!newPwd && !!confirmPwd;
  const hintText = msg
    ? msg
    : filledAll && localError
      ? localError
      : `至少 ${PWD_MIN} 位；不能与原密码相同；改完其它设备的登录会失效`;
  const hintState = msg ? (ok ? " is-ok" : " is-err") : filledAll && localError ? " is-err" : "";

  // Esc 关闭；Enter 直接提交（输入框里也能用）
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, oldPwd, newPwd, confirmPwd, busy, localError]);

  return (
    <div
      className="dialog-overlay pwd-overlay"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-panel pwd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="pwd-head">
          <span className="pwd-head-ico" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="10.5" width="16" height="10" rx="3" />
              <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
              <circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div>
            <div className="dialog-title pwd-title">修改密码</div>
            <div className="pwd-sub">改完其它设备需要重新登录，本机不用</div>
          </div>
        </div>

        <PwdField
          label="原密码"
          value={oldPwd}
          onChange={setOldPwd}
          placeholder="当前正在使用的密码"
          show={show}
          onToggleShow={() => setShow((v) => !v)}
          autoFocus
        />
        <PwdField
          label="新密码"
          value={newPwd}
          onChange={setNewPwd}
          placeholder={`${PWD_MIN}~${PWD_MAX} 位，建议字母 + 数字`}
          show={show}
          onToggleShow={() => setShow((v) => !v)}
        />
        <PwdField
          label="确认新密码"
          value={confirmPwd}
          onChange={setConfirmPwd}
          placeholder="再输入一次新密码"
          show={show}
          onToggleShow={() => setShow((v) => !v)}
        />

        {/* 规则与报错：同一块位置，成功是绿的、失败是红的 */}
        <div className={"pwd-hint" + hintState}>{hintText}</div>

        <div className="dialog-actions pwd-actions">
          <button className="btn" onClick={close} disabled={busy}>
            取消
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? "提交中…" : "确认修改"}
          </button>
        </div>
      </div>
    </div>
  );
}
