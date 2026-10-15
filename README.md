# 轻提词 (MicroPrompt) V4.0

Tauri 2 + React 19 + TypeScript + Vite 桌面速记应用（Web 技术栈迁移版）。

## 🚀 10 分钟极速复现指南（评审快速上手）

> 目标：从零到「窗口打开、能写笔记、能注册登录」**不超过 10 分钟**。
> 下列命令均在 **Windows 10/11 x64 + PowerShell** 实测通过（客户端 v4.1.1 / 服务端 v4.1.3，2026-10-15）。

### 0. 前置环境（约 3 分钟）

| 依赖 | 要求 | 验证命令 | 说明 |
|---|---|---|---|
| Windows | 10 / 11 x64 | — | Win11 自带 WebView2；Win10 缺失时装 [WebView2 Evergreen](https://developer.microsoft.com/microsoft-edge/webview2/) |
| Node.js | ≥ 20（实测 24.15.0） | `node -v` | 前端构建 + Tauri CLI |
| Rust | stable（实测 1.98.1） | `rustc -V` | `rustup default stable-x86_64-pc-windows-gnu`（MSVC 亦可） |
| Python | ≥ 3.8（实测 3.15） | `python -V` | **仅服务端需要**；纯标准库，无需 `pip install` 任何包 |

国内网络建议先配 crates 镜像（`%USERPROFILE%\.cargo\config.toml`）：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"
[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"
[net]
git-fetch-with-cli = true
```

### 1. 取代码 + 装依赖（约 2 分钟）

```powershell
git clone https://github.com/Syzlo-s/-MicroPrompt-.git MicroPrompt
cd MicroPrompt
npm install
```

### 2. 配置环境变量（约 1 分钟）

```powershell
Copy-Item .env.example .env      # 然后按需填写，只想看界面可全部留默认值
```

| 变量 | 必填 | 默认值 | 作用 |
|---|---|---|---|
| `VITE_CASDOOR_URL` | 否 | `http://127.0.0.1:2580` | 账号服务地址（4.1.0 起由自建账号服务接管，名字带 CASDOOR 只是历史原因） |
| `VITE_AI_URL` | 否 | `http://127.0.0.1:2581` | AI 中转服务地址 |
| `VITE_CASDOOR_CLIENT_ID` / `_SECRET` | 否 | 空 | 4.1.0 起只做「是否存在」的兼容检查，不再校验真实值 |

服务端变量模板见 `server_ai/.env.example`（`MP_DEEPSEEK_KEY` 必填，缺了服务拒绝启动；
没有 Key 时用 `MP_MOCK=1` 走假数据）。**`.env` 已被 gitignore，不要提交。**

### 3. 跑起来（约 2 分钟）

```powershell
npm run tauri dev          # 编译 Rust + 起 Vite + 打开窗口（首次编译约 1~2 分钟）
```

只想看前端界面（不编译 Rust）：`npm run dev` → 浏览器打开 `http://localhost:1420`。

### 4. 启动后端（可选：AI 润色 / 账号登录需要）

```powershell
cd server_ai
$env:MP_MOCK='1'           # 没有 DeepSeek Key 时用 mock，AI 返回假数据
python ai_server.py        # 主服务 2581；账号接口额外监听 2580
```

启动后浏览器打开 **<http://127.0.0.1:2581/admin>**，粘贴管理员密钥
（`python server_ai/admin_cli.py key` 打印；本地默认会自动生成到 `server_ai/data/admin_key.txt`），
就能看到 4.1.2 重构成电脑端控制台的运营后台：概览 KPI 与趋势图、用户与额度、订单（含
4.1.3 的「打回（没收到款）」）、收款码、操作日志与安全、设置；数据变了页面 2 秒内自己刷新
（不用点刷新按钮）。

### 5. 30 秒自检（怎么算复现成功）

- [ ] 窗口打开，顶栏显示「轻提词」，左侧笔记列表可新建/切换
- [ ] 在编辑器输入文字后，`%APPDATA%\DesktopNotesDev\DesktopNotes\notes.json` 里能看到内容
- [ ] `curl http://127.0.0.1:2581/ai/health` 返回 `{"ok": true, "service": "microprompt-ai", "version": "4.1.3", ...}`
- [ ] `python server_ai/selfcheck.py` 全项 `[OK]`
- [ ] 登录页注册一个账号 → 立刻登录成功（账号密码只存 PBKDF2 哈希）
- [ ] 后台 `/admin` 能打开：概览页 4 张 KPI 卡片 + 趋势图，右上角状态点是绿的（表示每 2 秒在同步）

### 6. 打包成 exe（可选）

```powershell
$env:CARGO_TARGET_DIR = 'D:\mp4target'     # 必须是纯英文路径，原因见下表
npm run tauri build                        # 产物：<target>\release\microprompt-v4.exe + NSIS 安装包
```

### 7. 常见坑（踩过并已解决）

| 现象 | 原因 | 处理 |
|---|---|---|
| `dlltool: Can't create .lib file: ... No such file or directory` | MinGW 工具链处理不了**含中文的路径** | 先设 `$env:CARGO_TARGET_DIR='D:\mp4target'` 再构建（仓库自带 `build.ps1` 已封装） |
| 窗口打开但报 `ERR_CONNECTION_REFUSED` | 用 `cargo build` 时漏了 `--features tauri/custom-protocol`，exe 去连 devUrl | 加该 feature，或直接用 `npm run tauri dev` |
| 提示缺少 `WebView2Loader.dll` | Tauri 运行时 DLL 没随 exe 一起拷 | 与 exe 放同一目录（`build.ps1` 会自动复制） |
| 登录报「无法连接服务器」 | 账号服务（2580）没起来 | 确认服务端 `MP_AUTH_MODE=builtin` 且 2580 在监听 |
| 打包出的包"能装能开但登录凭据为空" | `.env` 缺失或没填 | 构建前先跑 `npm run preflight`（会一次性核对凭据与 6 处客户端版本号） |

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
| `VITE_CASDOOR_URL` | 账号服务地址。**4.1.0 起由自建账号服务接管**，客户端仍按这个名字读地址，因此构建参数无需改动 | `http://127.0.0.1:2580` |
| `VITE_AI_URL` | AI 中转服务地址（`server_ai/ai_server.py`） | `http://127.0.0.1:2581` |
| `VITE_CASDOOR_CLIENT_ID`<br>`VITE_CASDOOR_CLIENT_SECRET` | 账号服务的 client 凭据。4.1.0 起只做「是否存在」的兼容检查（不再校验真实值） | 空 → 线上账号登录不可用 |

> 4.0.3 起已**彻底移除「本机离线账号」与内置管理员登录**：注册 / 登录一律走云端账号，
> 因此不再需要 `VITE_LOCAL_ADMIN_*`（旧 `.env` 里留着也不会被读取）。
> 4.1.0 起账号由 `server_ai/ai_server.py` 自己提供（见下文「账号系统（4.1.0）」），
> 名字里带 `CASDOOR` 只是历史原因，**不是**还依赖 Casdoor。

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
#    顺序必须是：先跑前置检查 → npm run build（产出 dist/）→ cargo build（把 dist 内嵌进 exe）
#    → ISCC 打包（setup.iss 从 D:\mp4target\release 取 exe）
npm run preflight     # 检查 .env 凭据 / 7 处版本号一致 / setup.iss 的 BOM / 线上服务端版本
npm run build
$env:CARGO_TARGET_DIR = 'D:\mp4target'
cargo build --release --features tauri/custom-protocol --manifest-path src-tauri\Cargo.toml
& 'C:\Users\Song\AppData\Local\Programs\Inno Setup 6\ISCC.exe' src-tauri\inno\setup.iss
# 产物：release\installer\轻提词安装包_v<版本>.exe

# 也可以一条命令做「前置检查 + 前端构建」：
npm run build:checked

# ⚠️ setup.iss 必须保存为「UTF-8 with BOM」，否则中文(应用名/输出文件名)会变乱码
# ⚠️ 改客户端版本号要同步这 6 处：package.json、src-tauri\tauri.conf.json、src-tauri\Cargo.toml、
#    src-tauri\inno\setup.iss（版本+输出文件名）、src\components\SettingsDialog.tsx（关于页）、
#    src\components\WelcomeScreen.tsx（欢迎页）
#    —— `npm run preflight` 会一次性核对这 6 处
# ℹ️ 服务端（server_ai\ai_server.py 的 VERSION）是**独立**版本号：服务端可以单独发版
#    （例如 4.1.2 只重构了后台与接口，桌面端仍是 4.1.1、用户不用重装）。
#    preflight 只要求它「不落后于客户端」，不要求相等。
#
# ℹ️ 4.1.1 实况（两条路线并存，别再搞混）：
#    实际发布的 `轻提词安装包_v4.1.1.exe` 是 `npm run tauri build`（NSIS，见 tauri.conf.json
#    的 bundle.targets=["nsis"]）产出的 `轻提词_4.1.1_x64-setup.exe` 改名而来，约 1.7 MB；
#    上面这条 Inno 路线（setup.iss）同样可用、版本串已同步到 4.1.1，产物约 3.5 MB。
#    两条任选其一即可，但**改版本号时两条的版本串都要同步** —— preflight 会核对 setup.iss。
#    历史教训：4.1.0 / 4.1.1 两次发版都漏改了 setup.iss，它一度停在 4.0.3（2026-10-14 已修正）。
```

> **构建前务必跑 `npm run preflight`**：4.0.2 起登录凭据与 AI 地址都从 `.env` 注入
> （`.env` 被 gitignore，只在本机），缺了会打出"能装、能开、但登录凭据为空"的包；
> 它同时会告诉你线上 AI 服务端是不是还没升级到新版。

> 链接时若出现 `multiple non-default manifests` 警告，是 Tauri 2 + GNU 工具链的已知现象
> （WebView2 清单与应用清单合并），Win10/11 已内置 WebView2 运行时，无影响。
> 若要彻底规避中文路径问题，可安装 MSVC 工具链（VS Build Tools）后执行
> `rustup default stable-x86_64-pc-windows-msvc`。

## AI 额度与会员（4.1.0）

- AI 是付费功能：**未付费每天 3 次**，会员 **日卡 2 元 / 月卡 8 元**（正常使用不限量，
  另有 300 次/天防滥用上限）
- **额度判定全部在服务端** `server_ai/ai_server.py`（端口 2581），客户端只做展示与引导；
  接口需要登录 token（4.1.0 起由本服务自签，不再依赖第三方账号系统）
- **4.1.0：账号系统自建**——注册 / 登录 / 改资料 / 头像全部由 `ai_server.py` 自己提供，
  同时额外监听 **2580**（原先 Casdoor 占用的端口，客户端里写死的地址），
  因此**客户端一行都不用改**。密码只存 PBKDF2-HMAC-SHA256 单向哈希；
  登录失败话术统一（不区分「用户不存在」与「密码错」），并有同名/IP 双维度防爆破；
  后台可对账号**重置密码 / 停用 / 启用 / 踢下线 / 备注**（永远看不到密码原文）
- **4.0.3 起只有云端账号**——不再有「本机离线账号」兜底
  （旧版本留下的 `local:*` 登录态启动时会被清除并要求重新登录）
- **管理后台：`http://<服务器>:2581/admin`** —— 「用户与 AI 额度」面板：
  看谁登录过软件、注册/最近登录时间、各账号今日与累计 AI 用量、账号状态与备注；
  可按账号「重置今日」「清零累计」「开通免费不限量」（不受每天 3 次限制，仍保留 2 秒间隔）
  以及 4.1.0 新增的账号管理按钮
- 对应管理接口：`/ai/admin/users`、`/ai/admin/reset`、`/ai/admin/free`、
  `/ai/admin/account/{list,create,resetpwd,status,kick,note}`（见 `server_ai/README_部署.md`）
- 客户端入口：设置 → AI 助手（会员状态 / 今日剩余 / 开通续费）；
  额度用尽时 AI 方框会写明原因并自动弹出开通窗口
- 支付目前是**半自动**：客户端下单 → 展示收款码 → 用户点「我已完成支付」→
  管理员在 `/admin` 点「确认收款并开通」（或命令行 `python3 admin_cli.py confirm <订单号>`）
- 服务端部署 / 自检 / 排障见 `server_ai/README_部署.md`；
  部署后先跑 `python3 selfcheck.py` 确认新版生效（它会检查版本是否 4.1.0、账号模式、用户额度与账号接口是否可用）
- **界面冒烟自测（可选，开发机上用）**：`node scripts/ui-smoke.mjs`（29 项，全过退出码 0）
  走 WebView2 的 CDP 验证单测覆盖不到的四件事——
  ① 注入旧 `local:*` 登录态后是否被清除并要求重新登录；
  ② AI 额度卡片在「免费不限量」与「免费版」下的文案（会拦截 `/ai/quota` 伪造响应，不依赖服务端真开通）；
  ③ **账号服务器不可达时**登录/注册是否明确报错、且**绝不退回离线账号**（拦截账号请求让它连不上，
  报错为「无法连接服务器，请检查网络或服务器地址（未创建任何账号）」，全程不产生任何 token）；
  ④ 额度接口取不到时卡片显示「AI 服务超时或无法连接，请稍后重试」且「开通会员」按钮置灰。
  需要先带调试端口启动开发版：
  `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"` 然后 `.\开发版\轻提词.exe`。
  脚本会临时改写登录态并在结束时还原；全过退出码 0。

## 账号系统（4.1.0）

自建、零依赖、只用 Python 标准库，全部在 `server_ai/ai_server.py` 里（不再需要 Casdoor）：

- **端口**：主服务仍 **2581**；账号接口额外监听 **2580**
  （客户端里 `VITE_CASDOOR_URL` 写死的地址，改端口号即可平滑接管，客户端零改动）
- **客户端只用到 5 个账号接口**，服务端逐一兼容：
  `/api/signup`、`/api/login/oauth/access_token`、`/api/get-account`、
  `/api/update-user`、`/api/upload-resource` + `/avatar/<文件名>` 头像访问；
  另外未知的 `/api/*` 与 `/avatar/*` 一律回 404 JSON，CORS / OPTIONS 预检全开
- **令牌**：HS256 自签 JWT，有效期 7 天；客户端只从 payload 里取 `id` / `name`
  （所以格式与 Casdoor 兼容，长度从 3 KB 降到约 300 B）
- **密码**：PBKDF2-HMAC-SHA256 单向哈希（服务端 12 万次迭代，实测登录约 90 ms），
  永远不会被后台看到或导出；注册要求密码 ≥8 位
- **用户名**（4.1.1 起）：1-32 位，可用**中英文、数字、下划线、连字符**，首尾不能是 `_` 或 `-`；
  规则同时写在客户端注册页上，不符合时服务端返回整句说明（`用户名不符合要求：…`）
- **安全**：登录失败话术统一（分不出用户是否存在）、同名与同 IP 双维度防爆破、
  停用/改密/踢下线立即让旧令牌失效（`tokenVer`）、账号枚举与头像伪造上传都被拦住
- **后台接管**：`/admin` 里可新建账号、重置密码（生成一次性临时密码）、
  停用/启用、踢下线、写备注；对应接口
  `/ai/admin/account/{list,create,resetpwd,status,kick,note}`
- **回退开关**：`MP_AUTH_MODE=casdoor|builtin`（默认 `casdoor` 行为完全不变）。
  需要退回 Casdoor 时，删掉 `run.env` 里的 `MP_AUTH_MODE`、重启 Casdoor 与
  `./start.sh` 即可；代价是所有客户端需要重新登录一次
- 详细契约、数据文件与上线步骤见 `server_ai/README_部署.md` 与
  `_deploy/方案_4.1.1_自建账号系统与后台接管.md`

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
- [x] **Phase 2（P1）动效**：设置面板 / 笔记抽屉 / 欢迎页 / 会员弹窗渐显渐隐、顶栏笔记名淡出→换字→淡入、
  最小化淡出 120ms、颜色弹层 pop-in、AI 方框描边流动 + 逐行变清晰、滚动条空闲淡出
  —— **只剩「启动 / 退出动画」未做**（见下方已知限制）
- [x] **Phase 3（P1）代码引用块**：占位图标弹层展开、refblocks 增删与孤儿清理（保存前只留被引用的）、
  17 种语言识别 + 短标题提取（`src/utils/codeBlockAnalyzer.ts`）、粘贴围栏还原 / 长代码询问、可折叠与手动改名
- [x] **Phase 4（P2）AI 提示词优化助手**：已上线并纳入计费 —— 悬浮按钮 / 右键双入口、
  结果放只读方框不覆盖原文、自动标题、逐段生成 + 逐行变清晰、上游失败自动退额度
  —— 但**走自建中转的 DeepSeek 单厂商**，`AiProvider` 多厂商抽象未做
- [x] **Phase 5 的前半：发布工程化**：`preflight`（凭据 + 6 处客户端版本号 + 服务端独立版本 + BOM + 线上版本）、
  `build.ps1`、Inno / NSIS 双路线、`SHA256SUMS.txt`、便携包与安装包
- [x] **Phase 6（服务端 4.1.2）运营后台重构**：`/admin` 从「单页表格」改成**电脑端控制台**
  （左侧导航 + 概览看板 + 用户/订单/收款码/日志安全/设置六个页签、暗色模式、详情抽屉、批量操作、
  CSV 导出）；新增 2 秒实时刷新（`rev` 修订号 + `/ai/admin/poll`，数据没变不重画）、
  每日统计 `stats.json`（近 14 天趋势与月收入）、操作审计 `admin_log.json`、
  登录锁定与密钥错误安全视图、收款码在线上传；界面源文件 `admin_ui.html` 用
  `sync_admin_page.py` 注入，仍是单文件部署
- [x] **Phase 6 补充（服务端 4.1.3）订单打回**：用户说付了但你没收到钱时，订单页一键
  **「打回（没收到款）」** → 订单作废（`cancelReason`/`canceledBy`/`canceledAt` 落盘）、
  不开会员、不计收入、写进操作审计；已开通的订单拒绝打回（400 `not_rejectable`）；
  客户端弹窗对作废订单显示明确提示并可重新下单
- [ ] Phase 5（P3）**剩余部分**：CI 自动构建、增量更新、代码签名 —— **均未做**，目前发版全靠手工

## 已知限制（客户端 v4.1.1 / 服务端 v4.1.3 · 2026-10-15 核对）

**界面 / 交互**

- **启动与退出动画未实现** —— 这是 Phase 2 唯一的遗留项，其余动效都已完成
- 窗口边缘缩放依赖 Tauri 原生无边框窗口行为（`resizable: true` + `decorations: false`）
- 列表 / 编辑器滚动条空闲淡出是两级透明度切换，不是 200ms 平滑过渡
- 后台实时刷新是 **2 秒轮询**（不是 SSE / WebSocket）：延迟最多 2 秒，
  换来的是零额外依赖、断线自愈（下一次轮询就恢复）；页签切到后台时暂停轮询省流量

**功能缺口**

- **没有应用内「修改密码」入口**：设置 → 用户 里那一行目前只写着「如需修改密码，请联系客服」
  （`src/components/SettingsDialog.tsx:355`）；真正的改密只能由管理员在 `/admin` 点
  「重置密码」拿到一次性临时密码
- **支付是半自动**：用户点「我已完成支付」后，仍需管理员在 `/admin` 点「确认收款并开通」
  （或 `python3 admin_cli.py confirm <订单号>`）；支付通道回调接口已预留但未接；
  没收到钱时可以点 **「打回（没收到款）」** 作废该笔订单（4.1.3）
- **「订单被打回」的客户端提示还没发给用户**：已安装的 4.1.1 客户端遇到作废订单会停在
  「等待确认开通」页（不会再误扣费，重开「开通会员」弹窗即可重新下单）；明确提示与
  「重新选套餐」按钮已写进源码（`src/components/MemberDialog.tsx`），**下次客户端发版才生效**
- 旧版数据自动迁移（`%APPDATA%/DesktopNotesDev` → 新路径）尚未实现：本版直接读写旧路径，天然兼容

**发布 / 工程**

- **没有 CI、没有增量更新、没有代码签名**：发版全靠手工
  （`npm run preflight` → `npm run build` → `cargo build` → ISCC 或 `npm run tauri build`），
  用户升级靠替换 exe 或重新安装（Phase 5 剩余部分）
- 安装包有 **Inno 与 NSIS 两条路线**并存（见「构建发布」末尾说明），改版本号时两条都要同步
- 服务端是**单机单进程**部署（2580/2581 同一个 `ai_server.py`），无多实例 / 负载均衡；
  `MP_AUTH_MODE=casdoor` 的回退开关仍保留

**安全（已知短板，别当成没有）**

- **后台与账号接口目前是 http 明文**（`http://8.163.51.216:2581/admin`、`:2580`）：
  管理员密钥和用户密码都走明文，同网络的人可以抓包看到。真实修法是给服务器配域名 +
  Caddy 自动 HTTPS，或者只在需要时用 SSH 隧道把端口映射到本机：
  `ssh -L 2581:127.0.0.1:2581 admin@8.163.51.216`，然后访问 `http://127.0.0.1:2581/admin`
- 后台**和 AI 接口共用 2581 端口**，所以没法只对后台单独做 IP 白名单；
  要隔离就得把后台拆到另一个端口（尚未做）
- 管理员密钥错误只记在内存（最多 50 条，重启即清），刻意不落盘 —— 防止被人刷日志把磁盘写满
