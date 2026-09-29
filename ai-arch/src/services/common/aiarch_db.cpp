#include "aiarch_db.h"
#include <QSqlDatabase>
#include <QSqlQuery>
#include <QSqlError>
#include <QDir>
#include <QFileInfo>
#include <QDateTime>
#include <QUuid>
#include <functional>

namespace aiarch {

static bool withDb(const QString &path, const char *schema,
                   const std::function<bool(QSqlDatabase &)> &fn)
{
    QDir().mkpath(QFileInfo(path).absolutePath());
    const QString connName = QUuid::createUuid().toString(QUuid::WithoutBraces);
    QSqlDatabase db = QSqlDatabase::addDatabase("QSQLITE", connName);
    db.setDatabaseName(path);
    bool ok = false;
    if (db.open()) {
        db.exec("PRAGMA journal_mode=WAL;");
        if (schema)
            db.exec(schema);
        ok = fn(db);
        db.close();
    }
    QSqlDatabase::removeDatabase(connName);
    return ok;
}

static const char *AUDIT_SCHEMA =
    "CREATE TABLE IF NOT EXISTS audit ("
    " seq INTEGER PRIMARY KEY AUTOINCREMENT,"
    " ts INTEGER NOT NULL,"
    " actor TEXT NOT NULL,"
    " tool TEXT NOT NULL,"
    " args_json TEXT NOT NULL DEFAULT '{}',"
    " purpose TEXT NOT NULL DEFAULT '',"
    " decision TEXT NOT NULL,"
    " detail TEXT NOT NULL DEFAULT '',"
    " request_id TEXT NOT NULL DEFAULT ''"
    ");";

static const char *USAGE_SCHEMA =
    "CREATE TABLE IF NOT EXISTS usage ("
    " ts INTEGER NOT NULL,"
    " app TEXT NOT NULL,"
    " model TEXT NOT NULL,"
    " tokens_in INTEGER NOT NULL,"
    " tokens_out INTEGER NOT NULL,"
    " est_cost REAL NOT NULL DEFAULT 0"
    ");";

void ensureAuditDb(const QString &path)
{
    withDb(path, AUDIT_SCHEMA, [](QSqlDatabase &) { return true; });
}

void ensureUsageDb(const QString &path)
{
    withDb(path, USAGE_SCHEMA, [](QSqlDatabase &) { return true; });
}

void auditAppend(const QString &dbPath, const QString &actor, const QString &tool,
                 const QString &argsJson, const QString &purpose,
                 const QString &decision, const QString &detail, const QString &requestId)
{
    withDb(dbPath, AUDIT_SCHEMA, [&](QSqlDatabase &db) {
        QSqlQuery q(db);
        q.prepare("INSERT INTO audit (ts, actor, tool, args_json, purpose, decision, detail, request_id) "
                  "VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        q.addBindValue(QDateTime::currentMSecsSinceEpoch());
        q.addBindValue(actor);
        q.addBindValue(tool);
        q.addBindValue(argsJson);
        q.addBindValue(purpose);
        q.addBindValue(decision);
        q.addBindValue(detail);
        q.addBindValue(requestId);
        return q.exec();
    });
}

QList<AuditRow> auditTail(const QString &dbPath, int n)
{
    QList<AuditRow> out;
    withDb(dbPath, AUDIT_SCHEMA, [&](QSqlDatabase &db) {
        QSqlQuery q(db);
        q.prepare("SELECT seq, ts, actor, tool, args_json, purpose, decision, detail, request_id "
                  "FROM audit ORDER BY seq DESC LIMIT ?");
        q.addBindValue(n);
        if (q.exec()) {
            while (q.next()) {
                AuditRow r;
                r.seq = q.value(0).toLongLong();
                r.ts = q.value(1).toLongLong();
                r.actor = q.value(2).toString();
                r.tool = q.value(3).toString();
                r.argsJson = q.value(4).toString();
                r.purpose = q.value(5).toString();
                r.decision = q.value(6).toString();
                r.detail = q.value(7).toString();
                r.requestId = q.value(8).toString();
                out.prepend(r);
            }
        }
        return true;
    });
    return out;
}

void usageAppend(const QString &dbPath, const UsageRow &r)
{
    withDb(dbPath, USAGE_SCHEMA, [&](QSqlDatabase &db) {
        QSqlQuery q(db);
        q.prepare("INSERT INTO usage (ts, app, model, tokens_in, tokens_out, est_cost) "
                  "VALUES (?, ?, ?, ?, ?, ?)");
        q.addBindValue(r.ts);
        q.addBindValue(r.app);
        q.addBindValue(r.model);
        q.addBindValue(r.tokensIn);
        q.addBindValue(r.tokensOut);
        q.addBindValue(r.estCost);
        return q.exec();
    });
}

QList<UsageRow> usageRange(const QString &dbPath, qint64 startMs, qint64 endMs)
{
    QList<UsageRow> out;
    withDb(dbPath, USAGE_SCHEMA, [&](QSqlDatabase &db) {
        QSqlQuery q(db);
        q.prepare("SELECT ts, app, model, tokens_in, tokens_out, est_cost "
                  "FROM usage WHERE ts >= ? AND ts < ? ORDER BY ts");
        q.addBindValue(startMs);
        q.addBindValue(endMs);
        if (q.exec()) {
            while (q.next()) {
                UsageRow r;
                r.ts = q.value(0).toLongLong();
                r.app = q.value(1).toString();
                r.model = q.value(2).toString();
                r.tokensIn = q.value(3).toInt();
                r.tokensOut = q.value(4).toInt();
                r.estCost = q.value(5).toDouble();
                out.append(r);
            }
        }
        return true;
    });
    return out;
}

qint64 usageSumTokens(const QString &dbPath, qint64 startMs, qint64 endMs)
{
    qint64 sum = 0;
    withDb(dbPath, USAGE_SCHEMA, [&](QSqlDatabase &db) {
        QSqlQuery q(db);
        q.prepare("SELECT COALESCE(SUM(tokens_in + tokens_out), 0) FROM usage WHERE ts >= ? AND ts < ?");
        q.addBindValue(startMs);
        q.addBindValue(endMs);
        if (q.exec() && q.next())
            sum = q.value(0).toLongLong();
        return true;
    });
    return sum;
}

} // namespace aiarch
