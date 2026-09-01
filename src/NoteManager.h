#ifndef NOTEMANAGER_H
#define NOTEMANAGER_H

#include <QObject>
#include <QList>
#include <QString>
#include <QDateTime>
#include <memory>

/**
 * @brief 单条笔记的数据结构
 */
struct Note {
    QString id;
    QString title;
    QString content;   // HTML 富文本内容
    int background;    // 0 = 纯白, 1 = 类纸张黄
    int color;         // 提示词卡片颜色: 0 = 黑色(默认), 1 = 红色, 2 = 蓝色
    QDateTime created;
    QDateTime modified;
};

/**
 * @brief 笔记数据管理器（单例）
 *
 * 负责笔记的增删改查与持久化存储。
 * 数据以 JSON 格式保存在用户 AppData 目录下。
 * 遵循 RAII 原则：构造时自动加载，析构时由 QObject 父子关系管理生命周期。
 */
class NoteManager : public QObject {
    Q_OBJECT
public:
    static NoteManager& instance();

    QList<std::shared_ptr<Note>> notes() const;
    std::shared_ptr<Note> createNote();
    bool deleteNote(const QString& id);
    std::shared_ptr<Note> note(const QString& id) const;
    // 更新笔记并落盘；返回是否成功写入（失败时调用方可保持脏标记等待重试）
    bool updateNote(const QString& id, const QString& title,
                    const QString& content, int background);
    // 仅更新提示词卡片颜色并落盘；返回是否成功写入
    bool updateNoteColor(const QString& id, int color);

    void load();
    // 原子保存（写临时文件→校验→替换）；返回是否成功写入磁盘
    bool save();

signals:
    void noteAdded(const QString& id);
    void noteDeleted(const QString& id);
    void noteUpdated(const QString& id);

private:
    NoteManager();
    Q_DISABLE_COPY(NoteManager)

    // 软件更名（DesktopNotes → MicroPrompt）后，将旧路径下的历史数据迁移到新目录
    void migrateLegacyData(const QString& newBaseDir);

    QList<std::shared_ptr<Note>> m_notes;
    QString m_dataPath;
    bool m_lastSaveOk = true;   // 最近一次落盘是否成功（驱动"无变化时是否补写"）
};

#endif // NOTEMANAGER_H
