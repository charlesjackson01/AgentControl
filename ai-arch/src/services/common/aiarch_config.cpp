#include "aiarch_config.h"
#include "aiarch_paths.h"
#include <QFile>
#include <QJsonDocument>
#include <QJsonParseError>

namespace aiarch {

static QStringList defaultExclusions()
{
    return { QStringLiteral("~/.ssh"), QStringLiteral("~/.gnupg"),
             QStringLiteral("~/.config/keepassxc"), QStringLiteral("/etc"),
             QStringLiteral("/boot") };
}

QJsonObject AiArchConfig::deepMerge(const QJsonObject &base, const QJsonObject &over)
{
    QJsonObject out = base;
    for (auto it = over.constBegin(); it != over.constEnd(); ++it) {
        if (out.contains(it.key()) && it.value().isObject() && out[it.key()].isObject())
            out[it.key()] = deepMerge(out[it.key()].toObject(), it.value().toObject());
        else
            out[it.key()] = it.value();
    }
    return out;
}

AiArchConfig AiArchConfig::fromJson(const QJsonObject &o)
{
    AiArchConfig c;
    c.version = o.value("version").toInt(1);
    c.aiEnabled = o.value("ai_enabled").toBool(true);

    if (o.contains("endpoint")) {
        const QJsonObject e = o["endpoint"].toObject();
        c.endpoint.url = e.value("url").toString();
        c.endpoint.model = e.value("model").toString();
        c.endpoint.apiKeyRef = e.value("api_key_ref").toString(c.endpoint.apiKeyRef);
        c.endpoint.timeoutMs = static_cast<quint32>(e.value("timeout_ms").toInt(600000));
        c.endpoint.maxTokensDefault = static_cast<quint32>(e.value("max_tokens_default").toInt(1024));
    }
    if (o.contains("privacy")) {
        const QJsonObject p = o["privacy"].toObject();
        c.privacy.preferLocal = p.value("prefer_local").toBool(true);
        c.privacy.logRetentionDays = p.value("log_retention_days").toInt(30);
        c.privacy.contentLogging = p.value("content_logging").toBool(false);
        if (p.contains("excluded_paths")) {
            for (const QJsonValue &v : p["excluded_paths"].toArray())
                c.privacy.excludedPaths << v.toString();
        }
    }
    if (c.privacy.excludedPaths.isEmpty())
        c.privacy.excludedPaths = defaultExclusions();

    if (o.contains("permissions")) {
        const QJsonObject p = o["permissions"].toObject();
        if (p.contains("defaults")) {
            const QJsonObject d = p["defaults"].toObject();
            c.permissions.readonly_ = d.value("readonly").toString(c.permissions.readonly_);
            c.permissions.low = d.value("low").toString(c.permissions.low);
            c.permissions.sensitive = d.value("sensitive").toString(c.permissions.sensitive);
            c.permissions.critical = d.value("critical").toString(c.permissions.critical);
        }
    }
    return c;
}

AiArchConfig AiArchConfig::load()
{
    QJsonObject merged;
    for (const QString &p : { distroConfigPath(), userConfigPath() }) {
        QFile f(p);
        if (!f.open(QIODevice::ReadOnly))
            continue;
        QJsonParseError pe{};
        const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &pe);
        if (pe.error == QJsonParseError::NoError && doc.isObject())
            merged = deepMerge(merged, doc.object());
        f.close();
    }

    if (merged.isEmpty()) {
        // Legacy 20-ai-client format: { base_url, model, max_tokens, notes }
        QFile f(legacyConfigPath());
        if (f.open(QIODevice::ReadOnly)) {
            const QJsonDocument doc = QJsonDocument::fromJson(f.readAll());
            if (doc.isObject()) {
                const QJsonObject d = doc.object();
                QJsonObject e;
                e["url"] = d.value("base_url").toString();
                e["model"] = d.value("model").toString();
                if (d.contains("max_tokens"))
                    e["max_tokens_default"] = d.value("max_tokens").toInt();
                QJsonObject m;
                m["endpoint"] = e;
                merged = deepMerge(merged, m);
            }
            f.close();
        }
    }
    return fromJson(merged);
}

QJsonObject AiArchConfig::toJson() const
{
    QJsonObject o;
    o["version"] = version;
    o["ai_enabled"] = aiEnabled;
    QJsonObject e;
    e["url"] = endpoint.url;
    e["model"] = endpoint.model;
    e["api_key_ref"] = endpoint.apiKeyRef;
    e["timeout_ms"] = static_cast<int>(endpoint.timeoutMs);
    e["max_tokens_default"] = static_cast<int>(endpoint.maxTokensDefault);
    o["endpoint"] = e;
    QJsonObject p;
    p["prefer_local"] = privacy.preferLocal;
    p["log_retention_days"] = static_cast<int>(privacy.logRetentionDays);
    p["content_logging"] = privacy.contentLogging;
    QJsonObject arr;
    QJsonArray ex;
    for (const QString &s : privacy.excludedPaths)
        ex.append(s);
    p["excluded_paths"] = ex;
    o["privacy"] = p;
    QJsonObject perms, defs;
    defs["readonly"] = permissions.readonly_;
    defs["low"] = permissions.low;
    defs["sensitive"] = permissions.sensitive;
    defs["critical"] = permissions.critical;
    perms["defaults"] = defs;
    o["permissions"] = perms;
    return o;
}

bool AiArchConfig::validate(const QJsonObject &o, QString *err)
{
    auto fail = [&](const QString &m) {
        if (err)
            *err = m;
        return false;
    };
    if (o.contains("endpoint")) {
        const QJsonObject e = o["endpoint"].toObject();
        const QString url = e.value("url").toString();
        if (!url.isEmpty() && !url.startsWith("http://") && !url.startsWith("https://"))
            return fail(QStringLiteral("endpoint.url must start with http:// or https://"));
    }
    if (o.contains("permissions")) {
        const QJsonObject p = o["permissions"].toObject();
        if (p.contains("defaults")) {
            const QJsonObject d = p["defaults"].toObject();
            for (const QString &cls : { "readonly", "low", "sensitive", "critical" }) {
                const QString mode = d.value(cls).toString();
                if (!mode.isEmpty() && !validPermissionModes().contains(mode))
                    return fail(QStringLiteral("permissions.defaults.%1 must be allow, ask, or confirm").arg(cls));
            }
        }
    }
    return true;
}

QStringList AiArchConfig::validPrivacySections()
{
    return { "prefer_local", "log_retention_days", "content_logging", "excluded_paths" };
}

QStringList AiArchConfig::validPermissionClasses()
{
    return { "readonly", "low", "sensitive", "critical" };
}

QStringList AiArchConfig::validPermissionModes()
{
    return { "allow", "ask", "confirm" };
}

} // namespace aiarch
