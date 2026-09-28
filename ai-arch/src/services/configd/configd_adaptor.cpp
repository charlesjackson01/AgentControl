#include "configd_adaptor.h"
#include "aiarch_paths.h"
#include "aiarch_db.h"
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QEventLoop>
#include <QTimer>
#include <QDateTime>
#include <QElapsedTimer>
#include <QDebug>

using namespace aiarch;

ConfigAdaptor::ConfigAdaptor(QObject *parent)
    : QObject(parent)
    , m_secrets(secretsDir())
{
}

void ConfigAdaptor::start()
{
    QDir().mkpath(dataDir());
    ensureAuditDb(auditDbPath());
    ensureUsageDb(usageDbPath());

    const bool userExisted = QFileInfo::exists(userConfigPath());
    m_cfg = AiArchConfig::load();

    if (!userExisted) {
        // first run: materialize the user file (distro defaults / legacy import)
        save(QStringLiteral("init"));
        audit(QStringLiteral("config.migrate"), QStringLiteral("applied"),
              userConfigPath(), QStringLiteral("first run: user config created from distro/legacy defaults"));
        m_migrated = true;
    }

    auto watch = [this]() {
        m_watcher.removePaths(m_watcher.files());
        m_watcher.addPath(userConfigPath());
        m_watcher.addPath(distroConfigPath());
    };
    connect(&m_watcher, &QFileSystemWatcher::fileChanged, this, &ConfigAdaptor::reloadExternal);
    connect(this, &ConfigAdaptor::fileReplaced, this, [this](const QString &p) {
        if (!m_watcher.files().contains(p))
            m_watcher.addPath(p);
    });
    watch();
}

void ConfigAdaptor::save(const QString &section)
{
    const QJsonDocument doc = QJsonDocument(m_cfg.toJson());
    const QString p = userConfigPath();
    QDir().mkpath(QFileInfo(p).absolutePath());
    const QString tmp = p + ".tmp";
    QFile f(tmp);
    if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) {
        qWarning() << "configd: cannot write" << tmp << f.errorString();
        return;
    }
    f.write(doc.toJson(QJsonDocument::Indented));
    f.close();
    QFile::remove(p);
    QFile::rename(tmp, p);
    emit fileReplaced(p);
    emit changed();
    emit changedSection(section);
}

void ConfigAdaptor::reloadExternal()
{
    // re-add paths: editors/writers often replace the inode
    for (const QString &p : { userConfigPath(), distroConfigPath() })
        if (!m_watcher.files().contains(p))
            m_watcher.addPath(p);

    const AiArchConfig fresh = AiArchConfig::load();
    if (fresh.toJson() == m_cfg.toJson())
        return;
    m_cfg = fresh;
    emit changed();
    emit changedSection(QStringLiteral("config"));
}

void ConfigAdaptor::audit(const QString &tool, const QString &decision,
                          const QString &detail, const QString &purpose)
{
    auditAppend(auditDbPath(), QStringLiteral("user"), tool, "{}", purpose, decision, detail);
}

void ConfigAdaptor::setAiEnabled(bool enabled)
{
    if (m_cfg.aiEnabled == enabled)
        return;
    m_cfg.aiEnabled = enabled;
    save(QStringLiteral("ai_enabled"));
    audit(QStringLiteral("config.ai_enabled"), enabled ? QStringLiteral("enabled")
                                                       : QStringLiteral("disabled"),
          QStringLiteral("kill switch"));
}

void ConfigAdaptor::setEndpoint(const QString &url, const QString &model)
{
    if (!url.isEmpty() && !url.startsWith("http://") && !url.startsWith("https://")) {
        qWarning() << "configd: invalid endpoint url" << url;
        return;
    }
    m_cfg.endpoint.url = url;
    if (!model.isEmpty())
        m_cfg.endpoint.model = model;
    save(QStringLiteral("endpoint"));
    audit(QStringLiteral("config.endpoint"), QStringLiteral("set"),
          QStringLiteral("url=%1 model=%2").arg(url, model));
}

void ConfigAdaptor::setApiKey(const QString &key)
{
    // key never logged, never stored in the config file (SECURITY.md §8)
    m_secrets.set(m_cfg.endpoint.apiKeyRef, key.toLatin1());
    audit(QStringLiteral("config.api_key"), QStringLiteral("set"),
          QStringLiteral("ref=%1").arg(m_cfg.endpoint.apiKeyRef));
}

void ConfigAdaptor::setPrivacy(const QString &section, const QDBusVariant &value)
{
    if (!AiArchConfig::validPrivacySections().contains(section)) {
        qWarning() << "configd: unknown privacy section" << section;
        return;
    }
    const QVariant v = value.variant();
    if (section == "prefer_local" && v.canConvert<bool>())
        m_cfg.privacy.preferLocal = v.toBool();
    else if (section == "log_retention_days" && v.canConvert<int>() && v.toInt() > 0)
        m_cfg.privacy.logRetentionDays = v.toInt();
    else if (section == "content_logging" && v.canConvert<bool>())
        m_cfg.privacy.contentLogging = v.toBool();
    else if (section == "excluded_paths" && v.canConvert<QStringList>())
        m_cfg.privacy.excludedPaths = v.toStringList();
    else {
        qWarning() << "configd: wrong type for privacy." << section;
        return;
    }
    save(QStringLiteral("privacy"));
    audit(QStringLiteral("config.privacy"), QStringLiteral("set"), section);
}

void ConfigAdaptor::setPermissionDefault(const QString &cls, const QString &mode)
{
    if (!AiArchConfig::validPermissionClasses().contains(cls)
        || !AiArchConfig::validPermissionModes().contains(mode)) {
        qWarning() << "configd: invalid permission default" << cls << mode;
        return;
    }
    if (cls == "readonly")
        m_cfg.permissions.readonly_ = mode;
    else if (cls == "low")
        m_cfg.permissions.low = mode;
    else if (cls == "sensitive")
        m_cfg.permissions.sensitive = mode;
    else
        m_cfg.permissions.critical = mode;
    save(QStringLiteral("permissions"));
    audit(QStringLiteral("config.permissions"), QStringLiteral("set"),
          QStringLiteral("%s=%s").arg(cls, mode));
}

QDBusArgument ConfigAdaptor::testEndpoint()
{
    int result = 1;
    QString model = m_cfg.endpoint.model;
    int latencyMs = -1;

    if (m_cfg.endpoint.url.isEmpty()) {
        result = 2; // not configured
    } else {
        QNetworkAccessManager nam;
        QNetworkRequest req(QUrl(m_cfg.endpoint.url + "/v1/models"));
        req.setTransferTimeout(5000);
        if (m_secrets.contains(QStringLiteral("endpoint-key")))
            req.setRawHeader("Authorization", "Bearer " + m_secrets.get("endpoint-key"));
        QNetworkReply *reply = nam.get(req);
        QEventLoop loop;
        QTimer timeout;
        timeout.setSingleShot(true);
        int code = -1;
        QObject::connect(reply, &QNetworkReply::finished, &loop, [&]() {
            code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            loop.quit();
        });
        QObject::connect(&timeout, &QTimer::timeout, &loop, [&]() { loop.quit(); });
        timeout.start(5500);
        QElapsedTimer t;
        t.start();
        loop.exec();
        latencyMs = static_cast<int>(t.elapsed());
        if (code == 200) {
            result = 0;
            const QJsonDocument doc = QJsonDocument::fromJson(reply->readAll());
            if (doc.isObject()) {
                const QJsonArray arr = doc.object().value("data").toArray();
                if (!arr.isEmpty() && arr.first().toObject().contains("id"))
                    model = arr.first().toObject().value("id").toString();
            }
        }
        reply->deleteLater();
    }

    QDBusArgument a;
    a << result << model << latencyMs;
    return a;
}

#include "configd_adaptor.moc"
