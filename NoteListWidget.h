#ifndef NOTELISTWIDGET_H
#define NOTELISTWIDGET_H

#include <QWidget>
#include <QScrollArea>
#include <QVBoxLayout>
#include <QString>
#include <memory>

class NoteListGroup;
struct Note;

/**
 * @brief 左侧笔记列表（浏览器式最小视图）
 *
 * 以笔记列表组形式展示所有笔记，每组显示标题和建立日期。
 * 点击列表组选中并通知编辑器加载对应笔记，选中组保持深色填充标识。
 */
class NoteListWidget : public QWidget {
    Q_OBJECT
public:
    explicit NoteListWidget(QWidget* parent = nullptr);

    void refresh();
    void setSelectedNote(const QString& id);

signals:
    void noteSelected(const QString& id);
    // 头部按钮触发：新建笔记 / 删除当前笔记
    void newNoteRequested();
    void deleteNoteRequested();
    // 右键菜单触发：删除指定笔记 / 重命名指定笔记（由 MainWindow 弹框处理）
    void noteDeleteRequested(const QString& id);
    void noteRenameRequested(const QString& id);

private:
    NoteListGroup* findCard(const QString& id) const;
    // 在全局坐标处弹出指定笔记的右键菜单
    void showContextMenu(const QString& id, const QPoint& globalPos);

    QScrollArea* m_scroll = nullptr;
    QWidget* m_container = nullptr;
    QVBoxLayout* m_layout = nullptr;
    QString m_selectedId;
};

#endif // NOTELISTWIDGET_H
