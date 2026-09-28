#include <QtTest>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include "secret_store.h"

using namespace aiarch;

class TSecretStore : public QObject
{
    Q_OBJECT
private slots:
    void setGetRemove();
    void refSanitization();
    void permissions0600();
};

static QString tmpDir()
{
    const QString d = QDir::tempPath() + QStringLiteral("/tsecrets-")
                          + QString::number(QCoreApplication::applicationPid());
    QDir().mkpath(d);
    return d;
}

void TSecretStore::setGetRemove()
{
    const QString d = tmpDir() + QStringLiteral("/basic");
    SecretStore s(d);
    QVERIFY(!s.contains("k"));
    QVERIFY(s.set("k", "v"));
    QVERIFY(s.contains("k"));
    QCOMPARE(s.get("k"), QByteArray("v"));
    QVERIFY(s.remove("k"));
    QVERIFY(!s.contains("k"));
}

void TSecretStore::refSanitization()
{
    const QString d = tmpDir() + QStringLiteral("/san");
    SecretStore s(d);
    QVERIFY(s.set("ai-arch/endpoint-key", "secret123"));
    QCOMPARE(s.get("ai-arch/endpoint-key"), QByteArray("secret123"));
    // the file must exist flat inside the dir, not as a subpath
    QVERIFY(QFile::exists(d + "/ai-arch_endpoint-key"));
    QVERIFY(!QDir(d + "/ai-arch").exists());
}

void TSecretStore::permissions0600()
{
    const QString d = tmpDir() + QStringLiteral("/perm");
    SecretStore s(d);
    QVERIFY(s.set("perm-key", "x"));
    const auto p = QFileInfo(d + "/perm-key").permissions();
    QVERIFY(p & QFile::ReadOwner);
    QVERIFY(p & QFile::WriteOwner);
    QVERIFY(!(p & QFile::ReadGroup));
    QVERIFY(!(p & QFile::ReadOther));
}

QTEST_MAIN(TSecretStore)
#include "t_secretstore.moc"
