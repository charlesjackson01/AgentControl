// org.aiarch.AI service entry point (docs/AI-ARCHITECTURE.md §4.2).
#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusPendingCallWatcher>
#include <QDBusPendingReply>
#include <QDBusServiceWatcher>
#include <QEventLoop>
#include <QTimer>
#include <QVariant>
#include <QDebug>
#include "aid_adaptor.h"
#include "gateway.h"
#include "aiarch_config.h"
#include "aiarch_paths.h"

using namespace aiarch;

template <typename T>
static T busValue(const QVariantMap &m, const QString &key, const T &def)
{
    const QVariant v = m.value(key);
    return (v.isValid() && v.canConvert<T>()) ? v.value<T>() : def;
}

static AiArchConfig configFromBusMap(const QVariantMap &m)
{
    AiArchConfig c;
    c.version = busValue(m, "Version", 1);
    c.aiEnabled = busValue(m, "AiEnabled", true);
    c.endpoint.url = m.value("EndpointUrl").toString();
    c.endpoint.model = m.value("Model").toString();
    c.endpoint.apiKeyRef = busValue(m, "ApiKeyRef", QStringLiteral("ai-arch/endpoint-key"));
    c.endpoint.timeoutMs = busValue(m, "TimeoutMs", quint32(600000));
    c.endpoint.maxTokensDefault = busValue(m, "MaxTokensDefault", quint32(1024));
    c.privacy.preferLocal = busValue(m, "PreferLocal", true);
    c.privacy.logRetentionDays = busValue(m, "LogRetentionDays", qint32(30));
    c.privacy.contentLogging = busValue(m, "ContentLogging", false);
    c.privacy.excludedPaths = m.value("ExcludedPaths").toStringList();
    c.permissions.readonly_ = busValue(m, "PermDefaultReadonly", QStringLiteral("allow"));
    c.permissions.low = busValue(m, "PermDefaultLow", QStringLiteral("ask"));
    c.permissions.sensitive = busValue(m, "PermDefaultSensitive", QStringLiteral("ask"));
    c.permissions.critical = busValue(m, "PermDefaultCritical", QStringLiteral("confirm"));
    return c;
}

static bool fetchConfigFromConfigd(AiArchConfig *out)
{
    QDBusInterface cfg(QStringLiteral("org.aiarch.Config"),
                       QStringLiteral("/org/aiarch/Config"));
    if (!cfg.isValid())
        return false;
    QDBusPendingCall call = cfg.asyncCallWithArgumentList(
        QStringLiteral("GetAll"), { QVariant() });
    QDBusPendingCallWatcher watcher(call);
    QEventLoop loop;
    QTimer timeout;
    timeout.setSingleShot(true);
    QObject::connect(&timeout, &QTimer::timeout, &loop, &QEventLoop::quit);
    QObject::connect(&watcher, &QDBusPendingCallWatcher::finished, &loop, &QEventLoop::quit);
    timeout.start(1500);
    loop.exec();
    QDBusPendingReply<QVariantMap> reply(call);
    if (!watcher.isFinished() || reply.isError())
        return false;
    *out = configFromBusMap(reply.argumentAt(0).toMap());
    return true;
}

class ConfigChangedReceiver : public QObject
{
    Q_OBJECT
public:
    ConfigChangedReceiver(aiarch::Gateway *gw, QObject *parent = nullptr)
        : QObject(parent), m_gw(gw) {}

public slots:
    void changedSection(const QString &section);

private:
    aiarch::Gateway *m_gw;
};

void ConfigChangedReceiver::changedSection(const QString &section)
{
    if (section == QStringLiteral("endpoint") || section == QStringLiteral("ai_enabled")
        || section == QStringLiteral("privacy") || section == QStringLiteral("permissions")
        || section == QStringLiteral("reloaded")) {
        AiArchConfig c;
        if (!fetchConfigFromConfigd(&c))
            c = AiArchConfig::load();
        m_gw->applyConfig(c);
    }
}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("ai-arch"));
    QCoreApplication::setApplicationName(QStringLiteral("ai-arch-aid"));

    QDBusConnection bus = QDBusConnection::sessionBus();
    if (!bus.registerService(QStringLiteral("org.aiarch.AI")))
        return 0; // another instance owns the name (activation semantics)

    Gateway gw;
    gw.start();

    AiArchConfig cfg;
    if (!fetchConfigFromConfigd(&cfg)) {
        cfg = AiArchConfig::load();
        qInfo() << "configd not reachable; using file config";
    }
    gw.applyConfig(cfg);

    AidAdaptor adaptor(&gw, &gw);
    bus.registerObject(QStringLiteral("/org/aiarch/AI"), &gw);

    // follow config changes
    QDBusServiceWatcher configWatcher(QStringLiteral("org.aiarch.Config"), bus,
                                      QDBusServiceWatcher::WatchForRegistration);
    QObject::connect(&configWatcher, &QDBusServiceWatcher::serviceRegistered, &gw,
                     [&gw](const QString &name) {
                         if (name == QStringLiteral("org.aiarch.Config")) {
                             AiArchConfig c;
                             if (!fetchConfigFromConfigd(&c))
                                 c = AiArchConfig::load();
                             gw.applyConfig(c);
                         }
                     });

    ConfigChangedReceiver configChanged(&gw, &gw);
    QDBusConnection::sessionBus().connect(
        QStringLiteral("org.aiarch.Config"), QStringLiteral("/org/aiarch/Config"),
        QStringLiteral("org.aiarch.Config"), QStringLiteral("ChangedSection"),
        &configChanged, "changedSection");

    return app.exec();
}

#include "main.moc"
