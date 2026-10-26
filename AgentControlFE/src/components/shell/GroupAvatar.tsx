import Avatar from '../Avatar'
import { groupAvatarIds } from '../../lib/shell'
import type { Agent } from '../../lib/types'

/** Two overlapping member avatars (01a group rows, 02a switcher). */
export default function GroupAvatar({
  memberAgentIds,
  leadAgentId,
  agents,
  size = 'lg',
}: {
  memberAgentIds?: string[]
  leadAgentId?: string
  agents: Agent[]
  size?: 'lg' | 'sm'
}) {
  const ids = groupAvatarIds({ memberAgentIds, leadAgentId })
  return (
    <span className={`cf-gav cf-gav--${size}`} aria-hidden="true">
      {ids.map((id) => {
        const a = agents.find((x) => x.id === id)
        return (
          <Avatar key={id} name={a?.name ?? '?'} agentId={id} avatar={a?.avatar} color={a?.color} size={size === 'lg' ? 'sm' : 'xs'} decorative />
        )
      })}
    </span>
  )
}
