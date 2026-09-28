#include <QtTest>
#include "sse.h"

using namespace aiarch;

class TSse : public QObject
{
    Q_OBJECT
private slots:
    void singleEvent();
    void multiLineData();
    void splitAcrossChunks();
    void doneSentinel();
    void namedEvent();
    void crlf();
};

static QList<SseEvent> collect(const QByteArray *chunks[], int n)
{
    SseParser p;
    QList<SseEvent> out;
    for (int i = 0; i < n; ++i)
        p.feed(*chunks[i], [&](const SseEvent &e) { out.append(e); });
    return out;
}

void TSse::singleEvent()
{
    const QByteArray c1 = "data: {\"x\":1}\n\n";
    const QByteArray *chunks[] = {&c1};
    const auto out = collect(chunks, 1);
    QCOMPARE(out.size(), 1);
    QCOMPARE(out.first().data, QStringLiteral("{\"x\":1}"));
    QVERIFY(!SseParser().done());
}

void TSse::multiLineData()
{
    const QByteArray c1 = "data: line1\ndata: line2\n\n";
    const QByteArray *chunks[] = {&c1};
    const auto out = collect(chunks, 1);
    QCOMPARE(out.size(), 1);
    QCOMPARE(out.first().data, QStringLiteral("line1\nline2"));
}

void TSse::splitAcrossChunks()
{
    const QByteArray c1 = "data: hel";
    const QByteArray c2 = "lo world\n\nda";
    const QByteArray c3 = "ta: [DONE]\n\n";
    SseParser p;
    QList<SseEvent> out;
    for (const QByteArray *c : {&c1, &c2, &c3})
        p.feed(*c, [&](const SseEvent &e) { out.append(e); });
    QCOMPARE(out.size(), 1);
    QCOMPARE(out[0].data, QStringLiteral("hello world"));
    QVERIFY(p.done());
}

void TSse::doneSentinel()
{
    const QByteArray c1 = "data: [DONE]\n\n";
    const QByteArray *chunks[] = {&c1};
    const auto out = collect(chunks, 1);
    // [DONE] is not an emitted event
    QCOMPARE(out.size(), 0);
    SseParser p;
    p.feed(c1, [](const SseEvent &) {});
    QVERIFY(p.done());
}

void TSse::namedEvent()
{
    const QByteArray c1 = "event: custom\ndata: payload\n\n";
    const QByteArray *chunks[] = {&c1};
    const auto out = collect(chunks, 1);
    QCOMPARE(out.size(), 1);
    QCOMPARE(out.first().event, QStringLiteral("custom"));
    QCOMPARE(out.first().data, QStringLiteral("payload"));
}

void TSse::crlf()
{
    const QByteArray c1 = "data: abc\r\n\r\n";
    const QByteArray *chunks[] = {&c1};
    const auto out = collect(chunks, 1);
    QCOMPARE(out.size(), 1);
    QCOMPARE(out.first().data, QStringLiteral("abc"));
}

QTEST_MAIN(TSse)
#include "t_sse.moc"
