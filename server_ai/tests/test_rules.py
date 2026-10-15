# -*- coding: utf-8 -*-
"""轻提词 AI 服务端「额度 / 会员 / 订单」规则回归套件
================================================================
自动拉起 fake Casdoor + 若干 ai_server 实例，逐条打穿关键规则：

  1. 免费额度        每天 3 次，第 4 次 402 free_exhausted
  2. 跨天重置        昨天用完的用户，今天第一调用应当成功
  3. 并发抢额度      只剩 1 次时两个并发请求：恰好一个成功、一个 402
  4. 订单复用        同用户同套餐 10 分钟内两次下单 → 同一订单号
  5. 确认幂等        同一订单连续确认两次 → 会员只加一次
  6. 越权保护        别人的订单不能被 claim
  7. 会员上限        达到防滥用上限 → 402 member_cap
  8. 失败退款        上游 AI 出错时把扣掉的次数退回
  9. 数据备份        启动时备份 5 个数据文件、每个保留 7 份
 10. 订单恢复去重    旧的未付订单自动作废；已支付订单可被客户端恢复
 11. 管理命令行      admin_cli.py list / confirm 可用
 12. 续费顺延        会员再买一次是在原到期时间上叠加
 13. 并发确认        同一订单被同时确认两次，只加一次会员
 14. 启动校验        缺 MP_DEEPSEEK_KEY 且非 mock → 拒绝启动（退出码 2）
 15. 管理后台        /admin 页面可访问、不含管理员密钥、带摘要与手机适配
 16. 数据损坏恢复    把 members.json 写坏后重启，会员到期时间原样恢复
 17. 超长文本        超过 2 万字符被拒（400 too_long）且不扣额度
  18. 免费不限量      管理员开通后不受每天 3 次限制；可重置今日 / 清零累计；越权 403

用法（在 server_ai 目录下）：
    python3 tests/test_rules.py            # 自动拉起假 Casdoor + 多个服务实例，跑完自动清理
    MP_TEST_WORK=/tmp/mp-test python3 tests/test_rules.py   # 指定数据目录（便于排查）

端口说明：所有实例（含假 Casdoor）都用 free_port() 动态挑空闲端口，不再写死
2589-2600，避免被 Hyper-V/WinNAT 保留段或残留 Bound 套接字占住导致误报失败。

依赖：只有 Python3 标准库；不会调用 DeepSeek（全程 MP_MOCK=1），不会碰真实的 data/。
"""

import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.normpath(os.path.join(HERE, "..", "ai_server.py"))
CLI = os.path.normpath(os.path.join(HERE, "..", "admin_cli.py"))
FAKE_CASDOOR = os.path.join(HERE, "fake_casdoor.py")
# 临时数据目录：每次跑用独立目录，避免污染真实的 data/
WORK = os.environ.get("MP_TEST_WORK") or tempfile.mkdtemp(prefix="mp-ai-rules-")
ADMIN_KEY = "ruleskey123"


def free_port():
    """取一个当前空闲的端口。

    以前这里写死 2599 / 2597 / 2596 / 2595 / ... / 2589，在部分 Windows 上会偶发
    起不来：Hyper-V / WinNAT 会保留端口段，或已退出进程会留下 Bound 套接字，
    bind 时抛 WinError 10013 / 10048；而 start_server 起不来时只表现为 http=0，
    看起来像规则失败。改成动态分配后与机器环境无关。
    """
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


CASDOOR_PORT = free_port()
CASDOOR = "http://127.0.0.1:%d" % CASDOOR_PORT

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("   " + detail) if detail else ""))


def call(url, path, method="GET", body=None, token=None, admin=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if admin:
        headers["X-Admin-Key"] = admin
    req = urllib.request.Request(url + path, data=data, headers=headers)
    if method != "GET":
        req.get_method = lambda: method
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.getcode(), json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            return e.code, {}
    except Exception as e:  # noqa: BLE001
        return 0, {"_err": str(e)}


def start_server(port, data_dir, extra_env=None, mock=True, seed_usage=None,
                 fresh=True, seed_files=None):
    if fresh and os.path.isdir(data_dir):
        shutil.rmtree(data_dir, ignore_errors=True)
    if not os.path.isdir(data_dir):
        os.makedirs(data_dir)
    if seed_usage:
        with open(os.path.join(data_dir, "usage.json"), "w", encoding="utf-8") as f:
            json.dump(seed_usage, f, ensure_ascii=False)
    for name, obj in (seed_files or {}).items():
        with open(os.path.join(data_dir, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False)
    env = dict(os.environ)
    env.update(
        {
            "MP_PORT": str(port),
            "MP_DATA_DIR": data_dir,
            "MP_ADMIN_KEY": ADMIN_KEY,
            "MP_MOCK": "1" if mock else "0",
            "MP_CASDOOR_URL": CASDOOR,
            "MP_RATE_LIMIT_SEC": "0",
            "MP_FREE_DAILY": "3",
        }
    )
    if extra_env:
        env.update(extra_env)
    kw = {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen([PY, SRV], env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, **kw)
    url = "http://127.0.0.1:%d" % port
    for _ in range(40):
        time.sleep(0.25)
        code, _d = call(url, "/ai/health", timeout=3)
        if code == 200:
            return proc, url, data_dir
    return proc, url, data_dir


def main():
    procs = []
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)

    kw = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
    cas_env = dict(os.environ)
    cas_env["MP_FAKE_CASDOOR_PORT"] = str(CASDOOR_PORT)
    casdoor = subprocess.Popen([PY, FAKE_CASDOOR], env=cas_env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, **kw)
    procs.append(casdoor)
    time.sleep(1)

    main_p, MAIN, main_dir = start_server(free_port(), os.path.join(WORK, "main"))
    cap_p, CAP, _ = start_server(free_port(), os.path.join(WORK, "cap"), {"MP_MEMBER_DAILY_CAP": "1"})
    fail_p, FAILURL, _ = start_server(free_port(), os.path.join(WORK, "fail"), mock=False,
                                      extra_env={"MP_DEEPSEEK_KEY": "sk-invalid-for-test"})
    # 跨天重置：预置"昨天用完"的用量
    yesterday_usage = {
        "uid-resetuser": {"day": "2020-01-01", "free": 3, "member": 0, "total": 3}
    }
    reset_p, RESET, _ = start_server(free_port(), os.path.join(WORK, "reset"), seed_usage=yesterday_usage)
    procs += [main_p, cap_p, fail_p, reset_p]

    print("轻提词 AI 服务端规则回归")
    print("=" * 64)
    try:
        # 1. 免费额度
        print("[1] 免费额度：每天 3 次")
        codes = []
        for i in range(4):
            c, d = call(MAIN, "/ai/polish", "POST", {"text": "额度测试 %d" % i}, token="freeuser")
            codes.append((c, d.get("code"), (d.get("quota") or {}).get("remainingToday")))
        check("前 3 次成功", all(x[0] == 200 for x in codes[:3]), str(codes[:3]))
        check("第 4 次 402 free_exhausted",
              codes[3][0] == 402 and codes[3][1] == "free_exhausted", str(codes[3]))

        # 2. 跨天重置
        print("[2] 跨天重置：昨天用完，今天应恢复")
        c, d = call(RESET, "/ai/polish", "POST", {"text": "新的一天"}, token="resetuser")
        check("今天第一次调用成功", c == 200, "http=%s code=%s" % (c, d.get("code")))
        check("剩余次数已重置为 2",
              (d.get("quota") or {}).get("remainingToday") == 2, str(d.get("quota")))

        # 3. 并发抢额度
        print("[3] 并发抢额度：只剩 1 次时两个并发请求")
        call(MAIN, "/ai/polish", "POST", {"text": "占位1"}, token="concuser")
        call(MAIN, "/ai/polish", "POST", {"text": "占位2"}, token="concuser")  # 只剩 1 次
        results = []

        def worker(i):
            results.append(call(MAIN, "/ai/polish", "POST", {"text": "并发 %d" % i}, token="concuser"))

        ts = [threading.Thread(target=worker, args=(i,)) for i in (1, 2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        ok_n = sum(1 for r in results if r[0] == 200)
        q_n = sum(1 for r in results if r[0] == 402)
        check("恰好 1 个成功 + 1 个 402", ok_n == 1 and q_n == 1,
              "结果=%s" % [(r[0], r[1].get("code")) for r in results])

        # 4. 订单复用
        print("[4] 订单复用：同用户同套餐 10 分钟内两次下单")
        _, o1 = call(MAIN, "/ai/order", "POST", {"plan": "month"}, token="orderuser")
        _, o2 = call(MAIN, "/ai/order", "POST", {"plan": "month"}, token="orderuser")
        id1 = (o1.get("order") or {}).get("id")
        id2 = (o2.get("order") or {}).get("id")
        check("返回同一订单号", bool(id1) and id1 == id2, "%s / %s" % (id1, id2))

        # 5. 确认幂等
        print("[5] 确认幂等：同一订单连续确认两次")
        call(MAIN, "/ai/order/claim", "POST", {"id": id1}, token="orderuser")
        _, c1 = call(MAIN, "/ai/admin/confirm", "POST", {"id": id1}, admin=ADMIN_KEY)
        _, c2 = call(MAIN, "/ai/admin/confirm", "POST", {"id": id1}, admin=ADMIN_KEY)
        u1 = (c1 or {}).get("memberUntil")
        u2 = (c2 or {}).get("memberUntil")
        check("两次确认后到期时间一致（没有多送会员）",
              bool(u1) and u1 == u2, "%s vs %s" % (u1, u2))

        # 6. 越权保护
        print("[6] 越权保护：别人的订单不能 claim")
        c, d = call(MAIN, "/ai/order/claim", "POST", {"id": id1}, token="otheruser")
        check("返回 404 not_found", c == 404 and d.get("code") == "not_found",
              "http=%s code=%s" % (c, d.get("code")))

        # 7. 会员上限
        print("[7] 会员上限：达到防滥用上限返回 member_cap")
        call(CAP, "/ai/quota", "POST", {}, token="capuser")  # 先登记用户
        call(CAP, "/ai/admin/grant", "POST", {"username": "capuser", "days": 30}, admin=ADMIN_KEY)
        c1, d1 = call(CAP, "/ai/polish", "POST", {"text": "会员第1次"}, token="capuser")
        c2, d2 = call(CAP, "/ai/polish", "POST", {"text": "会员第2次"}, token="capuser")
        check("第 1 次成功", c1 == 200, "http=%s" % c1)
        check("第 2 次 402 member_cap", c2 == 402 and d2.get("code") == "member_cap",
              "http=%s code=%s" % (c2, d2.get("code")))

        # 8. 失败退款
        print("[8] 失败退款：上游 AI 报错时退回次数")
        _, before = call(FAILURL, "/ai/quota", "POST", {}, token="refunduser")
        c, d = call(FAILURL, "/ai/polish", "POST", {"text": "退款测试"}, token="refunduser")
        _, after = call(FAILURL, "/ai/quota", "POST", {}, token="refunduser")
        r_before = (before.get("quota") or {}).get("remainingToday")
        r_after = (after.get("quota") or {}).get("remainingToday")
        check("上游报错返回 502 upstream",
              c == 502 and d.get("code") == "upstream", "http=%s code=%s" % (c, d.get("code")))
        check("额度没有被扣掉", r_before == r_after, "%s -> %s" % (r_before, r_after))

        # 9. 启动备份 + 只保留最近 7 份
        print("[9] 数据备份：启动时备份 5 个数据文件，且每个只保留 7 份")
        bdir = os.path.join(WORK, "backup")
        seed = {
            "users.json": {"u1": {"id": "u1", "name": "u1"}},
            "members.json": {"u1": {"until": time.time() + 86400, "name": "u1"}},
            "free.json": {"u1": {"on": True, "name": "u1", "updated": time.time()}},
            "usage.json": {"u1": {"day": "2026-01-01", "free": 1, "member": 0, "total": 1}},
            "orders.json": {"o1": {"id": "o1", "userId": "u1", "status": "paid"}},
        }
        bk_port = free_port()
        bp, _u, bdd = start_server(bk_port, bdir, fresh=True, seed_files=seed)
        procs.append(bp)
        time.sleep(0.6)
        first = sorted(os.listdir(os.path.join(bdd, "backup")))
        check("5 个数据文件都备份了", len(first) == 5, str(first))
        mem_file = os.path.join(bdd, "backup", [f for f in first if f.startswith("members.")][0])
        ok_read = False
        try:
            with open(mem_file, encoding="utf-8") as fh:
                ok_read = isinstance(json.load(fh), dict)
        except Exception:
            ok_read = False
        check("备份内容可读（JSON 合法）", ok_read, os.path.basename(mem_file))
        for i in range(7):  # 再启动 7 次，冲掉最早的备份
            try:
                bp.terminate()
                bp.wait(timeout=5)
            except Exception:
                pass
            time.sleep(0.4)
            bp, _u, _ = start_server(bk_port, bdir, fresh=False)
            procs.append(bp)
        time.sleep(0.6)
        members_bk = [f for f in os.listdir(os.path.join(bdd, "backup")) if f.startswith("members.")]
        check("每个文件最多保留 7 份", len(members_bk) <= 7, "members 备份数=%d" % len(members_bk))

        # 10. 订单恢复与去重（防重复付款）
        print("[10] 订单恢复与去重：旧的未付订单会被作废，已支付订单可被客户端恢复")
        ddir = os.path.join(WORK, "dedupe")
        old_order = {
            "OLD1": {
                "id": "OLD1", "userId": "uid-xuser", "name": "xuser", "plan": "month",
                "planName": "月卡", "days": 30, "amount": 8.0, "status": "pending",
                "created": time.time() - 7200, "claimedAt": 0, "paidAt": 0,
            }
        }
        dp, DEDUPE, ddir = start_server(free_port(), ddir, fresh=True, seed_files={"orders.json": old_order})
        procs.append(dp)
        time.sleep(0.5)
        _, nr = call(DEDUPE, "/ai/order", "POST", {"plan": "month"}, token="xuser")
        new_id = (nr.get("order") or {}).get("id")
        check("重新下单会生成新订单号", bool(new_id) and new_id != "OLD1", "%s" % new_id)
        try:
            with open(os.path.join(ddir, "orders.json"), encoding="utf-8") as fh:
                stored = json.load(fh)
            check("旧的 pending 订单已被作废（canceled）",
                  (stored.get("OLD1") or {}).get("status") == "canceled",
                  "OLD1=%s" % (stored.get("OLD1") or {}).get("status"))
        except Exception as e:  # noqa: BLE001
            check("旧的 pending 订单已被作废（canceled）", False, str(e))
        _, mine1 = call(DEDUPE, "/ai/orders/mine", "POST", {}, token="xuser")
        check("「我的订单」返回最新一笔",
              (mine1.get("order") or {}).get("id") == new_id,
              str((mine1.get("order") or {}).get("id")))
        call(DEDUPE, "/ai/order/claim", "POST", {"id": new_id}, token="xuser")
        _, mine2 = call(DEDUPE, "/ai/orders/mine", "POST", {}, token="xuser")
        mo = mine2.get("order") or {}
        check("已点过支付的订单会被恢复为 claimed（客户端据此显示等待确认）",
              mo.get("id") == new_id and mo.get("status") == "claimed",
              "id=%s status=%s" % (mo.get("id"), mo.get("status")))

        # 11. admin_cli.py 命令行确认收款（管理员每天的实操路径）
        print("[11] admin_cli.py：list / confirm 命令行是否可用")
        _, o = call(MAIN, "/ai/order", "POST", {"plan": "day"}, token="cliuser")
        cid = (o.get("order") or {}).get("id")
        call(MAIN, "/ai/order/claim", "POST", {"id": cid}, token="cliuser")
        cli_env = dict(os.environ)
        cli_env.update({
            "MP_URL": MAIN, "MP_ADMIN_KEY": ADMIN_KEY,
            "MP_DATA_DIR": main_dir, "PYTHONIOENCODING": "utf-8",
        })
        r1 = subprocess.run([PY, CLI, "list"], env=cli_env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
        out1 = (r1.stdout or b"").decode("utf-8", "replace")
        check("admin_cli list 能看到刚提交的订单", bool(cid) and cid in out1,
              str([l for l in out1.splitlines() if cid in l][:1]))
        r2 = subprocess.run([PY, CLI, "confirm", cid], env=cli_env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT)
        out2 = (r2.stdout or b"").decode("utf-8", "replace")
        check("admin_cli confirm 执行成功", "已确认开通" in out2,
              " | ".join(out2.strip().splitlines()[-2:]))
        _, q = call(MAIN, "/ai/quota", "POST", {}, token="cliuser")
        check("该用户已变成会员", bool((q.get("quota") or {}).get("member")),
              str((q.get("quota") or {}).get("member")))

        # 12. 续费顺延：老会员再买一次 → 在原有到期时间上叠加
        print("[12] 续费顺延：会员再开通一次是在原到期时间上叠加")
        call(MAIN, "/ai/quota", "POST", {}, token="renewuser")
        call(MAIN, "/ai/admin/grant", "POST", {"username": "renewuser", "days": 30}, admin=ADMIN_KEY)
        _, q1 = call(MAIN, "/ai/quota", "POST", {}, token="renewuser")
        u1 = (q1.get("quota") or {}).get("memberUntil")
        _, o2 = call(MAIN, "/ai/order", "POST", {"plan": "day"}, token="renewuser")
        cid2 = (o2.get("order") or {}).get("id")
        call(MAIN, "/ai/order/claim", "POST", {"id": cid2}, token="renewuser")
        call(MAIN, "/ai/admin/confirm", "POST", {"id": cid2}, admin=ADMIN_KEY)
        _, q2 = call(MAIN, "/ai/quota", "POST", {}, token="renewuser")
        u2 = (q2.get("quota") or {}).get("memberUntil")
        check("到期时间在原基础上 +1 天（不是从现在重算）",
              bool(u1) and bool(u2) and abs((u2 - u1) - 86400) < 60,
              "相差 %s 秒" % (None if not (u1 and u2) else round(u2 - u1)))

        # 13. 并发确认同一订单：只延长一次
        print("[13] 并发确认：同一订单被同时确认两次，只加一次会员")
        call(MAIN, "/ai/quota", "POST", {}, token="raceuser")
        _, o3 = call(MAIN, "/ai/order", "POST", {"plan": "month"}, token="raceuser")
        cid3 = (o3.get("order") or {}).get("id")
        call(MAIN, "/ai/order/claim", "POST", {"id": cid3}, token="raceuser")
        outs = []

        def confirmer():
            outs.append(call(MAIN, "/ai/admin/confirm", "POST", {"id": cid3}, admin=ADMIN_KEY))

        ts = [threading.Thread(target=confirmer) for _ in range(2)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        _, q3 = call(MAIN, "/ai/quota", "POST", {}, token="raceuser")
        u3 = (q3.get("quota") or {}).get("memberUntil") or 0
        check("到期时间只加了 30 天（没有翻倍）",
              abs((u3 - time.time()) - 30 * 86400) < 120,
              "距现在 %.1f 天" % ((u3 - time.time()) / 86400.0))

        # 14. 启动前置校验：没有 DeepSeek Key 且非 mock 时必须拒绝启动
        print("[14] 启动校验：缺 MP_DEEPSEEK_KEY 时拒绝启动（mock 模式豁免）")
        nokey_dir = os.path.join(WORK, "nokey")
        if os.path.isdir(nokey_dir):
            shutil.rmtree(nokey_dir, ignore_errors=True)
        os.makedirs(nokey_dir)
        env2 = dict(os.environ)
        env2.pop("MP_DEEPSEEK_KEY", None)
        env2.pop("MP_MOCK", None)
        nokey_port = free_port()
        env2.update({"MP_PORT": str(nokey_port), "MP_DATA_DIR": nokey_dir,
                     "MP_ADMIN_KEY": ADMIN_KEY, "MP_CASDOOR_URL": CASDOOR})
        kw2 = {"creationflags": subprocess.CREATE_NO_WINDOW} if hasattr(subprocess, "CREATE_NO_WINDOW") else {}
        p_nokey = subprocess.Popen([PY, SRV], env=env2, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, **kw2)
        try:
            rc = p_nokey.wait(timeout=8)
        except Exception:
            rc = None
        if rc is None:
            p_nokey.kill()
        check("进程自行退出且退出码为 2", rc == 2, "退出码=%s" % rc)
        code_nokey, _d = call("http://127.0.0.1:%d" % nokey_port, "/ai/health", timeout=3)
        check("该端口上没有服务在跑", code_nokey == 0, "http=%s" % code_nokey)

        # 15. 管理员后台页面
        print("[15] 管理后台页面 /admin")
        req = urllib.request.Request(MAIN + "/admin")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                html = r.read().decode("utf-8", "replace")
                ctype = r.headers.get("Content-Type", "")
                code_admin = r.getcode()
        except Exception as e:  # noqa: BLE001
            html, ctype, code_admin = "", "", 0
            print("     请求失败:", e)
        check("页面可访问且是 HTML", code_admin == 200 and "text/html" in ctype,
              "http=%s type=%s" % (code_admin, ctype))
        check("页面标题正确", "轻提词 · AI 服务后台" in html, "")
        check("页面里不含管理员密钥（密钥只存管理员浏览器）",
              ADMIN_KEY not in html, "")
        check("页面带运营摘要与手机适配（viewport + 窄屏样式）",
              "待处理" in html and 'class="summary"' in html
              and 'name="viewport"' in html and "@media (max-width: 480px)" in html, "")
        check("页面带「用户与 AI 额度」面板（登录记录 + 用量 + 免费不限量 + 重置）",
              "用户与 AI 额度" in html and 'id="users"' in html
              and "/ai/admin/users" in html and "/ai/admin/reset" in html
              and "/ai/admin/free" in html and "免费不限量" in html, "")
        # 4.1.2：INS 风重构后的后台 = 左侧导航 + 实时轮询 + 概览/收款码/日志页
        check("页面是 4.1.2 的桌面控制台（左侧导航 + 实时轮询 + 概览看板）",
              "/ai/admin/poll" in html and "/ai/admin/overview" in html
              and "/ai/admin/logs" in html and "/ai/admin/paycode/upload" in html
              and 'class="nav-item' in html and "近 14 天 AI 调用" in html, "")
        # 4.1.3：待处理订单要能「打回」（没收到付款时作废，而不是一直挂在待处理）
        check("订单页带「打回」按钮与接口（4.1.3）",
              "/ai/admin/reject" in html and 'data-reject' in html
              and "打回" in html and "cancelReason" in html, "")
        # 4.1.4：配色与桌面客户端同源（单一强调色靛蓝 + slate 中性底），不再有 INS 渐变
        check("后台配色与客户端一致、没有渐变（4.1.4）",
              "--brand:#6366f1" in html and "--bg:#f8fafc" in html
              and "linear-gradient" not in html.split("<style>")[1].split("</style>")[0], "")
        # 4.1.5：内容区栅格不能再用 .side 当修饰类（会命中左侧栏的 width:236px / height:100vh）
        # 注意：注释里提到 `.grid.side` 是为了留案发记录，所以只卡"规则"和"元素"，不卡字符串出现
        check("概览页两栏栅格用 .grid.split，不再误用 .grid.side（4.1.5）",
              'class="grid split"' in html and ".grid.split {" in html
              and 'class="grid side"' not in html and ".grid.side {" not in html, "")
        # 4.1.6：每个响应都要明说 Connection: close
        # （本服务是 HTTP/1.0 短连接；不明说的话浏览器/中间代理会把连接放回池子复用，
        #   复用到已关闭的 socket 上就报 ERR_CONTENT_LENGTH_MISMATCH、页面偶发空白）
        # 注意：必须用 http.client 直连 —— urllib 会走系统代理，读到的 Connection
        # 是代理自己加的那一份（本机实测：代理把它改写成 keep-alive），测不到服务端真实行为。
        conn_hdrs = []
        _host, _port = "127.0.0.1", int(MAIN.rsplit(":", 1)[1])
        for _path, _method in (("/admin", "GET"), ("/ai/health", "GET"), ("/ai/admin/poll", "POST")):
            try:
                _c = http.client.HTTPConnection(_host, _port, timeout=10)
                _c.request(_method, _path, b"{}" if _method == "POST" else None,
                           {"Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY})
                _r = _c.getresponse()
                _body = _r.read()
                _declared = _r.getheader("Content-Length")
                _conn = _r.getheader("Connection")
                _c.close()
                # 顺带验一件事：声明长度必须等于实收字节（截断在这里就会被抓到）
                _lenok = (_declared is not None and int(_declared) == len(_body))
                conn_hdrs.append((_path, _conn, _lenok))
            except Exception as _e:  # noqa: BLE001
                conn_hdrs.append((_path, "ERR:%s" % _e, False))
        check("所有响应都带 Connection: close 且长度自洽（4.1.6：防复用短连接导致响应被截断）",
              all(str(v).lower() == "close" and ok for _p, v, ok in conn_hdrs),
              ", ".join("%s=%s%s" % (p, v, "" if ok else "(长度不符)") for p, v, ok in conn_hdrs))
        # 4.1.7：读接口失败要自动重试一次，写接口绝不能自动重试（避免重复扣款/重复开通）
        check("读接口带自动重试、写接口不重试（4.1.7）",
              "已自动重试一次" in html and "概览数据没加载出来" in html
              and html.count("api(key, focus || {})") >= 2
              and "need('/ai/admin/confirm'" not in html
              and "need('/ai/admin/reject'" not in html
              and "need('/ai/admin/grant'" not in html
              and "need('/ai/admin/reset'" not in html, "")
        # 面板是手写的 HTML+JS：JS 里 $("xxx") / $('xxx') 引用的 id 必须真的存在，
        # 否则点按钮静默无效（4.1.2 起 JS 统一用单引号，所以两种引号都要认）
        ids_in_html = set(re.findall(r'id="([A-Za-z0-9_\-]+)"', html))
        ids_in_js = set(re.findall(r'\$\(' + r'["\']' + r'([A-Za-z0-9_\-]+)' + r'["\']' + r'\)',
                                   html))
        missing_ids = sorted(ids_in_js - ids_in_html)
        check("面板 JS 引用的元素 id 都存在", bool(ids_in_js) and not missing_ids,
              "JS 引用 %d 个，缺失=%s" % (len(ids_in_js), missing_ids))
        # 页面源文件与注入内容必须一致：改了 admin_ui.html 忘了注入 = 线上还是旧界面
        r = subprocess.run([PY, os.path.normpath(os.path.join(HERE, "..", "sync_admin_page.py")),
                            "--check"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        sync_out = (r.stdout or b"").decode("utf-8", "replace").strip().splitlines()
        check("后台页面源文件 admin_ui.html 已注入 ai_server.py（没有忘同步）",
              r.returncode == 0, sync_out[-1] if sync_out else "")

        # 16. 数据文件损坏时自动从备份恢复
        print("[16] 数据损坏：自动从最近备份恢复（会员不能凭空消失）")
        cdir = os.path.join(WORK, "corrupt")
        corrupt_port = free_port()
        cp, CURL_, cdd = start_server(corrupt_port, cdir, fresh=True)
        procs.append(cp)
        call(CURL_, "/ai/quota", "POST", {}, token="vipuser")
        call(CURL_, "/ai/admin/grant", "POST", {"username": "vipuser", "days": 30}, admin=ADMIN_KEY)
        _, q_before = call(CURL_, "/ai/quota", "POST", {}, token="vipuser")
        u_before = (q_before.get("quota") or {}).get("memberUntil")
        try:
            cp.terminate()
            cp.wait(timeout=5)
        except Exception:
            pass
        time.sleep(0.5)
        cp, _u, _ = start_server(corrupt_port, cdir, fresh=False)
        procs.append(cp)
        time.sleep(0.4)
        bdir = os.path.join(cdd, "backup")
        bk = os.listdir(bdir) if os.path.isdir(bdir) else []
        check("重启后生成了备份文件", any(f.startswith("members.") for f in bk), str(bk))
        with open(os.path.join(cdd, "members.json"), "w", encoding="utf-8") as fh:
            fh.write("{ 这不是合法 JSON")
        try:
            cp.terminate()
            cp.wait(timeout=5)
        except Exception:
            pass
        time.sleep(0.5)
        cp, _u, _ = start_server(corrupt_port, cdir, fresh=False)
        procs.append(cp)
        time.sleep(0.4)
        _, q_after = call(CURL_, "/ai/quota", "POST", {}, token="vipuser")
        u_after = (q_after.get("quota") or {}).get("memberUntil")
        check("会员到期时间没有丢失（已从备份恢复）",
              bool(u_before) and u_before == u_after, "%s vs %s" % (u_before, u_after))
        check("损坏的原文件被留档为 .corrupt",
              os.path.isfile(os.path.join(cdd, "members.json.corrupt")), "")

        # 17. 超长文本：拒绝且不扣额度
        print("[17] 超长文本：拒绝且不扣额度")
        call(MAIN, "/ai/quota", "POST", {}, token="longuser")
        _, qb2 = call(MAIN, "/ai/quota", "POST", {}, token="longuser")
        rb2 = (qb2.get("quota") or {}).get("remainingToday")
        c_long, d_long = call(MAIN, "/ai/polish", "POST", {"text": "长" * 20001}, token="longuser")
        _, qa2 = call(MAIN, "/ai/quota", "POST", {}, token="longuser")
        ra2 = (qa2.get("quota") or {}).get("remainingToday")
        check("返回 400 too_long",
              c_long == 400 and d_long.get("code") == "too_long",
              "http=%s code=%s" % (c_long, d_long.get("code")))
        check("额度没有被扣掉", rb2 == ra2, "%s -> %s" % (rb2, ra2))

        # 18. 免费不限量 + 用量重置（管理后台）
        print("[18] 免费不限量：管理员开通后不受每天 3 次限制，并可重置用量")
        freep, FURL, _ = start_server(free_port(), os.path.join(WORK, "free"))
        procs.append(freep)
        c1, d1 = call(FURL, "/ai/admin/users", "POST", {}, token="freevip")
        check("普通用户不能访问管理员接口",
              c1 == 403 and d1.get("code") == "admin_auth",
              "http=%s code=%s" % (c1, d1.get("code")))
        call(FURL, "/ai/quota", "POST", {}, token="freevip")  # 先建立登录记录
        c2, d2 = call(FURL, "/ai/admin/free", "POST",
                      {"username": "freevip", "on": True}, admin=ADMIN_KEY)
        check("管理员可开通「免费不限量」", c2 == 200 and d2.get("free") is True, str(d2)[:140])
        codes = []
        for i in range(5):  # 超过免费额度 3 次
            c, d = call(FURL, "/ai/polish", "POST", {"text": "免费不限量 %d" % i}, token="freevip")
            codes.append(c)
        check("开通后可连续调用 5 次（不再受每天 3 次限制）",
              all(x == 200 for x in codes), str(codes))
        _, q = call(FURL, "/ai/quota", "POST", {}, token="freevip")
        qq = q.get("quota") or {}
        check("额度视图标记 free=True 且为不限量（remaining=-1）",
              qq.get("free") is True and qq.get("remainingToday") == -1,
              "free=%s remaining=%s used=%s" % (
                  qq.get("free"), qq.get("remainingToday"), qq.get("unlimitedUsedToday")))
        c3, d3 = call(FURL, "/ai/admin/users", "POST", {}, admin=ADMIN_KEY)
        row = next((u for u in (d3.get("users") or []) if u.get("username") == "freevip"), None)
        check("后台用户列表含该账号、登录时间与用量",
              c3 == 200 and bool(row) and row.get("free") is True
              and row.get("totalCalls") == 5 and bool(row.get("first")),
              str(row)[:180])
        c4, d4 = call(FURL, "/ai/admin/reset", "POST", {"username": "freevip"}, admin=ADMIN_KEY)
        q4 = d4.get("quota") or {}
        check("可重置某账号的今日用量（累计保留）",
              c4 == 200 and q4.get("unlimitedUsedToday") == 0 and q4.get("totalCalls") == 5,
              str(q4)[:170])
        c5, d5 = call(FURL, "/ai/admin/reset", "POST",
                      {"username": "freevip", "total": True}, admin=ADMIN_KEY)
        check("可连累计调用数一起清零",
              c5 == 200 and (d5.get("quota") or {}).get("totalCalls") == 0,
              str(d5.get("quota"))[:170])
        c6, d6 = call(FURL, "/ai/admin/free", "POST",
                      {"username": "freevip", "on": False}, admin=ADMIN_KEY)
        check("取消免费不限量后恢复每天 3 次", c6 == 200 and d6.get("free") is False,
              str(d6)[:140])
        c7, d7 = call(FURL, "/ai/admin/free", "POST",
                      {"username": "nobody-xyz", "on": True}, admin=ADMIN_KEY)
        check("给不存在的账号开通会返回 404",
              c7 == 404 and d7.get("code") == "not_found", "http=%s" % c7)

        # 19. 管理员打回（未收到付款）：作废订单、不加会员、留审计、可重新下单
        print("[19] 管理员打回订单：没收到钱时作废，而不是一直挂在待处理")
        _, ro = call(MAIN, "/ai/order", "POST", {"plan": "month"}, token="rejectuser")
        rid = (ro.get("order") or {}).get("id")
        call(MAIN, "/ai/order/claim", "POST", {"id": rid}, token="rejectuser")
        _, rq0 = call(MAIN, "/ai/quota", "POST", {}, token="rejectuser")
        until0 = (rq0.get("quota") or {}).get("memberUntil")
        c8, d8 = call(MAIN, "/ai/admin/reject", "POST",
                      {"id": rid, "reason": "收款码没备注订单号"}, admin=ADMIN_KEY)
        check("管理员可以打回待处理（claimed）订单",
              c8 == 200 and (d8.get("order") or {}).get("status") == "canceled",
              "http=%s status=%s" % (c8, (d8.get("order") or {}).get("status")))
        _, rq1 = call(MAIN, "/ai/quota", "POST", {}, token="rejectuser")
        check("打回不会开通会员（memberUntil 没变）",
              (rq1.get("quota") or {}).get("memberUntil") == until0,
              "%s -> %s" % (until0, (rq1.get("quota") or {}).get("memberUntil")))
        c9, d9 = call(MAIN, "/ai/admin/reject", "POST", {"id": rid}, admin=ADMIN_KEY)
        check("重复打回是幂等的（仍是 canceled，不报错、不覆盖原因）",
              c9 == 200 and (d9.get("order") or {}).get("status") == "canceled"
              and (d9.get("order") or {}).get("cancelReason") == "收款码没备注订单号",
              str(d9)[:150])
        try:
            with open(os.path.join(main_dir, "orders.json"), encoding="utf-8") as fh:
                od = json.load(fh)
            check("磁盘 orders.json 记下了打回原因与时间",
                  (od.get(rid) or {}).get("cancelReason") == "收款码没备注订单号"
                  and float((od.get(rid) or {}).get("canceledAt") or 0) > 0
                  and (od.get(rid) or {}).get("canceledBy") == "admin",
                  str(od.get(rid))[:170])
        except Exception as e:  # noqa: BLE001
            check("磁盘 orders.json 记下了打回原因与时间", False, str(e))
        c10, d10 = call(MAIN, "/ai/admin/logs", "POST", {}, admin=ADMIN_KEY)
        logs = d10.get("logs") or []
        check("打回动作写进了操作审计",
              c10 == 200 and any("打回" in (l.get("action") or "") for l in logs),
              str(logs[:2])[:170])
        _, ro2 = call(MAIN, "/ai/order", "POST", {"plan": "month"}, token="rejectuser")
        check("打回后用户可以重新下单（拿到新订单号）",
              bool((ro2.get("order") or {}).get("id"))
              and (ro2.get("order") or {}).get("id") != rid,
              "%s -> %s" % (rid, (ro2.get("order") or {}).get("id")))
        _, po = call(MAIN, "/ai/order", "POST", {"plan": "day"}, token="paiduser")
        pid = (po.get("order") or {}).get("id")
        call(MAIN, "/ai/admin/confirm", "POST", {"id": pid}, admin=ADMIN_KEY)
        c11, d11 = call(MAIN, "/ai/admin/reject", "POST", {"id": pid}, admin=ADMIN_KEY)
        check("已开通的订单不允许打回（防止一键抹掉会员）",
              c11 == 400 and d11.get("code") == "not_rejectable",
              "http=%s code=%s" % (c11, d11.get("code")))
        c12, d12 = call(MAIN, "/ai/admin/reject", "POST",
                        {"id": "20200101000000-NOPE"}, admin=ADMIN_KEY)
        check("打回不存在的订单返回 404",
              c12 == 404 and d12.get("code") == "not_found", "http=%s" % c12)
        c13, d13 = call(MAIN, "/ai/admin/reject", "POST", {"id": rid})
        check("普通用户打不了订单（403 admin_auth）",
              c13 == 403 and d13.get("code") == "admin_auth", "http=%s" % c13)
    finally:
        for p in procs:
            try:
                p.terminate()
            except Exception:
                pass
        time.sleep(0.5)
        for p in procs:
            try:
                p.kill()
            except Exception:
                pass

    print("=" * 64)
    print("通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
    # 自动清理临时数据目录（显式指定 MP_TEST_WORK 时保留，方便排查）
    if not os.environ.get("MP_TEST_WORK"):
        try:
            shutil.rmtree(WORK, ignore_errors=True)
        except Exception:
            pass
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
