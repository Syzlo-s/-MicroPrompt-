#ifndef AUTOHIDESCROLLBAR_H
#define AUTOHIDESCROLLBAR_H

#include <QScrollBar>
#include <QPropertyAnimation>
#include <QTimer>

/**
 * @brief 自动隐藏滚动条（细黑线样式）
 *
 * 特点：
 *  - 平时淡出到约 55% 深度（保留一条隐约可见的细线），滚动/悬停时平滑淡入，
 *    停止滚动一段时间后淡出；
 *  - 滑块绘制为一条居中的细圆角线（半透明深色，悬停加深），轨道完全透明；
 *  - 交互完整保留：拖动滑块、点击轨道翻页、滚轮、键盘方向键均由基类处理。
 */
class AutoHideScrollBar : public QScrollBar {
    Q_OBJECT
    Q_PROPERTY(qreal fade READ fade WRITE setFade)
public:
    explicit AutoHideScrollBar(Qt::Orientation orientation,
                               QWidget* parent = nullptr);

protected:
    void paintEvent(QPaintEvent*) override;
    void enterEvent(QEnterEvent*) override;
    void leaveEvent(QEvent*) override;
    void wheelEvent(QWheelEvent*) override;
    void sliderChange(SliderChange change) override;

private:
    qreal fade() const { return m_fade; }
    void setFade(qreal v);

    // 短暂显示：淡入并重置隐藏倒计时
    void showTemporarily();
    // 淡出隐藏
    void fadeOut();

    qreal m_fade = 0.0;
    bool m_hovered = false;
    QPropertyAnimation m_fadeAnim;
    QTimer m_hideTimer;
};

#endif // AUTOHIDESCROLLBAR_H
