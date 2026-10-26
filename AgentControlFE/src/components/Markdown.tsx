import { useMemo } from 'react'
import { renderMarkdown, type TextRenderer } from '../lib/markdown-render.ts'

/** FE-9: an assistant reply with the safe markdown subset (see lib/markdown.ts). FE-6: `text` styles @mentions. */
export function Markdown({ text, renderText }: { text: string; renderText?: TextRenderer }) {
  return useMemo(() => renderMarkdown(text, renderText), [text, renderText])
}
