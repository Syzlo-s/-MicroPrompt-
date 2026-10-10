#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
轻提词 · AI 中转服务部署自检（4.0.2）
============================================================
上传新代码并重启服务后，在服务器上跑一次，用来确认「新版到底生效没有」：

    python3 selfcheck.py                          # 检查本机 2581
    python3 selfcheck.py --url http://127.0.0.1:2581
    MP_ADMIN_KEY=你的密钥 python3 selfcheck.py     # 顺便检查管理密钥

检查项：
  1. /ai/health      服务在跑、版本是 4.0.2、是否 mock 模式
  2. /ai/plans       套餐与免费额度是否按预期
  3. 无 token 调 /ai/quota    必须 401（说明鉴权已生效；旧版会直接返回结果 -> 说明还在跑旧代码）
  4. 无 token 调 /ai/polish   必须 401
  5. 假 token 调 /ai/quota    必须 401（说明能连上 Casdoor 并校验）
  6. 管理密钥（给了才测）     正确密钥 200 / 错误密钥 403
"""

import json
import os
import sys
import urllib.error
import urllib.request

OK = "  [OK] "
BAD = "  [X] "
WARN = "  [!]  "


def call(url, path, method="GET", body=None, token=None, admin_key=None, timeout=20):
    """返回 (http_code, dict)"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if admin_key:
        headers["X-Admin-Key"] = admin_key
    req = urllib.request.Request(url.rstrip("/") + path, data=data, headers=headers)
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


def main():
    argv = sys.argv[1:]
    url = "http://127.0.0.1:2581"
    if "--url" in argv:
        url = argv[argv.index("--url") + 1]
    admin_key = os.environ.get("MP_ADMIN_KEY", "").strip()

    print("轻提词 AI 服务自检 ->", url)
    print("-" * 62)
    fails = 0

    # 1) 健康检查
    code, d = call(url, "/ai/health")
    if code == 200 and d.get("ok"):
        print(OK + "服务在跑：version=%s mock=%s" % (d.get("version"), d.get("mock")))
        if d.get("version") != "4.0.2":
            print(WARN + "版本不是 4.0.2（当前 %s）——可能还是旧代码" % d.get("version"))
            fails += 1
    else:
        if code in (404, 501):
            print(BAD + "/ai/health 不存在（http=%s）" % code)
            print("      -> 服务器上还是 4.0.0 旧代码：请上传 ai_server.py 后重启服务")
        else:
            print(BAD + "/ai/health 不通（http=%s %s）" % (code, d.get("_err", d.get("error", ""))))
            print("      -> 服务没起来 / 端口没放行 / 地址不对")
            print("      -> 也可能是启动失败：日志里搜「启动失败」，多半是没设 MP_DEEPSEEK_KEY")
            print("         tail -n 30 ai_server.log")
        return 1

    # 2) 套餐
    code, d = call(url, "/ai/plans")
    if code == 200 and d.get("ok"):
        plans = {p["key"]: p for p in d.get("plans") or []}
        print(OK + "套餐：日卡 %s 元/%s 天，月卡 %s 元/%s 天；免费每天 %s 次"
              % (
                  plans.get("day", {}).get("amount"),
                  plans.get("day", {}).get("days"),
                  plans.get("month", {}).get("amount"),
                  plans.get("month", {}).get("days"),
                  d.get("freeDaily"),
              ))
    else:
        print(BAD + "/ai/plans 异常（http=%s）" % code)
        fails += 1

    # 3) 无 token 鉴权
    code, d = call(url, "/ai/quota")
    if code == 401 and d.get("code") == "auth":
        print(OK + "鉴权已生效：无 token 调 /ai/quota -> 401 auth")
    else:
        print(BAD + "无 token 调 /ai/quota 返回 http=%s（应为 401）" % code)
        print("      -> 如果返回 200/404，说明服务器上还是 4.0.0 旧代码，请重新上传并重启")
        fails += 1

    code, d = call(url, "/ai/polish", method="POST", body={"text": "自检"})
    if code == 401:
        print(OK + "无 token 调 /ai/polish -> 401（不会再白刷 DeepSeek Key）")
    else:
        print(BAD + "无 token 调 /ai/polish 返回 http=%s（应为 401）" % code)
        fails += 1

    # 4) 能连上 Casdoor 吗（用假 token 触发一次真实校验）
    code, d = call(url, "/ai/quota", token="selfcheck-invalid-token")
    if code == 401 and d.get("code") == "auth":
        print(OK + "服务端能连 Casdoor：假 token 被拒绝（401 auth）")
    else:
        print(WARN + "假 token 返回 http=%s msg=%s" % (code, d.get("error")))
        print("      预期 401；若是 5xx，检查 MP_CASDOOR_URL 是否可达")
        fails += 1

    # 5) 管理密钥（可选）
    if admin_key:
        code_ok, _ = call(url, "/ai/admin/orders", method="POST", body={}, admin_key=admin_key)
        code_bad, _ = call(url, "/ai/admin/orders", method="POST", body={}, admin_key="definitely-wrong")
        if code_ok == 200 and code_bad == 403:
            print(OK + "管理员密钥有效（正确 200 / 错误 403）")
        else:
            print(BAD + "管理员密钥检查失败（正确=%s 应为 200，错误=%s 应为 403）" % (code_ok, code_bad))
            print("      -> 确认服务启动时用的 MP_ADMIN_KEY 与这里一致；含中文时建议换成字母数字")
            fails += 1
    else:
        print(WARN + "未提供 MP_ADMIN_KEY，跳过管理员密钥检查")

    print("-" * 62)
    if fails == 0:
        print("结论：部署成功，客户端可以正常使用。")
        print("管理后台：浏览器打开 %s/admin 确认收款开通会员（粘贴管理员密钥即可）"
              % url.rstrip("/"))
        return 0
    print("结论：有 %d 项不符合预期，按上面提示处理后重跑本脚本。" % fails)
    return 1


if __name__ == "__main__":
    sys.exit(main())
