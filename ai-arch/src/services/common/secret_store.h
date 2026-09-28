#pragma once
#include <QByteArray>
#include <QString>

namespace aiarch {

// Foundation secret store: 0600 files under the secrets dir.
// The KWallet backend lands with Stage E behind this same interface
// (docs/SECURITY.md §8).
class SecretStore {
public:
    explicit SecretStore(const QString &dir);

    bool set(const QString &name, const QByteArray &value);
    QByteArray get(const QString &name) const;
    bool remove(const QString &name);
    bool contains(const QString &name) const;

private:
    QString m_path(const QString &name) const;
    QString m_dir;
};

} // namespace aiarch
