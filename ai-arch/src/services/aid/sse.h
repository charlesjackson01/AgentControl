#pragma once
#include <QByteArray>
#include <QString>
#include <functional>

namespace aiarch {

struct SseEvent {
    QString event; // "" = default "message"
    QString data;
};

// Minimal Server-Sent-Events parser for OpenAI-compatible streaming
// (docs/AI-ARCHITECTURE.md §2/§5). Feed arbitrary byte chunks.
class SseParser {
public:
    // onEvent is called once per complete event. Returns true when
    // "data: [DONE]" has been seen.
    void feed(const QByteArray &chunk, const std::function<void(const SseEvent &)> &onEvent);
    bool done() const { return m_done; }

private:
    void dispatch(const std::function<void(const SseEvent &)> &onEvent);

    QByteArray m_lineBuf;
    QString m_event;
    QString m_data;
    bool m_done = false;
};

} // namespace aiarch
