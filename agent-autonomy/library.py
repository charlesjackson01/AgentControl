"""N2 library and advisory project configuration. No execution or conversation service.

All metadata lives in the journal. Configuration audits contain identifiers and field names,
never names, roles, instructions, paths or other free text. Operations serialize validation
and writes with the Store lock; they do not take the engine's execution lock.
"""
from pathlib import Path
import secrets

from journal import now
import permissions
import projects
import sandbox

ENGINE_TYPES = ('coder', 'tester', 'reviewer', 'researcher')
AGENT_FIELDS = {'name', 'display_role', 'engine_type', 'model', 'instructions'}


def text(value, field, maximum=None, required=False, trim=False):
    if not isinstance(value, str):
        raise ValueError(f'{field} must be text')
    result = value.strip() if trim else value
    if required and not result or maximum is not None and len(result) > maximum:
        raise ValueError(f'{field} must contain ' + (f'1–{maximum} characters' if required and maximum else
                         'at least one character' if required else f'at most {maximum} characters'))
    return result


def identifiers(values, field):
    if not isinstance(values, list) or any(not isinstance(v, str) for v in values):
        raise ValueError(f'{field} must be a list of ids')
    return list(dict.fromkeys(values))


def host_allows(permission, config):
    return config == 'allow' if isinstance(config, str) else isinstance(config, dict) and config.get(permission, config.get('*')) == 'allow'


class Library:
    def __init__(self, controller):
        self.c, self.store = controller, controller.store

    def _get(self, table, ident):
        if not isinstance(ident, str):
            raise ValueError('An id is required')
        try:
            return self.store.record_get(table, ident)
        except KeyError as error:
            raise ValueError('Record not found') from error

    def _active_agent(self, ident):
        agent = self._get('library_agents', ident)
        if agent['archived']:
            raise ValueError('Archived agents cannot be changed or added')
        return agent

    def _audit(self, action, ids, fields):
        self.store.audit_append(None, {'actor': 'you', 'action': action, 'ids': ids, 'fields': sorted(fields)})

    def _validate_agent(self, body, current=None):
        allowed = AGENT_FIELDS | {'confirm', 'id'} | (set() if current else {'kind'})
        if set(body) - allowed:
            raise ValueError('Unknown agent fields')
        kind = current['kind'] if current else body.get('kind')
        if kind not in ('primary', 'specialist'):
            raise ValueError('kind must be primary or specialist')
        fields = {field: body.get(field, current.get(field) if current else '' if field in ('display_role', 'instructions') else None) for field in AGENT_FIELDS}
        fields['name'] = text(fields['name'], 'Name', 40, True, True)
        fields['display_role'] = text(fields['display_role'], 'Role', 40)
        fields['instructions'] = text(fields['instructions'], 'Instructions', 8000)
        if kind == 'specialist' and fields['engine_type'] not in ENGINE_TYPES:
            raise ValueError('Specialists need an engine type: coder, tester, reviewer or researcher')
        if kind == 'primary' and fields['engine_type'] is not None:
            raise ValueError('Primary has no engine type')
        agents = self.store.record_list('library_agents')
        if any(a['id'] != (current or {}).get('id') and not a['archived'] and a['name'].casefold() == fields['name'].casefold() for a in agents):
            raise ValueError('An active agent already has this name')
        if not current and kind == 'primary' and any(a['kind'] == 'primary' and not a['archived'] for a in agents):
            raise ValueError('Primary is already set up')
        model = fields['model']
        if model is not None:
            if not isinstance(model, str):
                raise ValueError('Model must be an endpoint id or null')
            endpoint = next((e for e in self.c.broker.endpoints if e['id'] == model), None)
            if endpoint is None:
                raise ValueError('Unknown model endpoint')
            if endpoint.get('paid') and (not current or 'model' in body) and str(body.get('confirm') or '').strip().lower() != permissions.CONFIRM_WORD:
                raise ValueError(f'Paid models send your prompts to an outside provider and cost money: type {permissions.CONFIRM_WORD} to confirm.')
        return {'kind': kind, **fields}

    def create_agent(self, body):
        with self.store.lock:
            values = self._validate_agent(body)
            stamp = now()
            agent = {'id': 'ag_' + secrets.token_hex(6), **values, 'created': stamp, 'updated': stamp, 'archived': None}
            self.store.record_put('library_agents', agent)
            self._audit('library.agent.create', {'agent': agent['id']}, AGENT_FIELDS | {'kind'})
            return agent

    def update_agent(self, body):
        with self.store.lock:
            current = self._active_agent(body.get('id'))
            fields = self._validate_agent(body, current)
            updated = {**current, **fields, 'updated': now()}
            self.store.record_put('library_agents', updated)
            self._audit('library.agent.update', {'agent': current['id']}, set(body) & AGENT_FIELDS)
            return updated

    def archive_agent(self, ident):
        with self.store.lock:
            current = self._active_agent(ident)
            if current['kind'] == 'primary':
                raise ValueError('Primary cannot be archived')
            stamp = now()
            updated = self.store.record_update('library_agents', ident, archived=stamp, updated=stamp)
            for member in self.store.record_list('memberships'):
                if member['agent'] == ident and member['active']:
                    self.store.record_update('memberships', member['id'], active=False, removed=stamp)
            for assignment in self.store.record_list('skill_assignments', ident):
                if assignment['active']:
                    self.store.record_update('skill_assignments', assignment['id'], active=False, updated=stamp)
            self._audit('library.agent.archive', {'agent': ident}, ['archived', 'memberships', 'skill_assignments'])
            return updated

    def read(self):
        with self.store.lock:
            assignments = self.store.record_list('skill_assignments')
            policies = self.store.record_list('tool_policies')
            agents = [{**a, 'skills': [s['skill'] for s in assignments if s['agent'] == a['id'] and s['active']],
                       'tool_policy': {p['permission']: p['mode'] for p in policies if p['agent'] == a['id']}}
                      for a in self.store.record_list('library_agents')]
            config = sandbox.host_permission()
            return {'agents': agents, 'primary': next((a for a in agents if a['kind'] == 'primary' and not a['archived']), None),
                    'engine_types': list(ENGINE_TYPES), 'models': [{'id': e['id'], 'paid': bool(e.get('paid'))} for e in self.c.broker.endpoints],
                    'permissions': [{'type': p, 'class': value[0], 'host_allows': bool(host_allows(p, config))} for p, value in permissions.REGISTRY.items()]}

    def projects(self):
        with self.store.lock:
            members = self.store.record_list('memberships')
            active = {a['id'] for a in self.store.record_list('library_agents') if not a['archived']}
            records = []
            for p in self.store.record_list('projects'):
                if p['archived']:
                    continue
                ids = [m['agent'] for m in members if m['project'] == p['id'] and m['active'] and m['agent'] in active]
                records.append({**p, 'current': p['path'] == str(self.c.s.project), 'members': ids, 'member_count': len(ids)})
            return {'root': str(self.c.projects_root()), 'projects': records}

    def _project_record(self, folder, name):
        path = str(folder.resolve())
        if any(p['path'] == path for p in self.store.record_list('projects')):
            raise ValueError('This folder is already registered')
        stamp = now()
        return {'id': 'pr_' + secrets.token_hex(6), 'path': path, 'name': name, 'created': stamp, 'updated': stamp, 'archived': None}

    def register(self, path, name=None):
        with self.store.lock:
            folder = projects.register(self.c.projects_root(), path)
            record = self._project_record(folder, name if name is not None else folder.name)
            self.store.record_put('projects', record)
            self._audit('project.register', {'project': record['id']}, ['path', 'name'])
            return record

    def create_project(self, name, path, member_ids):
        with self.store.lock:
            name = text(name, 'Name', required=True, trim=True)
            ids = identifiers(member_ids, 'Members')
            members = [self._active_agent(ident) for ident in ids]
            if not any(a['kind'] == 'specialist' for a in members):
                raise ValueError('Choose at least one active specialist')
            destination = projects.destination(self.c.projects_root(), path)
            self._project_record(destination, name)  # reject an already registered path before creating anything
            folder = projects.create(self.c.projects_root(), path)
            record = self._project_record(folder, name)
            self.store.record_put('projects', record)
            self._set_members(record['id'], ids, [])
            self._audit('project.create', {'project': record['id'], 'agents': ids}, ['path', 'name', 'memberships'])
            return record

    def _set_members(self, project, add, remove):
        stamp = now()
        for agent in add:
            ident = project + ':' + agent
            existing = next((m for m in self.store.record_list('memberships', project) if m['id'] == ident), None)
            self.store.record_put('memberships', {'id': ident, 'project': project, 'agent': agent, 'active': True,
                                                 'added': stamp if not existing or not existing['active'] else existing['added'], 'removed': None})
        for agent in remove:
            ident = project + ':' + agent
            existing = next((m for m in self.store.record_list('memberships', project) if m['id'] == ident), None)
            if existing and existing['active']:
                self.store.record_update('memberships', ident, active=False, removed=stamp)
        self.store.record_update('projects', project, updated=stamp)

    def members(self, project, add, remove):
        with self.store.lock:
            self._get('projects', project)
            add, remove = identifiers(add, 'Add'), identifiers(remove, 'Remove')
            if set(add) & set(remove):
                raise ValueError('An agent cannot be both added and removed')
            for ident in add:
                self._active_agent(ident)
            for ident in remove:
                self._get('library_agents', ident)
            current = {m['agent'] for m in self.store.record_list('memberships', project) if m['active']}
            specialists = {a['id'] for a in self.store.record_list('library_agents') if a['kind'] == 'specialist' and not a['archived']}
            after = (current | set(add)) - set(remove)
            if current & specialists and not after & specialists:
                raise ValueError('Keep at least one active specialist')
            self._set_members(project, add, remove)
            self._audit('project.members', {'project': project, 'add': add, 'remove': remove}, ['memberships'])
            return self._get('projects', project)

    def assign(self, body):
        with self.store.lock:
            agent, skill, assigned = body.get('agent'), body.get('skill'), body.get('assigned')
            self._active_agent(agent)
            if type(assigned) is not bool:
                raise ValueError('assigned must be true or false')
            if not isinstance(skill, str) or not any(s['name'] == skill and not s.get('error') for s in self.c.skill_library()):
                raise ValueError('Choose a valid catalogue skill')
            item = {'id': agent + ':' + skill, 'agent': agent, 'skill': skill, 'active': assigned, 'updated': now()}
            self.store.record_put('skill_assignments', item)
            self._audit('library.skill.assign', {'agent': agent, 'skill': skill}, ['active'])
            return item

    def policy(self, body):
        with self.store.lock:
            agent, permission, mode = body.get('agent'), body.get('permission'), body.get('mode')
            self._active_agent(agent)
            if not isinstance(permission, str) or permission not in permissions.REGISTRY:
                raise ValueError('Unknown permission type')
            if mode not in ('ask', 'deny'):
                raise ValueError('Tool policy must be ask or deny')
            item = {'id': agent + ':' + permission, 'agent': agent, 'permission': permission, 'mode': mode, 'updated': now()}
            self.store.record_put('tool_policies', item)
            self._audit('library.tool.policy', {'agent': agent, 'permission': permission}, ['mode'])
            return item
