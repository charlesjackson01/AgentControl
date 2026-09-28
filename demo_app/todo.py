"""A small command-line todo app with JSON file storage.

Uses only the Python 3 standard library.
"""

import argparse
import json
import os
import sys

DEFAULT_FILE = "tasks.json"


def new_store():
    """Return a new, empty task store."""
    return []


def add_task(store, text):
    """Append a new task to the store and return the new task dict.

    Raises ValueError if text is not a non-empty string (after strip).
    """
    if not isinstance(text, str) or not text.strip():
        raise ValueError("task text must be a non-empty string")
    task_id = max((task["id"] for task in store), default=0) + 1
    task = {"id": task_id, "text": text.strip(), "done": False}
    store.append(task)
    return task


def complete_task(store, task_id):
    """Mark the task with the given id as done and return it.

    Raises ValueError if no task has that id.
    """
    for task in store:
        if task["id"] == task_id:
            task["done"] = True
            return task
    raise ValueError("no task with id {}".format(task_id))


def delete_task(store, task_id):
    """Remove the task with the given id from the store and return it.

    Raises ValueError if no task has that id.
    """
    for i, task in enumerate(store):
        if task["id"] == task_id:
            return store.pop(i)
    raise ValueError("no task with id {}".format(task_id))


def load_store(path):
    """Load the task store from a JSON file.

    Returns a new empty store if the file does not exist or is empty.
    Raises ValueError on invalid JSON.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return new_store()
    if not content.strip():
        return new_store()
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError("invalid JSON in {}: {}".format(path, exc)) from exc
    if not isinstance(data, list):
        raise ValueError("expected a JSON list of tasks in {}".format(path))
    return data


def save_store(path, store):
    """Write the store as pretty-printed JSON, creating parent dirs if needed."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(store, f, indent=2)
        f.write("\n")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="todo",
        description="Simple todo list manager (JSON storage).",
    )
    parser.add_argument(
        "--file",
        default=DEFAULT_FILE,
        metavar="PATH",
        help="storage file path (default: ./tasks.json)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_add = sub.add_parser("add", help="add a new task")
    p_add.add_argument("text", help="task text")

    sub.add_parser("list", help="list all tasks")

    p_done = sub.add_parser("done", help="mark a task done")
    p_done.add_argument("task_id", type=int, help="id of the task to complete")

    p_delete = sub.add_parser("delete", help="delete a task")
    p_delete.add_argument("task_id", type=int, help="id of the task to delete")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    path = args.file

    if args.command == "add":
        store = load_store(path)
        try:
            task = add_task(store, args.text)
        except ValueError as exc:
            print("error: {}".format(exc), file=sys.stderr)
            return 1
        save_store(path, store)
        print(task["id"])
        return 0

    if args.command == "list":
        store = load_store(path)
        if not store:
            print('No tasks yet. Add one with: todo.py add "your task"')
        else:
            for task in store:
                marker = "x" if task["done"] else " "
                print("[{}] {}. {}".format(marker, task["id"], task["text"]))
        return 0

    if args.command == "done":
        store = load_store(path)
        try:
            complete_task(store, args.task_id)
        except ValueError as exc:
            print("error: {}".format(exc), file=sys.stderr)
            return 1
        save_store(path, store)
        return 0

    if args.command == "delete":
        store = load_store(path)
        try:
            delete_task(store, args.task_id)
        except ValueError as exc:
            print("error: {}".format(exc), file=sys.stderr)
            return 1
        save_store(path, store)
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
