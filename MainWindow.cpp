#include "MainWindow.h"
#include "NoteManager.h"
#include "NoteListWidget.h"
#include "NoteEditor.h"
#include "PinButton.h"
#include "TitleBarButton.h"
#include "SvgIconLoader.h"
#include "SplashScreen.h"
#include "SoundUtil.h"

#include <QApplication>
#include <QScreen>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QSplitter>
#include <QPushButton>
#include <QLabel>
#include <QCloseEvent>
#include <QMessageBox>
#include <QInputDialog>
#include <QLineEdit>
#include <QThread>
#include <QFile>
#include <QIcon>
#include <QFontMetrics>
#include <QTimer>
#include <QPainter>
#include <QPainterPath>
#include <QPropertyAnimation>
#include <QParallelAnimationGroup>
#include <QSequentialAnimationGroup>
#include <QPauseAnimation>
#include <QGraphicsOpacityEffect>
#include <QWindowStateChangeEvent>
#include <functional>
#include <cstdlib>
#include <string>

#ifdef Q_OS_WIN
#include <windows.h>
#include <dwmapi.h>
#include <mmsystem.h>
#endif

namespace {
constexpr int kResizeBorder = 6;   // 窗口边缘缩放区域宽度
constexpr int kTopBarHeight = 36;  // 顶栏高度

// ============================================================
// ExitOverlay —— 关闭退出动画覆盖层
//   点击关闭：界面整体淡出 ∥ 图标（与开屏动画同尺寸）在窗口中央淡入
//   同时播放"再见"音频（MCI，无需 QtMultimedia），图标停留至音频结束
//   → 图标淡出 → 真正退出
// ============================================================
class ExitOverlay : public QWidget {
public:
    explicit ExitOverlay(QWidget* parent)
        : QWidget(parent)
    {
        setWindowFlags(Qt::FramelessWindowHint | Qt::Tool
                       | Qt::WindowStaysOnTopHint | Qt::WindowTransparentForInput);
        setAttribute(Qt::WA_TranslucentBackground);

        // 覆盖主窗口区域（独立顶层窗口，避免随主窗口透明度一起消失）
        if (parent)
            setGeometry(parent->geometry());

        // 中央 logo —— 尺寸与开屏动画一致（140 容器 / 128 图形）
        m_logo = new QLabel(this);
        m_logo->setAlignment(Qt::AlignCenter);
        m_logo->setFixedSize(140, 140);
        QPixmap logoPix(QStringLiteral(":/icons/app-logo.svg"));
        if (!logoPix.isNull()) {
            m_logo->setPixmap(logoPix.scaled(128, 128, Qt::KeepAspectRatio,
                                             Qt::SmoothTransformation));
        } else {
            // 兜底：绘制一个简单笔记本图形
            QPixmap fallback(128, 128);
            fallback.fill(Qt::transparent);
            QPainter pf(&fallback);
            pf.setRenderHint(QPainter::Antialiasing);
            pf.setPen(Qt::NoPen);
            pf.setBrush(QColor(157, 198, 175));
            pf.drawRoundedRect(QRectF(9, 5, 110, 118), 12, 12);
            pf.setBrush(QColor(60, 60, 70));
            pf.drawRoundedRect(QRectF(18, 14, 92, 100), 7, 7);
            pf.end();
            m_logo->setPixmap(fallback);
        }
        m_logo->move((width() - 140) / 2, (height() - 140) / 2);

        m_logoEffect = new QGraphicsOpacityEffect(m_logo);
        m_logo->setGraphicsEffect(m_logoEffect);
        m_logoEffect->setOpacity(0.0);
    }

    /** 播放退出动画，结束后调用 onDone */
    void start(std::function<void()> onDone)
    {
        m_onDone = std::move(onDone);
        show();

        // ① 界面淡出 ∥ 图标淡入（并行）
        auto* winFade = new QPropertyAnimation(parentWidget(), "windowOpacity", this);
        winFade->setDuration(480);
        winFade->setStartValue(1.0);
        winFade->setEndValue(0.0);
        winFade->setEasingCurve(QEasingCurve::InCubic);

        auto* iconIn = new QPropertyAnimation(m_logoEffect, "opacity", this);
        iconIn->setDuration(380);
        iconIn->setStartValue(0.0);
        iconIn->setEndValue(1.0);
        iconIn->setEasingCurve(QEasingCurve::OutCubic);

        auto* fadeGroup = new QParallelAnimationGroup(this);
        fadeGroup->addAnimation(winFade);
        fadeGroup->addAnimation(iconIn);
        fadeGroup->start();

        // ② 点击关闭立即播放"再见"音频，图标停留至音频结束
        playGoodbyeAudioAndHold();
    }

private:
    void playGoodbyeAudioAndHold()
    {
        int holdMs = 2500; // 默认停留时长（音频打开失败时兜底）

#ifdef Q_OS_WIN
        saveSystemVolume();   // 先保存当前系统音量，防止 MCI 改写
        mciSendStringW(L"close bye", nullptr, 0, nullptr);
        const QString path = QCoreApplication::applicationDirPath()
                             + QStringLiteral("/Music/Goodbye. .mp3");
        const std::wstring openCmd = L"open \"" + path.toStdWString()
                                     + L"\" type mpegvideo alias bye";
        if (mciSendStringW(openCmd.c_str(), nullptr, 0, nullptr) == 0) {
            // 查询音频时长，按实际长度停留，保证"再见"播放完整
            wchar_t buf[64] = {};
            if (mciSendStringW(L"status bye length", buf, 63, nullptr) == 0) {
                const long len = wcstol(buf, nullptr, 10);
                if (len > 0)
                    holdMs = int(len);
            }
            mciSendStringW(L"play bye", nullptr, 0, nullptr);
            restoreSystemVolumeLater();   // 延迟恢复系统音量，播放跟随系统音量
        }
#endif

        auto* hold = new QPauseAnimation(holdMs, this);
        connect(hold, &QPauseAnimation::finished, this, [this]() {
#ifdef Q_OS_WIN
            mciSendStringW(L"close bye", nullptr, 0, nullptr);
#endif
            fadeOutIconAndDone();
        });
        hold->start();
    }

    void fadeOutIconAndDone()
    {
        auto* iconOut = new QPropertyAnimation(m_logoEffect, "opacity", this);
        iconOut->setDuration(320);
        iconOut->setStartValue(1.0);
        iconOut->setEndValue(0.0);
        iconOut->setEasingCurve(QEasingCurve::InCubic);
        connect(iconOut, &QPropertyAnimation::finished, this, [this]() {
            if (m_onDone)
                m_onDone();
        });
        iconOut->start(QAbstractAnimation::DeleteWhenStopped);
    }

    QLabel* m_logo = nullptr;
    QGraphicsOpacityEffect* m_logoEffect = nullptr;
    std::function<void()> m_onDone;
};
} // namespace

MainWindow::MainWindow(QWidget* parent)
    : QMainWindow(parent)
{
    // 无边框窗口
    setWindowFlags(Qt::Window | Qt::FramelessWindowHint);
    setAttribute(Qt::WA_TranslucentBackground, false);

    setupUI();
    setupConnections();

    // 如果有笔记则选中最近修改的一条（重新打开时回到上次编辑的位置）
    const auto notes = NoteManager::instance().notes();
    if (!notes.isEmpty()) {
        auto newest = notes.first();
        for (const auto& n : notes) {
            if (n->modified > newest->modified)
                newest = n;
        }
        const QString id = newest->id;
        m_listWidget->setSelectedNote(id);
        m_editor->loadNote(id);
    }
    updateNoteTitle();

#ifdef Q_OS_WIN
    // Windows 11 圆角窗口（dwmapi 常量在旧 MinGW 可能缺失，手动定义）
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
#ifndef DWMWCP_ROUND
#define DWMWCP_ROUND 2
#endif
    {
        const HWND hwnd = reinterpret_cast<HWND>(winId());
        const DWORD pref = DWMWCP_ROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                              &pref, sizeof(pref));
    }
#endif

    // 窗口显示、布局完成后，重新定位选中高亮条（首帧几何更准确）
    QTimer::singleShot(0, this, [this]() {
        const QString id = m_editor->currentNoteId();
        if (!id.isEmpty())
            m_listWidget->setSelectedNote(id);
    });

    // 修正窗口物理尺寸：部分环境（远程/虚拟显示器）平台窗口不按 DPR 缩放，
    // 窗口物理尺寸 = 逻辑尺寸(880×560)，而内容按 DPR 渲染（880×dpr 物理像素），
    // 导致右侧内容（含滚动条）被裁出窗口。检测到不一致时，把窗口物理尺寸强制
    // 设为"逻辑尺寸 × DPR"，并把窗口夹回工作区内；一致时（正常平台）不动。
    // 分多次应用：Qt/系统可能在本窗口显示后重新应用恢复的几何。
    {
        auto fixGeometry = [this]() {
#ifdef Q_OS_WIN
            const HWND hwnd = reinterpret_cast<HWND>(winId());
            const qreal dpr = devicePixelRatioF();
            const int wantW = qRound(880 * dpr);
            const int wantH = qRound(560 * dpr);
            RECT rr;
            GetWindowRect(hwnd, &rr);
            const int curW = rr.right - rr.left;
            const int curH = rr.bottom - rr.top;
            if (curW == wantW && curH == wantH)
                return;  // 物理尺寸已正确，保持用户位置不动
            RECT wa;
            SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0);
            const int w = qMin(wantW, wa.right - wa.left);
            const int h = qMin(wantH, wa.bottom - wa.top);
            int x = rr.left, y = rr.top;
            if (x + w > wa.right) x = wa.right - w;
            if (y + h > wa.bottom) y = wa.bottom - h;
            if (x < wa.left) x = wa.left;
            if (y < wa.top) y = wa.top;
            SetWindowPos(hwnd, nullptr, x, y, w, h,
                         SWP_NOZORDER | SWP_NOACTIVATE);
#endif
        };
        fixGeometry();
        QTimer::singleShot(100, this, fixGeometry);
        QTimer::singleShot(500, this, fixGeometry);
        QTimer::singleShot(1200, this, fixGeometry);
        QTimer::singleShot(2000, this, fixGeometry);
        QTimer::singleShot(3500, this, fixGeometry);
    }
}

MainWindow::~MainWindow()
{
    m_editor->saveCurrent();
}

void MainWindow::setupUI()
{
    setWindowTitle(QStringLiteral("轻提词"));
    resize(880, 560);
    setMinimumSize(640, 420);

    // 窗口图标（app-logo.svg 彩色笔记本 logo）
    setWindowIcon(SvgIconLoader::loadOriginal(
        QStringLiteral(":/icons/app-logo.svg"), 64));

    m_central = new QWidget(this);
    setCentralWidget(m_central);

    auto* mainLay = new QVBoxLayout(m_central);
    mainLay->setContentsMargins(0, 0, 0, 0);
    mainLay->setSpacing(0);

    // ===== 自定义顶栏 =====
    m_topBar = new QWidget(m_central);
    m_topBar->setObjectName(QStringLiteral("topBar"));
    m_topBar->setFixedHeight(kTopBarHeight);

    auto* barLay = new QHBoxLayout(m_topBar);
    barLay->setContentsMargins(14, 0, 6, 0);
    barLay->setSpacing(8);

    // 应用 logo（app-logo.svg 彩色笔记本，与启动动画一致）
    auto* logoLabel = new QLabel(m_topBar);
    logoLabel->setObjectName(QStringLiteral("appLogo"));
    logoLabel->setFixedSize(20, 20);
    logoLabel->setPixmap(SvgIconLoader::loadOriginal(
                             QStringLiteral(":/icons/app-logo.svg"), 40)
                             .pixmap(QSize(20, 20), logoLabel->devicePixelRatioF()));
    barLay->addWidget(logoLabel);

    // 顶部左侧：Logo 旁边显示当前打开笔记名称 / 保存状态（"名称 / 编辑"，双标签组合）
    m_noteTitleContainer = new QWidget(m_topBar);
    m_noteTitleContainer->setObjectName(QStringLiteral("noteTitleContainer"));
    // 不拦截鼠标事件，保证顶栏拖动（HTCAPTION）在该区域依然有效
    m_noteTitleContainer->setAttribute(Qt::WA_TransparentForMouseEvents);
    m_noteTitleContainer->hide();
    auto* noteLay = new QHBoxLayout(m_noteTitleContainer);
    noteLay->setContentsMargins(0, 0, 0, 0);
    noteLay->setSpacing(0);

    // 笔记名称（"名称 /"，过长时右侧省略，最大宽度约 240px）
    m_noteNameLabel = new QLabel(m_noteTitleContainer);
    m_noteNameLabel->setObjectName(QStringLiteral("noteNameLabel"));
    m_noteNameLabel->setMaximumWidth(240);
    m_noteNameLabel->setAlignment(Qt::AlignVCenter | Qt::AlignLeft);
    m_noteNameLabel->setAttribute(Qt::WA_TransparentForMouseEvents);
    noteLay->addWidget(m_noteNameLabel);

    // 保存状态（"编辑"/"保存中"，文字短；仅此标签参与动画）
    m_noteStatusLabel = new QLabel(m_noteTitleContainer);
    m_noteStatusLabel->setObjectName(QStringLiteral("noteStatusLabel"));
    m_noteStatusLabel->setAlignment(Qt::AlignVCenter | Qt::AlignLeft);
    m_noteStatusLabel->setAttribute(Qt::WA_TransparentForMouseEvents);
    noteLay->addWidget(m_noteStatusLabel);

    barLay->addWidget(m_noteTitleContainer);

    // 剩余弹性空间（把右上角按钮组推到右侧）
    barLay->addStretch(1);

    // ---- 右上角按钮组: 图钉 | 最小化 | 最大化 | 关闭 ----
    m_pinBtn = new PinButton(m_topBar);
    barLay->addWidget(m_pinBtn);

    m_minBtn = new TitleBarButton(QStringLiteral(":/icons/minimize.svg"),
                                  QStringLiteral("最小化"),
                                  TitleBarButton::Minimize, m_topBar);
    barLay->addWidget(m_minBtn);

    m_maxBtn = new TitleBarButton(QStringLiteral(":/icons/maximize.svg"),
                                  QStringLiteral("最大化"),
                                  TitleBarButton::Maximize, m_topBar);
    barLay->addWidget(m_maxBtn);

    m_closeBtn = new TitleBarButton(QStringLiteral(":/icons/close.svg"),
                                    QStringLiteral("关闭"),
                                    TitleBarButton::Close, m_topBar);
    barLay->addWidget(m_closeBtn);

    mainLay->addWidget(m_topBar);

    // ===== 左右分割布局 =====
    m_splitter = new QSplitter(Qt::Horizontal, m_central);
    m_splitter->setObjectName(QStringLiteral("splitter"));
    m_splitter->setHandleWidth(1);
    m_splitter->setChildrenCollapsible(false);

    m_listWidget = new NoteListWidget(m_splitter);
    m_listWidget->setObjectName(QStringLiteral("listPanel"));

    m_editor = new NoteEditor(m_splitter);
    m_editor->setObjectName(QStringLiteral("editorPanel"));

    m_splitter->addWidget(m_listWidget);
    m_splitter->addWidget(m_editor);
    m_splitter->setStretchFactor(0, 0);
    m_splitter->setStretchFactor(1, 1);
    m_splitter->setSizes({200, 680});
    // 限制左侧列表宽度拖动范围：最大 = 220，最小 = 130（逻辑像素）
    // （再窄时日期已完全淡出、标题仍可读，且不会把列表拖没）
    m_listWidget->setMinimumWidth(130);
    m_listWidget->setMaximumWidth(220);

    mainLay->addWidget(m_splitter, 1);

    // 加载 QSS 样式表
    QFile qss(QStringLiteral(":/style/style.qss"));
    if (qss.open(QIODevice::ReadOnly | QIODevice::Text)) {
        setStyleSheet(QString::fromUtf8(qss.readAll()));
        qss.close();
    }

    // 状态标签固定宽度（取最宽状态" 保存中"），保证"编辑"/"保存中"切换时
    // 容器总宽不变，笔记名称与"/"不会随之左右移动；多余空间留在状态文字右侧
    if (m_noteStatusLabel) {
        const QFontMetrics fmStatus(m_noteStatusLabel->font());
        m_noteStatusLabel->setFixedWidth(
            fmStatus.horizontalAdvance(QStringLiteral(" 保存中")));
    }
}

void MainWindow::setupConnections()
{
    connect(m_pinBtn, &PinButton::toggled, this, &MainWindow::onPinToggled);

    // 左侧列表头部按钮
    connect(m_listWidget, &NoteListWidget::newNoteRequested,
            this, &MainWindow::onNewNote);
    connect(m_listWidget, &NoteListWidget::deleteNoteRequested, this, [this]() {
        const QString id = m_editor->currentNoteId();
        if (!id.isEmpty())
            onDeleteNote(id);
    });

    // 左侧列表右键菜单
    connect(m_listWidget, &NoteListWidget::noteDeleteRequested,
            this, [this](const QString& id) { onDeleteNote(id); });
    connect(m_listWidget, &NoteListWidget::noteRenameRequested,
            this, &MainWindow::onRenameNote);

    // 窗口控制
    connect(m_minBtn, &QAbstractButton::clicked, this, &MainWindow::onMinimizeClicked);
    connect(m_maxBtn, &QAbstractButton::clicked, this, [this]() {
        if (isMaximized())
            showNormal();
        else
            showMaximized();
    });
    connect(m_closeBtn, &QAbstractButton::clicked, this, &QWidget::close);

    connect(m_listWidget, &NoteListWidget::noteSelected,
            this, &MainWindow::onNoteSelected);

    // 顶部中间：输入时状态切为"保存中"，保存完成后换回"编辑"
    connect(m_editor, &NoteEditor::textEdited, this, [this]() {
        setNoteStatus(QStringLiteral("保存中"));
    });
    connect(m_editor, &NoteEditor::contentChanged, this, [this](const QString& id) {
        // 仅当保存的正是当前打开的笔记时，才换回名称与状态
        if (id == m_editor->currentNoteId())
            updateNoteTitle();
    });
}

void MainWindow::updateNoteTitle()
{
    if (!m_noteTitleContainer)
        return;

    const QString id = m_editor->currentNoteId();
    if (id.isEmpty()) {
        // 无笔记打开：隐藏整个名称/状态组合容器
        m_noteTitleContainer->hide();
        return;
    }
    auto n = NoteManager::instance().note(id);
    const QString title = n ? n->title : QString();

    // 过长名称省略（名称区域约 240px，右侧留给状态文本）
    QString shown = title;
    const QFontMetrics fm(m_noteNameLabel->font());
    if (fm.horizontalAdvance(shown) > 240)
        shown = fm.elidedText(shown, Qt::ElideRight, 240);

    m_noteNameLabel->setText(shown + QStringLiteral(" /"));
    m_noteTitleContainer->show();

    // 状态切回"编辑"
    setNoteStatus(QStringLiteral("编辑"));
}

void MainWindow::setNoteStatus(const QString& status)
{
    if (!m_noteStatusLabel)
        return;

    // 状态文字前加一个空格，与笔记名称的"/"分隔开
    const QString spaced = QStringLiteral(" ") + status;

    // 首次显示（当前为空）：直接填入，避免启动时闪动
    if (m_noteStatusLabel->text().isEmpty()) {
        m_noteStatusLabel->setText(spaced);
        return;
    }

    if (m_noteStatusLabel->text() == spaced)
        return;

    // 停止上一次动画
    if (m_statusFadeAnim) {
        m_statusFadeAnim->stop();
        m_statusFadeAnim->deleteLater();
        m_statusFadeAnim = nullptr;
    }
    if (!m_statusFadeEffect) {
        m_statusFadeEffect = new QGraphicsOpacityEffect(m_noteStatusLabel);
        m_noteStatusLabel->setGraphicsEffect(m_statusFadeEffect);
        m_statusFadeEffect->setOpacity(1.0);
    }

    // 渐隐 → 替换文字 → 渐入（仅状态标签参与动画）
    auto* fadeOut = new QPropertyAnimation(m_statusFadeEffect, "opacity", this);
    m_statusFadeAnim = fadeOut;
    fadeOut->setDuration(140);
    fadeOut->setStartValue(m_statusFadeEffect->opacity());
    fadeOut->setEndValue(0.0);
    fadeOut->setEasingCurve(QEasingCurve::InCubic);
    connect(fadeOut, &QPropertyAnimation::finished, this, [this, spaced]() {
        m_statusFadeAnim = nullptr;
        m_noteStatusLabel->setText(spaced);
        auto* fadeIn = new QPropertyAnimation(m_statusFadeEffect, "opacity", this);
        m_statusFadeAnim = fadeIn;
        fadeIn->setDuration(180);
        fadeIn->setStartValue(0.0);
        fadeIn->setEndValue(1.0);
        fadeIn->setEasingCurve(QEasingCurve::OutCubic);
        connect(fadeIn, &QPropertyAnimation::finished, this, [this]() {
            m_statusFadeAnim = nullptr;
        });
        fadeIn->start(QAbstractAnimation::DeleteWhenStopped);
    });
    fadeOut->start(QAbstractAnimation::DeleteWhenStopped);
}

void MainWindow::onNewNote()
{
    auto n = NoteManager::instance().createNote();
    m_listWidget->setSelectedNote(n->id);
    m_editor->loadNote(n->id);
    updateNoteTitle();
    m_editor->setFocus();
}

void MainWindow::onDeleteNote(const QString& id)
{
    auto n = NoteManager::instance().note(id);
    if (!n)
        return;

    auto ret = QMessageBox::question(
        this, QStringLiteral("删除提示词"),
        QStringLiteral("确定要删除「%1」吗？").arg(n->title),
        QMessageBox::Yes | QMessageBox::No, QMessageBox::No);

    if (ret != QMessageBox::Yes)
        return;

    NoteManager::instance().deleteNote(id);

    const auto notes = NoteManager::instance().notes();
    if (!notes.isEmpty()) {
        const QString newId = notes.first()->id;
        m_listWidget->setSelectedNote(newId);
        m_editor->loadNote(newId);
    } else {
        m_editor->loadNote(QString());
    }
    updateNoteTitle();
}

void MainWindow::onRenameNote(const QString& id)
{
    auto n = NoteManager::instance().note(id);
    if (!n)
        return;

    // 输入框预填当前名称；取消则不做任何事
    bool ok = false;
    const QString text = QInputDialog::getText(
        this, QStringLiteral("重命名"),
        QStringLiteral("提示词名称："),
        QLineEdit::Normal, n->title, &ok);
    if (!ok)
        return;

    const QString name = text.trimmed();
    if (name.isEmpty()) {
        QMessageBox::warning(this, QStringLiteral("重命名"),
                             QStringLiteral("名称不能为空，请输入新的名称。"));
        return;
    }

    // 仅改标题，内容/背景保持不变（noteUpdated 触发列表与标题刷新）
    NoteManager::instance().updateNote(id, name, n->content, n->background);
    if (id == m_editor->currentNoteId())
        updateNoteTitle();
}

void MainWindow::onNoteSelected(const QString& id)
{
    m_listWidget->setSelectedNote(id);
    m_editor->loadNote(id);
    updateNoteTitle();
}

void MainWindow::onPinToggled(bool pinned)
{
    applyAlwaysOnTop(pinned);
    m_pinBtn->setToolTip(pinned ? QStringLiteral("已置顶 — 点击取消")
                                : QStringLiteral("置顶到桌面最上层"));
}

void MainWindow::onMinimizeClicked()
{
    // 中断可能仍在播放的还原淡入动画，从当前透明度开始淡出
    if (m_minFadeAnim)
        m_minFadeAnim->stop();

    m_minFadeAnim = new QPropertyAnimation(this, "windowOpacity", this);
    m_minFadeAnim->setDuration(220);
    m_minFadeAnim->setStartValue(windowOpacity());
    m_minFadeAnim->setEndValue(0.0);
    m_minFadeAnim->setEasingCurve(QEasingCurve::InCubic);  // 渐出：先慢后快
    connect(m_minFadeAnim, &QPropertyAnimation::finished, this, [this]() {
        m_minFadeAnim = nullptr;
        showMinimized();           // 已完全透明，系统"飞向任务栏"动画不可见
        setWindowOpacity(1.0);     // 复位透明度，保证任务栏缩略图正常
    });
    m_minFadeAnim->start(QAbstractAnimation::DeleteWhenStopped);
}

void MainWindow::playRestoreFadeIn()
{
    // 中断可能仍在播放的淡出动画
    if (m_minFadeAnim)
        m_minFadeAnim->stop();

    // 先置透明度 0，避免还原瞬间以完整尺寸闪一帧
    setWindowOpacity(0.0);

    m_minFadeAnim = new QPropertyAnimation(this, "windowOpacity", this);
    m_minFadeAnim->setDuration(220);
    m_minFadeAnim->setStartValue(0.0);
    m_minFadeAnim->setEndValue(1.0);
    m_minFadeAnim->setEasingCurve(QEasingCurve::OutCubic);  // 渐入：先快后慢
    connect(m_minFadeAnim, &QPropertyAnimation::finished, this, [this]() {
        m_minFadeAnim = nullptr;
        setWindowOpacity(1.0);
    });
    m_minFadeAnim->start(QAbstractAnimation::DeleteWhenStopped);
}

void MainWindow::startExitAnimation()
{
    auto* overlay = new ExitOverlay(this);
    overlay->start([this]() { close(); });
}

void MainWindow::applyAlwaysOnTop(bool on)
{
#ifdef Q_OS_WIN
    const HWND hwnd = reinterpret_cast<HWND>(winId());
    if (on)
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    else
        SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
#else
    Qt::WindowFlags flags = windowFlags();
    if (on)
        flags |= Qt::WindowStaysOnTopHint;
    else
        flags &= ~Qt::WindowStaysOnTopHint;
    setWindowFlags(flags);
    show();
#endif
}

void MainWindow::updateMaximizeIcon()
{
    // 最大化时切换到"还原"图标
    const bool maxed = isMaximized();
    m_maxBtn->setToolTip(maxed ? QStringLiteral("还原")
                               : QStringLiteral("最大化"));
    m_maxBtn->setSvgPath(maxed ? QStringLiteral(":/icons/restore.svg")
                               : QStringLiteral(":/icons/maximize.svg"));
}

void MainWindow::changeEvent(QEvent* event)
{
    QMainWindow::changeEvent(event);
    if (event->type() != QEvent::WindowStateChange)
        return;

    updateMaximizeIcon();

    // 从最小化恢复（点击任务栏图标）：播放淡入动画（不使用系统动画）
    const auto* wsc = static_cast<QWindowStateChangeEvent*>(event);
    if ((wsc->oldState() & Qt::WindowMinimized)
        && !(windowState() & Qt::WindowMinimized)) {
        playRestoreFadeIn();
    }
}

bool MainWindow::nativeEvent(const QByteArray& eventType, void* message,
                             qintptr* result)
{
#ifdef Q_OS_WIN
    if (eventType != "windows_generic_MSG")
        return false;

    MSG* msg = static_cast<MSG*>(message);

    // 约束最大化尺寸到工作区（不遮挡任务栏）
    if (msg->message == WM_GETMINMAXINFO) {
        auto* mmi = reinterpret_cast<MINMAXINFO*>(msg->lParam);
        const QRect avail = QApplication::primaryScreen()->availableGeometry();
        mmi->ptMaxPosition.x = avail.x();
        mmi->ptMaxPosition.y = avail.y();
        mmi->ptMaxSize.x = avail.width();
        mmi->ptMaxSize.y = avail.height();
        *result = 0;
        return true;
    }

    // 无边框窗口: 边缘缩放 + 顶栏拖动
    if (msg->message == WM_NCHITTEST) {
        const QPoint pos = mapFromGlobal(QCursor::pos());
        const QRect rc = rect();

        // 顶栏区域: 返回 HTCAPTION 允许拖动/双击最大化
        // 但按钮区域返回 HTCLIENT 保证点击生效
        if (pos.y() <= kTopBarHeight) {
            // 检查是否在顶栏按钮上（按钮是 m_topBar 的子控件）
            const QWidget* child = childAt(pos);
            if (child && child != m_topBar && child != m_central) {
                *result = HTCLIENT;
                return true;
            }
            *result = HTCAPTION;
            return true;
        }

        // 边缘缩放
        if (!isMaximized()) {
            const bool left  = pos.x() < kResizeBorder;
            const bool right = pos.x() > rc.width() - kResizeBorder;
            const bool top   = pos.y() < kResizeBorder;
            const bool bottom = pos.y() > rc.height() - kResizeBorder;

            if (top && left)     *result = HTTOPLEFT;
            else if (top && right) *result = HTTOPRIGHT;
            else if (bottom && left) *result = HTBOTTOMLEFT;
            else if (bottom && right) *result = HTBOTTOMRIGHT;
            else if (top)         *result = HTTOP;
            else if (bottom)      *result = HTBOTTOM;
            else if (left)        *result = HTLEFT;
            else if (right)       *result = HTRIGHT;
            else                  *result = HTCLIENT;
        } else {
            *result = HTCLIENT;
        }
        return true;
    }
#endif
    return QMainWindow::nativeEvent(eventType, message, result);
}

void MainWindow::closeEvent(QCloseEvent* event)
{
    // 强制保存当前笔记；落盘失败时重试最多 3 次，确保用户输入不丢失
    for (int attempt = 0; attempt < 3; ++attempt) {
        if (m_editor->saveCurrent())
            break;
        QThread::msleep(100);
    }

    if (m_exitAnimating) {
        event->accept(); // 退出动画播放完毕，真正关闭
        return;
    }

    // 首次关闭：播放退出动画（界面淡出 + 中央图标 + 再见音频）
    event->ignore();
    m_exitAnimating = true;
    startExitAnimation();
}
