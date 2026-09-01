#ifndef TITLEBARBUTTON_H
#define TITLEBARBUTTON_H

#include <QAbstractButton>
#include <QPixmap>

/**
 * @brief 自定义标题栏按钮（融入软件风格的窗口控制按钮）
 *
 * 不使用 Win11 系统默认按钮，改用自绘 SVG 图标 + 悬停渐变动画。
 * 图标在构造时预渲染为 normal/hover 两个像素图，动画期间仅做
 * alpha 混合绘制，几乎不占用算力。
 * 所有动画使用非线性缓动曲线 (QEasingCurve)，遵循 RAII 原则。
 */
class TitleBarButton : public QAbstractButton {
    Q_OBJECT
    Q_PROPERTY(qreal hoverProgress READ hoverProgress WRITE setHoverProgress)
public:
    enum Role {
        Normal,    // 普通工具按钮（新建、删除等）
        Minimize,
        Maximize,
        Close
    };

    explicit TitleBarButton(const QString& svgPath, const QString& tooltip,
                            Role role = Normal, QWidget* parent = nullptr);

    /** 切换图标源（如最大化 ↔ 还原） */
    void setSvgPath(const QString& path);

    qreal hoverProgress() const { return m_hover; }
    void setHoverProgress(qreal p);

protected:
    void paintEvent(QPaintEvent* event) override;
    void enterEvent(QEnterEvent* event) override;
    void leaveEvent(QEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;

private:
    void animateHoverTo(qreal target);
    void renderIcons();

    QString m_svgPath;
    Role m_role;
    QPixmap m_iconNormal;
    QPixmap m_iconHover;
    qreal m_hover = 0.0;
    bool m_pressed = false;
};

#endif // TITLEBARBUTTON_H
