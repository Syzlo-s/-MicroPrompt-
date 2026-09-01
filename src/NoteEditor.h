#ifndef NOTEEDITOR_H
#define NOTEEDITOR_H

#include <QWidget>
#include <QTextEdit>
#include <QString>
#include <QFont>
#include <QPixmap>
#include <QColor>
#include <QHash>

class QEnterEvent;
class QMouseEvent;
class QPaintEvent;
class QEvent;
class QPropertyAnimation;
class QGraphicsOpacityEffect;
class QTimer;
class ColorPickerPopup;
class FontSizeMenu;

/**
 * @brief 工具栏自绘按钮
 *
 * 支持两种内容形态：图标（SVG）、色块（背景切换）。
 * 默认透明背景，hover 浅灰 #EEF0F5；
 * 选中态用底部深灰圆角指示条表达（从中心向两侧生长，300ms OutCubic）；
 * 按下白色背景 + 白色发光阴影"笼罩"（径向渐变光晕，随按下进度淡入淡出）。
 * hover/press/check 均通过 QPropertyAnimation 平滑过渡，与 PinButton 模式一致。
 */
class ToolButton : public QWidget {
    Q_OBJECT
    Q_PROPERTY(qreal hoverProgress READ hoverProgress WRITE setHoverProgress)
    Q_PROPERTY(qreal pressProgress READ pressProgress WRITE setPressProgress)
    Q_PROPERTY(qreal checkProgress READ checkProgress WRITE setCheckProgress)
public:
    explicit ToolButton(QWidget* parent = nullptr);

    bool isChecked() const { return m_checked; }
    void setChecked(bool checked);

    // 是否可勾选（选中态显示底部指示条）；颜色按钮为瞬时按钮，置为 false
    void setCheckable(bool checkable) { m_checkable = checkable; }

    void setText(const QString& text);
    void setTextFont(const QFont& font);
    void setIcon(const QPixmap& icon);
    void setSwatch(const QColor& color);

    // hover 样式可配置：颜色（含透明度）/过渡时长/圆角
    void setHoverColor(const QColor& color) { m_hoverColor = color; }
    void setHoverDuration(int ms) { m_hoverDuration = ms; }
    void setCornerRadius(qreal r) { m_cornerRadius = r; }
    // 是否显示选中指示条（底部短横线动画）；设为 false 时选中无指示条
    void setIndicatorEnabled(bool enabled) { m_indicatorEnabled = enabled; }

    qreal hoverProgress() const { return m_hover; }
    void setHoverProgress(qreal h);

    qreal pressProgress() const { return m_press; }
    void setPressProgress(qreal p);

    qreal checkProgress() const { return m_checkProgress; }
    void setCheckProgress(qreal c);

signals:
    void clicked();
    void toggled(bool checked);

protected:
    void enterEvent(QEnterEvent* event) override;
    void leaveEvent(QEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void paintEvent(QPaintEvent* event) override;

private:
    void animateHover(qreal target);
    void animatePress(qreal target);
    void animateCheck(qreal target);

    bool m_checkable = true;
    bool m_checked = false;
    bool m_pressed = false;
    qreal m_hover = 0.0;
    qreal m_press = 0.0;
    qreal m_checkProgress = 0.0; // 选中指示条进度：0=隐藏, 1=完全展开
    QString m_text;
    QFont m_textFont;
    QPixmap m_icon;
    QColor m_swatch; // 有效时绘制色块
    QColor m_hoverColor = QColor(238, 240, 245); // #EEF0F5 默认 hover 浅灰
    int m_hoverDuration = 160;
    qreal m_cornerRadius = 6.0;
    bool m_indicatorEnabled = true; // 选中指示条开关（默认开启）
};

/**
 * @brief 右侧笔记编辑区
 *
 * 提供富文本编辑功能：字体大小、粗体、下划线、删除线、文字颜色。
 * 支持切换编辑区背景（纯白 / 类纸张黄）。
 * 切换笔记时编辑区播放"淡出 → 换内容 → 淡入"动画。
 * 切换前会先保存当前笔记；落盘失败不中断切换，内容缓冲进
 * m_pendingSaves，由自动保存/防抖/关闭链路在后台重试，保证数据不丢失。
 */
class NoteEditor : public QWidget {
    Q_OBJECT
public:
    explicit NoteEditor(QWidget* parent = nullptr);

    void loadNote(const QString& id);
    QString currentNoteId() const { return m_currentId; }
    bool saveCurrent();   // 返回是否真正执行了落盘保存（被跳过时返回 false）

    void setBackground(int type);  // 0=白, 1=黄

signals:
    void contentChanged(const QString& id);
    // 用户输入新文字（开始进入待保存状态）时触发
    void textEdited();

protected:
    bool eventFilter(QObject* obj, QEvent* event) override;

private slots:
    void onBoldToggled(bool checked);
    void onUnderlineToggled(bool checked);
    void onStrikeToggled(bool checked);
    void onInsertHr();
    void onColorClicked();
    void onTextChanged();
    void updateFormatButtons();

private:
    void setupToolbar();
    void applyBackground();
    void showFontSizeMenu();  // 弹出字号选择菜单（文字大小图标按钮）
    void applyFontSize(int pt);  // 应用字号到当前光标/选区
    void applyNoteContent();  // 加载 m_currentId 对应的内容（不处理动画）
    void startFadeIn();       // 淡入动画，结束后调用 finishLoading
    void finishLoading();     // 动画结束：复位 m_loading 并刷新格式按钮
    void closeColorMenu();    // 关闭文字颜色菜单并取消按钮高亮
    void flushPendingSaves(); // 重试所有缓冲的未落盘内容（由保存链路调用）

    QTextEdit* m_editor = nullptr;
    QWidget* m_toolbar = nullptr;
    ToolButton* m_sizeBtn = nullptr;     // 文字大小（SVG 图标，点击弹字号菜单）
    int m_fontSize = 10;                 // 当前字号（默认 10pt），菜单勾选用
    FontSizeMenu* m_fontSizeMenu = nullptr;  // 当前打开的文字大小菜单（无则空）
    ToolButton* m_boldBtn = nullptr;
    ToolButton* m_underlineBtn = nullptr;
    ToolButton* m_strikeBtn = nullptr;
    ToolButton* m_hrBtn = nullptr;         // 插入分割线按钮
    ToolButton* m_colorBtn = nullptr;
    ToolButton* m_bgWhiteBtn = nullptr;
    ToolButton* m_bgYellowBtn = nullptr;

    QString m_currentId;
    QString m_editingNoteId;   // 编辑器当前内容实际归属的笔记（切换动画期间与 m_currentId 不同）
    bool m_dirty = false;      // 有未落盘的修改
    int m_background = 0;
    bool m_loading = false;

    // 未落盘内容缓冲：切换笔记时落盘失败的内容暂存于此，
    // 由自动保存/防抖/关闭链路在后台重试，保证切换不中断且数据不丢失
    struct PendingSave {
        QString html;
        int background = 0;
    };
    QHash<QString, PendingSave> m_pendingSaves;

    QTimer* m_debounceTimer = nullptr;  // 输入防抖（500ms 后保存）
    QTimer* m_autosaveTimer = nullptr;  // 兜底自动保存（每 2s 检查脏标记）

    QGraphicsOpacityEffect* m_fadeEffect = nullptr;  // 切换动画用的透明度效果
    QPropertyAnimation* m_fadeAnim = nullptr;        // 当前运行中的切换动画
    ColorPickerPopup* m_colorPopup = nullptr;        // 当前打开的文字颜色菜单（无则空）
    ToolButton* m_bottomBtn = nullptr;               // 工具栏"回到笔记底部"图标按钮
};

#endif // NOTEEDITOR_H
