#ifndef SPLASHSCREEN_H
#define SPLASHSCREEN_H

#include <QWidget>

class QLabel;
class QGraphicsOpacityEffect;
class QSequentialAnimationGroup;

/**
 * @brief 启动动画画面
 *
 * 软件图标在桌面中央淡入 → 短暂停留 → 图标淡出的同时主窗口在其后淡入。
 * 全部采用非线性缓动曲线 (QEasingCurve)，遵循 RAII 原则。
 */
class SplashScreen : public QWidget {
    Q_OBJECT
public:
    explicit SplashScreen(QWidget* parent = nullptr);

    /** 开始播放启动动画，播放结束自动隐藏 */
    void play();

signals:
    void finished();

private:
    QLabel* m_logo = nullptr;
    QGraphicsOpacityEffect* m_logoEffect = nullptr;
    QSequentialAnimationGroup* m_sequence = nullptr;
};

#endif // SPLASHSCREEN_H
