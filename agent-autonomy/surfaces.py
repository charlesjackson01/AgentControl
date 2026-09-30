"""Preview surfaces: what a run lets you look at, described for the dashboard's viewers.

A surface is something visual that belongs to a run: the live web preview, a command-line
program's output, a virtual desktop, the VM console. The built-in providers only *describe* what the
existing preview and VM code already serve, and point at the existing endpoints, so nothing is
duplicated and describing never starts or changes anything.

Other kinds plug in by registering a SurfaceProvider:
- 'browser-session': an agent's own headless browser (for example a researcher's)
- 'vnc': a VNC display (for example ai-arch's VM listening on 127.0.0.1)

No provider for those ships here, so nothing depends on ai-arch. A provider that serves its own
frames implements frame() and input(); the dashboard then reads them through /api/surface/frame and
/api/surface/input, behind the dashboard key, with every input recorded in the audit log.
Standard library only.
"""

PREVIEW_MODES = {'web': 'Web preview', 'static': 'Static page', 'cli': 'Program output', 'desktop': 'Desktop app'}
LIVE = ('starting', 'running')


class SurfaceProvider:
    """One kind of surface. describe() returns a list of surface dicts for a run (usually 0 or 1)."""
    kind = ''

    def describe(self, run, ctx):
        return []

    def frame(self, run, surface_id):
        """PNG bytes of the surface now. Only for providers whose descriptors set frame='surface'."""
        raise ValueError('This surface has no frames')

    def input(self, run, surface_id, action, **fields):
        """Pass your click, text or key on to the surface. Only when interactive."""
        raise ValueError('This surface does not take input')


def surface(sid, kind, title, state, *, interactive=False, frame=None, input=None, agents='all', note=''):
    """A descriptor. frame and input name where the dashboard gets frames and sends input:
    'preview' and 'vm' are the existing endpoints; 'surface' is the generic route for providers."""
    return {'id': sid, 'kind': kind, 'title': title, 'state': state, 'interactive': interactive,
            'frame': frame, 'input': input, 'agents': agents, 'note': note}


class PreviewProvider(SurfaceProvider):
    """The run's live preview (web, static, cli, desktop), from PreviewManager.status()."""
    kind = 'preview'

    def describe(self, run, ctx):
        spec = run.get('preview') or {}
        mode = spec.get('mode')
        if mode not in PREVIEW_MODES:
            return []
        status = ctx.get('preview') or {}
        mine = status.get('run') == run['id']
        state = status.get('state', 'idle') if mine else 'idle'
        kind = {'web': 'web', 'static': 'web', 'cli': 'terminal', 'desktop': 'desktop'}[mode]
        return [surface('preview', kind, PREVIEW_MODES[mode], state,
                        interactive=kind in ('desktop', 'terminal') and state in LIVE,
                        frame='preview' if kind == 'desktop' else None, input='preview' if kind in ('desktop', 'terminal') else None,
                        note=spec.get('command') or spec.get('path') or '')]


class VMConsoleProvider(SurfaceProvider):
    """The run VM's screen through libvirt (M13), only while the VM runs."""
    kind = 'vm-console'

    def describe(self, run, ctx):
        vm = ctx.get('vm')
        if not vm or vm.get('live') != 'running':
            return []
        return [surface('vm', 'vm-console', 'VM screen', 'running', interactive=True, frame='vm', input='vm', note=vm.get('name', ''))]


class Registry:
    def __init__(self, providers=()):
        self.providers = list(providers)

    def register(self, provider):
        self.providers.append(provider)
        return provider

    def describe(self, run, ctx):
        """Every surface of a run. A provider that fails is skipped: viewing must never break state."""
        if not run:
            return []
        found = []
        for provider in self.providers:
            try:
                for item in provider.describe(run, ctx) or []:
                    found.append({**item, 'provider': provider.kind})
            except Exception:
                continue
        return found

    def find(self, run, ctx, surface_id):
        """(provider, descriptor) for a surface served through the generic route."""
        for provider in self.providers:
            for item in provider.describe(run, ctx) or []:
                if item['id'] == surface_id and 'surface' in (item.get('frame'), item.get('input')):
                    return provider, item
        raise KeyError(surface_id)


def default_registry():
    return Registry([PreviewProvider(), VMConsoleProvider()])
