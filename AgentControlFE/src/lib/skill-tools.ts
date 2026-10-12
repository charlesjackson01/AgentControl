import type { SkillTool, ToolInfo } from './types'

/** Keep legacy declarations intact; only newly selected tools come from the registry. */
export function toggleTool(selected: SkillTool[], tool: ToolInfo): SkillTool[] {
  if (selected.some((item) => item.name === tool.name)) return selected.filter((item) => item.name !== tool.name)
  return [...selected, { name: tool.name, description: tool.description, parameters: tool.parameters }]
}

export const MAX_SKILL_TOOLS = 16

/** Import accepts at most 16 known tools; unrecognized names are reported, not saved. */
export function classifyImportTools(names: string[], registry: ToolInfo[]) {
  const known = new Set(registry.map((tool) => tool.name))
  const tools: string[] = []
  const ignored: string[] = []
  for (const name of new Set(names)) {
    if (known.has(name) && tools.length < MAX_SKILL_TOOLS) tools.push(name)
    else ignored.push(name)
  }
  return { tools, ignored }
}
