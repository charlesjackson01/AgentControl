import { useState } from 'react'
import type { SkillTool, ToolInfo } from '../lib/types'
import { MAX_SKILL_TOOLS, toggleTool } from '../lib/skill-tools'
import { ErrorState } from './States'

export default function ToolPicker({ selected, registry, loading, error, disabled, onRetry, onChange }: {
  selected: SkillTool[]
  registry: ToolInfo[] | undefined
  loading: boolean
  error: Error | undefined
  disabled: boolean
  onRetry: () => void
  onChange: (tools: SkillTool[]) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const visible = (registry ?? []).filter((tool) => `${tool.name} ${tool.description} ${tool.category} ${tool.effect}`.toLowerCase().includes(q))
  return (
    <div className="field">
      <p className="field__label">Tools <span className="pill">{selected.length} / {MAX_SKILL_TOOLS}</span></p>
      <p className="field__hint">Select the built-in capabilities agents can call with this skill. Write tools can change files or the bot&apos;s memory.</p>
      {selected.length > 0 && (
        <div className="chips" aria-label="Selected tools">
          {selected.map((tool) => {
            const legacy = registry !== undefined && !registry.some((entry) => entry.name === tool.name)
            return (
              <button type="button" className="chip chip--on" key={tool.name} disabled={disabled}
                aria-label={`Remove ${tool.name}${legacy ? ' (unavailable)' : ''}`}
                title={legacy ? 'Unavailable in the current registry. Kept until you remove it.' : tool.description}
                onClick={() => onChange(selected.filter((item) => item.name !== tool.name))}>
                {tool.name}{legacy ? ' (unavailable)' : ''} ×
              </button>
            )
          })}
        </div>
      )}
      {loading ? <p className="field__hint" role="status">Loading tools…</p> : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : (
        <>
          <input type="search" className="input" aria-label="Filter tools" placeholder="Filter tools by name or category…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="skillpick" role="group" aria-label="Available tools">
            {visible.map((tool) => {
              const checked = selected.some((item) => item.name === tool.name)
              return (
                <label className={`skillrow${checked ? ' skillrow--on' : ''}`} key={tool.name}>
                  <input type="checkbox" checked={checked} disabled={disabled || (!checked && selected.length >= MAX_SKILL_TOOLS)} onChange={() => onChange(toggleTool(selected, tool))} />
                  <span className="skillrow__text">
                    <span className="skillrow__name">{tool.name} <span className="pill">{tool.category}</span> <span className="pill">{tool.effect}</span></span>
                    <span className="skillrow__desc">{tool.description}</span>
                  </span>
                </label>
              )
            })}
            {visible.length === 0 && <p className="field__hint">No tools match.</p>}
          </div>
        </>
      )}
      {selected.length >= MAX_SKILL_TOOLS && <p className="field__hint">Remove a tool to select another.</p>}
    </div>
  )
}
