#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻提词 · AI 服务管理工具（4.0.3）
============================================================
给管理员用：看订单、确认收款开通会员、手工加天数、查用户额度。

用法（在服务器 ai_server 目录下执行）：
    python3 admin_cli.py list                 # 看所有待处理订单（默认 pending+claimed）
    python3 admin_cli.py list claimed         # 只看用户已点"我已支付"的
    python3 admin_cli.py confirm 20261008XXXX-AB   # 确认收款 -> 自动开通对应天数
    python3 admin_cli.py grant ethan 30       # 手工给某用户名加 30 天
    python3 admin_cli.py lookup ethan         # 查某用户会员到期与今日用量
    python3 admin_cli.py key                  # 打印当前管理员密钥

环境变量：
    MP_URL      服务地址（默认 http://127.0.0.1:2581）
    MP_DATA_DIR 数据目录（默认脚本同目录/data，用于读取 admin_key.txt）
"""

import json
import os
import sys
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("MP_DATA_DIR", os.path.join(BASE_DIR, "data"))
URL = os.environ.get("MP_URL", "http://127.0.0.1:2581").rstrip("/")


def load_key():
    env = os.environ.get("MP_ADMIN_KEY", "").strip()
    if env:
        return env
    path = os.path.join(DATA_DIR, "admin_key.txt")
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
    except Exception:
        pass
    print("找不到管理员密钥：请设置环境变量 MP_ADMIN_KEY，或确认 %s 存在" % path)
    sys.exit(2)


def call(path, payload=None):
    key = load_key()
    data = json.dumps(payload or {}).encode("utf-8")
    req = urllib.request.Request(
        URL + path,
        data=data,
        headers={"Content-Type": "application/json", "X-Admin-Key": key},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"ok": False, "error": "HTTP %d" % e.code}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "无法连接服务：%s" % e}


def fmt_ts(ts):
    if not ts:
        return "-"
    import time as _t

    return _t.strftime("%Y-%m-%d %H:%M", _t.localtime(float(ts)))


def fmt_until(ts):
    if not ts:
        return "未开通"
    import time as _t

    left = float(ts) - _t.time()
    if left <= 0:
        return "已过期（%s）" % fmt_ts(ts)
    days = int(left // 86400)
    hours = int((left % 86400) // 3600)
    return "%s（剩余 %d 天 %d 小时）" % (fmt_ts(ts), days, hours)


def cmd_list(status=None):
    r = call("/ai/admin/orders", {"status": status})
    if not r.get("ok"):
        print("失败：", r.get("error"))
        return 1
    orders = r.get("orders") or []
    if not orders:
        print("没有订单。")
        return 0
    print("%-22s %-16s %-6s %-6s %-9s %-9s %s" % ("订单号", "用户", "套餐", "金额", "状态", "下单时间", "已付款时间"))
    print("-" * 100)
    for o in orders:
        print(
            "%-22s %-16s %-6s %-6s %-9s %-9s %s"
            % (
                o.get("id"),
                o.get("name"),
                o.get("planName"),
                "%.2f" % float(o.get("amount") or 0),
                o.get("status"),
                fmt_ts(o.get("created")),
                fmt_ts(o.get("paidAt")),
            )
        )
    print()
    print("确认收款开通：python3 admin_cli.py confirm <订单号>")
    return 0


def cmd_confirm(order_id):
    if not order_id:
        print("用法：python3 admin_cli.py confirm <订单号>")
        return 1
    r = call("/ai/admin/confirm", {"id": order_id})
    if not r.get("ok"):
        print("失败：", r.get("error"))
        return 1
    o = r.get("order") or {}
    print("已确认开通：用户 %s，套餐 %s，会员到期 %s" % (o.get("name"), o.get("planName"), fmt_until(r.get("memberUntil"))))
    return 0


def cmd_grant(username, days):
    if not username or not days:
        print("用法：python3 admin_cli.py grant <用户名> <天数>")
        return 1
    r = call("/ai/admin/grant", {"username": username, "days": int(days)})
    if not r.get("ok"):
        print("失败：", r.get("error"))
        return 1
    print("已给 %s 增加 %s 天，会员到期 %s" % (username, days, fmt_until(r.get("memberUntil"))))
    return 0


def cmd_lookup(username):
    if not username:
        print("用法：python3 admin_cli.py lookup <用户名>")
        return 1
    r = call("/ai/admin/lookup", {"username": username})
    if not r.get("ok"):
        print("失败：", r.get("error"))
        return 1
    q = r.get("quota") or {}
    print("用户        :", r.get("username"), "（id=%s）" % r.get("userId"))
    print("会员状态    :", fmt_until(q.get("memberUntil")))
    print("今日用量    : 免费 %s / %s 次，会员 %s / %s 次" % (q.get("freeUsedToday"), q.get("freeQuota"), q.get("memberUsedToday"), q.get("memberCap")))
    print("今日剩余    :", q.get("remainingToday"))
    print("累计调用    :", q.get("totalCalls"))
    return 0


def cmd_key():
    print(load_key())
    return 0


def main():
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    cmd = args[0]
    if cmd == "list":
        return cmd_list(args[1] if len(args) > 1 else None)
    if cmd == "confirm":
        return cmd_confirm(args[1] if len(args) > 1 else "")
    if cmd == "grant":
        return cmd_grant(args[1] if len(args) > 1 else "", args[2] if len(args) > 2 else "")
    if cmd == "lookup":
        return cmd_lookup(args[1] if len(args) > 1 else "")
    if cmd == "key":
        return cmd_key()
    print("未知命令：", cmd)
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
