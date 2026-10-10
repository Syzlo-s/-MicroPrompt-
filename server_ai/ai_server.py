#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻提词 · AI 中转服务（4.0.2）
============================================================
在 4.0.0 的「纯转发」版本上补上：鉴权 / 额度 / 会员 / 订单。

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

运行
  MP_ADMIN_KEY=你的管理密钥 python3 ai_server.py
  nohup env MP_ADMIN_KEY=你的管理密钥 python3 ai_server.py > ai_server.log 2>&1 &

可选环境变量
  MP_ADMIN_KEY        管理员密钥（首次运行若未设置，会自动生成并存到 data/admin_key.txt）
  MP_DATA_DIR         数据目录（默认：脚本同目录/data）
  MP_CASDOOR_URL      Casdoor 地址（默认 http://127.0.0.1:2580）
  MP_FREE_DAILY       未付费每天次数（默认 3）
  MP_MEMBER_DAILY_CAP 会员防滥用日上限（默认 300）
  MP_RATE_LIMIT_SEC   两次调用最小间隔秒数（默认 2）
  MP_DEEPSEEK_KEY     DeepSeek Key（必填，源码内不含任何默认值；缺失则拒绝启动）
  MP_MOCK=1           本地联调用：不调用 DeepSeek，直接返回假结果
"""

import json
import os
import secrets
import shutil
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
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


class Store(object):
    """data 目录下的几个 JSON 文件：用户、会员、用量、订单。
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
        self.usage = self._load("usage.json", {})       # id -> {day,free,member,total}
        self.orders = self._load("orders.json", {})     # orderId -> {...}
        self.admin_key = self._load_admin_key()

    # ---- 文件读写 ----
    def _path(self, name):
        return os.path.join(self.dir, name)

    def _load(self, name, default):
        try:
            with open(self._path(name), "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else default
        except Exception:
            return default

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
        for name in ("users.json", "members.json", "usage.json", "orders.json"):
            src = self._path(name)
            if not os.path.isfile(src):
                continue
            try:
                shutil.copy2(src, os.path.join(bdir, "%s.%s.json" % (name[:-5], stamp)))
                made += 1
            except Exception:
                continue
        # 只保留最近 keep 份（按文件名排序即时间排序）
        for base in ("users", "members", "usage", "orders"):
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
        return None, None

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

    # ---- 用量 ----
    def _usage_of(self, user_id):
        u = self.usage.get(user_id) or {}
        if u.get("day") != today_str():
            u = {"day": today_str(), "free": 0, "member": 0, "total": u.get("total", 0)}
        return u

    def quota_view(self, user_id):
        with self.lock:
            u = self._usage_of(user_id)
            member = self.is_member(user_id)
            until = self.member_until(user_id)
            if member:
                remaining = max(0, MEMBER_DAILY_CAP - int(u.get("member", 0)))
            else:
                remaining = max(0, FREE_DAILY_QUOTA - int(u.get("free", 0)))
            return {
                "member": member,
                "memberUntil": int(until) if until else 0,
                "plan": "unlimited" if member else "free",
                "freeQuota": FREE_DAILY_QUOTA,
                "freeUsedToday": int(u.get("free", 0)),
                "memberCap": MEMBER_DAILY_CAP,
                "memberUsedToday": int(u.get("member", 0)),
                "remainingToday": remaining,
                "totalCalls": int(u.get("total", 0)),
                "day": u.get("day"),
            }

    def consume(self, user_id):
        """计次；额度不足时抛 QuotaError。返回计次后的额度视图。"""
        with self.lock:
            u = self._usage_of(user_id)
            if self.is_member(user_id):
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
            if self.is_member(user_id):
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


def resolve_user(store, token):
    """拿 Casdoor access_token 换取用户身份（带 5 分钟缓存）。"""
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
  footer { max-width: 760px; margin: 4px auto 20px; }
</style>
</head>
<body>
<header>
  <h1>轻提词 · AI 服务后台</h1>
  <div class="sub">确认收款开通会员 / 手工加天数 / 查用户额度</div>
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
    var html = "";
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
  var timer = null;
  $("auto").addEventListener("change", function () {
    if (timer) { clearInterval(timer); timer = null; }
    if ($("auto").checked) { timer = setInterval(loadOrders, 15000); }
  });

  $("key").value = getKey();
  if (getKey()) loadOrders();
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
    server_version = "MicroPromptAI/4.0.2"
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
            self._ok(service="microprompt-ai", version="4.0.2", mock=MOCK)
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
        if path == "/ai/paycode.png":
            self._paycode()
            return
        if path == "/ai/plans":
            self._ok(plans=list(PLANS.values()), freeDaily=FREE_DAILY_QUOTA)
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
        # 预留：支付通道回调（通道到位后接这里自动开通，见 README）
        if path == "/ai/pay/notify":
            self._do_pay_notify()
            return
        self._err("not found", "not_found", 404)

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

    def _paycode(self):
        path = os.path.join(self.store.dir, "paycode.png")
        if not os.path.isfile(path):
            self._err("收款码图片未上传（把 paycode.png 放到数据目录）", "no_paycode", 404)
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
    log("轻提词 AI 中转服务 4.0.2 启动")
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
    log("  管理员密钥  :", store.admin_key)
    if any(ord(ch) > 127 for ch in store.admin_key):
        log("  提示：管理员密钥含非 ASCII 字符。不同终端传参编码可能不一致，")
        log("        建议用字母数字密钥（例如 32 位随机串），避免 admin_cli 认证失败。")
    log("  管理员用法  : python3 admin_cli.py list / confirm <订单号> / grant <用户名> <天数>")
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("已停止")


if __name__ == "__main__":
    main()
