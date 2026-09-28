#include <QtTest>
#include <QCoreApplication>
#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>
#include <QHash>
#include "gateway.h"

using namespace aiarch;

// Minimal OpenAI-compatible fake backend for gateway tests.
class FakeBackend : public QObject
{
    Q_OBJECT
public:
    QString mode = QStringLiteral("ok"); // ok | fail-midstream
    int port() const { return m_server.serverPort(); }
    bool start()
    {
        connect(&m_server, &QTcpServer::newConnection, this, &FakeBackend::onNewConnection);
        return m_server.listen(QHostAddress::LocalHost, 0);
    }
    void stop() { m_server.close(); }

private slots:
    void onNewConnection()
    {
        auto *socket = m_server.nextPendingConnection();
        connect(socket, &QTcpSocket::readyRead, this,
                [this, socket] { handleRead(socket); });
        connect(socket, &QTcpSocket::disconnected, socket, &QTcpSocket::deleteLater);
    }

private:
    void handleRead(QTcpSocket *socket)
    {
        auto it = m_bufs.find(socket);
        if (it == m_bufs.end()) {
            m_bufs.insert(socket, QByteArray());
            it = m_bufs.find(socket);
        }
        it.value() += socket->readAll();
        const int hdrEnd = it.value().indexOf("\r\n\r\n");
        if (hdrEnd < 0)
            return;
        int contentLength = 0;
        const QByteArray head = it.value().left(hdrEnd);
        for (const QByteArray &line : head.split('\n')) {
            if (line.trimmed().toLower().startsWith("content-length:"))
                contentLength = line.split(':').last().trimmed().toInt();
        }
        if (it.value().size() < hdrEnd + 4 + contentLength)
            return;
        const QByteArray req = it.value();
        m_bufs.remove(socket);
        respond(socket, req);
    }

    void respond(QTcpSocket *socket, const QByteArray &req)
    {
        const QString line1 = QString::fromUtf8(req).section('\n', 0, 0);
        const QString path = line1.section(' ', 1, 1);

        if (path.contains("/v1/models")) {
            const QByteArray body = R"({"data":[{"id":"test-model"}]})";
            socket->write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                          "Content-Length: " + QByteArray::number(body.size()) + "\r\n\r\n" + body);
            socket->disconnectFromHost();
        } else if (path.contains("/v1/chat/completions")) {
            socket->write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
            if (mode == "fail-midstream") {
                sseChunk(socket, "par");
                socket->disconnectFromHost(); // abrupt: no [DONE]
            } else {
                sseChunk(socket, "Hel");
                sseChunk(socket, "lo ");
                sseChunk(socket, "world");
                socket->write("data: [DONE]\n\n");
                socket->disconnectFromHost();
            }
        } else {
            socket->write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            socket->disconnectFromHost();
        }
    }

    static void sseChunk(QTcpSocket *s, const char *content)
    {
        s->write("data: {\"choices\":[{\"delta\":{\"content\":\"" + QByteArray(content)
                + "\"}}]}\n\n");
    }

    QTcpServer m_server;
    QHash<QTcpSocket *, QByteArray> m_bufs;
};

class TGateway : public QObject
{
    Q_OBJECT
private slots:
    void initTestCase();
    void chatStreamsContent();
    void disabledRejects();
    void notConfiguredRejects();
    void emptyMessagesReject();
    void cancelQueued();
    void killSwitchCancelsInFlight();
    void midStreamFailureReportsError();

private:
    QJsonArray userMsg(const QString &text)
    {
        QJsonObject m;
        m["role"] = "user";
        m["content"] = text;
        return {m};
    }
    AiArchConfig baseConfig(const FakeBackend &b, bool enabled = true)
    {
        AiArchConfig c;
        c.aiEnabled = enabled;
        c.endpoint.url = QStringLiteral("http://127.0.0.1:%1").arg(b.port());
        c.endpoint.model = QStringLiteral("test-model");
        return c;
    }

    FakeBackend m_backend;
    Gateway m_gw;
};

void TGateway::initTestCase()
{
    QVERIFY(m_backend.start());
    m_gw.start();
}

void TGateway::chatStreamsContent()
{
    m_gw.applyConfig(baseConfig(m_backend));
    QSignalSpy deltas(&m_gw, &Gateway::chatDelta);
    QSignalSpy done(&m_gw, &Gateway::chatDone);

    QString err;
    const QString id = m_gw.chat("testapp", "chat1", userMsg("hi"), QString(), 0, 0.0,
                                 QJsonArray(), QString(), &err);
    QVERIFY2(!id.isEmpty(), qPrintable(err));
    QTRY_COMPARE_WITH_TIMEOUT(done.count(), 1, 5000);

    QCOMPARE(done.at(0).at(0).toString(), id);
    QCOMPARE(done.at(0).at(1).toString(), QStringLiteral("Hello world"));
    QCOMPARE(deltas.count(), 3);
    QCOMPARE(m_gw.queueDepth(), 0);
}

void TGateway::disabledRejects()
{
    m_gw.applyConfig(baseConfig(m_backend, /*enabled=*/false));
    QString err;
    const QString id = m_gw.chat("testapp", "chat1", userMsg("hi"), QString(), 0, 0.0,
                                 QJsonArray(), QString(), &err);
    QVERIFY(id.isEmpty());
    QCOMPARE(err, QStringLiteral("Disabled"));
}

void TGateway::notConfiguredRejects()
{
    AiArchConfig c = baseConfig(m_backend);
    c.endpoint.url.clear();
    m_gw.applyConfig(c);
    QString err;
    const QString id = m_gw.chat("testapp", "chat1", userMsg("hi"), QString(), 0, 0.0,
                                 QJsonArray(), QString(), &err);
    QVERIFY(id.isEmpty());
    QCOMPARE(err, QStringLiteral("NotConfigured"));
}

void TGateway::emptyMessagesReject()
{
    m_gw.applyConfig(baseConfig(m_backend));
    QString err;
    const QString id = m_gw.chat("testapp", "chat1", QJsonArray(), QString(), 0, 0.0,
                                 QJsonArray(), QString(), &err);
    QVERIFY(id.isEmpty());
    QCOMPARE(err, QStringLiteral("ValidationError"));
}

void TGateway::cancelQueued()
{
    m_gw.applyConfig(baseConfig(m_backend));
    QSignalSpy done(&m_gw, &Gateway::chatDone);
    QSignalSpy updated(&m_gw, &Gateway::requestUpdated);

    m_gw.pauseQueue();
    QString err;
    const QString id1 = m_gw.chat("testapp", "c", userMsg("one"), QString(), 0, 0.0,
                                  QJsonArray(), QString(), &err);
    const QString id2 = m_gw.chat("testapp", "c", userMsg("two"), QString(), 0, 0.0,
                                  QJsonArray(), QString(), &err);
    QVERIFY(!id1.isEmpty() && !id2.isEmpty());
    QCOMPARE(m_gw.queueDepth(), 2);

    m_gw.cancel(id1);
    QCOMPARE(m_gw.queueDepth(), 1);
    QList<QList<QVariant>> cancelled;
    for (const auto &row : updated) {
        if (row.at(0).toString() == id1 && row.at(1).toString() == "cancelled")
            cancelled.append(row);
    }
    QCOMPARE(cancelled.count(), 1);

    m_gw.resumeQueue();
    QTRY_COMPARE_WITH_TIMEOUT(done.count(), 1, 5000);
    QCOMPARE(done.at(0).at(0).toString(), id2);
}

void TGateway::killSwitchCancelsInFlight()
{
    m_gw.applyConfig(baseConfig(m_backend));
    QSignalSpy errSpy(&m_gw, &Gateway::chatError);
    QSignalSpy updated(&m_gw, &Gateway::requestUpdated);

    QString err;
    const QString id = m_gw.chat("testapp", "c", userMsg("hi"), QString(), 0, 0.0,
                                 QJsonArray(), QString(), &err);
    QTRY_COMPARE_WITH_TIMEOUT(updated.count(), 2, 5000); // queued + streaming
    QCOMPARE(updated.at(1).at(1).toString(), QStringLiteral("streaming"));

    m_backend.stop();
    m_gw.applyConfig(baseConfig(m_backend, /*enabled=*/false));

    QTRY_COMPARE_WITH_TIMEOUT(errSpy.count(), 1, 5000);
    QCOMPARE(errSpy.at(0).at(0).toString(), id);
    QCOMPARE(errSpy.at(0).at(1).toString(), QStringLiteral("cancelled"));
    QCOMPARE(m_gw.queueDepth(), 0);
    QCOMPARE(m_gw.activeRequests(), 0);
}

void TGateway::midStreamFailureReportsError()
{
    m_backend.mode = QStringLiteral("fail-midstream");
    m_gw.applyConfig(baseConfig(m_backend));
    QSignalSpy errSpy(&m_gw, &Gateway::chatError);

    QString err;
    const QString id = m_gw.chat("testapp", "c", userMsg("hi"), QString(), 0, 0.0,
                                 QJsonArray(), QString(), &err);
    QVERIFY(!id.isEmpty());
    QTRY_COMPARE_WITH_TIMEOUT(errSpy.count(), 1, 5000);
    QCOMPARE(errSpy.at(0).at(1).toString(), QStringLiteral("backend"));

    m_backend.mode = QStringLiteral("ok");
}

QTEST_MAIN(TGateway)
#include "t_gateway.moc"
