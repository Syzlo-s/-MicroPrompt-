#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻提词 · AI 中转服务（4.1.8）
============================================================
在 4.0.0 的「纯转发」版本上补上：鉴权 / 额度 / 会员 / 订单。
4.1.0 再把第三方账号系统 Casdoor 换成内置账号模块（自建注册/登录/凭证校验），
使账号与 AI 额度在同一个服务里管理；客户端一行都不用改（兼容 Casdoor 的 5 个接口）。
4.1.1 修注册：用户名放开中文（1~32 位），并把「用户名/密码不符合要求」写成
一眼能看懂的整句（此前只收 ASCII，中文昵称会被当场拒掉且看不出原因；
同日再补齐单字用户名——用户实际填的是「吴」这种单姓，被 2 位下限挡掉了）。
4.1.2 重构管理后台（/admin，桌面优先的控制台）并补上运维能力：
  · 实时：每次数据落盘 +1 修订号，页面每 2 秒只拉一个几百字节的快照，
    变了才重画（/ai/admin/poll）；概览页有 KPI、额度分布、近 14 天趋势（/ai/admin/overview）
  · 每日统计 stats.json（调用/登录/下单/开通/收入/新增账号），趋势图与月收入靠它
  · 操作审计 admin_log.json：后台每次写操作留痕（谁、何时、对谁、做了什么）
  · 安全视图：登录失败锁定记录 + 管理员密钥错误（后者只进内存，防磁盘放大）
  · 收款码在线上传/替换/删除（不用再 scp 图片到服务器）
界面源文件是 server_ai/admin_ui.html，用 sync_admin_page.py 注入下面的 ADMIN_PAGE。
4.1.3 补「打回」：用户点了「我已完成支付」但管理员查账发现没收到钱时，
  后台订单页可以一键打回（POST /ai/admin/reject）—— 订单作废、不开会员、不计收入、
  记进操作审计，用户端显示「已作废」并可重新下单；已开通的订单不允许打回（防误抹会员）。
4.1.4 后台配色简化：去掉 4.1.2 的 INS 渐变与彩色块，改成与桌面客户端
  （src/styles.css）同一套视觉语言 —— 单一强调色靛蓝 #6366f1 + slate 中性底
  （页面 #f8fafc / 卡片 #fff / 描边 #eef2f7）、12~16px 圆角、白底细描边按钮、
  柔和阴影；暗色改成中性深色（#0f172a / #111827），图表按主题取色。
  功能一行没减（六个页签、2 秒实时、暗色、抽屉、批量、CSV、打回都在）。
4.1.5 修概览页布局 bug：`.grid.side` 这个类名同时命中了左侧栏的 `.side`
  （width:236px / height:100vh / position:sticky），于是「近 14 天 AI 调用」趋势图
  和「额度分布」两张卡片被挤成 236px 宽的窄条（图表实际只有 81px 宽、额度分布 38px 宽）。
  改名 `.grid.split`，并补上"概览卡片宽度必须占满内容区"的回归断言。
4.1.6 修「后台偶发空白」第一层：HTTP/1.0 的响应原来不带 Connection 头，
  浏览器/中间代理会把连接放回池子复用，复用到服务端已关闭的 socket 时响应被截断
  （net::ERR_CONTENT_LENGTH_MISMATCH），概览页 KPI 与图表整块不出来。
  统一在 end_headers() 里补 `Connection: close`，明确"短连接、别复用"。
4.1.7 修「后台偶发空白」第二层（真正常见的那种）：本机代理会把 HTTP/1.0 的
  响应截断（实测走代理时每 4 次加载有 2~3 次失败，直连 0 次），
  于是读接口（need()）在网络层失败时**自动重试一次**（紧接着重发必成功），
  并且概览页加载失败时给出可读提示，不再留一整块空白。
  写接口（确认收款/打回/重置…）绝不自动重试，避免重复执行。
4.1.8 账号兼容层新增 POST /api/change-password：用户终于可以自己改密码了
  （以前只能"联系客服"）。必须带登录令牌 + **必须验原密码**，
  新密码 8~128 位且不能与原密码相同；改完 tokenVer +1 把其它设备的旧令牌踢下线，
  同时返回一张新令牌，让当前这台设备不用重新登录。
  身份只从令牌取（不接受客户端传 uid/用户名），失败话术不区分账号是否存在。

设计要点
  · 鉴权：客户端必须带 Casdoor access_token（Authorization: Bearer xxx），
    服务端向 Casdoor /api/get-account 校验后得到用户身份；
    没有 token / token 失效 => 401，客户端提示重新登录。
  · 额度（唯一判定点，客户端只做展示，改前端绕不过）：
      未付费用户：每天 FREE_DAILY_QUOTA 次（默认 3，按北京时间 0 点重置）
      会员      ：正常使用不限量，但设防滥用日上限 MEMBER_DAILY_CAP（默认 300）
  · 会员：日卡 2 元 / 月卡 8 元；半自动支付
      下单 -> 用户扫码付款 -> 点「我已完成支付」-> 管理员确认 -> 开通到期时间
      支付通道到位后，只要把 /ai/pay/notify 接上即可自动开通（见 README）。
  · DeepSeek Key 只存在服务器，客户端拿不到。

接口一览
  POST /ai/polish        鉴权+计次   {text, system?}          -> {result, quota}
  GET  /ai/quota         鉴权                                    -> 额度/会员状态
  POST /ai/order         鉴权        {plan: day|month}          -> 订单
  GET  /ai/order?id=     鉴权                                    -> 订单状态（轮询）
  POST /ai/order/claim   鉴权        {id}                       -> 标记"我已支付"
  GET  /ai/paycode.png                                          -> 收款码图片
  POST /ai/admin/orders  管理员      {status?}                  -> 订单列表
  POST /ai/admin/confirm 管理员      {id}                       -> 确认收款并开通
  POST /ai/admin/grant   管理员      {username, days}           -> 手工加天数
  POST /ai/admin/lookup  管理员      {username}                 -> 查会员/用量
  GET  /ai/health

  【4.1.0 自建账号模块】以下接口在两种模式下都提供；MP_AUTH_MODE=builtin 时
  本进程会额外监听 2580 端口（客户端写死的 Casdoor 地址就是它），令牌改为本地校验。
  POST /api/signup                      注册（兼容 Casdoor 形状）
  POST /api/login/oauth/access_token    登录（form-urlencoded）-> 自签 HS256 JWT
  GET  /api/get-account                 校验登录态 / 取用户对象（只白名单输出）
  POST /api/update-user                 改资料（只接受 displayName / avatar）
  POST /api/change-password             用户自己改密码（4.1.8：验原密码 + 踢掉其它设备）
  POST /api/upload-resource             头像上传（multipart，≤2MB，按魔数校验）
  GET  /avatar/<uid>.<ext>              头像文件
  POST /ai/admin/account/list|create|resetpwd|status|kick|note   后台账号管理

  【4.1.2 后台实时与运维】全部要求 X-Admin-Key
  POST /ai/admin/poll           {rev?}      -> 轻量实时快照（修订号/账号/待处理/今日调用与收入）
  POST /ai/admin/overview                  -> KPI + 近 14 天趋势 + 热门账号（概览页）
  POST /ai/admin/logs                      -> 操作审计（最近 500 条）
  POST /ai/admin/security                  -> 登录锁定记录 + 管理员密钥错误
  POST /ai/admin/paycode/list              -> 4 个收款码槽位（日卡/月卡 × 微信/支付宝）
  POST /ai/admin/paycode/upload {plan, method, data(dataURL)}   -> 上传/替换收款码
  POST /ai/admin/paycode/delete {plan, method}                  -> 删除收款码
  POST /ai/admin/reject         {id, reason?}                   -> 打回订单（未收到付款，4.1.3）

运行
  MP_ADMIN_KEY=你的管理密钥 python3 ai_server.py
  nohup env MP_ADMIN_KEY=你的管理密钥 python3 ai_server.py > ai_server.log 2>&1 &

可选环境变量
  MP_ADMIN_KEY        管理员密钥（首次运行若未设置，会自动生成并存到 data/admin_key.txt）
  MP_DATA_DIR         数据目录（默认：脚本同目录/data）
  MP_AUTH_MODE        casdoor（默认，沿用 Casdoor 校验令牌）/ builtin（自建账号 + 监听 2580）
  MP_AUTH_PORT        自建账号监听端口（默认 2580，设 0 关闭；仅 builtin 生效）
  MP_AUTH_CLIENT_ID   兼容层要求的 client_id（默认与客户端 .env 一致）
  MP_AUTH_CLIENT_SECRET 若设置则必须匹配，留空则只校验「存在且非空」
  MP_JWT_TTL          自签令牌有效期秒数（默认 604800 = 7 天，与 Casdoor 原值一致）
  MP_PBKDF2_ITERS     密码哈希迭代次数（默认 120000）
  MP_LOGIN_MAX_FAIL   同名连续失败几次后锁定（默认 5）
  MP_LOGIN_LOCK_SEC   首次锁定时长秒数（默认 600，再犯翻倍，上限 3600）
  MP_CASDOOR_URL      Casdoor 地址（默认 http://127.0.0.1:2580）
  MP_FREE_DAILY       未付费每天次数（默认 3）
  MP_MEMBER_DAILY_CAP 会员防滥用日上限（默认 300）
  MP_RATE_LIMIT_SEC   两次调用最小间隔秒数（默认 2）
  MP_DEEPSEEK_KEY     DeepSeek Key（必填，源码内不含任何默认值；缺失则拒绝启动）
  MP_MOCK=1           本地联调用：不调用 DeepSeek，直接返回假结果
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

try:  # Python 3.7+
    from http.server import ThreadingHTTPServer
except ImportError:  # Python 3.6（阿里云服务器是 3.6.8）：自己拼一个多线程版本
    import socketserver

    class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
        daemon_threads = True
        allow_reuse_address = True

# ============================== 配置 ==============================

# 安全：Key 只从环境变量读取，源码内不留任何真实密钥（本文件会进公开仓库）。
# 缺失时 main() 直接拒绝启动，避免带着空 Key 静默运行、把 401 当成业务错误。
DEEPSEEK_KEY = os.environ.get("MP_DEEPSEEK_KEY", "").strip()
DEEPSEEK_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-chat"

PORT = int(os.environ.get("MP_PORT", "2581"))
CASDOOR_URL = os.environ.get("MP_CASDOOR_URL", "http://127.0.0.1:2580").rstrip("/")

# ---- 4.1.0 自建账号模块 ----
VERSION = "4.7.0"
# casdoor：令牌拿去问 Casdoor（4.0.3 的行为，默认，便于随时回滚）
# builtin：令牌本地校验，并额外监听 MP_AUTH_PORT（客户端写死的 2580）
AUTH_MODE = (os.environ.get("MP_AUTH_MODE", "casdoor") or "casdoor").strip().lower()
AUTH_PORT = int(os.environ.get("MP_AUTH_PORT", "2580"))
# 客户端 .env 里的 client_id（前端可提取，不是机密）；secret 留空表示只校验"存在且非空"
AUTH_CLIENT_ID = os.environ.get("MP_AUTH_CLIENT_ID", "b49640f6c4dabd78ce94").strip()
AUTH_CLIENT_SECRET = os.environ.get("MP_AUTH_CLIENT_SECRET", "").strip()
JWT_TTL_SEC = int(os.environ.get("MP_JWT_TTL", "604800"))     # 7 天，与 Casdoor 原值一致
PBKDF2_ITERS = int(os.environ.get("MP_PBKDF2_ITERS", "120000"))
LOGIN_MAX_FAIL = int(os.environ.get("MP_LOGIN_MAX_FAIL", "5"))
LOGIN_LOCK_SEC = int(os.environ.get("MP_LOGIN_LOCK_SEC", "600"))
IP_MAX_FAIL = int(os.environ.get("MP_IP_MAX_FAIL", "20"))
FAIL_WINDOW_SEC = int(os.environ.get("MP_FAIL_WINDOW_SEC", "900"))   # 15 分钟统计窗口
AVATAR_MAX_BYTES = 2 * 1024 * 1024
AVATAR_EXTS = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
               "webp": "image/webp"}
# 用户名：中英文、数字、下划线、连字符，1~32 位，首尾不能是 _ 或 -
# 4.1.1 起放开中文（老 Casdoor 时代的用户习惯用中文昵称，只收 ASCII 会当场被拒）
# 4.1.1 同日补齐：允许单字用户名（用户实际填的是「吴」这种单姓，被原来的 2 位下限挡掉了）
USERNAME_RE = re.compile(
    r"^[A-Za-z0-9\u4e00-\u9fa5](?:[A-Za-z0-9_\-\u4e00-\u9fa5]{0,30}[A-Za-z0-9\u4e00-\u9fa5])?$")
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
AVATAR_FILE_RE = re.compile(r"^[0-9a-fA-F-]{36}\.(png|jpg|jpeg|webp)$")

FREE_DAILY_QUOTA = int(os.environ.get("MP_FREE_DAILY", "3"))
MEMBER_DAILY_CAP = int(os.environ.get("MP_MEMBER_DAILY_CAP", "300"))
RATE_LIMIT_SEC = float(os.environ.get("MP_RATE_LIMIT_SEC", "2"))
TOKEN_CACHE_SEC = 300.0
MOCK = os.environ.get("MP_MOCK", "") == "1"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MP_DATA_DIR", os.path.join(BASE_DIR, "data"))

# 在线升级（4.7.0）：客户端的更新源就是本服务，形如
#   GET /updates/latest.json        → 最新版本清单（版本 / 说明 / 下载项 / SHA-256）
#   GET /updates/files/<文件名>      → 安装包或便携版 exe
# 目录结构（由 scripts/make-update-manifest.mjs 生成，scp 上来即可）：
#   updates/latest.json
#   updates/files/轻提词安装包_v4.7.0.exe
#   updates/files/轻提词_v4.7.0.exe
UPDATES_DIR = os.environ.get("MP_UPDATES_DIR", os.path.join(BASE_DIR, "updates"))
UPDATE_CHUNK = 256 * 1024

# 会员套餐（与客户端 / 欢迎页价格一致：日卡 2 元 / 月卡 8 元）
PLANS = {
    "day": {"key": "day", "name": "日卡", "desc": "24 小时不限量", "days": 1, "amount": 2.00},
    "month": {"key": "month", "name": "月卡", "desc": "30 天不限量", "days": 30, "amount": 8.00},
}

CST = timezone(timedelta(hours=8))  # 北京时间，用于额度按天重置

SYSTEM_PROMPT = (
    "你是「轻提词」的 AI 提示词润色助手。请对用户提供的提示词进行润色与规范化，要求：\n"
    "1. 第一行输出一个用于总结本段内容的简短标题，末尾加全角冒号「：」"
    "（例如「AI润色功能的修改：」）；\n"
    "2. 标题后空一行；\n"
    "3. 随后输出润色后的正文：在不改变原意的前提下，结构清晰、表达准确、"
    "条理分明，必要时用 1、2、3 编号列出；\n"
    "4. 只输出标题与正文，不要任何额外解释、客套话或代码块标记；\n"
    "5. 每行行首不要添加空格或缩进；行与行之间不要都空行，只在确实需要分段时"
    "空一行。"
)


# ============================== 小工具 ==============================


def now_ts():
    return time.time()


def today_str():
    return datetime.now(CST).strftime("%Y-%m-%d")


def is_today(ts):
    """时间戳（unix 秒）是否落在北京时间「今天」。"""
    try:
        ts = float(ts or 0)
    except Exception:
        return False
    if ts <= 0:
        return False
    return datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d") == today_str()


def log(*args):
    print(datetime.now(CST).strftime("[%Y-%m-%d %H:%M:%S]"), *args)
    sys.stdout.flush()


def clean_result(s):
    """去掉每行行首/行尾多余空白，并把连续空行压成一个。"""
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    blank = 0
    for ln in s.split("\n"):
        ln = ln.strip()
        if ln == "":
            blank += 1
            if blank > 1:
                continue
        else:
            blank = 0
        out.append(ln)
    return "\n".join(out).strip()


# ============================== 4.1.0 账号：密码 / 令牌 / multipart ==============================
# 全部只用标准库：服务器是 Python 3.6.8，glibc crypt 没有 BLOWFISH，
# 所以既不用 bcrypt 也不用 cgi（后者 3.6 起废弃、3.13 起被移除）。


def _b64u(raw):
    """base64url 编码，去掉 '=' 补位（JWT 的惯例写法）。"""
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def b64u_decode(text):
    """base64url 解码，容忍缺失/多余的 '=' 补位。"""
    if isinstance(text, bytes):
        text = text.decode("ascii", "replace")
    text = (text or "").replace("-", "+").replace("_", "/")
    text += "=" * (-len(text) % 4)
    return base64.b64decode(text)


def hash_pwd(pwd, iters=None, salt=None):
    """PBKDF2-HMAC-SHA256。返回 'pbkdf2_sha256$<iters>$<b64 salt>$<b64 dk>'。
    迭代次数写进哈希串本身，日后调高参数也不会让旧密码失效。"""
    iters = int(iters or PBKDF2_ITERS)
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"), salt, iters)
    return "pbkdf2_sha256$%d$%s$%s" % (
        iters, base64.b64encode(salt).decode("ascii"),
        base64.b64encode(dk).decode("ascii"))


def verify_pwd(pwd, stored):
    """校验密码。常量时间比较；任何异常都当作校验失败（不能 500 出去）。"""
    try:
        algo, iters, salt_b64, dk_b64 = (stored or "").split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", pwd.encode("utf-8"),
                                 base64.b64decode(salt_b64), int(iters))
        return hmac.compare_digest(dk, base64.b64decode(dk_b64))
    except Exception:
        return False


def pwd_needs_upgrade(stored):
    """哈希是否用了偏旧的参数（登录成功时顺手重算 = 无感升级）。"""
    try:
        return int((stored or "").split("$")[1]) < PBKDF2_ITERS
    except Exception:
        return False


# 账号不存在时也拿它跑一次同样代价的校验，避免用响应时间区分「账号是否存在」
DUMMY_PWD_HASH = ("pbkdf2_sha256$120000$AAAAAAAAAAAAAAAAAAAAAA==$"
                  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")

# 后台「重置密码」用的临时密码字符集：去掉 0/O/1/l/I 这些看错的字符
TEMP_PWD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"


def _temp_password(n=10):
    return "".join(secrets.choice(TEMP_PWD_ALPHABET) for _ in range(n))


def sign_jwt(payload, secret):
    """HS256 自签 JWT（payload 里请自带 iat / exp）。"""
    head = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"},
                            separators=(",", ":")).encode("utf-8"))
    body = _b64u(json.dumps(payload, separators=(",", ":"),
                            ensure_ascii=False).encode("utf-8"))
    sig = _b64u(hmac.new(secret.encode("utf-8"), head + b"." + body,
                         hashlib.sha256).digest())
    return (head + b"." + body + b"." + sig).decode("ascii")


def verify_jwt(token, secret):
    """校验并解出自签 JWT；任何问题都返回 None。"""
    try:
        head_b64, body_b64, sig = (token or "").split(".")
        head = json.loads(b64u_decode(head_b64).decode("utf-8"))
        # 必须先断言算法：否则 alg=none 或 RS256 混淆都可能被绕过
        if head.get("alg") != "HS256":
            return None
        want = _b64u(hmac.new(secret.encode("utf-8"),
                              (head_b64 + "." + body_b64).encode("ascii"),
                              hashlib.sha256).digest()).decode("ascii")
        if not hmac.compare_digest(want, sig):
            return None
        data = json.loads(b64u_decode(body_b64).decode("utf-8"))
        if int(data.get("exp", 0)) < time.time():
            return None
        return data
    except Exception:
        return None


def iso_cst(ts):
    """unix 秒 -> Casdoor 风格的 ISO8601（北京时间），空值返回空串。"""
    try:
        ts = float(ts or 0)
    except Exception:
        return ""
    if ts <= 0:
        return ""
    return datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def valid_username(name):
    return bool(USERNAME_RE.match(name or ""))


def _mp_boundary(content_type):
    for part in (content_type or "").split(";"):
        part = part.strip()
        if part.lower().startswith("boundary="):
            b = part[len("boundary="):].strip()
            if len(b) >= 2 and b[0] == '"' and b[-1] == '"':
                b = b[1:-1]
            return b.encode("utf-8")
    return None


def parse_multipart(body, content_type, max_bytes=AVATAR_MAX_BYTES + 65536):
    """极简 multipart/form-data 解析：返回 {字段名: {filename, ctype, data}}。
    只做我们真实需要的事（普通字段 + 单文件），不处理嵌套 multipart。"""
    boundary = _mp_boundary(content_type)
    if not boundary or not body or len(body) > max_bytes:
        return {}
    out = {}
    for chunk in body.split(b"--" + boundary):
        if not chunk:
            continue
        chunk = chunk.lstrip(b"\r\n")
        if chunk.startswith(b"--"):
            break
        pos = chunk.find(b"\r\n\r\n")
        if pos < 0:
            continue
        raw_head = chunk[:pos].decode("utf-8", "replace")
        data = chunk[pos + 4:]
        if data.endswith(b"\r\n"):
            data = data[:-2]
        name = filename = ctype = ""
        for line in raw_head.split("\r\n"):
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            k = k.strip().lower()
            v = v.strip()
            if k == "content-disposition":
                for seg in v.split(";"):
                    seg = seg.strip()
                    low = seg.lower()
                    if low.startswith("name="):
                        name = seg[len("name="):].strip().strip('"')
                    elif low.startswith("filename="):
                        filename = seg[len("filename="):].strip().strip('"')
            elif k == "content-type":
                ctype = v
        if name:
            out[name] = {"filename": filename, "ctype": ctype, "data": data}
    return out


def _decode_data_url(text):
    """解析浏览器 FileReader 给的 data:image/png;base64,xxxx（也接受裸 base64）。"""
    if not text:
        return b""
    if isinstance(text, bytes):
        text = text.decode("ascii", "replace")
    if text.startswith("data:"):
        pos = text.find(",")
        if pos < 0:
            return b""
        head, text = text[:pos], text[pos + 1:]
        if "base64" not in head:
            return b""
    try:
        return base64.b64decode(text)
    except Exception:
        return b""


def sniff_image_ext(data):
    """按文件头魔数判断图片类型（不看客户端给的文件名，防伪装）。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return ""


class Store(object):
    """data 目录下的几个 JSON 文件：用户、会员、用量、订单、账号。
    单进程内用一把锁串行写；写文件走 tmp + rename，避免写坏。"""

    def __init__(self, data_dir):
        self.dir = data_dir
        self.lock = threading.RLock()
        self.token_cache = {}          # token -> (user_id, username, expire_at)
        self.last_call = {}            # user_id -> 上次调用时间
        self.rev = 0                   # 数据修订号：任何真实数据落盘就 +1（后台据此判断要不要重画）
        if not os.path.isdir(self.dir):
            os.makedirs(self.dir)
        self.users = self._load("users.json", {})       # id -> {id,name,first,last}
        self.members = self._load("members.json", {})   # id -> {until, name, updated}
        self.free = self._load("free.json", {})         # id -> {on,name,updated} 管理员开通的「免费不限量」
        self.usage = self._load("usage.json", {})       # id -> {day,free,member,unlimited,total}
        self.orders = self._load("orders.json", {})     # orderId -> {...}
        self.accounts = self._load("accounts.json", {})  # 4.1.0：uid -> 账号（含密码哈希）
        self.guard = self._load("auth_guard.json", {})   # 4.1.0：登录失败计数（丢了只是限速被重置）
        self.admin_key = self._load_admin_key()
        self.jwt_secret = self._load_jwt_secret()
        # ---- 4.1.2 后台：每日统计 / 审计日志 ----
        self.stats = self._load("stats.json", {})        # {days: {"YYYY-MM-DD": {calls,logins,...}}}
        self._stats_flushed = 0.0
        doc = self._load("admin_log.json", {})
        items = doc.get("items") if isinstance(doc, dict) else None
        self.admin_log = items if isinstance(items, list) else []
        self.admin_fails = []          # 管理员密钥错误记录：只放内存，避免被人刷成磁盘炸弹
        self.rev = 1

    # ---- 文件读写 ----
    def _path(self, name):
        return os.path.join(self.dir, name)

    def _load(self, name, default):
        """读数据文件。文件损坏时自动用最近的备份恢复（付费数据不能凭空消失）。"""
        path = self._path(name)
        if not os.path.isfile(path):
            return default
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("内容不是 JSON 对象")
            return data
        except Exception as e:  # noqa: BLE001
            log("数据文件损坏：%s（%s）" % (name, e))
            data = self._load_from_backup(name)
            if data is None:
                log("  没有可用备份，%s 以空数据启动（原文件保留为 %s.corrupt）" % (name, name))
                try:
                    os.replace(path, path + ".corrupt")
                except Exception:
                    pass
                return default
            log("  已从备份恢复 %s（%d 条），并为损坏文件留了一份 %s.corrupt"
                % (name, len(data), name))
            try:
                os.replace(path, path + ".corrupt")
            except Exception:
                pass
            try:
                self._save(name, data)  # 立刻写回，避免每次启动都走恢复
            except Exception:
                pass
            return data

    def _load_from_backup(self, name):
        """从 data/backup/ 里找最新一份能解析的备份。"""
        bdir = os.path.join(self.dir, "backup")
        base = name[:-5] if name.endswith(".json") else name
        try:
            files = sorted(
                [f for f in os.listdir(bdir) if f.startswith(base + ".")], reverse=True
            )
        except Exception:
            return None
        for fn in files:
            try:
                with open(os.path.join(bdir, fn), "r", encoding="utf-8") as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    log("  使用备份文件：%s" % fn)
                    return d
            except Exception:
                continue
        return None

    # 这几个文件是「派生视图」：它们变化时必定伴随某个真实数据文件一起变化，
    # 让它们也 +rev 只会让后台每 3 秒白重画一次，所以排除在外。
    _REV_EXEMPT = ("stats.json", "admin_log.json", "auth_guard.json")

    def _save(self, name, obj):
        path = self._path(name)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        if name not in self._REV_EXEMPT:
            self.rev = int(getattr(self, "rev", 0)) + 1

    def bump_rev(self):
        """数据文件之外的变化（例如上传收款码图片）也要让后台知道。"""
        with self.lock:
            self.rev = int(self.rev) + 1
            return self.rev

    def _load_admin_key(self):
        path = self._path("admin_key.txt")
        env = os.environ.get("MP_ADMIN_KEY", "").strip()
        if env:
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(env)
            except Exception:
                pass
            return env
        try:
            with open(path, "r", encoding="utf-8") as f:
                key = f.read().strip()
            if key:
                return key
        except Exception:
            pass
        key = secrets.token_urlsafe(24)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(key)
        except Exception:
            pass
        log("已生成新的管理员密钥，写入", path)
        return key

    def _load_jwt_secret(self):
        """自签令牌的 HS256 密钥。首次启动随机生成，权限 600。
        刻意不复用 MP_ADMIN_KEY：两把钥匙互为备份，泄露一把就等于全丢。"""
        path = self._path("jwt_secret.txt")
        try:
            with open(path, "r", encoding="utf-8") as f:
                key = f.read().strip()
            if key:
                return key
        except Exception:
            pass
        key = secrets.token_urlsafe(32)
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(key)
            os.chmod(path, 0o600)
        except Exception:
            pass
        log("已生成新的令牌签名密钥，写入", path)
        return key

    def backup_data(self, keep=7):
        """启动时把 data/*.json 备份到 data/backup/，每个文件保留最近 keep 份。
        付费体系下 members.json / orders.json 丢了就等于用户白付钱，必须有兜底。"""
        bdir = os.path.join(self.dir, "backup")
        try:
            if not os.path.isdir(bdir):
                os.makedirs(bdir)
        except Exception:
            return 0
        stamp = datetime.now(CST).strftime("%Y%m%d-%H%M%S")
        made = 0
        for name in ("users.json", "members.json", "free.json", "usage.json", "orders.json",
                     "accounts.json", "stats.json", "admin_log.json"):
            src = self._path(name)
            if not os.path.isfile(src):
                continue
            try:
                shutil.copy2(src, os.path.join(bdir, "%s.%s.json" % (name[:-5], stamp)))
                made += 1
            except Exception:
                continue
        # 只保留最近 keep 份（按文件名排序即时间排序）
        for base in ("users", "members", "free", "usage", "orders", "accounts",
                     "stats", "admin_log"):
            try:
                files = sorted([f for f in os.listdir(bdir) if f.startswith(base + ".")])
            except Exception:
                continue
            for old in files[:-keep]:
                try:
                    os.remove(os.path.join(bdir, old))
                except Exception:
                    pass
        return made

    def check_admin(self, key):
        """管理员密钥比对。
        注意：secrets.compare_digest 对含非 ASCII 的 str 会抛 TypeError，
        所以统一转成 bytes 再比，避免密钥里带中文时直接 500。"""
        if not key:
            return False
        try:
            return secrets.compare_digest(
                str(key).encode("utf-8"), str(self.admin_key).encode("utf-8")
            )
        except Exception:
            return False

    # ---- 用户 ----
    def touch_user(self, user_id, username):
        with self.lock:
            u = self.users.get(user_id) or {}
            if not u:
                u = {"id": user_id, "name": username, "first": now_ts()}
            u["name"] = username or u.get("name") or ""
            u["last"] = now_ts()
            self.users[user_id] = u
            self._save("users.json", self.users)
            return u

    def find_user_by_name(self, name):
        name = (name or "").strip().lower()
        for uid, u in self.users.items():
            if (u.get("name") or "").strip().lower() == name:
                return uid, u
        # 4.1.0：账号已建但还没登录过（users.json 里没有记录）时也要能找到
        uid, acc = self.account_by_name(name)
        if uid:
            return uid, {"id": uid, "name": acc.get("name"),
                         "first": acc.get("created") or 0, "last": acc.get("lastLogin") or 0}
        return None, None

    # ---- 账号（4.1.0 自建账号模块）----
    # 关键约定：id 是 UUID（沿用 Casdoor 时期的 uid），**永远不等于 name**；
    # 用户名唯一性按小写判定，但原样保留用户输入的大小写用于显示。

    def account_by_name(self, name):
        key = (name or "").strip().lower()
        if not key:
            return None, None
        for uid, acc in self.accounts.items():
            if (acc.get("name") or "").strip().lower() == key:
                return uid, acc
        return None, None

    def account_by_id(self, uid):
        acc = self.accounts.get(uid or "")
        return (uid, acc) if acc else (None, None)

    def accounts_save(self):
        self._save("accounts.json", self.accounts)

    def account_create(self, name, password, uid=None, display_name="", note="",
                       status="active"):
        """新建账号。失败时抛 ValueError，消息可直接给用户看。"""
        name = (name or "").strip()
        if not valid_username(name):
            raise ValueError("用户名不符合要求：只能中英文、数字、下划线或连字符，"
                             "1~32 位，且不能以 _ 或 - 开头结尾")
        if len(password or "") < 8:
            raise ValueError("密码不符合要求：至少 8 位")
        if len(password or "") > 128:
            raise ValueError("密码不符合要求：最长 128 位")
        with self.lock:
            existed, _ = self.account_by_name(name)
            if existed:
                raise ValueError("该用户名已被注册")
            if uid:
                if not UUID_RE.match(uid):
                    raise ValueError("uid 必须是 UUID 格式")
                if uid in self.accounts:
                    raise ValueError("该 uid 已存在")
            else:
                uid = str(uuid.uuid4())
            now = now_ts()
            acc = {
                "id": uid,
                "name": name,
                "displayName": (display_name or "").strip()[:32],
                "avatar": "",
                "pwd": hash_pwd(password),
                "created": now,
                "lastLogin": 0,
                "lastIP": "",
                "tokenVer": 1,
                "status": status if status in ("active", "disabled") else "active",
                "note": (note or "").strip()[:200],
            }
            self.accounts[uid] = acc
            self.accounts_save()
            self._stats_bump("newAccounts", 1, force=True)
            return acc

    def account_set_password(self, uid, password, bump=True):
        with self.lock:
            acc = self.accounts.get(uid)
            if not acc:
                raise ValueError("账号不存在")
            if len(password or "") < 8:
                raise ValueError("密码不符合要求：至少 8 位")
            acc["pwd"] = hash_pwd(password)
            if bump:
                acc["tokenVer"] = int(acc.get("tokenVer", 1)) + 1   # 旧令牌立刻失效
            self.accounts[uid] = acc
            self.accounts_save()
            return acc

    def account_set_status(self, uid, status):
        with self.lock:
            acc = self.accounts.get(uid)
            if not acc:
                raise ValueError("账号不存在")
            status = "disabled" if status == "disabled" else "active"
            if acc.get("status") != status:
                acc["status"] = status
                acc["tokenVer"] = int(acc.get("tokenVer", 1)) + 1    # 停用即踢下线
            self.accounts[uid] = acc
            self.accounts_save()
            return acc

    def account_bump_ver(self, uid):
        """只把凭证版本 +1：让该用户已在用的所有令牌失效（踢下线）。"""
        with self.lock:
            acc = self.accounts.get(uid)
            if not acc:
                raise ValueError("账号不存在")
            acc["tokenVer"] = int(acc.get("tokenVer", 1)) + 1
            self.accounts[uid] = acc
            self.accounts_save()
            return acc

    def account_set_note(self, uid, note):
        with self.lock:
            acc = self.accounts.get(uid)
            if not acc:
                raise ValueError("账号不存在")
            acc["note"] = (note or "").strip()[:200]
            self.accounts[uid] = acc
            self.accounts_save()
            return acc

    def account_set_profile(self, uid, display_name=None, avatar=None):
        """只改白名单字段；身份由调用方（JWT）保证。"""
        with self.lock:
            acc = self.accounts.get(uid)
            if not acc:
                raise ValueError("账号不存在")
            if display_name is not None:
                acc["displayName"] = display_name.strip()[:32]
            if avatar is not None:
                avatar = (avatar or "").strip()
                # 只收 http(s) URL：避免 javascript: 之类被塞进 <img src>
                if avatar and not (avatar.startswith("http://") or avatar.startswith("https://")):
                    avatar = acc.get("avatar") or ""
                acc["avatar"] = avatar[:512]
            self.accounts[uid] = acc
            self.accounts_save()
            return acc

    def account_touch_login(self, uid, ip=""):
        with self.lock:
            acc = self.accounts.get(uid)
            if not acc:
                return None
            acc["lastLogin"] = now_ts()
            acc["lastIP"] = ip or ""
            self.accounts[uid] = acc
            self.accounts_save()
            self._stats_bump("logins", 1)
            return acc

    @staticmethod
    def account_public(acc):
        """对外（客户端）白名单字段：绝不出现 pwd / tokenVer / status / note。"""
        return {
            "id": acc.get("id") or "",
            "name": acc.get("name") or "",
            "displayName": acc.get("displayName") or "",
            "avatar": acc.get("avatar") or "",
            "createdTime": iso_cst(acc.get("created")),
            "lastLoginTime": iso_cst(acc.get("lastLogin")),
        }

    @staticmethod
    def account_admin_view(acc):
        """后台视图：内部字段可以有，但**永远不含密码哈希**。"""
        return {
            "id": acc.get("id") or "",
            "name": acc.get("name") or "",
            "displayName": acc.get("displayName") or "",
            "avatar": acc.get("avatar") or "",
            "status": acc.get("status") or "active",
            "created": acc.get("created") or 0,
            "lastLogin": acc.get("lastLogin") or 0,
            "lastIP": acc.get("lastIP") or "",
            "note": acc.get("note") or "",
            "tokenVer": int(acc.get("tokenVer", 1)),
            "hasPwd": bool(acc.get("pwd")),
        }

    def list_accounts(self):
        with self.lock:
            rows = [self.account_admin_view(a) for a in self.accounts.values()]
            rows.sort(key=lambda r: float(r.get("created") or 0), reverse=True)
            return rows

    # ---- 登录失败计数（防爆破）----
    # 双维度：按用户名 + 按来源 IP。不存在的用户名同样计数，
    # 否则「被锁了」这件事本身就成了账号枚举的信号。

    def guard_check(self, name, ip):
        """返回 (是否被锁, 还需等待秒数)。"""
        now = now_ts()
        key = (name or "").strip().lower()
        with self.lock:
            for slot, k in (("name", key), ("ip", ip or "")):
                rec = (self.guard.get(slot) or {}).get(k) or {}
                until = float(rec.get("until") or 0)
                if until > now:
                    return True, int(until - now) + 1
        return False, 0

    def guard_fail(self, name, ip):
        now = now_ts()
        key = (name or "").strip().lower()
        with self.lock:
            by_name = self.guard.setdefault("name", {})
            rec = by_name.get(key) or {}
            if now - float(rec.get("first") or 0) > FAIL_WINDOW_SEC:
                rec = {"fails": 0, "first": now, "strikes": rec.get("strikes", 0),
                       "lastLock": rec.get("lastLock", 0)}
            rec["fails"] = int(rec.get("fails", 0)) + 1
            rec.setdefault("first", now)
            if rec["fails"] >= LOGIN_MAX_FAIL:
                strikes = int(rec.get("strikes", 0))
                # 24 小时没再犯就重置升级计数，避免偶尔手误被永久放大
                if now - float(rec.get("lastLock") or 0) > 86400:
                    strikes = 0
                strikes += 1
                lock = min(LOGIN_LOCK_SEC * (2 ** (strikes - 1)), 3600)
                rec.update({"fails": 0, "first": now, "strikes": strikes,
                            "lastLock": now, "until": now + lock})
                log("登录失败次数过多，锁定用户名 %s 共 %d 秒（第 %d 次）"
                    % (key, lock, strikes))
            by_name[key] = rec

            by_ip = self.guard.setdefault("ip", {})
            irec = by_ip.get(ip or "") or {}
            if now - float(irec.get("first") or 0) > FAIL_WINDOW_SEC:
                irec = {"fails": 0, "first": now}
            irec["fails"] = int(irec.get("fails", 0)) + 1
            irec.setdefault("first", now)
            if irec["fails"] >= IP_MAX_FAIL:
                irec.update({"fails": 0, "first": now, "until": now + LOGIN_LOCK_SEC})
                log("登录失败次数过多，锁定来源 IP %s 共 %d 秒" % (ip or "?", LOGIN_LOCK_SEC))
            by_ip[ip or ""] = irec
            self._save("auth_guard.json", self.guard)

    def guard_reset(self, name):
        key = (name or "").strip().lower()
        with self.lock:
            by_name = self.guard.get("name") or {}
            if key in by_name:
                by_name.pop(key, None)
                self._save("auth_guard.json", self.guard)

    # ---- 头像文件 ----
    def avatar_dir(self):
        path = os.path.join(self.dir, "avatars")
        if not os.path.isdir(path):
            try:
                os.makedirs(path)
            except Exception:
                pass
        return path

    def avatar_save(self, uid, data, ext):
        """文件名由服务端生成（uid 是 UUID，天然无路径穿越）。"""
        name = "%s.%s" % (uid, ext)
        path = os.path.join(self.avatar_dir(), name)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        return name

    def avatar_path(self, filename):
        """只接受 <uuid>.<png|jpg|jpeg|webp>，其它一律 None（防路径穿越）。"""
        if not AVATAR_FILE_RE.match(filename or ""):
            return None
        path = os.path.join(self.avatar_dir(), filename)
        return path if os.path.isfile(path) else None

    # ---- 会员 ----
    def member_until(self, user_id):
        m = self.members.get(user_id) or {}
        try:
            return float(m.get("until") or 0)
        except Exception:
            return 0.0

    def is_member(self, user_id):
        return self.member_until(user_id) > now_ts()

    def add_membership(self, user_id, username, days):
        with self.lock:
            base = max(self.member_until(user_id), now_ts())
            until = base + days * 86400.0
            self.members[user_id] = {
                "until": until,
                "name": username or (self.users.get(user_id) or {}).get("name") or "",
                "updated": now_ts(),
            }
            self._save("members.json", self.members)
            return until

    # ---- 免费不限量（管理员在 /admin 里按账号开通） ----
    def is_free(self, user_id):
        f = self.free.get(user_id) or {}
        return bool(f.get("on"))

    def set_free(self, user_id, username, on):
        """开通/取消某个账号的「免费不限量」。返回当前状态。"""
        with self.lock:
            if on:
                self.free[user_id] = {
                    "on": True,
                    "name": username or (self.users.get(user_id) or {}).get("name") or "",
                    "updated": now_ts(),
                }
            else:
                self.free.pop(user_id, None)
            self._save("free.json", self.free)
            return self.is_free(user_id)

    # ---- 用量 ----
    def _usage_of(self, user_id):
        u = self.usage.get(user_id) or {}
        if u.get("day") != today_str():
            u = {
                "day": today_str(),
                "free": 0,
                "member": 0,
                "unlimited": 0,
                "total": u.get("total", 0),
            }
        return u

    def quota_view(self, user_id):
        with self.lock:
            u = self._usage_of(user_id)
            member = self.is_member(user_id)
            free = self.is_free(user_id)
            until = self.member_until(user_id)
            if free:
                # 管理员开通的「免费不限量」：不设每日上限（仍受 2 秒最小间隔限制）
                remaining = -1
            elif member:
                remaining = max(0, MEMBER_DAILY_CAP - int(u.get("member", 0)))
            else:
                remaining = max(0, FREE_DAILY_QUOTA - int(u.get("free", 0)))
            return {
                "member": member,
                "memberUntil": int(until) if until else 0,
                "free": free,
                "plan": "unlimited" if (member or free) else "free",
                "freeQuota": FREE_DAILY_QUOTA,
                "freeUsedToday": int(u.get("free", 0)),
                "memberCap": MEMBER_DAILY_CAP,
                "memberUsedToday": int(u.get("member", 0)),
                "unlimitedUsedToday": int(u.get("unlimited", 0)),
                "remainingToday": remaining,
                "totalCalls": int(u.get("total", 0)),
                "day": u.get("day"),
            }

    def consume(self, user_id):
        """计次；额度不足时抛 QuotaError。返回计次后的额度视图。"""
        with self.lock:
            u = self._usage_of(user_id)
            if self.is_free(user_id):
                u["unlimited"] = int(u.get("unlimited", 0)) + 1
            elif self.is_member(user_id):
                if int(u.get("member", 0)) >= MEMBER_DAILY_CAP:
                    raise QuotaError(
                        "member_cap",
                        "今日 AI 使用量已达防滥用上限（%d 次），请联系客服处理"
                        % MEMBER_DAILY_CAP,
                    )
                u["member"] = int(u.get("member", 0)) + 1
            else:
                if int(u.get("free", 0)) >= FREE_DAILY_QUOTA:
                    raise QuotaError(
                        "free_exhausted",
                        "今日免费额度已用完（每天 %d 次），开通会员即可不限量使用"
                        % FREE_DAILY_QUOTA,
                    )
                u["free"] = int(u.get("free", 0)) + 1
            u["total"] = int(u.get("total", 0)) + 1
            self.usage[user_id] = u
            self._save("usage.json", self.usage)
            self._stats_bump("calls", 1)
            return self.quota_view(user_id)

    def refund(self, user_id):
        """上游 AI 调用失败时把刚扣掉的一次退回（避免服务端故障白扣用户额度）。"""
        with self.lock:
            u = self._usage_of(user_id)
            if self.is_free(user_id):
                u["unlimited"] = max(0, int(u.get("unlimited", 0)) - 1)
            elif self.is_member(user_id):
                u["member"] = max(0, int(u.get("member", 0)) - 1)
            else:
                u["free"] = max(0, int(u.get("free", 0)) - 1)
            u["total"] = max(0, int(u.get("total", 0)) - 1)
            self.usage[user_id] = u
            self._save("usage.json", self.usage)
            self._stats_bump("calls", -1)
            return self.quota_view(user_id)

    def rate_limited(self, user_id):
        with self.lock:
            last = self.last_call.get(user_id, 0)
            if now_ts() - last < RATE_LIMIT_SEC:
                return True
            self.last_call[user_id] = now_ts()
            return False

    # ---- 管理员：重置用量 / 用户总览 ----
    def reset_usage(self, user_id, zero_total=False):
        """把某个账号的「今日用量」清零；zero_total=True 时连累计调用数一起清零。"""
        with self.lock:
            u = self._usage_of(user_id)
            u["free"] = 0
            u["member"] = 0
            u["unlimited"] = 0
            u["day"] = today_str()
            if zero_total:
                u["total"] = 0
            self.usage[user_id] = u
            self._save("usage.json", self.usage)
            self.last_call.pop(user_id, None)  # 顺手清掉限流计时，方便立刻重试
            return self.quota_view(user_id)

    def reset_all_usage(self, zero_total=False):
        """把所有账号的今日用量清零，返回影响人数。"""
        with self.lock:
            for uid in list(self.users.keys()) + list(self.usage.keys()):
                u = self._usage_of(uid)
                u["free"] = 0
                u["member"] = 0
                u["unlimited"] = 0
                u["day"] = today_str()
                if zero_total:
                    u["total"] = 0
                self.usage[uid] = u
            self._save("usage.json", self.usage)
            self.last_call.clear()
            return len(self.usage)

    def list_users(self):
        """所有登录过软件的账号 + 会员/免费/今日用量，供后台表格展示。
        4.1.0：账号表（accounts.json）里的账号即使用没登录过也要出现。"""
        with self.lock:
            ids = set(self.users.keys()) | set(self.usage.keys()) | set(self.members.keys()) \
                | set(self.free.keys()) | set(self.accounts.keys())
            rows = []
            for uid in ids:
                u = self.users.get(uid) or {}
                acc = self.accounts.get(uid) or {}
                usage = self._usage_of(uid)
                member = self.is_member(uid)
                free = self.is_free(uid)
                if free:
                    remaining = -1
                elif member:
                    remaining = max(0, MEMBER_DAILY_CAP - int(usage.get("member", 0)))
                else:
                    remaining = max(0, FREE_DAILY_QUOTA - int(usage.get("free", 0)))
                rows.append({
                    "userId": uid,
                    "username": u.get("name") or acc.get("name")
                    or (self.free.get(uid) or {}).get("name") or "",
                    "first": u.get("first") or acc.get("created") or 0,
                    "last": u.get("last") or acc.get("lastLogin") or 0,
                    "member": member,
                    "memberUntil": int(self.member_until(uid)) if member else 0,
                    "free": free,
                    "freeUpdated": int((self.free.get(uid) or {}).get("updated") or 0),
                    "day": usage.get("day"),
                    "freeUsedToday": int(usage.get("free", 0)),
                    "memberUsedToday": int(usage.get("member", 0)),
                    "unlimitedUsedToday": int(usage.get("unlimited", 0)),
                    "remainingToday": remaining,
                    "totalCalls": int(usage.get("total", 0)),
                    # ---- 4.1.0 账号字段 ----
                    "account": bool(acc),
                    "hasPwd": bool(acc.get("pwd")),
                    "status": acc.get("status") or ("" if not acc else "active"),
                    "displayName": acc.get("displayName") or "",
                    "created": acc.get("created") or 0,
                    "lastLogin": acc.get("lastLogin") or 0,
                    "lastIP": acc.get("lastIP") or "",
                    "note": acc.get("note") or "",
                    "tokenVer": int(acc.get("tokenVer") or 0),
                })
            # 最近登录的排前面
            rows.sort(key=lambda r: float(r.get("last") or r.get("created") or 0),
                      reverse=True)
            return rows

    # ================= 4.1.2 后台：实时快照 / 每日统计 / 审计日志 =================

    def _stats_bump(self, key, n=1, force=False):
        """按天累计运营统计（概览页的趋势图靠它）。
        默认最多每 3 秒写一次盘：一次 AI 调用已经写了 usage.json，
        再为统计多写一次盘不值得；订单/收入/新账号这类低频但要紧的事件走 force。"""
        with self.lock:
            days = self.stats.setdefault("days", {})
            day = today_str()
            row = days.get(day)
            if not isinstance(row, dict):
                row = {}
            row[key] = row.get(key, 0) + n
            days[day] = row
            self.stats["updated"] = now_ts()
            if len(days) > 200:                      # 只留最近 200 天，别让文件无限长
                for old in sorted(days.keys())[:-200]:
                    days.pop(old, None)
            if force or (now_ts() - float(self._stats_flushed or 0)) >= 3:
                self._stats_flushed = now_ts()
                self._save("stats.json", self.stats)

    def stats_series(self, days=14):
        """最近 N 天（含今天，从旧到新）；今天的数字用实时用量覆盖统计文件。"""
        with self.lock:
            hist = self.stats.get("days") or {}
            today = today_str()
            out = []
            today_row = {
                "calls": 0,
                "logins": 0,
                "orders": 0,
                "paidOrders": 0,
                "revenue": 0.0,
                "newAccounts": 0,
            }
            for uid in set(self.usage.keys()) | set(self.users.keys()):
                u = self._usage_of(uid)
                today_row["calls"] += (int(u.get("free", 0)) + int(u.get("member", 0))
                                       + int(u.get("unlimited", 0)))
            for acc in self.accounts.values():
                if is_today(acc.get("lastLogin")):
                    today_row["logins"] += 1
            for o in self.orders.values():
                if is_today(o.get("created")):
                    today_row["orders"] += 1
                if is_today(o.get("paidAt")):
                    today_row["paidOrders"] += 1
                    today_row["revenue"] += float(o.get("amount") or 0)
            for acc in self.accounts.values():
                if is_today(acc.get("created")):
                    today_row["newAccounts"] += 1
            base = datetime.now(CST).date()
            for i in range(days - 1, -1, -1):
                d = (base - timedelta(days=i)).strftime("%Y-%m-%d")
                if d == today:
                    row = today_row
                else:
                    row = hist.get(d) or {}
                out.append({
                    "day": d,
                    "calls": int(row.get("calls", 0)),
                    "logins": int(row.get("logins", 0)),
                    "orders": int(row.get("orders", 0)),
                    "paidOrders": int(row.get("paidOrders", 0)),
                    "revenue": round(float(row.get("revenue", 0) or 0), 2),
                    "newAccounts": int(row.get("newAccounts", 0)),
                })
            return out

    def admin_kpi(self):
        """概览页要的所有聚合数字。"""
        with self.lock:
            rows = self.list_users()
            orders = list(self.orders.values())
            paid = [o for o in orders if o.get("status") == "paid"]
            pending = [o for o in orders if o.get("status") in ("pending", "claimed")]
            today = today_str()
            hist = (self.stats.get("days") or {}).get(today) or {}
            return {
                "accounts": len(self.accounts),
                "disabled": len([r for r in rows if r.get("status") == "disabled"]),
                "members": len([r for r in rows if r.get("member")]),
                "free": len([r for r in rows if r.get("free")]),
                "freeOnly": len([r for r in rows if not r.get("member") and not r.get("free")
                                 and r.get("status") != "disabled"]),
                "activeToday": len([r for r in rows if is_today(r.get("lastLogin") or r.get("last"))]),
                "newToday": len([r for r in rows if is_today(r.get("created"))]),
                "callsToday": sum(int(r.get("freeUsedToday", 0)) + int(r.get("memberUsedToday", 0))
                                  + int(r.get("unlimitedUsedToday", 0)) for r in rows),
                "callsTotal": sum(int(r.get("totalCalls", 0)) for r in rows),
                "pendingOrders": len(pending),
                "paidOrders": len(paid),
                "revenueToday": round(sum(float(o.get("amount") or 0) for o in paid
                                          if is_today(o.get("paidAt"))), 2),
                "revenueTotal": round(sum(float(o.get("amount") or 0) for o in paid), 2),
                "revenueMonth": round(sum(float(o.get("amount") or 0) for o in paid
                                          if datetime.fromtimestamp(
                                              float(o.get("paidAt") or 0), CST).strftime("%Y-%m")
                                          == datetime.now(CST).strftime("%Y-%m")), 2),
                "loginsToday": int(hist.get("logins", 0)),
                "rev": int(self.rev),
                "day": today,
            }

    def admin_top_users(self, limit=8):
        rows = [r for r in self.list_users() if int(r.get("totalCalls", 0)) > 0]
        rows.sort(key=lambda r: int(r.get("totalCalls", 0)), reverse=True)
        return [{"username": r.get("username") or "(未命名)",
                 "userId": r.get("userId"),
                 "totalCalls": int(r.get("totalCalls", 0)),
                 "callsToday": int(r.get("freeUsedToday", 0)) + int(r.get("memberUsedToday", 0))
                               + int(r.get("unlimitedUsedToday", 0)),
                 "member": bool(r.get("member")),
                 "free": bool(r.get("free")),
                 "status": r.get("status") or ""} for r in rows[:limit]]

    def admin_poll(self):
        """轻量实时快照：后台每 2 秒拉一次，只回几百字节。"""
        with self.lock:
            calls = 0
            for uid in set(self.usage.keys()) | set(self.users.keys()):
                u = self._usage_of(uid)
                calls += (int(u.get("free", 0)) + int(u.get("member", 0))
                          + int(u.get("unlimited", 0)))
            pending = 0
            revenue_today = 0.0
            for o in self.orders.values():
                if o.get("status") in ("pending", "claimed"):
                    pending += 1
                if o.get("status") == "paid" and is_today(o.get("paidAt")):
                    revenue_today += float(o.get("amount") or 0)
            locked = 0
            for slot in ("name", "ip"):
                for rec in (self.guard.get(slot) or {}).values():
                    if float(rec.get("until") or 0) > now_ts():
                        locked += 1
            active = 0
            for acc in self.accounts.values():
                if is_today(acc.get("lastLogin")):
                    active += 1
            return {
                "rev": int(self.rev),
                "ts": now_ts(),
                "day": today_str(),
                "accounts": len(self.accounts),
                "activeToday": active,
                "pendingOrders": pending,
                "callsToday": calls,
                "revenueToday": round(revenue_today, 2),
                "locked": locked,
            }

    def audit(self, action, target="", detail="", ip="", ok=True):
        """管理员操作留痕（新的在前，只留最近 500 条）。"""
        with self.lock:
            self.admin_log.insert(0, {
                "t": now_ts(),
                "action": action,
                "target": target,
                "detail": detail,
                "ip": ip or "",
                "ok": bool(ok),
            })
            del self.admin_log[500:]
            self._save("admin_log.json", {"items": self.admin_log, "updated": now_ts()})

    def admin_fail(self, ip):
        """管理员密钥校验失败：只进内存，避免被人拿错误密钥刷成磁盘炸弹。"""
        with self.lock:
            self.admin_fails.insert(0, {"t": now_ts(), "ip": ip or ""})
            del self.admin_fails[50:]

    def admin_security(self):
        with self.lock:
            now = now_ts()
            out = {"name": [], "ip": []}
            for slot in ("name", "ip"):
                for key, rec in (self.guard.get(slot) or {}).items():
                    until = float(rec.get("until") or 0)
                    out[slot].append({
                        "key": key,
                        "fails": int(rec.get("fails", 0)),
                        "strikes": int(rec.get("strikes", 0)),
                        "until": int(until),
                        "locked": until > now,
                        "waitSec": int(max(0, until - now)),
                        "lastLock": int(rec.get("lastLock") or 0),
                    })
                out[slot].sort(key=lambda r: (-int(r["locked"]), -float(r["until"])))
            return {
                "guard": out,
                "adminFails": list(self.admin_fails),
                "policy": {
                    "maxFail": LOGIN_MAX_FAIL,
                    "lockSec": LOGIN_LOCK_SEC,
                    "ipMaxFail": IP_MAX_FAIL,
                    "windowSec": FAIL_WINDOW_SEC,
                },
            }

    # ---- 订单 ----
    def create_order(self, user_id, username, plan_key):
        plan = PLANS[plan_key]
        with self.lock:
            # 10 分钟内同一个用户同套餐的未付款订单直接复用，避免刷单
            for o in self.orders.values():
                if (
                    o.get("userId") == user_id
                    and o.get("plan") == plan_key
                    and o.get("status") == "pending"
                    and now_ts() - float(o.get("created") or 0) < 600
                ):
                    return o
            # 超过 10 分钟的旧 pending 订单标记为 canceled，
            # 避免管理员在后台看到同一用户同套餐的两笔待确认订单（可能重复收款）
            for k, o in list(self.orders.items()):
                if (
                    o.get("userId") == user_id
                    and o.get("plan") == plan_key
                    and o.get("status") == "pending"
                ):
                    o["status"] = "canceled"
                    o["canceledAt"] = now_ts()
                    self.orders[k] = o
            order_id = (
                datetime.now(CST).strftime("%Y%m%d%H%M%S")
                + "-"
                + secrets.token_hex(2).upper()
            )
            order = {
                "id": order_id,
                "userId": user_id,
                "name": username,
                "plan": plan_key,
                "planName": plan["name"],
                "days": plan["days"],
                "amount": plan["amount"],
                "status": "pending",     # pending -> claimed -> paid / canceled
                "created": now_ts(),
                "claimedAt": 0,
                "paidAt": 0,
            }
            self.orders[order_id] = order
            self._save("orders.json", self.orders)
            self._stats_bump("orders", 1, force=True)
            return order

    def get_order(self, order_id):
        return self.orders.get(order_id)

    def claim_order(self, order_id, user_id):
        with self.lock:
            o = self.orders.get(order_id)
            if not o or o.get("userId") != user_id:
                return None
            if o.get("status") == "pending":
                o["status"] = "claimed"
                o["claimedAt"] = now_ts()
                self.orders[order_id] = o
                self._save("orders.json", self.orders)
            return o

    def confirm_order(self, order_id):
        """管理员确认收款：标记 paid 并把会员天数加到该用户身上。"""
        with self.lock:
            o = self.orders.get(order_id)
            if not o:
                return None, "订单不存在"
            if o.get("status") == "paid":
                return o, None
            uid = o.get("userId")
            until = self.add_membership(uid, o.get("name"), int(o.get("days") or 1))
            o["status"] = "paid"
            o["paidAt"] = now_ts()
            o["memberUntil"] = until
            self.orders[order_id] = o
            self._save("orders.json", self.orders)
            self._stats_bump("paidOrders", 1, force=True)
            self._stats_bump("revenue", float(o.get("amount") or 0), force=True)
            return o, None

    def reject_order(self, order_id, reason=""):
        """管理员打回订单：没收到钱 / 用户说付了但账上没到 → 作废，不加会员、不计收入。

        为什么需要它：用户点了「我已完成支付」之后，订单会停在 claimed 等管理员确认；
        如果管理员查了收款记录发现没收到，此前只能干放着（后台一直显示「待处理」），
        用户那边也会一直等。打回后订单变 canceled，用户可以重新下单。

        状态机：pending / claimed --(打回)--> canceled；已 paid 的不允许打回
        （会员天数已经加上去了，要退得走「手工调整会员」那条路，避免一键把会员抹掉）。
        """
        with self.lock:
            o = self.orders.get(order_id)
            if not o:
                return None, "订单不存在", None
            st = o.get("status")
            if st == "paid":
                return o, "该订单已开通会员，不能打回；如需退款请手工调整会员天数", 400
            if st == "canceled":
                return o, None, None          # 幂等：重复打回不报错、不覆盖原原因
            o["status"] = "canceled"
            o["canceledAt"] = now_ts()
            o["cancelReason"] = (reason or "").strip()[:200]
            o["canceledBy"] = "admin"
            self.orders[order_id] = o
            self._save("orders.json", self.orders)
            return o, None, None

    def list_orders(self, status=None):
        items = list(self.orders.values())
        if status:
            items = [o for o in items if o.get("status") == status]
        items.sort(key=lambda o: float(o.get("created") or 0), reverse=True)
        return items

    def latest_order(self, user_id):
        """某用户最近的一笔订单。
        客户端重开「开通会员」弹窗时用它恢复状态：
        已经点过「我已完成支付」的订单要接着等确认，而不是又下一单（避免重复付款）。"""
        mine = [o for o in self.orders.values() if o.get("userId") == user_id]
        if not mine:
            return None
        mine.sort(key=lambda o: float(o.get("created") or 0), reverse=True)
        return mine[0]


class QuotaError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


class AuthError(Exception):
    def __init__(self, message):
        Exception.__init__(self, message)
        self.message = message


# ============================== 身份校验 ==============================

CASDOOR_OPENER = urllib.request.build_opener()


def resolve_user_builtin(store, token):
    """4.1.0 builtin 模式：本地校验自签令牌（不联网、不依赖 Casdoor）。"""
    data = verify_jwt(token, store.jwt_secret)
    if not data:
        raise AuthError("登录状态已失效，请重新登录")
    uid = str(data.get("id") or "")
    if not uid:
        raise AuthError("登录状态已失效，请重新登录")
    _, acc = store.account_by_id(uid)
    if not acc:
        raise AuthError("登录状态已失效，请重新登录")
    if (acc.get("status") or "active") != "active":
        raise AuthError("该账号已被停用，请联系客服")
    # 改密 / 停用 / 踢下线都会把 tokenVer +1，旧令牌在这里被拦下
    if int(data.get("ver") or 0) != int(acc.get("tokenVer") or 0):
        raise AuthError("登录状态已失效，请重新登录")
    name = acc.get("name") or str(data.get("name") or "")
    store.touch_user(uid, name)
    return uid, name


def resolve_user(store, token):
    """拿访问令牌换用户身份。
    casdoor 模式：向 Casdoor /api/get-account 校验（带 5 分钟缓存，4.0.3 行为）；
    builtin 模式：本地校验自签 HS256 令牌。"""
    if AUTH_MODE == "builtin":
        if not token:
            raise AuthError("缺少登录凭证，请先登录")
        return resolve_user_builtin(store, token)
    if not token:
        raise AuthError("缺少登录凭证，请先登录")
    with store.lock:
        cached = store.token_cache.get(token)
        if cached and cached[2] > now_ts():
            return cached[0], cached[1]
    req = urllib.request.Request(
        CASDOOR_URL + "/api/get-account",
        headers={"Authorization": "Bearer " + token},
    )
    try:
        with CASDOOR_OPENER.open(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise AuthError("登录状态已失效，请重新登录")
    except Exception:
        raise AuthError("无法连接账号服务器，请稍后重试")
    if data.get("status") != "ok" or not isinstance(data.get("data"), dict):
        raise AuthError("登录状态已失效，请重新登录")
    rec = data["data"]
    uid = str(rec.get("id") or rec.get("name") or "")
    name = rec.get("name") or rec.get("displayName") or uid
    if not uid:
        raise AuthError("登录状态已失效，请重新登录")
    with store.lock:
        store.token_cache[token] = (uid, name, now_ts() + TOKEN_CACHE_SEC)
    store.touch_user(uid, name)
    return uid, name


# ============================== 管理员后台页面 ==============================
# 打开 http://<服务器>:2581/admin 即可用手机/电脑确认收款开通会员，
# 不必每次都 SSH 跑 admin_cli.py（命令行方式仍然保留）。
# 页面本身不含密钥，密钥由使用者填一次、存在他自己的浏览器里，
# 每次请求通过 X-Admin-Key 发给本服务校验。

ADMIN_PAGE = r"""<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>轻提词 · AI 服务后台</title>
<!--
  轻提词管理后台（4.1.7：与客户端同源的简洁配色 / 桌面优先 / 2 秒实时）
  ------------------------------------------------------------------
  · 这个文件是「源文件」，由 sync_admin_page.py 注入 ai_server.py 的 ADMIN_PAGE 常量，
    服务端运行时**不读盘**（单文件部署，不依赖相对路径），改完必须跑一次：
        python3 sync_admin_page.py          # 注入
        python3 sync_admin_page.py --check  # 只检查有没有不同步（回归测试用）
  · 配色规则（4.1.4 起）：与桌面客户端 src/styles.css 同一套 —— 只用一种强调色
    靛蓝 #6366f1（--brand），其余全靠 slate 灰阶 + 1px 描边分层；
    禁止渐变 / 彩色大色块 / 装饰性插画，圆角 12~16px，阴影柔和。
  · 类名规则（4.1.5 起）：左侧栏占用了 `.side`，内容区**不要**再用 side 当修饰类
    （`.grid.side` 会命中 .side 的 width:236px / height:100vh / position:sticky，
    把概览页两张卡片挤成窄条）；两栏栅格用 `.grid.split`。
  · 网络规则（4.1.7 起）：**读接口**（need()）在网络层失败时自动重试一次，
    写接口（api()）绝不重试；失败时页面必须给出可读的提示，不允许留空白块。
    背景：本服务是 HTTP/1.0 短连接，经过本机代理时响应偶发被截断
    （net::ERR_CONTENT_LENGTH_MISMATCH），不重试的话概览页会整块空白。
  · 纯离线：不引用任何 CDN / 外部字体 / 图表库，图表是手写 SVG（按主题取色）。
  · 密钥只存在使用者自己的浏览器 localStorage，每次请求走 X-Admin-Key 头。
  · 为了回归测试（tests/admin_panel_smoke.mjs）能点得动，保留了这些钩子：
      id: key / save / clear / out / users / nname / npwd / ncreate / uresetall
      data-*: data-confirm / data-reject / data-reset / data-zero / data-free / data-name /
              data-pwd / data-kick / data-status / data-note
-->
<style>
  /* 配色与桌面客户端（src/styles.css）保持同一套：靛蓝品牌色 + slate 中性底。
     原则：只用一种强调色（靛蓝），其余靠灰阶与 1px 描边分层，不要渐变/彩色块。 */
  :root {
    --bg:#f8fafc; --bg2:#f1f5f9; --card:#ffffff;
    --text:#1f2937; --muted:#6b7280; --aux:#9ca3af;
    --line:#e2e8f0; --line-soft:#eef2f7;
    --brand:#6366f1; --brand-strong:#4f46e5; --brand-tint:#eef2ff; --brand-press:#e0e7ff;
    --shadow:0 1px 2px rgba(15,23,42,.04), 0 10px 25px -5px rgba(99,102,241,.12);
    --shadow-sm:0 1px 2px rgba(15,23,42,.05);
    --accent:var(--brand); --ok:#10b981; --warn:#b45309; --danger:#ef4444;
    --tint-blue:#eef2ff; --tint-green:#ecfdf5; --tint-amber:#fffbeb; --tint-red:#fef2f2; --tint-violet:#f5f3ff;
    --radius:16px; --radius-sm:12px;
  }
  html[data-theme="dark"] {
    --bg:#0f172a; --bg2:#1e293b; --card:#111827;
    --text:#e5e7eb; --muted:#94a3b8; --aux:#64748b;
    --line:#334155; --line-soft:#1f2937;
    --brand:#818cf8; --brand-strong:#6366f1; --brand-tint:#1e1b4b; --brand-press:#312e81;
    --shadow:0 1px 2px rgba(0,0,0,.4), 0 10px 25px -5px rgba(0,0,0,.5);
    --shadow-sm:0 1px 2px rgba(0,0,0,.35);
    --ok:#34d399; --warn:#fbbf24; --danger:#f87171;
    --tint-blue:#1e1b4b; --tint-green:#052e21; --tint-amber:#2b2110; --tint-red:#2c1516; --tint-violet:#221a33;
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:14px/1.6 "Microsoft YaHei", "微软雅黑", "PingFang SC", "Segoe UI",
         -apple-system, BlinkMacSystemFont, Inter, Roboto, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  button, input, select, textarea { font:inherit; color:inherit; }
  a { color:var(--accent); }
  code { background:var(--bg2); padding:1px 5px; border-radius:6px; font-size:12px; }
  .muted { color:var(--muted); }
  .mono { font-family:ui-monospace, Consolas, "SF Mono", Menlo, monospace; font-size:12px; }
  .sr { position:absolute; left:-9999px; top:0; width:1px; height:1px; overflow:hidden; }

  /* 骨架。注意：左侧栏的类名就叫 .side，所以内容区的栅格**不能**再用 side 当修饰类
     （4.1.2 的 `.grid.side` 会同时命中 .side 的 width:236px / height:100vh / position:sticky，
     结果概览页的趋势图和额度分布被挤成 236px 宽的窄条；4.1.5 改名为 .grid.split）。 */
  .app { display:flex; min-height:100vh; }
  .side {
    width:236px; flex:0 0 236px; background:var(--card); border-right:1px solid var(--line-soft);
    padding:18px 12px; display:flex; flex-direction:column; gap:14px; position:sticky; top:0; height:100vh;
  }
  .brand { display:flex; align-items:center; gap:10px; padding:4px 8px 10px; }
  .brand .logo {
    width:34px; height:34px; border-radius:11px; background:var(--brand); flex:0 0 34px;
    display:flex; align-items:center; justify-content:center; color:#fff; font-weight:700; font-size:15px;
  }
  .brand b { display:block; font-size:15px; letter-spacing:-.01em; }
  .brand small { color:var(--muted); font-size:11px; letter-spacing:.02em; }
  nav { display:flex; flex-direction:column; gap:2px; }
  .nav-item {
    display:flex; align-items:center; gap:10px; width:100%; text-align:left;
    padding:9px 10px; border:0; border-radius:var(--radius-sm); background:transparent;
    cursor:pointer; color:var(--text); font-size:13.5px; position:relative;
  }
  .nav-item:hover { background:var(--brand-tint); color:var(--brand-strong); }
  .nav-item.active { background:var(--brand-tint); color:var(--brand-strong); font-weight:600; }
  .nav-item.active::before {
    content:""; position:absolute; left:-12px; top:8px; bottom:8px; width:3px; border-radius:0 3px 3px 0;
    background:var(--brand);
  }
  .nav-item .ico { width:18px; text-align:center; font-size:14px; opacity:.85; }
  .nav-item .grow { flex:1; }
  .pill {
    display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:19px;
    padding:0 6px; border-radius:999px; font-size:11px; background:var(--bg2); color:var(--muted);
  }
  .pill.hot { background:var(--tint-amber); color:var(--warn); font-weight:600; }
  .pill.live { background:var(--tint-green); color:var(--ok); }
  .side-foot { margin-top:auto; display:flex; flex-direction:column; gap:8px; padding:0 6px 4px; }
  .side-foot .row2 { display:flex; align-items:center; gap:8px; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--aux); flex:0 0 8px; }
  .dot.on { background:var(--ok); box-shadow:0 0 0 4px color-mix(in srgb, var(--ok) 16%, transparent); animation:pulse 2s infinite; }
  .dot.warn { background:var(--warn); box-shadow:0 0 0 4px color-mix(in srgb, var(--warn) 16%, transparent); }
  @keyframes pulse { 50% { opacity:.45; } }

  main { flex:1; min-width:0; display:flex; flex-direction:column; }
  .topbar {
    position:sticky; top:0; z-index:20; background:var(--bg);
    background:color-mix(in srgb, var(--bg) 88%, transparent);
    backdrop-filter:saturate(160%) blur(12px);
    border-bottom:1px solid var(--line-soft); padding:14px 26px;
    display:flex; align-items:center; gap:14px;
  }
  .topbar h1 { font-size:19px; margin:0; letter-spacing:-.02em; }
  .topbar .sub { color:var(--muted); font-size:12px; }
  .topbar-right { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .content { padding:22px 26px 60px; max-width:1320px; width:100%; }
  .page { display:none; }
  .page.active { display:block; animation:fade .18s ease; }
  @keyframes fade { from { opacity:0; transform:translateY(4px); } }

  /* ---------------- 控件（与客户端 .btn / .form-input 同款：白底细描边 + 靛蓝主色） ---------------- */
  .btn {
    height:34px; padding:0 14px; border-radius:var(--radius-sm); border:1px solid var(--line);
    background:var(--card); cursor:pointer; font-size:13px; display:inline-flex; align-items:center;
    gap:6px; white-space:nowrap; color:var(--text); box-shadow:var(--shadow-sm);
    transition:background .18s, border-color .18s, box-shadow .18s, transform .1s;
  }
  .btn:hover { background:var(--brand-tint); border-color:color-mix(in srgb, var(--brand) 32%, var(--line));
               color:var(--brand-strong); }
  .btn:active { transform:scale(.985); }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .btn.primary { background:var(--brand); border-color:var(--brand); color:#fff; font-weight:600;
                 box-shadow:0 6px 16px -8px rgba(99,102,241,.65); }
  .btn.primary:hover { background:var(--brand-strong); border-color:var(--brand-strong); color:#fff; }
  .btn.dark { background:var(--text); border-color:var(--text); color:var(--card); }
  .btn.danger { background:var(--danger); border-color:var(--danger); color:#fff; font-weight:600;
                box-shadow:0 6px 16px -8px rgba(239,68,68,.55); }
  .btn.danger:hover { background:#dc2626; border-color:#dc2626; color:#fff; }
  .btn.sm { height:28px; padding:0 10px; font-size:12px; border-radius:10px; }
  .btn.icon { width:34px; padding:0; justify-content:center; }
  input[type=text], input[type=password], input[type=number], select, textarea {
    height:36px; padding:0 12px; border:1px solid var(--line); border-radius:10px;
    background:var(--bg); outline:none; min-width:0; color:var(--text);
  }
  textarea { height:auto; padding:9px 12px; resize:vertical; }
  input:focus, select:focus, textarea:focus {
    border-color:var(--brand); background:var(--card);
    box-shadow:0 0 0 3px color-mix(in srgb, var(--brand) 16%, transparent);
  }
  input[type=checkbox] { width:15px; height:15px; accent-color:var(--brand); cursor:pointer; }
  label.lbl { font-size:12px; color:var(--muted); display:block; margin-bottom:5px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip {
    height:30px; padding:0 12px; border-radius:999px; border:1px solid var(--line);
    background:var(--card); cursor:pointer; font-size:12.5px; color:var(--muted);
  }
  .chip:hover { background:var(--brand-tint); color:var(--brand-strong); }
  .chip.on { background:var(--brand-tint); color:var(--brand-strong); border-color:var(--brand); font-weight:600; }

  /* ---------------- 卡片 ---------------- */
  .card {
    background:var(--card); border:1px solid var(--line-soft); border-radius:var(--radius);
    box-shadow:var(--shadow); padding:18px; margin-bottom:16px;
  }
  .card-hd { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .card-hd h2 { font-size:14.5px; margin:0; letter-spacing:-.01em; }
  .card-hd .right { margin-left:auto; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .grid { display:grid; gap:16px; }
  .grid.k4 { grid-template-columns:repeat(4, minmax(0,1fr)); }
  .grid.k3 { grid-template-columns:repeat(3, minmax(0,1fr)); }
  .grid.k2 { grid-template-columns:repeat(2, minmax(0,1fr)); }
  .grid.split { grid-template-columns:minmax(0,1.55fr) minmax(0,1fr); }
  @media (max-width:1180px) { .grid.k4 { grid-template-columns:repeat(2,minmax(0,1fr)); } .grid.split { grid-template-columns:1fr; } }
  @media (max-width:820px) {
    .app { flex-direction:column; }
    .side { width:auto; flex:none; height:auto; position:static; border-right:0; border-bottom:1px solid var(--line-soft); }
    nav { flex-direction:row; overflow-x:auto; }
    .nav-item.active::before { display:none; }
    .side-foot { flex-direction:row; align-items:center; }
    .grid.k3, .grid.k2 { grid-template-columns:1fr; }
    .content, .topbar { padding-left:14px; padding-right:14px; }
  }

  /* KPI */
  .kpi { display:flex; flex-direction:column; gap:6px; }
  .kpi .k-top { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; }
  .kpi .k-val { font-size:27px; font-weight:650; letter-spacing:-.03em; line-height:1.15; }
  .kpi .k-sub { font-size:12px; color:var(--muted); display:flex; gap:8px; flex-wrap:wrap; }
  .kpi .k-ico {
    width:26px; height:26px; border-radius:9px; display:flex; align-items:center; justify-content:center;
    font-size:13px; background:var(--bg2); color:var(--muted);
  }
  .k-ico.blue { background:var(--tint-blue); color:var(--brand-strong); }
  .k-ico.green { background:var(--tint-green); color:var(--ok); }
  .k-ico.amber { background:var(--tint-amber); color:var(--warn); }
  .k-ico.violet { background:var(--tint-blue); color:var(--brand-strong); }
  .k-ico.red { background:var(--tint-red); color:var(--danger); }
  .trend-up { color:var(--ok); } .trend-down { color:var(--danger); }

  /* 表格 */
  .tblwrap { overflow-x:auto; margin:0 -4px; }
  table.tbl { width:100%; border-collapse:collapse; font-size:12.5px; }
  table.tbl th, table.tbl td {
    padding:9px 10px; text-align:left; border-bottom:1px solid var(--line-soft); vertical-align:middle;
  }
  table.tbl th {
    color:var(--muted); font-weight:500; font-size:11px; letter-spacing:.04em; text-transform:uppercase;
    white-space:nowrap; position:sticky; top:0; background:var(--card);
  }
  table.tbl tbody tr:hover { background:var(--brand-tint); }
  table.tbl tbody tr.sel { background:color-mix(in srgb, var(--brand) 7%, transparent); }
  table.tbl td.ops { white-space:nowrap; }
  table.tbl td.ops .btn { margin-right:5px; }
  table.tbl td.wrap { white-space:normal; max-width:200px; }
  .who { display:flex; align-items:center; gap:9px; }
  .avatar {
    width:32px; height:32px; flex:0 0 32px; border-radius:50%; background:var(--brand-tint);
    color:var(--brand-strong); display:flex; align-items:center; justify-content:center;
  }
  .avatar > span {
    width:100%; height:100%; border-radius:50%; background:transparent; display:flex;
    align-items:center; justify-content:center; font-size:12px; font-weight:600; color:inherit;
  }
  .avatar.plain { background:var(--bg2); color:var(--muted); }
  .avatar.lg { width:56px; height:56px; flex-basis:56px; }
  .avatar.lg > span { font-size:20px; }
  .badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; white-space:nowrap; }
  .b-pending { background:var(--bg2); color:var(--muted); }
  .b-claimed { background:var(--tint-amber); color:var(--warn); }
  .b-paid { background:var(--tint-green); color:var(--ok); }
  .b-canceled { background:var(--bg2); color:var(--muted); opacity:.75; }
  .b-free { background:var(--tint-blue); color:var(--brand-strong); }
  .b-member { background:var(--tint-green); color:var(--ok); }
  .b-off { background:var(--tint-red); color:var(--danger); }
  .b-none { background:var(--bg2); color:var(--muted); }
  .summary {
    display:flex; gap:18px; flex-wrap:wrap; padding:11px 13px; border-radius:var(--radius-sm);
    background:var(--bg2); font-size:12.5px; color:var(--muted); margin-bottom:12px;
  }
  .summary b { color:var(--text); font-weight:650; }
  .summary b.hot { color:var(--warn); }
  .bar { height:7px; border-radius:999px; background:var(--bg2); overflow:hidden; }
  .bar > i { display:block; height:100%; border-radius:999px; background:var(--brand); }
  .bar.blue > i { background:var(--brand); } .bar.green > i { background:var(--ok); }
  .bar.amber > i { background:#f59e0b; } .bar.gray > i { background:var(--aux); }

  /* 订单 */
  .orders { display:flex; flex-direction:column; gap:9px; }
  .order {
    border:1px solid var(--line-soft); border-radius:var(--radius-sm); padding:12px 14px;
    display:flex; gap:12px; align-items:center; background:var(--card);
  }
  .order:hover { border-color:var(--line); }
  .order .amt { font-size:17px; font-weight:650; letter-spacing:-.02em; }
  .order .meta { color:var(--muted); font-size:12px; }
  .oid { font-family:ui-monospace, Consolas, monospace; font-size:11.5px; color:var(--muted); }
  .copy { cursor:pointer; border:0; background:transparent; color:var(--muted); font-size:11px; padding:2px 4px; }
  .copy:hover { color:var(--accent); }

  /* 收款码 / 空态 */
  .pc-grid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:16px; }
  .pc { border:1px dashed var(--line); border-radius:var(--radius-sm); padding:14px; text-align:center; }
  .pc.has { border-style:solid; border-color:var(--line-soft); }
  .pc img { width:100%; max-width:210px; aspect-ratio:1/1; object-fit:contain; border-radius:8px; background:var(--bg2); }
  .pc .ph { width:100%; max-width:210px; aspect-ratio:1/1; margin:0 auto; border-radius:8px; background:var(--bg2);
            display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:12px; }
  .empty { text-align:center; color:var(--muted); padding:26px 10px; font-size:13px; }

  /* 抽屉 / 弹窗 / 提示 */
  .drawer-mask, .modal-mask {
    position:fixed; inset:0; background:rgba(0,0,0,.32); backdrop-filter:blur(2px);
    z-index:60; opacity:0; pointer-events:none; transition:opacity .18s;
  }
  .drawer-mask.on, .modal-mask.on { opacity:1; pointer-events:auto; }
  .drawer {
    position:fixed; top:0; right:0; height:100vh; width:440px; max-width:92vw; background:var(--card);
    border-left:1px solid var(--line-soft); z-index:61; transform:translateX(102%);
    transition:transform .22s cubic-bezier(.32,.72,0,1); display:flex; flex-direction:column;
  }
  .drawer.on { transform:none; }
  .drawer-hd { padding:16px 18px; border-bottom:1px solid var(--line-soft); display:flex; align-items:center; gap:12px; }
  .drawer-bd { padding:16px 18px 40px; overflow:auto; flex:1; }
  .drawer-ft { padding:12px 18px; border-top:1px solid var(--line-soft); display:flex; gap:8px; flex-wrap:wrap; }
  .kv { display:grid; grid-template-columns:96px 1fr; gap:7px 10px; font-size:12.5px; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; word-break:break-all; }
  .sec-title { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:18px 0 8px; }
  .modal {
    position:fixed; z-index:62; left:50%; top:14vh; transform:translateX(-50%) scale(.98);
    width:430px; max-width:92vw; background:var(--card); border-radius:var(--radius);
    border:1px solid var(--line-soft); box-shadow:var(--shadow); padding:20px;
    opacity:0; pointer-events:none; transition:opacity .16s, transform .16s;
  }
  .modal.on { opacity:1; pointer-events:auto; transform:translateX(-50%) scale(1); }
  .modal h3 { margin:0 0 8px; font-size:16px; letter-spacing:-.01em; }
  .modal p { margin:0 0 14px; color:var(--muted); font-size:13px; white-space:pre-wrap; }
  .modal-ft { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }
  .toasts { position:fixed; right:18px; bottom:18px; z-index:70; display:flex; flex-direction:column; gap:8px; align-items:flex-end; }
  .toast {
    background:var(--card); color:var(--text); padding:10px 14px; border-radius:12px; font-size:12.5px;
    max-width:340px; border:1px solid var(--line-soft);
    box-shadow:0 10px 30px -10px rgba(15,23,42,.28); animation:fade .18s ease; white-space:pre-wrap;
  }
  .toast.ok { border-left:3px solid var(--ok); }
  .toast.err { border-left:3px solid var(--danger); }
  .toast.info { border-left:3px solid var(--brand); }
  .hint { color:var(--muted); font-size:12px; line-height:1.7; }
  .err { color:var(--danger); }
  .pager { display:flex; align-items:center; gap:8px; justify-content:flex-end; margin-top:12px; font-size:12.5px; color:var(--muted); }
  .chart-wrap { width:100%; overflow:hidden; }
  svg.chart { width:100%; height:190px; display:block; }
  .legend { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:var(--muted); margin-top:6px; }
  .legend i { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:5px; }
  .feed { display:flex; flex-direction:column; }
  .feed-item { display:flex; gap:10px; padding:9px 0; border-bottom:1px solid var(--line-soft); font-size:12.5px; }
  .feed-item:last-child { border-bottom:0; }
  .feed-item .t { color:var(--muted); font-size:11.5px; white-space:nowrap; }
  .toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
  .toolbar .grow { flex:1; min-width:160px; }
  .selbar {
    display:none; align-items:center; gap:8px; flex-wrap:wrap; padding:9px 12px; margin-bottom:12px;
    border-radius:var(--radius-sm); background:var(--brand-tint); color:var(--brand-strong); font-size:12.5px;
  }
  .selbar.on { display:flex; }
  .kv-inline { display:flex; gap:12px; flex-wrap:wrap; font-size:12.5px; color:var(--muted); }
  .kv-inline b { color:var(--text); }
  /* 窄屏（手机应急确认收款用；后台主要还是在电脑上开） */
  @media (max-width: 480px) {
    body { font-size:13px; }
    .content { padding:14px 10px 50px; }
    .topbar { padding:10px; }
    .topbar h1 { font-size:17px; }
    .card { padding:14px; border-radius:14px; }
    .kpi .k-val { font-size:22px; }
    .order { flex-wrap:wrap; }
    .order > div:last-child { text-align:left !important; width:100%; }
    .order .btn { width:100%; }
    .toolbar > * { width:100%; }
    .toolbar .chips { width:100%; }
    .drawer { width:100%; }
    .modal { top:8vh; }
    .toasts { left:12px; right:12px; bottom:12px; }
    .toast { max-width:none; }
  }
</style>
</head>
<body>
<div class="app">
  <!-- ======================= 左侧导航 ======================= -->
  <aside class="side">
    <div class="brand">
      <div class="logo">轻</div>
      <div><b>轻提词</b><small>AI 服务后台</small></div>
    </div>
    <nav id="nav">
      <button class="nav-item active" data-tab="dash"><span class="ico">◔</span><span class="grow">概览</span></button>
      <button class="nav-item" data-tab="users"><span class="ico">☺</span><span class="grow">用户与额度</span><span class="pill" id="navUsers">0</span></button>
      <button class="nav-item" data-tab="orders"><span class="ico">▤</span><span class="grow">订单</span><span class="pill" id="navOrders">0</span></button>
      <button class="nav-item" data-tab="pay"><span class="ico">▣</span><span class="grow">收款码</span></button>
      <button class="nav-item" data-tab="logs"><span class="ico">≡</span><span class="grow">日志与安全</span></button>
      <button class="nav-item" data-tab="settings"><span class="ico">⚙</span><span class="grow">设置</span></button>
    </nav>
    <div class="side-foot">
      <div class="row2">
        <span class="dot" id="liveDot"></span>
        <span class="muted" style="font-size:11.5px">实时 <span id="liveText">未连接</span></span>
      </div>
      <div class="row2">
        <button class="btn sm" id="themeBtn">暗色</button>
        <span class="muted mono" id="verText">v-</span>
      </div>
    </div>
  </aside>

  <!-- ======================= 主区 ======================= -->
  <main>
    <div class="topbar">
      <div>
        <h1 id="pageTitle">概览</h1>
        <div class="sub" id="pageSub">轻提词 AI 服务实时看板</div>
      </div>
      <div class="topbar-right">
        <span class="muted" style="font-size:11.5px" id="syncText">等待密钥</span>
        <button class="btn icon" id="refresh" title="立即刷新">↻</button>
        <button class="btn" id="keyBtn">管理员密钥</button>
      </div>
    </div>

    <div class="content">
      <!-- ---------------- 概览 ---------------- -->
      <section class="page active" id="page-dash">
        <div class="grid k4" id="kpiRow"></div>
        <div class="grid split">
          <div class="card">
            <div class="card-hd">
              <h2>近 14 天 AI 调用</h2>
              <div class="right"><span class="muted" style="font-size:11.5px" id="chartHint"></span></div>
            </div>
            <div class="chart-wrap" id="chart"></div>
            <div class="legend">
              <span><i style="background:var(--brand)"></i>调用次数</span>
              <span><i style="background:var(--ok)"></i>开通会员（笔）</span>
            </div>
          </div>
          <div class="card">
            <div class="card-hd"><h2>额度分布</h2></div>
            <div id="dist"></div>
          </div>
        </div>
        <div class="grid k2">
          <div class="card">
            <div class="card-hd"><h2>调用最多的账号</h2><div class="right muted" style="font-size:11.5px">按累计次数</div></div>
            <div id="topUsers"></div>
          </div>
          <div class="card">
            <div class="card-hd">
              <h2>最近操作</h2>
              <div class="right"><button class="btn sm" data-goto="logs">全部日志</button></div>
            </div>
            <div id="recentLogs"></div>
          </div>
        </div>
      </section>

      <!-- ---------------- 用户 ---------------- -->
      <section class="page" id="page-users">
        <div class="card">
          <div class="card-hd">
            <h2>用户与 AI 额度</h2>
            <div class="right">
              <button class="btn sm" id="uExport">导出 CSV</button>
              <button class="btn sm danger" id="uresetall">全部重置「今日用量」</button>
            </div>
          </div>
          <div class="toolbar">
            <input class="grow" id="uq" type="text" placeholder="搜索用户名 / 显示名 / 备注 / IP">
            <div class="chips" id="uFilters">
              <button class="chip on" data-uf="all">全部</button>
              <button class="chip" data-uf="member">会员</button>
              <button class="chip" data-uf="free">免费不限量</button>
              <button class="chip" data-uf="active">今日活跃</button>
              <button class="chip" data-uf="disabled">已停用</button>
            </div>
            <select id="uSort" title="排序">
              <option value="last">按最后登录</option>
              <option value="created">按注册时间</option>
              <option value="calls">按累计调用</option>
              <option value="today">按今日调用</option>
              <option value="name">按用户名</option>
            </select>
          </div>
          <div class="toolbar">
            <input id="nname" type="text" placeholder="新建账号的用户名" style="width:190px">
            <input id="npwd" type="text" placeholder="初始密码（≥8 位）" style="width:190px">
            <button class="btn primary" id="ncreate">新建账号</button>
            <span class="hint">用户名 1~32 位，可用中英文 / 数字 / <code>_</code> / <code>-</code>，首尾不能是 <code>_</code> <code>-</code>；密码至少 8 位</span>
          </div>
          <div class="selbar" id="selbar">
            <b>已选 <span id="selCount">0</span> 个</b>
            <button class="btn sm" data-batch="reset">重置今日用量</button>
            <button class="btn sm" data-batch="zero">清零累计</button>
            <button class="btn sm" data-batch="kick">踢下线</button>
            <button class="btn sm" data-batch="disable">停用</button>
            <button class="btn sm" data-batch="enable">启用</button>
            <button class="btn sm" data-batch="clear">取消选择</button>
          </div>
          <div class="tblwrap" id="users"><div class="empty">正在加载…</div></div>
          <div class="pager" id="uPager"></div>
        </div>
      </section>

      <!-- ---------------- 订单 ---------------- -->
      <section class="page" id="page-orders">
        <div class="card">
          <div class="card-hd">
            <h2>订单</h2>
            <div class="right">
              <button class="btn sm" id="oExport">导出 CSV</button>
              <button class="btn sm" id="oRefresh">刷新</button>
            </div>
          </div>
          <div class="toolbar">
            <input class="grow" id="oq" type="text" placeholder="搜索订单号 / 用户名">
            <div class="chips" id="oFilters">
              <button class="chip on" data-of="all">全部</button>
              <button class="chip" data-of="todo">待处理</button>
              <button class="chip" data-of="paid">已开通</button>
              <button class="chip" data-of="canceled">已作废</button>
            </div>
          </div>
          <div class="toolbar">
            <input id="uname" type="text" placeholder="用户名（软件里登录的账号）" style="width:200px">
            <input id="days" type="number" value="30" min="1" style="width:90px">
            <button class="btn" id="grant">手工加天数</button>
            <button class="btn" id="lookup">查用户额度</button>
            <span class="hint">用于客户线下付款、补时长等手工场景</span>
          </div>
          <div class="orders" id="orderList"><div class="empty">正在加载…</div></div>
        </div>
      </section>

      <!-- ---------------- 收款码 ---------------- -->
      <section class="page" id="page-pay">
        <div class="card">
          <div class="card-hd">
            <h2>收款码</h2>
            <div class="right"><span class="hint">客户端「开通会员」弹窗里展示，改完立即生效</span></div>
          </div>
          <div id="pcWrap"><div class="empty">正在加载…</div></div>
          <div class="hint" style="margin-top:14px">
            支持 PNG / JPG / WebP，单张上限 4 MB。上传后客户端按套餐与支付方式自动切换；
            老部署里那张 <code>data/paycode.png</code> 仍然兼容（作为兜底显示）。
          </div>
        </div>
      </section>

      <!-- ---------------- 日志与安全 ---------------- -->
      <section class="page" id="page-logs">
        <div class="card">
          <div class="card-hd">
            <h2>操作日志</h2>
            <div class="right">
              <span class="hint" id="logHint">最近 500 条</span>
              <button class="btn sm" id="logRefresh">刷新</button>
            </div>
          </div>
          <div id="logList"><div class="empty">正在加载…</div></div>
        </div>
        <div class="grid k2">
          <div class="card">
            <div class="card-hd"><h2>登录锁定记录</h2><div class="right hint">按用户名 / 来源 IP</div></div>
            <div id="guardList"><div class="empty">正在加载…</div></div>
          </div>
          <div class="card">
            <div class="card-hd"><h2>后台密钥错误</h2><div class="right hint">只记在内存</div></div>
            <div id="failList"><div class="empty">正在加载…</div></div>
          </div>
        </div>
      </section>

      <!-- ---------------- 设置 ---------------- -->
      <section class="page" id="page-settings">
        <div class="grid k2">
          <div class="card">
            <div class="card-hd"><h2>管理员密钥</h2></div>
            <div class="hint" style="margin-bottom:10px">
              密钥只存在你自己的浏览器里，每个请求通过 <code>X-Admin-Key</code> 头发给服务端校验；
              服务端用常量时间比对，日志里只打印后四位。
            </div>
            <div class="toolbar" style="margin-bottom:0">
              <input id="key" type="password" class="grow" placeholder="启动服务时设置的 MP_ADMIN_KEY">
              <button class="btn primary" id="save">保存到本浏览器</button>
              <button class="btn" id="clear">清除</button>
            </div>
          </div>
          <div class="card">
            <div class="card-hd"><h2>实时刷新</h2></div>
            <div class="hint" style="margin-bottom:10px">
              服务端给每次数据落盘都打一个修订号，页面每 2 秒只拉一个几百字节的快照：
              <b>只有数据真的变了才重画</b>，切到别的浏览器标签页会自动暂停。
            </div>
            <div class="kv-inline" id="liveInfo"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-hd"><h2>服务信息</h2></div>
          <div id="sysInfo"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h2>危险操作</h2></div>
          <div class="hint" style="margin-bottom:10px">
            把<b>所有账号</b>的「今日用量」清零（累计调用数保留）。常用于批量补偿或排查额度问题。
          </div>
          <button class="btn danger" id="resetAll2">全部重置今日用量</button>
        </div>
      </section>
    </div>
  </main>
</div>

<!-- ======================= 密钥弹窗 ======================= -->
<div class="modal-mask" id="keyMask"></div>
<div class="modal" id="keyModal">
  <h3>填写管理员密钥</h3>
  <p>服务端启动时会生成/读取 <code>data/admin_key.txt</code>，把里面的内容粘贴到这里（只保存在本浏览器）。</p>
  <input id="key2" type="password" style="width:100%" placeholder="MP_ADMIN_KEY">
  <div class="modal-ft">
    <button class="btn" id="keyCancel">稍后</button>
    <button class="btn primary" id="keyOk">连接</button>
  </div>
</div>

<!-- ======================= 通用确认 / 输入弹窗 ======================= -->
<div class="modal-mask" id="askMask"></div>
<div class="modal" id="askModal">
  <h3 id="askTitle">确认</h3>
  <p id="askBody"></p>
  <textarea id="askInput" rows="3" style="width:100%; display:none"></textarea>
  <div class="modal-ft">
    <button class="btn" id="askCancel">取消</button>
    <button class="btn primary" id="askOk">确定</button>
  </div>
</div>

<!-- ======================= 用户详情抽屉 ======================= -->
<div class="drawer-mask" id="drawerMask"></div>
<div class="drawer" id="drawer">
  <div class="drawer-hd">
    <div class="avatar lg" id="dAvatar"><span>?</span></div>
    <div style="min-width:0">
      <div style="font-weight:650; font-size:15px" id="dName">-</div>
      <div class="muted mono" id="dId">-</div>
    </div>
    <button class="btn sm" style="margin-left:auto" id="dClose">关闭</button>
  </div>
  <div class="drawer-bd" id="dBody"></div>
  <div class="drawer-ft" id="dFoot"></div>
</div>

<div class="toasts" id="toasts"></div>
<pre class="sr" id="out"></pre>

<script>
(function () {
  'use strict';
  var KEY_STORE = 'microprompt.adminKey';
  var THEME_STORE = 'microprompt.adminTheme';
  var POLL_MS = 2000;
  var FREE_DAILY = 3, MEMBER_CAP = 300;
  var VERSION = '4.1.2';   // 兜底值：真实版本从 /ai/health 读，避免页面写着写着就过期

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  var S = {
    key: '', tab: 'dash', rev: -1, ready: false, paused: false,
    users: [], orders: [], kpi: null, series: [], topUsers: [], plans: [],
    logs: [], guard: null, adminFails: [], paycodes: null, live: null, health: null,
    q: '', filter: 'all', sort: 'last', page: 1, per: 20, sel: {},
    oq: '', ofilter: 'all', openUser: '', lastPending: -1, loaded: {}, busy: false
  };

  /* ---------------------------------------------------------- 工具 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(ts) {
    if (!ts) return '-';
    var d = new Date(Number(ts) * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
           pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtClock(ts) {
    if (!ts) return '-';
    var d = new Date(Number(ts) * 1000);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtDay(day) { return String(day || '').slice(5); }
  function money(n) { return '￥' + Number(n || 0).toFixed(2); }
  function isTodayTs(ts) {
    if (!ts) return false;
    var d = new Date(Number(ts) * 1000), t = new Date();
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() &&
           d.getDate() === t.getDate();
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function initial(name) {
    var s = String(name || '?').trim();
    return s ? s.slice(0, 1).toUpperCase() : '?';
  }
  function statusText(s) {
    return ({ pending: '待付款', claimed: '用户已付待确认', paid: '已开通', canceled: '已作废' })[s] || s;
  }
  function usageText(u) {
    if (u.free) return '不限量 · 今日 ' + u.unlimitedUsedToday + ' 次';
    if (u.member) return '会员 · 今日 ' + u.memberUsedToday + ' / ' + MEMBER_CAP + ' 次';
    return '免费 · 今日 ' + u.freeUsedToday + ' / ' + FREE_DAILY + ' 次（余 ' + u.remainingToday + '）';
  }
  function stateBadge(u) {
    var st = String(u.status || '');
    if (st === 'disabled') return '<span class="badge b-off">已停用</span>';
    if (!u.account) return '<span class="badge b-none">无账号</span>';
    if (u.free) return '<span class="badge b-free">免费不限量</span>';
    if (u.member) return '<span class="badge b-member">会员</span>';
    return '<span class="badge b-none">免费版</span>';
  }
  function copyText(text, okMsg) {
    // 后台是 http 明文，navigator.clipboard 在非安全上下文里不存在，必须有兜底
    // 注意：这里只弹吐司、不写 #out —— 否则会把「临时密码：xxx」这种重要提示冲掉
    var done = function () { toast(okMsg || ('已复制：' + text), 'ok'); };
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(); });
        return;
      }
    } catch (e) { /* 落到兜底 */ }
    fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('复制失败，请手动选中复制：' + text, 'err'); }
      document.body.removeChild(ta);
    }
  }
  function download(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }
  function csv(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
  }

  /* ---------------------------------------------------------- 输出：吐司 + 隐藏文本槽 */
  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 4200);
  }
  /** say = 吐司 + 写进隐藏的 #out（回归测试读 #out，比抓吐司稳） */
  function say(msg, kind) {
    var box = $('out');
    if (box) box.textContent = String(msg == null ? '' : msg);
    if (!msg) return;
    toast(msg, kind);
  }
  function err(res) {
    if (res && res.status === 403) { say('管理员密钥不正确，请在右上角重新填写', 'err'); needKey(true); return; }
    var d = (res && res.data) || {};
    say(d.error || ('请求失败 HTTP ' + ((res && res.status) || '?')), 'err');
  }

  /* ---------------------------------------------------------- 接口 */
  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': S.key },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, data: d };
      });
    });
  }
  function need(key, focus) {
    if (!key) return Promise.resolve({ status: 0, data: { ok: false, error: '请先填写管理员密钥' } });
    // 4.1.7：**只给读接口**自动重试一次。
    // 为什么要重试：本服务是 HTTP/1.0 短连接，经过某些本机代理（例如抓包/科学上网用的
    // localhost 代理）时响应会被截断，浏览器直接报 net::ERR_CONTENT_LENGTH_MISMATCH，
    // 表现就是后台偶发空白（概览页 KPI 与图表整块不出来）。实测线上每几次加载中一次，
    // 且紧接着重发就成功，所以一次重试足够。
    // 写接口（确认收款/打回/重置密码…）**绝不自动重试** —— 万一第一次其实已经成功，
    // 重发会重复执行（多写一条审计、多开一次会员）。
    return api(key, focus || {}).catch(function (e) {
      return new Promise(function (r) { setTimeout(r, 400); }).then(function () {
        return api(key, focus || {});
      }).catch(function () { throw e; });
    });
  }

  /* ---------------------------------------------------------- 弹窗 */
  var askCb = null;
  function ask(opts, cb) {
    askCb = cb;
    $('askTitle').textContent = opts.title || '确认';
    $('askBody').textContent = opts.body || '';
    var input = $('askInput');
    if (opts.input) {
      input.style.display = 'block';
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
      setTimeout(function () { input.focus(); }, 30);
    } else {
      input.style.display = 'none';
    }
    $('askOk').textContent = opts.ok || '确定';
    $('askOk').className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    $('askMask').classList.add('on');
    $('askModal').classList.add('on');
  }
  function askClose() {
    $('askMask').classList.remove('on');
    $('askModal').classList.remove('on');
    askCb = null;
  }
  $('askCancel').addEventListener('click', askClose);
  $('askMask').addEventListener('click', askClose);
  $('askOk').addEventListener('click', function () {
    var cb = askCb, val = $('askInput').value;
    askClose();
    if (cb) cb(val);
  });

  function needKey(show) {
    if (S.key && !show) return;
    $('key2').value = S.key || '';
    $('keyMask').classList.add('on');
    $('keyModal').classList.add('on');
    setTimeout(function () { $('key2').focus(); }, 40);
  }
  function keyClose() {
    $('keyMask').classList.remove('on');
    $('keyModal').classList.remove('on');
  }
  $('keyCancel').addEventListener('click', keyClose);
  $('keyMask').addEventListener('click', keyClose);
  $('keyOk').addEventListener('click', function () {
    S.key = $('key2').value.trim();
    try { localStorage.setItem(KEY_STORE, S.key); } catch (e) {}
    $('key').value = S.key;
    keyClose();
    if (!S.key) { say('密钥为空，无法连接', 'err'); return; }
    S.loaded = {};
    refresh(true);
  });

  /* ---------------------------------------------------------- 主题 */
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeBtn').textContent = t === 'dark' ? '亮色' : '暗色';
    try { localStorage.setItem(THEME_STORE, t); } catch (e) {}
  }
  $('themeBtn').addEventListener('click', function () {
    setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    if (S.series && S.series.length) renderDash();   // 图表是按主题取色的，切主题要重画
  });

  /* ---------------------------------------------------------- 页签 */
  var TITLES = {
    dash: ['概览', '轻提词 AI 服务实时看板'],
    users: ['用户与额度', '账号、会员、免费不限量与每日 AI 用量'],
    orders: ['订单', '确认收款开通会员 / 手工加天数'],
    pay: ['收款码', '微信与支付宝收款图在线管理'],
    logs: ['日志与安全', '后台操作留痕、登录锁定与密钥错误'],
    settings: ['设置', '密钥、实时刷新与服务信息']
  };
  function goto(tab) {
    S.tab = tab;
    $$('#nav .nav-item').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    $$('.page').forEach(function (p) { p.classList.toggle('active', p.id === 'page-' + tab); });
    var t = TITLES[tab] || ['', ''];
    $('pageTitle').textContent = t[0];
    $('pageSub').textContent = t[1];
    loadTab(tab);
  }
  $$('#nav .nav-item').forEach(function (b) {
    b.addEventListener('click', function () { goto(b.getAttribute('data-tab')); });
  });
  $$('[data-goto]').forEach(function (b) {
    b.addEventListener('click', function () { goto(b.getAttribute('data-goto')); });
  });

  /* ---------------------------------------------------------- 概览 */
  function kpiCard(ico, cls, label, value, sub) {
    return '<div class="card kpi">' +
      '<div class="k-top"><span class="k-ico ' + cls + '">' + ico + '</span>' + label + '</div>' +
      '<div class="k-val">' + value + '</div>' +
      '<div class="k-sub">' + (sub || '') + '</div></div>';
  }
  /* 图表配色跟着主题走（SVG 的 fill/stroke 属性吃不了 CSS 变量，只能按主题取色） */
  function chartColors() {
    return document.documentElement.getAttribute('data-theme') === 'dark'
      ? { line:'#818cf8', fill:'#818cf8', bar:'#34d399', dot:'#111827', axis:'#64748b' }
      : { line:'#6366f1', fill:'#6366f1', bar:'#10b981', dot:'#ffffff', axis:'#9ca3af' };
  }
  function areaChart(series, key, height) {
    var C = chartColors();
    var W = 720, H = height || 190, padL = 6, padR = 6, padT = 16, padB = 22;
    var n = series.length;
    if (!n) return '<div class="empty">暂无数据</div>';
    var max = 0;
    series.forEach(function (d) { max = Math.max(max, Number(d[key] || 0)); });
    if (max <= 0) max = 1;
    var stepX = (W - padL - padR) / Math.max(1, n - 1);
    var y = function (v) { return padT + (H - padT - padB) * (1 - Number(v || 0) / max); };
    var pts = series.map(function (d, i) { return [padL + i * stepX, y(d[key])]; });
    var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = line + ' ' + (padL + (n - 1) * stepX).toFixed(1) + ',' + (H - padB) + ' ' +
               padL + ',' + (H - padB);
    var bars = '';
    var bw = Math.max(3, Math.min(14, stepX * 0.34));
    series.forEach(function (d, i) {
      var v = Number(d.paidOrders || 0);
      if (!v) return;
      var h = Math.max(2, (H - padT - padB) * 0.34 * (v / Math.max(1, maxPaid(series))));
      bars += '<rect x="' + (padL + i * stepX - bw / 2).toFixed(1) + '" y="' + (H - padB - h).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + C.bar + '" opacity=".8"><title>' +
        esc(d.day) + '：开通 ' + v + ' 笔</title></rect>';
    });
    var dots = '';
    series.forEach(function (d, i) {
      if (i === n - 1 || Number(d[key]) > 0) {
        dots += '<circle cx="' + pts[i][0].toFixed(1) + '" cy="' + pts[i][1].toFixed(1) +
          '" r="' + (i === n - 1 ? 4 : 2.6) + '" fill="' + C.dot + '" stroke="' + C.line + '" stroke-width="2"><title>' +
          esc(d.day) + '：' + Number(d[key] || 0) + ' 次</title></circle>';
      }
    });
    var labels = '';
    series.forEach(function (d, i) {
      if (i % 2 === 0 || i === n - 1) {
        labels += '<text x="' + (padL + i * stepX).toFixed(1) + '" y="' + (H - 6) +
          '" font-size="10" fill="' + C.axis + '" text-anchor="middle">' + esc(fmtDay(d.day)) + '</text>';
      }
    });
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + C.fill + '" stop-opacity=".22"/>' +
      '<stop offset="100%" stop-color="' + C.fill + '" stop-opacity="0"/></linearGradient></defs>' +
      '<polygon points="' + area + '" fill="url(#ag)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="' + C.line + '" stroke-width="2.2" ' +
      'stroke-linejoin="round" stroke-linecap="round"/>' +
      bars + dots + labels + '</svg>';
  }
  function maxPaid(series) {
    var m = 1;
    series.forEach(function (d) { m = Math.max(m, Number(d.paidOrders || 0)); });
    return m;
  }
  function renderDash() {
    var k = S.kpi || {};
    var y = S.series.length > 1 ? S.series[S.series.length - 2] : null;
    var diff = y ? Number(k.callsToday || 0) - Number(y.calls || 0) : 0;
    var diffTxt = y ? (diff === 0 ? '与昨天持平'
      : '<span class="' + (diff > 0 ? 'trend-up' : 'trend-down') + '">' +
        (diff > 0 ? '↑' : '↓') + ' ' + Math.abs(diff) + ' 次</span> 较昨天') : '';
    $('kpiRow').innerHTML =
      kpiCard('☺', 'blue', '账号总数', Number(k.accounts || 0),
        '今日新增 <b>' + Number(k.newToday || 0) + '</b> · 今日活跃 <b>' + Number(k.activeToday || 0) + '</b>') +
      kpiCard('✦', 'violet', '今日 AI 调用', Number(k.callsToday || 0),
        diffTxt + ' · 累计 <b>' + Number(k.callsTotal || 0) + '</b> 次') +
      kpiCard('▤', 'amber', '待处理订单', Number(k.pendingOrders || 0),
        '累计已开通 <b>' + Number(k.paidOrders || 0) + '</b> 笔') +
      kpiCard('￥', 'green', '今日收入', money(k.revenueToday),
        '本月 <b>' + money(k.revenueMonth) + '</b> · 累计 <b>' + money(k.revenueTotal) + '</b>');
    $('chart').innerHTML = areaChart(S.series, 'calls', 190);
    $('chartHint').textContent = '今天 ' + Number(k.callsToday || 0) + ' 次 · 峰值 ' +
      Math.max.apply(null, S.series.map(function (d) { return Number(d.calls || 0); }).concat([0])) + ' 次';
    var dist = [
      ['免费版', Number(k.freeOnly || 0), 'gray'],
      ['会员', Number(k.members || 0), 'green'],
      ['免费不限量', Number(k.free || 0), 'blue'],
      ['已停用', Number(k.disabled || 0), 'amber']
    ];
    var total = dist.reduce(function (a, r) { return a + r[1]; }, 0) || 1;
    $('dist').innerHTML = dist.map(function (r) {
      var pct = Math.round(r[1] / total * 100);
      return '<div style="margin-bottom:12px">' +
        '<div class="kv-inline" style="justify-content:space-between"><span>' + r[0] + '</span>' +
        '<span><b>' + r[1] + '</b> 个 · ' + pct + '%</span></div>' +
        '<div class="bar ' + r[2] + '" style="margin-top:5px"><i style="width:' + pct + '%"></i></div></div>';
    }).join('') + '<div class="hint" style="margin-top:6px">共 ' + total + ' 个账号；' +
      '今日登录 ' + Number(k.loginsToday || 0) + ' 次</div>';
    $('topUsers').innerHTML = S.topUsers.length ? S.topUsers.map(function (u) {
      return '<div class="feed-item"><div class="avatar plain"><span>' + esc(initial(u.username)) + '</span></div>' +
        '<div style="flex:1;min-width:0"><b>' + esc(u.username) + '</b>' +
        '<div class="muted" style="font-size:11.5px">累计 ' + u.totalCalls + ' 次 · 今日 ' + u.callsToday + ' 次' +
        (u.free ? ' · 免费不限量' : (u.member ? ' · 会员' : '')) +
        (u.status === 'disabled' ? ' · 已停用' : '') + '</div></div></div>';
    }).join('') : '<div class="empty">还没有 AI 调用记录</div>';
    $('recentLogs').innerHTML = S.logs.length ? S.logs.slice(0, 6).map(function (l) {
      return '<div class="feed-item"><span class="t">' + fmtClock(l.t) + '</span>' +
        '<div style="flex:1;min-width:0"><b>' + esc(l.action) + '</b> ' + esc(l.target || '') +
        '<div class="muted" style="font-size:11.5px">' + esc(l.detail || '') +
        (l.ip ? ' · ' + esc(l.ip) : '') + '</div></div></div>';
    }).join('') : '<div class="empty">还没有后台操作记录</div>';
    $('liveInfo').innerHTML =
      '<span>修订号 <b id="revText">' + (S.live ? S.live.rev : '-') + '</b></span>' +
      '<span>最近同步 <b id="syncText2">' + (S.live ? fmtClock(S.live.ts) : '-') + '</b></span>' +
      '<span>锁定账号 <b>' + Number((S.live || {}).locked || 0) + '</b></span>' +
      '<span>服务端版本 <b>' + esc(serverVersion()) + '</b></span>';
    $('sysInfo').innerHTML =
      '<div class="kv">' +
      '<dt>服务版本</dt><dd>' + esc(serverVersion()) + '（/ai/health 可查）</dd>' +
      '<dt>账号模式</dt><dd>' + esc((S.health && S.health.authMode) || '-') +
      ((S.health && S.health.mock) ? ' · 模拟模式（不调用 DeepSeek）' : '') + '</dd>' +
      '<dt>账号总数</dt><dd>' + Number(k.accounts || 0) + ' 个</dd>' +
      '<dt>免费额度</dt><dd>每天 ' + FREE_DAILY + ' 次；会员日上限 ' + MEMBER_CAP + ' 次（防滥用）</dd>' +
      '<dt>数据存储</dt><dd>服务器 <code>data/*.json</code>（原子写 + 启动备份，无数据库依赖）</dd>' +
      '<dt>管理员密钥</dt><dd>' + (S.key ? '已保存在本浏览器（' + esc(S.key.slice(0, 2)) + '****）' : '未填写') + '</dd>' +
      '<dt>命令行</dt><dd><code>python3 admin_cli.py list | confirm &lt;订单号&gt; | grant &lt;用户名&gt; &lt;天数&gt;</code></dd>' +
      '</div>';
  }
  function serverVersion() {
    return (S.health && S.health.version) || VERSION;
  }

  /* ---------------------------------------------------------- 用户 */
  function filteredUsers() {
    var kw = S.q.trim().toLowerCase();
    var list = S.users.filter(function (u) {
      if (S.filter === 'member' && !u.member) return false;
      if (S.filter === 'free' && !u.free) return false;
      if (S.filter === 'disabled' && u.status !== 'disabled') return false;
      if (S.filter === 'active' && !isTodayTs(u.lastLogin || u.last)) return false;
      if (!kw) return true;
      return [u.username, u.displayName, u.note, u.lastIP, u.userId].some(function (v) {
        return String(v || '').toLowerCase().indexOf(kw) >= 0;
      });
    });
    var key = S.sort;
    list.sort(function (a, b) {
      if (key === 'name') return String(a.username || '').localeCompare(String(b.username || ''), 'zh');
      if (key === 'calls') return Number(b.totalCalls || 0) - Number(a.totalCalls || 0);
      if (key === 'today') return todayCalls(b) - todayCalls(a);
      if (key === 'created') return Number(b.created || b.first || 0) - Number(a.created || a.first || 0);
      return Number(b.lastLogin || b.last || 0) - Number(a.lastLogin || a.last || 0);
    });
    return list;
  }
  function todayCalls(u) {
    return Number(u.freeUsedToday || 0) + Number(u.memberUsedToday || 0) + Number(u.unlimitedUsedToday || 0);
  }
  function renderUsers() {
    var box = $('users');
    if (!S.users.length && S.ready) {
      box.innerHTML = '<div class="empty">还没有任何账号。用上面的「新建账号」建一个，或让用户在软件里注册。</div>';
      $('uPager').innerHTML = '';
      return;
    }
    var list = filteredUsers();
    var page = Math.min(S.page, Math.max(1, Math.ceil(list.length / S.per)));
    S.page = page;
    var slice = list.slice((page - 1) * S.per, page * S.per);
    var todayUsers = list.filter(function (u) { return isTodayTs(u.lastLogin || u.last); }).length;
    var freeCount = list.filter(function (u) { return u.free; }).length;
    var offCount = list.filter(function (u) { return u.status === 'disabled'; }).length;
    var calls = list.reduce(function (a, u) { return a + todayCalls(u); }, 0);
    var html = '<div class="summary">' +
      '<span>账号 <b>' + list.length + '</b> 个</span>' +
      '<span>今日登录 <b>' + todayUsers + '</b> 个</span>' +
      '<span>免费不限量 <b>' + freeCount + '</b> 个</span>' +
      '<span>已停用 <b>' + offCount + '</b> 个</span>' +
      '<span>今日 AI 调用 <b>' + calls + '</b> 次</span>' +
      '</div>';
    html += '<table class="tbl"><thead><tr>' +
      '<th style="width:30px"><input type="checkbox" id="uAll"></th>' +
      '<th>账号</th><th>注册时间</th><th>最后登录</th><th>AI 额度</th>' +
      '<th>累计</th><th>会员到期</th><th>状态</th><th>备注</th><th>操作</th>' +
      '</tr></thead><tbody>';
    slice.forEach(function (u) {
      var name = esc(u.username);
      var st = String(u.status || '');
      html += '<tr data-row="' + name + '"' + (S.sel[u.username] ? ' class="sel"' : '') + '>' +
        '<td><input type="checkbox" data-check="' + name + '"' + (S.sel[u.username] ? ' checked' : '') + '></td>' +
        '<td><div class="who"><div class="avatar"><span>' + esc(initial(u.username)) + '</span></div>' +
        '<div style="min-width:0"><b>' + (name || '(未命名)') + '</b>' +
        (u.displayName ? '<div class="muted" style="font-size:11.5px">' + esc(u.displayName) + '</div>' : '') +
        '<div class="oid">' + esc(String(u.userId || '').slice(0, 8)) + '</div></div></div></td>' +
        '<td>' + fmtTime(u.created || u.first) + '</td>' +
        '<td>' + fmtTime(u.lastLogin || u.last) +
        (u.lastIP ? '<div class="oid">' + esc(u.lastIP) + '</div>' : '') + '</td>' +
        '<td>' + usageText(u) + '</td>' +
        '<td>' + Number(u.totalCalls || 0) + ' 次</td>' +
        '<td>' + (u.member ? fmtTime(u.memberUntil) : '-') + '</td>' +
        '<td>' + stateBadge(u) + '</td>' +
        '<td class="wrap">' + (u.note ? esc(u.note) : '-') + '</td>' +
        '<td class="ops">' +
        '<button class="btn sm" data-reset="' + name + '">重置今日</button>' +
        '<button class="btn sm" data-zero="' + name + '">清零累计</button>' +
        (u.free
          ? '<button class="btn sm" data-free="0" data-name="' + name + '">取消免费</button>'
          : '<button class="btn sm primary" data-free="1" data-name="' + name + '">开通免费不限量</button>') +
        (u.account ? (
          '<button class="btn sm" data-pwd="' + name + '">重置密码</button>' +
          '<button class="btn sm" data-note="' + name + '">备注</button>' +
          '<button class="btn sm" data-kick="' + name + '">踢下线</button>' +
          (st === 'disabled'
            ? '<button class="btn sm primary" data-status="active" data-name="' + name + '">启用</button>'
            : '<button class="btn sm" data-status="disabled" data-name="' + name + '">停用</button>')
        ) : '') +
        '</td></tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    var pages = Math.max(1, Math.ceil(list.length / S.per));
    $('uPager').innerHTML = pages > 1
      ? '<span>第 ' + page + ' / ' + pages + ' 页</span>' +
        '<button class="btn sm" data-page="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        '<button class="btn sm" data-page="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button>'
      : '<span>共 ' + list.length + ' 条</span>';
    bindUserRow(box);
  }
  function bindUserRow(box) {
    $$('[data-reset]', box).forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); resetUsage(b.getAttribute('data-reset'), false); });
    });
    $$('[data-zero]', box).forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); resetUsage(b.getAttribute('data-zero'), true); });
    });
    $$('[data-free]', box).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        setFree(b.getAttribute('data-name'), b.getAttribute('data-free') === '1');
      });
    });
    $$('[data-pwd]', box).forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); resetPwd(b.getAttribute('data-pwd')); });
    });
    $$('[data-status]', box).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        setStatus(b.getAttribute('data-name'), b.getAttribute('data-status'));
      });
    });
    $$('[data-kick]', box).forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); kickUser(b.getAttribute('data-kick')); });
    });
    $$('[data-note]', box).forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); setNote(b.getAttribute('data-note')); });
    });
    $$('[data-check]', box).forEach(function (c) {
      c.addEventListener('click', function (e) { e.stopPropagation(); });
      c.addEventListener('change', function () {
        var n = c.getAttribute('data-check');
        if (c.checked) S.sel[n] = true; else delete S.sel[n];
        renderUsers();
      });
    });
    $$('tr[data-row]', box).forEach(function (tr) {
      tr.addEventListener('click', function () { openDrawer(tr.getAttribute('data-row')); });
    });
    var all = $('uAll');
    if (all) all.addEventListener('change', function () {
      var list = filteredUsers();
      if (all.checked) list.forEach(function (u) { S.sel[u.username] = true; });
      else S.sel = {};
      renderUsers();
    });
    $$('[data-page]', $('uPager')).forEach(function (b) {
      b.addEventListener('click', function () {
        S.page += (b.getAttribute('data-page') === 'next' ? 1 : -1);
        renderUsers();
      });
    });
    var n = Object.keys(S.sel).length;
    $('selCount').textContent = n;
    $('selbar').classList.toggle('on', n > 0);
  }

  /* ---------------------------------------------------------- 用户抽屉 */
  function userOf(name) {
    for (var i = 0; i < S.users.length; i++) if (S.users[i].username === name) return S.users[i];
    return null;
  }
  function openDrawer(name) {
    var u = userOf(name);
    if (!u) return;
    S.openUser = name;
    $('dName').textContent = u.username || '(未命名)';
    $('dId').textContent = u.userId || '';
    $('dAvatar').innerHTML = '<span>' + esc(initial(u.username)) + '</span>';
    var mine = S.orders.filter(function (o) { return o.userId === u.userId; });
    $('dBody').innerHTML =
      '<div class="sec-title">账号</div><dl class="kv">' +
      '<dt>显示名</dt><dd>' + esc(u.displayName || '-') + '</dd>' +
      '<dt>状态</dt><dd>' + stateBadge(u) + '</dd>' +
      '<dt>注册时间</dt><dd>' + fmtTime(u.created || u.first) + '</dd>' +
      '<dt>最后登录</dt><dd>' + fmtTime(u.lastLogin || u.last) + '</dd>' +
      '<dt>最后 IP</dt><dd class="mono">' + esc(u.lastIP || '-') + '</dd>' +
      '<dt>凭证版本</dt><dd>' + Number(u.tokenVer || 0) + '</dd>' +
      '</dl>' +
      '<div class="sec-title">额度</div><dl class="kv">' +
      '<dt>当前档位</dt><dd>' + usageText(u) + '</dd>' +
      '<dt>会员到期</dt><dd>' + (u.member ? fmtTime(u.memberUntil) : '未开通') + '</dd>' +
      '<dt>今日剩余</dt><dd>' + (u.free ? '不限量' : Number(u.remainingToday || 0) + ' 次') + '</dd>' +
      '<dt>累计调用</dt><dd>' + Number(u.totalCalls || 0) + ' 次</dd>' +
      '<dt>备注</dt><dd>' + (u.note ? esc(u.note) : '-') + '</dd>' +
      '</dl>' +
      '<div class="sec-title">该账号的订单（' + mine.length + '）</div>' +
      (mine.length ? mine.slice(0, 8).map(function (o) {
        return '<div class="feed-item"><div style="flex:1"><span class="badge b-' + o.status + '">' +
          statusText(o.status) + '</span> <b>' + money(o.amount) + '</b> ' + esc(o.planName || o.plan) +
          '<div class="oid">' + esc(o.id) + ' · ' + fmtTime(o.created) + '</div></div></div>';
      }).join('') : '<div class="hint">暂无订单</div>');
    $('dFoot').innerHTML =
      '<input id="dDays" type="number" value="30" min="1" style="width:82px">' +
      '<button class="btn" data-d="grant">加天数</button>' +
      '<button class="btn" data-d="reset">重置今日</button>' +
      '<button class="btn" data-d="zero">清零累计</button>' +
      '<button class="btn" data-d="free">' + (u.free ? '取消免费不限量' : '开通免费不限量') + '</button>' +
      '<button class="btn" data-d="pwd">重置密码</button>' +
      '<button class="btn" data-d="note">改备注</button>' +
      '<button class="btn" data-d="kick">踢下线</button>' +
      (u.status === 'disabled'
        ? '<button class="btn" data-d="enable">启用账号</button>'
        : '<button class="btn danger" data-d="disable">停用账号</button>');
    $$('[data-d]', $('dFoot')).forEach(function (b) {
      b.addEventListener('click', function () { drawerAction(b.getAttribute('data-d'), u); });
    });
    $('drawerMask').classList.add('on');
    $('drawer').classList.add('on');
  }
  function closeDrawer() {
    $('drawerMask').classList.remove('on');
    $('drawer').classList.remove('on');
    S.openUser = '';
  }
  $('dClose').addEventListener('click', closeDrawer);
  $('drawerMask').addEventListener('click', closeDrawer);
  function drawerAction(kind, u) {
    if (kind === 'grant') {
      var d = parseInt($('dDays').value, 10) || 0;
      if (d <= 0) { say('天数要大于 0', 'err'); return; }
      ask({ title: '手工加天数', body: '给「' + u.username + '」加 ' + d + ' 天会员？' }, function () {
        api('/ai/admin/grant', { username: u.username, days: d }).then(function (res) {
          if (!res.data.ok) return err(res);
          say('已给 ' + u.username + ' 加 ' + d + ' 天，到期 ' + fmtTime(res.data.memberUntil), 'ok');
          refresh(true);
        });
      });
      return;
    }
    if (kind === 'reset') return resetUsage(u.username, false);
    if (kind === 'zero') return resetUsage(u.username, true);
    if (kind === 'free') return setFree(u.username, !u.free);
    if (kind === 'pwd') return resetPwd(u.username);
    if (kind === 'note') return setNote(u.username);
    if (kind === 'kick') return kickUser(u.username);
    if (kind === 'disable') return setStatus(u.username, 'disabled');
    if (kind === 'enable') return setStatus(u.username, 'active');
  }

  /* ---------------------------------------------------------- 用户操作 */
  function after(action) { say(action, 'ok'); refresh(true); }
  function resetUsage(name, zeroTotal) {
    if (!name) return;
    ask({
      title: zeroTotal ? '清零累计调用' : '重置今日用量',
      body: zeroTotal
        ? '把「' + name + '」的累计调用数一起清零？\n（今日用量同样清零，不可撤销）'
        : '把「' + name + '」的今日用量清零？\n（累计调用数保留）',
      danger: zeroTotal
    }, function () {
      var body = { username: name };
      if (zeroTotal) body.total = true;
      api('/ai/admin/reset', body).then(function (res) {
        if (!res.data.ok) return err(res);
        after('已重置「' + name + '」' + (zeroTotal ? '（含累计）' : '（今日用量）'));
      });
    });
  }
  function setFree(name, on) {
    if (!name) return;
    ask({
      title: on ? '开通免费不限量' : '取消免费不限量',
      body: on ? '给「' + name + '」开通免费不限量 AI 润色？\n（不受每天 ' + FREE_DAILY + ' 次限制，仍保留 2 秒最小间隔）'
               : '取消「' + name + '」的免费不限量？'
    }, function () {
      api('/ai/admin/free', { username: name, on: on }).then(function (res) {
        if (!res.data.ok) return err(res);
        after((on ? '已开通免费不限量：' : '已取消免费不限量：') + name);
      });
    });
  }
  function resetPwd(name) {
    if (!name) return;
    ask({
      title: '重置密码',
      body: '重置「' + name + '」的密码？\n· 会生成一个一次性临时密码，只显示这一次\n· 该账号已登录的旧令牌会立刻失效',
      danger: true
    }, function () {
      api('/ai/admin/account/resetpwd', { name: name }).then(function (res) {
        if (!res.data.ok) return err(res);
        var temp = res.data.tempPassword;
        say('已重置「' + name + '」的密码。\n临时密码：' + temp + '\n（只显示这一次，请转告用户登录后自行修改）', 'ok');
        copyText(temp, '临时密码已复制到剪贴板');
        refresh(true);
      });
    });
  }
  function setStatus(name, status) {
    if (!name) return;
    var off = status === 'disabled';
    ask({
      title: off ? '停用账号' : '启用账号',
      body: off ? '停用「' + name + '」？\n该账号将无法登录，已登录的旧令牌立刻失效。'
                : '启用「' + name + '」？启用后该账号可以重新登录。',
      danger: off
    }, function () {
      api('/ai/admin/account/status', { name: name, status: status }).then(function (res) {
        if (!res.data.ok) return err(res);
        after((off ? '已停用：' : '已启用：') + name);
      });
    });
  }
  function kickUser(name) {
    if (!name) return;
    ask({
      title: '踢下线',
      body: '把「' + name + '」踢下线？\n旧令牌立刻失效，用户需要重新登录（密码不变）。'
    }, function () {
      api('/ai/admin/account/kick', { name: name }).then(function (res) {
        if (!res.data.ok) return err(res);
        var u = res.data.account || {};
        after('已把「' + name + '」踢下线（凭证版本 -> ' + (u.tokenVer || '?') + '）');
      });
    });
  }
  function setNote(name) {
    if (!name) return;
    var u = userOf(name) || {};
    ask({
      title: '备注「' + name + '」',
      body: '仅后台可见，留空即清除。',
      input: true,
      value: u.note || '',
      placeholder: '例如：VIP 客户 / 微信名 xxx / 已线下退款'
    }, function (val) {
      api('/ai/admin/account/note', { name: name, note: val }).then(function (res) {
        if (!res.data.ok) return err(res);
        after('已更新「' + name + '」的备注');
      });
    });
  }
  function createAccount() {
    var name = ($('nname').value || '').trim();
    var pwd = $('npwd').value || '';
    if (!name) { say('请先填用户名', 'err'); return; }
    if (pwd.length < 8) { say('密码不符合要求：至少 8 位', 'err'); return; }
    ask({ title: '新建账号', body: '新建账号「' + name + '」？用户可直接用它登录。' }, function () {
      api('/ai/admin/account/create', { name: name, password: pwd }).then(function (res) {
        if (!res.data.ok) return err(res);
        $('nname').value = ''; $('npwd').value = '';
        after('已新建账号：' + name);
      });
    });
  }
  function batch(kind) {
    var names = Object.keys(S.sel);
    if (!names.length) return;
    var labels = {
      reset: '重置今日用量', zero: '清零累计调用', kick: '踢下线',
      disable: '停用', enable: '启用'
    };
    ask({
      title: '批量' + labels[kind],
      body: '对选中的 ' + names.length + ' 个账号执行「' + labels[kind] + '」？',
      danger: kind === 'disable' || kind === 'zero'
    }, function () {
      var done = 0, fails = [];
      var next = function (i) {
        if (i >= names.length) {
          S.sel = {};
          say('批量' + labels[kind] + '完成：成功 ' + done + ' 个' +
              (fails.length ? '，失败 ' + fails.length + ' 个（' + fails.join('、') + '）' : ''), 
              fails.length ? 'err' : 'ok');
          refresh(true);
          return;
        }
        var n = names[i];
        var p;
        if (kind === 'reset') p = api('/ai/admin/reset', { username: n });
        else if (kind === 'zero') p = api('/ai/admin/reset', { username: n, total: true });
        else if (kind === 'kick') p = api('/ai/admin/account/kick', { name: n });
        else p = api('/ai/admin/account/status', { name: n, status: kind === 'disable' ? 'disabled' : 'active' });
        p.then(function (res) {
          if (res.data.ok) done++; else fails.push(n);
          next(i + 1);
        }).catch(function () { fails.push(n); next(i + 1); });
      };
      next(0);
    });
  }

  /* ---------------------------------------------------------- 订单 */
  function filteredOrders() {
    var kw = S.oq.trim().toLowerCase();
    return S.orders.filter(function (o) {
      if (S.ofilter === 'todo' && o.status !== 'pending' && o.status !== 'claimed') return false;
      if (S.ofilter === 'paid' && o.status !== 'paid') return false;
      if (S.ofilter === 'canceled' && o.status !== 'canceled') return false;
      if (!kw) return true;
      return String(o.id || '').toLowerCase().indexOf(kw) >= 0 ||
             String(o.name || '').toLowerCase().indexOf(kw) >= 0;
    });
  }
  function orderCard(o) {
    var can = (o.status === 'pending' || o.status === 'claimed');
    return '<div class="order">' +
      '<div class="avatar"><span>' + esc(initial(o.name)) + '</span></div>' +
      '<div style="flex:1;min-width:0">' +
      '<div><b>' + esc(o.name || '-') + '</b> <span class="badge b-' + o.status + '">' +
      statusText(o.status) + '</span></div>' +
      '<div class="meta">' + esc(o.planName || o.plan) + ' / ' + (o.days || '-') + ' 天 · 下单 ' +
      fmtTime(o.created) + (o.paidAt ? ' · 开通 ' + fmtTime(o.paidAt) : '') +
      (o.canceledAt ? ' · 作废 ' + fmtTime(o.canceledAt) : '') + '</div>' +
      '<div class="oid">' + esc(o.id) + ' <button class="copy" data-copy="' + esc(o.id) + '">复制</button></div>' +
      (o.status === 'canceled' && o.cancelReason
        ? '<div class="hint" style="margin-top:4px">打回原因：' + esc(o.cancelReason) + '</div>' : '') +
      '</div>' +
      '<div style="text-align:right">' +
      '<div class="amt">' + money(o.amount) + '</div>' +
      (can
        ? '<button class="btn sm primary" data-confirm="' + esc(o.id) + '" style="margin-top:6px">确认收款并开通</button>' +
          '<button class="btn sm danger" data-reject="' + esc(o.id) + '" style="margin-top:6px">打回（没收到款）</button>'
        : '') +
      '</div></div>';
  }
  function renderOrders() {
    var list = filteredOrders();
    var wait = list.filter(function (o) { return o.status === 'pending' || o.status === 'claimed'; });
    var paid = list.filter(function (o) { return o.status === 'paid'; });
    var rest = list.filter(function (o) {
      return o.status !== 'pending' && o.status !== 'claimed' && o.status !== 'paid';
    });
    var paidAll = S.orders.filter(function (o) { return o.status === 'paid'; });
    var today = paidAll.filter(function (o) { return isTodayTs(o.paidAt); });
    var sum = function (l) { return l.reduce(function (a, o) { return a + Number(o.amount || 0); }, 0); };
    var html = '<div class="summary">' +
      '<span>待处理 <b class="' + (wait.length ? 'hot' : '') + '">' + wait.length + '</b> 笔</span>' +
      '<span>今日已开通 <b>' + today.length + '</b> 笔 · ' + money(sum(today)) + '</span>' +
      '<span>累计已开通 <b>' + paidAll.length + '</b> 笔 · ' + money(sum(paidAll)) + '</span>' +
      '</div>';
    if (!list.length) html += '<div class="empty">没有匹配的订单。</div>';
    if (wait.length) html += '<div class="hint" style="margin:6px 0">待处理 ' + wait.length + ' 笔</div>' +
      '<div class="orders">' + wait.map(orderCard).join('') + '</div>';
    if (paid.length) html += '<div class="hint" style="margin:14px 0 6px">最近已开通</div>' +
      '<div class="orders">' + paid.slice(0, 20).map(orderCard).join('') + '</div>';
    if (rest.length) html += '<div class="hint" style="margin:14px 0 6px">其它</div>' +
      '<div class="orders">' + rest.slice(0, 5).map(orderCard).join('') + '</div>';
    $('orderList').innerHTML = html;
    $$('[data-confirm]', $('orderList')).forEach(function (b) {
      b.addEventListener('click', function () { confirmOrder(b.getAttribute('data-confirm'), b); });
    });
    $$('[data-reject]', $('orderList')).forEach(function (b) {
      b.addEventListener('click', function () { rejectOrder(b.getAttribute('data-reject'), b); });
    });
    $$('[data-copy]', $('orderList')).forEach(function (b) {
      b.addEventListener('click', function () { copyText(b.getAttribute('data-copy'), '订单号已复制'); });
    });
  }
  function rejectOrder(id, btn) {
    ask({
      title: '打回订单（未收到付款）',
      body: '订单 ' + id + ' 没收到款？\n打回后该订单作废（客户端会显示「已作废」），\n' +
            '不会开通会员、不计收入；用户可以重新下单。',
      input: true,
      placeholder: '原因（可选，会写进操作日志，例如：收款码没备注订单号）',
      ok: '确认打回',
      danger: true
    }, function (reason) {
      if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
      api('/ai/admin/reject', { id: id, reason: reason || '' }).then(function (res) {
        if (!res.data.ok) {
          err(res);
          if (btn) { btn.disabled = false; btn.textContent = '打回（没收到款）'; }
          return;
        }
        say('已打回：' + id + '（未收到付款，未开通会员）', 'ok');
        refresh(true);
      });
    });
  }
  function confirmOrder(id, btn) {
    ask({
      title: '确认收款并开通',
      body: '确认已收到订单 ' + id + ' 的款项？\n确认后会立即为其开通会员。'
    }, function () {
      if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
      api('/ai/admin/confirm', { id: id }).then(function (res) {
        if (!res.data.ok) { err(res); if (btn) { btn.disabled = false; btn.textContent = '确认收款并开通'; } return; }
        say('已开通：' + id + '，会员到期 ' + fmtTime(res.data.memberUntil), 'ok');
        refresh(true);
      });
    });
  }

  /* ---------------------------------------------------------- 收款码 */
  function renderPay() {
    var d = S.paycodes;
    if (!d) { $('pcWrap').innerHTML = '<div class="empty">正在加载…</div>'; return; }
    var names = { day: '日卡', month: '月卡' };
    var mnames = { wechat: '微信', alipay: '支付宝' };
    var html = '<div class="pc-grid">';
    d.items.forEach(function (it) {
      var ts = it.updated ? ('?t=' + it.updated) : '';
      html += '<div class="pc ' + (it.exists ? 'has' : '') + '">' +
        '<div class="kv-inline" style="justify-content:center;margin-bottom:8px">' +
        '<b>' + (names[it.plan] || it.plan) + ' · ' + (mnames[it.method] || it.method) + '</b></div>' +
        (it.exists
          ? '<img src="' + it.url + ts + '" alt="收款码">'
          : '<div class="ph">还没有上传</div>') +
        '<div class="hint" style="margin:8px 0 10px">' +
        (it.exists ? Math.round(it.size / 1024) + ' KB · ' + fmtTime(it.updated) : '客户端会退回兜底收款码') + '</div>' +
        '<div class="chips" style="justify-content:center">' +
        '<label class="btn sm">' + (it.exists ? '替换' : '上传') +
        '<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none" ' +
        'data-upload="' + it.plan + '|' + it.method + '"></label>' +
        (it.exists ? '<button class="btn sm danger" data-delpc="' + it.plan + '|' + it.method + '">删除</button>' : '') +
        '</div></div>';
    });
    html += '</div>';
    if (d.legacy && d.legacy.exists) {
      html += '<div class="hint" style="margin-top:14px">检测到旧版兜底收款码 <code>data/paycode.png</code>，' +
        '已上传的套餐收款码会优先生效。</div>';
    }
    $('pcWrap').innerHTML = html;
    $$('[data-upload]', $('pcWrap')).forEach(function (inp) {
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        if (!f) return;
        if (f.size > 4 * 1024 * 1024) { say('图片太大（上限 4 MB）', 'err'); return; }
        var parts = inp.getAttribute('data-upload').split('|');
        var fr = new FileReader();
        fr.onload = function () {
          say('正在上传…', 'info');
          api('/ai/admin/paycode/upload', { plan: parts[0], method: parts[1], data: fr.result })
            .then(function (res) {
              if (!res.data.ok) return err(res);
              S.paycodes = res.data;
              renderPay();
              say('收款码已更新（' + parts[0] + '/' + parts[1] + '）', 'ok');
            });
        };
        fr.readAsDataURL(f);
      });
    });
    $$('[data-delpc]', $('pcWrap')).forEach(function (b) {
      b.addEventListener('click', function () {
        var parts = b.getAttribute('data-delpc').split('|');
        ask({ title: '删除收款码', body: '删除 ' + parts[0] + '/' + parts[1] + ' 的收款码？', danger: true }, function () {
          api('/ai/admin/paycode/delete', { plan: parts[0], method: parts[1] }).then(function (res) {
            if (!res.data.ok) return err(res);
            S.paycodes = res.data;
            renderPay();
            say('已删除收款码', 'ok');
          });
        });
      });
    });
  }

  /* ---------------------------------------------------------- 日志与安全 */
  function renderLogs() {
    var rows = S.logs;
    $('logHint').textContent = '最近 ' + rows.length + ' 条（服务端保留 500 条）';
    $('logList').innerHTML = rows.length
      ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>时间</th><th>操作</th><th>对象</th>' +
        '<th>详情</th><th>来源 IP</th></tr></thead><tbody>' +
        rows.map(function (l) {
          return '<tr><td class="mono">' + fmtTime(l.t) + '</td><td><b>' + esc(l.action) + '</b></td>' +
            '<td>' + esc(l.target || '-') + '</td><td class="wrap">' + esc(l.detail || '-') + '</td>' +
            '<td class="mono">' + esc(l.ip || '-') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '<div class="empty">还没有后台操作记录。做一次「确认收款」「加天数」之类的操作就会出现在这里。</div>';
    var g = (S.guard && S.guard.guard) || { name: [], ip: [] };
    var p = (S.guard && S.guard.policy) || {};
    var guardRows = [];
    (g.name || []).forEach(function (r) {
      guardRows.push(['用户名', r.key, r.fails, r.locked, r.waitSec]);
    });
    (g.ip || []).forEach(function (r) {
      guardRows.push(['来源 IP', r.key, r.fails, r.locked, r.waitSec]);
    });
    $('guardList').innerHTML = guardRows.length
      ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>维度</th><th>值</th><th>失败次数</th>' +
        '<th>状态</th></tr></thead><tbody>' +
        guardRows.map(function (r) {
          return '<tr><td>' + r[0] + '</td><td class="mono">' + esc(r[1]) + '</td><td>' + r[2] + '</td>' +
            '<td>' + (r[3] ? '<span class="badge b-off">锁定中 · 还需 ' + Math.ceil(r[4] / 60) + ' 分钟</span>'
                           : '<span class="badge b-none">仅计数</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="hint" style="margin-top:10px">策略：同一账号连续失败 ' + (p.maxFail || 5) + ' 次锁定 ' +
        Math.round((p.lockSec || 600) / 60) + ' 分钟；同一 IP ' + (p.ipMaxFail || 20) + ' 次；窗口 ' +
        Math.round((p.windowSec || 900) / 60) + ' 分钟。锁定会在成功登录后自动清零。</div>'
      : '<div class="empty">当前没有被锁定或计数中的登录失败记录。</div>';
    $('failList').innerHTML = S.adminFails.length
      ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>时间</th><th>来源 IP</th></tr></thead><tbody>' +
        S.adminFails.map(function (f) {
          return '<tr><td class="mono">' + fmtTime(f.t) + '</td><td class="mono">' + esc(f.ip || '-') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="hint" style="margin-top:10px">有人拿着错误的管理员密钥访问后台时会记在这里；' +
        '只存在服务端内存里（重启即清空），不会被人刷成磁盘炸弹。</div>'
      : '<div class="empty">没有记录到密钥错误尝试。</div>';
  }

  /* ---------------------------------------------------------- 数据加载 */
  function loadTab(tab, cb) {
    if (!S.key) { cb && cb(); return; }
    if (tab === 'dash') loadOverview(cb);
    else if (tab === 'users') loadUsers(cb);
    else if (tab === 'orders') loadOrders(cb);
    else if (tab === 'pay') loadPaycodes(cb);
    else if (tab === 'logs') loadLogs(cb);
    else if (tab === 'settings') loadSettings(cb);
  }
  function loadOverview(cb) {
    need('/ai/admin/overview').then(function (res) {
      if (!res.data.ok) { err(res); cb && cb(); return; }
      S.kpi = res.data.kpi; S.series = res.data.series || []; S.topUsers = res.data.topUsers || [];
      S.plans = res.data.plans || [];
      if (S.kpi && S.kpi.rev != null) S.rev = S.kpi.rev;
      S.ready = true;
      renderDash();
      paintBadges();
      cb && cb();
    }).catch(function (e) {
      say('无法连接服务（已自动重试一次）：' + e, 'err');
      // 4.1.7：不要再留一整块空白 —— 明确告诉人「没加载出来 + 怎么办」
      if (!S.kpi) {
        $('kpiRow').innerHTML = '<div class="card kpi">' +
          '<div class="k-top"><span class="k-ico red">!</span>概览数据没加载出来</div>' +
          '<div class="k-val">—</div><div class="k-sub">点右上角 <b>↻</b> 重试；' +
          '若反复失败，多半是本机代理把 HTTP 响应截断了（见 README「后台偶发空白」）</div></div>';
      }
      cb && cb();
    });
  }
  function loadUsers(cb) {
    need('/ai/admin/users').then(function (res) {
      if (!res.data.ok) { $('users').innerHTML = '<div class="empty err">' +
        ((res.data && res.data.error) || '加载失败') + '</div>'; err(res); cb && cb(); return; }
      FREE_DAILY = Number(res.data.freeDaily || FREE_DAILY);
      MEMBER_CAP = Number(res.data.memberCap || MEMBER_CAP);
      S.users = res.data.users || [];
      S.ready = true;
      renderUsers();
      paintBadges();
      if (S.openUser) openDrawer(S.openUser);
      cb && cb();
    }).catch(function (e) { say('无法连接服务：' + e, 'err'); cb && cb(); });
  }
  function loadOrders(cb) {
    need('/ai/admin/orders').then(function (res) {
      if (!res.data.ok) { $('orderList').innerHTML = '<div class="empty err">' +
        ((res.data && res.data.error) || '加载失败') + '</div>'; err(res); cb && cb(); return; }
      S.orders = res.data.orders || [];
      renderOrders();
      paintBadges();
      cb && cb();
    }).catch(function (e) { say('无法连接服务：' + e, 'err'); cb && cb(); });
  }
  function loadLogs(cb) {
    need('/ai/admin/logs').then(function (res) {
      if (!res.data.ok) { err(res); cb && cb(); return; }
      S.logs = res.data.logs || [];
      renderLogs();
      if (S.tab === 'dash') renderDash();
      cb && cb();
    });
    need('/ai/admin/security').then(function (res) {
      if (res.data.ok) { S.guard = res.data; S.adminFails = res.data.adminFails || []; renderLogs(); }
      cb && cb();
    });
  }
  function loadPaycodes(cb) {
    need('/ai/admin/paycode/list').then(function (res) {
      if (!res.data.ok) { err(res); cb && cb(); return; }
      S.paycodes = res.data;
      renderPay();
      cb && cb();
    });
  }
  function loadSettings(cb) {
    loadOverview(function () { renderDash(); cb && cb(); });
    loadLogs(function () {});
  }
  function paintBadges() {
    var live = S.live || {};
    $('navUsers').textContent = S.users.length ? S.users.length : Number(live.accounts || 0);
    var pending = live.pendingOrders != null ? live.pendingOrders
      : S.orders.filter(function (o) { return o.status === 'pending' || o.status === 'claimed'; }).length;
    var el = $('navOrders');
    el.textContent = pending;
    el.className = 'pill' + (pending ? ' hot' : '');
  }

  /* ---------------------------------------------------------- 实时轮询 */
  function setLive(state, text) {
    $('liveDot').className = 'dot' + (state === 'on' ? ' on' : (state === 'paused' ? ' warn' : ''));
    $('liveText').textContent = text;
  }
  function poll() {
    if (!S.key) { setLive('off', '等待密钥'); return; }
    if (document.hidden) { setLive('paused', '已暂停（标签页未激活）'); return; }
    if (S.busy) return;
    S.busy = true;
    api('/ai/admin/poll', {}).then(function (res) {
      S.busy = false;
      if (!res.data.ok) {
        if (res.status === 403) { setLive('off', '密钥不正确'); }
        return;
      }
      var d = res.data;
      S.live = d;
      setLive('on', fmtClock(d.ts));
      $('syncText').textContent = '已同步 ' + fmtClock(d.ts);
      var revEl = $('revText');
      if (revEl) revEl.textContent = d.rev;
      var syncEl = $('syncText2');
      if (syncEl) syncEl.textContent = fmtClock(d.ts);
      // 新订单提醒（只在真的变多时提醒一次）
      if (S.lastPending >= 0 && d.pendingOrders > S.lastPending) {
        say('有新的待处理订单（' + d.pendingOrders + ' 笔）', 'info');
      }
      S.lastPending = d.pendingOrders;
      paintBadges();
      if (S.rev !== -1 && d.rev !== S.rev) {
        S.rev = d.rev;
        loadTab(S.tab);
      } else if (S.rev === -1) {
        S.rev = d.rev;
      }
    }).catch(function () {
      S.busy = false;
      setLive('off', '连接中断，正在重试');
    });
  }
  function refresh(force) {
    if (!S.key) { needKey(true); return; }
    loadTab(S.tab, function () { if (force) poll(); });
  }

  /* ---------------------------------------------------------- 绑定 */
  $('refresh').addEventListener('click', function () { refresh(true); });
  $('keyBtn').addEventListener('click', function () { needKey(true); });
  $('save').addEventListener('click', function () {
    S.key = $('key').value.trim();
    try { localStorage.setItem(KEY_STORE, S.key); } catch (e) {}
    $('key2').value = S.key;
    if (!S.key) { say('已清空密钥', 'info'); return; }
    say('密钥已保存在本浏览器', 'ok');
    S.loaded = {}; S.rev = -1; S.lastPending = -1;
    refresh(true);
  });
  $('clear').addEventListener('click', function () {
    S.key = ''; $('key').value = ''; $('key2').value = '';
    try { localStorage.removeItem(KEY_STORE); } catch (e) {}
    say('已清除本浏览器里的密钥', 'info');
    setLive('off', '等待密钥');
  });
  $('uq').addEventListener('input', function () { S.q = $('uq').value; S.page = 1; renderUsers(); });
  $('uSort').addEventListener('change', function () { S.sort = $('uSort').value; renderUsers(); });
  $$('#uFilters .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      S.filter = c.getAttribute('data-uf'); S.page = 1;
      $$('#uFilters .chip').forEach(function (x) { x.classList.toggle('on', x === c); });
      renderUsers();
    });
  });
  $('ncreate').addEventListener('click', createAccount);
  $('uresetall').addEventListener('click', function () { allReset(); });
  $('resetAll2').addEventListener('click', function () { allReset(); });
  function allReset() {
    ask({
      title: '全部重置今日用量',
      body: '把所有账号的「今日用量」清零？\n（累计调用数保留，不可撤销）',
      danger: true
    }, function () {
      api('/ai/admin/reset', { all: true }).then(function (res) {
        if (!res.data.ok) return err(res);
        after('已重置全部账号的今日用量（' + (res.data.count || 0) + ' 个账号）');
      });
    });
  }
  $$('[data-batch]').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-batch');
      if (k === 'clear') { S.sel = {}; renderUsers(); return; }
      batch(k);
    });
  });
  $('uExport').addEventListener('click', function () {
    var list = filteredUsers();
    var rows = [['用户名', '显示名', '用户ID', '状态', '档位', '注册时间', '最后登录', '最后IP',
                 '今日免费', '今日会员', '今日不限量', '累计调用', '会员到期', '备注']];
    list.forEach(function (u) {
      rows.push([u.username, u.displayName, u.userId,
        u.status === 'disabled' ? '已停用' : '正常',
        u.free ? '免费不限量' : (u.member ? '会员' : '免费版'),
        fmtTime(u.created || u.first), fmtTime(u.lastLogin || u.last), u.lastIP,
        u.freeUsedToday, u.memberUsedToday, u.unlimitedUsedToday, u.totalCalls,
        u.member ? fmtTime(u.memberUntil) : '', u.note]);
    });
    download('轻提词用户_' + todayStr() + '.csv', csv(rows));
    say('已导出 ' + list.length + ' 个账号', 'ok');
  });
  $('oq').addEventListener('input', function () { S.oq = $('oq').value; renderOrders(); });
  $$('#oFilters .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      S.ofilter = c.getAttribute('data-of');
      $$('#oFilters .chip').forEach(function (x) { x.classList.toggle('on', x === c); });
      renderOrders();
    });
  });
  $('oRefresh').addEventListener('click', function () { loadOrders(); });
  $('oExport').addEventListener('click', function () {
    var rows = [['订单号', '用户名', '套餐', '天数', '金额', '状态', '下单时间', '开通时间', '到期时间']];
    filteredOrders().forEach(function (o) {
      rows.push([o.id, o.name, o.planName || o.plan, o.days, Number(o.amount || 0).toFixed(2),
        statusText(o.status), fmtTime(o.created), o.paidAt ? fmtTime(o.paidAt) : '',
        o.memberUntil ? fmtTime(o.memberUntil) : '']);
    });
    download('轻提词订单_' + todayStr() + '.csv', csv(rows));
    say('已导出 ' + filteredOrders().length + ' 笔订单', 'ok');
  });
  $('grant').addEventListener('click', function () {
    var u = ($('uname').value || '').trim(), d = parseInt($('days').value, 10) || 0;
    if (!u || d <= 0) { say('请填写用户名与天数', 'err'); return; }
    ask({ title: '手工加天数', body: '给「' + u + '」加 ' + d + ' 天会员？' }, function () {
      api('/ai/admin/grant', { username: u, days: d }).then(function (res) {
        if (!res.data.ok) return err(res);
        after('已给 ' + u + ' 加 ' + d + ' 天，会员到期 ' + fmtTime(res.data.memberUntil));
      });
    });
  });
  $('lookup').addEventListener('click', function () {
    var u = ($('uname').value || '').trim();
    if (!u) { say('请填写用户名', 'err'); return; }
    api('/ai/admin/lookup', { username: u }).then(function (res) {
      if (!res.data.ok) return err(res);
      var q = res.data.quota || {};
      say('用户：' + res.data.username + '（id=' + res.data.userId + '）\n' +
        '会员到期：' + (q.memberUntil ? fmtTime(q.memberUntil) : '未开通') + '\n' +
        '今日：免费 ' + q.freeUsedToday + '/' + q.freeQuota + ' 次，会员 ' + q.memberUsedToday + '/' +
        q.memberCap + ' 次\n今日剩余：' + q.remainingToday + '，累计调用：' + q.totalCalls, 'ok');
    });
  });
  $('logRefresh').addEventListener('click', function () { loadLogs(); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { poll(); }
  });

  /* ---------------------------------------------------------- 启动 */
  (function init() {
    try { S.key = localStorage.getItem(KEY_STORE) || ''; } catch (e) { S.key = ''; }
    try {
      var t = localStorage.getItem(THEME_STORE);
      setTheme(t === 'dark' ? 'dark' : 'light');
    } catch (e) { setTheme('light'); }
    $('key').value = S.key;
    $('key2').value = S.key;
    $('verText').textContent = 'v' + VERSION;
    $('out').textContent = '';
    // 版本从服务端读（页面里那个 VERSION 只是连不上时的兜底）
    fetch('/ai/health').then(function (r) { return r.json(); }).then(function (d) {
      S.health = d || {};
      if (S.health.version) $('verText').textContent = 'v' + S.health.version;
      if (S.tab === 'settings') renderDash();
    }).catch(function () {});
    goto('dash');
    setInterval(poll, POLL_MS);
    if (S.key) { poll(); }
    else { needKey(true); setLive('off', '等待密钥'); }
  })();
})();
</script>
</body>
</html>
"""


# ============================== DeepSeek 调用 ==============================


def call_deepseek(text, system_prompt):
    if MOCK:
        time.sleep(0.4)
        head = text.strip().split("\n")[0][:12] or "内容"
        return "%s：\n\n（MP_MOCK 本地模拟结果）\n1、已收到 %d 个字符的输入；\n2、正式环境会返回 DeepSeek 润色后的内容。" % (
            head,
            len(text),
        )
    req_body = json.dumps(
        {
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            "temperature": 0.3,
            "stream": False,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=req_body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + DEEPSEEK_KEY,
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return clean_result(data["choices"][0]["message"]["content"])


# ============================== HTTP 处理 ==============================


class Handler(BaseHTTPRequestHandler):
    server_version = "MicroPromptAI/" + VERSION
    store = None  # 由 main 注入

    def end_headers(self):
        """统一补一行 Connection: close（4.1.6）。

        为什么必须写：本服务是 HTTP/1.0（BaseHTTPRequestHandler 默认），
        默认行为就是"一次请求一条连接、回完即关"，但**响应头里没有明说**。
        Chrome 遇到没有 Connection 头的 HTTP/1.0 响应时，会把这条连接放回连接池
        继续复用；等它复用到一个服务端已经关掉的 socket 上，响应就会被截断，
        控制台报 net::ERR_CONTENT_LENGTH_MISMATCH —— 表现为后台偶发空白
        （概览页 KPI/图表整块不出来，只弹一句"无法连接服务"）。
        实测：线上面板每几次加载就会中一次；Node/curl 不会（它们不复用 HTTP/1.0 连接）。
        明说 close 之后浏览器不再复用，这个竞态就没了。顺带也让 send_header
        把 close_connection 置为 True，与本服务"短连接"的定位一致。
        """
        self.send_header("Connection", "close")
        BaseHTTPRequestHandler.end_headers(self)

    # ---- 基础输出 ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key"
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ok(self, **kw):
        obj = {"ok": True}
        obj.update(kw)
        self._json(obj, 200)

    def _err(self, message, code="error", http=400):
        self._json({"ok": False, "error": message, "code": code}, http)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _raw_body(self, limit=AVATAR_MAX_BYTES + 65536):
        """原样读请求体（登录是 form-urlencoded、头像是 multipart，都不能按 JSON 解析）。"""
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except Exception:
            return b""
        if length <= 0 or length > limit:
            return b""
        try:
            return self.rfile.read(length)
        except Exception:
            return b""

    def _drain(self, length, cap=32 * 1024 * 1024):
        """把（超限的）请求体读掉再回错误。
        直接回错误会让仍在发送数据的客户端收到 RST，浏览器只看到「网络错误」，
        反而掩盖了「文件太大」这个真正的原因。"""
        left = min(int(length or 0), cap)
        while left > 0:
            try:
                chunk = self.rfile.read(min(65536, left))
            except Exception:
                return
            if not chunk:
                return
            left -= len(chunk)

    def _token(self):
        auth = self.headers.get("Authorization", "") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return ""

    def _html(self, page):
        body = page.encode("utf-8")
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        q = urllib.parse.urlparse(self.path).query
        return dict(urllib.parse.parse_qsl(q))

    def _path(self):
        return urllib.parse.urlparse(self.path).path

    def _file(self, path, content_type, download_name=None, head_only=False):
        """发一个（可能很大的）静态文件：分块写，避免把 5MB exe 一次读进内存。

        只用于 /updates —— 更新包本身不敏感（客户端还要按清单里的 SHA-256 校验），
        所以不校验登录态；路径穿越在调用处已被拦掉。
        """
        if not os.path.isfile(path):
            self._err("更新文件不存在", "not_found", 404)
            return
        try:
            size = os.path.getsize(path)
        except OSError as e:
            self._err("读取更新文件失败：%s" % e, "io", 500)
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        # 清单必须每次现取（否则发新版后客户端还看旧版本号）；文件本身可以短缓存
        self.send_header("Cache-Control", "no-cache" if download_name is None else "public, max-age=300")
        self.send_header("Accept-Ranges", "none")
        if download_name:
            self.send_header(
                "Content-Disposition",
                'attachment; filename="%s"' % download_name.encode("ascii", "ignore").decode("ascii") or "update.bin",
            )
        self.end_headers()
        if head_only:
            return
        try:
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(UPDATE_CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # 客户端中途取消下载：正常现象，别刷日志
            pass

    def _updates_route(self, path, head_only=False):
        """返回 True 表示已处理（/updates/*）"""
        if path == "/updates" or path == "/updates/":
            self._json({"ok": True, "usage": ["/updates/latest.json", "/updates/files/<name>"]})
            return True
        if path == "/updates/latest.json":
            self._file(os.path.join(UPDATES_DIR, "latest.json"),
                       "application/json; charset=utf-8", head_only=head_only)
            return True
        prefix = "/updates/files/"
        if path.startswith(prefix):
            name = urllib.parse.unquote(path[len(prefix):])
            # 只允许纯文件名：挡掉 ../ 、子目录与隐藏文件
            if (not name) or ("/" in name) or ("\\" in name) or name.startswith(".") or name != os.path.basename(name):
                self._err("非法的更新文件名", "bad_name", 400)
                return True
            fp = os.path.join(UPDATES_DIR, "files", name)
            self._file(fp, "application/octet-stream", download_name=name, head_only=head_only)
            return True
        return False

    def _need_user(self):
        """返回 (uid, name)；失败时已写好响应并返回 None。"""
        try:
            return resolve_user(self.store, self._token())
        except AuthError as e:
            self._err(e.message, "auth", 401)
            return None

    def _need_admin(self):
        key = self.headers.get("X-Admin-Key", "") or self._query().get("key", "")
        if not self.store.check_admin(key):
            # 失败记录只进内存：被人拿错密钥猛刷时，也不能变成磁盘写入放大
            self.store.admin_fail(self.client_address[0] if self.client_address else "")
            self._err("管理员密钥不正确", "admin_auth", 403)
            return False
        return True

    def _audit(self, action, target="", detail=""):
        """后台操作留痕：谁、什么时候、对谁做了什么（在 /admin 的「日志」页可见）。"""
        self.store.audit(action, target=target, detail=detail,
                         ip=self.client_address[0] if self.client_address else "")

    def log_message(self, *args):  # 静默，避免刷日志
        pass

    # ---- 路由 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_HEAD(self):
        """只给 /updates 用：运维确认更新包在不在、多大（curl -I）"""
        path = self._path()
        if self._updates_route(path, head_only=True):
            return
        self.send_response(404)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = self._path()
        if self._updates_route(path):
            return
        if path in ("/admin", "/admin/"):
            self._html(ADMIN_PAGE)
            return
        if path == "/ai/health":
            self._ok(service="microprompt-ai", version=VERSION, mock=MOCK,
                     authMode=AUTH_MODE, accounts=len(self.store.accounts))
            return
        if path == "/ai/quota":
            user = self._need_user()
            if not user:
                return
            self._ok(quota=self.store.quota_view(user[0]))
            return
        if path == "/ai/order":
            user = self._need_user()
            if not user:
                return
            oid = self._query().get("id", "")
            o = self.store.get_order(oid)
            if not o or o.get("userId") != user[0]:
                self._err("订单不存在", "not_found", 404)
                return
            self._ok(order=self._safe_order(o), quota=self.store.quota_view(user[0]))
            return
        if path == "/ai/paycodes":
            self._paycodes_manifest()
            return
        if path == "/ai/paycode.png":
            self._paycode()
            return
        if path.startswith("/ai/paycode/"):
            parts = path[len("/ai/paycode/"):].split("/")
            plan = parts[0] if parts else ""
            method = parts[1][:-4] if len(parts) > 1 and parts[1].endswith(".png") else (
                parts[1] if len(parts) > 1 else "")
            if plan in self.PAYCODE_PLANS and method in self.PAYCODE_METHODS:
                self._paycode(plan, method)
                return
            self._err("收款码路径不对（应为 /ai/paycode/<套餐>/<方式>.png）", "not_found", 404)
            return
        if path == "/ai/plans":
            self._ok(plans=list(PLANS.values()), freeDaily=FREE_DAILY_QUOTA)
            return
        # ---- 4.1.0 账号兼容层（GET）----
        if path == "/api/get-account":
            self._api_get_account()
            return
        if path.startswith("/avatar/"):
            self._serve_avatar(path[len("/avatar/"):])
            return
        if path.startswith("/api/"):
            self._err("接口不存在", "not_found", 404)
            return
        self._err("not found", "not_found", 404)

    def do_POST(self):
        path = self._path()
        # 额度查询同时支持 POST：旧版服务端对 GET 会回 501 且不带 CORS 头，
        # 浏览器会当成"网络失败"，客户端就分不清"服务端旧版"和"连不上"。
        # 走 POST 时旧版会回带 CORS 头的 404，客户端即可准确提示"服务端还是旧版本"。
        if path == "/ai/quota":
            user = self._need_user()
            if not user:
                return
            self._ok(quota=self.store.quota_view(user[0]))
            return
        if path == "/ai/polish":
            self._do_polish()
            return
        if path == "/ai/order":
            self._do_create_order()
            return
        if path == "/ai/order/claim":
            self._do_claim_order()
            return
        if path == "/ai/orders/mine":
            user = self._need_user()
            if not user:
                return
            o = self.store.latest_order(user[0])
            self._ok(
                order=self._safe_order(o) if o else None,
                quota=self.store.quota_view(user[0]),
            )
            return
        if path == "/ai/admin/orders":
            if not self._need_admin():
                return
            self._ok(orders=self.store.list_orders(self._body().get("status") or None))
            return
        if path == "/ai/admin/confirm":
            if not self._need_admin():
                return
            oid = (self._body().get("id") or "").strip()
            order, err = self.store.confirm_order(oid)
            if err:
                self._err(err, "not_found", 404)
                return
            self._audit("确认收款开通", oid, "%s ￥%s / %s 天"
                        % (order.get("name"), order.get("amount"), order.get("days")))
            self._ok(order=order, memberUntil=order.get("memberUntil"))
            return
        if path == "/ai/admin/reject":
            if not self._need_admin():
                return
            body = self._body()
            oid = (body.get("id") or "").strip()
            reason = (body.get("reason") or "").strip()
            order, err, status = self.store.reject_order(oid, reason)
            if err:
                self._err(err, "not_rejectable" if status else "not_found",
                         status or 404)
                return
            self._audit("打回订单（未收到付款）", oid,
                        "%s · %s%s" % (order.get("name"), order.get("planName"),
                                       (" · " + reason) if reason else ""))
            self._ok(order=order)
            return
        if path == "/ai/admin/grant":
            if not self._need_admin():
                return
            body = self._body()
            name = (body.get("username") or "").strip()
            days = int(body.get("days") or 0)
            if not name or days <= 0:
                self._err("请提供 username 与正整数的 days", "bad_request", 400)
                return
            uid, u = self.store.find_user_by_name(name)
            if not uid:
                self._err("没有找到用户「%s」的登录记录" % name, "not_found", 404)
                return
            until = self.store.add_membership(uid, u.get("name"), days)
            self._audit("手工加天数", u.get("name"), "%d 天" % days)
            self._ok(userId=uid, username=u.get("name"), memberUntil=int(until),
                     quota=self.store.quota_view(uid))
            return
        if path == "/ai/admin/lookup":
            if not self._need_admin():
                return
            name = (self._body().get("username") or "").strip()
            uid, u = self.store.find_user_by_name(name)
            if not uid:
                self._err("没有找到用户「%s」的登录记录" % name, "not_found", 404)
                return
            self._ok(userId=uid, username=u.get("name"),
                     quota=self.store.quota_view(uid))
            return
        if path == "/ai/admin/users":
            if not self._need_admin():
                return
            self._ok(
                users=self.store.list_users(),
                freeDaily=FREE_DAILY_QUOTA,
                memberCap=MEMBER_DAILY_CAP,
            )
            return
        if path == "/ai/admin/reset":
            if not self._need_admin():
                return
            body = self._body()
            zero_total = bool(body.get("total"))
            if body.get("all"):
                n = self.store.reset_all_usage(zero_total=zero_total)
                log("admin reset ALL usage zeroTotal=%s count=%d" % (zero_total, n))
                self._audit("重置全部今日用量", "全部账号",
                            "含累计" if zero_total else "仅今日")
                self._ok(scope="all", count=n)
                return
            name = (body.get("username") or "").strip()
            if not name:
                self._err(
                    '请提供 username；要重置全部账号请传 {"all": true}',
                    "bad_request",
                    400,
                )
                return
            uid, u = self.store.find_user_by_name(name)
            if not uid:
                self._err("没有找到用户「%s」的登录记录" % name, "not_found", 404)
                return
            quota = self.store.reset_usage(uid, zero_total=zero_total)
            log("admin reset usage user=%s(%s) zeroTotal=%s" % (u.get("name"), uid, zero_total))
            self._audit("重置用量", u.get("name"), "含累计" if zero_total else "仅今日")
            self._ok(userId=uid, username=u.get("name"), quota=quota)
            return
        if path == "/ai/admin/free":
            if not self._need_admin():
                return
            body = self._body()
            name = (body.get("username") or "").strip()
            if not name:
                self._err("请提供 username", "bad_request", 400)
                return
            uid, u = self.store.find_user_by_name(name)
            if not uid:
                self._err("没有找到用户「%s」的登录记录" % name, "not_found", 404)
                return
            state = self.store.set_free(uid, u.get("name"), bool(body.get("on")))
            log("admin set free user=%s(%s) on=%s" % (u.get("name"), uid, state))
            self._audit("开通免费不限量" if state else "取消免费不限量", u.get("name"))
            self._ok(
                userId=uid,
                username=u.get("name"),
                free=state,
                quota=self.store.quota_view(uid),
            )
            return
        # ---- 4.1.2 后台实时 / 概览 / 日志 / 安全 / 收款码 ----
        if path == "/ai/admin/poll":
            if not self._need_admin():
                return
            self._ok(**self.store.admin_poll())
            return
        if path == "/ai/admin/overview":
            if not self._need_admin():
                return
            self._ok(
                kpi=self.store.admin_kpi(),
                series=self.store.stats_series(14),
                topUsers=self.store.admin_top_users(8),
                plans=list(PLANS.values()),
            )
            return
        if path == "/ai/admin/logs":
            if not self._need_admin():
                return
            self._ok(logs=list(self.store.admin_log))
            return
        if path == "/ai/admin/security":
            if not self._need_admin():
                return
            self._ok(**self.store.admin_security())
            return
        if path == "/ai/admin/paycode/list":
            if not self._need_admin():
                return
            self._ok(**self._paycode_admin_list())
            return
        if path == "/ai/admin/paycode/upload":
            if not self._need_admin():
                return
            self._paycode_upload()
            return
        if path == "/ai/admin/paycode/delete":
            if not self._need_admin():
                return
            self._paycode_delete()
            return
        # 预留：支付通道回调（通道到位后接这里自动开通，见 README）
        if path == "/ai/pay/notify":
            self._do_pay_notify()
            return
        # ---- 4.1.0 账号兼容层（POST）----
        if path == "/api/signup":
            self._api_signup()
            return
        if path == "/api/login/oauth/access_token":
            self._api_login()
            return
        if path == "/api/update-user":
            self._api_update_user()
            return
        if path == "/api/change-password":
            self._api_change_password()
            return
        if path == "/api/upload-resource":
            self._api_upload_resource()
            return
        if path.startswith("/api/"):
            self._err("接口不存在", "not_found", 404)
            return
        # ---- 4.1.0 后台账号管理 ----
        if path.startswith("/ai/admin/account/"):
            self._do_admin_account(path[len("/ai/admin/account/"):])
            return
        self._err("not found", "not_found", 404)

    # ---- 4.1.0 账号兼容层：形状照 Casdoor，客户端一行都不用改 ----

    def _api_signup(self):
        """POST /api/signup —— 客户端读 status / data / msg，失败时 msg 直接显示给用户。"""
        raw = self._raw_body(limit=64 * 1024)
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(body, dict):
                raise ValueError("not an object")
        except Exception:
            self._json({"status": "error", "msg": "请求格式不正确"}, 200)
            return
        name = (body.get("username") or "").strip()
        pwd = body.get("password") or ""
        if not name:
            self._json({"status": "error", "msg": "用户名不能为空"}, 200)
            return
        try:
            self.store.account_create(name, pwd)
        except ValueError as e:
            self._json({"status": "error", "msg": str(e)}, 200)
            return
        log("注册新账号：%s" % name)
        self._json({"status": "ok", "data": name}, 200)

    def _api_login(self):
        """POST /api/login/oauth/access_token —— form-urlencoded，OAuth2 密码模式。

        安全顺序：client 凭据 -> 锁定检查 -> 账号是否存在 -> 密码 -> 停用 -> 签发。
        「用户不存在」与「密码错误」共用一句话术，避免账号枚举。"""
        form = dict(urllib.parse.parse_qsl(
            self._raw_body().decode("utf-8", "replace")))
        cid = (form.get("client_id") or "").strip()
        csec = (form.get("client_secret") or "").strip()
        name = (form.get("username") or "").strip()
        pwd = form.get("password") or ""
        ip = self.client_address[0] if self.client_address else ""

        def fail(msg, err="invalid_grant"):
            self._json({"error": err, "error_description": msg}, 400)

        if not cid or not csec:
            fail("客户端凭据缺失", "invalid_client")
            return
        if AUTH_CLIENT_SECRET and csec != AUTH_CLIENT_SECRET:
            fail("客户端凭据不正确", "invalid_client")
            return
        locked, wait = self.store.guard_check(name, ip)
        if locked:
            fail("尝试次数过多，请 %d 分钟后再试" % max(1, int(wait + 59) // 60))
            return
        uid, acc = self.store.account_by_name(name)
        # acc 不存在时也跑一次同代价的哈希校验，避免用响应时间区分账号是否存在
        ok = verify_pwd(pwd, (acc or {}).get("pwd") or DUMMY_PWD_HASH)
        if not acc or not ok:
            self.store.guard_fail(name, ip)
            fail("用户名或密码不正确")
            return
        if (acc.get("status") or "active") != "active":
            # 只有在密码正确之后才提示停用，否则等于告诉攻击者这个账号存在
            fail("该账号已被停用，请联系客服")
            return
        self.store.guard_reset(name)
        if pwd_needs_upgrade(acc.get("pwd")):
            try:
                self.store.account_set_password(uid, pwd, bump=False)  # 无感升级哈希参数
            except Exception:
                pass
        acc = self.store.account_touch_login(uid, ip) or acc
        iat = int(now_ts())
        token = sign_jwt({
            "id": uid, "name": acc.get("name") or name, "sub": acc.get("name") or name,
            "ver": int(acc.get("tokenVer", 1)), "iss": "microprompt",
            "aud": "app-microprompt", "iat": iat, "exp": iat + JWT_TTL_SEC,
        }, self.store.jwt_secret)
        log("登录成功：%s（%s）" % (acc.get("name"), uid))
        self._json({"access_token": token, "token_type": "Bearer",
                    "expires_in": JWT_TTL_SEC}, 200)

    def _api_get_account(self):
        """GET /api/get-account —— 只白名单输出（绝不含 pwd / tokenVer）。"""
        try:
            uid, _name = resolve_user(self.store, self._token())
        except AuthError as e:
            self._json({"status": "error", "msg": e.message}, 401)
            return
        _, acc = self.store.account_by_id(uid)
        if not acc:
            self._json({"status": "error", "msg": "登录已过期"}, 401)
            return
        self._json({"status": "ok", "data": self.store.account_public(acc)}, 200)

    def _api_update_user(self):
        """POST /api/update-user —— 只接受 displayName / avatar，身份一律取自令牌。"""
        try:
            uid, _name = resolve_user(self.store, self._token())
        except AuthError as e:
            self._json({"status": "error", "msg": e.message}, 401)
            return
        body = self._body()
        dn = body.get("displayName")
        av = body.get("avatar")
        try:
            self.store.account_set_profile(
                uid,
                display_name=None if dn is None else str(dn),
                avatar=None if av is None else str(av),
            )
        except ValueError as e:
            self._json({"status": "error", "msg": str(e)}, 200)
            return
        self._json({"status": "ok"}, 200)

    def _api_change_password(self):
        """POST /api/change-password —— 用户自己改密码（4.1.8）。

        形状照 Casdoor：{"status": "ok"|"error", "msg": ..., "data": ...}，msg 可直接给用户看。

        安全约定（都是刻意这么写的）：
          · 必须带登录令牌；身份**只**从令牌取，绝不接受客户端传 uid / 用户名，
            否则就是"拿着自己的令牌改别人的密码"；
          · **必须验原密码** —— 手机/电脑被临时借用时，不能直接就把密码改掉；
          · 新密码 8~128 位（与注册同一套规则），且不能与原密码相同；
          · 改完 tokenVer +1：其它设备上的旧令牌立刻失效（被踢下线），
            同时**返回一个用新 ver 签发的令牌**，让当前这台设备不用重新登录；
          · 失败信息不区分"账号不存在"与"原密码错误"（账号枚举防护，与登录一致）。
        """
        try:
            uid, name = resolve_user(self.store, self._token())
        except AuthError as e:
            self._json({"status": "error", "msg": e.message}, 401)
            return
        body = self._body()
        old = body.get("oldPassword")
        new = body.get("newPassword")
        if old is None:
            old = body.get("old_password") or ""
        if new is None:
            new = body.get("new_password") or ""
        old = str(old or "")
        new = str(new or "")

        _uid2, acc = self.store.account_by_id(uid)
        if not acc:
            self._json({"status": "error", "msg": "账号不存在"}, 200)
            return
        if not verify_pwd(old, acc.get("pwd") or DUMMY_PWD_HASH):
            log("改密失败（原密码不正确）：%s" % name)
            self._json({"status": "error", "msg": "原密码不正确"}, 200)
            return
        if len(new) < 8:
            self._json({"status": "error", "msg": "新密码至少 8 位"}, 200)
            return
        if len(new) > 128:
            self._json({"status": "error", "msg": "新密码最长 128 位"}, 200)
            return
        if new == old:
            self._json({"status": "error", "msg": "新密码不能与原密码相同"}, 200)
            return
        try:
            acc = self.store.account_set_password(uid, new, bump=True)
        except ValueError as e:
            self._json({"status": "error", "msg": str(e)}, 200)
            return
        # 旧令牌全部失效，给当前设备补一张新令牌（否则用户会被自己踢下线）
        iat = int(now_ts())
        token = sign_jwt({
            "id": uid, "name": acc.get("name") or name, "sub": acc.get("name") or name,
            "ver": int(acc.get("tokenVer", 1)), "iss": "microprompt",
            "aud": "app-microprompt", "iat": iat, "exp": iat + JWT_TTL_SEC,
        }, self.store.jwt_secret)
        log("修改密码成功：%s（其它设备的旧令牌已失效）" % name)
        self._json({"status": "ok", "data": {
            "access_token": token, "token_type": "Bearer",
            "expires_in": JWT_TTL_SEC, "tokenVer": int(acc.get("tokenVer", 1)),
        }}, 200)

    def _api_upload_resource(self):
        """POST /api/upload-resource —— 头像上传（multipart，≤2MB，按魔数校验）。"""
        try:
            uid, _name = resolve_user(self.store, self._token())
        except AuthError as e:
            self._json({"status": "error", "msg": e.message}, 200)
            return
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except Exception:
            length = 0
        if length <= 0:
            self._json({"status": "error", "msg": "没有收到文件"}, 200)
            return
        if length > AVATAR_MAX_BYTES + 65536:
            self._drain(length)          # 先读掉再报错，避免客户端收到 RST
            self._json({"status": "error", "msg": "头像不能超过 2 MB"}, 200)
            return
        parts = parse_multipart(self._raw_body(),
                               self.headers.get("Content-Type", ""))
        data = (parts.get("file") or {}).get("data") or b""
        if not data:
            self._json({"status": "error", "msg": "没有收到文件"}, 200)
            return
        if len(data) > AVATAR_MAX_BYTES:
            self._json({"status": "error", "msg": "头像不能超过 2 MB"}, 200)
            return
        ext = sniff_image_ext(data)
        if not ext:
            self._json({"status": "error", "msg": "只支持 PNG / JPG / WebP 图片"}, 200)
            return
        fname = self.store.avatar_save(uid, data, ext)
        host = self.headers.get("Host") or ("127.0.0.1:%d" % AUTH_PORT)
        log("上传头像：%s -> %s" % (uid, fname))
        self._json({"status": "ok", "data": "http://%s/avatar/%s" % (host, fname)}, 200)

    def _serve_avatar(self, filename):
        path = self.store.avatar_path(urllib.parse.unquote(filename or ""))
        if not path:
            self._err("头像不存在", "not_found", 404)
            return
        try:
            with open(path, "rb") as f:
                blob = f.read()
        except Exception:
            self._err("头像读取失败", "io_error", 500)
            return
        ext = path.rsplit(".", 1)[-1].lower()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", AVATAR_EXTS.get(ext, "application/octet-stream"))
        self.send_header("Cache-Control", "public, max-age=300")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        try:
            self.wfile.write(blob)
        except Exception:
            pass

    # ---- 4.1.0 后台：账号管理 ----
    def _do_admin_account(self, action):
        if not self._need_admin():
            return
        body = self._body()
        name = (body.get("name") or body.get("username") or "").strip()
        store = self.store

        if action == "list":
            self._ok(accounts=store.list_accounts())
            return

        if action == "create":
            try:
                acc = store.account_create(
                    name,
                    body.get("password") or "",
                    uid=(body.get("uid") or "").strip() or None,
                    display_name=body.get("displayName") or "",
                    note=body.get("note") or "",
                )
            except ValueError as e:
                self._err(str(e), "bad_request", 400)
                return
            log("后台新建账号：%s（%s）" % (acc.get("name"), acc.get("id")))
            self._audit("新建账号", acc.get("name"), "id=%s" % acc.get("id"))
            self._ok(account=store.account_admin_view(acc))
            return

        uid, acc = store.account_by_name(name)
        if not uid:
            self._err("账号不存在：%s" % (name or "(空)"), "not_found", 404)
            return

        if action == "resetpwd":
            temp = _temp_password()
            try:
                store.account_set_password(uid, temp, bump=True)
            except ValueError as e:
                self._err(str(e), "bad_request", 400)
                return
            log("后台重置密码：%s（%s）" % (acc.get("name"), uid))
            self._audit("重置密码", acc.get("name"), "已签发一次性临时密码")
            self._ok(username=acc.get("name"), tempPassword=temp)
            return

        if action == "status":
            want = "disabled" if (body.get("status") or "") == "disabled" else "active"
            acc = store.account_set_status(uid, want)
            log("后台%s账号：%s（%s）" % ("停用" if want == "disabled" else "启用",
                                     acc.get("name"), uid))
            self._audit("停用账号" if want == "disabled" else "启用账号", acc.get("name"))
            self._ok(account=store.account_admin_view(acc))
            return

        if action == "kick":
            acc = store.account_bump_ver(uid)
            log("后台踢下线：%s（%s）" % (acc.get("name"), uid))
            self._audit("踢下线", acc.get("name"), "凭证版本 -> %s" % acc.get("tokenVer"))
            self._ok(account=store.account_admin_view(acc))
            return

        if action == "note":
            acc = store.account_set_note(uid, body.get("note") or "")
            self._audit("修改备注", acc.get("name"), (body.get("note") or "")[:60])
            self._ok(account=store.account_admin_view(acc))
            return

        self._err("未知的账号操作：%s" % action, "not_found", 404)

    # ---- 各接口实现 ----
    def _safe_order(self, o):
        return {
            "id": o.get("id"),
            "plan": o.get("plan"),
            "planName": o.get("planName"),
            "days": o.get("days"),
            "amount": o.get("amount"),
            "status": o.get("status"),
            "created": o.get("created"),
            "paidAt": o.get("paidAt"),
        }

    def _do_polish(self):
        user = self._need_user()
        if not user:
            return
        uid, name = user
        payload = self._body()
        text = (payload.get("text") or "").strip()
        if not text:
            self._err("文本为空", "bad_request", 400)
            return
        if len(text) > 20000:
            self._err("单次文本过长（上限 2 万字符）", "too_long", 400)
            return
        if self.store.rate_limited(uid):
            self._err("操作太快了，请稍后再试", "rate_limited", 429)
            return
        try:
            quota = self.store.consume(uid)
        except QuotaError as e:
            self._err(e.message, e.code, 402)
            return
        system_prompt = (payload.get("system") or "").strip() or SYSTEM_PROMPT
        try:
            result = call_deepseek(text, system_prompt)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")
            log("deepseek HTTPError:", detail[:200])
            quota = self.store.refund(uid)  # 上游报错，退回次数
            self._err("AI 服务错误，请稍后重试", "upstream", 502)
            return
        except Exception as e:  # noqa: BLE001
            log("deepseek error:", repr(e))
            quota = self.store.refund(uid)  # 上游异常，退回次数
            self._err("AI 服务异常，请稍后重试", "upstream", 500)
            return
        log("polish ok user=%s(%s) chars=%d quota=%s" % (name, uid, len(text), quota))
        self._ok(result=result, quota=quota)

    def _do_create_order(self):
        user = self._need_user()
        if not user:
            return
        plan = (self._body().get("plan") or "").strip()
        if plan not in PLANS:
            self._err("套餐不存在", "bad_request", 400)
            return
        o = self.store.create_order(user[0], user[1], plan)
        self._ok(order=self._safe_order(o), quota=self.store.quota_view(user[0]))

    def _do_claim_order(self):
        user = self._need_user()
        if not user:
            return
        oid = (self._body().get("id") or "").strip()
        o = self.store.claim_order(oid, user[0])
        if not o:
            self._err("订单不存在", "not_found", 404)
            return
        log("order claimed:", oid, "user=", user[1])
        self._ok(order=self._safe_order(o))

    def _do_pay_notify(self):
        """支付通道回调占位：验签 -> 找到订单 -> confirm_order()。
        现在没有通道，直接返回未启用，避免误调用。"""
        self._err(
            "尚未接入在线支付通道；请用「用户下单 + 管理员确认」流程",
            "pay_channel_off",
            501,
        )

    # 收款码文件命名：paycode_<套餐>_<方式>.png（如 paycode_month_wechat.png）；
    # 兼容早期只有一个 data/paycode.png 的部署。
    PAYCODE_PLANS = ("day", "month")
    PAYCODE_METHODS = ("wechat", "alipay")

    def _paycode_file(self, plan, method):
        d = self.store.dir
        if plan and method:
            return os.path.join(d, "paycode_%s_%s.png" % (plan, method))
        if plan:
            for m in self.PAYCODE_METHODS:  # 只给套餐时挑第一个存在的
                p = os.path.join(d, "paycode_%s_%s.png" % (plan, m))
                if os.path.isfile(p):
                    return p
        return os.path.join(d, "paycode.png")

    def _paycode(self, plan="", method=""):
        path = self._paycode_file(plan, method)
        if not os.path.isfile(path):
            self._err(
                "收款码未上传（把图片放到数据目录：paycode_<套餐>_<方式>.png 或 paycode.png）",
                "no_paycode", 404,
            )
            return
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self._cors()
        # 按图片魔数给 Content-Type：后台允许传 JPG/WebP，写死 image/png 会让浏览器不认
        self.send_header("Content-Type",
                         AVATAR_EXTS.get(sniff_image_ext(body) or "png", "image/png"))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- 4.1.2 后台：收款码在线管理（不用再 scp 图片到服务器）----
    PAYCODE_MAX_BYTES = 4 * 1024 * 1024

    def _paycode_admin_list(self):
        d = self.store.dir
        items = []
        for plan in self.PAYCODE_PLANS:
            for method in self.PAYCODE_METHODS:
                fn = "paycode_%s_%s.png" % (plan, method)
                p = os.path.join(d, fn)
                info = {
                    "plan": plan,
                    "method": method,
                    "file": fn,
                    "url": "/ai/paycode/%s/%s.png" % (plan, method),
                    "exists": os.path.isfile(p),
                    "size": 0,
                    "updated": 0,
                }
                if info["exists"]:
                    try:
                        st = os.stat(p)
                        info["size"] = int(st.st_size)
                        info["updated"] = int(st.st_mtime)
                    except Exception:
                        pass
                items.append(info)
        legacy = os.path.join(d, "paycode.png")
        return {
            "items": items,
            "plans": list(self.PAYCODE_PLANS),
            "methods": list(self.PAYCODE_METHODS),
            "legacy": {"exists": os.path.isfile(legacy), "url": "/ai/paycode.png"},
        }

    def _paycode_upload(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except Exception:
            length = 0
        if length > self.PAYCODE_MAX_BYTES + 1024 * 1024:
            self._drain(length)          # 先读掉再报错，避免浏览器只看到「网络错误」
            self._err("图片太大（上限 4 MB）", "too_large", 400)
            return
        body = self._body()
        plan = (body.get("plan") or "").strip()
        method = (body.get("method") or "").strip()
        if plan not in self.PAYCODE_PLANS or method not in self.PAYCODE_METHODS:
            self._err("套餐或支付方式不对（plan=day|month，method=wechat|alipay）",
                      "bad_request", 400)
            return
        data = _decode_data_url(body.get("data") or "")
        if not data:
            self._err("没有收到图片数据", "bad_request", 400)
            return
        if len(data) > self.PAYCODE_MAX_BYTES:
            self._err("图片太大（上限 4 MB）", "too_large", 400)
            return
        if not sniff_image_ext(data):
            self._err("只支持 PNG / JPG / WebP 图片", "bad_request", 400)
            return
        path = os.path.join(self.store.dir, "paycode_%s_%s.png" % (plan, method))
        tmp = path + ".tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except Exception as e:  # noqa: BLE001
            self._err("写入失败：%s" % e, "io_error", 500)
            return
        self.store.bump_rev()
        self._audit("上传收款码", "%s/%s" % (plan, method), "%d KB" % (len(data) // 1024))
        log("后台上传收款码：%s/%s（%d 字节）" % (plan, method, len(data)))
        self._ok(**self._paycode_admin_list())

    def _paycode_delete(self):
        body = self._body()
        plan = (body.get("plan") or "").strip()
        method = (body.get("method") or "").strip()
        if plan not in self.PAYCODE_PLANS or method not in self.PAYCODE_METHODS:
            self._err("套餐或支付方式不对", "bad_request", 400)
            return
        path = os.path.join(self.store.dir, "paycode_%s_%s.png" % (plan, method))
        try:
            if os.path.isfile(path):
                os.remove(path)
        except Exception as e:  # noqa: BLE001
            self._err("删除失败：%s" % e, "io_error", 500)
            return
        self.store.bump_rev()
        self._audit("删除收款码", "%s/%s" % (plan, method))
        self._ok(**self._paycode_admin_list())

    def _paycodes_manifest(self):
        """告诉客户端有哪些收款码可用（客户端据此显示 微信/支付宝 切换）。"""
        d = self.store.dir
        items = []
        for plan in self.PAYCODE_PLANS:
            for method in self.PAYCODE_METHODS:
                if os.path.isfile(os.path.join(d, "paycode_%s_%s.png" % (plan, method))):
                    items.append({
                        "plan": plan,
                        "method": method,
                        "url": "/ai/paycode/%s/%s.png" % (plan, method),
                    })
        legacy = os.path.isfile(os.path.join(d, "paycode.png"))
        self._ok(
            codes=items,
            legacyUrl="/ai/paycode.png" if legacy else "",
            methods=list(self.PAYCODE_METHODS),
            plans=list(self.PAYCODE_PLANS),
        )


# ============================== 启动 ==============================


def main():
    # 启动前置校验：没有 DeepSeek Key 就别启动（MP_MOCK=1 联调模式除外）
    if not DEEPSEEK_KEY and not MOCK:
        log("启动失败：未设置 MP_DEEPSEEK_KEY 环境变量。")
        log("  正式运行： MP_DEEPSEEK_KEY='sk-xxxx' python3 ai_server.py")
        log("  本地联调： MP_MOCK=1 python3 ai_server.py   # 不调用 DeepSeek")
        sys.exit(2)

    store = Store(DATA_DIR)
    Handler.store = store
    log("轻提词 AI 中转服务 %s 启动" % VERSION)
    log("  端口        :", PORT)
    log("  数据目录    :", DATA_DIR)
    log("  在线升级    : /updates（%s）" % ("已就绪" if os.path.isfile(os.path.join(UPDATES_DIR, "latest.json"))
        else "未放置 latest.json —— 把 updates/ 目录 scp 上来即可"))
    log("  备份        : 已备份 %d 个数据文件到 data/backup/（各保留最近 7 份）"
        % store.backup_data())
    log("  Casdoor     :", CASDOOR_URL)
    log("  DeepSeek Key:", "已配置（长度 %d）" % len(DEEPSEEK_KEY) if DEEPSEEK_KEY
        else "未配置（模拟模式）")
    log("  免费额度    : 每天 %d 次" % FREE_DAILY_QUOTA)
    log("  会员日上限  : %d 次（防滥用）" % MEMBER_DAILY_CAP)
    log("  最短调用间隔: %.1fs" % RATE_LIMIT_SEC)
    log("  模拟模式    :", "开（不调用 DeepSeek）" if MOCK else "关")
    # 安全：不再把管理员密钥明文打进日志（日志会被 tail/备份/转发看到）
    if store.admin_key:
        log("  管理员密钥  : ****%s（完整密钥见 data/admin_key.txt，权限 600）"
            % store.admin_key[-4:])
    else:
        log("  管理员密钥  : （未设置）")
    if any(ord(ch) > 127 for ch in store.admin_key):
        log("  提示：管理员密钥含非 ASCII 字符。不同终端传参编码可能不一致，")
        log("        建议用字母数字密钥（例如 32 位随机串），避免 admin_cli 认证失败。")
    log("  管理员用法  : python3 admin_cli.py list / confirm <订单号> / grant <用户名> <天数>")
    log("  账号模式    : %s（账号数 %d；jwt_secret 与密码哈希都在 data/ 下）"
        % (AUTH_MODE, len(store.accounts)))
    if AUTH_MODE != "builtin":
        log("    提示：casdoor 模式下令牌仍由 Casdoor 校验；自建账号接口已在 %d 端口可用"
            % PORT)
    # 自建账号模式下，本进程额外接管客户端写死的 2580（原 Casdoor 端口）
    auth_httpd = None
    if AUTH_MODE == "builtin" and AUTH_PORT:
        try:
            auth_httpd = ThreadingHTTPServer(("0.0.0.0", AUTH_PORT), Handler)
        except Exception as e:  # noqa: BLE001
            log("账号服务启动失败：无法监听 %d（%s）" % (AUTH_PORT, e))
            log("  常见原因：Casdoor 还占着这个端口。检查：ss -lntp | grep %d" % AUTH_PORT)
            log("  确认端口已释放后重试；要立刻回退旧行为就用 MP_AUTH_MODE=casdoor。")
            sys.exit(3)
        threading.Thread(target=auth_httpd.serve_forever).start()
        log("  账号服务    : 已监听 0.0.0.0:%d（/api/* 与 /avatar/*，CORS 已开）" % AUTH_PORT)
    elif AUTH_MODE == "builtin":
        log("  账号服务    : 未监听（MP_AUTH_PORT=0），仅本机 %d 提供 /api/*" % PORT)
    else:
        log("  账号服务    : 未监听 2580（Casdoor 仍在跑）")
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("已停止")
    finally:
        if auth_httpd is not None:
            try:
                auth_httpd.shutdown()
            except Exception:
                pass


if __name__ == "__main__":
    main()
