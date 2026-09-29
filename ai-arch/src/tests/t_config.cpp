#include <QtTest>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include "aiarch_config.h"
#include "aiarch_paths.h"

using namespace aiarch;

class TConfig : public QObject
{
    Q_OBJECT
private slots:
    void deepMergeNested();
    void legacyFallbackMapping();
    void userOverridesDistro();
    void validateRejectsBadUrl();
    void validateRejectsBadPermissionMode();
    void toJsonRoundTrip();
    void envOverrides();
};

void TConfig::deepMergeNested()
{
    QJsonObject base, over;
    QJsonObject e1, e2;
    e1["url"] = "http://a";
    e1["model"] = "m1";
    e2["model"] = "m2";
    base["endpoint"] = e1;
    over["endpoint"] = e2;
    over["ai_enabled"] = false;
    const QJsonObject m = AiArchConfig::deepMerge(base, over);
    QCOMPARE(m["endpoint"].toObject().value("url").toString(), QStringLiteral("http://a"));
    QCOMPARE(m["endpoint"].toObject().value("model").toString(), QStringLiteral("m2"));
    QCOMPARE(m["ai_enabled"].toBool(), false);
}

void TConfig::legacyFallbackMapping()
{
    qputenv("AIARCH_USER_CONFIG", "/nonexistent/ai-arch.json");
    qputenv("AIARCH_DISTRO_CONFIG", "/nonexistent/xdg.json");
    const QJsonObject o;
    QJsonObject e;
    e["url"] = QStringLiteral("http://legacy");
    e["model"] = QStringLiteral("m");
    e["max_tokens_default"] = 512;
    QJsonObject m;
    m["endpoint"] = e;
    const AiArchConfig c = AiArchConfig::fromJson(m);
    QCOMPARE(c.endpoint.url, QStringLiteral("http://legacy"));
    QCOMPARE(c.endpoint.maxTokensDefault, quint32(512));
}

void TConfig::userOverridesDistro()
{
    const QString dir = QDir::tempPath() + QStringLiteral("/tconfig-")
                             + QString::number(QCoreApplication::applicationPid());
    QDir().mkpath(dir);
    const QString distro = dir + QStringLiteral("/distro.json");
    const QString user = dir + QStringLiteral("/user.json");
    QJsonObject d;
    QJsonObject de;
    de["url"] = QStringLiteral("http://distro");
    de["model"] = QStringLiteral("dm");
    d["endpoint"] = de;
    QFile f(distro);
    f.open(QIODevice::WriteOnly);
    f.write(QJsonDocument(d).toJson());
    f.close();

    QJsonObject u;
    QJsonObject ue;
    ue["model"] = QStringLiteral("um");
    u["endpoint"] = ue;
    f.setFileName(user);
    f.open(QIODevice::WriteOnly);
    f.write(QJsonDocument(u).toJson());
    f.close();

    qputenv("AIARCH_DISTRO_CONFIG", distro.toUtf8());
    qputenv("AIARCH_USER_CONFIG", user.toUtf8());
    const AiArchConfig c = AiArchConfig::load();
    QCOMPARE(c.endpoint.url, QStringLiteral("http://distro"));
    QCOMPARE(c.endpoint.model, QStringLiteral("um"));
    qunsetenv("AIARCH_DISTRO_CONFIG");
    qunsetenv("AIARCH_USER_CONFIG");
}

void TConfig::validateRejectsBadUrl()
{
    QJsonObject o;
    QJsonObject e;
    e["url"] = QStringLiteral("ftp://nope");
    o["endpoint"] = e;
    QString err;
    QVERIFY(!AiArchConfig::validate(o, &err));
    QVERIFY(!err.isEmpty());
}

void TConfig::validateRejectsBadPermissionMode()
{
    QJsonObject o;
    QJsonObject p, defs;
    defs["readonly"] = QStringLiteral("maybe");
    p["defaults"] = defs;
    o["permissions"] = p;
    QString err;
    QVERIFY(!AiArchConfig::validate(o, &err));
    QVERIFY(AiArchConfig::validate(QJsonObject(), &err));
}

void TConfig::toJsonRoundTrip()
{
    AiArchConfig c;
    c.aiEnabled = false;
    c.endpoint.url = QStringLiteral("http://x");
    c.endpoint.model = QStringLiteral("m");
    c.privacy.logRetentionDays = 7;
    c.privacy.excludedPaths = { QStringLiteral("/a"), QStringLiteral("/b") };
    c.permissions.critical = QStringLiteral("ask");
    const AiArchConfig c2 = AiArchConfig::fromJson(c.toJson());
    QCOMPARE(c2.aiEnabled, false);
    QCOMPARE(c2.endpoint.url, c.endpoint.url);
    QCOMPARE(c2.privacy.logRetentionDays, qint32(7));
    QCOMPARE(c2.privacy.excludedPaths, c.privacy.excludedPaths);
    QCOMPARE(c2.permissions.critical, QStringLiteral("ask"));
}

void TConfig::envOverrides()
{
    const QString dir = QDir::tempPath() + QStringLiteral("/tconfig-env-")
                             + QString::number(QCoreApplication::applicationPid());
    QDir().mkpath(dir);
    const QString p = dir + QStringLiteral("/c.json");
    QJsonObject o;
    o["ai_enabled"] = false;
    QFile f(p);
    f.open(QIODevice::WriteOnly);
    f.write(QJsonDocument(o).toJson());
    f.close();
    qputenv("AIARCH_USER_CONFIG", p.toUtf8());
    qputenv("AIARCH_DISTRO_CONFIG", "/nonexistent/xdg.json");
    QCOMPARE(userConfigPath(), p);
    QCOMPARE(AiArchConfig::load().aiEnabled, false);
    qunsetenv("AIARCH_USER_CONFIG");
    qunsetenv("AIARCH_DISTRO_CONFIG");
}

QTEST_MAIN(TConfig)
#include "t_config.moc"
