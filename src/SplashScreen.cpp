#include "SplashScreen.h"

#include <QLabel>
#include <QPainter>
#include <QScreen>
#include <QApplication>
#include <QGraphicsOpacityEffect>
#include <QPropertyAnimation>
#include <QPauseAnimation>
#include <QParallelAnimationGroup>
#include <QSequentialAnimationGroup>

SplashScreen::SplashScreen(QWidget* parent)
    : QWidget(parent)
{
    // 透明浮层：覆盖整个屏幕，不拦截鼠标
    setWindowFlags(Qt::FramelessWindowHint | Qt::Tool
                   | Qt::WindowStaysOnTopHint | Qt::WindowTransparentForInput);
    setAttribute(Qt::WA_TranslucentBackground);
    setAttribute(Qt::WA_DeleteOnClose, false);

    // 覆盖主窗口所在屏幕，图标显示在桌面中央
    QScreen* scr = parent ? parent->screen() : QApplication::primaryScreen();
    if (scr) {
        setGeometry(scr->geometry());
    } else if (parent) {
        setGeometry(parent->geometry());
    } else {
        resize(480, 300);
    }

    // 中央软件图标
    m_logo = new QLabel(this);
    m_logo->setObjectName(QStringLiteral("splashLogo"));
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
    m_logo->move((width() - m_logo->width()) / 2,
                 (height() - m_logo->height()) / 2);

    // 图标初始透明，由 play() 播放淡入/淡出
    m_logoEffect = new QGraphicsOpacityEffect(m_logo);
    m_logo->setGraphicsEffect(m_logoEffect);
    m_logoEffect->setOpacity(0.0);
}

void SplashScreen::play()
{
    // 主窗口初始透明，待图标淡出时同步淡入
    if (parentWidget())
        parentWidget()->setWindowOpacity(0.0);

    show();

    // 第一阶段：图标在桌面中央淡入
    auto* fadeIn = new QPropertyAnimation(m_logoEffect, "opacity", this);
    fadeIn->setDuration(420);
    fadeIn->setStartValue(0.0);
    fadeIn->setEndValue(1.0);
    fadeIn->setEasingCurve(QEasingCurve::OutCubic);

    // 图标完全显示后短暂停留
    auto* hold = new QPauseAnimation(140, this);

    // 第二阶段：图标淡出 ∥ 主窗口淡入（并行）
    auto* fadeGroup = new QParallelAnimationGroup(this);

    auto* fadeOut = new QPropertyAnimation(m_logoEffect, "opacity", this);
    fadeOut->setDuration(450);
    fadeOut->setStartValue(1.0);
    fadeOut->setEndValue(0.0);
    fadeOut->setEasingCurve(QEasingCurve::InCubic);
    fadeGroup->addAnimation(fadeOut);

    if (QWidget* win = parentWidget()) {
        auto* winFadeIn = new QPropertyAnimation(win, "windowOpacity", this);
        winFadeIn->setDuration(450);
        winFadeIn->setStartValue(0.0);
        winFadeIn->setEndValue(1.0);
        winFadeIn->setEasingCurve(QEasingCurve::OutCubic);
        fadeGroup->addAnimation(winFadeIn);
    }

    m_sequence = new QSequentialAnimationGroup(this);
    m_sequence->addAnimation(fadeIn);
    m_sequence->addAnimation(hold);
    m_sequence->addAnimation(fadeGroup);
    connect(m_sequence, &QSequentialAnimationGroup::finished,
            this, [this]() {
        emit finished();
        hide();
        // 注意：SplashScreen 由 main() 中的栈对象持有（RAII），
        // 动画结束时只隐藏，不 deleteLater()，避免双重释放。
    });
    m_sequence->start();
}
