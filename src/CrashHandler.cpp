// ============================================================
// CrashHandler.cpp
// 全局崩溃捕获：闪退时在 exe 同目录生成/追加 crash.log
// 仅使用 Win32 API，崩溃时即使 Qt 层已损坏也能写入日志
// 日志策略：
//   - 平时不产生任何文件，只有闪退时才写入
//   - 每次启动自动清理：日志超过 512KB 时删除重建，防止无限膨胀
//   - 用户可随时手动删除 crash.log
// ============================================================

#include "CrashHandler.h"

#ifdef _WIN32

#include <windows.h>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <signal.h>

namespace {

constexpr DWORD kMaxLogSize = 512 * 1024;  // 超过 512KB 自动清理

char g_logPath[MAX_PATH] = {0};
volatile LONG g_inCrash = 0;  // 防重入标记

// 初始化日志路径：exe 所在目录 + crash.log
void initLogPath()
{
    if (g_logPath[0] != '\0')
        return;
    GetModuleFileNameA(nullptr, g_logPath, MAX_PATH);
    char* slash = strrchr(g_logPath, '\\');
    if (slash)
        *(slash + 1) = '\0';
    strncat(g_logPath, "crash.log", MAX_PATH - strlen(g_logPath) - 1);
}

// 以追加方式写入一行文本
void appendLine(const char* line)
{
    HANDLE h = CreateFileA(g_logPath, FILE_APPEND_DATA, FILE_SHARE_READ,
                           nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE)
        return;
    DWORD written = 0;
    WriteFile(h, line, static_cast<DWORD>(strlen(line)), &written, nullptr);
    CloseHandle(h);
}

// 写入带时间戳的日志行
void appendLineTS(const char* line)
{
    SYSTEMTIME st;
    GetLocalTime(&st);
    char buf[640];
    std::snprintf(buf, sizeof(buf),
                  "[%04u-%02u-%02u %02u:%02u:%02u] %s\n",
                  st.wYear, st.wMonth, st.wDay,
                  st.wHour, st.wMinute, st.wSecond, line);
    appendLine(buf);
}

// 输出当前调用栈（解析每个返回地址所属模块与偏移）
void writeStack(const char* title)
{
    appendLineTS(title);

    void* frames[24];
    const USHORT count = CaptureStackBackTrace(1, 24, frames, nullptr);
    char buf[512];
    for (USHORT i = 0; i < count; ++i) {
        HMODULE mod = nullptr;
        if (GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS
                    | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                reinterpret_cast<LPCWSTR>(frames[i]), &mod)) {
            wchar_t wmod[MAX_PATH] = {0};
            GetModuleFileNameW(mod, wmod, MAX_PATH);
            const wchar_t* base = wcsrchr(wmod, L'\\');
            const wchar_t* name = base ? base + 1 : wmod;
            const ULONG_PTR offset =
                reinterpret_cast<ULONG_PTR>(frames[i])
                - reinterpret_cast<ULONG_PTR>(mod);
            // 转为 UTF-8 写入（GBK 系统下模块名为中文时也能正确记录）
            char modName[MAX_PATH];
            int len = WideCharToMultiByte(CP_UTF8, 0, name, -1,
                                          modName, MAX_PATH, nullptr, nullptr);
            if (len <= 0)
                std::snprintf(modName, sizeof(modName), "?");
            std::snprintf(buf, sizeof(buf),
                          "    #%02u  %s + 0x%llX\n", i, modName,
                          static_cast<unsigned long long>(offset));
        } else {
            std::snprintf(buf, sizeof(buf),
                          "    #%02u  0x%p\n", i, frames[i]);
        }
        appendLine(buf);
    }
    appendLine("--------------------------------------------------\n");
}

// SEH 未处理异常回调
LONG WINAPI crashFilter(EXCEPTION_POINTERS* ep)
{
    if (InterlockedExchange(&g_inCrash, 1) != 0)
        return EXCEPTION_CONTINUE_SEARCH;

    initLogPath();

    char buf[512];
    if (ep && ep->ExceptionRecord) {
        std::snprintf(buf, sizeof(buf),
                      "程序闪退！异常代码 0x%08X，异常地址 0x%p%s",
                      ep->ExceptionRecord->ExceptionCode,
                      ep->ExceptionRecord->ExceptionAddress,
                      ep->ExceptionRecord->ExceptionCode == 0xC0000005
                          ? "（内存访问冲突）" : "");
    } else {
        std::snprintf(buf, sizeof(buf), "程序闪退！原因未知");
    }
    appendLineTS(buf);

    writeStack("调用栈：");
    return EXCEPTION_EXECUTE_HANDLER;  // 交给系统终止进程并弹窗提示
}

// 非 SEH 信号崩溃（SIGSEGV 等）
void signalHandler(int sig)
{
    if (InterlockedExchange(&g_inCrash, 1) != 0)
        _exit(1);

    initLogPath();

    char buf[128];
    std::snprintf(buf, sizeof(buf),
                  "程序闪退！收到信号 %d（%s）", sig,
                  sig == SIGSEGV ? "内存访问错误"
                      : sig == SIGABRT ? "程序终止"
                      : sig == SIGFPE  ? "浮点运算错误"
                      : sig == SIGILL  ? "非法指令" : "未知");
    appendLineTS(buf);

    writeStack("调用栈：");
    _exit(1);
}

// 启动时清理：日志过大则删除重建
void cleanupOnStartup()
{
    initLogPath();
    HANDLE h = CreateFileA(g_logPath, GENERIC_READ, FILE_SHARE_READ,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) {
        const DWORD size = GetFileSize(h, nullptr);
        CloseHandle(h);
        if (size != INVALID_FILE_SIZE && size > kMaxLogSize)
            DeleteFileA(g_logPath);
    }
}

}  // namespace

void installCrashHandler()
{
    initLogPath();
    cleanupOnStartup();

    SetUnhandledExceptionFilter(crashFilter);
    signal(SIGSEGV, signalHandler);
    signal(SIGABRT, signalHandler);
    signal(SIGFPE, signalHandler);
    signal(SIGILL, signalHandler);
}

#endif  // _WIN32
