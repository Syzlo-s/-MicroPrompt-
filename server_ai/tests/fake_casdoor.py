# -*- coding: utf-8 -*-
"""测试用的假 Casdoor（只实现 /api/get-account），供 tests/test_rules.py 使用。

约定：Authorization: Bearer <name>  =>  用户 id = "uid-<name>"；
      token 以 invalid / selfcheck 开头时，返回 Casdoor 风格的 status=error
      （用来验证「无效 token 必须被拒绝」这条链路）。

不依赖任何第三方库；真实 Casdoor 的响应结构与它保持一致：
    {"status": "ok", "data": {"id": "...", "name": "..."}}
"""

import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

# 端口可由 test_rules.py 指定（它动态挑空闲端口，避免固定端口被系统保留/残留套接字占用）
PORT = int(os.environ.get("MP_FAKE_CASDOOR_PORT", "2600"))


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.path.startswith("/api/get-account"):
            self.send_response(404)
            self.end_headers()
            return
        auth = self.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            self.send_response(401)
            self.end_headers()
            return
        name = auth[7:].strip()
        if (not name) or name.startswith("invalid") or name.startswith("selfcheck"):
            self._json(
                {
                    "status": "error",
                    "msg": "Access token doesn't exist in database",
                    "data": None,
                }
            )
            return
        self._json({"status": "ok", "data": {"id": "uid-" + name, "name": name}})

    def log_message(self, *args):  # 静默
        pass


if __name__ == "__main__":
    print("fake casdoor on 127.0.0.1:%d" % PORT)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
