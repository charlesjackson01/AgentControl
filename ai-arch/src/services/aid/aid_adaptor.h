#pragma once
#include <QDBusAbstractAdaptor>
#include <QDBusContext>
#include <QVariant>
#include "gateway.h"

// org.aiarch.AI D-Bus facade (docs/AI-ARCHITECTURE.md §4.2).
class AidAdaptor : public QDBusAbstractAdaptor, public QDBusContext
{
    Q_OBJECT
public:
    explicit AidAdaptor(aiarch::Gateway *gw, QObject *parent = nullptr);

    Q_PROPERTY(QString State READ state NOTIFY statusUpdated)
    Q_PROPERTY(QString EndpointUrl READ endpointUrl NOTIFY statusUpdated)
    Q_PROPERTY(QString Model READ model NOTIFY statusUpdated)
    Q_PROPERTY(int LatencyMs READ latencyMs NOTIFY statusUpdated)
    Q_PROPERTY(int QueueDepth READ queueDepth NOTIFY statusUpdated)
    Q_PROPERTY(int ActiveRequests READ activeRequests NOTIFY statusUpdated)
    Q_PROPERTY(int FailedRequests READ failedRequests NOTIFY statusUpdated)
    Q_PROPERTY(bool QueuePaused READ queuePaused NOTIFY statusUpdated)
    Q_PROPERTY(int UsageToday READ usageToday NOTIFY statusUpdated)
    Q_PROPERTY(int UsageMonth READ usageMonth NOTIFY statusUpdated)
    Q_PROPERTY(double UsageTodayCost READ usageTodayCost NOTIFY statusUpdated)
    Q_PROPERTY(double UsageMonthCost READ usageMonthCost NOTIFY statusUpdated)

    QString state() const { return m_gw->state(); }
    QString endpointUrl() const { return m_gw->endpointUrl(); }
    QString model() const { return m_gw->model(); }
    int latencyMs() const { return m_gw->latencyMs(); }
    int queueDepth() const { return m_gw->queueDepth(); }
    int activeRequests() const { return m_gw->activeRequests(); }
    int failedRequests() const { return m_gw->failedRequests(); }
    bool queuePaused() const { return m_gw->queuePaused(); }
    int usageToday() const;
    int usageMonth() const;
    double usageTodayCost() const { return 0.0; } // rates land with the KCM
    double usageMonthCost() const { return 0.0; }

public slots:
    Q_INVOKABLE QString chat(const QVariantMap &req);
    Q_INVOKABLE void cancel(const QString &requestId);
    Q_INVOKABLE QList<QVariant> models();
    Q_INVOKABLE void reloadModel(const QString &model);
    Q_INVOKABLE void unloadModel();
    Q_INVOKABLE void setDefaultModel(const QString &model);
    Q_INVOKABLE int testModel(const QString &model);
    Q_INVOKABLE QList<QVariant> diagnostics();
    Q_INVOKABLE QList<QVariant> usageRange(quint64 startMs, quint64 endMs);
    Q_INVOKABLE QList<QVariant> logs(const QString &app, int n);
    Q_INVOKABLE void pauseQueue();
    Q_INVOKABLE void resumeQueue();

signals:
    void statusUpdated();
    void statusChanged(const QString &state);
    void requestUpdated(const QString &requestId, const QString &state);
    void chatDelta(const QString &requestId, const QString &delta);
    void chatDone(const QString &requestId, const QString &content,
                  const QJsonArray &toolCalls, const QJsonObject &usage);
    void chatError(const QString &requestId, const QString &code, const QString &message);
    void modelsReady(const QJsonArray &models);
    void testModelDone(const QString &model, int latencyMs);

private:
    void raise(const QString &code, const QString &msg);
    aiarch::Gateway *m_gw;
};
