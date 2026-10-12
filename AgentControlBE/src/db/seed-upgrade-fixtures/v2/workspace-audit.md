---
name: workspace-audit
description: Inspect workspace agents, their setup, available skills, and recent run results using read-only local tools. Use for a grounded inventory, a team status snapshot, or diagnosis of recent agent activity.
tools: list_agents, list_skills, read_run_log, get_agent, workspace_overview
---

# Workspace Audit

Provide a concise, evidence-based view of the current AgentControl workspace and selected recent runs.

## Workflow

1. For a team-wide question, call `workspace_overview` first: it returns each agent's status, run count and recent failures (of its last 10 runs), endpoint status, and skill and note counts in one call.
2. For one agent's setup, call `get_agent` with its name or ID: role, instructions, endpoint name and status, model, skills and the tools they declare. Use `list_agents` or `list_skills` when you need the full roster or catalog.
3. To explain failures, call `read_run_log` with that `agentId` and a small `limit`; omit `agentId` only when the current agent is intended.
4. Report observed statuses, timing, and errors. Separate facts returned by the tools from possible causes that still need investigation, then give practical next steps. If the roster or log is empty, state that directly.

## Example

For "Why did Researcher fail recently?", call `workspace_overview({})` to see whether failures are isolated, then `get_agent({"agentId":"Researcher"})` and `read_run_log({"agentId":"Researcher","limit":3})`. Summarize the returned errors and affected runs without guessing endpoint settings or credentials.

## Limits

These tools inspect records only. They cannot launch, delegate to, pause, or reconfigure agents. Endpoint URLs, model lists and keys are never shown. Recent logs are bounded and text fields may be clipped; missing details are not evidence that an event did not occur.
