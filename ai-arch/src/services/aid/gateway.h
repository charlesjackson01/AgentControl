#pragma once
#include <QObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QTimer>
#include <QHash>
#include <QList>
#include <QJsonArray>
#include <QJsonObject>
#include <memory>
#include <map>
#include "aiarch_config.h"
#include "secret_store.h"

namespace aiarch {

class SseParser;
struct SseEvent;

struct InFlight {
    ~InFlight();
    InFlight() = default;
    InFlight(InFlight &&) = default;
    QString id;
    QString state = "queued"; // queued | streaming | done | error | cancelled
    QString app, chatId, model;
    QJsonArray messages;
    QJsonArray tools;
    QString contextScope;
    quint32 maxTokens = 0;
    double temperature = 0.0;
    QNetworkReply *reply = nullptr;
    std::unique_ptr<SseParser> sse;
    QString content;
    QJsonArray toolCalls;
    quint32 tokensIn = 0, tokensOut = 0;
    qint64 startedMs = 0;
    bool cancelRequested = false;
    bool timedOut = false;
    QString backendError;
};

// org.aiarch.AI — the gateway: the only client of the backend
// (docs/AI-ARCHITECTURE.md §5). Queue (1 in-flight), streaming,
// cancellation, usage metering, request log, health.
class Gateway : public QObject
{
    Q_OBJECT
public:
    explicit Gateway(QObject *parent = nullptr);

    void start();
    void applyConfig(const AiArchConfig &cfg);
    bool aiEnabled() const { return m_cfg.aiEnabled; }
    const AiArchConfig &config() const { return m_cfg; }

    // returns request id; empty on synchronous rejection (*err = code)
    QString chat(const QString &app, const QString &chatId, const QJsonArray &messages,
                 const QString &modelOverride, quint32 maxTokens, double temperature,
                 const QJsonArray &tools, const QString &contextScope, QString *err = nullptr);
    void cancel(const QString &id);
    QJsonArray modelsSync();              // blocks up to 5 s
    int testModelSync(const QString &model); // latency ms, -1 on failure
    QJsonObject diagnostics();
    QJsonArray logEntries(const QString &app, int n);

    void pauseQueue() { m_paused = true; emit statusUpdated(); }
    void resumeQueue() { m_paused = false; pump(); emit statusUpdated(); }

    QString state() const { return m_state; }
    QString endpointUrl() const { return m_cfg.endpoint.url; }
    QString model() const { return m_cfg.endpoint.model; }
    int latencyMs() const { return m_latencyMs; }
    int queueDepth() const { return m_queue.size(); }
    int activeRequests() const { return m_activeCount; }
    int failedRequests() const { return m_failed; }
    bool queuePaused() const { return m_paused; }

signals:
    void statusUpdated();
    void statusChanged(const QString &state);
    void requestUpdated(const QString &id, const QString &state);
    void chatDelta(const QString &id, const QString &delta);
    void chatDone(const QString &id, const QString &content, const QJsonArray &toolCalls,
                  const QJsonObject &usage);
    void chatError(const QString &id, const QString &code, const QString &message);
    void modelsReady(const QJsonArray &models);
    void testModelDone(const QString &model, int latencyMs);

private:
    void ping();
    void pump();
    void startRequest(InFlight &req);
    void handleChunk(InFlight &req);
    void handleEvent(InFlight &req, const SseEvent &e);
    void finish(InFlight &req, bool ok, const QString &code, const QString &message);
    void recordAndLog(InFlight &req, int latencyMs, const QString &state);
    void setState(const QString &s);
    void cancelAll();
    QNetworkRequest authedRequest(const QString &path);

    AiArchConfig m_cfg;
    SecretStore m_secrets;
    QNetworkAccessManager m_nam;
    std::map<QString, std::unique_ptr<InFlight>> m_reqs;
    QList<QString> m_queue;
    int m_activeCount = 0;
    int m_failed = 0;
    int m_latencyMs = 0;
    QString m_state = "offline";
    QString m_lastError;
    bool m_paused = false;
    QJsonArray m_models;
    qint64 m_modelsFetchedMs = 0;
    QTimer m_pingTimer;
    QTimer m_chunkTimer;
    QNetworkReply *m_pingReply = nullptr;
    qint64 m_pingStartedMs = 0;

    struct LogEntry {
        qint64 ts = 0;
        QString app, model, state;
        qint32 tokensIn = 0, tokensOut = 0, latencyMs = 0;
    };
    QList<LogEntry> m_log; // ring, capped at 500
};

} // namespace aiarch
