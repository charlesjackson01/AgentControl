# Chat-first AgentControl — implementation handoff (draft)

Status: APPROVED FOR IMPLEMENTATION (2026-10-16). D-C1…D-C6 confirmed as recommended.
Base: master at a64b0f2 (orchestration Parts 1–6 complete).

## Goal

AgentControl becomes chat-first, like Grok Bot or Meta's assistant apps.
Every agent has a profile (name, avatar, description, rules, memory) and its
own 1:1 chat. Primary is the user's personal agent in its 1:1 and still
orchestrates projects. Projects appear as group chats.

## Decisions (owner to confirm)

- D-C1: Default landing is Primary's 1:1 chat. Recommended: yes.
- D-C2: `rules: string[]` kept separate from `instructions` (persona).
  Recommended: yes, rules get their own prompt section and budget line.
- D-C3: Memory is per agent (`MemoryFact` with agentId), with an optional
  later "shared user facts" scope. Recommended: per agent now.
- D-C4: Primary may read project results from its 1:1 only when asked
  (via existing read_run_log scoped by projectId). Recommended: on request,
  not injected by default, to protect the 8k window.
- D-C5: Avatars are emoji or uploaded image stored in `data/avatars/`,
  never inline in store.json. Recommended: yes, initials fallback.
- D-C6: Project chats stay on `ProjectMessage` this milestone; moving them
  onto `Conversation` is a later milestone. Recommended: yes.

## Backend

- Agent: `avatar?: { kind: 'emoji' | 'image'; value: string }`,
  `rules?: string[]`, `color?`, `pinned?`, `hidden?`.
- `GET/PUT/DELETE /api/agents/:id/avatar` (image file in data/avatars/).
- `MemoryFact { id, agentId, text, source: 'user' | 'agent', createdAt }`;
  `GET/POST/DELETE /api/agents/:id/memory`; `remember` / `forget` tools.
  System prompt gets newest facts trimmed to budget.
- `Conversation { id, kind: 'dm' | 'project', agentId?, projectId?,
  lastReadAt?, createdAt }` and `ChatMessage { id, conversationId,
  author: 'user' | agentId, text, runId?, mentions?, createdAt }`.
  One DM per agent, created lazily. Runs record `conversationId`; DM history
  comes from messages, not runs.
- Routes: `GET /api/conversations` (includes project chats, each with
  last message preview and unread count, one request for the sidebar),
  `GET /api/conversations/:id/messages?before=`,
  `POST /api/conversations/:id/messages` → `{ conversation, messages }`,
  `POST /api/conversations/:id/read`.
- Primary in its DM: rules, memory, normal tools; starting a project or
  tagging a teammate goes through the existing team-plan confirm card (D-P1).
- First store schema bump: migrate each agent's non-project runs into its
  DM conversation. Fixture test like seed-upgrade.

## Frontend

- Sidebar becomes a chat list: Primary pinned, agents, project group chats;
  avatar, last message, unread. Skills, Notes, Settings move to a footer
  menu; footer shows the owner's real name (drop hardcoded "Casey Jack").
- Default route → Primary's DM.
- AgentChat becomes the DM screen for every agent (TurnAudit kept), with a
  header (avatar, name) that opens the profile panel.
- Move MentionText / MentionPicker into components/.
- Split ProjectChat.tsx into PlanCard, TaskAssignment, WorkBar, WhatItSaw,
  AddAgentsDialog; share the message list with AgentChat.
- AgentForm + SettingsDrawer become the profile panel: name, avatar picker,
  description, rules editor, memory list.
- New: Avatar (initials fallback), sidebar row preview.
- Agents and Projects index pages fold into the sidebar ("New agent",
  "New group chat").

## Sequencing

1. Part 0: this doc approved.
2. Part 1 (BE): profile fields, avatar routes, rules in prompt. (FE): Avatar
   component, profile panel against the contract.
3. Part 2 (BE): Conversation/ChatMessage, routes, migration. (FE): sidebar
   chat list, DM screen, default route.
4. Part 3: memory facts, tools, memory list UI.
5. Part 4: ProjectChat split and shared message list; Primary DM → project
   hand-off through the confirm card.
6. Part 5: screenshots, live 8k check over Tailscale, README routes.

Verify every part with the existing commands in HANDOFF.md.
