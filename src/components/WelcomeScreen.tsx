import { createPortal } from "react-dom";
import { useStore } from "../store";
import appLogo from "../assets/icons/app-logo.png";

/**
 * 首次安装 / 首次启动欢迎页：
 *   - 仅在首次进入主界面时显示一次（localStorage 记录）
 *   - 四周圆角 + 上下常驻模糊（与主界面同款实时渲染）
 */
export default function WelcomeScreen() {
  const username = useStore((s) => s.authUser?.username ?? "用户");
  const finishWelcome = useStore((s) => s.finishWelcome);

  return createPortal(
    <div className="welcome-overlay">
      <div className="welcome-card-wrap">
        <div className="welcome-card">
          <img className="welcome-logo" src={appLogo} alt="轻提词" />
          <h1 className="welcome-hello">[ {username} ] 您好！</h1>

          <p className="welcome-text">
            感谢您参与测试！你的每一条反馈和建议，都会帮助我们把「轻提词」做得更好。如有问题，欢迎随时反馈。
          </p>
          <p className="welcome-text">
            反馈邮箱：Songyizhen5565@outlook.com
          </p>

          <div className="welcome-brand">
            <div>欢迎使用 [ 轻提词 ]（MicroPrompt）</div>
            <div>曾用名： [ 桌面速记 ]（DesktopNotes）</div>
            <div>当前版本：测试 4.0.2</div>
          </div>

          <h2 className="welcome-h2">如何使用：</h2>
          <ul className="welcome-list">
            <li>点击左上角「新建」按钮创建新笔记</li>
            <li>点击左侧笔记卡片可切换笔记，右键卡片可重命名或删除</li>
            <li>
              顶部工具栏支持字体大小、粗体、下划线、删除线、文字颜色，以及白/黄纸背景切换
            </li>
            <li>右上角图钉按钮可将窗口置顶到最上层</li>
            <li>所有内容都会自动保存，关闭窗口时无需手动保存</li>
            <li>
              笔记文件默认地址：C:\Users\&lt;用户名&gt;\AppData\Roaming\DesktopNotesDev\DesktopNotes\notes.json
            </li>
          </ul>

          <h2 className="welcome-h2">未来的发展计划：</h2>
          <div className="welcome-version">版本测试 V4.0：</div>
          <ul className="welcome-list">
            <li>
              AI 提示词优化助手 （Deepseek-V4.1-Flash）<b>[*付费功能]</b>
              <ol className="welcome-sub">
                <li>实时优化提示词；</li>
                <li>实时规范提示词格式；</li>
                <li>实现口语化描述改写总结用户要求提示词。</li>
              </ol>
              <div className="welcome-note">
                *付费功能主要用于AI，基础功能可以正常使用不受任何影响。
              </div>
              <div className="welcome-price">
                [ 免费版：每天 3 次 AI 润色 ]
              </div>
              <div className="welcome-price">
                [ 会员价：日卡 2 RMB（24 小时不限量）]
              </div>
              <div className="welcome-price">
                [ 会员价：月卡 8 RMB（30 天不限量）]
              </div>
              <div className="welcome-note">
                *会员在正常使用状态下额度不限制，若特殊原因超出额度将额外处理~
              </div>
              <div className="welcome-note">
                *开通入口：设置 → AI 助手 → 开通会员（软件内下单、扫码支付后自动确认开通）
              </div>
            </li>
            <li>Ai问题反馈助手（可以反馈软件问题、可以提交愿望功能）</li>
            <li>实现多端同步</li>
            <li>实现主动更新功能</li>
          </ul>

          <button className="welcome-btn" onClick={finishWelcome}>
            开始使用
          </button>
        </div>
        <div className="welcome-blur welcome-blur-top" />
        <div className="welcome-blur welcome-blur-bottom" />
      </div>
    </div>,
    document.body,
  );
}
