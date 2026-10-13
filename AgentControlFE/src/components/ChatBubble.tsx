import type { ReactNode } from 'react'

/**
 * One chat bubble. The speaker header renders only when a name is provided —
 * 1:1 agent chats pass nothing; project chats pass the agent's name.
 */
export function Bubble({
  kind,
  speaker,
  label,
  children,
}: {
  kind: 'user' | 'assistant' | 'error'
  speaker?: string
  label?: string
  children: ReactNode
}) {
  const kindClass = kind === 'error' ? 'chat__bubble--assistant chat__bubble--error' : `chat__bubble--${kind}`
  return (
    <div className={`chat__bubble ${kindClass}`} aria-label={label}>
      {speaker && <div className="bubble__header">{speaker}</div>}
      {children}
    </div>
  )
}

/** Three-dot typing indicator inside an assistant bubble. */
export function TypingBubble({ label, speaker }: { label: string; speaker?: string }) {
  return (
    <Bubble kind="assistant" label={label} speaker={speaker}>
      <span className="typing" aria-hidden="true">
        <span className="typing__dot" />
        <span className="typing__dot" />
        <span className="typing__dot" />
      </span>
    </Bubble>
  )
}
