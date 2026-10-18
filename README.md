# 轻提词 (MicroPrompt) V4.0

Tauri 2 + React 19 + TypeScript + Vite 桌面速记应用（Web 技术栈迁移版）。

## 🚀 10 分钟极速复现指南（评审快速上手）

> 目标：从零到「窗口打开、能写笔记、能注册登录」**不超过 10 分钟**。
> 下列命令均在 **Windows 10/11 x64 + PowerShell** 实测通过（客户端 v4.7.0 / 服务端 v4.7.0，2026-10-18）。

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
（不用点刷新按钮）。**4.1.4 起配色与软件本体一致**：单一靛蓝强调色 + 灰阶描边，没有渐变。
4.1.5~4.1.7 又修了概览页两处显示问题（趋势图被挤成 81px 的类名冲突、代理截断响应导致的偶发空白），
细节见 `server_ai/README_部署.md` 的「类名规则」「后台偶发空白怎么办」两节。
4.1.8 起服务端多了 `POST /api/change-password`（用户在设置里自己改密码，不用再找客服）。

### 5. 30 秒自检（怎么算复现成功）

- [ ] 窗口打开，顶栏显示「轻提词」，左侧笔记列表可新建/切换
- [ ] 在编辑器输入文字后，`<安装目录>\data\notes.json` 里能看到内容
      （安装版 = `D:\轻提词\data`；便携版 = exe 旁的 `data\`；位置可在 设置 → 存储 里改）
- [ ] `curl http://127.0.0.1:2581/ai/health` 返回 `{"ok": true, "service": "microprompt-ai", "version": "4.7.0", ...}`
- [ ] `curl http://127.0.0.1:2581/updates/latest.json` 能拿到在线升级清单（没放 `updates/` 时返回 404 也正常）
- [ ] `python server_ai/selfcheck.py` 全项 `[OK]`
- [ ] 登录页注册一个账号 → 立刻登录成功（账号密码只存 PBKDF2 哈希）
- [ ] 后台 `/admin` 能打开：概览页 4 张 KPI 卡片 + 趋势图，右上角状态点是绿的（表示每 2 秒在同步）

### 6. 打包成 exe（可选）

**发布用的路线是 Inno Setup**（第 3 步的 `setup.iss`，历史版本 v3.0.0~v4.1.8 都是它）：

```powershell
$env:CARGO_TARGET_DIR = 'D:\mp4target'                    # 必须是纯英文路径，原因见下表
cargo build --release --features tauri/custom-protocol     # 或用 .\build.ps1（同一件事）
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" src-tauri\inno\setup.iss
# 产物：release\installer\轻提词安装包_v<版本>.exe（约 3.3 MB）
```

**打完包必须真机验一次再发**（4.1.8 踩过坑：`npm run tauri build` 出来的 NSIS 包文件在、
版本号也对，但静默安装什么都不装、手动双击报「无法打开要写入的文件」）：

```powershell
node scripts/verify-installer.mjs     # 真机静默装一次 → 校验版本/界面 → 卸载
```

> 它会临时摘掉已有的「轻提词」卸载项、装到临时目录、跑完再还原（**桌面 / 开始菜单快捷方式也一起还原**
> —— 4.7.0 才发现：测试安装与正式安装共用同一个 AppId，卸载时会连用户桌面上那份一起删掉）。

另一条路线是 Tauri 自带的 NSIS（`bundle.targets=["nsis"]`）：

```powershell
npm run tauri build        # 产物：<target>\release\microprompt-v4.exe + NSIS 安装包
```

> ⚠️ 4.1.8 实测这条 NSIS 路线**不可靠**：同一个包先能装、后来说什么都不装（静默退出码仍是 0），
> 换 Inno 重打一次就正常了，根因没查到。所以发布走 Inno，NSIS 只当备选。

### 7. 常见坑（踩过并已解决）

| 现象 | 原因 | 处理 |
|---|---|---|
| `dlltool: Can't create .lib file: ... No such file or directory` | MinGW 工具链处理不了**含中文的路径** | 先设 `$env:CARGO_TARGET_DIR='D:\mp4target'` 再构建（仓库自带 `build.ps1` 已封装） |
| 窗口打开但报 `ERR_CONNECTION_REFUSED` | 用 `cargo build` 时漏了 `--features tauri/custom-protocol`，exe 去连 devUrl | 加该 feature，或直接用 `npm run tauri dev` |
| 提示缺少 `WebView2Loader.dll` | Tauri 运行时 DLL 没随 exe 一起拷 | 与 exe 放同一目录（`build.ps1` 会自动复制） |
| 登录报「无法连接服务器」 | 账号服务（2580）没起来 | 确认服务端 `MP_AUTH_MODE=builtin` 且 2580 在监听 |
| 打包出的包"能装能开但登录凭据为空" | `.env` 缺失或没填 | 构建前先跑 `npm run preflight`（会一次性核对凭据与 6 处客户端版本号） |
| 双击安装包弹「Windows 已保护你的电脑」 | 安装包**没有数字签名**（`Get-AuthenticodeSignature` = `NotSigned`）；用户那份是下载来的、带 Mark-of-the-Web，SmartScreen 对「来自 Internet + 未签名」的 exe 一律先拦 | 短期：用 `双击安装_轻提词.bat`（启动前会**清掉下载标记**再启动，详见 `_deploy\安装与分发_轻提词.md`），或点「更多信息」→「仍要运行」。长期：**优先上架微软商店（MSIX）—— 微软免费重签名，商店用户零弹窗**（个人开发者唯一免费且彻底的路）；官网直接下载渠道才需要 `scripts\sign.ps1` + OV 证书（$150~300/年，且注意 **EV 自 2024 年起也不再即时绕过**，与 OV 一样要积累信誉） |
| 安装报「安装程序无法创建目录 `…\Temp\is-XXXX.tmp`。错误 5: 拒绝访问」 | 那次安装是被**低完整性 / 受限上下文**（沙箱、AI 代理、受限启动器）拉起来的：`%TEMP%` 是 Medium 完整性标签，Windows 不允许低完整性进程往里写。**机器权限没坏** —— 普通（Medium）进程实测建目录/写文件全成功 | 在资源管理器里双击 `双击安装_轻提词.bat` 安装（它自带一个实测可写的私有临时目录，不再依赖 `%TEMP%`）；**不要**从 AI 代理 / 沙箱窗口里启动安装包 |
| 安装包能生成、大小也对，但装不上去 | 4.1.8 实测：NSIS 路线打出来的包**偶发不可用**（静默安装什么都不装、退出码仍是 0；手动双击报「无法打开要写入的文件」） | 换 Inno 路线重打（`ISCC.exe src-tauri\inno\setup.iss`），并用 `node scripts/verify-installer.mjs` 真机验一次再发 |
| `.\build.ps1` 报 `Join-Path ... NullNotAllowed` | `build.ps1` 曾是 UTF-8 无 BOM，Windows PowerShell 5.1 按 GBK 读 → 中文注释吃掉换行、脚本被解析坏 | 已修（加了 BOM）；若你改了该文件，记得存成 **UTF-8 with BOM** |

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

## 工作区里到底有几个「轻提词」

> 常见困惑：「开发版 / 稳定版 / 便携版 / 安装版」是不是不同版本？**不是。**
> 同一版构建出来的 exe 只有一个，各处只是**同一个文件的不同摆放**，区别只在于
> 「笔记存在哪个文件夹」和「有没有快捷方式 / 卸载项」。

| 形态 | 位置 | 怎么来的 | 笔记在哪 | 用途 |
|---|---|---|---|---|
| 安装版 | `D:\轻提词\` | 跑 `轻提词安装包_v<版本>.exe` | `D:\轻提词\data\`（卸载不删） | **普通用户日常用这个**（开始菜单 / 桌面快捷方式） |
| 便携版 | `便携版\` | 直接复制 `release\轻提词.exe` + `WebView2Loader.dll` | `便携版\data\` | 给别人试、放 U 盘、临时测试 |
| 构建产物 | `release\轻提词.exe` | `npm run build` + `cargo build` 后回填 | 跟着 exe 目录 | 中间产物，发版时同步到上面两处 |

- **不用安装也能直接双击 exe 运行**：Tauri 应用本身就是单文件 exe，前端页面编译在里面，
  运行期用 Windows 自带的 WebView2；安装包只多做三件事——复制文件、建快捷方式、写卸载注册表。
- ⚠️ **所有副本共用同一个 WebView2 用户数据目录**（`%LOCALAPPDATA%\com.microprompt.v4\EBWebView`）：
  登录状态和界面偏好是共享的，**不要同时开两个副本**（第二个会因共用目录报
  `ERROR_INVALID_STATE` 起不来）。笔记数据本身是分开的，只有浏览器层（登录态 / 偏好）共享。
- **2026-10-17 起取消「开发版 / 稳定版」两个目录**（它们其实是同一个 exe 的两份拷贝，
  反而让人分不清哪份才是自己的笔记）。要同时保留两套数据：同一个 exe 用
  **设置 → 存储 → 更改位置** 指到不同文件夹即可，不必复制 exe。
- ⚠️ **别在工作区里直接双击安装包**：DSH 会话给 `D:\Desktop\桌面速记` 打了 **Low 完整性标签**
  （`icacls` 里 `Mandatory Label\Low ...(OI)(CI)`），里面新建的文件（含安装包）都继承 Low；
  而 Windows 会把"从 Low 标签文件启动的进程"本身也约束成低完整性，它**写不了** `D:\轻提词`（Medium），
  装到一半就报「无法创建目录 D:\轻提词。错误 5」并回滚（退出码 4）。
  对策：把安装包**复制到桌面/下载目录**（那里是 Medium）再双击，或直接用
  `install_microprompt.ps1`（4.6.0 起它检测到 Low 标签会自动复制到 Medium 临时目录再启动）。
  详见 `_deploy\安装与分发_轻提词.md` 第六之三节。

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
#    （例如 4.1.2~4.1.7 只改后台与接口，桌面端停在 4.1.1、用户不用重装；
#    4.1.8 起服务端加了自助改密；4.5.0 起两边同号发布（客户端 6 处与服务端 VERSION 一起改）。
#    preflight 只要求它「不落后于客户端」，不要求相等。
#
# ℹ️ 4.6.0 实况（数据目录 + 文件管理台，发布仍走 Inno）：
#    ① 笔记默认落在 **安装目录\data**（安装版 = D:\轻提词\data），设置 → 存储 里可自选位置、
#       一键打开、一键搬移、恢复默认；旧版 %APPDATA%\DesktopNotesDev 下的笔记首次启动自动复制过来。
#    ② 安装包支持选择安装位置（默认 D:\轻提词，`DisableDirPage=no`），卸载时 data 目录保留
#       （setup.iss 的 `[Dirs] ... uninsneveruninstall`），不会把用户笔记删掉。
#    ③ 新增「文件管理台」（Ctrl+K 或抽屉里的「管理」）：搜索 / 分类 / 批量置顶改色删除导出。
#    实际发布的 `轻提词安装包_v4.6.0.exe` 由 **Inno Setup** 编译（`ISCC.exe src-tauri\inno\setup.iss`）；
#    另一条 `npm run tauri build` 的 NSIS 路线（tauri.conf.json 的 bundle.targets=["nsis"]）
#    产出 `轻提词_4.5.0_x64-setup.exe`（约 1.7 MB）—— 4.1.8 实测这条路线**不可靠**
#    （同一份文件先能装、后来静默安装什么都不装），所以发布不用它。
#    **发版前两条都要同步版本串** —— preflight 会核对 setup.iss；打完包再跑
#    `node scripts/verify-installer.mjs`（真机装一次、启动一次、卸载一次）才允许发出去。
#    历史教训：4.1.0 / 4.1.1 两次发版都漏改了 setup.iss，它一度停在 4.0.3（2026-10-14 已修正）。
#
# ℹ️ 4.7.0 实况（软件内在线升级）：
#    客户端启动静默查 <更新源>/updates/latest.json，设置 → 关于 里也能手动查；
#    安装版走「下安装包 + 静默覆盖装」，便携版走「换 exe（旧文件留 .old-<版本>）」。
#    发版时多一步： node scripts/make-update-manifest.mjs → 把 server_ai\updates\ scp 上服务器。
#    下载与 SHA-256 校验都在前端做（crypto.subtle + fetch 进度），Rust 只负责落盘/应用/重启，
#    所以**没有新增任何 Rust 依赖**。详见下面「在线升级（4.7.0）」一节。
```

> **构建前务必跑 `npm run preflight`**：4.0.2 起登录凭据与 AI 地址都从 `.env` 注入
> （`.env` 被 gitignore，只在本机），缺了会打出"能装、能开、但登录凭据为空"的包；
> 它同时会告诉你线上 AI 服务端是不是还没升级到新版。

> 链接时若出现 `multiple non-default manifests` 警告，是 Tauri 2 + GNU 工具链的已知现象
> （WebView2 清单与应用清单合并），Win10/11 已内置 WebView2 运行时，无影响。
>
> ⚠️ **本仓库路径含中文（`桌面速记\轻提词V4.0`）时，GNU 工具链会直接编译失败**：
> `dlltool: Can't create .lib file: ...\rustcXXXX\kernel32.dll_imports.lib: No such file or directory`
> （dlltool 按 ANSI 代码页读参数，中文路径变成乱码）。4.1.8 发版实测可行的办法是
> **把编译中间产物挪到纯英文目录**：
> ```powershell
> $env:CARGO_TARGET_DIR = 'D:\mp4target'   # 纯 ASCII 路径（与 build.ps1、§6 用的是同一个）
> npm run tauri build                       # 前端照常在本目录构建
> ```
> 产物会出现在 `D:\mp4target\release\bundle\nsis\`。
> 另一条路是装 MSVC 工具链（VS Build Tools）后 `rustup default stable-x86_64-pc-windows-msvc`，
> 它不用 dlltool，也就没有中文路径问题。

## 在线升级（4.7.0）

装着软件的人不用再手动下新包：**启动后静默查一次更新，设置 → 关于里也能手动查**。

**怎么工作（一次更新的完整链路）**

| 步骤 | 谁做 | 说明 |
| --- | --- | --- |
| ① 查清单 | 前端 `GET <更新源>/latest.json` | 拿版本号 / 更新说明 / 下载项 / SHA-256 |
| ② 比版本 | `src/services/updater.ts` | 只有清单版本 > 当前版本才提示；相同就静默（不打扰） |
| ③ 下载 | 前端 `fetch` + `ReadableStream` | 真实进度（百分比 + 已传/总量），不占内存峰值 |
| ④ 校验 | `crypto.subtle` 算 SHA-256 | **不匹配就拒绝**，界面上直接给期望/实际两个哈希 |
| ⑤ 落盘 | Rust `save_update_file` | 先写 `.part` 再改名，断电不会留下半个 exe |
| ⑥ 应用 | Rust `apply_update` | 写更新脚本 → 确认脚本真的活起来 → 自己退出 |
| ⑦ 替换 | 更新脚本（PowerShell，脱离本进程） | 安装版静默覆盖安装；便携版旧 exe 改名留底再写新的 |
| ⑧ 重启 | 同一个脚本 | 启动新版；下次启动会提示「已更新到 x.y.z」 |

- **安装版**（exe 旁边有 `unins000.exe`）→ 下**安装包**，静默 `/DIR=<当前安装目录>` 覆盖装，
  快捷方式与卸载注册表项一起更新；**便携版** → 只下 exe，旧文件留成 `轻提词.exe.old-<旧版本>`。
- 下载与校验全部在前端完成，所以 **Rust 侧没有引入任何新依赖**（不用 reqwest，离线也能编译）。
- 更新缓存：`%LOCALAPPDATA%\轻提词\update\`，日志 `update.log`（客户端与脚本写同一个文件，
  排障时一眼看出是「脚本没起来」还是「脚本里失败了」）。

**怎么发一次更新**

```powershell
# 1) 版本号 6 处一起升（package.json / tauri.conf.json / Cargo.toml / setup.iss /
#    SettingsDialog.tsx（关于页）/ WelcomeScreen.tsx），npm run preflight 会核对
# 2) 出产物：npm run build:checked → cargo build --release --features tauri/custom-protocol
#            → ISCC.exe src-tauri\inno\setup.iss
# 3) 生成清单（算 size + SHA-256，并把两份产物复制进 server_ai\updates\files\）
node scripts/make-update-manifest.mjs --notes-file release\notes-4.7.0.md
# 4) 把 server_ai\updates\ 整个目录 scp 到服务器（ai_server.py 同级的 updates/）
#    换位置也可以： MP_UPDATES_DIR=/srv/mp-updates python3 ai_server.py
# 5) 不用登录就能自测：
curl -s http://<服务器>:2581/updates/latest.json
curl -sI "http://<服务器>:2581/updates/files/轻提词安装包_v4.7.0.exe"
```

**安全与边界（务必知道）**

- 更新源是 **明文 HTTP + 裸 IP，产物未签名**：SHA-256 只能防「传输损坏 / 文件被换」，
  **挡不住中间人**（攻击者可以同时改清单和文件）。要真防篡改得上 HTTPS + 代码签名。
- 更新源必须允许跨域（`Access-Control-Allow-Origin`）——客户端页面跑在 `http://tauri.localhost`；
  `ai_server.py` 的 `/updates` 已带 CORS，把更新包放同一台服务器最省事。
- 客户端**只在清单版本 > 当前版本**时才提示；`/updates` 两条路由不校验登录态（更新包不敏感），
  但文件名做了白名单（挡 `..`、子目录、隐藏文件），并支持 `curl -I` 探活。
- 「忽略此版本」= 记住版本号不再提示（设置 → 关于里仍可手动更新）；「稍后」= 只是收起卡片，
  下次启动还会提醒。启动自动检查可在 设置 → 关于 里关掉（`localStorage` 的
  `microprompt.update.autoCheck`）。
- 更新提示卡挂在 `main.tsx`，**登录页/欢迎页也能看到**；而「已更新到 x.y.z」这类反馈走的是
  `<ToastHost/>`（挂在登录后的界面里），所以在登录页重启更新时看不到那句提示 —— 卡片本身照旧显示。

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
  需要先带调试端口启动便携版：
  `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"` 然后 `.\便携版\轻提词.exe`
  （也可用 `release\轻提词.exe`；2026-10-17 起工作区只有「便携版 + 安装版」两种形态，见下节）。
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

## 数据存储（与 C++ 版兼容 · 4.6.0 起位置可自选）

- **默认位置（4.6.0 起）**：`<安装目录>\data\notes.json` + `refblocks.json`
  —— 安装版即 `D:\轻提词\data\`；免安装版即 exe 旁边的 `data\`（exe 目录不可写时自动退回 `%APPDATA%`）
- **位置解析优先级**：`MICROPROMPT_DATA_DIR` > 用户在「设置 → 存储」里自选的位置（存
  `%APPDATA%\<profile>\config.json` 的 `dataDir`）> `<安装目录>\data` > `%APPDATA%\DesktopNotesDev\DesktopNotes`
- **旧数据自动迁移**：新默认目录里还没有 `notes.json`、而旧位置（`%APPDATA%\DesktopNotesDev\DesktopNotes`）有
  → 首次启动复制一份过去（只复制不删除，旧文件留作备份）
- **环境变量切换**：`MICROPROMPT_PROFILE=dev|test|stable`，或 `MICROPROMPT_DATA_DIR=<绝对路径>`
- **换位置 = 三步走**（`switch_data_dir` 命令）：先 flush 内存改动 → 复制到新目录并读回校验
  （必须是合法笔记 JSON）→ 才写配置；选择覆盖时目标目录里的旧 `notes.json` 会先备份成 `notes.json.<时间戳>.bak`
- 字段语义与 C++ 版 `NoteManager::Note` 一致，4.6.0 多一个 `pinned`（旧版/ C++ 版读到会忽略，
  缺失时按 `false` 处理，双向兼容）
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
- [x] **Phase 6 补充（服务端 4.1.4）后台配色简化**：按需求「后台不要花里胡哨、要和软件雷同」，
  删掉 4.1.2 的 INS 渐变与彩色块，改成与客户端 `src/styles.css` 同一套令牌 ——
  单一靛蓝 `#6366f1` + slate 灰阶（页面 `#f8fafc` / 卡片 `#fff` / 描边 `#eef2f7`）、
  12~16px 圆角、白底细描边按钮；暗色改中性深色且图表按主题取色。功能一项没减
- [x] **Phase 6 补充（服务端 4.1.5~4.1.7）概览页显示问题**：用户报「概览页显示有问题」，
  查出两个独立问题并各自修掉 —— ① 4.1.5：概览页两栏栅格误用 `.grid.side`，撞上左侧栏
  `.side` 的 `width:236px / height:100vh / position:sticky`，趋势图被压成 **81px** 宽
  （改名 `.grid.split` 后恢复 **723px**，并补「尺寸占比」回归断言）；② 4.1.6/4.1.7：偶发整块
  空白（`net::ERR_CONTENT_LENGTH_MISMATCH`）—— 响应补 `Connection: close`，读接口失败
  **自动重试一次**、写接口绝不重试、失败时给可读提示不留空白；实测走本机代理失败率
  10/14、直连 0/28，确认是代理那一跳的问题
- [x] **Phase 6 补充（服务端 4.1.8）用户自助改密 + 设置页重设计**：用户提出三件事 ——
  ①「设置里的用户界面重新设计、允许用户改密码但要二级界面」；②「AI 助手界面重构」；
  ③「开关附近的阴影和边框形成特别明显的分界线」。对应改动：服务端新增
  `POST /api/change-password`（验原密码 → `tokenVer+1` 踢掉其它设备 → 给当前设备补新令牌）；
  客户端「用户」页与「AI 助手」页改成**分组卡片**，改密做成一层独立小窗
  （原密码 / 新密码 / 确认 + 显示密码 + 本地校验 + 成功失败提示）；
  开关与三档开关去掉写死的拟物阴影（`#ffffff` 高光 + `#d1d9e6`），改成跟随主题的
  平轨道 + 滑块下投影（边缘跳变 41 → 22，实测见 `比赛提交材料/02_演进记录`）
- [x] **Phase 7（4.6.0）数据归位 + 文件管理台**：用户提三件事 —— ①「设置里能自选文件存哪、一键打开、
  一键搬到别的位置」；②「安装包要能选装在哪，默认 `D:\轻提词`，笔记默认也放软件根目录下的文件夹」；
  ③「保留抽屉那套展开样式，但要一个效率更高的文件管理架构」。对应落地：
  - **数据位置**：`resolve_data_dir()` 四级优先（环境变量 → 用户配置 `config.json` → `<安装目录>\data` →
    `%APPDATA%` 兜底）；旧数据**复制式**自动迁移；换位置走 `flush → 复制 → 读回校验 → 才写配置`
    （目标已有 `notes.json` 先备份），`open_folder` 用 explorer `/select,` 选中笔记文件；
  - **设置 → 存储**：路径 / 条数 / 占用 / 文件清单 + 打开文件夹 / 更改位置 / 恢复默认 / 文件管理；
  - **文件管理台（Ctrl + K）**：近全屏三栏（分类 / 列表 / 详情）+ 批量置顶改色导出删除 + 搜索排序 +
    键盘导航；原来的笔记抽屉**一行没改**，只加了个「管理」入口；
  - **安装包**：`DefaultDirName=D:\轻提词` + `DisableDirPage=no`（可改位置），安装时建 `{app}\data`，
    `uninsneveruninstall` 保证**卸载不删笔记**；
  - 新增 Rust 命令 11 个（存储信息 / 开关目录 / 列目录与盘符 / 快捷位置 / 新建文件夹 / 搬移 / 导出等），
    自绘文件夹选择器（不依赖没打进依赖的 `tauri-plugin-dialog`）；
  - 真机验证：装到 `D:\轻提词` → 界面与数据位置正确 → 搬移 / 恢复默认 / 导出全通 → 卸载后 `data\` 保留
- [x] **Phase 8（4.7.0）软件内在线升级**：用户提「能不能实现软件内直接在线升级」。对应落地：
  - **前端一套**：`src/services/updater.ts`（清单 → 比版本 → 下载带进度 → `crypto.subtle` 校验 →
    落盘 → 应用，zustand store）+ `src/components/UpdateWatcher.tsx`（右上角提示卡，挂在 `main.tsx`，
    与登录态无关）+ 设置 → 关于 里的「检查更新 / 启动自动检查」；
  - **Rust 三条命令**：`get_update_info`（版本 / 安装目录 / 是否安装版 / 缓存目录）、
    `save_update_file`（base64 → 先写 `.part` 再改名）、`apply_update`（写更新脚本 → 确认它活了 →
    退出）；**没有新增任何 Rust 依赖**（不用 reqwest）；
  - **两种应用方式**：安装版（exe 旁有 `unins000.exe`）下安装包静默覆盖装（`/DIR=<当前安装目录>`）；
    便携版只换 exe，旧文件留成 `轻提词.exe.old-<版本>`；
  - **服务端**：`ai_server.py` 新增 `/updates/latest.json` 与 `/updates/files/<name>`（+ HEAD、CORS、
    文件名白名单、路径穿越拦截）；`scripts/make-update-manifest.mjs` 发版时算 size + SHA-256 并写清单；
  - **失败安全**：SHA-256 不符一律拒绝；脚本起不来时 `apply_update` 返回错误且**程序不退出**，
    把 `apply-update.ps1` 的路径交给用户手动跑；`update.log` 里客户端与脚本写同一个文件便于排障；
  - 实测：静默检查 / 已是最新不打扰、进度 16%→94% 递增、sha256 写错被拒且不留文件、
    便携版换 exe（备份 + 哈希核对 + 自动重启）、**安装版静默覆盖安装 exit=0 + 自动重启 + 16 条笔记完好**
- [ ] Phase 5（P3）**剩余部分**：CI 自动构建、增量更新、代码签名 —— **均未做**，目前发版全靠手工

## 已知限制（客户端 v4.7.0 / 服务端 v4.7.0 · 2026-10-18 核对）

**界面 / 交互**

- **启动与退出动画未实现** —— 这是 Phase 2 唯一的遗留项，其余动效都已完成
- 窗口边缘缩放依赖 Tauri 原生无边框窗口行为（`resizable: true` + `decorations: false`）
- 列表 / 编辑器滚动条空闲淡出是两级透明度切换，不是 200ms 平滑过渡
- 后台实时刷新是 **2 秒轮询**（不是 SSE / WebSocket）：延迟最多 2 秒，
  换来的是零额外依赖、断线自愈（下一次轮询就恢复）；页签切到后台时暂停轮询省流量

**功能缺口**

- **应用内「修改密码」从 4.1.8 客户端起可用**：设置 → 用户 → 账号安全 → 「修改」弹出二级界面
  （原密码 / 新密码 / 确认，`src/components/ChangePasswordDialog.tsx`），改完**本机保持登录、
  其它设备掉线**；服务端 `POST /api/change-password` 已上线。
  仍在用 4.1.1 老客户端的用户，那一行还是「如需修改密码，请联系客服」，
  也可以由管理员在 `/admin` 点「重置密码」拿到一次性临时密码
- **支付是半自动**：用户点「我已完成支付」后，仍需管理员在 `/admin` 点「确认收款并开通」
  （或 `python3 admin_cli.py confirm <订单号>`）；支付通道回调接口已预留但未接；
  没收到钱时可以点 **「打回（没收到款）」** 作废该笔订单（4.1.3）
- **「订单被打回」的客户端提示已在 4.1.8 客户端里**：作废订单会明确提示并给「重新选套餐」按钮
  （`src/components/MemberDialog.tsx`）；仍在用 4.1.1 的用户遇到作废订单会停在「等待确认开通」页
  （不会再误扣费，重开「开通会员」弹窗即可重新下单）
- ~~旧版数据自动迁移（`%APPDATA%/DesktopNotesDev` → 新路径）尚未实现~~ → **4.6.0 已实现**：
  默认目录里还没有 `notes.json` 而旧位置有，就**复制**一份过去（只复制不删除，旧文件留作备份）
- **在线升级（4.7.0）的短板写清楚**：更新源是**明文 HTTP + 裸 IP、包未签名**，
  清单里的 SHA-256 只防「传输损坏 / 文件被换」，**挡不住中间人**；服务器上还得真的放好
  `server_ai/updates/`（含 `latest.json` 与 `files/`）并部署带 `/updates` 的 `ai_server.py`
  —— 线上服务若还是旧版，客户端只是静默跳过（不会报错，也不会提示）；另外「已更新到 x.y.z」
  这类反馈走 `<ToastHost/>`，**登录页看不到**（更新卡片本身照旧显示）
- **4.6.0 的文件管理台是「附加能力」**：原来的笔记抽屉（向上展开的气泡卡片）一行没改；
  管理台目前只做「管理」，不做云同步 / 多标签 / 回收站（删除仍是真删，带二次确认）
- **换保存位置是「复制 + 校验」而不是「移动」**：为了保证不丢数据，搬到新位置后旧目录里的文件会留下
  （可以自己删）；目标目录里已有 `notes.json` 时会先备份成 `notes.json.<时间戳>.bak`
- **文件夹选择器是自绘的**（没用 Tauri 官方 dialog 插件，离线构建环境拉不到那个 crate）：
  只支持选目录、进子目录、新建文件夹，没有系统弹窗的「最近位置 / 网络位置 / 新建到剪贴板」等能力
- **后台只有亮色和客户端一致**：后台的暗色模式是它独有的（客户端目前只有亮色），
  以后客户端要加暗色，两边的颜色令牌得对齐一次（4.1.4）

**发布 / 工程**

- **没有 CI、没有代码签名**：发版全靠手工
  （`npm run preflight` → `npm run build` → `cargo build` → ISCC 或 `npm run tauri build`），
  用户升级走**软件内在线升级**（4.7.0 起：设置 → 关于 / 启动静默检查）或重新安装；
  **在线升级本身没有代码签名兜底** —— 只有清单里的 SHA-256（防传输损坏/文件被换，防不住中间人），
  更新源还是明文 HTTP。要真防篡改就得上 HTTPS + Authenticode（见「在线升级（4.7.0）」）
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
