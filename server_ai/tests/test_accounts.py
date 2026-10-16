# -*- coding: utf-8 -*-
"""轻提词 4.1.0「自建账号系统」回归套件（对应方案 §9.1 的组 19~24、26、28）
================================================================
自动拉起一个 MP_AUTH_MODE=builtin 的 ai_server 实例：
  · MP_PORT      = 动态空闲端口（AI 接口，2581 的角色）
  · MP_AUTH_PORT = 动态空闲端口（自建账号接口，生产上是客户端写死的 2580）

覆盖：
  19 注册        成功 / 重名（含大小写与空格差异）/ 密码 <8 / 非法用户名 / 非 JSON 请求体
  20 登录        成功拿 JWT 且 payload 含 id/name / 密码错与用户不存在话术一致 /
                 停用账号被拒（且密码错时不暴露停用）/ client 凭据缺失被拒
  21 凭证        alg=none 被拒 / 算法混淆被拒 / 签名篡改被拒 / 过期被拒 / 错误密钥被拒
  22 撤销        重置密码、停用、踢下线后旧令牌立刻失效；启用后可重新登录
  23 防爆破      同名连续失败锁定；锁定期内正确密码也被拒；成功登录清零；
                 不存在的用户名同样会被锁（不泄露存在性）；IP 维度锁定
  24 兼容层      5 个接口形状对齐方案 §3；OPTIONS 204 且带 CORS；404 也带 CORS；
                 /api/get-account 白名单（响应里搜不到 pwd/哈希）；/avatar 可 GET；
                 上传按魔数与大小限制
  26 权限        非管理员调 /ai/admin/account/* 403；/api/update-user 忽略 id/name/pwd/tokenVer
  28 后台账号    create（含指定 uid）/ resetpwd / status / kick / note / list

用法（在 server_ai 目录下）：
    python3 tests/test_accounts.py
    MP_TEST_WORK=/tmp/mp-acc-test python3 tests/test_accounts.py   # 指定数据目录（便于排查）

依赖：只有 Python3 标准库；全程 MP_MOCK=1，不调用 DeepSeek，不碰真实 data/。
"""

import base64
import hashlib
import hmac
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PY = sys.executable
HERE = os.path.dirname(os.path.abspath(__file__))
SRV = os.path.normpath(os.path.join(HERE, "..", "ai_server.py"))
WORK = os.environ.get("MP_TEST_WORK") or tempfile.mkdtemp(prefix="mp-acc-rules-")
ADMIN_KEY = "acckey456"
# 测试里把 PBKDF2 迭代次数调低：这里要验的是逻辑，不是耗时（耗时另有专项断言）
TEST_ITERS = "2000"
# 主实例把 IP 维度阈值调高：本套件会刻意制造大量失败登录，
# 若不调高会连累后续用例（IP 维度锁定另有独立实例专测）
BIG_IP_FAIL = "100000"

# 一个只满足魔数的最小 PNG（服务端只按文件头判类型）
PNG_1PX = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40

PASS, FAIL = [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("  [PASS] " if ok else "  [FAIL] ") + name + (("   " + detail) if detail else ""))


def free_port():
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def call(url, path, method="GET", body=None, token=None, admin=None,
         form=None, raw=None, ctype=None, timeout=30):
    """返回 (http_code, json_dict, headers_dict)。"""
    data = None
    headers = {}
    if raw is not None:
        data = raw
        if ctype:
            headers["Content-Type"] = ctype
    elif form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    if admin:
        headers["X-Admin-Key"] = admin
    req = urllib.request.Request(url.rstrip("/") + path, data=data, headers=headers)
    if method != "GET":
        req.get_method = lambda: method
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            blob = r.read()
            hdrs = {k.lower(): v for k, v in r.getheaders()}
            try:
                payload = json.loads(blob.decode("utf-8") or "{}")
            except Exception:
                payload = {"_raw": blob}
            return r.getcode(), payload, hdrs
    except urllib.error.HTTPError as e:
        try:
            blob = e.read()
            hdrs = {k.lower(): v for k, v in e.headers.items()}
            try:
                payload = json.loads(blob.decode("utf-8") or "{}")
            except Exception:
                payload = {"_raw": blob}
            return e.code, payload, hdrs
        except Exception:
            return e.code, {}, {}
    except Exception as e:  # noqa: BLE001
        return 0, {"_err": str(e)}, {}


def multipart(fields, filename="avatar.png", content=b"", ftype="image/png"):
    """手搓一个 multipart 请求体（服务端也是手搓解析的，正好互验）。"""
    bd = "----mpboundary1234567890"
    out = b""
    for k, v in fields.items():
        out += ('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n'
                % (bd, k, v)).encode("utf-8")
    out += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="%s"\r\n'
            'Content-Type: %s\r\n\r\n' % (bd, filename, ftype)).encode("utf-8")
    out += content + b"\r\n"
    out += ("--%s--\r\n" % bd).encode("utf-8")
    return out, "multipart/form-data; boundary=" + bd


def start_server(port, auth_port, data_dir, extra_env=None, fresh=True):
    if fresh and os.path.isdir(data_dir):
        shutil.rmtree(data_dir, ignore_errors=True)
    if not os.path.isdir(data_dir):
        os.makedirs(data_dir)
    env = dict(os.environ)
    env.update({
        "MP_PORT": str(port),
        "MP_AUTH_PORT": str(auth_port),
        "MP_AUTH_MODE": "builtin",
        "MP_DATA_DIR": data_dir,
        "MP_ADMIN_KEY": ADMIN_KEY,
        "MP_MOCK": "1",
        "MP_RATE_LIMIT_SEC": "0",
        "MP_FREE_DAILY": "3",
        "MP_PBKDF2_ITERS": TEST_ITERS,
        "MP_IP_MAX_FAIL": BIG_IP_FAIL,
    })
    if extra_env:
        env.update(extra_env)
    kw = {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        kw["creationflags"] = subprocess.CREATE_NO_WINDOW
    proc = subprocess.Popen([PY, SRV], env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, **kw)
    ai_url = "http://127.0.0.1:%d" % port
    auth_url = "http://127.0.0.1:%d" % auth_port
    for _ in range(60):
        time.sleep(0.25)
        code, _d, _h = call(ai_url, "/ai/health", timeout=3)
        if code == 200:
            break
    # 自建账号监听是另一个端口，也要等它就绪
    for _ in range(40):
        code, _d, _h = call(auth_url, "/api/get-account", timeout=3)
        if code == 401:
            break
        time.sleep(0.25)
    return proc, ai_url, auth_url, data_dir


# ---------------- 测试内的独立 JWT 实现（用来伪造各种坏令牌） ----------------

def _b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=")


def sign_token(payload, secret):
    head = _b64u(json.dumps({"alg": "HS256", "typ": "JWT"},
                            separators=(",", ":")).encode())
    body = _b64u(json.dumps(payload, separators=(",", ":")).encode())
    sig = _b64u(hmac.new(secret.encode(), head + b"." + body, hashlib.sha256).digest())
    return (head + b"." + body + b"." + sig).decode()


def sign_raw(head_obj, payload_obj, secret, sig_override=None):
    """按给定 header/payload 组一个令牌（header 可随意改，用来测撞算法）。"""
    head = _b64u(json.dumps(head_obj, separators=(",", ":")).encode())
    body = _b64u(json.dumps(payload_obj, separators=(",", ":")).encode())
    if sig_override is not None:
        sig = sig_override
    else:
        sig = _b64u(hmac.new(secret.encode(), head + b"." + body,
                             hashlib.sha256).digest())
    return (head + b"." + body + b"." + sig).decode()


def jwt_payload(token):
    part = (token or "").split(".")[1] if token and token.count(".") == 2 else ""
    part = part.replace("-", "+").replace("_", "/")
    part += "=" * (-len(part) % 4)
    try:
        return json.loads(base64.b64decode(part).decode("utf-8"))
    except Exception:
        return {}


def do_login(auth_url, name, pwd, cid="b49640f6c4dabd78ce94", secret="s" * 40):
    return call(auth_url, "/api/login/oauth/access_token", "POST",
                form={"grant_type": "password", "client_id": cid,
                      "client_secret": secret, "username": name, "password": pwd,
                      "scope": "read"})


def login_ok(auth_url, name, pwd):
    code, d, _h = do_login(auth_url, name, pwd)
    return (d.get("access_token") or "") if code == 200 else ""


def main():
    if os.path.isdir(WORK):
        shutil.rmtree(WORK, ignore_errors=True)
    os.makedirs(WORK)

    procs = []
    print("轻提词 4.1.0 自建账号系统回归")
    print("=" * 64)
    try:
        port, aport = free_port(), free_port()
        main_p, AI, AUTH, DATA = start_server(port, aport, os.path.join(WORK, "main"))
        procs.append(main_p)
        if call(AI, "/ai/health")[0] != 200:
            print("  [FAIL] 服务未能启动，后续用例无法执行")
            print("         检查 ai_server.py 能否用 %s 启动" % PY)
            return 1

        # ---------------- 19 注册 ----------------
        print("[19] 注册")
        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"application": "app-microprompt",
                            "organization": "microprompt",
                            "username": "alice", "password": "pw123456"})
        check("注册成功返回 status=ok 且 data=用户名",
              code == 200 and d.get("status") == "ok" and d.get("data") == "alice", str(d)[:120])

        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "alice", "password": "pw123456"})
        check("重名（完全一致）被拒", d.get("status") == "error" and "已被注册" in (d.get("msg") or ""),
              str(d)[:120])
        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "ALICE", "password": "pw123456"})
        check("重名（大小写不同）也被拒", d.get("status") == "error", str(d)[:120])
        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "  alice  ", "password": "pw123456"})
        check("重名（前后空格）也被拒", d.get("status") == "error", str(d)[:120])

        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "shortpw", "password": "1234567"})
        check("密码 <8 位被拒且话术与客户端一致",
              d.get("status") == "error" and "至少 8 位" in (d.get("msg") or ""), str(d)[:120])

        for bad in ("_abc", "abc-", "a b", "a" * 33, "中文 名", "名" * 33, "张三·"):
            code, d, _h = call(AUTH, "/api/signup", "POST",
                               {"username": bad, "password": "pw123456"})
            if d.get("status") != "error":
                check("非法用户名被拒：%r" % bad, False, str(d)[:100])
                break
        else:
            check("非法用户名（首尾符号/含空格/超长/中文带空格或间隔号）全部被拒", True)

        # 单字用户名：4.1.1 同日放开（用户实际填的是「吴」这种单姓，2 位下限会误伤）
        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "吴", "password": "pw123456"})
        check("单字中文用户名可注册（1 字）",
              d.get("status") == "ok" and d.get("data") == "吴", str(d)[:120])
        code, d, _h = do_login(AUTH, "吴", "pw123456")
        check("单字中文用户名可登录（注册→登录闭环）", bool(d.get("access_token")), str(d)[:120])

        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "ab", "password": "pw123456"})
        check("双字符用户名可注册（下限已放宽到 1 位）",
              d.get("status") == "ok" and d.get("data") == "ab", str(d)[:120])

        # 中文用户名：4.1.1 起放开（老 Casdoor 时代用户习惯用中文昵称）
        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "张三", "password": "pw123456"})
        check("中文用户名可注册（2 字）",
              d.get("status") == "ok" and d.get("data") == "张三", str(d)[:120])
        code, d, _h = do_login(AUTH, "张三", "pw123456")
        check("中文用户名可登录（注册→登录闭环）", bool(d.get("access_token")), str(d)[:120])

        code, d, _h = call(AUTH, "/api/signup", "POST",
                           {"username": "测试用户abc", "password": "pw123456"})
        check("中英混排用户名可注册",
              d.get("status") == "ok" and d.get("data") == "测试用户abc", str(d)[:120])

        code, d, _h = call(AUTH, "/api/signup", "POST", raw=b"not-json",
                           ctype="application/json")
        check("非 JSON 请求体返回「请求格式不正确」",
              d.get("status") == "error" and "请求格式不正确" in (d.get("msg") or ""),
              str(d)[:120])

        # ---------------- 20 登录 ----------------
        print("[20] 登录")
        code, d, _h = do_login(AUTH, "alice", "pw123456")
        token_a = d.get("access_token") or ""
        check("登录成功返回 access_token / Bearer / expires_in",
              code == 200 and token_a and d.get("token_type") == "Bearer"
              and int(d.get("expires_in") or 0) == 604800, str(d)[:100])
        pl = jwt_payload(token_a)
        check("JWT payload 含 id 与 name，且 id 是 UUID（不等于用户名）",
              bool(pl.get("id")) and pl.get("name") == "alice"
              and pl.get("id") != "alice" and len(str(pl.get("id")).split("-")) == 5,
              "id=%s name=%s" % (pl.get("id"), pl.get("name")))
        check("JWT 过期时间为 7 天（604800）",
              int(pl.get("exp") or 0) - int(pl.get("iat") or 0) == 604800, str(pl.get("exp")))

        _c, d_wrong, _h = do_login(AUTH, "alice", "wrong-password")
        _c, d_ghost, _h = do_login(AUTH, "nobody-here", "whatever123")
        check("密码错与用户不存在的话术完全一致（不泄露账号是否存在）",
              d_wrong.get("error_description") == d_ghost.get("error_description")
              == "用户名或密码不正确",
              "%s / %s" % (d_wrong.get("error_description"), d_ghost.get("error_description")))
        _c, d, _h = do_login(AUTH, "alice", "pw123456", cid="", secret="")
        check("client 凭据缺失被拒", d.get("error") == "invalid_client", str(d)[:100])

        call(AUTH, "/api/signup", "POST", {"username": "banned", "password": "pw123456"})
        _uid_b, acc_b = None, None
        raw_accounts = json.load(open(os.path.join(DATA, "accounts.json"), encoding="utf-8"))
        for uid, acc in raw_accounts.items():
            if acc.get("name") == "banned":
                _uid_b, acc_b = uid, acc
        check("accounts.json 里保存的是 pbkdf2 单向哈希（不是明文/可逆）",
              bool(acc_b) and str(acc_b.get("pwd", "")).startswith("pbkdf2_sha256$")
              and str(acc_b.get("pwd", "")).count("$") == 3
              and "pw123456" not in json.dumps(acc_b), str(acc_b.get("pwd"))[:40])
        tok_b = login_ok(AUTH, "banned", "pw123456")
        call(AI, "/ai/admin/account/status", "POST",
             {"name": "banned", "status": "disabled"}, admin=ADMIN_KEY)
        _c, d, _h = do_login(AUTH, "banned", "pw123456")
        check("停用账号即使密码正确也被拒，且提示「已停用」",
              "停用" in (d.get("error_description") or ""), str(d)[:120])
        _c, d2, _h = do_login(AUTH, "banned", "bad-password")
        check("停用账号 + 错误密码时不暴露「已停用」（仍是统一话术）",
              d2.get("error_description") == "用户名或密码不正确", str(d2)[:120])
        call(AI, "/ai/admin/account/status", "POST",
             {"name": "banned", "status": "active"}, admin=ADMIN_KEY)

        # ---------------- 21 凭证 ----------------
        print("[21] 凭证校验")
        secret = open(os.path.join(DATA, "jwt_secret.txt"), encoding="utf-8").read().strip()
        future = int(time.time()) + 3600
        code, _d, _h = call(AUTH, "/api/get-account", token=sign_raw(
            {"alg": "none", "typ": "JWT"}, {"id": "x", "name": "x", "exp": future},
            secret, sig_override=b""))
        check("alg=none 被拒", code == 401, "http=%s" % code)
        code, _d, _h = call(AUTH, "/api/get-account", token=sign_raw(
            {"alg": "RS256", "typ": "JWT"}, {"id": "x", "name": "x", "exp": future}, secret))
        check("算法混淆（header 写 RS256）被拒", code == 401, "http=%s" % code)
        parts = token_a.split(".")
        tampered = parts[0] + "." + parts[1] + "." + (
            ("A" if parts[2][10] != "A" else "B") + parts[2][11:])
        code, _d, _h = call(AUTH, "/api/get-account", token=tampered)
        check("签名被篡改一律拒绝", code == 401, "http=%s" % code)
        code, _d, _h = call(AUTH, "/api/get-account", token=sign_token(
            {"id": pl.get("id"), "name": "alice", "ver": 1,
             "exp": int(time.time()) - 60}, secret))
        check("已过期令牌被拒", code == 401, "http=%s" % code)
        code, _d, _h = call(AUTH, "/api/get-account", token=sign_token(
            {"id": pl.get("id"), "name": "alice", "ver": 1, "exp": future},
            "not-the-real-secret"))
        check("用错误密钥签发的令牌被拒", code == 401, "http=%s" % code)

        # ---------------- 24 兼容层（先于撤销，用干净令牌） ----------------
        print("[24] Casdoor 兼容层")
        code, d, hdrs = call(AUTH, "/api/get-account", token=token_a)
        check("GET /api/get-account 成功且形状为 {status:ok,data:{...}}",
              code == 200 and d.get("status") == "ok" and isinstance(d.get("data"), dict),
              str(d)[:120])
        data = d.get("data") or {}
        check("data 只白名单输出（含 id/name/displayName/avatar/createdTime）",
              set(data.keys()) == {"id", "name", "displayName", "avatar",
                                   "createdTime", "lastLoginTime"}, str(sorted(data.keys())))
        check("data 里搜不到密码哈希或 tokenVer",
              "pwd" not in json.dumps(d) and "pbkdf2" not in json.dumps(d)
              and "tokenVer" not in json.dumps(d), json.dumps(d)[:120])

        code, d, _h = call(AUTH, "/api/get-account")
        check("无令牌取用户信息返回 401", code == 401, "http=%s" % code)

        # 改资料：白名单内生效
        payload = dict(data)
        payload["displayName"] = "爱丽丝"
        code, d, _h = call(AUTH, "/api/update-user", "POST", payload, token=token_a)
        check("POST /api/update-user 改 displayName 返回 status=ok",
              code == 200 and d.get("status") == "ok", str(d)[:100])
        _c, d, _h = call(AUTH, "/api/get-account", token=token_a)
        check("displayName 已生效（中文不乱码）",
              (d.get("data") or {}).get("displayName") == "爱丽丝",
              str((d.get("data") or {}).get("displayName")))

        # 改资料：白名单外必须被忽略
        evil = dict(data)
        evil.update({"id": "hacked-id", "name": "hacker", "pwd": "plaintext-pw",
                     "tokenVer": 999, "status": "disabled", "note": "x",
                     "createdTime": "1970-01-01T00:00:00+08:00"})
        evil["displayName"] = "正常名字"
        call(AUTH, "/api/update-user", "POST", evil, token=token_a)
        _c, d_after, _h = call(AUTH, "/api/get-account", token=token_a)
        rec = d_after.get("data") or {}
        check("update-user 忽略 id/name/pwd/tokenVer/status/note 等非白名单字段",
              rec.get("id") == pl.get("id") and rec.get("name") == "alice"
              and rec.get("displayName") == "正常名字", json.dumps(rec)[:150])
        check("旧令牌在 update-user 之后仍然有效（改资料不等于改密码）",
              call(AUTH, "/api/get-account", token=token_a)[0] == 200)

        # CORS / OPTIONS
        code, _d, hdrs = call(AUTH, "/api/signup", "OPTIONS")
        check("OPTIONS 预检返回 204 且带 CORS 头",
              code == 204 and hdrs.get("access-control-allow-origin") == "*"
              and "authorization" in (hdrs.get("access-control-allow-headers") or "").lower(),
              "http=%s allow-headers=%s" % (code, hdrs.get("access-control-allow-headers")))
        code, _d, hdrs = call(AUTH, "/api/definitely-not-exist", "POST", {})
        check("未知 /api/* 返回 404 且仍带 CORS 头（否则客户端会误报网络错误）",
              code == 404 and hdrs.get("access-control-allow-origin") == "*",
              "http=%s acao=%s" % (code, hdrs.get("access-control-allow-origin")))
        check("2581 端口同样提供自建账号接口（便于不碰生产做联调）",
              call(AI, "/api/get-account", token=token_a)[0] == 200)

        # 头像
        body, ctype = multipart({"owner": "microprompt", "tag": "avatar",
                                 "application": "app-microprompt"}, content=PNG_1PX)
        code, d, _h = call(AUTH, "/api/upload-resource", "POST", raw=body,
                           ctype=ctype, token=token_a)
        url = d.get("data") or ""
        check("上传头像成功并返回可访问的 URL",
              code == 200 and d.get("status") == "ok" and "/avatar/" in url, str(d)[:140])
        path = "/avatar/" + url.rsplit("/avatar/", 1)[-1] if "/avatar/" in url else "/avatar/x"
        code, _d, hdrs = call(AUTH, path)
        check("返回的头像 URL 能直接 GET 到图片",
              code == 200 and hdrs.get("content-type") == "image/png",
              "http=%s type=%s" % (code, hdrs.get("content-type")))
        check("头像文件名由服务端生成（<uid>.<ext>）",
              path.startswith("/avatar/" + str(pl.get("id"))), path)
        code, _d, _h = call(AUTH, "/avatar/../../etc/passwd")
        check("头像路径穿越被拒", code == 404, "http=%s" % code)

        body, ctype = multipart({}, filename="evil.png", content=b"just text, not an image")
        _c, d, _h = call(AUTH, "/api/upload-resource", "POST", raw=body,
                         ctype=ctype, token=token_a)
        check("伪装成 png 的非图片按魔数被拒",
              d.get("status") == "error" and "PNG" in (d.get("msg") or ""), str(d)[:120])
        body, ctype = multipart({}, content=b"\x89PNG\r\n\x1a\n" + b"\x00" * (3 * 1024 * 1024))
        _c, d, _h = call(AUTH, "/api/upload-resource", "POST", raw=body,
                         ctype=ctype, token=token_a)
        check("超过 2 MB 的头像被拒",
              d.get("status") == "error" and "2 MB" in (d.get("msg") or ""), str(d)[:120])
        _c, d, _h = call(AUTH, "/api/upload-resource", "POST", raw=b"",
                         ctype="multipart/form-data", token=token_a)
        check("空请求体不会 404（返回明确错误，避免客户端提示「无法连接服务器」）",
              d.get("status") == "error", str(d)[:100])

        # ---------------- 22 撤销 ----------------
        print("[22] 凭证撤销")
        call(AUTH, "/api/signup", "POST", {"username": "revoke", "password": "pw123456"})
        tok1 = login_ok(AUTH, "revoke", "pw123456")
        check("撤销前令牌可用", call(AUTH, "/api/get-account", token=tok1)[0] == 200)
        check("令牌可用于 AI 接口（本地校验打通 /ai/*）",
              call(AI, "/ai/quota", token=tok1)[0] == 200)
        _c, d, _h = call(AI, "/ai/admin/account/resetpwd", "POST",
                         {"name": "revoke"}, admin=ADMIN_KEY)
        temp = d.get("tempPassword") or ""
        check("重置密码返回一次性临时密码（10 位）", len(temp) == 10, "len=%s" % len(temp))
        check("重置密码后旧令牌立刻失效",
              call(AUTH, "/api/get-account", token=tok1)[0] == 401)
        check("重置密码后旧密码不能登录",
              not (do_login(AUTH, "revoke", "pw123456")[1].get("access_token")))
        tok2 = login_ok(AUTH, "revoke", temp)
        check("临时密码可以登录", bool(tok2))
        call(AI, "/ai/admin/account/kick", "POST", {"name": "revoke"}, admin=ADMIN_KEY)
        check("踢下线后令牌立刻失效（tokenVer+1）",
              call(AUTH, "/api/get-account", token=tok2)[0] == 401)
        tok3 = login_ok(AUTH, "revoke", temp)
        call(AI, "/ai/admin/account/status", "POST",
             {"name": "revoke", "status": "disabled"}, admin=ADMIN_KEY)
        check("停用后该用户新令牌也失效",
              call(AUTH, "/api/get-account", token=tok3)[0] == 401)
        check("停用后 AI 接口也拒绝",
              call(AI, "/ai/quota", token=tok3)[0] == 401)
        call(AI, "/ai/admin/account/status", "POST",
             {"name": "revoke", "status": "active"}, admin=ADMIN_KEY)
        check("启用后可以重新登录", bool(login_ok(AUTH, "revoke", temp)))

        # ---------------- 26 权限 ----------------
        print("[26] 权限")
        for ep in ("list", "create", "resetpwd", "status", "kick", "note"):
            code, _d, _h = call(AI, "/ai/admin/account/" + ep, "POST", {}, admin="wrong-key")
            if code != 403:
                check("非管理员调 /ai/admin/account/%s 返回 403" % ep, False, "http=%s" % code)
                break
        else:
            check("非管理员调 6 个账号管理接口全部 403", True)

        # ---------------- 28 后台账号管理 ----------------
        print("[28] 后台账号管理")
        code, d, _h = call(AI, "/ai/admin/account/create", "POST",
                           {"name": "seeded", "password": "pw123456",
                            "uid": "13736fe6-5ba9-4d38-bfd1-ca5ca2971d90",
                            "displayName": "播种账号", "note": "迁移用"},
                           admin=ADMIN_KEY)
        seeded = d.get("account") or {}
        check("后台新建账号可指定 uid（沿用老 uid 才不会丢会员/用量）",
              code == 200 and seeded.get("id") == "13736fe6-5ba9-4d38-bfd1-ca5ca2971d90",
              json.dumps(seeded)[:140])
        check("后台账号视图不含密码哈希", "pwd" not in json.dumps(seeded), json.dumps(seeded)[:120])
        tok_s = login_ok(AUTH, "seeded", "pw123456")
        check("播种账号的 uid 就是令牌里的 id（用量主键对齐）",
              jwt_payload(tok_s).get("id") == "13736fe6-5ba9-4d38-bfd1-ca5ca2971d90",
              str(jwt_payload(tok_s).get("id")))
        _c, d, _h = call(AI, "/ai/admin/account/list", "POST", {}, admin=ADMIN_KEY)
        names = [a.get("name") for a in (d.get("accounts") or [])]
        check("账号列表含新建的账号", "seeded" in names, str(names))
        _c, d, _h = call(AI, "/ai/admin/account/note", "POST",
                         {"name": "seeded", "note": "VIP 客户"}, admin=ADMIN_KEY)
        check("备注可修改", (d.get("account") or {}).get("note") == "VIP 客户", str(d)[:100])
        _c, d, _h = call(AI, "/ai/admin/account/create", "POST",
                         {"name": "seeded", "password": "pw123456"}, admin=ADMIN_KEY)
        check("重名新建被拒（400）", d.get("ok") is False, str(d)[:100])
        _c, d, _h = call(AI, "/ai/admin/account/resetpwd", "POST",
                         {"name": "not-exist-user"}, admin=ADMIN_KEY)
        check("给不存在的账号重置密码返回 404", d.get("ok") is False, str(d)[:100])
        _c, d, _h = call(AI, "/ai/admin/users", "POST", {}, admin=ADMIN_KEY)
        rows = {r.get("username"): r for r in (d.get("users") or [])}
        row = rows.get("seeded") or {}
        check("/ai/admin/users 的每行带账号字段（状态/注册时间/最后登录/备注/凭证版本）",
              row.get("account") is True and row.get("hasPwd") is True
              and row.get("status") == "active" and row.get("note") == "VIP 客户"
              and int(row.get("tokenVer") or 0) >= 1 and float(row.get("created") or 0) > 0,
              json.dumps({k: row.get(k) for k in
                          ("account", "hasPwd", "status", "note", "tokenVer", "created")},
                         ensure_ascii=False)[:160])
        check("后台新建但从未登录的账号也出现在用户列表里（不依赖登录记录）",
              "seeded" in rows, str(sorted(rows.keys())))

        # ---------------- 23 防爆破 ----------------
        print("[23] 防爆破")
        call(AUTH, "/api/signup", "POST", {"username": "lockme", "password": "rightpw123"})
        for _ in range(5):
            do_login(AUTH, "lockme", "wrongpw")
        _c, d, _h = do_login(AUTH, "lockme", "rightpw123")
        check("同一用户名连续失败 5 次后，第 6 次即使密码正确也被拒",
              "尝试次数过多" in (d.get("error_description") or ""), str(d)[:120])
        for _ in range(5):
            do_login(AUTH, "ghost-user-x", "whatever")
        _c, d, _h = do_login(AUTH, "ghost-user-x", "whatever")
        check("不存在的用户名同样会被锁（否则「被锁」本身就是账号枚举信号）",
              "尝试次数过多" in (d.get("error_description") or ""), str(d)[:120])

        call(AUTH, "/api/signup", "POST", {"username": "clearme", "password": "rightpw123"})
        for _ in range(2):
            do_login(AUTH, "clearme", "wrongpw")
        check("失败 2 次后正确密码仍可登录", bool(login_ok(AUTH, "clearme", "rightpw123")))
        for _ in range(4):
            do_login(AUTH, "clearme", "wrongpw")
        _c, d, _h = do_login(AUTH, "clearme", "rightpw123")
        check("登录成功会清零失败计数（再失败 4 次仍未被锁）",
              bool(d.get("access_token")), str(d)[:120])

        # IP 维度：单独一个实例，阈值调小
        ip_p, ip_ai, ip_auth, _d2 = start_server(
            free_port(), free_port(), os.path.join(WORK, "iplock"),
            {"MP_IP_MAX_FAIL": "3"})
        procs.append(ip_p)
        for i in range(3):
            do_login(ip_auth, "somebody-%d" % i, "wrongpw")
        _c, d, _h = do_login(ip_auth, "somebody-9", "wrongpw")
        check("同一 IP 连续失败达阈值后，后续登录一律被拒（IP 维度限速）",
              "尝试次数过多" in (d.get("error_description") or ""), str(d)[:120])

        # ---------------- 29 数据兜底与持久化 ----------------
        print("[29] 数据兜底与持久化")
        _c, d, _h = call(AI, "/ai/admin/account/create", "POST",
                         {"name": "backupcheck", "password": "pw123456"}, admin=ADMIN_KEY)
        check("新建账号成功（用于重启后校验持久化）",
              (d.get("account") or {}).get("name") == "backupcheck", str(d)[:100])
        main_p.terminate()
        try:
            main_p.wait(timeout=5)
        except Exception:
            main_p.kill()
        time.sleep(0.5)
        rest_p, rest_ai, rest_auth, _dd = start_server(port, aport, DATA, fresh=False)
        procs.append(rest_p)
        check("重启后账号仍在（accounts.json 被正确加载）",
              bool(login_ok(rest_auth, "backupcheck", "pw123456")))
        check("重启后 displayName 等资料仍在",
              (call(rest_auth, "/api/get-account",
                    token=login_ok(rest_auth, "backupcheck", "pw123456"))[1]
               .get("data") or {}).get("name") == "backupcheck")
        try:
            files = sorted(os.listdir(os.path.join(DATA, "backup")))
        except Exception:
            files = []
        check("accounts.json 进入启动备份名单（不能成为唯一没有兜底的数据）",
              any(f.startswith("accounts.") for f in files), str(files[:8]))
        code, d, _h = call(rest_ai, "/ai/health")
        check("/ai/health 报告版本 4.5.0 与账号数",
              code == 200 and d.get("version") == "4.5.0"
              and int(d.get("accounts") or 0) >= 2 and d.get("authMode") == "builtin",
              str(d)[:140])

        # ---------------- 30 用户自己改密码（4.5.0 新增） ----------------
        # 单独用一个账号，避免把前面用例依赖的 alice/pw123456 改掉
        print("[30] 用户自己改密码 /api/change-password（4.5.0）")
        call(AUTH, "/api/signup", "POST",
             {"username": "pwuser", "password": "pw123456"})
        tk_old = login_ok(AUTH, "pwuser", "pw123456")
        check("新账号可登录（改密前置条件）", bool(tk_old))

        code, d, _h = call(AUTH, "/api/change-password", "POST",
                           {"oldPassword": "wrong-old", "newPassword": "newpw12345"},
                           token=tk_old)
        check("原密码不对 → 拒绝且不改密码",
              d.get("status") == "error" and "原密码" in (d.get("msg") or "")
              and bool(login_ok(AUTH, "pwuser", "pw123456")), str(d)[:120])

        code, d, _h = call(AUTH, "/api/change-password", "POST",
                           {"oldPassword": "pw123456", "newPassword": "short7"},
                           token=tk_old)
        check("新密码 <8 位 → 拒绝",
              d.get("status") == "error" and "至少 8 位" in (d.get("msg") or ""), str(d)[:120])

        code, d, _h = call(AUTH, "/api/change-password", "POST",
                           {"oldPassword": "pw123456", "newPassword": "pw123456"},
                           token=tk_old)
        check("新旧密码相同 → 拒绝",
              d.get("status") == "error" and "不能与原密码相同" in (d.get("msg") or ""),
              str(d)[:120])

        code, d, _h = call(AUTH, "/api/change-password", "POST",
                           {"oldPassword": "pw123456", "newPassword": "newpw12345"})
        check("没带登录令牌 → 401（不能凭用户名改别人密码）", code == 401, "http=%s" % code)

        code, d, _h = call(AUTH, "/api/change-password", "POST",
                           {"oldPassword": "pw123456", "newPassword": "newpw12345"},
                           token=tk_old)
        tk_new = (d.get("data") or {}).get("access_token") or ""
        check("改密成功返回 status=ok 且带一张新令牌",
              code == 200 and d.get("status") == "ok" and bool(tk_new), str(d)[:140])
        check("新密码能登录、旧密码登不上",
              bool(login_ok(AUTH, "pwuser", "newpw12345"))
              and not login_ok(AUTH, "pwuser", "pw123456"))
        check("当前设备拿到的令牌继续可用（改完不用重新登录）",
              call(AUTH, "/api/get-account", token=tk_new)[0] == 200)
        check("改密前签发的旧令牌立刻失效（其它设备被踢下线）",
              call(AUTH, "/api/get-account", token=tk_old)[0] == 401,
              "http=%s" % call(AUTH, "/api/get-account", token=tk_old)[0])
        check("改密后 AI 接口同样认新令牌、拒旧令牌",
              call(AI, "/ai/quota", token=tk_new)[0] == 200
              and call(AI, "/ai/quota", token=tk_old)[0] == 401)
        # 改了密码，但资料/额度不该受影响
        _c, d, _h = call(AUTH, "/api/get-account", token=tk_new)
        check("改密不影响账号资料（id/name 不变）",
              (d.get("data") or {}).get("name") == "pwuser", str(d)[:120])

        print("=" * 64)
        print("通过 %d 项，失败 %d 项" % (len(PASS), len(FAIL)))
        for name in FAIL:
            print("  失败：", name)
        return 1 if FAIL else 0
    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass


if __name__ == "__main__":
    sys.exit(main())
