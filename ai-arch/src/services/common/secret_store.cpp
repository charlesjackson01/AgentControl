#include "secret_store.h"
#include <QDir>
#include <QFile>
#include <QFileInfo>

namespace aiarch {

SecretStore::SecretStore(const QString &dir) : m_dir(dir)
{
}

QString SecretStore::m_path(const QString &name) const
{
    // only [A-Za-z0-9._-] in file names (no path traversal); refs like
    // "ai-arch/endpoint-key" (KWallet folder/key form) are sanitized
    if (m_dir.isEmpty() || name.isEmpty())
        return QString();
    QString n;
    for (const QChar &c : name)
        n += (c.isLetterOrNumber() || c == '.' || c == '_' || c == '-') ? c : QChar('_');
    return m_dir + "/" + n;
}

bool SecretStore::set(const QString &name, const QByteArray &value)
{
    const QString p = m_path(name);
    if (p.isEmpty())
        return false;
    QDir().mkpath(m_dir);
    QFile f(p);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    f.write(value);
    f.close();
    return QFile::setPermissions(p, QFile::ReadOwner | QFile::WriteOwner);
}

QByteArray SecretStore::get(const QString &name) const
{
    const QString p = m_path(name);
    if (p.isEmpty())
        return {};
    QFile f(p);
    if (!f.open(QIODevice::ReadOnly))
        return {};
    const QByteArray v = f.readAll().trimmed();
    f.close();
    return v;
}

bool SecretStore::remove(const QString &name)
{
    const QString p = m_path(name);
    if (p.isEmpty())
        return false;
    return QFile::remove(p);
}

bool SecretStore::contains(const QString &name) const
{
    const QString p = m_path(name);
    return !p.isEmpty() && QFileInfo::exists(p);
}

} // namespace aiarch
