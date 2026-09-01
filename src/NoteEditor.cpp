#include "NoteEditor.h"
#include "NoteManager.h"

#include <QApplication>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QTextCharFormat>
#include <QTextBlock>
#include <QFont>
#include <QTimer>
#include <QEvent>
#include <QFrame>
#include <QPainter>
#include <QPainterPath>
#include <QMouseEvent>
#include <QKeyEvent>
#include <QEnterEvent>
#include <QPropertyAnimation>
#include <QParallelAnimationGroup>
#include <QVariantAnimation>
#include <QGraphicsOpacityEffect>
#include <QCoreApplication>
#include <QScrollBar>
#include <QPixmap>
#include <functional>
#include "SvgIconLoader.h"
#include "AutoHideScrollBar.h"

// ============ 保存调试日志（已禁用：每次按键都写 save.log 会造成界面卡顿/输入无响应） ============
// 需要排查保存链路时，可恢复下方实现。
static void logSave(const QString& msg)
{
    Q_UNUSED(msg)
}

// ===================== ToolButton 实现 =====================

ToolButton::ToolButton(QWidget* parent)
    : QWidget(parent)
{
    setCursor(Qt::PointingHandCursor);
    setFocusPolicy(Qt::NoFocus);
}

void ToolButton::setChecked(bool checked)
{
    if (m_checked == checked)
        return;
    m_checked = checked;
    emit toggled(m_checked);
    // 选中指示条随状态滑入/滑出（底部短横线）
    animateCheck(checked ? 1.0 : 0.0);
}

void ToolButton::setText(const QString& text)
{
    m_text = text;
    update();
}

void ToolButton::setTextFont(const QFont& font)
{
    m_textFont = font;
    update();
}

void ToolButton::setIcon(const QPixmap& icon)
{
    m_icon = icon;
    m_swatch = QColor();
    update();
}

void ToolButton::setSwatch(const QColor& color)
{
    m_swatch = color;
    m_icon = QPixmap();
    m_text.clear();
    update();
}

void ToolButton::setHoverProgress(qreal h)
{
    m_hover = h;
    update();
}

void ToolButton::setPressProgress(qreal p)
{
    m_press = p;
    update();
}

void ToolButton::setCheckProgress(qreal c)
{
    m_checkProgress = c;
    update();
}

void ToolButton::animateHover(qreal target)
{
    auto* anim = new QPropertyAnimation(this, "hoverProgress", this);
    anim->setDuration(160);
    anim->setStartValue(m_hover);
    anim->setEndValue(target);
    anim->setEasingCurve(QEasingCurve::OutCubic);
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void ToolButton::animatePress(qreal target)
{
    auto* anim = new QPropertyAnimation(this, "pressProgress", this);
    anim->setDuration(150);
    anim->setStartValue(m_press);
    anim->setEndValue(target);
    anim->setEasingCurve(QEasingCurve::OutCubic);
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

// 选中指示条进度：从中心向两侧对称生长/收缩
void ToolButton::animateCheck(qreal target)
{
    auto* anim = new QPropertyAnimation(this, "checkProgress", this);
    anim->setDuration(300);
    anim->setStartValue(m_checkProgress);
    anim->setEndValue(target);
    anim->setEasingCurve(QEasingCurve::OutCubic);
    anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void ToolButton::enterEvent(QEnterEvent* event)
{
    Q_UNUSED(event)
    animateHover(1.0);
}

void ToolButton::leaveEvent(QEvent* event)
{
    Q_UNUSED(event)
    animateHover(0.0);
    // 按下后直接移出按钮：复位按下状态，避免卡在按下样式
    if (m_pressed) {
        m_pressed = false;
        animatePress(0.0);
    }
}

void ToolButton::mousePressEvent(QMouseEvent* event)
{
    if (event->button() == Qt::LeftButton) {
        m_pressed = true;
        animatePress(1.0);
    }
    QWidget::mousePressEvent(event);
}

void ToolButton::mouseReleaseEvent(QMouseEvent* event)
{
    if (event->button() == Qt::LeftButton && m_pressed) {
        m_pressed = false;
        animatePress(0.0);
        if (rect().contains(event->pos())) {
            if (m_checkable)
                setChecked(!m_checked);
            emit clicked();
        }
    }
    QWidget::mouseReleaseEvent(event);
}

void ToolButton::paintEvent(QPaintEvent*)
{
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);

    const QRectF rc(rect());
    const qreal radius = m_cornerRadius;
    const qreal h = m_hover;

    // 背景层：按下为白色 + 白色发光阴影"笼罩"（径向渐变光晕，随按下进度淡入淡出）；
    // 选中态不再填背景，改用底部指示条表达（见下方指示条绘制）
    p.setPen(Qt::NoPen);
    if (m_press > 0.0) {
        const qreal glow = 0.32 * m_press;  // 光晕峰值强度
        QRadialGradient g(rc.center(),
                          qMax(rc.width(), rc.height()) * 0.9);
        g.setColorAt(0.0, QColor(255, 255, 255, 0));
        g.setColorAt(0.55, QColor(255, 255, 255, qRound(255 * glow)));
        g.setColorAt(1.0, QColor(255, 255, 255, 0));
        p.setBrush(g);
        p.drawRoundedRect(rc.adjusted(-8, -8, 8, 8), radius + 8, radius + 8);
        p.setBrush(QColor(255, 255, 255));  // 白色按下面板
        p.drawRoundedRect(rc, radius, radius);
    } else if (h > 0.0) {
        // hover 背景按配置颜色混合透明度（可配置为极淡灰，如 rgba(170,170,170,0.062)）
        QColor hc = m_hoverColor;
        hc.setAlpha(qRound(hc.alpha() * h));
        p.setBrush(hc);
        p.drawRoundedRect(rc, radius, radius);
    }

    // 内容：色块 / 图标 / 文字符号 三种形态
    if (m_swatch.isValid()) {
        // 背景切换色块：1px 边框，选中时深灰描边；
        // 垂直居中偏上 2px，为底部选中指示条留出间距
        const qreal sw = 11.0;
        QRectF sr(rc.center().x() - sw / 2, rc.center().y() - sw / 2 - 2.0, sw, sw);
        p.setPen(QPen(m_checked ? QColor(0x70, 0x70, 0x70) : QColor(200, 204, 216), 1));
        p.setBrush(m_swatch);
        p.drawRoundedRect(sr, 3, 3);
    } else if (!m_icon.isNull()) {
        // 图标（文字颜色按钮）：按逻辑尺寸居中绘制
        const qreal dpr = m_icon.devicePixelRatio();
        const QSizeF is(m_icon.width() / dpr, m_icon.height() / dpr);
        p.drawPixmap(QPointF(rect().center().x() - is.width() / 2.0,
                             rect().center().y() - is.height() / 2.0),
                     m_icon);
    } else if (!m_text.isEmpty()) {
        // 文字符号（B/U/S）
        QFont f = m_textFont;
        if (f.pointSize() <= 0)
            f = font();
        p.setFont(f);
        p.setPen(QColor(74, 80, 94));  // 白色主题下文字按钮恒为深色，保证可读性
        p.drawText(rect(), Qt::AlignCenter, m_text);
    }

    // 选中指示条：底部深灰圆角短横线，从中心向两侧对称生长（checkProgress 0~1）
    if (m_indicatorEnabled && m_checkProgress > 0.0) {
        const qreal t = m_checkProgress;
        const qreal barW = 14.0;  // 完全展开时宽度
        const qreal barH = 1.5;   // 细线高度（兼做圆角半径一半）
        const qreal y = rc.bottom() - 2.5 - barH; // 距底 2.5px，与上方色块保持间距
        const qreal x = rc.center().x() - barW * t / 2.0;
        p.setPen(Qt::NoPen);
        p.setBrush(QColor(0x2A, 0x2A, 0x2A));
        p.drawRoundedRect(QRectF(x, y, barW * t, barH), barH / 2, barH / 2);
    }
}

// ============================================================
// ColorSwatch —— 文字颜色选择弹层中的单个色块
//   圆形色块：悬停放大、按下微缩加深、选中蓝色描边 + 对勾
// ============================================================
class ColorSwatch : public QWidget {
public:
    ColorSwatch(const QColor& color, const QString& name, bool selected,
                QWidget* parent = nullptr)
        : QWidget(parent), m_color(color), m_selected(selected)
    {
        setFixedSize(20, 20);
        setCursor(Qt::PointingHandCursor);
        setToolTip(name);
    }

    // 选择回调（由弹层注入）
    std::function<void(const QColor&)> onClick;

protected:
    void enterEvent(QEnterEvent*) override { animate(1.0); }
    void leaveEvent(QEvent*) override { animate(0.0); }
    void mousePressEvent(QMouseEvent* e) override
    {
        if (e->button() == Qt::LeftButton) {
            m_press = 1.0;
            update();
        }
        QWidget::mousePressEvent(e);
    }
    void mouseReleaseEvent(QMouseEvent* e) override
    {
        if (e->button() == Qt::LeftButton && m_press > 0.0) {
            m_press = 0.0;
            update();
            if (rect().contains(e->pos()) && onClick)
                onClick(m_color);
        }
        QWidget::mouseReleaseEvent(e);
    }
    void paintEvent(QPaintEvent*) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);

        // 悬停放大、按下微缩
        const qreal scale = (1.0 + 0.13 * m_hover) * (1.0 - 0.10 * m_press);
        QRectF r = rect().adjusted(1.5, 1.5, -1.5, -1.5);
        p.save();
        p.translate(rect().center());
        p.scale(scale, scale);
        p.translate(-rect().center());

        // 边框：白/浅色用灰边；选中用深灰描边（白色主题）
        QColor border = m_color.lightness() > 235 ? QColor(205, 209, 220)
                                                  : QColor(0, 0, 0, 28);
        if (m_selected)
            border = QColor(0x60, 0x60, 0x60);
        p.setPen(QPen(border, m_selected ? 2.0 : 1.0));
        p.setBrush(m_color);
        p.drawEllipse(r);
        p.restore();

        // 按下加深
        if (m_press > 0.0) {
            p.setPen(Qt::NoPen);
            p.setBrush(QColor(0, 0, 0, qRound(70.0 * m_press)));
            p.drawEllipse(rect().adjusted(2, 2, -2, -2));
        }

        // 选中对勾（深色块用白色，浅色块用深灰）
        if (m_selected) {
            const QColor chk = m_color.lightness() < 150 ? QColor(Qt::white)
                                                         : QColor(70, 76, 88);
            const QPointF c = rect().center();
            p.setPen(QPen(chk, 1.8, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
            QPainterPath path;
            path.moveTo(c.x() - 5.0, c.y());
            path.lineTo(c.x() - 1.5, c.y() + 3.5);
            path.lineTo(c.x() + 5.0, c.y() - 3.5);
            p.drawPath(path);
        }
    }

private:
    void animate(qreal target)
    {
        auto* anim = new QVariantAnimation(this);
        anim->setDuration(160);
        anim->setStartValue(m_hover);
        anim->setEndValue(target);
        anim->setEasingCurve(QEasingCurve::OutCubic);
        connect(anim, &QVariantAnimation::valueChanged, this, [this](const QVariant& v) {
            m_hover = v.toReal();
            update();
        });
        anim->start(QAbstractAnimation::DeleteWhenStopped);
    }

    QColor m_color;
    bool m_selected = false;
    qreal m_hover = 0.0;
    qreal m_press = 0.0;
};

// ============================================================
// ColorPickerPopup —— 文字颜色选择（红/蓝/绿/白/黑 5 色）
//   内嵌工具栏、与颜色按钮同一行的无边框色块行：
//   不绘制任何外框/背景，仅 5 个圆形色块在按钮右侧并列显示；
//   出现动画：从按钮右侧向右滑入 + 淡入；
//   关闭动画：向右滑出 + 淡出，结束后通知按钮取消高亮
// ============================================================
class ColorPickerPopup : public QWidget {
public:
    ColorPickerPopup(const QColor& current, QWidget* ownerBtn)
        : QWidget(ownerBtn->parentWidget()), m_ownerBtn(ownerBtn)
    {
        const struct { QColor color; const char* name; } kColors[] = {
            { QColor(229, 57, 53), "红色" },
            { QColor(74, 144, 217), "蓝色" },
            { QColor(67, 160, 71), "绿色" },
            { QColor(255, 255, 255), "白色" },
            { QColor(33, 33, 33), "黑色" },
        };

        auto* lay = new QHBoxLayout(this);
        lay->setContentsMargins(6, 0, 0, 0);
        lay->setSpacing(8);
        for (const auto& c : kColors) {
            auto* sw = new ColorSwatch(c.color, QString::fromUtf8(c.name),
                                       c.color == current, this);
            sw->onClick = [this](const QColor& cc) {
                if (onPick)
                    onPick(cc);
                closePopup();
            };
            lay->addWidget(sw);
        }
        adjustSize();
    }

    // 选中颜色回调 / 关闭完成回调（触发按钮取消高亮）
    std::function<void(const QColor&)> onPick;
    std::function<void()> onClosed;

    bool isClosing() const { return m_closing; }

    // 关闭菜单（播放关闭动画，结束后触发 onClosed 通知按钮取消高亮）
    void closePopup()
    {
        if (m_closing)
            return;
        m_closing = true;
        qApp->removeEventFilter(this);
        if (m_inAnim) {
            m_inAnim->stop();
            m_inAnim = nullptr;
        }

        auto* posAnim = new QPropertyAnimation(this, "pos", this);
        posAnim->setDuration(160);
        posAnim->setStartValue(pos());
        posAnim->setEndValue(pos() + QPoint(28, 0));
        posAnim->setEasingCurve(QEasingCurve::InCubic);

        auto* opAnim = new QPropertyAnimation(m_effect, "opacity", this);
        opAnim->setDuration(160);
        opAnim->setStartValue(m_effect ? m_effect->opacity() : 1.0);
        opAnim->setEndValue(0.0);
        opAnim->setEasingCurve(QEasingCurve::InCubic);

        auto* group = new QParallelAnimationGroup(this);
        group->addAnimation(posAnim);
        group->addAnimation(opAnim);
        connect(group, &QParallelAnimationGroup::finished, this, [this]() {
            hide();
            if (onClosed)
                onClosed();   // 关闭完成，通知按钮取消高亮
        });
        group->start(QAbstractAnimation::DeleteWhenStopped);
    }

    // 析构时务必移除 qApp 事件过滤器，避免残留悬空过滤器导致崩溃
    ~ColorPickerPopup() override { qApp->removeEventFilter(this); }

    // 显示并播放"从按钮右侧向右滑入 + 淡入"；finalPos 为父控件（工具栏）内坐标
    void animateIn(const QPoint& finalPos)
    {
        qApp->installEventFilter(this);
        m_effect = new QGraphicsOpacityEffect(this);
        setGraphicsEffect(m_effect);
        move(finalPos + QPoint(28, 0));
        m_effect->setOpacity(0.0);
        show();
        raise();

        auto* posAnim = new QPropertyAnimation(this, "pos", this);
        posAnim->setDuration(220);
        posAnim->setStartValue(pos());
        posAnim->setEndValue(finalPos);
        posAnim->setEasingCurve(QEasingCurve::OutCubic);

        auto* opAnim = new QPropertyAnimation(m_effect, "opacity", this);
        opAnim->setDuration(220);
        opAnim->setStartValue(0.0);
        opAnim->setEndValue(1.0);
        opAnim->setEasingCurve(QEasingCurve::OutCubic);

        m_inAnim = new QParallelAnimationGroup(this);
        m_inAnim->addAnimation(posAnim);
        m_inAnim->addAnimation(opAnim);
        // 动画结束（自然完成或被 stop）即自动释放，并清空成员指针，
        // 防止 DeleteWhenStopped 释放后 m_inAnim 悬空导致下次 closePopup 闪退
        connect(m_inAnim, &QParallelAnimationGroup::finished, this,
                [this, anim = m_inAnim]() {
                    if (m_inAnim == anim)
                        m_inAnim = nullptr;
                });
        m_inAnim->start(QAbstractAnimation::DeleteWhenStopped);
    }

protected:
    bool eventFilter(QObject* obj, QEvent* e) override
    {
        // 点击弹层外部 → 关闭（事件继续传递给目标控件）；
        // 点击颜色按钮本身不关闭，交给按钮的开关（toggle）逻辑
        if (e->type() == QEvent::MouseButtonPress) {
            const QPoint gp = static_cast<QMouseEvent*>(e)->globalPosition().toPoint();
            const QWidget* hit = QApplication::widgetAt(gp);
            if (hit == m_ownerBtn || (hit && m_ownerBtn->isAncestorOf(hit)))
                return QWidget::eventFilter(obj, e);
            if (!rect().contains(mapFromGlobal(gp)))
                closePopup();
        }
        return QWidget::eventFilter(obj, e);
    }

private:
    QWidget* m_ownerBtn = nullptr;
    QParallelAnimationGroup* m_inAnim = nullptr;
    QGraphicsOpacityEffect* m_effect = nullptr;
    bool m_closing = false;
};

// ============================================================
// FontSizeRow —— 字号菜单中的单个行项
//   hover 浅灰平滑过渡（与 ToolButton 同款动画），按下微加深；
//   当前字号加粗显示，右侧绘制深灰对勾
// ============================================================
class FontSizeRow : public QWidget {
    Q_OBJECT
    Q_PROPERTY(qreal hoverProgress READ hoverProgress WRITE setHoverProgress)
    Q_PROPERTY(qreal pressProgress READ pressProgress WRITE setPressProgress)
public:
    FontSizeRow(int pt, QWidget* parent)
        : QWidget(parent), m_pt(pt)
    {
        setFixedHeight(30);
        setCursor(Qt::PointingHandCursor);
    }

    std::function<void(int)> onPick;

    int fontSize() const { return m_pt; }

    void setSelected(bool sel)
    {
        m_selected = sel;
        update();
    }

    qreal hoverProgress() const { return m_hover; }
    void setHoverProgress(qreal h) { m_hover = h; update(); }

    qreal pressProgress() const { return m_press; }
    void setPressProgress(qreal p) { m_press = p; update(); }

protected:
    void enterEvent(QEnterEvent* e) override { Q_UNUSED(e); animateHover(1.0); }
    void leaveEvent(QEvent* e) override { Q_UNUSED(e); animateHover(0.0); }
    void mousePressEvent(QMouseEvent* e) override { Q_UNUSED(e); animatePress(1.0); }
    void mouseReleaseEvent(QMouseEvent* e) override
    {
        animatePress(0.0);
        if (rect().contains(e->pos()) && onPick)
            onPick(m_pt);
    }
    void paintEvent(QPaintEvent*) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const QRectF rc = rect().adjusted(2, 1, -2, -1);
        p.setPen(Qt::NoPen);
        if (m_press > 0.0) {
            p.setBrush(QColor(0xE3, 0xE6, 0xEF, qRound(255 * m_press)));
            p.drawRoundedRect(rc, 5, 5);
        }
        if (m_hover > 0.0) {
            p.setBrush(QColor(0xF0, 0xF0, 0xF0, qRound(255 * m_hover)));
            p.drawRoundedRect(rc, 5, 5);
        }

        // 字号数值
        QFont f = font();
        f.setPixelSize(13);
        if (m_selected)
            f.setBold(true);
        p.setFont(f);
        p.setPen(QColor(0x2A, 0x2A, 0x2A));
        p.drawText(QRectF(14, 0, width() - 40, height()),
                   Qt::AlignLeft | Qt::AlignVCenter, QString::number(m_pt));

        // 当前字号右侧对勾
        if (m_selected) {
            p.setPen(QPen(QColor(0x2A, 0x2A, 0x2A), 1.8, Qt::SolidLine,
                          Qt::RoundCap, Qt::RoundJoin));
            const qreal cx = width() - 18;
            const qreal cy = height() / 2.0;
            QPainterPath path;
            path.moveTo(cx - 5, cy);
            path.lineTo(cx - 1.5, cy + 4);
            path.lineTo(cx + 6, cy - 4.5);
            p.drawPath(path);
        }
    }

private:
    void animateHover(qreal target)
    {
        auto* anim = new QPropertyAnimation(this, "hoverProgress", this);
        anim->setDuration(160);
        anim->setStartValue(m_hover);
        anim->setEndValue(target);
        anim->setEasingCurve(QEasingCurve::OutCubic);
        anim->start(QAbstractAnimation::DeleteWhenStopped);
    }
    void animatePress(qreal target)
    {
        auto* anim = new QPropertyAnimation(this, "pressProgress", this);
        anim->setDuration(120);
        anim->setStartValue(m_press);
        anim->setEndValue(target);
        anim->setEasingCurve(QEasingCurve::OutCubic);
        anim->start(QAbstractAnimation::DeleteWhenStopped);
    }

    int m_pt = 0;
    bool m_selected = false;
    qreal m_hover = 0.0;
    qreal m_press = 0.0;
};

// ============================================================
// FontSizeMenu —— 文字大小二级菜单（自定义弹层）
//   白底圆角面板 + 浅灰边框，垂直字号列表；
//   打开动画：从按钮位置向下滑入 + 淡入（OutCubic）；
//   关闭动画：向上收回 + 淡出；外部点击关闭
// ============================================================
class FontSizeMenu : public QWidget {
public:
    FontSizeMenu(QWidget* ownerBtn)
        // 必须挂到顶层窗口：菜单向下弹出会超出工具栏边界，
        // 若挂在工具栏上会被下方的编辑器区域遮挡
        : QWidget(ownerBtn->window()), m_ownerBtn(ownerBtn)
    {
        auto* lay = new QVBoxLayout(this);
        lay->setContentsMargins(4, 4, 4, 4);
        lay->setSpacing(0);
        const int sizes[] = {8, 10, 12, 14, 16, 18, 20, 24, 28, 32};
        for (int s : sizes) {
            auto* row = new FontSizeRow(s, this);
            row->onPick = [this](int pt) {
                if (onPick)
                    onPick(pt);
                closePopup();
            };
            lay->addWidget(row);
            m_rows.append(row);
        }
        setFixedWidth(100);
        adjustSize();
    }

    std::function<void(int)> onPick;
    std::function<void()> onClosed;

    bool isClosing() const { return m_closing; }

    // 勾选当前字号
    void setCurrent(int pt)
    {
        for (FontSizeRow* row : m_rows)
            row->setSelected(row->fontSize() == pt);
    }

    // 关闭（播放关闭动画，结束后触发 onClosed 通知按钮并释放）
    void closePopup()
    {
        if (m_closing)
            return;
        m_closing = true;
        qApp->removeEventFilter(this);
        if (m_inAnim) {
            m_inAnim->stop();
            m_inAnim = nullptr;
        }

        auto* posAnim = new QPropertyAnimation(this, "pos", this);
        posAnim->setDuration(150);
        posAnim->setStartValue(pos());
        posAnim->setEndValue(pos() + QPoint(0, -14));
        posAnim->setEasingCurve(QEasingCurve::InCubic);

        auto* opAnim = new QPropertyAnimation(m_effect, "opacity", this);
        opAnim->setDuration(150);
        opAnim->setStartValue(m_effect ? m_effect->opacity() : 1.0);
        opAnim->setEndValue(0.0);
        opAnim->setEasingCurve(QEasingCurve::InCubic);

        auto* group = new QParallelAnimationGroup(this);
        group->addAnimation(posAnim);
        group->addAnimation(opAnim);
        connect(group, &QParallelAnimationGroup::finished, this, [this]() {
            hide();
            if (onClosed)
                onClosed();
        });
        group->start(QAbstractAnimation::DeleteWhenStopped);
    }

    // 析构时务必移除 qApp 事件过滤器，避免残留悬空过滤器导致崩溃
    ~FontSizeMenu() override { qApp->removeEventFilter(this); }

    // 显示并播放"从按钮位置向下滑入 + 淡入"；finalPos 为父控件（工具栏）内坐标
    void animateIn(const QPoint& finalPos)
    {
        qApp->installEventFilter(this);
        m_effect = new QGraphicsOpacityEffect(this);
        setGraphicsEffect(m_effect);
        move(finalPos.x(), finalPos.y() - 14);
        m_effect->setOpacity(0.0);
        show();
        raise();

        auto* posAnim = new QPropertyAnimation(this, "pos", this);
        posAnim->setDuration(200);
        posAnim->setStartValue(pos());
        posAnim->setEndValue(finalPos);
        posAnim->setEasingCurve(QEasingCurve::OutCubic);

        auto* opAnim = new QPropertyAnimation(m_effect, "opacity", this);
        opAnim->setDuration(200);
        opAnim->setStartValue(0.0);
        opAnim->setEndValue(1.0);
        opAnim->setEasingCurve(QEasingCurve::OutCubic);

        m_inAnim = new QParallelAnimationGroup(this);
        m_inAnim->addAnimation(posAnim);
        m_inAnim->addAnimation(opAnim);
        // 动画结束（自然完成或被 stop）即自动释放，并清空成员指针，
        // 防止 DeleteWhenStopped 释放后 m_inAnim 悬空导致下次 closePopup 闪退
        connect(m_inAnim, &QParallelAnimationGroup::finished, this,
                [this, anim = m_inAnim]() {
                    if (m_inAnim == anim)
                        m_inAnim = nullptr;
                });
        m_inAnim->start(QAbstractAnimation::DeleteWhenStopped);
    }

protected:
    bool eventFilter(QObject* obj, QEvent* e) override
    {
        // 点击弹层外部 → 关闭（事件继续传递给目标控件）；
        // 点击文字大小按钮本身不关闭，交给 showFontSizeMenu 的开关（toggle）逻辑
        if (e->type() == QEvent::MouseButtonPress) {
            const QPoint gp = static_cast<QMouseEvent*>(e)->globalPosition().toPoint();
            const QWidget* hit = QApplication::widgetAt(gp);
            if (hit == m_ownerBtn || (hit && m_ownerBtn->isAncestorOf(hit)))
                return QWidget::eventFilter(obj, e);
            if (!rect().contains(mapFromGlobal(gp)))
                closePopup();
        }
        return QWidget::eventFilter(obj, e);
    }

    void paintEvent(QPaintEvent*) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setPen(QPen(QColor(0xE0, 0xE0, 0xE0), 1));
        p.setBrush(QColor(255, 255, 255));
        p.drawRoundedRect(rect().adjusted(0, 0, -1, -1), 8, 8);
    }

private:
    QWidget* m_ownerBtn = nullptr;
    QList<FontSizeRow*> m_rows;
    QParallelAnimationGroup* m_inAnim = nullptr;
    QGraphicsOpacityEffect* m_effect = nullptr;
    bool m_closing = false;
};

// ===================== 分割线感知编辑器 =====================
// QTextEdit 的 <hr/> 是一个块级元素（BlockTrailingHorizontalRulerWidth）。
// 若光标落入分割线块：鼠标点击/方向键都会让光标停在分割线上，
// 导致 (1) 输入的文字被加到分割线上方；(2) 在分割线块内按回车，
// 新块会继承分割线属性被重复绘制一条横线（看起来像没有换行）。
// 因此用子类把分割线块变成"光标禁区"：点击分割线时光标自动落到其下方，
// 每次按键输入/移动前后都确保光标不在分割线块内。
class DividerAwareTextEdit : public QTextEdit {
public:
    using QTextEdit::QTextEdit;

    // 是否为分割线块
    static bool isDividerBlock(const QTextBlock& b)
    {
        return b.blockFormat().hasProperty(QTextFormat::BlockTrailingHorizontalRulerWidth);
    }

    // 光标若在分割线块内，移到其下方的新行
    void escapeDividerBlock()
    {
        QTextCursor c = textCursor();
        if (!isDividerBlock(c.block()))
            return;
        const QTextBlock next = c.block().next();
        if (next.isValid())
            c.setPosition(next.position());      // 分割线下方的新行行首
        else
            c.movePosition(QTextCursor::End);    // 分割线是最后一块 → 文档末尾
        setTextCursor(c);
    }

    // 点击落在分割线块：光标重定向到其下方并消费事件；返回是否处理
    bool redirectDividerClick(QMouseEvent* event)
    {
        if (event->button() != Qt::LeftButton)
            return false;
        const QTextCursor target = cursorForPosition(event->pos());
        if (!isDividerBlock(target.block()))
            return false;
        QTextCursor c = textCursor();
        const QTextBlock next = target.block().next();
        if (next.isValid())
            c.setPosition(next.position());      // 分割线下方的新行行首
        else
            c.movePosition(QTextCursor::End);    // 分割线是最后一块 → 文档末尾
        setTextCursor(c);
        setFocus();                              // 点击被拦截后仍保证编辑器获得焦点
        event->accept();
        return true;
    }

protected:
    void keyPressEvent(QKeyEvent* event) override
    {
        escapeDividerBlock();               // 输入/移动前：确保不在分割线块内
        QTextEdit::keyPressEvent(event);
        escapeDividerBlock();               // 输入/移动后：方向键可能把光标移入分割线块
    }

    void mousePressEvent(QMouseEvent* event) override
    {
        if (redirectDividerClick(event))
            return;
        QTextEdit::mousePressEvent(event);
    }

    void mouseDoubleClickEvent(QMouseEvent* event) override
    {
        if (redirectDividerClick(event))
            return;
        QTextEdit::mouseDoubleClickEvent(event);
    }
};

// ===================== NoteEditor 实现 =====================

NoteEditor::NoteEditor(QWidget* parent)
    : QWidget(parent)
{
    auto* mainLay = new QVBoxLayout(this);
    mainLay->setContentsMargins(0, 0, 0, 0);
    mainLay->setSpacing(0);

    setupToolbar();

    m_editor = new DividerAwareTextEdit(this);
    m_editor->setObjectName(QStringLiteral("noteEdit"));
    // 使用自动隐藏细线滚动条（平时淡出，滚动/悬停时淡入）
    m_editor->setVerticalScrollBar(new AutoHideScrollBar(Qt::Vertical, m_editor));
    m_editor->installEventFilter(this);
    connect(m_editor, &QTextEdit::currentCharFormatChanged,
            this, &NoteEditor::updateFormatButtons);
    connect(m_editor, &QTextEdit::textChanged, this, &NoteEditor::onTextChanged);

    // 输入防抖保存：停止输入 500ms 后落盘
    m_debounceTimer = new QTimer(this);
    m_debounceTimer->setSingleShot(true);
    connect(m_debounceTimer, &QTimer::timeout, this, [this]() {
        if (m_dirty && !m_loading) {
            logSave(QStringLiteral("DEBOUNCE_FIRE"));
            if (saveCurrent())
                emit contentChanged(m_currentId);
        }
    });

    // 兜底自动保存：每 2s 检查一次，防抖被中断时也保证落盘
    m_autosaveTimer = new QTimer(this);
    m_autosaveTimer->setInterval(2000);
    connect(m_autosaveTimer, &QTimer::timeout, this, [this]() {
        if (m_dirty && !m_loading) {
            logSave(QStringLiteral("AUTOSAVE_FIRE"));
            if (saveCurrent())
                emit contentChanged(m_currentId);
        } else if (!m_dirty && !m_loading) {
            // 状态纠正保险：数据已落盘但顶部提示可能仍卡在"保存中"
            // （如 contentChanged 链路意外中断），周期性补发一次以恢复
            // "编辑"状态。updateNoteTitle/setNoteStatus 对相同文字
            // 直接返回，不会造成闪烁。
            emit contentChanged(m_currentId);
        }
    });
    m_autosaveTimer->start();

    mainLay->addWidget(m_toolbar);
    mainLay->addWidget(m_editor, 1);

    applyBackground();
}

void NoteEditor::setupToolbar()
{
    m_toolbar = new QWidget(this);
    m_toolbar->setObjectName(QStringLiteral("editorToolbar"));
    m_toolbar->setFixedHeight(30);

    auto* lay = new QHBoxLayout(m_toolbar);
    lay->setContentsMargins(8, 4, 8, 4);
    lay->setSpacing(4);

    // 简洁图标按钮：hover 极淡灰 rgba(170,170,170,0.062)、500ms 过渡、10px 圆角、
    // 无边框、不显示选中指示条（底部短横线动画）
    auto styleIconBtn = [](ToolButton* b) {
        b->setHoverColor(QColor(170, 170, 170, 16)); // 0.062*255 ≈ 16
        b->setHoverDuration(500);
        b->setCornerRadius(10);
        b->setIndicatorEnabled(false);
    };

    // 文字大小：SVG 图标按钮，点击弹出字号选择菜单
    m_sizeBtn = new ToolButton(m_toolbar);
    styleIconBtn(m_sizeBtn);
    m_sizeBtn->setCheckable(false);  // 瞬时按钮：点击弹出菜单，不进入选中态
    m_sizeBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/font-size.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
        .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_sizeBtn->setToolTip(QStringLiteral("文字大小"));
    m_sizeBtn->setFixedSize(24, 20);
    connect(m_sizeBtn, &ToolButton::clicked, this, &NoteEditor::showFontSizeMenu);
    lay->addWidget(m_sizeBtn);

    // 分隔线（竖向）：与图标大小（24px）匹配的短竖线，颜色加深以便看清
    auto addSep = [&]() {
        auto* sep = new QFrame(m_toolbar);
        sep->setFrameShape(QFrame::VLine);
        sep->setFixedWidth(1);
        sep->setFixedHeight(18);
        sep->setStyleSheet(QStringLiteral("color: #A0A0A0;"));
        lay->addWidget(sep);
    };
    addSep();

    // 粗体：SVG 图标按钮
    m_boldBtn = new ToolButton(m_toolbar);
    styleIconBtn(m_boldBtn);
    m_boldBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/bold.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
        .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_boldBtn->setToolTip(QStringLiteral("粗体"));
    m_boldBtn->setFixedSize(24, 20);
    connect(m_boldBtn, &ToolButton::toggled, this, &NoteEditor::onBoldToggled);
    lay->addWidget(m_boldBtn);

    // 下划线：SVG 图标按钮
    m_underlineBtn = new ToolButton(m_toolbar);
    styleIconBtn(m_underlineBtn);
    m_underlineBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/underline.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
        .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_underlineBtn->setToolTip(QStringLiteral("下划线"));
    m_underlineBtn->setFixedSize(24, 20);
    connect(m_underlineBtn, &ToolButton::toggled, this, &NoteEditor::onUnderlineToggled);
    lay->addWidget(m_underlineBtn);

    // 删除线：SVG 图标按钮
    m_strikeBtn = new ToolButton(m_toolbar);
    styleIconBtn(m_strikeBtn);
    m_strikeBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/strikethrough.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
        .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_strikeBtn->setToolTip(QStringLiteral("删除线"));
    m_strikeBtn->setFixedSize(24, 20);
    connect(m_strikeBtn, &ToolButton::toggled, this, &NoteEditor::onStrikeToggled);
    lay->addWidget(m_strikeBtn);

    // 分割线：在光标所在位置插入一条适配界面宽度的水平分割线（SVG 图标）
    m_hrBtn = new ToolButton(m_toolbar);
    styleIconBtn(m_hrBtn);
    m_hrBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/divider.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
        .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_hrBtn->setToolTip(QStringLiteral("插入分割线"));
    m_hrBtn->setFixedSize(24, 20);
    m_hrBtn->setCheckable(false);  // 分割线是瞬时按钮：点击一次插入一次，不进入选中态（无蓝色高亮）
    connect(m_hrBtn, &ToolButton::clicked, this, &NoteEditor::onInsertHr);
    lay->addWidget(m_hrBtn);

    addSep();

    // 文字颜色：调色盘图标（icons），与其他工具栏图标同色，自绘 hover 动画；瞬时按钮，不勾选
    m_colorBtn = new ToolButton(m_toolbar);
    styleIconBtn(m_colorBtn);
    m_colorBtn->setCheckable(false);
    m_colorBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/palette.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
                            .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_colorBtn->setToolTip(QStringLiteral("文字颜色"));
    m_colorBtn->setFixedSize(24, 20);
    connect(m_colorBtn, &ToolButton::clicked, this, &NoteEditor::onColorClicked);
    lay->addWidget(m_colorBtn);

    lay->addStretch();

    addSep();

    // 背景切换：纯白色块（自绘）
    m_bgWhiteBtn = new ToolButton(m_toolbar);
    m_bgWhiteBtn->setSwatch(QColor(Qt::white));
    m_bgWhiteBtn->setToolTip(QStringLiteral("纯白背景"));
    m_bgWhiteBtn->setFixedSize(24, 20);
    m_bgWhiteBtn->setChecked(true);
    connect(m_bgWhiteBtn, &ToolButton::clicked, this, [this]() {
        setBackground(0);
        m_bgWhiteBtn->setChecked(true);
        m_bgYellowBtn->setChecked(false);
    });
    lay->addWidget(m_bgWhiteBtn);

    // 背景切换：纸张黄色块（自绘）
    m_bgYellowBtn = new ToolButton(m_toolbar);
    m_bgYellowBtn->setSwatch(QColor(255, 248, 231)); // #FFF8E7
    m_bgYellowBtn->setToolTip(QStringLiteral("纸张黄背景"));
    m_bgYellowBtn->setFixedSize(24, 20);
    connect(m_bgYellowBtn, &ToolButton::clicked, this, [this]() {
        setBackground(1);
        m_bgYellowBtn->setChecked(true);
        m_bgWhiteBtn->setChecked(false);
    });
    lay->addWidget(m_bgYellowBtn);

    // 回到笔记底部：SVG 图标按钮，使用"箭头-下滑"图标（带统一圆角方框），
    // 位于纸张黄背景按钮右侧，尺寸与其余工具按钮一致
    m_bottomBtn = new ToolButton(m_toolbar);
    m_bottomBtn->setCheckable(false);   // 瞬时按钮：点击一次跳到底部一次，不进入选中态
    m_bottomBtn->setIcon(SvgIconLoader::load(
        QStringLiteral(":/icons/arrow-down.svg"),
        QColor(0x25, 0x31, 0x4C), 20)
        .pixmap(QSize(20, 20), devicePixelRatioF()));
    m_bottomBtn->setToolTip(QStringLiteral("回到笔记底部"));
    m_bottomBtn->setFixedSize(24, 20);
    lay->addWidget(m_bottomBtn);
    connect(m_bottomBtn, &ToolButton::clicked, this, [this]() {
        // 点击后把光标移到文档末尾，滚动到可见并聚焦，方便继续输入
        QTextCursor c = m_editor->textCursor();
        c.movePosition(QTextCursor::End);
        m_editor->setTextCursor(c);
        m_editor->ensureCursorVisible();
        m_editor->setFocus();
    });
}

void NoteEditor::loadNote(const QString& id)
{
    // 取消挂起的防抖保存，防止旧笔记内容在新笔记名下被错误落盘
    if (m_debounceTimer)
        m_debounceTimer->stop();

    // 先保存当前笔记：编辑器内容实际归属 m_editingNoteId，不受 m_loading 影响。
    // 落盘失败时【不中断切换】——内容缓冲进待保存队列，由自动保存/防抖在后台
    // 重试（见 saveCurrent/flushPendingSaves），避免“点击其他笔记偶尔切换不了界面”。
    if (m_dirty && !m_editingNoteId.isEmpty()) {
        auto prev = NoteManager::instance().note(m_editingNoteId);
        if (prev) {
            if (NoteManager::instance().updateNote(
                    m_editingNoteId, prev->title, m_editor->toHtml(), m_background)) {
                logSave(QStringLiteral("SWITCH_SAVE ok id=%1").arg(m_editingNoteId));
                m_dirty = false;
                m_pendingSaves.remove(m_editingNoteId);
            } else {
                logSave(QStringLiteral("SWITCH_SAVE_FAIL id=%1 -> pending")
                            .arg(m_editingNoteId));
                m_pendingSaves[m_editingNoteId] = { m_editor->toHtml(), m_background };
            }
        } else {
            m_dirty = false;
        }
    }
    m_editingNoteId = id;

    const bool firstLoad = m_currentId.isEmpty();
    m_currentId = id;

    // 目标笔记若有未落盘的缓冲内容，保持脏标记，等待自动保存链路重试落盘
    if (m_pendingSaves.contains(id))
        m_dirty = true;

    // 中断可能仍在进行的切换动画，避免状态错乱
    if (m_fadeAnim) {
        m_fadeAnim->stop();
        m_fadeAnim = nullptr;
    }
    if (m_fadeEffect) {
        m_editor->setGraphicsEffect(nullptr); // 安装 nullptr 会删除原效果
        m_fadeEffect = nullptr;
    }

    // 动画期间保持 m_loading，防止中途触发保存中间态
    m_loading = true;

    if (firstLoad) {
        // 首次加载（或从空笔记切换）：不做淡出，直接换内容后淡入
        applyNoteContent();
        startFadeIn();
        return;
    }

    // 非首次：先快速淡出，再换内容，最后淡入
    m_fadeEffect = new QGraphicsOpacityEffect(m_editor);
    m_editor->setGraphicsEffect(m_fadeEffect);
    m_fadeEffect->setOpacity(1.0);

    auto* fadeOut = new QPropertyAnimation(m_fadeEffect, "opacity", this);
    m_fadeAnim = fadeOut;
    fadeOut->setDuration(180);
    fadeOut->setStartValue(1.0);
    fadeOut->setEndValue(0.0);
    fadeOut->setEasingCurve(QEasingCurve::OutCubic);
    connect(fadeOut, &QPropertyAnimation::finished, this, [this]() {
        // 淡出完成后替换内容（m_loading 仍为 true）
        applyNoteContent();
        startFadeIn();
    });
    fadeOut->start(QAbstractAnimation::DeleteWhenStopped);
}

void NoteEditor::applyNoteContent()
{
    // 存在未落盘的缓冲内容（上次切换时落盘失败）：优先显示最新内容，
    // 并保持脏标记等待自动保存链路重试落盘
    const auto it = m_pendingSaves.constFind(m_currentId);
    if (it != m_pendingSaves.constEnd()) {
        m_editor->setHtml(it->html);
        m_background = it->background;
        applyBackground();
        m_bgWhiteBtn->setChecked(m_background == 0);
        m_bgYellowBtn->setChecked(m_background == 1);
        return;
    }

    auto n = NoteManager::instance().note(m_currentId);
    if (n) {
        m_editor->setHtml(n->content);
        m_background = n->background;
        applyBackground();
        m_bgWhiteBtn->setChecked(m_background == 0);
        m_bgYellowBtn->setChecked(m_background == 1);
    } else {
        m_editor->clear();
        m_background = 0;
        applyBackground();
    }
}

void NoteEditor::startFadeIn()
{
    if (!m_fadeEffect) {
        m_fadeEffect = new QGraphicsOpacityEffect(m_editor);
        m_editor->setGraphicsEffect(m_fadeEffect);
    }
    m_fadeEffect->setOpacity(0.0);

    auto* fadeIn = new QPropertyAnimation(m_fadeEffect, "opacity", this);
    m_fadeAnim = fadeIn;
    fadeIn->setDuration(300);
    fadeIn->setStartValue(0.0);
    fadeIn->setEndValue(1.0);
    fadeIn->setEasingCurve(QEasingCurve::OutCubic);
    connect(fadeIn, &QPropertyAnimation::finished, this, &NoteEditor::finishLoading);
    fadeIn->start(QAbstractAnimation::DeleteWhenStopped);
}

void NoteEditor::finishLoading()
{
    m_fadeAnim = nullptr;
    // 移除透明度效果（setGraphicsEffect 会删除原效果对象）
    m_editor->setGraphicsEffect(nullptr);
    m_fadeEffect = nullptr;
    m_loading = false;
    updateFormatButtons();
}

bool NoteEditor::saveCurrent()
{
    // 先重试缓冲中其他笔记的未落盘内容（落盘成功即清除，失败保留下次再试）
    flushPendingSaves();

    if (m_currentId.isEmpty()) {
        logSave(QStringLiteral("SAVE_SKIP no-id"));
        return false;
    }
    if (m_loading) {
        logSave(QStringLiteral("SAVE_SKIP loading id=%1").arg(m_currentId));
        return false;
    }
    auto n = NoteManager::instance().note(m_currentId);
    if (!n) {
        logSave(QStringLiteral("SAVE_SKIP note-missing id=%1").arg(m_currentId));
        return false;
    }
    const bool ok = NoteManager::instance().updateNote(
        m_currentId, n->title, m_editor->toHtml(), m_background);
    if (ok) {
        m_dirty = false;
        m_pendingSaves.remove(m_currentId);
        logSave(QStringLiteral("SAVED id=%1 chars=%2")
                    .arg(m_currentId)
                    .arg(m_editor->toPlainText().length()));
    } else {
        // 落盘失败：缓冲最新内容并保持脏标记，由兜底定时器每 2s 重试
        m_dirty = true;
        m_pendingSaves[m_currentId] = { m_editor->toHtml(), m_background };
        logSave(QStringLiteral("SAVE_FAIL_KEEP_DIRTY id=%1 chars=%2")
                    .arg(m_currentId)
                    .arg(m_editor->toPlainText().length()));
    }
    return ok;
}

void NoteEditor::flushPendingSaves()
{
    for (auto it = m_pendingSaves.begin(); it != m_pendingSaves.end();) {
        auto n = NoteManager::instance().note(it.key());
        if (!n) {
            // 笔记已被删除：缓冲内容随之丢弃
            it = m_pendingSaves.erase(it);
            continue;
        }
        if (NoteManager::instance().updateNote(
                it.key(), n->title, it->html, it->background)) {
            logSave(QStringLiteral("PENDING_SAVED id=%1").arg(it.key()));
            it = m_pendingSaves.erase(it);
        } else {
            logSave(QStringLiteral("PENDING_RETRY id=%1").arg(it.key()));
            ++it; // 落盘仍失败：保留，等待下次重试
        }
    }
}

void NoteEditor::setBackground(int type)
{
    m_background = type;
    applyBackground();
    m_dirty = true;   // 背景也是笔记的一部分，置脏保证兜底保存
    saveCurrent();
}

void NoteEditor::applyBackground()
{
    // 纯白 or 类纸张黄 (#FFF8E7 类似旧纸张)
    if (m_background == 1) {
        m_editor->setStyleSheet(QStringLiteral(
            "QTextEdit#noteEdit { background-color: #FFF8E7; border: none; "
            "font-size: 10px; padding: 16px 20px; }"));
    } else {
        m_editor->setStyleSheet(QStringLiteral(
            "QTextEdit#noteEdit { background-color: #FFFFFF; border: none; "
            "font-size: 10px; padding: 16px 20px; }"));
    }
}

void NoteEditor::showFontSizeMenu()
{
    // 已打开：再次点击按钮 → 关闭菜单（开关切换）
    if (m_fontSizeMenu && m_fontSizeMenu->isVisible()) {
        m_fontSizeMenu->closePopup();
        m_fontSizeMenu = nullptr;
        return;
    }

    auto* popup = new FontSizeMenu(m_sizeBtn);
    m_fontSizeMenu = popup;
    popup->onPick = [this](int pt) { applyFontSize(pt); };
    popup->onClosed = [this, popup]() {
        if (m_fontSizeMenu == popup)
            m_fontSizeMenu = nullptr;
        popup->deleteLater();
    };
    popup->setCurrent(m_fontSize);
    // 菜单显示在按钮下方，贴住按钮底部（坐标为顶层窗口内坐标）
    popup->animateIn(m_sizeBtn->mapTo(window(),
                                      QPoint(0, m_sizeBtn->height() + 6)));
}

void NoteEditor::applyFontSize(int pt)
{
    m_fontSize = pt;
    QTextCharFormat fmt;
    fmt.setFontPointSize(pt);
    m_editor->textCursor().mergeCharFormat(fmt);
    m_editor->setFocus();
}

void NoteEditor::onBoldToggled(bool checked)
{
    QTextCharFormat fmt;
    fmt.setFontWeight(checked ? QFont::Bold : QFont::Normal);
    m_editor->textCursor().mergeCharFormat(fmt);
    m_editor->setFocus();
}

void NoteEditor::onUnderlineToggled(bool checked)
{
    QTextCharFormat fmt;
    fmt.setFontUnderline(checked);
    m_editor->textCursor().mergeCharFormat(fmt);
    m_editor->setFocus();
}

void NoteEditor::onStrikeToggled(bool checked)
{
    QTextCharFormat fmt;
    fmt.setFontStrikeOut(checked);
    m_editor->textCursor().mergeCharFormat(fmt);
    m_editor->setFocus();
}

void NoteEditor::onInsertHr()
{
    QTextCursor c = m_editor->textCursor();
    c.beginEditBlock();

    // 分割线独占一行：光标不在行首时，先把当前行在此处断开
    // （光标前的文字留在原行，分割线单独起一行，光标后的文字移到下方）
    if (!c.atBlockStart())
        c.insertBlock();

    // 插入水平分割线（块级元素，独占一行，自动适配界面宽度）
    c.insertHtml(QStringLiteral("<hr/>"));

    // 分割线下方自动新起一行，光标默认落在这条新行上。
    // 注意：不能用无参 insertBlock()——它会继承分割线所在块的格式，
    // 使新行/后续文字块带上 <hr> 属性，渲染时会被重复绘制一条横线；
    // 因此沿用当前块格式（保留对齐等设置）并清除 <hr> 属性后再插入新块。
    QTextBlockFormat bf = c.blockFormat();
    bf.clearProperty(QTextFormat::BlockTrailingHorizontalRulerWidth);
    c.insertBlock(bf);

    c.endEditBlock();

    // 关键：必须把修改后的光标同步回编辑器。
    // textCursor() 返回的是副本，endEditBlock 后编辑器真实光标仍停留在
    // 插入分割线前的位置（即分割线块内），导致：
    //   1) 光标与分割线重合显示；
    //   2) 输入文字被加到分割线上方；
    //   3) 按回车被 escapeDividerBlock 先"弹"到分割线下方，视觉上要按两次才换行。
    m_editor->setTextCursor(c);
    m_editor->setFocus();

    // ===== 滚动到分割线：插入后自动滚动，让分割线显示在视口上部 =====
    // 插入完成后，用户光标位于分割线下方的空行（后续输入位置），
    // 分割线就是光标所在块的上一块，通过 PreviousBlock 定位到分割线块。
    QTextCursor hrCursor = m_editor->textCursor();
    hrCursor.movePosition(QTextCursor::PreviousBlock);

    // cursorRect 返回分割线块在视口坐标系中的位置（top 为相对视口顶部的偏移）
    const QRect hrRect = m_editor->cursorRect(hrCursor);
    QScrollBar* vsb = m_editor->verticalScrollBar();

    // 分割线已经显示在视口上部（约 40px 以内）时无需滚动，避免无谓跳动；
    // 否则通过垂直滚动条滚动，使分割线位于视口顶部下方约 40px 处，
    // 下方新行（用户光标所在行）紧随其后，方便用户继续输入。
    if (hrRect.top() < 0 || hrRect.top() > 40) {
        // 滚动量 = 当前值 + 把分割线移到视口顶部下方 40px 处所需的偏移
        vsb->setValue(qMax(0, vsb->value() + (hrRect.top() - 40)));
    }
}

void NoteEditor::onColorClicked()
{
    // 已打开：再次点击按钮 → 关闭菜单并取消高亮（开关切换）
    if (m_colorPopup && m_colorPopup->isVisible()) {
        closeColorMenu();
        return;
    }

    m_colorBtn->setChecked(true);   // 高亮提示按钮已被点击

    auto* popup = new ColorPickerPopup(m_editor->textColor(), m_colorBtn);
    m_colorPopup = popup;
    popup->onPick = [this](const QColor& c) {
        QTextCharFormat fmt;
        fmt.setForeground(c);
        m_editor->textCursor().mergeCharFormat(fmt);
        m_editor->setFocus();
    };
    popup->onClosed = [this, popup]() {
        m_colorBtn->setChecked(false);   // 菜单关闭完成，取消高亮
        if (m_colorPopup == popup)
            m_colorPopup = nullptr;
        popup->deleteLater();
    };

    // 与按钮并列同一行：y 与按钮对齐，x 紧贴按钮右侧
    const QPoint btnPos = m_colorBtn->mapTo(m_toolbar, QPoint(0, 0));
    const QPoint finalPos(btnPos.x() + m_colorBtn->width() + 8, btnPos.y());
    popup->animateIn(finalPos);
}

void NoteEditor::closeColorMenu()
{
    if (m_colorPopup) {
        m_colorPopup->closePopup();  // 播放关闭动画，结束后 onClosed 会清指针并释放
        m_colorPopup = nullptr;      // 立即断开，防止关闭动画期间重复触发
    }
}

void NoteEditor::onTextChanged()
{
    if (m_loading)
        return;
    // 记录未落盘修改，通知主窗口显示"正在保存"，并重启防抖保存
    m_dirty = true;
    logSave(QStringLiteral("TEXT_CHANGED id=%1 chars=%2")
                .arg(m_currentId)
                .arg(m_editor->toPlainText().length()));
    emit textEdited();
    m_debounceTimer->start(500);
}

void NoteEditor::updateFormatButtons()
{
    const QTextCharFormat fmt = m_editor->currentCharFormat();

    // 阻断信号以避免回环
    QSignalBlocker b1(m_boldBtn), b2(m_underlineBtn), b3(m_strikeBtn);

    m_boldBtn->setChecked(fmt.fontWeight() >= QFont::Bold);
    m_underlineBtn->setChecked(fmt.fontUnderline());
    m_strikeBtn->setChecked(fmt.fontStrikeOut());

    const int pt = static_cast<int>(fmt.fontPointSize());
    if (pt > 0)
        m_fontSize = pt;  // 记录当前字号，弹出菜单时据此勾选
}

bool NoteEditor::eventFilter(QObject* obj, QEvent* event)
{
    // 失焦时自动保存（动画期间 m_loading 为 true，saveCurrent 会自动跳过）
    if (obj == m_editor && event->type() == QEvent::FocusOut) {
        saveCurrent();
    }
    return QWidget::eventFilter(obj, event);
}

// cpp 内定义的 Q_OBJECT 类（FontSizeRow）的 moc 代码，需在此包含
#include "NoteEditor.moc"
