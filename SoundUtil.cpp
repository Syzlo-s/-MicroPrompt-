// ============================================================
// SoundUtil.cpp
// 系统音量保存/恢复工具（Win32）
// 背景：mciSendStringW 播放 MP3 时，Windows MCI 音频设备会把
// 系统主音量重置为 60%，导致提示音改变用户音量。
// 解决：播放前保存当前系统音量（waveOutGetVolume），
// 播放后由工作线程延迟恢复（waveOutSetVolume），
// 提示音输出音量即跟随系统当前音量，且不残留音量改动。
// ============================================================

#include "SoundUtil.h"

#ifdef _WIN32

#include <windows.h>
#include <mmsystem.h>

namespace {
DWORD g_savedVolume = 0xFFFFFFFF;  // 0xFFFFFFFF 表示尚未保存
}

void saveSystemVolume()
{
    // 每次播放前都重新保存，避免覆盖用户播放间隙手动调节的音量
    DWORD v = 0;
    // WAVE_MAPPER 作为 HWAVEOUT 句柄使用（标准做法）
    if (waveOutGetVolume(reinterpret_cast<HWAVEOUT>(WAVE_MAPPER), &v)
        == MMSYSERR_NOERROR)
        g_savedVolume = v;
}

void restoreSystemVolumeLater()
{
    const DWORD v = g_savedVolume;
    if (v == 0xFFFFFFFF)
        return;
    // 工作线程延迟 150ms 恢复：MCI 在 play 时才改写主音量，
    // 延迟恢复既不阻塞主线程，也不依赖 Qt 事件循环
    // （启动音可能在 Qt 事件循环启动前播放）
    // 音量经堆对象传给线程函数（无捕获 lambda 才能转为线程入口）
    auto* volParam = new DWORD(v);
    const HANDLE h = CreateThread(nullptr, 0, [](LPVOID param) -> DWORD {
        const DWORD vol = *static_cast<DWORD*>(param);
        delete static_cast<DWORD*>(param);
        Sleep(150);
        waveOutSetVolume(reinterpret_cast<HWAVEOUT>(WAVE_MAPPER), vol);
        return 0;
    }, volParam, 0, nullptr);
    if (h)
        CloseHandle(h);
}

#endif  // _WIN32
