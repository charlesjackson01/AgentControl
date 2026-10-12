---
name: workspace-audit
description: Inspect workspace agents, available skills, and recent run results using read-only local tools. Use for a grounded inventory or diagnosis of recent agent activity.
tools: list_agents, list_skills, read_run_log
---

# Workspace Audit

Provide a concise, evidence-based view of the current AgentControl workspace and selected recent runs.

## Workflow

1. Call `list_agents` for the current roster and `list_skills` for the available skill catalog as needed for the user's question.
2. Identify the relevant agent by returned ID. Call `read_run_log` with that `agentId` and a small `limit` to inspect recent activity; omit `agentId` only when the current agent is intended.
3. Report observed statuses, timing, and errors. Separate facts returned by the tools from possible causes that still need investigation.
4. Give practical next steps for the user based on those observations. If the roster or log is empty, state that directly.

## Example

For “Why did Researcher fail recently?”, first call `list_agents({})`, then `read_run_log({"agentId":"Researcher","limit":3})` if that agent exists. Summarize the returned errors and affected runs without guessing endpoint settings or credentials.

## Limits

These tools inspect records only. They cannot launch, delegate to, pause, or reconfigure agents. The skill catalog shows availability, not which skills an agent has enabled. Recent logs are bounded and text fields may be clipped; missing details are not evidence that an event did not occur. No filesystem, shell, network, API keys, or endpoint configuration is exposed by this workflow.
