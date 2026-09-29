pragma Singleton
import QtQuick

// Static mock content for the AI-Arch concept prototype.
// No network, no real agents, no inference. Data is illustrative only.
QtObject {
    id: root

    // Apps shown in the launcher. ai: true marks the 9 AI-native apps
    // (subtle cyan dot); fav: true puts the app in the favorites row.
    readonly property var apps: [
        { name: "AI Assistant",        id: "ai-assistant",     ai: true,  fav: true,  glyph: "chat" },
        { name: "AI Control Center",   id: "ai-control",       ai: true,  fav: true,  glyph: "mark" },
        { name: "AI Diagnostics",      id: "ai-diagnostics",   ai: true,  fav: false, glyph: "wrench" },
        { name: "AI Monitoring",       id: "ai-monitoring",    ai: true,  fav: false, glyph: "gauge" },
        { name: "Agent Manager",       id: "agent-manager",    ai: true,  fav: false, glyph: "agent" },
        { name: "Inference Manager",   id: "inference",        ai: true,  fav: false, glyph: "cpu" },
        { name: "Model Manager",       id: "model-manager",    ai: true,  fav: true,  glyph: "layers" },
        { name: "RAG Tools",           id: "rag-tools",        ai: true,  fav: false, glyph: "doc" },
        { name: "AI Workflows",        id: "ai-workflows",     ai: true,  fav: false, glyph: "flow" },
        { name: "Files",               id: "files",            ai: false, fav: true,  glyph: "folder" },
        { name: "Terminal",            id: "terminal",         ai: false, fav: true,  glyph: "terminal" },
        { name: "Web Browser",         id: "browser",          ai: false, fav: true,  glyph: "globe" },
        { name: "System Monitor",      id: "monitor",          ai: false, fav: true,  glyph: "gauge" },
        { name: "System Settings",     id: "settings",         ai: false, fav: true,  glyph: "gear" },
        { name: "Discover",            id: "discover",         ai: false, fav: false, glyph: "grid" },
        { name: "Kate",                id: "kate",             ai: false, fav: false, glyph: "doc" },
        { name: "Okular",              id: "okular",           ai: false, fav: false, glyph: "doc" },
        { name: "Gwenview",            id: "gwenview",         ai: false, fav: false, glyph: "image" },
        { name: "VLC",                 id: "vlc",              ai: false, fav: false, glyph: "play" },
        { name: "Elisa",               id: "elisa",            ai: false, fav: false, glyph: "music" },
        { name: "KCalc",               id: "kcalc",            ai: false, fav: false, glyph: "calc" },
        { name: "Spectacle",           id: "spectacle",        ai: false, fav: false, glyph: "camera" }
    ]

    // Launcher "recent" row (mock)
    readonly property var recent: [
        { name: "ai-arch",           glyph: "folder", hint: "project" },
        { name: "README.md",         glyph: "doc",    hint: "markdown" },
        { name: "gen-wallpaper.py",  glyph: "file",   hint: "script" },
        { name: "qwen3-27b.gguf",    glyph: "layers", hint: "model" }
    ]

    // File manager mock tree (Projects/ai-arch)
    readonly property var files: [
        { name: "docs",                 type: "dir",   size: "—",        date: "Aug 25" },
        { name: "concept",              type: "dir",   size: "—",        date: "Aug 26" },
        { name: "profile",              type: "dir",   size: "—",        date: "Aug 24" },
        { name: "tools",                type: "dir",   size: "—",        date: "Aug 20" },
        { name: "README.md",            type: "doc",   size: "14 KB",    date: "Aug 25" },
        { name: "ROADMAP.md",           type: "doc",   size: "8 KB",     date: "Aug 25" },
        { name: "install.sh",           type: "file",  size: "3 KB",     date: "Aug 18" },
        { name: "ai-arch-wallpaper.png",type: "image", size: "2.1 MB",   date: "Aug 26" },
        { name: "kwin-place.js",        type: "file",  size: "2 KB",     date: "Aug 19" }
    ]

    readonly property var sidebar: [
        { name: "Home",      glyph: "home",   path: "~" },
        { name: "Documents", glyph: "doc",    path: "~/Documents" },
        { name: "Projects",  glyph: "folder", path: "~/Projects" },
        { name: "Downloads", glyph: "folder", path: "~/Downloads" },
        { name: "Music",     glyph: "music",  path: "~/Music" }
    ]

    // System monitor mock processes
    readonly property var processes: [
        { pid: 1182, name: "kwin_wayland",    cpu: "1.2 %", mem: "412 MB" },
        { pid: 1240, name: "plasmashell",     cpu: "0.8 %", mem: "388 MB" },
        { pid: 2044, name: "qml-concept",     cpu: "18.4 %", mem: "96 MB" },
        { pid: 1730, name: "llama-server",    cpu: "6.1 %", mem: "18.2 GB" },
        { pid: 1602, name: "pipewire",        cpu: "0.3 %", mem: "94 MB" },
        { pid: 1519, name: "powerdevil",      cpu: "0.0 %", mem: "18 MB" },
        { pid: 1422, name: "sddm",            cpu: "0.1 %", mem: "24 MB" }
    ]

    // AI Command Center mock conversation
    readonly property var chat: [
        { who: "user", text: "Summarize the files in ~/Projects/ai-arch" },
        { who: "ai",   text: "This is the ai-arch project: an Arch Linux desktop profile with layered themes, a custom wallpaper pipeline, and a QML concept prototype. The latest activity is the Stage B wallpaper work (parameterized generator, three intensity variants)." },
        { who: "system", kind: "workspace", title: "Created workspace", detail: "ai-arch-review · 9 files pinned" },
        { who: "user", text: "Why is qml-concept using so much memory?" },
        { who: "ai",   text: "The concept runner is rendering offscreen at 1920x1080 with the software RHI backend; that allocates a full framebuffer plus scene-graph resources. Expected for a capture run, and it releases on exit." }
    ]

    // Command Center context chips (model / agent status)
    readonly property var context: [
        { name: "qwen3-27b", sub: "local · loaded", state: "ok" },
        { name: "daily-brief", sub: "agent · idle", state: "idle" },
        { name: "3 agents", sub: "2 idle · 1 running", state: "ok" }
    ]

    // Quick suggestions above the input
    readonly property var suggestions: [
        "Run diagnostics",
        "Show today's agent runs",
        "Summarize open files"
    ]

    // Contextual AI actions per app (the "AI context layer")
    readonly property var appActions: ({
        "files":   ["Summarize these files", "Find duplicates"],
        "monitor": ["Explain top memory users", "Why is this app using memory?"]
    })

    // Notifications (kind: normal | ai | urgent | group)
    readonly property var notifications: [
        { kind: "ai",     app: "AI Control Center", title: "Daily brief ready",      body: "3 agents completed overnight. 1 model needs an update.", time: "now" },
        { kind: "normal", app: "System",            title: "Software update",         body: "Plasma 6.7.1 is available for installation.",                   time: "2 m" },
        { kind: "group",  app: "System",            title: "3 notifications",         body: "Disk usage 40% · Network reconnected · Backup completed",   time: "14 m", count: 3 }
    ]

    // Quick settings (status control) mock values
    readonly property var quick: [
        { name: "Network",   sub: "ai-arch-lan · wired",  glyph: "wifi",     on: true },
        { name: "Bluetooth", sub: "Off",                  glyph: "bluetooth", on: false }
    ]
}
