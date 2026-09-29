"""Permission classes for agent requests (adapted from ai-arch docs/SECURITY.md).

Every OpenCode permission request gets a risk class:
  R0 readonly   inspect only
  R1 low        reversible, user-visible, not sensitive
  R2 sensitive  changes files, runs commands, reaches the network
  R3 critical   destructive, privileged, credential-touching, or unrecognised

Rules that keep the person in charge:
  * The class and the impact text come from this registry, never from the model.
  * Nothing is approved automatically by default; every request is asked.
  * Critical requests need a typed confirmation, and can never be remembered.
  * An approval can be remembered only for identical requests, only within one run,
    and only for low or sensitive requests. The class is re-checked at match time.
Standard library only.
"""
import json
import re

LEVELS = {'readonly': 'R0', 'low': 'R1', 'sensitive': 'R2', 'critical': 'R3'}
LABELS = {'readonly': 'Read only', 'low': 'Low', 'sensitive': 'Sensitive', 'critical': 'Critical'}
CONFIRM_WORD = 'approve'

# Defaults per class: ask = one tap in the dashboard; confirm = typed confirmation.
POLICY = {'readonly': 'ask', 'low': 'ask', 'sensitive': 'ask', 'critical': 'confirm'}

# OpenCode permission types. Impact text is authored here, never generated.
REGISTRY = {
    'read': ('readonly', 'Reads a file. Nothing is changed.'),
    'list': ('readonly', 'Lists files. Nothing is changed.'),
    'glob': ('readonly', 'Searches file names. Nothing is changed.'),
    'grep': ('readonly', 'Searches file contents. Nothing is changed.'),
    'lsp': ('readonly', 'Asks the language server about the code. Nothing is changed.'),
    'todowrite': ('low', "Updates OpenCode's own task list. Project files are not changed."),
    'todoread': ('readonly', "Reads OpenCode's own task list."),
    'task': ('low', 'Starts an OpenCode sub-agent with the same permissions as this one.'),
    'skill': ('low', "Loads a skill's instructions into the agent's context. The skill's text is not checked by OpenCode."),
    'research': ('critical', 'Hermes browses the internet from your machine to answer one question, and reads what it finds. '
                             'Your question may reach search engines and websites.'),
    'edit': ('sensitive', 'Changes file contents in the project. Undo with git or a backup.'),
    'write': ('sensitive', 'Creates or overwrites a file in the project. Existing content is replaced.'),
    'patch': ('sensitive', 'Applies a patch that changes project files.'),
    'multiedit': ('sensitive', 'Makes several edits to project files at once.'),
    'bash': ('sensitive', 'Runs a shell command in the project folder. It can change files, install software, or reach the network.'),
    'webfetch': ('sensitive', 'Downloads a web page. Its content can carry instructions aimed at the agent.'),
    'websearch': ('sensitive', 'Searches the web. Results can carry instructions aimed at the agent.'),
    'codesearch': ('sensitive', 'Searches code on the internet. Results can carry instructions aimed at the agent.'),
    'doom_loop': ('sensitive', 'OpenCode repeated the same action several times. Approving lets it keep going.'),
    'external_directory': ('critical', 'Reaches files outside the project folder.'),
}
UNKNOWN_IMPACT = 'AgentControl does not recognise this kind of request, so it is treated as critical.'

# Shell commands that make a request critical, with the reason shown to the person.
CRITICAL_COMMANDS = [
    (r'(?<!git )\brm\s+((-\w+\s+)*-\w*[rR]\w*|(-\w+\s+)*--recursive)\b', 'recursive delete'),
    (r'(^|[;&|]\s*|\s)(sudo|su|doas|pkexec)\s', 'runs with administrator rights'),
    (r'\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b', 'downloads and runs a script'),
    (r'\bchmod\s+(-R\s+)?[0-7]*7{2,}', 'makes files writable by everyone'),
    (r'\b(chown|chmod)\s+-R\s', 'changes ownership or permissions recursively'),
    (r'\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b|\bdd\s+[^|]*\bof=', 'writes to a disk or partition'),
    (r'\b(shutdown|reboot|poweroff|halt)\b|\bsystemctl\s+(stop|disable|mask|poweroff|reboot)', 'stops or restarts the system or a service'),
    (r'\bgit\s+push\b[^;&|]*(\s-f\b|--force)', 'force-pushes and can overwrite remote history'),
    (r'\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)', 'discards uncommitted work'),
    (r'\bdocker\b.*(--privileged|-v\s*/var/run/docker\.sock|/var/run/docker\.sock)', 'gives a container control of the host'),
    (r'>\s*/(etc|boot|usr|bin|sbin|lib)/', 'writes to a system directory'),
    (r'\b(crontab\s+-|at\s+now)', 'schedules commands to run later'),
]

# Paths that hold credentials or keys (ai-arch privacy.excluded_paths, extended).
SECRET_PATHS = r'(~|\$HOME|/home/[^/\s]+|/root)?/?\.(ssh|gnupg|aws|kube|docker/config\.json)\b|\bid_(rsa|ed25519|ecdsa)\b|(^|/)\.env(\.|\b)|\b(credentials?|secrets?)\.(json|ya?ml|toml|txt)\b|\.(pem|key|p12|pfx)\b|keepassxc'


# Editing these would let an agent change its own permissions or tools (OpenCode reads them).
AGENT_CONFIG = r'(^|[\s/"\'])(opencode\.jsonc?|\.opencode/)'


def _text(packet):
    """The command and paths a request is about, from OpenCode's request and the tool input."""
    input_ = (packet.get('context') or {}).get('input') or {}
    meta = packet.get('metadata') or {}
    parts = [input_.get('command'), meta.get('command'), input_.get('filePath'), input_.get('path'),
             meta.get('filepath'), meta.get('filePath')]
    patterns = packet.get('patterns') or ([packet['pattern']] if isinstance(packet.get('pattern'), str) else [])
    parts += patterns if isinstance(patterns, list) else []
    return ' '.join(str(p) for p in parts if p)


def classify(packet):
    """Risk for one OpenCode request: class, R-level, label, impact (from the registry), and reasons."""
    if packet.get('kind') == 'question':
        return {'class': 'low', 'level': 'R1', 'label': LABELS['low'], 'permission': 'question',
                'impact': 'OpenCode is asking you a question. Your answer goes back to the agent.', 'reasons': [],
                'decision': POLICY['low'], 'remember_allowed': False}
    permission = str(packet.get('permission') or packet.get('type') or '')
    klass, impact = REGISTRY.get(permission, ('critical', UNKNOWN_IMPACT))
    reasons = [] if permission in REGISTRY else [f'unrecognised request type {permission!r}']
    text = _text(packet)
    if permission in ('bash',):
        for pattern, reason in CRITICAL_COMMANDS:
            if re.search(pattern, text):
                reasons.append(reason)
    if re.search(SECRET_PATHS, text, re.I):
        reasons.append('touches credentials or keys')
    if permission in ('edit', 'write', 'patch', 'multiedit', 'bash') and re.search(AGENT_CONFIG, text):
        reasons.append("changes the agent's own OpenCode configuration or permissions")
    if reasons and klass != 'critical':
        klass = 'critical'
    return {'class': klass, 'level': LEVELS[klass], 'label': LABELS[klass], 'permission': permission,
            'impact': impact, 'reasons': reasons, 'decision': POLICY[klass],
            'remember_allowed': klass in ('low', 'sensitive')}


def rule_for(packet):
    """The exact-match rule an approval would create: same permission, same command/paths."""
    return {'permission': str(packet.get('permission') or ''), 'match': _text(packet)}


def matching_rule(packet, rules):
    """A remembered rule that covers this request, or None. Critical requests never match.
    A rule that names an agent (skills you installed for one agent) covers only that agent."""
    risk = classify(packet)
    if packet.get('kind') != 'permission' or not risk['remember_allowed']:
        return None
    wanted = rule_for(packet)
    for rule in rules or []:
        if rule.get('agent') and rule['agent'] != packet.get('agent', 'coder-1'):
            continue
        if not rule.get('revoked') and rule.get('permission') == wanted['permission'] and rule.get('match') == wanted['match']:
            return rule
    return None


def canonical(entry):
    return json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
