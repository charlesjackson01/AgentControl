#include "aid_adaptor.h"
#include "aiarch_paths.h"
#include "aiarch_db.h"
#include <QDBusInterface>
#include <QDBusMessage>
#include <QDate>
#include <QDateTime>
#include <QDebug>

using namespace aiarch;

AidAdaptor::AidAdaptor(Gateway *gw, QObject *parent)
    : QDBusAbstractAdaptor(parent)
    , m_gw(gw)
{
    connect(gw, &Gateway::statusUpdated, this, &AidAdaptor::statusUpdated);
    connect(gw, &Gateway::statusChanged, this, &AidAdaptor::statusChanged);
    connect(gw, &Gateway::requestUpdated, this, &AidAdaptor::requestUpdated);
    connect(gw, &Gateway::chatDelta, this, &AidAdaptor::chatDelta);
    connect(gw, &Gateway::chatDone, this, &AidAdaptor::chatDone);
    connect(gw, &Gateway::chatError, this, &AidAdaptor::chatError);
    connect(gw, &Gateway::modelsReady, this, &AidAdaptor::modelsReady);
    connect(gw, &Gateway::testModelDone, this, &AidAdaptor::testModelDone);
}

static qint64 startOfTodayMs()
{
    return QDateTime(QDate::currentDate(), QTime()).toMSecsSinceEpoch();
}

static qint64 startOfMonthMs()
{
    const QDate d = QDate::currentDate();
    return QDateTime(QDate(d.year(), d.month(), 1), QTime()).toMSecsSinceEpoch();
}

int AidAdaptor::usageToday() const
{
    return static_cast<int>(usageSumTokens(usageDbPath(), startOfTodayMs(),
                                           QDateTime::currentMSecsSinceEpoch() + 1));
}

int AidAdaptor::usageMonth() const
{
    return static_cast<int>(usageSumTokens(usageDbPath(), startOfMonthMs(),
                                           QDateTime::currentMSecsSinceEpoch() + 1));
}

void AidAdaptor::raise(const QString &code, const QString &msg)
{
    sendErrorReply(QStringLiteral("org.aiarch.Error.") + code, msg);
}

QString AidAdaptor::chat(const QVariantMap &req)
{
    const QString app = req.value("app").isValid()
                            ? req.value("app").toString()
                            : QStringLiteral("unknown");
    const QString chatId = req.value("chat_id").toString();

    QJsonArray messages;
    const QVariantList ml = req.value("messages").toList();
    for (const QVariant &mv : ml) {
        const QVariantMap mm = mv.toMap();
        QJsonObject m;
        m["role"] = mm.value("role").isValid()
                        ? mm.value("role").toString()
                        : QStringLiteral("user");
        m["content"] = mm.value("content").toString();
        messages.append(m);
    }

    const QString model = req.value("model").toString();
    const quint32 maxTokens = static_cast<quint32>(req.value("max_tokens").toUInt(0));
    const double temperature = req.value("temperature").toDouble();

    QJsonArray tools;
    const QVariantList tl = req.value("tools").toList();
    for (const QVariant &tv : tl) {
        if (tv.canConvert<QJsonObject>())
            tools.append(tv.toJsonObject());
        else if (tv.canConvert<QVariantMap>())
            tools.append(QJsonObject::fromVariantMap(tv.toMap()));
    }
    const QString contextScope = req.value("context_scope").toString();

    QString err;
    const QString id = m_gw->chat(app, chatId, messages, model, maxTokens, temperature,
                                   tools, contextScope, &err);
    if (id.isEmpty())
        raise(err, QStringLiteral("chat rejected: %1").arg(err));
    return id;
}

void AidAdaptor::cancel(const QString &requestId)
{
    m_gw->cancel(requestId);
}

QList<QVariant> AidAdaptor::models()
{
    QList<QVariant> out;
    const QJsonArray arr = m_gw->modelsSync();
    for (const QJsonValue &v : arr)
        out << QJsonValue(v).toVariant();
    return out;
}

void AidAdaptor::reloadModel(const QString &model)
{
    Q_UNUSED(model);
    raise("NotImplemented", QStringLiteral("model slot control lands in Stage E"));
}

void AidAdaptor::unloadModel()
{
    raise("NotImplemented", QStringLiteral("model slot control lands in Stage E"));
}

void AidAdaptor::setDefaultModel(const QString &model)
{
    QDBusInterface cfg(QStringLiteral("org.aiarch.Config"),
                       QStringLiteral("/org/aiarch/Config"));
    if (!cfg.isValid()) {
        raise("Unavailable", QStringLiteral("configd is not running"));
        return;
    }
    cfg.call(QStringLiteral("setEndpoint"), m_gw->endpointUrl(), model);
}

int AidAdaptor::testModel(const QString &model)
{
    return m_gw->testModelSync(model);
}

QList<QVariant> AidAdaptor::diagnostics()
{
    // a{sv} over the wire: flat [k0, v0, k1, v1, ...]
    QList<QVariant> out;
    const QJsonObject d = m_gw->diagnostics();
    QVariantMap map = d.toVariantMap();
    for (auto it = map.constBegin(); it != map.constEnd(); ++it)
        out << QJsonValue(it.key()).toVariant() << it.value();
    return out;
}

QList<QVariant> AidAdaptor::usageRange(quint64 startMs, quint64 endMs)
{
    QList<QVariant> out;
    const QList<UsageRow> rows =
        aiarch::usageRange(usageDbPath(), static_cast<qint64>(startMs), static_cast<qint64>(endMs));
    for (const UsageRow &r : rows) {
        QJsonObject o;
        o["ts"] = r.ts;
        o["app"] = r.app;
        o["model"] = r.model;
        o["tokens_in"] = r.tokensIn;
        o["tokens_out"] = r.tokensOut;
        o["est_cost"] = r.estCost;
        out << o;
    }
    return out;
}

QList<QVariant> AidAdaptor::logs(const QString &app, int n)
{
    QList<QVariant> out;
    const QJsonArray arr = m_gw->logEntries(app, n > 0 ? n : 20);
    for (const QJsonValue &v : arr)
        out << v.toVariant();
    return out;
}

void AidAdaptor::pauseQueue()
{
    m_gw->pauseQueue();
}

void AidAdaptor::resumeQueue()
{
    m_gw->resumeQueue();
}

#include "aid_adaptor.moc"
