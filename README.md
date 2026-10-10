# 轻提词 (MicroPrompt) V4.0

Tauri 2 + React 19 + TypeScript + Vite 桌面速记应用（Web 技术栈迁移版）。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2（Rust 后端，窗口管理 / 原子 JSON 持久化） |
| UI | React 19 + TypeScript + Vite 7 |
| 富文本 | TipTap 2（ProseMirror），支持字号/加粗/下划线/删除线/颜色/分割线/引用块占位 |
| 状态 | Zustand（前端持有全部业务状态，后端仅读写与窗口控制） |

## 环境要求

- Node.js ≥ 20，npm
- Rust（stable，`x86_64-pc-windows-gnu` 或 MSVC 均可；本机已通过 rustup 安装 GNU 工具链 + MinGW 链接器）
- Windows 10/11（WebView2 运行时，Win11 自带）

中国镜像建议（已写入 `%USERPROFILE%\.cargo\config.toml`）：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
[net]
git-fetch-with-cli = true
```

## 环境变量（必读）

源码内**不含任何真实密钥、账号或服务器地址**，这些值全部通过环境变量注入。
首次运行前先建好 `.env`：

```bash
cp .env.example .env     # 然后填入真实值
```

| 变量 | 说明 | 未配置时的默认值 |
|---|---|---|
| `VITE_CASDOOR_URL` | Casdoor 认证服务地址 | `http://127.0.0.1:2580` |
| `VITE_AI_URL` | AI 中转服务地址（`server_ai/ai_server.py`） | `http://127.0.0.1:2581` |
| `VITE_CASDOOR_CLIENT_ID`<br>`VITE_CASDOOR_CLIENT_SECRET` | Casdoor 应用凭据 | 空 → 线上账号登录不可用 |
| `VITE_LOCAL_ADMIN_USER`<br>`VITE_LOCAL_ADMIN_PASSWORD` | 离线内置管理员 | 空 → 该登录入口整体关闭 |

- `.env` 已写入 `.gitignore`，**不要提交，也不要打进分发包**。
- 服务端变量（`MP_DEEPSEEK_KEY` 等）见 `server_ai/.env.example`。Python 标准库
  不自动读取 `.env`，需按该文件顶部注释手动加载或直接在命令行传入。
- `MP_DEEPSEEK_KEY` 现在是**必填项**：缺失时 `ai_server.py` 会拒绝启动
  （本地联调可加 `MP_MOCK=1`）。

> ⚠️ **前端没有秘密**：Vite 会在构建时把 `VITE_*` 内联进产物，拿到安装包的人
> 仍可提取这些值。`.env` 解决的是"公开仓库不泄露凭据"，不等于"客户端安全"。
> 真正的密钥（DeepSeek Key、管理员密钥）必须只留在服务端。

## 开发运行

```bash
npm install
npm run tauri dev     # 启动 Vite 开发服务器 + 编译 Rust + 打开窗口
```

## 构建发布

> ⚠️ **重要（本机 GNU/MinGW 工具链 + 中文路径）**：MinGW 的 `dlltool` / `windres`
> 无法处理含中文的路径，因此必须把**编译输出目录**指向英文路径（`CARGO_TARGET_DIR`）。
> `build.rs` 已自动把 `icon.ico` 复制到英文的 `OUT_DIR` 以绕过 `windres` 的中文路径缺陷。

```powershell
# 1) 直接编译可运行 exe（最快验证方式）
#    --features tauri/custom-protocol：让 exe 内嵌 dist/（生产构建），
#    否则默认 dev 模式会去连 localhost:1420（报 ERR_CONNECTION_REFUSED）
$env:CARGO_TARGET_DIR = 'D:\mp4target'        # 换成任意英文路径
cargo build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
# 产物：D:\mp4target\release\microprompt-v4.exe
# 运行需随行 WebView2Loader.dll（Tauri 运行时非系统 DLL），已同步到 .\release\
#   .\release\轻提词.exe  +  .\release\WebView2Loader.dll

# 2) 一键脚本（等价于上面两步 + 复制 exe）
.\build.ps1

# 3) 打包安装器（NSIS + MSI，需联网下载打包工具；网络慢时可能失败，此时用 1/2 即可）
$env:CARGO_TARGET_DIR = 'D:\mp4target'
npm run tauri build

# 4) 实际在用的安装包：Inno Setup（src-tauri\inno\setup.iss）
#    顺序必须是：先 npm run build（产出 dist/），再 cargo build（把 dist 内嵌进 exe），
#    最后 ISCC 打包（setup.iss 从 D:\mp4target\release 取 exe）
npm run build
$env:CARGO_TARGET_DIR = 'D:\mp4target'
cargo build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
& 'C:\Users\Song\AppData\Local\Programs\Inno Setup 6\ISCC.exe' src-tauri\inno\setup.iss
# 产物：release\installer\轻提词安装包_v<版本>.exe

# ⚠️ setup.iss 必须保存为「UTF-8 with BOM」，否则中文(应用名/输出文件名)会变乱码
# ⚠️ 改版本号要同步这 5 处：package.json、src-tauri\tauri.conf.json、src-tauri\Cargo.toml、
#    src\components\SettingsDialog.tsx（关于页）、src-tauri\inno\setup.iss（版本+输出文件名）
```

> 链接时若出现 `multiple non-default manifests` 警告，是 Tauri 2 + GNU 工具链的已知现象
> （WebView2 清单与应用清单合并），Win10/11 已内置 WebView2 运行时，无影响。
> 若要彻底规避中文路径问题，可安装 MSVC 工具链（VS Build Tools）后执行
> `rustup default stable-x86_64-pc-windows-msvc`。

## AI 额度与会员（4.0.2）

- AI 是付费功能：**未付费每天 3 次**，会员 **日卡 2 元 / 月卡 8 元**（正常使用不限量，
  另有 300 次/天防滥用上限）
- **额度判定全部在服务端** `server_ai/ai_server.py`（端口 2581），客户端只做展示与引导；
  接口需要 Casdoor 登录 token，离线本地账号不可用 AI
- 客户端入口：设置 → AI 助手（会员状态 / 今日剩余 / 开通续费）；
  额度用尽时 AI 方框会写明原因并自动弹出开通窗口
- 支付目前是**半自动**：客户端下单 → 展示收款码 → 用户点「我已完成支付」→
  管理员在服务器执行 `python3 admin_cli.py confirm <订单号>` 开通
- 服务端部署 / 自检 / 排障见 `server_ai/README_部署.md`；
  部署后先跑 `python3 selfcheck.py` 确认新版生效

## 数据存储（与 C++ 版兼容）

- 开发版默认：`%APPDATA%\DesktopNotesDev\DesktopNotes\notes.json` + `refblocks.json`
- 环境变量切换：`MICROPROMPT_PROFILE=dev|test|stable`，或 `MICROPROMPT_DATA_DIR=<绝对路径>`
- 字段语义与 C++ 版 `NoteManager::Note` 完全一致（含 `color` 字段）
- 保存链路对齐 C++ 版：输入防抖 500ms / 兜底 2s / 切换笔记与新建/删除前强制 flush；
  原子写入 = 写 `.tmp` → 读回校验 → 备份 `.bak` → rename 替换（失败重试 2 次，仍失败回退直接覆盖写并保留 `.bak`）

## 阶段进度

- [x] **Phase 1（P0）核心替换**：无边框窗口框架（36px 顶栏、左右分栏 200:680 可拖 130~220）、
  笔记列表（38px 卡片、悬停放大 1.03、选中插卡 16px、右侧渐隐渐变）、TipTap 编辑器
  （10pt 默认、字号 8~32、加粗/下划线/删除线、5 色文字、9 种分割线样式）、
  工具栏（格式刷/字号/粗/下/删/分割线/颜色/白黄背景/回底部）、窗口控制（图钉置顶/最小化/最大化/关闭）、
  Rust 原子 JSON 持久化。纯本地，无 AI。
- [ ] Phase 2（P1）动效全量对齐：启动/退出动画、弹层滑入滑出、状态淡入淡出、滚动条空闲淡出细节、颜色弹层动效
- [ ] Phase 3（P1）代码引用块：占位图标弹层展开、refblocks 增删与孤儿清理、粘贴/输入智能识别
- [ ] Phase 4（P2）AI 提示词优化助手（AiProvider trait + 多厂商）
- [ ] Phase 5（P3）CI 构建 + 增量更新 + 签名

## 已知限制（Phase 1）

- 退出动画与启动动画尚未实现（Phase 2）
- 窗口边缘缩放依赖 Tauri 原生无边框窗口行为（`resizable: true` + `decorations: false`）
- 列表滚动条空闲淡出暂为两级透明度切换（Phase 2 做 200ms 平滑过渡）
- 旧版数据自动迁移（`%APPDATA%/DesktopNotesDev` → 新路径）尚未实现：本版直接读写旧路径，天然兼容
