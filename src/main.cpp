#include <QApplication>
#include <QCoreApplication>
#include <string>
#include "CrashHandler.h"
#include "MainWindow.h"
#include "SoundUtil.h"
#include "SplashScreen.h"

#ifdef Q_OS_WIN
#include <windows.h>
#include <mmsystem.h>
#endif

// ============================================================
// 启动音效：软件启动即播放 Hello.mp3（MCI，无需 QtMultimedia）
// 播放前保存系统音量、播放后恢复，避免 MCI 将系统音量改为 60%
// ============================================================
static void playStartupSound()
{
#ifdef Q_OS_WIN
    saveSystemVolume();   // 先保存当前系统音量，防止 MCI 改写
    mciSendStringW(L"close hello", nullptr, 0, nullptr);
    const QString path = QCoreApplication::applicationDirPath()
                         + QStringLiteral("/Music/Hello.mp3");
    const std::wstring openCmd = L"open \"" + path.toStdWString()
                                 + L"\" type mpegvideo alias hello";
    if (mciSendStringW(openCmd.c_str(), nullptr, 0, nullptr) == 0) {
        mciSendStringW(L"play hello", nullptr, 0, nullptr);
        restoreSystemVolumeLater();   // 延迟恢复系统音量，播放跟随系统音量
    }
#endif
}

int main(int argc, char* argv[])
{
    // 安装崩溃捕获：闪退时在 exe 同目录写 crash.log（便于排查）
    installCrashHandler();

    // 高 DPI 支持
    QApplication::setHighDpiScaleFactorRoundingPolicy(
        Qt::HighDpiScaleFactorRoundingPolicy::PassThrough);

    // 界面整体放大 1.25 倍（用户确认保留）：文字/图标获得更多物理像素，更清晰。
    // 注意：QT_SCALE_FACTOR 会让"窗口物理尺寸"与"内容渲染尺寸"的缩放基准不同
    // （本 Qt 版本窗口几何按 factor 缩放、内容按 屏幕DPR×factor 缩放），二者不一致
    // 时右侧内容（含滚动条）会被裁出窗口。MainWindow 构造末尾的 fixGeometry 会
    // 检测不一致并把窗口物理尺寸修正为"内容尺寸"，保证完整显示。
#if defined(Q_OS_WIN)
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    qputenv("QT_SCALE_FACTOR", "1.25");
#endif

    QApplication app(argc, argv);
    app.setApplicationName(QStringLiteral("MicroPrompt"));
    app.setOrganizationName(QStringLiteral("MicroPrompt"));
    app.setQuitOnLastWindowClosed(true);

    // 软件启动即播放"Hello"音效（与启动动画同时）
    playStartupSound();

    // 主窗口：初始透明，由启动动画在图标淡出时同步淡入
    MainWindow w;
    w.setWindowOpacity(0.0);
    w.show();

    // 启动动画（图标桌面中央淡入 → 图标淡出 + 主窗口淡入）
    SplashScreen splash(&w);
    splash.play();

    return app.exec();
}
