#include "aiarch_paths.h"
#include <QStandardPaths>
#include <QDir>
#include <QProcessEnvironment>

namespace aiarch {

static QString envOr(const char *name, const QString &fallback)
{
    const QString v = QProcessEnvironment::systemEnvironment().value(name);
    return v.isEmpty() ? fallback : v;
}

QString homeDir()
{
    QString h = QStandardPaths::writableLocation(QStandardPaths::HomeLocation);
    if (h.isEmpty())
        h = QDir::homePath();
    return h;
}

QString userConfigPath()
{
    return envOr("AIARCH_USER_CONFIG", homeDir() + "/.config/ai-arch/ai-arch.json");
}

QString distroConfigPath()
{
    return envOr("AIARCH_DISTRO_CONFIG", QStringLiteral("/etc/xdg/ai-arch/ai-arch.json"));
}

QString legacyConfigPath()
{
    return QStringLiteral("/etc/ai-arch/llama-server.json");
}

QString dataDir()
{
    return envOr("AIARCH_DATA_DIR", homeDir() + "/.local/share/ai-arch");
}

QString secretsDir()
{
    return dataDir() + "/secrets";
}

QString auditDbPath()
{
    return dataDir() + "/audit.db";
}

QString usageDbPath()
{
    return dataDir() + "/usage.db";
}

QString logsDir()
{
    return dataDir() + "/logs";
}

} // namespace aiarch
