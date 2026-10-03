# AgentControl UI redesign handoff

AgentControl is an existing project. Redesign the interface in place. Do not rename it, do not scaffold a new app, and do not replace working data, auth, or API calls. This pass is presentation and interaction.

Reference mock: `agentcontrol-ui.html`.

Native orchestration is out of scope. Preserve the current approval gates. Define native orchestration in a separate architecture milestone.

## Model

- Primary agent. One persistent agent. It is the everyday conversation and survives every project switch. It is not created per project.
- Agent library. Reusable specialist agents. The user creates and configures them. They exist before any project.
- Teams. A team is the membership of a project, assembled from library agents. There is no permanent team catalog and no team-creation screen.
- Project creation. Creates a real project directory, chooses agents from the library, and opens that project's team conversation.
- Skills. One shared catalog. Assignment is per agent. Tool permissions are a separate control from assignment.
- Memory. Three stores, never one blended transcript: primary-agent memory, specialist-agent memory, and project context.
- Execution. Show the existing approval gate before a tool runs. Do not invent a new orchestrator in this pass.

A direct message is never copied into a team thread. Project files and project context are shared by members of that project. Primary memory is not written into a project unless the user sends it there.

## Shell

Desktop is three columns.

1. Vertical rail, about 76px. Mark `AC` at top; clicking it opens Primary. Items, in order: Primary, Agents, Projects, Workspace, Skills, Settings. User avatar at the bottom. Icon plus a short label. Active item is a light fill, not a new color.
2. Secondary panel, about 300px. Section title, search, list for the selected rail item.
3. Main stage. Top bar with title, one-line context, and section actions. Then the screen.

Under 720px, the rail becomes a bottom bar and the secondary panel opens over the stage.

Visual system: near-black surfaces (`#070708`, `#101012`, `#161618`), borders at about 7% white, Inter, muted gray secondary text, IBM Plex Mono for model and file labels. Active pills and the send button are white with black text. No purple theme, no heavy gradients, no marketing page. The composer is a rounded dark pill.

## Primary

The home conversation.

- Always available. Switching projects does not clear it.
- Top bar says Primary and Everyday. It is not labeled as a team.
- Composer has no team pills. Placeholder: `Message the primary agent`.
- Its memory is the primary-agent store only.
- It can be added to a project from the member picker, but membership does not replace this thread.

## Agents

The library, not a team list.

- Secondary list is one row per specialist: name, role, model.
- Plus opens Create agent: name, role, model, system prompt. Saving adds it to the library. It is not added to a project until a project selects it.
- Selecting a row opens configuration, then a direct thread. Top bar says Direct.
- Configure covers model, prompt, skill assignments, tool permissions, and that agent's memory. These are separate sections.
- A direct reply never appears in a project transcript.

Sample specialists: Atlas, research. Codex, builder. Muse, design. Sentinel, ops. Grok remains the primary agent, not a library row.

## Projects

Each row is a project. Its team is the agents chosen for it.

- Secondary list: project name, directory, member count. Under the active project, list members so each can be opened as a direct message.
- Main stage: project cards, then the team thread.
- Composer pills: Team, then one pill per member. Team posts to the project thread. A member pill opens that agent's direct thread.
- Do not add a Teams item to the rail.

Create flow:

- Name, required.
- Directory, required. Creating the project creates this directory.
- Member picker from the library. At least one specialist. Primary is optional.
- Button label: Create project.
- Submit creates the directory, stores the membership, and opens the team conversation.

Sample projects: AgentControl at `~/AgentControl`, members Muse and Codex. Parking lot model at `~/lots/austin`, members Atlas and Sentinel. Hermes local at `~/hermes`, member Codex.

## Workspace

The real directory for the active project.

- Split view: file tree, then preview.
- Root is the project directory created with the project. Do not show a fake global file list.
- Selecting a file does not change who you are messaging.
- Top context names the directory and says members share it.

## Skills

Shared catalog. Assignment and permission are separate.

- Grid of skills: name, description, assigned agents, tool permission.
- Assign opens a picker of library agents. Assignment does not grant a tool.
- Tool permission is its own control: allow, ask, or deny. Ask uses the existing approval gate.
- A skill installed on the catalog is not automatically on every agent.

Sample: Web research assigned to Atlas, tool ask. Workspace files assigned to Codex, tool allow. Shell assigned to Sentinel, tool deny until changed.

## Memory

Three scopes, shown in Settings and on the matching object.

- Primary: only the everyday thread. Survives project switches.
- Specialist: one store per library agent. Used by that agent's direct thread and by that agent inside a team.
- Project: notes and decisions for that directory. Visible to members of that project. Not written into primary memory.

Do not merge the three into one context panel.

## Execution

Leave the current approval path in place.

- A tool set to ask shows the existing gate before it runs. Approve and deny stay where they are.
- Do not add a native orchestrator, planner, or handoff engine in this pass. Team replies can be sequential in the mock, but the architecture milestone owns real orchestration.

## Acceptance

- The product is still called AgentControl.
- Primary is reachable from the rail and is not cleared by a project switch.
- Creating an agent adds a library entry and does not create a project.
- Creating a project creates a directory, stores membership, and opens the team thread.
- There is no team catalog.
- Skill assignment and tool permission can differ on the same skill.
- Primary, specialist, and project memory are separate.
- Approval gates still fire. No new orchestrator shipped in this pass.
- Usable at 1280px and 390px.
