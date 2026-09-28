#pragma once
#include <QObject>
#include <QDBusArgument>
#include <QDBusVariant>
#include <QFileSystemWatcher>
#include "aiarch_config.h"
#include "secret_store.h"

// org.aiarch.Config — configuration, kill switch, secrets intake
// (docs/AI-ARCHITECTURE.md §4.1). Sole writer of the user config file.
class ConfigAdaptor : public QObject
{
    Q_OBJECT
public:
    explicit ConfigAdaptor(QObject *parent = nullptr);

    // properties (docs: scalar for QML accessibility)
    Q_PROPERTY(bool AiEnabled READ aiEnabled NOTIFY changed)
    Q_PROPERTY(QString EndpointUrl READ endpointUrl NOTIFY changed)
    Q_PROPERTY(QString Model READ model NOTIFY changed)
    Q_PROPERTY(QString ApiKeyRef READ apiKeyRef NOTIFY changed)
    Q_PROPERTY(quint32 TimeoutMs READ timeoutMs NOTIFY changed)
    Q_PROPERTY(quint32 MaxTokensDefault READ maxTokensDefault NOTIFY changed)
    Q_PROPERTY(bool PreferLocal READ preferLocal NOTIFY changed)
    Q_PROPERTY(qint32 LogRetentionDays READ logRetentionDays NOTIFY changed)
    Q_PROPERTY(bool ContentLogging READ contentLogging NOTIFY changed)
    Q_PROPERTY(QStringList ExcludedPaths READ excludedPaths NOTIFY changed)
    Q_PROPERTY(QString PermDefaultReadonly READ permDefaultReadonly NOTIFY changed)
    Q_PROPERTY(QString PermDefaultLow READ permDefaultLow NOTIFY changed)
    Q_PROPERTY(QString PermDefaultSensitive READ permDefaultSensitive NOTIFY changed)
    Q_PROPERTY(QString PermDefaultCritical READ permDefaultCritical NOTIFY changed)
    Q_PROPERTY(int Version READ version NOTIFY changed)

    bool aiEnabled() const { return m_cfg.aiEnabled; }
    QString endpointUrl() const { return m_cfg.endpoint.url; }
    QString model() const { return m_cfg.endpoint.model; }
    QString apiKeyRef() const { return m_cfg.endpoint.apiKeyRef; }
    quint32 timeoutMs() const { return m_cfg.endpoint.timeoutMs; }
    quint32 maxTokensDefault() const { return m_cfg.endpoint.maxTokensDefault; }
    bool preferLocal() const { return m_cfg.privacy.preferLocal; }
    qint32 logRetentionDays() const { return m_cfg.privacy.logRetentionDays; }
    bool contentLogging() const { return m_cfg.privacy.contentLogging; }
    QStringList excludedPaths() const { return m_cfg.privacy.excludedPaths; }
    QString permDefaultReadonly() const { return m_cfg.permissions.readonly_; }
    QString permDefaultLow() const { return m_cfg.permissions.low; }
    QString permDefaultSensitive() const { return m_cfg.permissions.sensitive; }
    QString permDefaultCritical() const { return m_cfg.permissions.critical; }
    int version() const { return m_cfg.version; }

    aiarch::AiArchConfig config() const { return m_cfg; }
    QByteArray secret(const QString &ref) const { return m_secrets.get(ref); }

    void start(); // load + migrate + ensure dirs

public slots:
    Q_INVOKABLE void setAiEnabled(bool enabled);
    Q_INVOKABLE void setEndpoint(const QString &url, const QString &model);
    Q_INVOKABLE void setApiKey(const QString &key);
    Q_INVOKABLE void setPrivacy(const QString &section, const QDBusVariant &value);
    Q_INVOKABLE void setPermissionDefault(const QString &cls, const QString &mode);
    // (int result, string model, int latency_ms) — 0 = ok
    Q_INVOKABLE QDBusArgument testEndpoint();

signals:
    void changed();
    void changedSection(const QString &section);
    void fileReplaced(const QString &path);

private:
    void save(const QString &section);
    void reloadExternal();
    void audit(const QString &tool, const QString &decision, const QString &detail,
               const QString &purpose = {});

    aiarch::AiArchConfig m_cfg;
    aiarch::SecretStore m_secrets;
    QFileSystemWatcher m_watcher;
    bool m_migrated = false;
};
