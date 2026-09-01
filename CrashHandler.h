#ifndef CRASHHANDLER_H
#define CRASHHANDLER_H

// 安装全局崩溃捕获：
// 程序闪退时会在 exe 同目录生成/追加 crash.log，
// 记录崩溃时间、异常代码、故障模块和调用栈，便于排查闪退问题。
void installCrashHandler();

#endif // CRASHHANDLER_H
