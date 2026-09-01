#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QString>

class NoteListWidget;
class NoteEditor;
class PinButton;
class TitleBarButton;
class QSplitter;
class QWidget;
class QLabel;
class QGraphicsOpacityEffect;
class QPropertyAnimation;

/**
 * @brief 主窗口 —— 左右布局 + 自定义无边框标题栏
 *
 * 顶栏(自绘): 左侧 logo, 右侧 图钉|最小化|最大化|关闭
 * 左侧: NoteListWidget  笔记卡片列表（顶部含新建/删除按钮）
 * 右侧: NoteEditor      富文本编辑区
 *
 * 窗口使用 FramelessWindowHint，通过 nativeEvent(WM_NCHITTEST)
 * 实现边缘缩放与标题栏拖动。
 * 最小化：点击最小化按钮窗口淡出后最小化（不使用系统动画）；
 * 还原：点击任务栏窗口淡入。
 * 关闭播放"界面淡出 + 中央图标淡入（尺寸同开屏动画）+ 再见音频"退出动画。
 * 所有动画使用非线性缓动曲线。
 */
class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr);
    ~MainWindow() override;

protected:
    void closeEvent(QCloseEvent* event) override;
    bool nativeEvent(const QByteArray& eventType, void* message,
                     qintptr* result) override;
    void changeEvent(QEvent* event) override;

private slots:
    void onNewNote();
    void onDeleteNote(const QString& id);
    void onRenameNote(const QString& id);
    void onNoteSelected(const QString& id);
    void onPinToggled(bool pinned);
    void onMinimizeClicked();

private:
    void setupUI();
    void setupConnections();
    void applyAlwaysOnTop(bool on);
    void updateMaximizeIcon();
    void playRestoreFadeIn();   // 还原（点击任务栏）淡入动画
    void startExitAnimation();

    // 顶部中间：当前笔记名称 / 保存状态显示
    void updateNoteTitle();                       // 刷新为当前打开笔记名称与"编辑"状态
    void setNoteStatus(const QString& status);    // 状态标签渐隐换字动画

    QWidget* m_central = nullptr;
    QWidget* m_topBar = nullptr;
    
    QWidget* m_noteTitleContainer = nullptr;      // 顶部中间：名称+状态组合容器
    QLabel* m_noteNameLabel = nullptr;            // 顶部中间：笔记名称（"名称 /"）
    QLabel* m_noteStatusLabel = nullptr;          // 顶部中间：保存状态（编辑/保存中）
    QGraphicsOpacityEffect* m_statusFadeEffect = nullptr;
    QPropertyAnimation* m_statusFadeAnim = nullptr;
    PinButton* m_pinBtn = nullptr;
    TitleBarButton* m_minBtn = nullptr;
    TitleBarButton* m_maxBtn = nullptr;
    TitleBarButton* m_closeBtn = nullptr;

    QSplitter* m_splitter = nullptr;
    NoteListWidget* m_listWidget = nullptr;
    NoteEditor* m_editor = nullptr;

    bool m_maximized = false;
    bool m_exitAnimating = false;   // 关闭动画播放中（第二次 close 直接接受）
    QPropertyAnimation* m_minFadeAnim = nullptr;  // 最小化淡出/还原淡入动画
};

#endif // MAINWINDOW_H
