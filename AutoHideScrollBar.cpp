#include "AutoHideScrollBar.h"

#include <QPainter>
#include <QStyle>
#include <QStyleOptionSlider>
#include <QEnterEvent>
#include <QWheelEvent>
#include <QEasingCurve>

// 空闲时的淡出程度：约 55% 深度，保留一条清晰可见的细黑线；
// 滚动/悬停时加深到完全不透明。
static const qreal kIdleFade = 0.55;

AutoHideScrollBar::AutoHideScrollBar(Qt::Orientation orientation,
                                     QWidget* parent)
    : QScrollBar(orientation, parent)
    , m_fadeAnim(this, "fade")
    , m_fade(kIdleFade) // 初始即保留一条隐约可见的细线，提示滚动条位置
{
    // 细线样式：横向/纵向均为 8px 厚度的窄条，轨道透明
    if (orientation == Qt::Vertical)
        setFixedWidth(8);
    else
        setFixedHeight(8);

    m_fadeAnim.setDuration(200);
    m_fadeAnim.setEasingCurve(QEasingCurve::OutCubic);

    // 停止滚动/离开滚动条 1.2s 后自动淡出
    m_hideTimer.setSingleShot(true);
    m_hideTimer.setInterval(1200);
    connect(&m_hideTimer, &QTimer::timeout, this, &AutoHideScrollBar::fadeOut);
}

void AutoHideScrollBar::setFade(qreal v)
{
    m_fade = v;
    update();
}

void AutoHideScrollBar::showTemporarily()
{
    m_hideTimer.start(); // 重置隐藏倒计时
    if (m_fade >= 1.0)
        return;
    m_fadeAnim.stop();
    m_fadeAnim.setStartValue(m_fade);
    m_fadeAnim.setEndValue(1.0);
    m_fadeAnim.start();
}

void AutoHideScrollBar::fadeOut()
{
    // 鼠标仍悬停在滚动条上时不淡出
    if (m_hovered)
        return;
    if (m_fade <= kIdleFade)
        return;
    m_fadeAnim.stop();
    m_fadeAnim.setStartValue(m_fade);
    m_fadeAnim.setEndValue(kIdleFade);
    m_fadeAnim.start();
}

void AutoHideScrollBar::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);

    // 用系统样式计算滑块几何（保证与点击轨道翻页等交互逻辑一致）
    QStyleOptionSlider opt;
    initStyleOption(&opt);
    QRect handle =
        style()->subControlRect(QStyle::CC_ScrollBar, &opt,
                                QStyle::SC_ScrollBarSlider, this);
    if (handle.isEmpty())
        return;

    // 细线：竖向取滑块中间一条竖线，横向取中间一条横线
    const int margin = 2;
    QRectF line;
    if (orientation() == Qt::Vertical) {
        const qreal x = rect().center().x();
        line = QRectF(x - 2.0, handle.top() + margin,
                      4.0, handle.height() - margin * 2);
    } else {
        const qreal y = rect().center().y();
        line = QRectF(handle.left() + margin, y - 2.0,
                      handle.width() - margin * 2, 4.0);
    }
    if (line.height() < 4.0 || line.width() < 4.0)
        return;

    // 深色细线（基础深度 200/255），滚动/悬停时 fade→1 加深，空闲 fade→0.55 变浅
    const int baseAlpha = 200;
    QColor color(QStringLiteral("#25314C"));
    color.setAlpha(qRound(baseAlpha * m_fade));
    p.setPen(Qt::NoPen);
    p.setBrush(color);
    p.drawRoundedRect(line, 1.5, 1.5);
}

void AutoHideScrollBar::enterEvent(QEnterEvent* event)
{
    m_hovered = true;
    m_hideTimer.stop();
    showTemporarily();
    QScrollBar::enterEvent(event);
}

void AutoHideScrollBar::leaveEvent(QEvent* event)
{
    m_hovered = false;
    m_hideTimer.start();
    QScrollBar::leaveEvent(event);
}

void AutoHideScrollBar::wheelEvent(QWheelEvent* event)
{
    showTemporarily();
    QScrollBar::wheelEvent(event);
}

void AutoHideScrollBar::sliderChange(SliderChange change)
{
    // 值或范围变化（拖动滑块、滚轮、点轨道、程序滚动）都视为"正在使用"
    if (change == QAbstractSlider::SliderValueChange
        || change == QAbstractSlider::SliderRangeChange) {
        showTemporarily();
    }
    QScrollBar::sliderChange(change);
}
