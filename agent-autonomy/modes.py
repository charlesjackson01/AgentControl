"""Auto mode (M8): choose between one coder and a team, transparently.

Rules decide the clear cases without calling the model; everything else goes to Hermes, whose
team proposal says "single" or "multi". Whatever Auto concludes:
  * a team never starts without your approval of its plan (the M7 approval step always runs);
  * an explicit choice in New run (single or team) is never overridden;
  * running as a single agent needs no approval, because it is what a normal run does.

Decision table (first matching row wins):
  1. not a usable git project                      -> single   (teams need worktrees)
  2. prompt limit below 3                          -> single   (no room for parallel tasks plus review)
  3. fewer than 2 independent parts in the brief   -> single   (nothing to split)
  4. one model slot, no verification command,
     fewer than 4 parts                            -> single   (agents would mostly wait on the model)
  5. otherwise                                     -> ask Hermes for a team plan (you approve it)
A "part" is an area of work named in the brief (UI, API, storage, CLI, tests, docs, ...) or a
separate bullet or numbered line. Standard library only.
"""
import re

AREAS = {
    'user interface': r'\b(ui|frontend|front-end|html|css|web page|webpage|page|view|dashboard|gui)\b',
    'API or server': r'\b(api|backend|back-end|server|endpoint|rest|http service)\b',
    'storage': r'\b(database|storage|persist\w*|sqlite|json file|save\w*)\b',
    'command line': r'\b(cli|command[- ]line|terminal app|argparse)\b',
    'tests': r'\b(tests?|unittest|pytest|test suite)\b',
    'documentation': r'\b(readme|docs|documentation|usage guide)\b',
    'packaging or build': r'\b(package|packaging|build script|dockerfile|ci pipeline)\b',
}
MIN_TEAM_PROMPTS = 3


def parts(goal, goal_checks=()):
    """Areas of work and list items found in the brief (and your goal checks)."""
    text = '\n'.join([goal] + list(goal_checks or []))
    areas = [name for name, pattern in AREAS.items() if re.search(pattern, text, re.I)]
    items = [line for line in text.splitlines() if re.match(r'\s*([-*•]|\d+[.)])\s+\S', line)]
    return areas, items


def decide(goal, goal_checks=(), verifier=(), max_steps=8, git_usable=True, slots=1):
    """{'mode': 'single'|'team', 'rule': n, 'reasons': [...], 'signals': {...}}. 'team' means
    "ask Hermes for a team plan"; Hermes may still judge one agent enough."""
    areas, items = parts(goal, goal_checks)
    count = max(len(areas), len(items))
    signals = {'areas': areas, 'list_items': len(items), 'parts': count, 'git': bool(git_usable),
               'max_steps': max_steps, 'model_slots': slots, 'verifier': bool(verifier)}

    def result(mode, rule, *reasons):
        return {'mode': mode, 'rule': rule, 'reasons': list(reasons), 'signals': signals}

    if not git_usable:
        return result('single', 1, 'Teams need a git project with a commit, because each agent works in its own worktree.')
    if max_steps < MIN_TEAM_PROMPTS:
        return result('single', 2, f'The prompt limit ({max_steps}) leaves no room for parallel tasks and a review; a team needs at least {MIN_TEAM_PROMPTS}.')
    if count < 2:
        found = f' (found: {areas[0]})' if areas else ''
        return result('single', 3, f'The brief names one area of work{found}, so there is nothing to split between agents.')
    if slots <= 1 and not verifier and count < 4:
        return result('single', 4, f'{count} parts, but your model server answers one agent at a time and there is no '
                      'verification command to run in parallel, so extra agents would mostly wait.')
    named = ', '.join(areas) if areas else f'{len(items)} listed items'
    return result('team', 5, f'The brief has {count} parts ({named}). Hermes will propose a team plan, or say one agent is enough.',
                  'A team never starts without your approval of its plan.')
