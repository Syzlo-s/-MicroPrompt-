#include "PinButton.h"
#include "SvgIconLoader.h"

#include <QPainter>
#include <QPropertyAnimation>
#include <QMouseEvent>
#include <QEnterEvent>

PinButton::PinButton(QWidget* parent)
    : QWidget(parent)
{
    setFixedSize(30, 24);
    setCursor(Qt::PointingHandCursor);
    setFocusPolicy(Qt::NoFocus);
    renderIcons();
}

void PinButton::setRotation(qreal r)
{
    m_rotation = r;
    update();
}

void PinButton::setHoverProgress(qreal h)
{
    m_hover = h;
    update();
}

void PinButton::setColorProgress(qreal c)
{
    m_colorProgress = c;
    update();
}

void PinButton::setPinned(bool pinned)
{
    if (m_pinned == pinned)
        return;
    m_pinned = pinned;
    animateTo(pinned ? 45.0 : 0.0, "rotation");
    animateColor(pinned ? 1.0 : 0.0);   // 颜色淡入红色 / 淡出回灰色
    emit toggled(m_pinned);
}

void PinButton::animateTo(qreal target, const char* property)
{
    auto* anim = new QPropertyAnimation(this, property, this);
    anim->setDuration(350);
    anim->setStartValue(target == 45.0 ? 0.0 : m_rotation);
    anim->setEndValue(target);
    // 禁止线性曲线 —— 使用 OutBack 带回弹效果
    anim->setEasingCurve(QEasingCurve::OutBack);
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

// 图标颜色淡入/淡出：灰色（默认）↔ 红色（置顶）
void PinButton::animateColor(qreal target)
{
    auto* anim = new QPropertyAnimation(this, "colorProgress", this);
    anim->setDuration(300);
    anim->setStartValue(m_colorProgress);
    anim->setEndValue(target);
    anim->setEasingCurve(QEasingCurve::OutCubic);
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void PinButton::renderIcons()
{
    const int size = 30; // 2x 分辨率渲染
    m_iconNormal = SvgIconLoader::load(QStringLiteral(":/icons/pin.svg"),
                                       QColor(90, 90, 102), size)
                       .pixmap(QSize(size, size));
    m_iconPinned = SvgIconLoader::load(QStringLiteral(":/icons/pin.svg"),
                                       QColor(192, 57, 43), size)   // 置顶红色
                       .pixmap(QSize(size, size));
}

void PinButton::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);

    const QRectF rc(rect());
    const qreal h = m_hover;

    // 悬停背景
    QColor bg(90, 90, 105);
    bg.setAlphaF(h * 0.14);
    p.setPen(Qt::NoPen);
    p.setBrush(bg);
    p.drawRoundedRect(rc, 5, 5);

    // 旋转
    p.save();
    p.translate(rc.center());
    p.rotate(m_rotation);
    p.translate(-rc.center());

    // 图标绘制：颜色按 colorProgress 在灰色（默认）与红色（置顶）间淡入淡出
    const qreal iconSize = 15.0;
    const QRectF iconRect(rc.center().x() - iconSize / 2,
                          rc.center().y() - iconSize / 2,
                          iconSize, iconSize);

    const qreal t = m_colorProgress;
    p.setOpacity(1.0 - t);
    p.drawPixmap(iconRect.toRect(), m_iconNormal);
    p.setOpacity(t);
    p.drawPixmap(iconRect.toRect(), m_iconPinned);
    p.setOpacity(1.0);

    p.restore();
}

void PinButton::mousePressEvent(QMouseEvent* event)
{
    if (event->button() == Qt::LeftButton) {
        setPinned(!m_pinned);
    }
    QWidget::mousePressEvent(event);
}

void PinButton::enterEvent(QEnterEvent* event)
{
    Q_UNUSED(event)
    auto* anim = new QPropertyAnimation(this, "hoverProgress", this);
    anim->setDuration(180);
    anim->setStartValue(m_hover);
    anim->setEndValue(1.0);
    anim->setEasingCurve(QEasingCurve::OutCubic); // 非线性
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void PinButton::leaveEvent(QEvent* event)
{
    Q_UNUSED(event)
    auto* anim = new QPropertyAnimation(this, "hoverProgress", this);
    anim->setDuration(180);
    anim->setStartValue(m_hover);
    anim->setEndValue(0.0);
    anim->setEasingCurve(QEasingCurve::OutCubic); // 非线性
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}
