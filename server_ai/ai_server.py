#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻提词 · AI 中转服务（4.1.1）
============================================================
在 4.0.0 的「纯转发」版本上补上：鉴权 / 额度 / 会员 / 订单。
4.1.0 再把第三方账号系统 Casdoor 换成内置账号模块（自建注册/登录/凭证校验），
使账号与 AI 额度在同一个服务里管理；客户端一行都不用改（兼容 Casdoor 的 5 个接口）。
4.1.1 修注册：用户名放开中文（1~32 位），并把「用户名/密码不符合要求」写成
一眼能看懂的整句（此前只收 ASCII，中文昵称会被当场拒掉且看不出原因；
同日再补齐单字用户名——用户实际填的是「吴」这种单姓，被 2 位下限挡掉了）。

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
  POST /api/upload-resource             头像上传（multipart，≤2MB，按魔数校验）
  GET  /avatar/<uid>.<ext>              头像文件
  POST /ai/admin/account/list|create|resetpwd|status|kick|note   后台账号管理

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
VERSION = "4.1.1"
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

    def _save(self, name, obj):
        path = self._path(name)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

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
                     "accounts.json"):
            src = self._path(name)
            if not os.path.isfile(src):
                continue
            try:
                shutil.copy2(src, os.path.join(bdir, "%s.%s.json" % (name[:-5], stamp)))
                made += 1
            except Exception:
                continue
        # 只保留最近 keep 份（按文件名排序即时间排序）
        for base in ("users", "members", "free", "usage", "orders", "accounts"):
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
            return o, None

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
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>轻提词 · AI 服务后台</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 16px; background: #f5f6f8; color: #1f2430;
         font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  header { max-width: 760px; margin: 0 auto 12px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  h2 { font-size: 14px; margin: 0; }
  .sub, .hint, footer { color: #7a8290; font-size: 12px; }
  .card { max-width: 760px; margin: 0 auto 12px; background: #fff; border-radius: 12px;
          padding: 14px 16px; box-shadow: 0 2px 10px rgba(20,30,50,.06); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .between { justify-content: space-between; }
  input[type=text], input[type=password], input[type=number] {
    flex: 1; min-width: 120px; height: 34px; padding: 0 10px; font-size: 13px;
    border: 1px solid #dfe3ea; border-radius: 8px; background: #fbfcfe; }
  button { height: 34px; padding: 0 12px; font-size: 13px; cursor: pointer;
           border: 1px solid #dfe3ea; border-radius: 8px; background: #fff; }
  button:hover { background: #f2f4f8; }
  button.primary { background: #2b2f36; border-color: #2b2f36; color: #fff; }
  button.primary:hover { background: #3a4049; }
  button:disabled { opacity: .5; cursor: default; }
  .chk { font-size: 12px; color: #7a8290; display: inline-flex; align-items: center; gap: 4px; }
  label { font-size: 12px; color: #7a8290; }
  .list { margin-top: 10px; }
  .order { border: 1px solid #e8ebf0; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; }
  .order .top { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .oid { font-family: Consolas, monospace; font-size: 12px; color: #4b5563; }
  .amt { color: #c0392b; font-weight: 600; }
  .who { font-size: 13px; }
  .meta { color: #7a8290; font-size: 12px; margin-top: 2px; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .b-pending { background: #eef1f6; color: #5b6472; }
  .b-claimed { background: #fff3e0; color: #b45309; }
  .b-paid { background: #e8f6ee; color: #1c7c46; }
  .b-canceled { background: #f2f2f2; color: #9aa1ab; }
  .out { background: #f8fafc; border-radius: 8px; padding: 10px; font-size: 12px;
         white-space: pre-wrap; word-break: break-all; margin: 10px 0 0; min-height: 20px; }
  .err { color: #c0392b; }
  .summary { display: flex; gap: 14px; flex-wrap: wrap; margin: 4px 0 10px;
             padding: 8px 10px; background: #f7f9fc; border-radius: 8px;
             font-size: 12px; color: #5b6472; }
  .summary b { color: #1f2430; }
  .summary b.hot { color: #b45309; }
  .tblwrap { margin-top: 10px; overflow-x: auto; }
  table.tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
  table.tbl th, table.tbl td { padding: 6px 8px; border-bottom: 1px solid #eef1f6; text-align: left;
                               white-space: nowrap; vertical-align: top; }
  table.tbl th { color: #7a8290; font-weight: 500; }
  table.tbl tr:last-child td { border-bottom: 0; }
  table.tbl td.ops { white-space: normal; }
  table.tbl td.ops button { height: 26px; padding: 0 8px; font-size: 12px; margin: 0 4px 4px 0; }
  .badge.b-free { background: #e8f0fe; color: #1a56db; }
  .badge.b-member { background: #e8f6ee; color: #1c7c46; }
  .badge.b-off { background: #fdecec; color: #b42318; }
  @media (max-width: 480px) {
    body { padding: 10px; }
    .card { padding: 12px; }
    .summary { gap: 8px 12px; }
    .order .top { flex-direction: column; }
    .order .top > div:last-child { text-align: left !important; }
    .order button { width: 100%; margin-top: 8px; }
    .amt { font-size: 15px; }
  }
  footer { max-width: 760px; margin: 4px auto 20px; }
</style>
</head>
<body>
<header>
  <h1>轻提词 · AI 服务后台</h1>
  <div class="sub">确认收款开通会员 / 手工加天数 / 账号与 AI 额度管理</div>
</header>

<section class="card">
  <label>管理员密钥</label>
  <div class="row" style="margin-top:6px">
    <input id="key" type="password" placeholder="启动服务时设置的 MP_ADMIN_KEY">
    <button class="primary" id="save">保存到本浏览器</button>
    <button id="clear">清除</button>
  </div>
  <div class="hint" style="margin-top:6px">密钥只保存在你自己的浏览器里，请求时通过 X-Admin-Key 发给本服务校验。</div>
</section>

<section class="card">
  <div class="row between">
    <h2>订单</h2>
    <div class="row">
      <label class="chk"><input type="checkbox" id="auto"> 每 15 秒自动刷新</label>
      <button id="refresh">刷新</button>
    </div>
  </div>
  <div class="list" id="orders"><div class="hint">点「刷新」加载订单。</div></div>
</section>

<section class="card">
  <h2>手工操作</h2>
  <div class="row" style="margin-top:8px">
    <input id="uname" type="text" placeholder="用户名（软件里登录的账号）">
    <input id="days" type="number" value="30" min="1" style="max-width:90px">
    <button id="grant">加天数</button>
    <button id="lookup">查用户</button>
  </div>
  <pre class="out" id="out"></pre>
</section>

<section class="card">
  <div class="row between">
    <h2>用户与 AI 额度</h2>
    <div class="row">
      <input id="uq" type="text" placeholder="搜索用户名" style="max-width:150px">
      <button id="urefresh">刷新</button>
    </div>
  </div>
  <div class="row" style="margin-top:8px">
    <label class="chk"><input type="checkbox" id="uauto"> 每 15 秒自动刷新</label>
    <button id="uresetall">全部重置「今日用量」</button>
  </div>
  <div class="row" style="margin-top:8px">
    <input id="nname" type="text" placeholder="新建账号的用户名" style="max-width:180px">
    <input id="npwd" type="text" placeholder="初始密码（≥8 位）" style="max-width:180px">
    <button class="primary" id="ncreate">新建账号</button>
  </div>
  <div class="hint" style="margin-top:6px">
    用户名规则（和客户端注册页一致）：<b>1~32 位</b>，可用<b>中英文、数字、下划线、连字符</b>，
    首尾不能是 <code>_</code> 或 <code>-</code>；密码<b>至少 8 位</b>。
  </div>
  <div class="hint" style="margin-top:6px">
    这里的「账号」就是软件里登录的云端账号（含注册/最后登录时间、当日与累计 AI 次数）。
    「免费不限量」= 该账号不受每天 3 次免费额度限制（仍保留 2 秒最小调用间隔）。<br>
    账号操作：<b>重置密码</b>会生成一次性临时密码（只显示这一次，请转告用户登录后自行修改）；
    <b>停用</b>会让该账号立即下线且无法登录；<b>踢下线</b>只让已登录的旧令牌立刻失效。
    后台<b>不会</b>显示任何密码原文——系统只保存单向哈希。
  </div>
  <div class="tblwrap" id="users"><div class="hint">点「刷新」加载用户。</div></div>
</section>

<footer>
  收款码：把收款图传到服务器 data/paycode.png，客户端会自动展示；
  命令行方式同样可用：python3 admin_cli.py list / confirm / grant。
</footer>

<script>
(function () {
  var KEY_STORE = "microprompt.adminKey";
  var $ = function (id) { return document.getElementById(id); };

  function getKey() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }
  function setKey(v) {
    try { localStorage.setItem(KEY_STORE, v); } catch (e) {}
  }
  function fmtTime(ts) {
    if (!ts) return "-";
    var d = new Date(ts * 1000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
           " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function statusText(s) {
    return ({ pending: "待付款", claimed: "用户已付待确认", paid: "已开通", canceled: "已作废" })[s] || s;
  }

  function api(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Key": getKey() },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, data: d };
      });
    });
  }

  function showErr(target, res) {
    var d = res.data || {};
    if (res.status === 403) target.innerHTML = '<span class="err">管理员密钥不正确，请在上方重新填写并保存。</span>';
    else target.innerHTML = '<span class="err">' + (d.error || ("请求失败 HTTP " + res.status)) + "</span>";
  }

  function renderOrders(orders) {
    var box = $("orders");
    if (!orders || !orders.length) {
      box.innerHTML = '<div class="hint">还没有订单。</div>';
      return;
    }
    var wait = orders.filter(function (o) { return o.status === "pending" || o.status === "claimed"; });
    var done = orders.filter(function (o) { return o.status === "paid"; }).slice(0, 20);
    var rest = orders.filter(function (o) {
      return o.status !== "pending" && o.status !== "claimed" && o.status !== "paid";
    }).slice(0, 5);
    // 运营摘要：待处理 / 今日已开通 / 累计收入（按已开通订单金额求和）
    var paidAll = orders.filter(function (o) { return o.status === "paid"; });
    var today = new Date();
    var isToday = function (ts) {
      if (!ts) return false;
      var d = new Date(ts * 1000);
      return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() &&
             d.getDate() === today.getDate();
    };
    var paidToday = paidAll.filter(function (o) { return isToday(o.paidAt); });
    var sum = function (list) {
      return list.reduce(function (a, o) { return a + Number(o.amount || 0); }, 0);
    };
    var summary = '<div class="summary">' +
      '<span>待处理 <b class="' + (wait.length ? "hot" : "") + '">' + wait.length + "</b> 笔</span>" +
      "<span>今日已开通 <b>" + paidToday.length + "</b> 笔 · ￥" + sum(paidToday).toFixed(2) + "</span>" +
      "<span>累计已开通 <b>" + paidAll.length + "</b> 笔 · ￥" + sum(paidAll).toFixed(2) + "</span>" +
      "</div>";
    var html = summary;
    var block = function (list) {
      list.forEach(function (o) {
        var canConfirm = (o.status === "pending" || o.status === "claimed");
        html += '<div class="order"><div class="top">' +
          '<div><span class="who">' + (o.name || "-") + "</span> " +
          '<span class="badge b-' + o.status + '">' + statusText(o.status) + "</span>" +
          '<div class="meta">' + (o.planName || o.plan) + " / " + (o.days || "-") + " 天 / " +
          '下单 ' + fmtTime(o.created) + "</div>" +
          '<div class="oid">' + o.id + "</div></div>" +
          '<div style="text-align:right"><div class="amt">' + Number(o.amount || 0).toFixed(2) + " 元</div>" +
          (canConfirm ? '<button class="primary" data-confirm="' + o.id + '" style="margin-top:6px">确认收款并开通</button>' : "") +
          "</div></div></div>";
      });
    };
    if (wait.length) { html += '<div class="hint">待处理 ' + wait.length + ' 笔</div>'; block(wait); }
    if (done.length) { html += '<div class="hint" style="margin-top:10px">最近已开通</div>'; block(done); }
    if (rest.length) { html += '<div class="hint" style="margin-top:10px">其它</div>'; block(rest); }
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll("[data-confirm]"), function (b) {
      b.addEventListener("click", function () { confirmOrder(b.getAttribute("data-confirm"), b); });
    });
  }

  function loadOrders() {
    if (!getKey()) { $("orders").innerHTML = '<div class="hint err">请先填写并保存管理员密钥。</div>'; return; }
    api("/ai/admin/orders", {}).then(function (res) {
      if (!res.data.ok) { showErr($("orders"), res); return; }
      renderOrders(res.data.orders || []);
    }).catch(function (e) {
      $("orders").innerHTML = '<div class="err">无法连接服务：' + e + "</div>";
    });
  }

  function confirmOrder(id, btn) {
    if (!confirm("确认已收到这笔款项？确认后会立即为其开通会员。")) return;
    btn.disabled = true;
    btn.textContent = "处理中...";
    api("/ai/admin/confirm", { id: id }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); btn.disabled = false; btn.textContent = "确认收款并开通"; return; }
      $("out").textContent = "已开通：" + id + "，会员到期 " + fmtTime(res.data.memberUntil);
      loadOrders();
    });
  }

  $("save").addEventListener("click", function () {
    setKey($("key").value.trim());
    $("out").textContent = "密钥已保存在本浏览器。";
    loadOrders();
  });
  $("clear").addEventListener("click", function () {
    setKey(""); $("key").value = ""; $("out").textContent = "已清除本浏览器里的密钥。";
  });
  $("refresh").addEventListener("click", loadOrders);
  $("grant").addEventListener("click", function () {
    var u = $("uname").value.trim(), d = parseInt($("days").value, 10) || 0;
    if (!u || d <= 0) { $("out").textContent = "请填写用户名与天数。"; return; }
    api("/ai/admin/grant", { username: u, days: d }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已给 " + u + " 加 " + d + " 天，会员到期 " + fmtTime(res.data.memberUntil);
      loadOrders();
    });
  });
  $("lookup").addEventListener("click", function () {
    var u = $("uname").value.trim();
    if (!u) { $("out").textContent = "请填写用户名。"; return; }
    api("/ai/admin/lookup", { username: u }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      var q = res.data.quota || {};
      $("out").textContent =
        "用户：" + res.data.username + "（id=" + res.data.userId + "）\n" +
        "会员到期：" + (q.memberUntil ? fmtTime(q.memberUntil) : "未开通") + "\n" +
        "今日用量：免费 " + q.freeUsedToday + "/" + q.freeQuota + " 次，会员 " +
        q.memberUsedToday + "/" + q.memberCap + " 次\n" +
        "今日剩余：" + q.remainingToday + "，累计调用：" + q.totalCalls;
    });
  });
  /* ---------- 用户与 AI 额度 ---------- */
  var USERS = [];
  var FREE_DAILY = 3, MEMBER_CAP = 300;

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function isTodayTs(ts) {
    if (!ts) return false;
    var d = new Date(ts * 1000), t = new Date();
    return d.getFullYear() === t.getFullYear() && d.getMonth() === t.getMonth() &&
           d.getDate() === t.getDate();
  }
  function usageText(u) {
    if (u.free) return "不限量 · 今日 " + u.unlimitedUsedToday + " 次";
    if (u.member) return "会员 · 今日 " + u.memberUsedToday + " / " + MEMBER_CAP + " 次";
    return "免费 · 今日 " + u.freeUsedToday + " / " + FREE_DAILY +
           " 次（余 " + u.remainingToday + "）";
  }

  function renderUsers() {
    var box = $("users");
    var kw = ($("uq").value || "").trim().toLowerCase();
    var list = USERS.filter(function (u) {
      return !kw || String(u.username || "").toLowerCase().indexOf(kw) >= 0;
    });
    if (!list.length) {
      box.innerHTML = '<div class="hint">' +
        (USERS.length ? "没有匹配的用户。" : "还没有用户登录记录。") + "</div>";
      return;
    }
    var todayUsers = list.filter(function (u) { return isTodayTs(u.last); });
    var freeCount = list.filter(function (u) { return u.free; }).length;
    var offCount = list.filter(function (u) { return u.status === "disabled"; }).length;
    var todayCalls = list.reduce(function (a, u) {
      return a + Number(u.freeUsedToday || 0) + Number(u.memberUsedToday || 0) +
             Number(u.unlimitedUsedToday || 0);
    }, 0);
    var html = '<div class="summary">' +
      "<span>账号 <b>" + list.length + "</b> 个</span>" +
      "<span>今日登录 <b>" + todayUsers.length + "</b> 个</span>" +
      "<span>免费不限量 <b>" + freeCount + "</b> 个</span>" +
      "<span>已停用 <b>" + offCount + "</b> 个</span>" +
      "<span>今日 AI 调用 <b>" + todayCalls + "</b> 次</span>" +
      "</div>";
    html += '<table class="tbl"><thead><tr>' +
      "<th>账号</th><th>注册时间</th><th>最后登录</th><th>AI 额度</th>" +
      "<th>累计</th><th>会员到期</th><th>状态</th><th>备注</th><th>操作</th>" +
      "</tr></thead><tbody>";
    list.forEach(function (u) {
      var name = esc(u.username);
      var st = String(u.status || "");
      var stateBadge = st === "disabled"
        ? '<span class="badge b-off">已停用</span>'
        : (!u.account ? '<span class="badge b-off">无账号</span>'
          : (u.free ? '<span class="badge b-free">免费不限量</span>'
            : (u.member ? '<span class="badge b-member">会员</span>' : "免费版")));
      html += "<tr>" +
        "<td><b>" + (name || "(未命名)") + '</b><div class="oid">' + esc(u.userId) + "</div></td>" +
        "<td>" + fmtTime(u.created || u.first) + "</td>" +
        "<td>" + fmtTime(u.lastLogin || u.last) +
          (u.lastIP ? '<div class="oid">' + esc(u.lastIP) + "</div>" : "") + "</td>" +
        "<td>" + usageText(u) + "</td>" +
        "<td>" + Number(u.totalCalls || 0) + " 次</td>" +
        "<td>" + (u.member ? fmtTime(u.memberUntil) : "-") + "</td>" +
        "<td>" + stateBadge + "</td>" +
        "<td>" + (u.note ? esc(u.note) : "-") + "</td>" +
        '<td class="ops">' +
        '<button data-reset="' + name + '">重置今日</button>' +
        '<button data-zero="' + name + '">清零累计</button>' +
        (u.free
          ? '<button data-free="0" data-name="' + name + '">取消免费</button>'
          : '<button class="primary" data-free="1" data-name="' + name +
            '">开通免费不限量</button>') +
        (u.account ? (
          '<button data-pwd="' + name + '">重置密码</button>' +
          '<button data-note="' + name + '">备注</button>' +
          '<button data-kick="' + name + '">踢下线</button>' +
          (st === "disabled"
            ? '<button class="primary" data-status="active" data-name="' + name + '">启用</button>'
            : '<button data-status="disabled" data-name="' + name + '">停用</button>')
        ) : "") +
        "</td></tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll("[data-reset]"), function (b) {
      b.addEventListener("click", function () {
        resetUsage(b.getAttribute("data-reset"), false);
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-zero]"), function (b) {
      b.addEventListener("click", function () {
        resetUsage(b.getAttribute("data-zero"), true);
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-free]"), function (b) {
      b.addEventListener("click", function () {
        setFree(b.getAttribute("data-name"), b.getAttribute("data-free") === "1");
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-pwd]"), function (b) {
      b.addEventListener("click", function () { resetPwd(b.getAttribute("data-pwd")); });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-status]"), function (b) {
      b.addEventListener("click", function () {
        setStatus(b.getAttribute("data-name"), b.getAttribute("data-status"));
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-kick]"), function (b) {
      b.addEventListener("click", function () { kickUser(b.getAttribute("data-kick")); });
    });
    Array.prototype.forEach.call(box.querySelectorAll("[data-note]"), function (b) {
      b.addEventListener("click", function () { setNote(b.getAttribute("data-note")); });
    });
  }

  function resetUsage(name, zeroTotal) {
    if (!name) return;
    if (!confirm(zeroTotal
      ? "把「" + name + "」的累计调用数一起清零？（今日用量同样清零）"
      : "把「" + name + "」的今日用量清零？")) return;
    var body = { username: name };
    if (zeroTotal) body.total = true;
    api("/ai/admin/reset", body).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已重置「" + name + "」" + (zeroTotal ? "（含累计）" : "（今日用量）");
      loadUsers();
    });
  }

  function setFree(name, on) {
    if (!name) return;
    if (!confirm(on ? "给「" + name + "」开通免费不限量 AI 润色？"
                    : "取消「" + name + "」的免费不限量？")) return;
    api("/ai/admin/free", { username: name, on: on }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = (on ? "已开通免费不限量：" : "已取消免费不限量：") + name;
      loadUsers();
    });
  }

  /* ---------- 账号管理（4.1.0） ---------- */
  function resetPwd(name) {
    if (!name) return;
    if (!confirm("重置「" + name + "」的密码？\n" +
      "· 会生成一个一次性临时密码，只显示这一次\n" +
      "· 该账号已登录的旧令牌会立刻失效")) return;
    api("/ai/admin/account/resetpwd", { name: name }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已重置「" + name + "」的密码。\n" +
        "临时密码：" + res.data.tempPassword + "\n" +
        "（只显示这一次，请转告用户登录后自行修改）";
      loadUsers();
    });
  }

  function setStatus(name, status) {
    if (!name) return;
    var off = status === "disabled";
    if (!confirm(off
      ? "停用「" + name + "」？该账号将无法登录，已登录的旧令牌立刻失效。"
      : "启用「" + name + "」？启用后该账号可以重新登录。")) return;
    api("/ai/admin/account/status", { name: name, status: status }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已" + (off ? "停用：" : "启用：") + name;
      loadUsers();
    });
  }

  function kickUser(name) {
    if (!name) return;
    if (!confirm("把「" + name + "」踢下线？\n旧令牌立刻失效，用户需要重新登录（密码不变）。")) return;
    api("/ai/admin/account/kick", { name: name }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已把「" + name + "」踢下线（凭证版本 -> " +
        ((res.data.account || {}).tokenVer || "?") + "）";
      loadUsers();
    });
  }

  function setNote(name) {
    if (!name) return;
    var cur = "";
    USERS.forEach(function (u) { if (u.username === name) cur = u.note || ""; });
    var note = prompt("「" + name + "」的备注（仅后台可见，留空即清除）：", cur);
    if (note === null) return;
    api("/ai/admin/account/note", { name: name, note: note }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已更新「" + name + "」的备注。";
      loadUsers();
    });
  }

  function createAccount() {
    var name = ($("nname").value || "").trim();
    var pwd = $("npwd").value || "";
    if (!name) { $("out").textContent = "请先填用户名。"; return; }
    if (pwd.length < 8) { $("out").textContent = "密码不符合要求：至少 8 位。"; return; }
    if (!confirm("新建账号「" + name + "」？")) return;
    api("/ai/admin/account/create", { name: name, password: pwd }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已新建账号：" + name + "\n（用户可直接用它登录）";
      $("nname").value = "";
      $("npwd").value = "";
      loadUsers();
    });
  }

  function loadUsers() {
    if (!getKey()) {
      $("users").innerHTML = '<div class="hint err">请先填写并保存管理员密钥。</div>';
      return;
    }
    api("/ai/admin/users", {}).then(function (res) {
      if (!res.data.ok) { showErr($("users"), res); return; }
      FREE_DAILY = Number(res.data.freeDaily || FREE_DAILY);
      MEMBER_CAP = Number(res.data.memberCap || MEMBER_CAP);
      USERS = res.data.users || [];
      renderUsers();
    }).catch(function (e) {
      $("users").innerHTML = '<div class="err">无法连接服务：' + e + "</div>";
    });
  }

  var timer = null;
  $("auto").addEventListener("change", function () {
    if (timer) { clearInterval(timer); timer = null; }
    if ($("auto").checked) { timer = setInterval(loadOrders, 15000); }
  });

  var utimer = null;
  $("urefresh").addEventListener("click", loadUsers);
  $("uq").addEventListener("input", renderUsers);
  $("ncreate").addEventListener("click", createAccount);
  $("uresetall").addEventListener("click", function () {
    if (!confirm("把所有账号的「今日用量」清零？（累计调用数保留）")) return;
    api("/ai/admin/reset", { all: true }).then(function (res) {
      if (!res.data.ok) { showErr($("out"), res); return; }
      $("out").textContent = "已重置全部账号的今日用量（" + (res.data.count || 0) + " 个账号）。";
      loadUsers();
    });
  });
  $("uauto").addEventListener("change", function () {
    if (utimer) { clearInterval(utimer); utimer = null; }
    if ($("uauto").checked) { utimer = setInterval(loadUsers, 15000); }
  });
  $("save").addEventListener("click", loadUsers);

  $("key").value = getKey();
  if (getKey()) { loadOrders(); loadUsers(); }
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
            self._err("管理员密钥不正确", "admin_auth", 403)
            return False
        return True

    def log_message(self, *args):  # 静默，避免刷日志
        pass

    # ---- 路由 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self._path()
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
            self._ok(order=order, memberUntil=order.get("memberUntil"))
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
            self._ok(
                userId=uid,
                username=u.get("name"),
                free=state,
                quota=self.store.quota_view(uid),
            )
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
            self._ok(username=acc.get("name"), tempPassword=temp)
            return

        if action == "status":
            want = "disabled" if (body.get("status") or "") == "disabled" else "active"
            acc = store.account_set_status(uid, want)
            log("后台%s账号：%s（%s）" % ("停用" if want == "disabled" else "启用",
                                     acc.get("name"), uid))
            self._ok(account=store.account_admin_view(acc))
            return

        if action == "kick":
            acc = store.account_bump_ver(uid)
            log("后台踢下线：%s（%s）" % (acc.get("name"), uid))
            self._ok(account=store.account_admin_view(acc))
            return

        if action == "note":
            acc = store.account_set_note(uid, body.get("note") or "")
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
        self.send_header("Content-Type", "image/png")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
