#pragma once
#include <QJsonObject>
#include <QJsonArray>
#include <QString>
#include <QStringList>

namespace aiarch {

struct EndpointCfg {
    QString url;
    QString model;
    QString apiKeyRef = QStringLiteral("ai-arch/endpoint-key");
    quint32 timeoutMs = 600000;
    quint32 maxTokensDefault = 1024;
};

struct PrivacyCfg {
    bool preferLocal = true;
    qint32 logRetentionDays = 30;
    bool contentLogging = false;
    QStringList excludedPaths;
};

struct PermissionDefaults {
    QString readonly_ = QStringLiteral("allow");
    QString low = QStringLiteral("ask");
    QString sensitive = QStringLiteral("ask");
    QString critical = QStringLiteral("confirm");
};

// One config document: user file overrides distro defaults key-wise,
// legacy /etc/ai-arch/llama-server.json is the last fallback
// (docs/AI-ARCH-ARCHITECTURE.md §3 — see docs/AI-ARCHITECTURE.md).
struct AiArchConfig {
    int version = 1;
    bool aiEnabled = true;
    EndpointCfg endpoint;
    PrivacyCfg privacy;
    PermissionDefaults permissions;

    static AiArchConfig load();
    static AiArchConfig fromJson(const QJsonObject &o);
    QJsonObject toJson() const;
    static QJsonObject deepMerge(const QJsonObject &base, const QJsonObject &over);
    static bool validate(const QJsonObject &o, QString *err = nullptr);
    static QStringList validPrivacySections();
    static QStringList validPermissionClasses();
    static QStringList validPermissionModes();
};

} // namespace aiarch
