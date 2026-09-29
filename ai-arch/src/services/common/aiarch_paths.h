#pragma once
#include <QString>

// Canonical filesystem layout for the AI layer (docs/ARCHITECTURE.md §6).
// Env overrides exist for tests: AIARCH_USER_CONFIG, AIARCH_DISTRO_CONFIG,
// AIARCH_DATA_DIR.
namespace aiarch {

QString homeDir();
QString userConfigPath();    // ~/.config/ai-arch/ai-arch.json
QString distroConfigPath();  // /etc/xdg/ai-arch/ai-arch.json
QString legacyConfigPath();  // /etc/ai-arch/llama-server.json (20-ai-client)
QString dataDir();           // ~/.local/share/ai-arch
QString secretsDir();        // dataDir()/secrets
QString auditDbPath();       // dataDir()/audit.db
QString usageDbPath();       // dataDir()/usage.db
QString logsDir();           // dataDir()/logs

} // namespace aiarch
