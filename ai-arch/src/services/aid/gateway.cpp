#include "gateway.h"
#include "sse.h"
#include "aiarch_paths.h"
#include "aiarch_db.h"
#include <QHostInfo>
#include <QTcpSocket>
#include <QEventLoop>
#include <QCoreApplication>
#include <QUrl>
#include <QUuid>
#include <QDateTime>
#include <QElapsedTimer>
#include <QFile>
#include <QDir>
#include <QJsonDocument>
#include <QTextStream>
#include <QDebug>

using namespace aiarch;

InFlight::~InFlight() = default;

Gateway::Gateway(QObject *parent)
    : QObject(parent)
    , m_secrets(secretsDir())
{
    m_pingTimer.setInterval(10000);
    connect(&m_pingTimer, &QTimer::timeout, this, &Gateway::ping);
    m_chunkTimer.setSingleShot(true);
    connect(&m_chunkTimer, &QTimer::timeout, this, [this] {
        for (auto it = m_reqs.begin(); it != m_reqs.end(); ++it) {
            if (it->second->state == "streaming") {
                it->second->timedOut = true;
                if (it->second->reply)
                    it->second->reply->abort();
            }
        }
    });
}

void Gateway::start()
{
    m_pingTimer.start();
}

void Gateway::applyConfig(const AiArchConfig &cfg)
{
    m_cfg = cfg;
    if (!cfg.aiEnabled)
        cancelAll();
    ping();
    emit statusUpdated();
}

void Gateway::setState(const QString &s)
{
    if (m_state == s) {
        emit statusUpdated();
        return;
    }
    m_state = s;
    emit statusChanged(s);
    emit statusUpdated();
}

void Gateway::ping()
{
    if (m_cfg.endpoint.url.isEmpty()) {
        m_lastError = QStringLiteral("endpoint not configured");
        setState("offline");
        return;
    }
    if (m_pingReply) {
        m_pingReply->deleteLater();
        m_pingReply = nullptr;
    }
    m_pingStartedMs = QDateTime::currentMSecsSinceEpoch();
    QNetworkRequest req = authedRequest(QStringLiteral("/v1/models"));
    req.setTransferTimeout(2000);
    m_pingReply = m_nam.get(req);
    connect(m_pingReply, &QNetworkReply::finished, this, [this] {
        auto *reply = m_pingReply;
        m_pingReply = nullptr;
        const int code = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const bool ok = reply->error() == QNetworkReply::NoError && code == 200;
        m_latencyMs = static_cast<int>(QDateTime::currentMSecsSinceEpoch() - m_pingStartedMs);
        if (ok) {
            const QJsonDocument doc = QJsonDocument::fromJson(reply->readAll());
            if (doc.isObject()) {
                m_models = doc.object().value("data").toArray();
                m_modelsFetchedMs = QDateTime::currentMSecsSinceEpoch();
            }
            m_lastError.clear();
            setState("connected");
        } else {
            m_lastError = reply->errorString();
            if (m_state != "degraded")
                setState("offline");
        }
        reply->deleteLater();
    });
}

void Gateway::cancelAll()
{
    for (auto it = m_reqs.begin(); it != m_reqs.end(); ++it) {
        InFlight &r = *it->second;
        if (r.state == "streaming") {
            r.cancelRequested = true;
            if (r.reply)
                r.reply->abort();
        } else if (r.state == "queued") {
            emit requestUpdated(r.id, QStringLiteral("cancelled"));
        }
    }
    m_queue.clear();
    // queued entries removed via finish-less cleanup:
    for (auto it = m_reqs.begin(); it != m_reqs.end();) {
        if (it->second->state == "queued")
            it = m_reqs.erase(it);
        else
            ++it;
    }
    emit statusUpdated();
}

QString Gateway::chat(const QString &app, const QString &chatId, const QJsonArray &messages,
                      const QString &modelOverride, quint32 maxTokens, double temperature,
                      const QJsonArray &tools, const QString &contextScope, QString *err)
{
    if (!m_cfg.aiEnabled) {
        if (err) *err = "Disabled";
        return {};
    }
    if (m_cfg.endpoint.url.isEmpty()) {
        if (err) *err = "NotConfigured";
        return {};
    }
    if (messages.isEmpty()) {
        if (err) *err = "ValidationError";
        return {};
    }

    InFlight req;
    req.id = QStringLiteral("req-") + QUuid::createUuid().toString(QUuid::WithoutBraces).left(12);
    req.app = app;
    req.chatId = chatId;
    req.model = modelOverride.isEmpty() ? m_cfg.endpoint.model : modelOverride;
    req.messages = messages;
    req.tools = tools;
    req.contextScope = contextScope;
    req.maxTokens = maxTokens;
    req.temperature = temperature;
    auto ptr = std::make_unique<InFlight>(std::move(req));
    const QString id = ptr->id;
    m_reqs.emplace(id, std::move(ptr));
    m_queue.append(id);
    emit requestUpdated(id, QStringLiteral("queued"));
    emit statusUpdated();
    pump();
    return id;
}

void Gateway::pump()
{
    while (!m_queue.isEmpty() && m_activeCount < 1 && !m_paused) {
        const QString id = m_queue.takeFirst();
        auto it = m_reqs.find(id);
        if (it == m_reqs.end())
            continue;
        InFlight &req = *it->second;
        req.state = "streaming";
        req.startedMs = QDateTime::currentMSecsSinceEpoch();
        m_activeCount++;
        emit requestUpdated(req.id, QStringLiteral("streaming"));
        startRequest(req);
    }
}

QNetworkRequest Gateway::authedRequest(const QString &path)
{
    QNetworkRequest req(QUrl(m_cfg.endpoint.url + path));
    req.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    if (m_secrets.contains(QStringLiteral("endpoint-key")))
        req.setRawHeader("Authorization", "Bearer " + m_secrets.get("endpoint-key"));
    return req;
}

void Gateway::startRequest(InFlight &req)
{
    QNetworkRequest netReq = authedRequest(QStringLiteral("/v1/chat/completions"));
    netReq.setRawHeader("Accept", "text/event-stream");

    QJsonObject body;
    body["model"] = req.model;
    body["messages"] = req.messages;
    body["stream"] = true;
    if (req.maxTokens > 0)
        body["max_tokens"] = static_cast<int>(req.maxTokens);
    if (req.temperature > 0.0)
        body["temperature"] = req.temperature;
    if (!req.tools.isEmpty())
        body["tools"] = req.tools;

    auto *reply = m_nam.post(netReq, QJsonDocument(body).toJson());
    req.reply = reply;
    req.sse = std::make_unique<SseParser>();

    const QString id = req.id;
    connect(reply, &QNetworkReply::readyRead, this, [this, id] {
        auto it = m_reqs.find(id);
        if (it == m_reqs.end() || it->second->state != "streaming")
            return;
        handleChunk(*it->second);
    });
    connect(reply, &QNetworkReply::finished, this, [this, id] {
        auto it = m_reqs.find(id);
        if (it == m_reqs.end())
            return;
        InFlight &req = *it->second;
        if (req.state != "streaming")
            return;
        if (req.cancelRequested) {
            finish(req, false, "cancelled", QStringLiteral("cancelled by user"));
        } else if (req.timedOut) {
            finish(req, false, "timeout", QStringLiteral("no data between chunks"));
        } else if (!req.backendError.isEmpty()) {
            finish(req, false, "backend", req.backendError);
        } else if (req.sse->done()) {
            finish(req, true, QString(), QString());
        } else {
            finish(req, false, "backend", QStringLiteral("stream ended without [DONE]"));
        }
    });

    m_chunkTimer.start(30000);
}

void Gateway::handleChunk(InFlight &req)
{
    if (!req.reply)
        return;
    const QByteArray chunk = req.reply->readAll();
    req.sse->feed(chunk, [this, &req](const SseEvent &e) { handleEvent(req, e); });
    if (!req.sse->done() && req.state == "streaming")
        m_chunkTimer.start(30000);
}

void Gateway::handleEvent(InFlight &req, const SseEvent &e)
{
    if (e.data == QStringLiteral("[DONE]"))
        return;
    const QJsonDocument doc = QJsonDocument::fromJson(e.data.toUtf8());
    if (!doc.isObject())
        return;
    const QJsonObject obj = doc.object();

    if (obj.contains("error")) {
        const QJsonObject err = obj["error"].toObject();
        req.backendError = err.value("message").toString(
            obj["error"].toString(QStringLiteral("backend error")));
        return;
    }
    if (obj.contains("usage")) {
        const QJsonObject u = obj["usage"].toObject();
        req.tokensIn = static_cast<quint32>(u.value("prompt_tokens").toInt(0));
        req.tokensOut = static_cast<quint32>(u.value("completion_tokens").toInt(0));
    }
    const QJsonArray choices = obj.value("choices").toArray();
    if (choices.isEmpty())
        return;
    const QJsonObject delta = choices.first().toObject().value("delta").toObject();
    const QString content = delta.value("content").toString();
    if (!content.isEmpty()) {
        req.content += content;
        emit chatDelta(req.id, content);
    }
    const QJsonArray tcs = delta.value("tool_calls").toArray();
    for (const QJsonValue &tv : tcs) {
        const QJsonObject tc = tv.toObject();
        const int index = tc.value("index").toInt(0);
        while (req.toolCalls.size() <= index)
            req.toolCalls.append(QJsonObject());
        QJsonObject cur = req.toolCalls.at(index).toObject();
        const QJsonObject fn = tc.value("function").toObject();
        if (tc.contains("id"))
            cur["id"] = tc.value("id");
        QJsonObject curFn = cur.value("function").toObject();
        if (fn.contains("name"))
            curFn["name"] = fn.value("name");
        if (fn.contains("arguments"))
            curFn["arguments"] = curFn.value("arguments").toString() + fn.value("arguments").toString();
        cur["function"] = curFn;
        req.toolCalls.replace(index, cur);
    }
}

void Gateway::finish(InFlight &req, bool ok, const QString &code, const QString &message)
{
    const int latencyMs = static_cast<int>(QDateTime::currentMSecsSinceEpoch() - req.startedMs);
    if (ok)
        req.state = "done";
    else if (code == "cancelled")
        req.state = "cancelled";
    else
        req.state = "error";

    if (ok) {
        QJsonObject usage;
        usage["app"] = req.app;
        usage["model"] = req.model;
        usage["tokens_in"] = static_cast<int>(req.tokensIn);
        usage["tokens_out"] = static_cast<int>(req.tokensOut);
        usage["latency_ms"] = latencyMs;
        emit chatDone(req.id, req.content, req.toolCalls, usage);
    } else {
        if (code != "cancelled") {
            m_failed++;
            if (m_state == "connected")
                setState("degraded");
        }
        emit chatError(req.id, code, message);
    }

    recordAndLog(req, latencyMs, req.state);
    m_activeCount = qMax(0, m_activeCount - 1);
    if (req.reply) {
        QNetworkReply *reply = req.reply;
        req.reply = nullptr;
        reply->deleteLater();
    }
    m_reqs.erase(req.id);
    emit statusUpdated();
    pump();
}

void Gateway::recordAndLog(InFlight &req, int latencyMs, const QString &state)
{
    // estimate when the backend sent no usage
    if (req.tokensIn == 0 && req.tokensOut == 0) {
        req.tokensOut = static_cast<quint32>(req.content.length() / 4 + 1);
    }
    UsageRow row;
    row.ts = QDateTime::currentMSecsSinceEpoch();
    row.app = req.app;
    row.model = req.model;
    row.tokensIn = static_cast<qint32>(req.tokensIn);
    row.tokensOut = static_cast<qint32>(req.tokensOut);
    row.estCost = 0.0;
    usageAppend(usageDbPath(), row);

    LogEntry e;
    e.ts = row.ts;
    e.app = req.app;
    e.model = req.model;
    e.state = state;
    e.tokensIn = row.tokensIn;
    e.tokensOut = row.tokensOut;
    e.latencyMs = latencyMs;
    m_log.append(e);
    while (m_log.size() > 500)
        m_log.removeFirst();

    // request log line — no content (SECURITY.md §7)
    QDir().mkpath(logsDir());
    QFile f(logsDir() + "/aid.log");
    if (f.open(QIODevice::Append | QIODevice::Text)) {
        QTextStream out(&f);
        out << QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)
            << " app=" << req.app << " model=" << req.model
            << " tokens_in=" << row.tokensIn << " tokens_out=" << row.tokensOut
            << " latency_ms=" << latencyMs << " state=" << state
            << (state == "error" ? " error=" + (req.backendError.isEmpty() ? QString() : req.backendError) : QString())
            << "\n";
    }
}

void Gateway::cancel(const QString &id)
{
    auto it = m_reqs.find(id);
    if (it == m_reqs.end())
        return;
    InFlight &req = *it->second;
    if (req.state == "queued") {
        m_queue.removeOne(id);
        emit requestUpdated(id, QStringLiteral("cancelled"));
        m_reqs.erase(it);
        emit statusUpdated();
    } else if (req.state == "streaming") {
        req.cancelRequested = true;
        if (req.reply)
            req.reply->abort();
    }
}

QJsonArray Gateway::modelsSync()
{
    if (m_modelsFetchedMs
        && QDateTime::currentMSecsSinceEpoch() - m_modelsFetchedMs < 30000)
        return m_models;
    if (m_cfg.endpoint.url.isEmpty())
        return m_models;
    QNetworkRequest req = authedRequest(QStringLiteral("/v1/models"));
    req.setTransferTimeout(5000);
    QNetworkReply *reply = m_nam.get(req);
    QElapsedTimer t;
    t.start();
    while (!reply->isFinished() && t.elapsed() < 5500)
        QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
    if (reply->isFinished()) {
        if (reply->error() == QNetworkReply::NoError) {
            const QJsonDocument doc = QJsonDocument::fromJson(reply->readAll());
            if (doc.isObject()) {
                m_models = doc.object().value("data").toArray();
                m_modelsFetchedMs = QDateTime::currentMSecsSinceEpoch();
            }
        }
    }
    reply->deleteLater();
    return m_models;
}

int Gateway::testModelSync(const QString &model)
{
    if (m_cfg.endpoint.url.isEmpty())
        return -1;
    QNetworkRequest req = authedRequest(QStringLiteral("/v1/chat/completions"));
    req.setTransferTimeout(30000);
    QJsonObject body;
    body["model"] = model;
    QJsonArray msgs;
    QJsonObject m;
    m["role"] = "user";
    m["content"] = "ping";
    msgs.append(m);
    body["messages"] = msgs;
    body["stream"] = false;
    body["max_tokens"] = 1;
    QNetworkReply *reply = m_nam.post(req, QJsonDocument(body).toJson());
    QElapsedTimer t;
    t.start();
    while (!reply->isFinished() && t.elapsed() < 30500)
        QCoreApplication::processEvents(QEventLoop::AllEvents, 10);
    int latency = -1;
    if (reply->isFinished() && reply->error() == QNetworkReply::NoError)
        latency = static_cast<int>(t.elapsed());
    reply->deleteLater();
    return latency;
}

QJsonObject Gateway::diagnostics()
{
    QJsonObject d;
    d["config_present"] = !m_cfg.endpoint.url.isEmpty();
    d["ai_enabled"] = m_cfg.aiEnabled;
    d["endpoint_url"] = m_cfg.endpoint.url;
    d["state"] = m_state;
    d["latency_ms"] = m_latencyMs;
    d["last_error"] = m_lastError;
    d["queue_depth"] = m_queue.size();
    d["queue_paused"] = m_paused;
    d["active_requests"] = m_activeCount;
    d["failed_requests"] = m_failed;

    if (!m_cfg.endpoint.url.isEmpty()) {
        const QUrl url(m_cfg.endpoint.url);
        const QString host = url.host();
        const quint16 port = static_cast<quint16>(url.port(url.scheme() == "https" ? 443 : 80));
        if (!host.isEmpty()) {
            const QHostInfo info = QHostInfo::fromName(host);
            d["dns_ok"] = info.error() == QHostInfo::NoError;
            d["dns_address"] = info.addresses().isEmpty()
                                    ? QString()
                                    : info.addresses().first().toString();
            QTcpSocket sock;
            sock.connectToHost(host, port);
            QEventLoop loop;
            QObject::connect(&sock, &QTcpSocket::connected, &loop, &QEventLoop::quit);
            QTimer timeout;
            timeout.setSingleShot(true);
            QObject::connect(&timeout, &QTimer::timeout, &loop, &QEventLoop::quit);
            timeout.start(3000);
            loop.exec();
            d["tcp_ok"] = sock.state() == QAbstractSocket::ConnectedState;
            sock.disconnectFromHost();
        }
    }
    return d;
}

QJsonArray Gateway::logEntries(const QString &app, int n)
{
    QJsonArray out;
    for (int i = m_log.size() - 1; i >= 0 && out.size() < n; --i) {
        const LogEntry &e = m_log.at(i);
        if (!app.isEmpty() && e.app != app)
            continue;
        QJsonObject o;
        o["ts"] = e.ts;
        o["app"] = e.app;
        o["model"] = e.model;
        o["state"] = e.state;
        o["tokens_in"] = e.tokensIn;
        o["tokens_out"] = e.tokensOut;
        o["latency_ms"] = e.latencyMs;
        out.append(o);
    }
    return out;
}

#include "gateway.moc"
