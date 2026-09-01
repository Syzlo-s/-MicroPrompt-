#include "NoteManager.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStandardPaths>
#include <QStringList>
#include <QUuid>
#include <QDateTime>
#include <QCoreApplication>

// ============ 保存调试日志（已禁用：逐次写 save.log 会产生磁盘 I/O，拖慢键盘输入） ============
// 需要排查保存链路时，可恢复下方实现。
static void logSaveMgr(const QString& msg)
{
    Q_UNUSED(msg)
}

NoteManager& NoteManager::instance()
{
    // Meyers 单例：线程安全且遵循 RAII
    static NoteManager mgr;
    return mgr;
}

NoteManager::NoteManager()
{
    // 数据存储目录: %APPDATA%/MicroPrompt/MicroPrompt
    const QString baseDir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(baseDir);
    m_dataPath = baseDir + QDir::separator() + QStringLiteral("notes.json");

    // 软件更名（DesktopNotes → MicroPrompt）后自动迁移旧数据，避免历史笔记"消失"
    migrateLegacyData(baseDir);

    load();
}

// 软件更名后，将旧版本（DesktopNotes / DesktopNotesTest）存储目录中的历史数据
// 自动复制到新目录。仅在"新目录无数据、旧目录有数据"时执行，绝不覆盖新数据。
void NoteManager::migrateLegacyData(const QString& newBaseDir)
{
    // 新目录已有数据则跳过（用户在迁移前已新建过笔记）
    if (QFile::exists(m_dataPath))
        return;

    // 旧版本数据可能位于 %APPDATA%（Roaming）或 %LOCALAPPDATA%（Local），
    // 注意：QStandardPaths::GenericDataLocation 在 Windows 上返回 Local，
    // 而旧版本 AppDataLocation 实际落在 Roaming，因此直接用环境变量枚举。
    const QStringList legacyRoots = {
        qEnvironmentVariable("APPDATA")      + QStringLiteral("/DesktopNotes/DesktopNotes"),
        qEnvironmentVariable("LOCALAPPDATA") + QStringLiteral("/DesktopNotes/DesktopNotes"),
        qEnvironmentVariable("APPDATA")      + QStringLiteral("/DesktopNotesTest/DesktopNotes"),
        qEnvironmentVariable("LOCALAPPDATA") + QStringLiteral("/DesktopNotesTest/DesktopNotes"),
    };

    for (const QString& legacyDir : legacyRoots) {
        const QString legacyJson = legacyDir + QStringLiteral("/notes.json");
        if (!QFile::exists(legacyJson))
            continue;

        // 迁移主数据文件（只复制不删除旧文件，保证可回退）
        const bool ok = QFile::copy(legacyJson, m_dataPath);
        // 一并迁移 .bak 备份
        const QString legacyBak = legacyDir + QStringLiteral("/notes.json.bak");
        if (ok && QFile::exists(legacyBak))
            QFile::copy(legacyBak, newBaseDir + QStringLiteral("/notes.json.bak"));
        return;   // 只迁移第一个命中的旧目录
    }
}

QList<std::shared_ptr<Note>> NoteManager::notes() const
{
    return m_notes;
}

std::shared_ptr<Note> NoteManager::createNote()
{
    auto n = std::make_shared<Note>();
    n->id = QUuid::createUuid().toString(QUuid::WithoutBraces);
    n->title = QStringLiteral("新建笔记");
    n->content = QString();
    n->background = 0;
    n->color = 0;
    n->created = QDateTime::currentDateTime();
    n->modified = n->created;

    m_notes.prepend(n);
    save();
    emit noteAdded(n->id);
    return n;
}

bool NoteManager::deleteNote(const QString& id)
{
    for (int i = 0; i < m_notes.size(); ++i) {
        if (m_notes[i]->id == id) {
            m_notes.removeAt(i);
            save();
            emit noteDeleted(id);
            return true;
        }
    }
    return false;
}

std::shared_ptr<Note> NoteManager::note(const QString& id) const
{
    for (const auto& n : m_notes) {
        if (n->id == id)
            return n;
    }
    return nullptr;
}

bool NoteManager::updateNote(const QString& id, const QString& title,
                             const QString& content, int background)
{
    auto n = note(id);
    if (!n)
        return false;

    bool changed = false;
    if (n->title != title) { n->title = title; changed = true; }
    if (n->content != content) { n->content = content; changed = true; }
    if (n->background != background) { n->background = background; changed = true; }

    if (changed)
        n->modified = QDateTime::currentDateTime();
    else
        logSaveMgr(QStringLiteral("UPDATE_NO_CHANGE id=%1").arg(id));

    // 内容变化时落盘；无变化但上次落盘失败时强制补写。
    // 返回值 = 磁盘写入结果，调用方据此决定是否清除脏标记。
    if (changed || !m_lastSaveOk) {
        m_lastSaveOk = save();
        if (m_lastSaveOk && changed)
            emit noteUpdated(id);
    }
    return m_lastSaveOk;
}

bool NoteManager::updateNoteColor(const QString& id, int color)
{
    auto n = note(id);
    if (!n)
        return false;

    if (n->color == color)
        return true;   // 颜色未变化，无需落盘

    n->color = color;
    n->modified = QDateTime::currentDateTime();
    m_lastSaveOk = save();
    if (m_lastSaveOk)
        emit noteUpdated(id);
    return m_lastSaveOk;
}

void NoteManager::load()
{
    QFile file(m_dataPath);
    if (!file.open(QIODevice::ReadOnly))
        return;

    const QJsonDocument doc = QJsonDocument::fromJson(file.readAll());
    file.close();

    const QJsonArray arr = doc.array();
    m_notes.clear();
    for (const QJsonValue& val : arr) {
        const QJsonObject obj = val.toObject();
        auto n = std::make_shared<Note>();
        n->id = obj.value(QStringLiteral("id")).toString();
        n->title = obj.value(QStringLiteral("title")).toString();
        n->content = obj.value(QStringLiteral("content")).toString();
        n->background = obj.value(QStringLiteral("background")).toInt(0);
        n->color = obj.value(QStringLiteral("color")).toInt(0);
        n->created = QDateTime::fromString(obj.value(QStringLiteral("created")).toString(), Qt::ISODate);
        n->modified = QDateTime::fromString(obj.value(QStringLiteral("modified")).toString(), Qt::ISODate);
        if (n->id.isEmpty())
            n->id = QUuid::createUuid().toString(QUuid::WithoutBraces);
        m_notes.append(n);
    }
}

bool NoteManager::save()
{
    QJsonArray arr;
    for (const auto& n : m_notes) {
        QJsonObject obj;
        obj[QStringLiteral("id")] = n->id;
        obj[QStringLiteral("title")] = n->title;
        obj[QStringLiteral("content")] = n->content;
        obj[QStringLiteral("background")] = n->background;
        obj[QStringLiteral("color")] = n->color;
        obj[QStringLiteral("created")] = n->created.toString(Qt::ISODate);
        obj[QStringLiteral("modified")] = n->modified.toString(Qt::ISODate);
        arr.append(obj);
    }

    const QByteArray data = QJsonDocument(arr).toJson(QJsonDocument::Compact);
    const QString tmpPath = m_dataPath + QStringLiteral(".tmp");
    const QString bakPath = m_dataPath + QStringLiteral(".bak");

    bool ok = false;

    // 连续两次尝试：第一次失败（文件被占用/安全软件拦截）时，保留旧文件副本后重试
    for (int attempt = 0; attempt < 2 && !ok; ++attempt) {
        // 1) 写临时文件
        QFile tmp(tmpPath);
        if (!tmp.open(QIODevice::WriteOnly)) {
            logSaveMgr(QStringLiteral("ATOMIC_TMP_OPEN_FAIL attempt=%1 err=%2")
                           .arg(attempt).arg(tmp.errorString()));
            continue;
        }
        qint64 written = tmp.write(data);
        tmp.flush();
        tmp.close();
        if (written != data.size()) {
            logSaveMgr(QStringLiteral("ATOMIC_TMP_WRITE_SHORT attempt=%1 got=%2 want=%3")
                           .arg(attempt).arg(written).arg(data.size()));
            continue;
        }

        // 2) 读回校验：内容完全一致才算写入成功
        QFile verify(tmpPath);
        bool verifyOk = false;
        if (verify.open(QIODevice::ReadOnly)) {
            verifyOk = (verify.readAll() == data);
            verify.close();
        }
        if (!verifyOk) {
            logSaveMgr(QStringLiteral("ATOMIC_VERIFY_FAIL attempt=%1")
                           .arg(attempt));
            continue;
        }

        // 3) 备份旧文件，然后原子替换
        if (QFile::exists(m_dataPath)) {
            QFile::remove(bakPath);
            QFile::copy(m_dataPath, bakPath);
        }
        QFile::remove(m_dataPath);   // Windows 上 rename 无法覆盖已存在文件
        if (QFile::rename(tmpPath, m_dataPath)) {
            logSaveMgr(QStringLiteral("ATOMIC_SAVE ok bytes=%1 path=%2")
                           .arg(data.size()).arg(m_dataPath));
            ok = true;
            break;
        }

        // 4) 替换失败：尝试从备份恢复，再重试一轮
        logSaveMgr(QStringLiteral("ATOMIC_RENAME_FAIL attempt=%1 err=%2")
                       .arg(attempt).arg(QFile(m_dataPath).errorString()));
        if (QFile::exists(bakPath)) {
            QFile::copy(bakPath, m_dataPath);
        }
    }

    if (!ok) {
        // ---- 回退方案：临时文件机制不可用（如安全软件拦截 .tmp 写入）时，
        //      直接覆盖写原文件（与历史版本一致、经验证可行），保证数据不丢 ----
        logSaveMgr(QStringLiteral("FALLBACK_DIRECT_WRITE bytes=%1").arg(data.size()));
        if (QFile::exists(m_dataPath)) {
            QFile::remove(bakPath);
            QFile::copy(m_dataPath, bakPath);   // 保留一份旧文件副本，多一层保障
        }
        QFile file(m_dataPath);
        if (file.open(QIODevice::WriteOnly)) {
            const qint64 written = file.write(data);
            file.flush();
            file.close();
            if (written == data.size()) {
                logSaveMgr(QStringLiteral("FALLBACK_DIRECT ok bytes=%1 path=%2")
                               .arg(data.size()).arg(m_dataPath));
                ok = true;
            } else {
                logSaveMgr(QStringLiteral("FALLBACK_DIRECT_SHORT got=%1 want=%2")
                               .arg(written).arg(data.size()));
            }
        } else {
            logSaveMgr(QStringLiteral("FALLBACK_DIRECT_OPEN_FAIL err=%1")
                           .arg(file.errorString()));
        }
    }

    m_lastSaveOk = ok;
    if (!ok)
        logSaveMgr(QStringLiteral("SAVE_FAILED bytes=%1 path=%2")
                       .arg(data.size()).arg(m_dataPath));
    return ok;
}
