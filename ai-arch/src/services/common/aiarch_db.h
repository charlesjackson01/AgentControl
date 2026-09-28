#pragma once
#include <QList>
#include <QString>

namespace aiarch {

// SQLite helpers (WAL mode). Foundation tables: audit (append-only), usage.
void ensureAuditDb(const QString &path);
void ensureUsageDb(const QString &path);

void auditAppend(const QString &dbPath, const QString &actor, const QString &tool,
                 const QString &argsJson, const QString &purpose,
                 const QString &decision, const QString &detail = {},
                 const QString &requestId = {});

struct AuditRow {
    qint64 seq = 0;
    qint64 ts = 0;
    QString actor, tool, argsJson, purpose, decision, detail, requestId;
};
QList<AuditRow> auditTail(const QString &dbPath, int n);

struct UsageRow {
    qint64 ts = 0;
    QString app, model;
    qint32 tokensIn = 0, tokensOut = 0;
    double estCost = 0.0;
};
void usageAppend(const QString &dbPath, const UsageRow &r);
QList<UsageRow> usageRange(const QString &dbPath, qint64 startMs, qint64 endMs);
qint64 usageSumTokens(const QString &dbPath, qint64 startMs, qint64 endMs);

} // namespace aiarch
