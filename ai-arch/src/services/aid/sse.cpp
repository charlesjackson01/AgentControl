#include "sse.h"

namespace aiarch {

void SseParser::dispatch(const std::function<void(const SseEvent &)> &onEvent)
{
    if (m_data.isEmpty() && m_event.isEmpty())
        return;
    if (m_data == QStringLiteral("[DONE]")) {
        m_done = true;
        m_event.clear();
        m_data.clear();
        return;
    }
    SseEvent e;
    e.event = m_event;
    e.data = m_data;
    onEvent(e);
    m_event.clear();
    m_data.clear();
}

void SseParser::feed(const QByteArray &chunk, const std::function<void(const SseEvent &)> &onEvent)
{
    m_lineBuf += chunk;
    int idx;
    while ((idx = m_lineBuf.indexOf('\n')) >= 0) {
        QByteArray line = m_lineBuf.left(idx);
        m_lineBuf.remove(0, idx + 1);
        if (line.endsWith('\r'))
            line.chop(1);

        if (line.isEmpty()) {
            dispatch(onEvent);
            continue;
        }
        const QString s = QString::fromUtf8(line);
        if (s.startsWith("data:")) {
            QString d = s.mid(5).trimmed();
            if (!m_data.isEmpty())
                m_data += '\n';
            m_data += d;
        } else if (s.startsWith("event:")) {
            m_event = s.mid(6).trimmed();
        }
        // comments (: ...) and other fields ignored
    }
}

} // namespace aiarch
