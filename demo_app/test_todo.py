"""unittest tests for todo.py.

Run from the project root:
    python3 -m unittest discover -s demo_app -p test_*.py
"""

import os
import tempfile
import unittest

import todo


class AddTaskTests(unittest.TestCase):
    def test_add_increases_length_and_fields(self):
        store = todo.new_store()
        self.assertEqual(store, [])
        task = todo.add_task(store, "Write tests")
        self.assertEqual(len(store), 1)
        self.assertEqual(task["text"], "Write tests")
        self.assertFalse(task["done"])
        self.assertIsInstance(task["id"], int)
        self.assertIs(store[-1], task)

    def test_add_blank_text_raises(self):
        store = todo.new_store()
        with self.assertRaises(ValueError):
            todo.add_task(store, "   ")
        with self.assertRaises(ValueError):
            todo.add_task(store, "")
        self.assertEqual(store, [])

    def test_add_strips_surrounding_whitespace(self):
        store = todo.new_store()
        task = todo.add_task(store, "  pad the text  ")
        self.assertEqual(task["text"], "pad the text")

    def test_ids_unique_and_increasing(self):
        store = todo.new_store()
        ids = [todo.add_task(store, "task {}".format(i))["id"] for i in range(3)]
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(ids, [ids[0] + i for i in range(3)])


class CompleteTaskTests(unittest.TestCase):
    def test_complete_sets_done_flag(self):
        store = todo.new_store()
        first = todo.add_task(store, "first")
        second = todo.add_task(store, "second")
        todo.complete_task(store, first["id"])
        self.assertTrue(first["done"])
        self.assertFalse(second["done"])
        self.assertEqual(len(store), 2)

    def test_complete_unknown_id_raises(self):
        store = todo.new_store()
        todo.add_task(store, "only task")
        with self.assertRaises(ValueError):
            todo.complete_task(store, 999)


class DeleteTaskTests(unittest.TestCase):
    def test_delete_removes_task(self):
        store = todo.new_store()
        first = todo.add_task(store, "first")
        removed = todo.delete_task(store, first["id"])
        self.assertEqual(removed, first)
        self.assertEqual(store, [])

    def test_delete_unknown_id_raises(self):
        store = todo.new_store()
        todo.add_task(store, "only task")
        with self.assertRaises(ValueError):
            todo.delete_task(store, 999)
        self.assertEqual(len(store), 1)

    def test_delete_decreases_length_by_one_and_keeps_ids(self):
        store = todo.new_store()
        first = todo.add_task(store, "first")
        second = todo.add_task(store, "second")
        todo.delete_task(store, first["id"])
        self.assertEqual(len(store), 1)
        self.assertEqual(store[0]["id"], second["id"])
        self.assertEqual(store[0]["text"], "second")


class SaveLoadTests(unittest.TestCase):
    def test_round_trip_preserves_all_fields(self):
        store = todo.new_store()
        todo.add_task(store, "incomplete task")
        done = todo.add_task(store, "completed task")
        todo.complete_task(store, done["id"])
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "tasks.json")
            todo.save_store(path, store)
            self.assertTrue(os.path.isfile(path))
            loaded = todo.load_store(path)
            self.assertEqual(loaded, store)
            self.assertEqual([t["id"] for t in loaded], [t["id"] for t in store])
            self.assertFalse(loaded[0]["done"])
            self.assertTrue(loaded[1]["done"])

    def test_load_nonexistent_path_returns_empty_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "does-not-exist.json")
            self.assertEqual(todo.load_store(path), [])

    def test_load_empty_file_returns_empty_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "empty.json")
            with open(path, "w", encoding="utf-8"):
                pass
            self.assertEqual(todo.load_store(path), [])

    def test_load_invalid_json_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write("{not valid json")
            with self.assertRaises(ValueError):
                todo.load_store(path)


if __name__ == "__main__":
    unittest.main()
