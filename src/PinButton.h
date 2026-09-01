#ifndef PINBUTTON_H
#define PINBUTTON_H

#include <QWidget>
#include <QPixmap>

/**
 * @brief 大头钉置顶按钮
 *
 * 使用 SVG 图标 (thumbtack)，点击后通过旋转动画切换"置顶"状态。
 * 颜色规则：默认/悬停均为灰色（悬停颜色与默认一致，仅背景高亮）；
 * 点击置顶时图标淡入红色，取消置顶淡出回灰色（colorProgress 进度插值）。
 * 图标预渲染为灰/红两种状态，动画期间仅做绘制，几乎不占算力。
 * 动画使用非线性缓动曲线 OutBack/OutCubic，遵循 RAII 原则。
 */
class PinButton : public QWidget {
    Q_OBJECT
    Q_PROPERTY(qreal rotation READ rotation WRITE setRotation)
    Q_PROPERTY(qreal hoverProgress READ hoverProgress WRITE setHoverProgress)
    Q_PROPERTY(qreal colorProgress READ colorProgress WRITE setColorProgress)
public:
    explicit PinButton(QWidget* parent = nullptr);

    bool isPinned() const { return m_pinned; }
    qreal rotation() const { return m_rotation; }
    void setRotation(qreal r);

    qreal hoverProgress() const { return m_hover; }
    void setHoverProgress(qreal h);

    qreal colorProgress() const { return m_colorProgress; }
    void setColorProgress(qreal c);

    void setPinned(bool pinned);

signals:
    void toggled(bool pinned);

protected:
    void paintEvent(QPaintEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void enterEvent(QEnterEvent* event) override;
    void leaveEvent(QEvent* event) override;

private:
    void animateTo(qreal target, const char* property);
    void animateColor(qreal target);
    void renderIcons();

    bool m_pinned = false;
    qreal m_rotation = 0.0;     // 0° = 未置顶, 45° = 置顶
    qreal m_hover = 0.0;
    qreal m_colorProgress = 0.0; // 0 = 灰色(默认), 1 = 红色(置顶)
    QPixmap m_iconNormal;
    QPixmap m_iconPinned;
};

#endif // PINBUTTON_H
