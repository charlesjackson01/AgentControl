"""N2 append-only records: preservation, downgrade, validation and advisory membership."""
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
import journal
import library
import projects
import capabilities


class MigrationN2Tests(unittest.TestCase):
    def test_v7_upgrade_preserves_every_row_and_old_build_opens_v8(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'journal.sqlite3'
            with patch.object(journal, 'MIGRATIONS', journal.MIGRATIONS[:7]):
                old = journal.Store(path)
                old.put('runs', {'id': 'old', 'goal': 'unchanged'})
                old.event('old', 'note', 'kept')
                old.audit_append('old', {'actor': 'you', 'action': 'kept'})
            with sqlite3.connect(path) as c:
                tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
                # Exercise preservation of every historical table, including those with no fixture rows yet.
                for table in tables:
                    if table == 'sqlite_sequence' or c.execute('SELECT count(*) FROM '+table).fetchone()[0]:
                        continue
                    columns=list(c.execute('PRAGMA table_info('+table+')'))
                    names=[column[1] for column in columns]
                    values=[1 if 'INT' in column[2].upper() else 1.0 if 'REAL' in column[2].upper() else '{}' if column[1]=='value' else 'old_'+table+'_'+column[1] for column in columns]
                    c.execute('INSERT INTO '+table+' ('+','.join(names)+') VALUES ('+','.join('?' for _ in names)+')',values)
                c.commit()
                before = {t: list(c.execute('SELECT * FROM '+t)) for t in tables}
                schema = set(c.execute('SELECT type,name,tbl_name,sql FROM sqlite_master'))
            new = journal.Store(path)
            with new.connection() as c:
                self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0], 8)
                self.assertEqual({t: list(c.execute('SELECT * FROM '+t)) for t in tables}, before)
                after = set(c.execute('SELECT type,name,tbl_name,sql FROM sqlite_master'))
                self.assertTrue(schema <= after)
                self.assertEqual({r[1] for r in after-schema}, {'library_agents', 'projects', 'sqlite_autoindex_projects_2', 'sqlite_autoindex_projects_1', 'sqlite_autoindex_library_agents_1', 'memberships', 'sqlite_autoindex_memberships_1', 'memberships_project', 'skill_assignments', 'sqlite_autoindex_skill_assignments_1', 'skill_assignments_agent', 'tool_policies', 'sqlite_autoindex_tool_policies_1', 'tool_policies_agent'})
            with patch.object(journal, 'MIGRATIONS', journal.MIGRATIONS[:7]):
                older = journal.Store(path)
                self.assertEqual(older.get('runs', 'old'), {'id': 'old', 'goal': 'unchanged'})
                self.assertEqual(older.audit_verify(), (True, None))
            with new.connection() as c:
                self.assertEqual(c.execute('PRAGMA user_version').fetchone()[0], 8)


class LibraryN2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = journal.Store(self.root/'journal.sqlite3')
        self.c = SimpleNamespace(store=self.store, projects_root=lambda:self.root,
                                 s=SimpleNamespace(project=self.root),
                                 broker=SimpleNamespace(endpoints=[{'id':'local','paid':False},{'id':'paid','paid':True}]),
                                 skill_library=lambda:[{'name':'docs','tools':['read','bash']},{'name':'invalid','error':'bad'}])
        self.lib = library.Library(self.c)

    def tearDown(self):
        self.temp.cleanup()

    def agent(self, name='Builder', **extra):
        return self.lib.create_agent({'kind':'specialist','name':name,'engine_type':'coder',**extra})

    def test_empty_library_has_no_seeded_primary_or_agents(self):
        data = self.lib.read()
        self.assertEqual(data['agents'], [])
        self.assertIsNone(data['primary'])
        self.assertEqual(self.store.runs(), [])

    def test_agent_create_update_does_not_create_project_and_store_crud(self):
        a = self.agent(instructions='<private prompt>')
        self.assertRegex(a['id'], r'^ag_[0-9a-f]{12}$')
        self.assertEqual(self.store.record_get('library_agents', a['id']), a)
        changed = self.lib.update_agent({'id':a['id'],'display_role':'Free text role','engine_type':'reviewer'})
        self.assertEqual(changed['engine_type'], 'reviewer')
        self.assertEqual(len(self.store.record_list('library_agents')), 1)
        self.assertEqual(self.store.record_list('projects'), [])
        self.assertFalse(any(p.is_dir() for p in self.root.iterdir()))
        self.assertEqual(self.store.record_update('library_agents', a['id'], display_role='new')['display_role'], 'new')

    def test_uniqueness_lengths_and_engine_type_refusals_before_effects(self):
        self.agent(' Builder ')
        for body in [dict(name='builder'),dict(name=' '),dict(name='x'*41),dict(display_role='x'*41),dict(instructions='x'*8001),dict(engine_type='orchestrator'),dict(engine_type=None),dict(model='unknown'),dict(kind='other'),dict(name=3),dict(instructions=[]),dict(model={})]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.agent(**body)
        self.assertEqual(len(self.store.record_list('library_agents')), 1)
        self.assertEqual(len(self.store.audit(None)), 1)

    def test_paid_confirmation_and_primary_rules(self):
        with self.assertRaisesRegex(ValueError,'type approve'):
            self.agent(model='paid')
        a = self.agent(model='paid',confirm='approve')
        with self.assertRaises(ValueError):
            self.lib.update_agent({'id':a['id'],'model':'paid','confirm':'wrong'})
        self.lib.update_agent({'id':a['id'],'model':'local'})
        p = self.lib.create_agent({'kind':'primary','name':'Primary','model':None})
        self.assertIsNone(p['engine_type'])
        with self.assertRaises(ValueError):
            self.lib.create_agent({'kind':'primary','name':'Another'})
        with self.assertRaises(ValueError):
            self.lib.archive_agent(p['id'])
        with self.assertRaises(ValueError):
            self.lib.update_agent({'id':p['id'],'engine_type':'coder'})
        self.assertEqual(self.lib.read()['primary']['id'], p['id'])

    def test_parallel_name_and_primary_creation_serializes_before_writes(self):
        from concurrent.futures import ThreadPoolExecutor
        def create(body):
            try:
                return self.lib.create_agent(body)['id']
            except ValueError:
                return None
        for body in ({'kind':'specialist','name':'Same','engine_type':'coder'}, {'kind':'primary','name':'Primary'}):
            with ThreadPoolExecutor(max_workers=4) as pool:
                values=list(pool.map(create,[body]*4))
            self.assertEqual(sum(v is not None for v in values),1)
        self.assertEqual(len(self.store.record_list('library_agents')),2)

    def test_explicit_null_text_and_unknown_model_refuse_without_audit(self):
        before=self.store.audit(None)
        for change in ({'name':None},{'name':' '},{'display_role':None},{'instructions':None},{'model':{}},{'model':'missing'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.agent(**change)
        self.assertEqual(self.store.record_list('library_agents'),[])
        self.assertEqual(self.store.audit(None),before)

    def test_each_store_record_supports_list_get_put_and_update(self):
        rows={'library_agents':{'id':'ag_a'}, 'projects':{'id':'pr_a','path':str(self.root/'folder')},
              'memberships':{'id':'pr_a:ag_a','project':'pr_a','agent':'ag_a'},
              'skill_assignments':{'id':'ag_a:docs','agent':'ag_a'}, 'tool_policies':{'id':'ag_a:read','agent':'ag_a'}}
        for table,row in rows.items():
            with self.subTest(table=table):
                self.store.record_put(table,row)
                self.assertEqual(self.store.record_get(table,row['id']),row)
                self.assertEqual(self.store.record_list(table),[row])
                self.store.record_update(table,row['id'],marked=True)
                self.assertTrue(self.store.record_get(table,row['id'])['marked'])
                if table in ('memberships','skill_assignments','tool_policies'):
                    self.assertEqual(len(self.store.record_list(table,'pr_a' if table=='memberships' else 'ag_a')),1)
                    self.assertEqual(self.store.record_list(table,'missing'),[])

    def test_membership_validation_and_archive_deactivation(self):
        a, b = self.agent(), self.agent('Reader',engine_type='reviewer')
        p = self.lib.create_project('Test', 'nested/project', [a['id']])
        self.assertTrue(projects.is_git(p['path']))
        self.assertEqual(self.lib.projects()['projects'][0]['members'], [a['id']])
        with self.assertRaises(ValueError):
            self.lib.members(p['id'], [], [a['id']])
        self.lib.members(p['id'], [b['id']], [a['id']])
        self.lib.assign({'agent':b['id'],'skill':'docs','assigned':True})
        self.lib.archive_agent(b['id'])
        self.assertTrue(self.store.record_get('library_agents', b['id'])['archived'])
        self.assertTrue(all(not m['active'] for m in self.store.record_list('memberships')))
        self.assertFalse(self.store.record_list('skill_assignments')[0]['active'])
        with self.assertRaises(ValueError):
            self.lib.members(p['id'], [b['id']], [])
        self.agent('Reader')

    def test_new_project_needs_specialist_primary_optional_and_validation_before_directory(self):
        p = self.lib.create_agent({'kind':'primary','name':'Primary'})
        for members in [[],[p['id']],['missing'],[{}],None]:
            with self.subTest(members=members), self.assertRaises(ValueError):
                self.lib.create_project('Test','must-not-exist',members)
        self.assertFalse((self.root/'must-not-exist').exists())
        a = self.agent()
        project = self.lib.create_project('Test','first/second/third/fourth',[a['id'],p['id']])
        self.assertEqual(self.lib.projects()['projects'][0]['member_count'],2)
        self.assertEqual(self.store.record_list('projects')[0]['id'],project['id'])
        self.assertFalse((Path(project['path'])/'team.json').exists())
        self.assertFalse((Path(project['path'])/'room.md').exists())

    def test_skill_assignment_policy_are_independent_and_allow_never_accepted(self):
        a = self.agent()
        self.lib.policy({'agent':a['id'],'permission':'bash','mode':'deny'})
        self.lib.assign({'agent':a['id'],'skill':'docs','assigned':True})
        data = self.lib.read()['agents'][0]
        self.assertEqual(data['skills'],['docs'])
        self.assertEqual(data['tool_policy'],{'bash':'deny'})
        self.lib.assign({'agent':a['id'],'skill':'docs','assigned':False})
        self.assertEqual(self.lib.read()['agents'][0]['tool_policy'],{'bash':'deny'})
        for body in [dict(permission='bash',mode='allow'),dict(permission='not-real',mode='deny'),dict(permission='bash',mode=None)]:
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.lib.policy({'agent':a['id'],**body})
        for skill in ['invalid','missing']:
            with self.assertRaises(ValueError):
                self.lib.assign({'agent':a['id'],'skill':skill,'assigned':True})
        with self.assertRaises(ValueError):
            self.lib.assign({'agent':a['id'],'skill':'docs','assigned':'true'})

    def test_audit_has_only_identifiers_field_names_and_not_free_text_or_events(self):
        a = self.agent('Hostile <name>',instructions='DO-NOT-AUDIT',display_role='SECRET-ROLE')
        self.lib.update_agent({'id':a['id'],'instructions':'PRIVATE-UPDATE'})
        self.lib.policy({'agent':a['id'],'permission':'read','mode':'ask'})
        raw = json.dumps(self.store.audit(None))
        for secret in ['Hostile','DO-NOT-AUDIT','SECRET-ROLE','PRIVATE-UPDATE']:
            self.assertNotIn(secret,raw)
        self.assertTrue(all(entry['run'] is None and entry['actor']=='you' for entry in self.store.audit(None)))
        self.assertEqual(self.store.audit_verify(),(True,None))
        with self.store.connection() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM events').fetchone()[0],0)

    def test_change_notices_are_library_or_projects_with_no_run(self):
        notices=[];self.store.listener=lambda *args:notices.append(args)
        a = self.agent();self.lib.create_project('Test','test',[a['id']])
        self.assertIn(('library',None),notices)
        self.assertIn(('projects',None),notices)
        self.assertNotIn(('event',None),notices)

    def test_host_warning_is_read_only_for_each_exact_permission(self):
        for config, expected in [('allow',{'read':True,'bash':True}),('ask',{'read':False,'bash':False}),({'read':'allow','bash':'ask'},{'read':True,'bash':False}),({'*':'allow','bash':'deny'},{'read':True,'bash':False})]:
            with patch('library.sandbox.host_permission',return_value=config):
                found={p['type']:p['host_allows'] for p in self.lib.read()['permissions']}
                for key,value in expected.items():self.assertEqual(found[key],value)


class ProjectPathsN2Tests(unittest.TestCase):
    def test_nested_paths_and_every_refusal(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            r=Path(root);(r/'escape').symlink_to(outside,target_is_directory=True)
            for bad in ['/absolute','~','../outside','a//b','a/','a/b/c/d/e','escape/new','..','a/../x','x'*65]:
                with self.subTest(path=bad),self.assertRaises(ValueError):projects.create(r,bad)
            p=projects.create(r,'one/two/three/four')
            self.assertTrue(projects.is_git(p))
            with self.assertRaises(ValueError):projects.create(r,'one/two/three/four')
            self.assertEqual(list(Path(outside).iterdir()),[])

    def test_failed_git_creation_cleans_only_created_folders(self):
        with tempfile.TemporaryDirectory() as root:
            r=Path(root);(r/'existing').mkdir();(r/'existing'/'keep').write_text('kept')
            with patch('projects._git',side_effect=RuntimeError('git failure')):
                for path in ['new/missing/target','existing/new/target']:
                    with self.assertRaises(RuntimeError):projects.create(r,path)
            self.assertFalse((r/'new').exists());self.assertFalse((r/'existing'/'new').exists())
            self.assertEqual((r/'existing'/'keep').read_text(),'kept')

    def test_registration_is_explicit_confined_and_unique(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            r=Path(root);(r/'existing').mkdir();(r/'escape').symlink_to(outside,target_is_directory=True)
            c=SimpleNamespace(store=journal.Store(r/'state.sqlite3'),projects_root=lambda:r,s=SimpleNamespace(project=r/'existing'))
            lib=library.Library(c)
            self.assertEqual(lib.projects()['projects'],[])
            item=lib.register('existing')
            self.assertEqual(item['path'],str(r/'existing'))
            for bad in ['existing','missing','../','escape',outside]:
                with self.subTest(path=bad),self.assertRaises(ValueError):lib.register(bad)


class ToolsManifestN2Tests(unittest.TestCase):
    def test_tools_inline_and_block_lists_are_read_only(self):
        for declaration in ['tools: [read, bash, research]','tools:\n  - read\n  - bash\n  - research','tools:\n- read\n- bash\n- research']:
            meta=capabilities.frontmatter('---\nname: docs\ndescription: Read docs\n'+declaration+'\n---\nBody')
            self.assertEqual(meta['tools'],['read','bash','research'])
            self.assertEqual(meta['name'],'docs')
        self.assertNotIn('tools',capabilities.frontmatter('---\nname: old\ndescription: old\n---'))

    def test_unknown_or_malformed_tools_make_the_catalogue_entry_invalid(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/'bad';folder.mkdir()
            for decl in ['tools: [read, not-real]','tools: bash','tools:\n  not-a-list']:
                (folder/'SKILL.md').write_text('---\nname: bad\ndescription: Bad\n'+decl+'\n---')
                entry=capabilities.library(root)[0]
                self.assertTrue(entry['error'])
                self.assertIn('tool',entry['error'].lower())
