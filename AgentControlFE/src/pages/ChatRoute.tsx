import { useParams } from 'react-router-dom'
import ConversationChat from './ConversationChat'
import GroupChat from './GroupChat'
import type { ConversationSummary, GroupConversation } from '../lib/types'
import { useConversations } from '../state/conversations-context'

/** `/c/:id`: a group thread (FE-6) or a DM. Unknown or still loading: the DM view handles both states. */
export default function ChatRoute() {
  const { conversationId = '' } = useParams()
  const { conversations } = useConversations()
  const c = conversations?.find((x) => x.id === conversationId)
  if (c?.kind === 'group') return <GroupChat key={c.id} group={c as ConversationSummary & GroupConversation} />
  return <ConversationChat />
}
