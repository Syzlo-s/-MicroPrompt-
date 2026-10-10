# 轻提词 AI 中转服务 · 4.0.2 部署与运维

> 相对 4.0.0 的变化：**加了鉴权、额度、会员、订单**。
> 4.0.0 的接口是完全开放的（任何人拿到地址就能刷你的 DeepSeek Key），
> 4.0.2 起必须带登录凭证才能调用。

---

## 一、文件清单（`server_ai/` 目录）

| 文件 | 说明 |
|---|---|
| `ai_server.py` | 服务主体（Python3 标准库，无第三方依赖，**兼容服务器上的 Python 3.6.8**）；同时提供管理后台页面 `/admin` |
| `admin_cli.py` | 管理员工具（命令行）：看订单 / 确认收款 / 手工加天数 / 查用户 |
| `selfcheck.py` | 部署自检：一条命令确认新代码到底生效没有 |
| `.env.example` | 环境变量模板（服务端不自动读 .env，需按说明 export） |
| `data/` | 运行时自动创建：用户、会员、用量、订单、管理员密钥、收款码、自动备份 |

**管理后台**：部署后浏览器打开 `http://<服务器IP>:2581/admin`，
粘贴管理员密钥即可确认收款开通会员（手机也能用，见第四节）。

客户端侧对应文件：`src/services/ai.ts`（请求会带 `Authorization: Bearer <登录 token>`）。

---

## 二、部署（覆盖更新，约 1 分钟）

```bash
# 1) 上传新文件（在本机执行；路径按你的实际情况）
scp server_ai/ai_server.py server_ai/admin_cli.py server_ai/selfcheck.py \
    root@<服务器IP>:/home/admin/ai_server/

# 2) 登录服务器
ssh root@<服务器IP>
cd /home/admin/ai_server

# 3) 先设好两个密钥（缺 MP_DEEPSEEK_KEY 会直接启动失败；MP_ADMIN_KEY 留空则自动生成）
pkill -f ai_server.py
MP_DEEPSEEK_KEY='sk-你的DeepSeekKey' MP_ADMIN_KEY='你自己设一个长密钥' \
  nohup python3 ai_server.py > ai_server.log 2>&1 &

# 4) 看日志确认启动
tail -n 20 ai_server.log

# 5) 自检：确认新代码生效（关键一步）
MP_ADMIN_KEY='你自己设一个长密钥' python3 selfcheck.py
```

> 启动失败排查：日志里出现「启动失败：未设置 MP_DEEPSEEK_KEY 环境变量」，
> 就是第 3 步漏了 `MP_DEEPSEEK_KEY`（4.0.2 起源码里不再内置 Key）。

自检输出应该是 6 项全 `[OK]`；如果提示
「`/ai/health 不存在（http=501）`」，说明服务器上跑的还是 4.0.0 旧代码，
重新上传 `ai_server.py` 并重启即可。

启动日志里会打印：端口、数据目录、Casdoor 地址、免费额度、会员日上限、**管理员密钥**。

> 如果不想每次都在命令行写密钥，就放在一个固定文件里：
> `echo "你的密钥" > /home/admin/ai_server/admin_key.txt`（服务启动时会读它）。

### 端口与防火墙
- 仍然是 **2581/TCP**（服务器 firewalld + 阿里云安全组已放行，无需改动）。
- 服务端要能访问 **127.0.0.1:2580**（本机 Casdoor）来校验登录凭证；
  如果 Casdoor 不在本机，用 `MP_CASDOOR_URL=http://<服务器IP>:2580` 指定。

### 两个已知坑（本版已处理 / 需注意）
1. **旧版是单线程**：`HTTPServer` 一次只能处理一个请求，一个慢的 DeepSeek 调用
   会把后面所有请求（包括浏览器预检）堵到超时，客户端表现为「AI 服务超时或无法连接」。
   4.0.2 已改为多线程（并且在 Python 3.6 上也能用）。
2. **管理员密钥建议只用字母数字**：不同终端传参编码不一致时，含中文的密钥会导致
   `admin_cli.py` 认证失败（服务端已做兼容处理不会崩，但会认不出来）。

### 可选环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `MP_ADMIN_KEY` | 自动生成 | 管理员密钥（管理接口用，**不要外泄**） |
| `MP_DATA_DIR` | 脚本同目录 `/data` | 数据目录 |
| `MP_CASDOOR_URL` | `http://127.0.0.1:2580` | Casdoor 地址 |
| `MP_FREE_DAILY` | `3` | 未付费用户每天免费次数 |
| `MP_MEMBER_DAILY_CAP` | `300` | 会员防滥用日上限 |
| `MP_RATE_LIMIT_SEC` | `2` | 同一用户两次调用最小间隔（秒） |
| `MP_DEEPSEEK_KEY` | **无默认值（必填）** | DeepSeek Key；未设置时服务**拒绝启动**（本地联调可用 `MP_MOCK=1` 绕过） |
| `MP_MOCK` | 关 | `=1` 时不调用 DeepSeek，返回模拟结果（本地联调用） |

---

## 三、额度规则（服务端唯一判定，改客户端绕不过）

| 用户 | 规则 |
|---|---|
| 未付费 | 每天 **3 次**（北京时间 0 点重置），超出返回 `402 free_exhausted` |
| 会员 | 正常使用不限量，但设 **300 次/天** 防滥用上限（超出返回 `402 member_cap`） |
| 所有人 | 两次调用最小间隔 2 秒（返回 `429 rate_limited`）；单次文本上限 2 万字符 |
| 身份 | 必须带 Casdoor `access_token`，校验失败返回 `401 auth` |

> 说明：AI 只对**云端账号**开放。本机离线账号（`local:` 前缀）在服务端无法验证身份，
> 客户端会直接提示「请使用云端账号登录后再用 AI」。

---

## 四、收款码（半自动支付）

把收款码图片命名为 `paycode.png` 放到数据目录：

```bash
# 例：把微信/支付宝收款码传上去
scp 收款码.png root@<服务器IP>:/home/admin/ai_server/data/paycode.png
```

客户端「开通会员」弹窗会自动拉取 `http://<服务器IP>:2581/ai/paycode.png` 展示；
没上传时弹窗会提示「请联系客服获取收款码」。

### 用户下单 → 你确认开通 的完整流程

1. 用户在软件里：设置 → AI 助手 → 开通会员 → 选日卡/月卡 → 得到订单号，扫码付款；
2. 用户点「我已完成支付」（订单状态变 `claimed`）；
3. 你确认收款并开通 —— **两种方式任选**：

**方式 A（推荐，手机也能用）：后台页面**

浏览器打开 `http://<服务器IP>:2581/admin`

1. 粘贴管理员密钥 → 点「保存到本浏览器」（密钥只存在你自己浏览器里，不会写进页面）；
2. 订单列表里点「确认收款并开通」即可，支持勾选「每 15 秒自动刷新」；
3. 同一页面还能「加天数」和「查用户额度」。

**方式 B（服务器命令行）**

```bash
cd /home/admin/ai_server
python3 admin_cli.py list            # 看所有订单（claimed = 用户说已付）
python3 admin_cli.py confirm 20261010XXXX-AB   # 确认收款 → 自动开通对应天数
```

4. 客户端弹窗会自动轮询到「已开通」，额度立即生效。

> 防重复收款：同一用户同套餐只会有一笔「待付款」订单（旧的自动作废）；
> 用户中途关掉弹窗再打开，会自动回到原来那笔订单（等待确认 / 继续付款），
> 不会再生成第二笔，也不用担心他重复付钱。
> 同一笔订单你手滑点两次 `confirm` 也只加一次会员天数。

### 其他管理命令

```bash
python3 admin_cli.py lookup <用户名>     # 查会员到期 + 今日用量
python3 admin_cli.py grant <用户名> 30   # 手工加 30 天（补偿 / 活动 / 内部账号）
python3 admin_cli.py key                # 打印当前管理员密钥
```

---

## 五、以后接在线支付通道（自动开通）

代码里已经留好位置，只要在 `ai_server.py` 的 `_do_pay_notify()` 里补三件事：

1. 按通道要求验签（虎皮椒 / 易支付 / 微信支付 V3 / 支付宝 各有自己的验签方式）；
2. 从回调里取出订单号，找到 `store.get_order(orderId)`；
3. 调用 `store.confirm_order(orderId)` —— 它会把订单标记 `paid` 并给用户加会员天数。

然后把回调地址填成 `http://<服务器IP>:2581/ai/pay/notify` 即可。
（现在该接口返回 `501 pay_channel_off`，避免被误调用。）

---

## 六、数据文件与备份

`data/` 目录：

| 文件 | 内容 |
|---|---|
| `users.json` | 见过的用户（id / 用户名 / 首末次时间） |
| `members.json` | 会员到期时间 |
| `usage.json` | 每人每天的免费/会员用量 |
| `orders.json` | 订单记录 |
| `admin_key.txt` | 管理员密钥 |
| `paycode.png` | 收款码（可选） |
| `backup/` | **自动备份**（见下） |

### 自动备份（4.0.2 新增）

每次**启动服务**时，会把上面 4 个 json 复制到 `data/backup/`，
命名为 `members.20261010-093501.json` 这样的时间戳文件，**每个文件只保留最近 7 份**，
启动日志里会打印「已备份 N 个数据文件」。

> 为什么要这个：`members.json` / `orders.json` 丢了就等于用户白付了钱。
> 想手工再兜一层可以偶尔执行：
> ```bash
> tar czf ~/ai_data_$(date +%F).tar.gz -C /home/admin/ai_server data
> ```
> 注意：备份只在**启动时**做，所以服务长期不重启时，建议按上面这条定时打包一次。

```bash
# 备份
tar czf ~/ai_data_$(date +%F).tar.gz -C /home/admin/ai_server data
```

写入方式：先写 `.tmp` 再改名覆盖，不会写坏；单进程单锁，不会并发写乱。

---

## 七、本地联调（不花 DeepSeek 的钱）

```bash
MP_MOCK=1 MP_PORT=2599 MP_DATA_DIR=./data_test MP_ADMIN_KEY=testkey \
  MP_CASDOOR_URL=http://127.0.0.1:2600 python3 ai_server.py
```

`MP_MOCK=1` 时不会真的调用 DeepSeek，直接返回一段模拟润色结果，
用来验证「额度 → 下单 → 开通 → 额度变化」整条链路。

健康检查：`curl http://127.0.0.1:2599/ai/health`

---

## 八、排查

| 现象 | 原因 / 处理 |
|---|---|
| 客户端提示「登录状态已失效」 | token 过期（30 天）→ 重新登录；或服务端连不上 Casdoor |
| 客户端提示「无法连接 AI 服务」 | 2581 未启动 / 安全组关闭 → `tail -n 50 ai_server.log` |
| 所有人都是 402 | 免费次数用完是正常的；要改次数用 `MP_FREE_DAILY` |
| 管理命令报「无法连接服务」 | 服务没起来，或 `MP_URL` 端口不对（默认 2581） |
| 用户说付了钱但没开通 | `python3 admin_cli.py list` 看有没有 `claimed` 订单，然后 `confirm` |
