#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 admin_ui.html 注入 ai_server.py 的 ADMIN_PAGE 常量（保持「单文件部署」）。

用法（在 server_ai 目录下）：
    python3 sync_admin_page.py           # 注入（改完 admin_ui.html 必须跑一次）
    python3 sync_admin_page.py --check   # 只检查是否同步；不同步退出码 1（回归测试用）

为什么是「注入」而不是「运行时读文件」：
    生产部署是「一个 ai_server.py + data/」的单文件形态，运维只 scp 一个文件。
    如果服务端运行时去读 admin_ui.html，忘传这个文件后台就直接 500 —— 单点故障。
    注入后 admin_ui.html 只是**源文件**（方便编辑 / 语法检查 / diff），
    两者是否一致由 --check 兜底：test_rules.py 的 §15 会调它，忘了注入就会红。

依赖：只有 Python3 标准库（做 JS 语法检查时会调用 node，没装 node 就跳过这一步）。
"""

import io
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "ai_server.py")
UI = os.path.join(HERE, "admin_ui.html")

BEGIN = 'ADMIN_PAGE = r"""'
# 内容从开引号后面立刻开始（<!doctype html>），结束于单独一行的三个引号
BLOCK_RE = re.compile(r'ADMIN_PAGE = r"""(.*?)\n"""\n', re.S)


def read_text(path):
    with io.open(path, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write_text(path, text):
    with io.open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def normalize(html):
    """统一换行为 LF。"""
    return html.replace("\r\n", "\n").replace("\r", "\n")


def payload(html):
    """注入块的内容形态：LF 换行、去掉尾部空行（让结尾三引号独占一行）。"""
    return normalize(html).rstrip("\n")


def check_injectable(html):
    """HTML 里不能出现三引号，也不能以反斜杠结尾 —— 否则会破坏 r\"\"\" 原始字符串。"""
    if '"""' in html:
        raise SystemExit("admin_ui.html 里出现了三个连续双引号，无法放进 r\"\"\" 原始字符串")
    if normalize(html).rstrip("\n").endswith("\\"):
        raise SystemExit("admin_ui.html 以反斜杠结尾，无法放进原始字符串")


def build_block(html):
    return BEGIN + payload(html) + '\n"""\n'


def extract_block(source):
    """从 ai_server.py 里取出当前 ADMIN_PAGE 的内容（不含三引号本身），用于比对。"""
    m = BLOCK_RE.search(source)
    return m.group(1) if m else None


SCRIPT_RE = re.compile(r"<script>(.*?)</script>", re.S)


def check_js(html):
    """把页面里的 <script> 抽出来交给 node --check 过一遍。

    为什么值得做：后台是手写的一大段 JS（1800 行），少一个括号、多一个逗号时
    Python 侧的 py_compile 完全看不出来，页面会在浏览器里整块不执行（白屏），
    而且报错信息只有「Unexpected token ')'」这种，排查要绕一大圈。
    node 不在 PATH 上就跳过（不阻断注入，只在提示里说一声）。
    """
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        print("（提示：没找到 node，跳过 JS 语法检查）")
        return
    chunks = SCRIPT_RE.findall(html)
    if not chunks:
        return
    tmp = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8")
    try:
        tmp.write("\n;\n".join(chunks))
        tmp.close()
        p = subprocess.Popen([node, "--check", tmp.name],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out = p.communicate()[0]
        if p.returncode != 0:
            msg = (out or b"").decode("utf-8", "replace").strip()
            raise SystemExit("admin_ui.html 里的 JS 语法有错（node --check 没过）：\n" + msg)
        print("JS 语法检查通过（%d 段 <script>）" % len(chunks))
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


def main(argv):
    check_only = "--check" in argv
    if not os.path.isfile(UI):
        print("找不到 %s" % UI)
        return 2
    html = read_text(UI)
    check_injectable(html)
    check_js(html)
    want = payload(html)
    src = read_text(SERVER)
    have = extract_block(src)

    if check_only:
        if have == want:
            print("admin_ui.html 与 ai_server.py 的 ADMIN_PAGE 一致（%d 行 / %d 字节）"
                  % (want.count("\n") + 1, len(want.encode("utf-8"))))
            return 0
        print("admin_ui.html 与 ai_server.py 的 ADMIN_PAGE **不一致**：")
        print("  admin_ui.html          : %s 行" % (want.count("\n") + 1))
        print("  ai_server.py 里的副本  : %s 行"
              % ("?" if have is None else have.count("\n") + 1))
        print("  修法：在 server_ai 目录下跑 python3 sync_admin_page.py")
        return 1

    if have == want:
        print("已经是最新，无需改动（%d 行 / %d 字节）"
              % (want.count("\n") + 1, len(want.encode("utf-8"))))
        return 0
    new_src, n = BLOCK_RE.subn(lambda _m: build_block(html), src, count=1)
    if n != 1:
        print("在 ai_server.py 里没找到 ADMIN_PAGE = r\"\"\"...\"\"\" 块，注入失败")
        return 2
    write_text(SERVER, new_src)
    print("已注入：admin_ui.html -> ai_server.py 的 ADMIN_PAGE（%d 行 / %d 字节）"
          % (want.count("\n") + 1, len(want.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
