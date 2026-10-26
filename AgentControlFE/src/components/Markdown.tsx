import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown-render.ts'

/** FE-9: an assistant reply with the safe markdown subset (see lib/markdown.ts). */
export function Markdown({ text }: { text: string }) {
  return useMemo(() => renderMarkdown(text), [text])
}
