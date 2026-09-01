#include "TitleBarButton.h"
#include "SvgIconLoader.h"

#include <QPainter>
#include <QPropertyAnimation>
#include <QMouseEvent>
#include <QEnterEvent>

TitleBarButton::TitleBarButton(const QString& svgPath, const QString& tooltip,
                               Role role, QWidget* parent)
    : QAbstractButton(parent)
    , m_svgPath(svgPath)
    , m_role(role)
{
    setToolTip(tooltip);
    setCursor(Qt::PointingHandCursor);
    setFixedSize(30, 24);
    setFocusPolicy(Qt::NoFocus);
    renderIcons();
}

void TitleBarButton::setSvgPath(const QString& path)
{
    if (m_svgPath == path)
        return;
    m_svgPath = path;
    renderIcons();
    update();
}

void TitleBarButton::setHoverProgress(qreal p)
{
    m_hover = p;
    update();
}

void TitleBarButton::animateHoverTo(qreal target)
{
    auto* anim = new QPropertyAnimation(this, "hoverProgress", this);
    anim->setDuration(180);
    anim->setStartValue(m_hover);
    anim->setEndValue(target);
    anim->setEasingCurve(QEasingCurve::OutCubic); // 非线性
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void TitleBarButton::renderIcons()
{
    QColor normal, hover;
    switch (m_role) {
    case Minimize:
    case Maximize:
        normal = QColor(80, 80, 92);
        hover  = QColor(35, 35, 45);
        break;
    case Close:
        normal = QColor(80, 80, 92);
        hover  = QColor(255, 255, 255);
        break;
    default:
        normal = QColor(90, 90, 100);
        hover  = QColor(55, 55, 70);
        break;
    }

    const qreal iconSize = 14.0;
    m_iconNormal = SvgIconLoader::load(m_svgPath, normal,
                                       static_cast<int>(iconSize * 2))
                       .pixmap(QSize(static_cast<int>(iconSize * 2),
                                     static_cast<int>(iconSize * 2)));
    m_iconHover = SvgIconLoader::load(m_svgPath, hover,
                                      static_cast<int>(iconSize * 2))
                      .pixmap(QSize(static_cast<int>(iconSize * 2),
                                    static_cast<int>(iconSize * 2)));
}

void TitleBarButton::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);

    const QRectF rc(rect());
    const qreal h = m_hover;

    // 背景
    if (m_role == Close) {
        // 关闭按钮悬停红色渐变
        QColor bg = QColor(196, 43, 28);
        bg.setAlphaF(h);
        p.setPen(Qt::NoPen);
        p.setBrush(bg);
        p.drawRoundedRect(rc, 5, 5);
    } else {
        QColor bg = QColor(90, 90, 105);
        bg.setAlphaF(h * 0.14);
        p.setPen(Qt::NoPen);
        p.setBrush(bg);
        p.drawRoundedRect(rc, 5, 5);
    }

    // 按下状态
    if (m_pressed) {
        QColor bg = m_role == Close ? QColor(160, 30, 20) : QColor(90, 90, 105);
        bg.setAlphaF(m_role == Close ? h : h * 0.22);
        p.setBrush(bg);
        p.drawRoundedRect(rc, 5, 5);
    }

    // 图标：normal 与 hover 混合
    const qreal iconSize = 14.0;
    const QRectF iconRect(rc.center().x() - iconSize / 2,
                          rc.center().y() - iconSize / 2,
                          iconSize, iconSize);

    p.setOpacity(1.0 - h);
    p.drawPixmap(iconRect.toRect(), m_iconNormal);
    p.setOpacity(h);
    p.drawPixmap(iconRect.toRect(), m_iconHover);
    p.setOpacity(1.0);
}

void TitleBarButton::enterEvent(QEnterEvent* event)
{
    Q_UNUSED(event)
    animateHoverTo(1.0);
}

void TitleBarButton::leaveEvent(QEvent* event)
{
    Q_UNUSED(event)
    animateHoverTo(0.0);
    m_pressed = false;
}

void TitleBarButton::mousePressEvent(QMouseEvent* event)
{
    if (event->button() == Qt::LeftButton) {
        m_pressed = true;
        update();
    }
    QAbstractButton::mousePressEvent(event);
}

void TitleBarButton::mouseReleaseEvent(QMouseEvent* event)
{
    m_pressed = false;
    update();
    QAbstractButton::mouseReleaseEvent(event);
}
