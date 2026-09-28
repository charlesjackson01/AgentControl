# demo_app — small todo CLI

A tiny command-line todo list. Python 3 standard library only (no third-party
packages, no network access).

## Commands

Run from the project root:

```
python3 demo_app/todo.py add "Write tests"   # add a task; prints the new task id
python3 demo_app/todo.py list                # list all tasks with [x]/[ ] markers
python3 demo_app/todo.py done 1              # mark task id 1 as done
python3 demo_app/todo.py delete 1            # delete task id 1
```

- `add TEXT` — adds a task and prints its new integer id to stdout. Blank text
  is rejected with an error on stderr and a non-zero exit status.
- `list` — prints every task as `[x] 1. done task` or `[ ] 2. open task`.
  With no tasks it prints a friendly empty-state message.
- `done TASK_ID` — marks the task as done. An unknown id prints an error to
  stderr and exits with a non-zero status.
- `delete TASK_ID` — removes the task with the given id and saves the store.
  Remaining tasks keep their original ids (no renumbering). An unknown id
  prints an error to stderr and exits with a non-zero status.

## Options

- `--file PATH` — must be given **before** the subcommand; overrides the
  storage location. Example:

  ```
  python3 demo_app/todo.py --file /tmp/mylist.json add "Use --file"
  ```

## Storage

Tasks are stored as a JSON list of `{"id": int, "text": str, "done": bool}`
objects. By default the file is `tasks.json` in the current working directory;
`save_store` creates parent directories as needed.

## Tests

From the project root:

```
python3 -m unittest discover -s demo_app -p test_*.py
```
