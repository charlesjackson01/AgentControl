import { INTERNET_POLICY_LABELS, agentChatFirstFields, botFolder } from '../../lib/agent-put'
import type { Agent } from '../../lib/types'

/** Files and Sandbox (03d, 03e) are FE-4. Show what BE-1 already knows, and nothing fake. */
export default function PlaceholderTab({ tab, agent }: { tab: 'files' | 'sandbox'; agent: Agent }) {
  const { slug, internetPolicy } = agentChatFirstFields(agent)
  const folder = botFolder(slug)
  return (
    <div className="cf-set__stack">
      <section className="cf-card cf-placeholder">
        <h3 className="cf-card__title">{tab === 'files' ? 'Files' : 'Sandbox'}</h3>
        <p className="cf-card__hint">
          {tab === 'files'
            ? `Browsing, uploading and previewing ${agent.name}'s files arrives with FE-4 (needs BE-2).`
            : `Coming soon. The bot VM, run limits and run history need BE-8; the VM itself is Phase 2.`}
        </p>
        <dl className="cf-kv">
          {tab === 'files' ? (
            <>
              <dt>Private folder</dt>
              <dd>{folder ? <code>{folder}</code> : 'Not reported by this server yet'}</dd>
            </>
          ) : (
            <>
              <dt>Internet for scripts</dt>
              <dd>{INTERNET_POLICY_LABELS[internetPolicy]}</dd>
            </>
          )}
        </dl>
      </section>
    </div>
  )
}
