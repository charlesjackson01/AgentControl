# 0002: Key-only access; secrets never in the repo

Date: 2026-08-23 (ratified at T0, 2026-08-25)

## Context

Automation drives everything (install, maintenance, verify). Any password or
token flowing through a command risks leaking into logs or transcripts.

## Decision

- SSH is key-only in practice: the owner ed25519 key is authorized for `archdev`
  and `root`; `PermitRootLogin prohibit-password`; the account password exists
  only as a first-boot/console fallback.
- The preseed embeds only the PUBLIC owner key (`custom_commands`). Passwords
  live in `preseed/archinstall-creds.json` (mode 600, gitignored) and are scp'd
  straight through — never printed.
- Tailscale auth keys are one-off, passed via an SSH session, never written to
  disk, the VM, or git (see 0006).
- The host approval gate blocks piping sudo passwords into commands.

## Consequences

- No secret ever flows through the agent; the repo is publishable.
- First-boot recovery requires console/serial access.
- Any new node type follows the same pattern.
