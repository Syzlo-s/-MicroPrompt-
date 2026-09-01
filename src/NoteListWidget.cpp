#include "NoteListWidget.h"
#include "NoteManager.h"
#include "AutoHideScrollBar.h"

#include <QLabel>
#include <QFrame>
#include <QHBoxLayout>
#include <QPropertyAnimation>
#include <QEasingCurve>
#include <QScrollArea>
#include <QSpacerItem>
#include <QMouseEvent>
#include <QContextMenuEvent>
#include <QPainter>
#include <QPainterPath>
#include <QFontMetrics>
#include <QImage>
#include <QPixmap>
#include <QEvent>
#include <QTimer>
#include <QApplication>
#include <QScreen>
#include <cmath>
#include <functional>
#include "SvgIconLoader.h"

// 笔记列表组固定高度（与布局参数 2/2 边距、4 间距共同决定列表几何）
static const int kCardHeight = 38;
// 悬停放大比例：hover 满时缩放 = 1.0（即原卡片满格大小），静止时 1/1.03 ≈ 0.9709
// （视觉略内缩），因此"放大后"正好填满卡片槽位，左右仅占用 2px 布局边距，绝不超出列表区域
static const qreal kHoverScale = 1.03;
// 悬停动画时长（毫秒）：要求响应极快，鼠标快速滑动时各组动画实时跟上
static const int kHoverMs = 100;
// 插卡选中动画时长（毫秒）
static const int kSelectMs = 220;
// 插卡右移像素：选中时左边界右移并同步收窄，右边缘保持贴住列表右边界
static const int kSelectOffset = 16;

// ============================================================
// 图标资源路径：icons 文件夹全部打包为 Qt 资源
// ============================================================
static QString iconPath(const QString& fileName)
{
    return QStringLiteral(":/icons/") + fileName;
}

// ============================================================
// 提示词卡片颜色方案（与 Note::color 对应）
//   机制：边框与提示词名称/时间日期【固定使用默认黑色样式】，
//   修改颜色只作用于【右侧渐变】（基色 + 最大透明度）。
//   0 = 黑色(默认): 渐变沿用原黑 15/255
//   1 = 红色: 渐变纯红 RGB(255,0,0)，最大透明度 15%（38/255）
//   2 = 蓝色: 渐变纯蓝 RGB(0,0,255)，最大透明度 15%（38/255）
// ============================================================
struct NoteColorScheme {
    int id;
    QString name;
    QColor gradient;
    int gradAlpha;
};

static const NoteColorScheme kNoteColors[] = {
    { 0, QStringLiteral("黑色"), QColor(0x00, 0x00, 0x00), 15 },
    { 1, QStringLiteral("红色"), QColor(0xFF, 0x00, 0x00), 38 },
    { 2, QStringLiteral("蓝色"), QColor(0x00, 0x00, 0xFF), 38 },
};

// 边框与文字颜色固定为默认黑色方案（不随 Note::color 变化）
static const QColor kCardBorder(0xE5, 0xE5, 0xE5);
static const QColor kCardTitle(0x3B, 0x3B, 0x3B);
static const QColor kCardDate(0x9A, 0x9A, 0x9A);

// 颜色越界时安全回退到黑色（默认）
static const NoteColorScheme& noteColorScheme(int color)
{
    for (const auto& s : kNoteColors) {
        if (s.id == color)
            return s;
    }
    return kNoteColors[0];
}

// ============================================================
// NoteListGroup —— 笔记列表组（边框 + 笔记名称 + 创建日期与时间）
// 三者深度绑定，全部由该控件自绘（paintEvent 用 QPainter 绘制边框和文字，
// 不再使用 QLabel 子控件），因此整体缩放/移动时所有元素同步运动
// ============================================================
class NoteListGroup : public QFrame {
    Q_OBJECT
    Q_PROPERTY(qreal hoverProgress READ hoverProgress WRITE setHoverProgress)
    Q_PROPERTY(qreal selectProgress READ selectProgress WRITE setSelectProgress)
    Q_PROPERTY(qreal selectOffset READ selectOffset WRITE setSelectOffset)
public:
    explicit NoteListGroup(const QString& noteId, QWidget* parent = nullptr)
        : QFrame(parent), m_id(noteId)
    {
        setFrameStyle(QFrame::NoFrame);
        setObjectName(QStringLiteral("noteListGroup"));
        setFixedHeight(kCardHeight);

        setCursor(Qt::PointingHandCursor);
    }

    void loadFromNote(const std::shared_ptr<Note>& n)
    {
        m_title = n->title;
        // 显示建立日期时间
        m_dateText = n->created.toString(QStringLiteral("yyyy-MM-dd HH:mm"));
        m_background = n->background;
        m_color = n->color;
        update();
    }

    void setSelected(bool sel)
    {
        if (sel == m_selected)
            return; // 状态未变化时直接返回，避免重复动画
        m_selected = sel;
        // 中止同组上一次进度/位移动画，避免快速连点时并发写同一属性造成抖动
        // （stop 保留进度当前值，新动画从其续接，不触发 finished 竞态）
        if (m_selectAnim) {
            m_selectAnim->stop();
            m_selectAnim->deleteLater();
            m_selectAnim = nullptr;
        }
        if (m_offsetAnim) {
            m_offsetAnim->stop();
            m_offsetAnim->deleteLater();
            m_offsetAnim = nullptr;
        }
        // 选中进度动画：选中 InCubic（慢到快）淡入深色 + 白字，取消 OutCubic（快到慢）淡回
        auto* a = new QPropertyAnimation(this, "selectProgress", this);
        a->setDuration(kSelectMs);
        a->setStartValue(m_selectProgress);
        a->setEndValue(sel ? 1.0 : 0.0);
        a->setEasingCurve(sel ? QEasingCurve::InCubic : QEasingCurve::OutCubic);
        connect(a, &QPropertyAnimation::finished, this, [this, a]() {
            if (m_selectAnim == a)
                m_selectAnim = nullptr;
            a->deleteLater();
        });
        m_selectAnim = a;
        a->start();

        // 插卡位移动画：选中 OutCubic（出发即加速，插入干脆）推出，
        // 取消 InCubic（慢到快）收回原位
        auto* oa = new QPropertyAnimation(this, "selectOffset", this);
        oa->setDuration(kSelectMs);
        oa->setStartValue(m_selectOffset);
        oa->setEndValue(sel ? 1.0 : 0.0);
        oa->setEasingCurve(sel ? QEasingCurve::OutCubic : QEasingCurve::InCubic);
        connect(oa, &QPropertyAnimation::finished, this, [this, oa]() {
            if (m_offsetAnim == oa)
                m_offsetAnim = nullptr;
            oa->deleteLater();
        });
        m_offsetAnim = oa;
        oa->start();
    }

    // 列表重建时使用：选中态直接置满进度，不重播动画
    void setSelectedImmediate(bool sel)
    {
        m_selected = sel;
        m_selectProgress = sel ? 1.0 : 0.0;
        m_selectOffset = sel ? 1.0 : 0.0;
        update();
    }

    QString id() const { return m_id; }

    qreal hoverProgress() const { return m_hoverProgress; }
    void setHoverProgress(qreal p) { m_hoverProgress = p; update(); }
    qreal selectProgress() const { return m_selectProgress; }
    void setSelectProgress(qreal p) { m_selectProgress = p; update(); }
    qreal selectOffset() const { return m_selectOffset; }
    void setSelectOffset(qreal p) { m_selectOffset = p; update(); }

signals:
    void selected(const QString& id);
    // 右键卡片：请求弹出上下文菜单（携带全局坐标）
    void contextMenuRequested(const QString& id, const QPoint& globalPos);

protected:
    void mousePressEvent(QMouseEvent* e) override
    {
        if (e->button() == Qt::LeftButton) {
            emit selected(m_id);
        }
        QFrame::mousePressEvent(e);
    }

    void contextMenuEvent(QContextMenuEvent* e) override
    {
        emit contextMenuRequested(m_id, e->globalPos());
    }

    void enterEvent(QEnterEvent* e) override
    {
        Q_UNUSED(e)
        // 悬停放大：快速滑动时 stop 保留当前值，新动画从当前值续接，实时跟上
        if (m_hoverAnim) {
            m_hoverAnim->stop();
            m_hoverAnim->deleteLater();
            m_hoverAnim = nullptr;
        }
        auto* a = new QPropertyAnimation(this, "hoverProgress", this);
        a->setDuration(kHoverMs);
        a->setStartValue(m_hoverProgress);
        a->setEndValue(1.0);
        a->setEasingCurve(QEasingCurve::OutCubic); // 进入：出发即加速，响应迅速
        connect(a, &QPropertyAnimation::finished, this, [this, a]() {
            if (m_hoverAnim == a)
                m_hoverAnim = nullptr;
            a->deleteLater();
        });
        m_hoverAnim = a;
        a->start();
    }

    void leaveEvent(QEvent* e) override
    {
        Q_UNUSED(e)
        if (m_hoverAnim) {
            m_hoverAnim->stop();
            m_hoverAnim->deleteLater();
            m_hoverAnim = nullptr;
        }
        auto* a = new QPropertyAnimation(this, "hoverProgress", this);
        a->setDuration(kHoverMs);
        a->setStartValue(m_hoverProgress);
        a->setEndValue(0.0);
        a->setEasingCurve(QEasingCurve::InCubic); // 离开：平缓开始，平滑收回
        connect(a, &QPropertyAnimation::finished, this, [this, a]() {
            if (m_hoverAnim == a)
                m_hoverAnim = nullptr;
            a->deleteLater();
        });
        m_hoverAnim = a;
        a->start();
    }

    void paintEvent(QPaintEvent*) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setRenderHint(QPainter::TextAntialiasing);

        const NoteColorScheme& scheme = noteColorScheme(m_color);   // 仅用于右侧渐变
        const QRectF wrect(rect());
        // hover 缩放：rest 时 1/1.03 ≈ 0.9709（视觉略内缩），hover 满时 1.0（= 原卡片满格大小）
        // 因此"放大后"= 原大小，正好填满卡片槽位，左右只占用 2px 布局边距，绝不超出列表区域
        const qreal scale = 1.0 / (1.0 + (kHoverScale - 1.0) * m_hoverProgress);
        // 插卡右移+收窄：左边界右移 offset 像素，宽度同步收窄，右边界保持贴住 widget 右缘
        const qreal off = kSelectOffset * m_selectOffset;
        QRectF base(wrect.left() + off, wrect.top(),
                    wrect.width() - off, wrect.height());

        p.save();
        p.translate(base.center());
        p.scale(scale, scale);
        p.translate(-base.center());

        // ① 边框：固定默认浅灰 #E5E5E5 / 1px（不随颜色方案变化）
        p.setPen(QPen(kCardBorder, 1));
        p.setBrush(Qt::NoBrush);
        p.drawRoundedRect(base, 15, 15);

        // ② 选中渐变：卡片右侧一段横向渐隐，
        //    颜色随提示词颜色方案（默认黑色），深浅度保持极淡（gradAlpha），
        //    靠列表右侧略深，向左延伸渐变并融入列表面板背景色（#FAFAFA），
        //    整体随选中进度淡入淡出
        if (m_selectProgress > 0.01) {
            const qreal kGradW = 120.0;   // 渐变跨度更宽，暗影覆盖更长、过渡更缓
            const int maxAlpha = qRound(scheme.gradAlpha * m_selectProgress); // 极淡的着色
            const int gw = qMax(2, qCeil(kGradW));
            const int gh = qMax(1, qCeil(base.height()));
            // 预渲染平滑渐变：连续曲线逐像素生成 + 有序抖动打散 8bit 色带，
            // 保证过渡平滑柔和、无折点无断层。
            // 注意：必须用【非预乘】格式 ARGB32 —— 若用 ARGB32_Premultiplied，
            // 纯红/纯蓝的 RGB 值（255）远大于透明度（15），预乘解析时数值越界，
            // 渐变会被错误渲染成黑色（黑色 RGB=0 预乘后仍为 0 才恰好正常）。
            QImage grad(gw, gh, QImage::Format_ARGB32);
            static const int bayer[4][4] = {
                { 0, 8, 2, 10 }, { 12, 4, 14, 6 },
                { 3, 11, 1, 9 }, { 15, 7, 13, 5 }
            };
            for (int y = 0; y < gh; ++y) {
                QRgb* line = reinterpret_cast<QRgb*>(grad.scanLine(y));
                for (int x = 0; x < gw; ++x) {
                    // 图像从左（透明）到右（深），drawImage 后深色落在卡片右侧
                    const qreal t = qreal(x) / qreal(gw - 1);
                    const qreal k = std::pow(t, 1.6); // 柔和缓升，暗影覆盖整个跨度
                    const qreal ideal = maxAlpha * k;
                    const qreal dith = (bayer[y & 3][x & 3] - 7.5) / 16.0;
                    const int a = qBound(0, qRound(ideal + dith), maxAlpha);
                    line[x] = qRgba(scheme.gradient.red(), scheme.gradient.green(),
                                    scheme.gradient.blue(), a);
                }
            }
            // 按卡片圆角路径裁剪，保证渐变只在卡片内、右侧圆角正确
            QPainterPath clip;
            clip.addRoundedRect(base, 15, 15);
            p.save();
            p.setClipPath(clip);
            p.drawImage(QRectF(base.right() - kGradW, base.top(),
                               kGradW, base.height()), grad);
            p.restore();
        }

        // ③ 文字（随组整体缩放，与边框深度绑定）：固定默认黑色样式，不随颜色方案变化
        //    横向排版：笔记标题在左、创建日期在右（同一行垂直居中）
        //    空间分配策略：优先保证标题完整显示 —— 标题始终占用自身完整宽度，
        //    日期只使用剩余空间；剩余空间不足容纳完整日期时，日期【整体渐隐】淡出，
        //    把宽度让给标题（不会逐字符省略）。
        const QColor titleColor = kCardTitle;
        const QColor dateColor = kCardDate;

        // 日期：pointSize 7，右对齐（右边距 14）
        QFont df = font();
        df.setPointSize(7);
        const QFontMetrics dfm(df);
        const int fullDateW = dfm.horizontalAdvance(m_dateText); // 完整日期宽度

        // 标题：pointSize 8 加粗，左边距 14
        QFont tf = font();
        tf.setPointSize(8);
        tf.setBold(true);
        const QFontMetrics tfm(tf);
        const int fullTitleW = tfm.horizontalAdvance(m_title); // 完整标题宽度（不压缩）

        // 可用总宽度 = 卡片宽 - 左右边距28 - 标题与日期间距8
        const qreal available = base.width() - 28.0 - 8.0;
        // 标题优先：标题占满完整宽度后，剩余空间才是日期的；
        // 剩余空间 ≥ 完整日期宽 → 日期全显；剩余空间趋近 0 → 日期整体淡出消失
        const qreal dateAlpha = qBound(0.0,
                                       (available - fullTitleW) / qreal(fullDateW),
                                       1.0);
        const qreal dateW = qreal(fullDateW) * dateAlpha; // 日期占位宽度随淡出收缩

        if (dateAlpha > 0.0) {
            QColor dc = dateColor;
            dc.setAlphaF(dateAlpha);
            p.setFont(df);
            p.setPen(dc);
            const QRectF dateRect(base.right() - 14 - dateW, base.top(),
                                  dateW, base.height());
            // 绘制完整日期（不做省略号裁剪），淡出阶段整段变透明
            p.drawText(dateRect, Qt::AlignRight | Qt::AlignVCenter, m_dateText);
        }

        // 标题：宽度 = 可用总宽 - 日期占位宽（日期淡出时宽度即时回收给标题）
        p.setFont(tf);
        p.setPen(titleColor);
        const QRectF titleRect(base.left() + 14, base.top(),
                               qMax(0.0, available - dateW),
                               base.height());
        // 仅当日期已完全淡出、标题仍放不下时，才做省略号兜底（最后手段）
        const QString elidedTitle =
            tfm.elidedText(m_title, Qt::ElideRight, int(titleRect.width()));
        p.drawText(titleRect, Qt::AlignLeft | Qt::AlignVCenter, elidedTitle);

        p.restore();
    }

private:
    QString m_id;
    QString m_title;
    QString m_dateText;
    int m_background = 0;
    int m_color = 0;
    qreal m_hoverProgress = 0.0;
    qreal m_selectProgress = 0.0;
    qreal m_selectOffset = 0.0;
    bool m_selected = false;
    QPropertyAnimation* m_hoverAnim = nullptr;   // 进行中的悬停放大动画
    QPropertyAnimation* m_selectAnim = nullptr;  // 进行中的选中进度动画
    QPropertyAnimation* m_offsetAnim = nullptr;  // 进行中的插卡位移动画
};

// ============================================================
// HeaderButton —— 头部图标按钮（自绘，hover/press 动画过渡）
// ============================================================
class HeaderButton : public QWidget {
    Q_OBJECT
    Q_PROPERTY(qreal hoverProgress READ hoverProgress WRITE setHoverProgress)
    Q_PROPERTY(qreal pressProgress READ pressProgress WRITE setPressProgress)
public:
    HeaderButton(const QIcon& icon, QWidget* parent = nullptr)
        : QWidget(parent), m_icon(icon)
    {
        setFixedSize(24, 24);
        setCursor(Qt::PointingHandCursor);
        setFocusPolicy(Qt::NoFocus);
    }

    qreal hoverProgress() const { return m_hover; }
    void setHoverProgress(qreal h) { m_hover = h; update(); }
    qreal pressProgress() const { return m_press; }
    void setPressProgress(qreal p) { m_press = p; update(); }

signals:
    void clicked();

protected:
    void paintEvent(QPaintEvent*) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setRenderHint(QPainter::SmoothPixmapTransform);

        // 按当前屏幕缩放比取高清图标位图（DPR 变化时重新生成）
        const qreal dpr = devicePixelRatioF();
        if (m_iconPix.isNull() || m_iconPix.devicePixelRatio() != dpr)
            m_iconPix = m_icon.pixmap(QSize(15, 15), dpr);

        const QRectF rc(rect());
        // 默认透明背景；hover 浅灰 #EEF0F5；按下更深 #E3E6EF
        const QColor hov(0xEE, 0xF0, 0xF5);
        const QColor prs(0xE3, 0xE6, 0xEF);
        // 按下进度在 hover 色与按下色之间插值
        QColor bg(hov.red()   + (prs.red()   - hov.red())   * m_press,
                  hov.green() + (prs.green() - hov.green()) * m_press,
                  hov.blue()  + (prs.blue()  - hov.blue())  * m_press);
        // 透明度按 hover 进度插值（透明 -> 浅灰）
        bg.setAlphaF(m_hover);
        p.setPen(Qt::NoPen);
        p.setBrush(bg);
        p.drawRoundedRect(rc, 6, 6);

        // 图标居中绘制（用逻辑尺寸布局，避免 DPR 放大后图标溢出/变模糊）
        const qreal lw = m_iconPix.width() / m_iconPix.devicePixelRatio();
        const qreal lh = m_iconPix.height() / m_iconPix.devicePixelRatio();
        // drawPixmap(QPointF, pixmap) 按自然逻辑尺寸 1:1 映射物理像素 → 清晰
        p.drawPixmap(QPointF(rc.center().x() - lw / 2.0,
                             rc.center().y() - lh / 2.0),
                     m_iconPix);
    }

    void mousePressEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton) {
            animateTo(1.0, "pressProgress");
            emit clicked();
        }
        QWidget::mousePressEvent(event);
    }

    void mouseReleaseEvent(QMouseEvent* event) override
    {
        if (event->button() == Qt::LeftButton) {
            animateTo(0.0, "pressProgress");
        }
        QWidget::mouseReleaseEvent(event);
    }

    void enterEvent(QEnterEvent* event) override
    {
        Q_UNUSED(event)
        animateTo(1.0, "hoverProgress");
    }

    void leaveEvent(QEvent* event) override
    {
        Q_UNUSED(event)
        animateTo(0.0, "hoverProgress");
        animateTo(0.0, "pressProgress"); // 离开时同时恢复按下状态
    }

private:
    void animateTo(qreal target, const char* property)
    {
        auto* anim = new QPropertyAnimation(this, property, this);
        anim->setDuration(160);
        anim->setEasingCurve(QEasingCurve::OutCubic); // 非线性平滑过渡
        anim->setStartValue(qstrcmp(property, "hoverProgress") == 0 ? m_hover : m_press);
        anim->setEndValue(target);
        anim->start(QAbstractAnimation::DeleteWhenStopped);
    }

    QIcon m_icon;
    QPixmap m_iconPix;
    qreal m_hover = 0.0;
    qreal m_press = 0.0;
};

// ============================================================
// NoteContextMenu —— 笔记卡片右键菜单（全自绘弹出面板，不用 QMenu）
//   · 白色圆角面板：圆角 10px、1px 浅灰边框（#E2E6EE）、右下角轻微自绘阴影
//     （完全自绘 + NoDropShadowWindowHint，规避系统菜单阴影导致的黑边/直角问题）
//   · 打开动画：淡入 + 自下方 10px 上浮，190ms OutCubic
//     （窗口位置固定，动画为面板在窗口内部上浮，杜绝移动窗口式动画的抖动）
//   · 结构：删除提示词 / 重命名 | 分隔线 | 更改提示词颜色(标题) | 黑/红/蓝
//   · 点击项后先 close 释放鼠标抓取，下一拍事件循环再执行动作，
//     避免弹出确认框/输入框时与 Popup 抓取冲突
// ============================================================
class NoteContextMenu : public QWidget {
    Q_OBJECT
    Q_PROPERTY(qreal popProgress READ popProgress WRITE setPopProgress)
public:
    NoteContextMenu(int currentColor, QWidget* parent = nullptr)
        : QWidget(parent)
    {
        setWindowFlags(Qt::Popup | Qt::FramelessWindowHint
                       | Qt::NoDropShadowWindowHint);
        setAttribute(Qt::WA_TranslucentBackground);
        setAttribute(Qt::WA_DeleteOnClose);
        setMouseTracking(true);
        setFocusPolicy(Qt::NoFocus);

        // ---- 构建菜单项 ----
        const QColor actGray(0x6B, 0x72, 0x80);       // 重命名铅笔
        const QColor hdrGray(0x8A, 0x8F, 0x99);       // 调色板/标题文字
        const QColor delRed(0xE0, 0x43, 0x43);        // 垃圾桶
        const QColor dotBlack(0x2F, 0x2F, 0x2F);      // 色点（显示色，渐变基色另算）
        const QColor dotRed(0xE0, 0x43, 0x43);
        const QColor dotBlue(0x3B, 0x6F, 0xE0);

        m_items << Item { Item::Action, QStringLiteral("删除提示词"),
                          ctxPixmap(QStringLiteral("shanchu.svg"), delRed, 14),
                          QColor(), -1, false };
        m_items << Item { Item::Action, QStringLiteral("重命名"),
                          ctxPixmap(QStringLiteral("pen.svg"), actGray, 14),
                          QColor(), -1, false };
        m_items << Item { Item::Separator, QString(), QPixmap(), QColor(), -1, false };
        m_items << Item { Item::Header, QStringLiteral("更改列表颜色"),
                          ctxPixmap(QStringLiteral("palette.svg"), hdrGray, 11),
                          QColor(), -1, false };
        m_items << Item { Item::ColorOption, QStringLiteral("黑色（默认）"),
                          QPixmap(), dotBlack, 0, currentColor == 0 };
        m_items << Item { Item::ColorOption, QStringLiteral("红色"),
                          QPixmap(), dotRed, 1, currentColor == 1 };
        m_items << Item { Item::ColorOption, QStringLiteral("蓝色"),
                          QPixmap(), dotBlue, 2, currentColor == 2 };

        // ---- 累计几何：每项占面板内一行 ----
        qreal y = 0.0;
        for (Item& it : m_items) {
            const qreal h = it.kind == Item::Separator ? kCtxSepH
                           : it.kind == Item::Header    ? kCtxHeaderH
                                                        : kCtxItemH;
            it.rect = QRectF(0.0, y, qreal(kCtxPanelW), h);
            y += h;
        }
        m_panelH = y;
        // 窗口 = 面板 + 右下阴影余量（左上紧贴，弹出位置即面板左上角）
        resize(kCtxPanelW + kCtxShadow, qCeil(m_panelH) + kCtxShadow);
    }

    // 设置三项动作回调（点击项后经事件循环下一拍调用，均按值捕获安全执行）
    void setActions(std::function<void()> onDelete,
                    std::function<void()> onRename,
                    std::function<void(int)> onColor)
    {
        m_onDelete = std::move(onDelete);
        m_onRename = std::move(onRename);
        m_onColor = std::move(onColor);
    }

    // 在全局坐标处弹出（自动夹回屏幕工作区）
    void popup(const QPoint& globalPos)
    {
        QScreen* scr = QApplication::screenAt(globalPos);
        if (!scr)
            scr = QApplication::primaryScreen();
        const QRect avail = scr ? scr->availableGeometry() : QRect();

        QPoint pos = globalPos;
        if (!avail.isNull()) {
            pos.setX(qBound(avail.left(), pos.x(), avail.right() + 1 - width()));
            pos.setY(qBound(avail.top(), pos.y(), avail.bottom() + 1 - height()));
        }

        move(pos);
        m_popProgress = 0.0;
        setWindowOpacity(0.0);
        show();

        // 上浮：面板在窗口内部自下而上滑入（窗口不动，动画无抖动）
        auto* rise = new QPropertyAnimation(this, "popProgress", this);
        rise->setDuration(kCtxAnimMs);
        rise->setStartValue(0.0);
        rise->setEndValue(1.0);
        rise->setEasingCurve(QEasingCurve::OutCubic);
        rise->start(QAbstractAnimation::DeleteWhenStopped);

        // 淡入
        auto* fade = new QPropertyAnimation(this, "windowOpacity", this);
        fade->setDuration(kCtxAnimMs);
        fade->setStartValue(0.0);
        fade->setEndValue(1.0);
        fade->setEasingCurve(QEasingCurve::OutCubic);
        fade->start(QAbstractAnimation::DeleteWhenStopped);
    }

    qreal popProgress() const { return m_popProgress; }
    void setPopProgress(qreal p) { m_popProgress = p; update(); }

protected:
    void paintEvent(QPaintEvent*) override
    {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.setRenderHint(QPainter::TextAntialiasing);
        p.setRenderHint(QPainter::SmoothPixmapTransform);

        const qreal rise = kCtxRise * (1.0 - m_popProgress);
        // 内缩 0.5 保证 1px 边框完整落在窗口内（半透明窗口边缘不裁剪）
        const QRectF panel(0.5, rise + 0.5, qreal(kCtxPanelW) - 1.0, m_panelH - 1.0);

        // ① 右下角轻微阴影：三层右下偏移的淡色圆角矩形叠加（先画，左上被面板覆盖）
        p.setPen(Qt::NoPen);
        const qreal shOff[3]  = { 1.0, 2.1, 3.4 };
        const int   shAlpha[3] = { 22, 13, 7 };
        for (int i = 0; i < 3; ++i) {
            p.setBrush(QColor(28, 34, 52, shAlpha[i]));
            p.drawRoundedRect(panel.translated(shOff[i] * 0.7, shOff[i]), 10, 10);
        }

        // ② 白色面板 + 1px 浅灰边框
        p.setBrush(QColor(0xFF, 0xFF, 0xFF));
        p.setPen(QPen(QColor(0xE2, 0xE6, 0xEE), 1.0));
        p.drawRoundedRect(panel, 10, 10);

        // ③ 菜单项
        QFont itemFont = font();
        itemFont.setPointSizeF(8.5);
        QFont hdrFont = font();
        hdrFont.setPointSizeF(8);

        for (int i = 0; i < m_items.size(); ++i) {
            const Item& it = m_items[i];
            const QRectF r = it.rect.translated(0.5, rise + 0.5);

            if (it.kind == Item::Separator) {
                p.setPen(QPen(QColor(0xEC, 0xEC, 0xEF), 1.0));
                p.drawLine(QPointF(10, r.center().y()),
                           QPointF(kCtxPanelW - 10, r.center().y()));
                continue;
            }

            const bool clickable = it.kind == Item::Action
                                || it.kind == Item::ColorOption;

            // 悬停高亮：浅灰圆角块
            if (clickable && i == m_hover) {
                p.setPen(Qt::NoPen);
                p.setBrush(QColor(0xEE, 0xF2, 0xF8));
                p.drawRoundedRect(r.adjusted(5, 2, -5, -2), 5, 5);
            }

            if (it.kind == Item::Header) {
                // 分区标题：灰色调色板小图标 + 浅灰说明文字（不可点击）
                drawPixmapCentered(p, it.icon, 10.0, r.center().y());
                p.setFont(hdrFont);
                p.setPen(QColor(0x8A, 0x8F, 0x99));
                p.drawText(r.adjusted(28, 0, -8, 0),
                           Qt::AlignLeft | Qt::AlignVCenter, it.text);
            } else if (it.kind == Item::Action) {
                drawPixmapCentered(p, it.icon, 8.0, r.center().y());
                p.setFont(itemFont);
                p.setPen(QColor(0x3B, 0x3B, 0x3B));
                p.drawText(r.adjusted(30, 0, -8, 0),
                           Qt::AlignLeft | Qt::AlignVCenter, it.text);
            } else {
                // 颜色项：圆点（当前色内画白色对勾）+ 文字
                const QPointF c(16.0, r.center().y());
                p.setPen(Qt::NoPen);
                p.setBrush(it.dot);
                p.drawEllipse(c, 5.0, 5.0);
                if (it.checked) {
                    QPainterPath ck;
                    ck.moveTo(c.x() - 2.5, c.y() + 0.1);
                    ck.lineTo(c.x() - 0.8, c.y() + 1.8);
                    ck.lineTo(c.x() + 2.7, c.y() - 2.0);
                    p.setPen(QPen(Qt::white, 1.4, Qt::SolidLine,
                                  Qt::RoundCap, Qt::RoundJoin));
                    p.setBrush(Qt::NoBrush);
                    p.drawPath(ck);
                }
                p.setFont(itemFont);
                p.setPen(QColor(0x3B, 0x3B, 0x3B));
                p.drawText(r.adjusted(30, 0, -8, 0),
                           Qt::AlignLeft | Qt::AlignVCenter, it.text);
            }
        }
    }

    void mouseMoveEvent(QMouseEvent* e) override
    {
        const int idx = hitIndex(e->position().toPoint());
        const bool clickable = idx >= 0
            && (m_items[idx].kind == Item::Action
                || m_items[idx].kind == Item::ColorOption);
        const int h = clickable ? idx : -1;
        if (h != m_hover) {
            m_hover = h;
            update();
        }
        setCursor(clickable ? Qt::PointingHandCursor : Qt::ArrowCursor);
    }

    void leaveEvent(QEvent*) override
    {
        if (m_hover != -1) {
            m_hover = -1;
            update();
        }
        unsetCursor();
    }

    void mousePressEvent(QMouseEvent* e) override
    {
        if (e->button() == Qt::RightButton) {
            close();   // 菜单内右键：直接关闭
            return;
        }
        if (e->button() != Qt::LeftButton) {
            QWidget::mousePressEvent(e);
            return;
        }

        const int idx = hitIndex(e->position().toPoint());
        if (idx < 0) {
            close();   // 点到面板外阴影空白：关闭
            return;
        }
        const Item& it = m_items[idx];
        if (it.kind != Item::Action && it.kind != Item::ColorOption)
            return;    // 分隔线/分区标题不响应

        // 先关闭释放 Popup 鼠标抓取，下一拍再执行动作（此时弹对话框无冲突）。
        // 回调按值拷贝，避免捕获 this（窗口随 close 销毁）。
        close();
        if (it.kind == Item::Action) {
            if (it.colorId == 0) {
                auto fn = m_onDelete;
                QTimer::singleShot(0, fn);
            } else {
                auto fn = m_onRename;
                QTimer::singleShot(0, fn);
            }
        } else {
            auto fn = m_onColor;
            const int c = it.colorId;
            QTimer::singleShot(0, [fn, c]() { fn(c); });
        }
    }

private:
    struct Item {
        enum Kind { Action, Separator, Header, ColorOption };
        Kind kind;
        QString text;
        QPixmap icon;    // Action/Header 图标
        QColor dot;      // ColorOption 圆点颜色
        int colorId;     // Action: 0=删除 1=重命名；ColorOption: Note::color
        bool checked;    // ColorOption: 是否当前颜色
        QRectF rect;     // 面板内行矩形
    };

    // 加载染色图标（按当前 DPR 取高清位图）
    QPixmap ctxPixmap(const QString& file, const QColor& color, int logical)
    {
        const QIcon ic = SvgIconLoader::load(iconPath(file), color, logical);
        return ic.pixmap(QSize(logical, logical), devicePixelRatioF());
    }

    // 以 (x, cy) 为左边界/垂直中心绘制图标（物理像素 1:1 映射，最清晰）
    static void drawPixmapCentered(QPainter& p, const QPixmap& pm,
                                   qreal x, qreal cy)
    {
        if (pm.isNull())
            return;
        const qreal lh = pm.height() / pm.devicePixelRatio();
        p.drawPixmap(QPointF(x, cy - lh / 2.0), pm);
    }

    // 命中检测：返回面板内命中的项下标（考虑打开动画期间的面板上浮偏移）
    int hitIndex(const QPoint& pos) const
    {
        const qreal rise = kCtxRise * (1.0 - m_popProgress);
        const qreal px = qreal(pos.x()) - 0.5;
        const qreal py = qreal(pos.y()) - rise - 0.5;
        if (px < 0.0 || px >= qreal(kCtxPanelW))
            return -1;
        for (int i = 0; i < m_items.size(); ++i) {
            if (py >= m_items[i].rect.top() && py < m_items[i].rect.bottom())
                return i;
        }
        return -1;
    }

    // ---- 尺寸/动画参数 ----
    static const int kCtxPanelW = 170;   // 面板宽（含 1px 边框）
    static const int kCtxItemH = 26;     // 功能项行高
    static const int kCtxHeaderH = 24;   // 分区标题行高
    static const int kCtxSepH = 9;       // 分隔线区高度
    static const int kCtxShadow = 6;     // 右/下阴影余量
    static const qreal kCtxRise;         // 打开上浮距离
    static const int kCtxAnimMs = 190;   // 打开动画时长

    QList<Item> m_items;
    qreal m_panelH = 0.0;
    qreal m_popProgress = 0.0;           // 打开动画进度（0 起始 → 1 就位）
    int m_hover = -1;                    // 当前悬停项
    std::function<void()> m_onDelete;
    std::function<void()> m_onRename;
    std::function<void(int)> m_onColor;
};

const qreal NoteContextMenu::kCtxRise = 10.0;

// ============================================================
// NoteListWidget
// ============================================================
NoteListWidget::NoteListWidget(QWidget* parent)
    : QWidget(parent)
{
    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    outer->setSpacing(0);

    // 标题栏：容器 + 左侧标题 + stretch + 新建/删除按钮
    auto* header = new QWidget(this);
    header->setFixedHeight(30);
    auto* headerLayout = new QHBoxLayout(header);
    headerLayout->setContentsMargins(0, 0, 8, 0);
    headerLayout->setSpacing(4);

    auto* titleLabel = new QLabel(QStringLiteral("  我的提示词"), header);
    titleLabel->setObjectName(QStringLiteral("listHeader"));
    // 垂直撑满容器，保证 qss 中 listHeader 的背景/下边框铺满标题区高度
    titleLabel->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Expanding);
    headerLayout->addWidget(titleLabel);
    headerLayout->addStretch();

    // 新建/删除按钮：与工具栏图标统一的深色（正常黑色），非彩色
    const QColor headIconColor(0x25, 0x31, 0x4C);

    auto* newBtn = new HeaderButton(
        SvgIconLoader::load(iconPath(QStringLiteral("chuangjian.svg")),
                            headIconColor, 24),
        header);
    newBtn->setToolTip(QStringLiteral("新建笔记"));
    headerLayout->addWidget(newBtn);

    auto* delBtn = new HeaderButton(
        SvgIconLoader::load(iconPath(QStringLiteral("shanchu.svg")),
                            headIconColor, 24),
        header);
    delBtn->setToolTip(QStringLiteral("删除当前笔记"));
    headerLayout->addWidget(delBtn);

    connect(newBtn, &HeaderButton::clicked, this, &NoteListWidget::newNoteRequested);
    connect(delBtn, &HeaderButton::clicked, this, &NoteListWidget::deleteNoteRequested);

    outer->addWidget(header);

    m_scroll = new QScrollArea(this);
    m_scroll->setWidgetResizable(true);
    m_scroll->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    // 使用自动隐藏细线滚动条（平时淡出，滚动/悬停时淡入）
    m_scroll->setVerticalScrollBar(new AutoHideScrollBar(Qt::Vertical, m_scroll));
    m_scroll->setFrameShape(QFrame::NoFrame);
    // 强制视口透明，保证容器透明背景透出
    m_scroll->viewport()->setAttribute(Qt::WA_NoSystemBackground, true);
    m_scroll->viewport()->setStyleSheet("background: transparent;");

    m_container = new QWidget;
    m_container->setAttribute(Qt::WA_NoSystemBackground, true); // 容器背景透明
    m_layout = new QVBoxLayout(m_container);
    // 左右边距 2px（为悬停放大预留空间，放大后正好填满槽位），上下仍 6px
    m_layout->setContentsMargins(2, 6, 2, 6);
    m_layout->setSpacing(4);
    m_layout->addStretch();

    m_scroll->setWidget(m_container);
    outer->addWidget(m_scroll);

    refresh();

    auto& mgr = NoteManager::instance();
    connect(&mgr, &NoteManager::noteAdded, this, [this](const QString&) { refresh(); });
    connect(&mgr, &NoteManager::noteDeleted, this, [this](const QString&) { refresh(); });
    connect(&mgr, &NoteManager::noteUpdated, this, [this](const QString&) { refresh(); });
}

void NoteListWidget::refresh()
{
    // 清空旧列表组
    QLayoutItem* item;
    while ((item = m_layout->takeAt(0)) != nullptr) {
        if (QWidget* w = item->widget()) {
            w->hide(); // 先隐藏，避免延迟删除期间与重建列表组叠加闪烁
            w->deleteLater();
        }
        delete item;
    }

    auto& mgr = NoteManager::instance();
    const auto notes = mgr.notes();

    for (const auto& n : notes) {
        auto* group = new NoteListGroup(n->id, m_container);
        group->loadFromNote(n);
        // 选中列表组直接置满进度，避免重建后重播动画
        group->setSelectedImmediate(n->id == m_selectedId);

        connect(group, &NoteListGroup::selected, this, [this](const QString& id) {
            setSelectedNote(id);
            emit noteSelected(id);
        });
        connect(group, &NoteListGroup::contextMenuRequested,
                this, &NoteListWidget::showContextMenu);

        m_layout->addWidget(group);
    }
    m_layout->addStretch();
}

void NoteListWidget::setSelectedNote(const QString& id)
{
    if (id == m_selectedId)
        return;

    NoteListGroup* oldCard = findCard(m_selectedId);
    NoteListGroup* newCard = findCard(id);
    m_selectedId = id;

    if (oldCard) oldCard->setSelected(false); // 旧组收回（插卡动画 + 深色淡出）
    if (newCard) {
        newCard->setSelected(true);           // 新组插出（插卡动画 + 深色淡入）
        m_scroll->ensureWidgetVisible(newCard, 0, 0);
    }
}

NoteListGroup* NoteListWidget::findCard(const QString& id) const
{
    for (int i = 0; i < m_layout->count(); ++i) {
        QLayoutItem* it = m_layout->itemAt(i);
        if (auto* group = qobject_cast<NoteListGroup*>(it ? it->widget() : nullptr)) {
            if (group->id() == id)
                return group;
        }
    }
    return nullptr;
}

void NoteListWidget::showContextMenu(const QString& id, const QPoint& globalPos)
{
    auto n = NoteManager::instance().note(id);
    if (!n)
        return;

    // 弹出自绘菜单：删除/重命名转发给 MainWindow 弹框处理；
    // 颜色直接落盘（noteUpdated 触发列表刷新，卡片渐变即时生效）
    auto* menu = new NoteContextMenu(n->color);
    menu->setActions(
        [this, id]() { emit noteDeleteRequested(id); },
        [this, id]() { emit noteRenameRequested(id); },
        [id](int color) { NoteManager::instance().updateNoteColor(id, color); });
    menu->popup(globalPos);
}

#include "NoteListWidget.moc"
