# AI-Arch Concept — Stage C QML Prototype

Self-contained QML concept prototype of the AI-Arch desktop experience.
**Design phase only**: every data source is mock (`MockData.qml`), no
inference is executed, and nothing here is meant to be shipped. It renders
a complete Linux desktop — wallpaper, desktop icons, window manager
behaviors, bottom panel, launcher, quick settings, notifications — with the
AI Control Center and the contextual AI layer (AIBar) as first-class
citizens.

## Layout

```
concept/qml/
├── qmldir                  # module aiarch.concept; singletons Theme + MockData
├── Theme.qml               # design tokens (colors, type, radii, glass, hairlines)
├── MockData.qml            # all mock content: apps, chat, files, processes, …
├── main.qml                # entry point; shot/live sizing; fit-scale; keys
├── desktop/
│   └── DesktopShell.qml    # composition root + window stack + state machine
├── components/
│   ├── Surface.qml         # glass surface primitive
│   ├── Glyph.qml           # Canvas line-icon set (incl. AI "mark" glyph)
│   ├── Chip.qml            # suggestion chip
│   ├── WindowFrame.qml     # window chrome: title bar, focus ring, AIBar slot
│   ├── AIBar.qml           # contextual AI chips inside a focused window
│   ├── Panel.qml           # bottom task panel: kickoff, AI entry, tasks, tray
│   ├── Launcher.qml        # kickoff launcher: search, recent, favorites, grid
│   ├── StatusControl.qml   # quick settings popup
│   ├── Notification.qml    # notification card (AI + normal kinds)
│   └── AICommandCenter.qml # the AI Control Center window content
├── apps/
│   ├── FileManager.qml     # representative "normal" app (Files)
│   ├── ExampleApp.qml      # representative "normal" app (System Monitor)
│   └── PlaceholderApp.qml  # generic window for the other 7 AI apps
└── run/
    ├── runner.cpp          # C++ runner: shot mode (offscreen capture) + live
    └── CMakeLists.txt
```

## Requirements

- Qt 6 with Quick, Quick.Controls and the offscreen/wayland/xcb platform
  plugins (verified on the `ai-arch-dev` VM, Arch, Qt 6.11).
- CMake + a C++ compiler for the runner (shot mode only).

## Build the runner (VM path shown)

```sh
cmake -S run -B /tmp/aiarch-concept/run/build -DCMAKE_BUILD_TYPE=Release
cmake --build /tmp/aiarch-concept/run/build
```

## Shot mode (deterministic 1920×1080 captures)

The runner loads `main.qml`, forces the given demo state, waits for a
settle period, then `grabWindow()`-captures the scene to a PNG:

```sh
QT_QPA_PLATFORM=offscreen QSG_RHI_BACKEND=software \
  /tmp/aiarch-concept/run/build/runner \
    --mode shot --state 1 --out /tmp/shot-01.png \
    --settle 3000 /path/to/concept/qml/main.qml
```

Options: `--state 1..9` (or `-1` to skip a preset), `--width/--height`
(default 1920×1080), `--settle <ms>` (default 3000), `--out <path>`.

### The nine demo states

| #  | State                                                        |
|----|--------------------------------------------------------------|
| 1  | Desktop only (wallpaper, icons, panel)                       |
| 2  | AI Control Center open and focused                           |
| 3  | AI Control Center minimized (taskbar entry only)             |
| 4  | Files + System Monitor open, Files focused                   |
| 5  | Same as 4 with System Monitor focused (focus ring moves)     |
| 6  | Files focused with the contextual AIBar active               |
| 7  | Quick settings popup                                         |
| 8  | Notification stack (AI + normal + grouped cards)             |
| 9  | Files focused left (AIBar) + AI Control Center open right    |

## Live mode (interactive)

Run inside a graphical session (Wayland on the dev VM):

```sh
WAYLAND_DISPLAY=wayland-0 /tmp/aiarch-concept/run/build/runner \
  --mode live /path/to/concept/qml/main.qml
```

Keys: `1`–`9` states, `a` toggle AI Control Center, `l` launcher,
`q` quick settings, `n` push a mock notification, `Esc` close popups.
Windows drag by title bar, double-click title bar or use the buttons to
maximize; taskbar entries click-to-restore / click-to-minimize.

## Verification note

Captures are verified programmatically (pixel-region statistics and edge
profiles), not by eye: window rectangles, focus-ring color
(accent `rgba(64,190,220,α)` vs neutral hairline), content variance inside
each window region, and panel/taskbar/tray positions.

## Guardrails

- Concept code lives only in `concept/`; it must not be pulled into
  production profile layers.
- All content is mock; no model is invoked, no system state is read.
- Wallpaper reference is `Theme.wallpaperPath` (Stage B v2-balanced,
  installed at `/usr/share/wallpapers/ai-arch/`).
- Stage C ends with this prototype + captures. Any further stage (Stage D:
  implementation) requires explicit owner approval.
