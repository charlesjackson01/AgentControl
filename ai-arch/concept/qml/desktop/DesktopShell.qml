import QtQuick
import ".."
import "../components"
import "../apps"

// DesktopShell: the concept desktop composition root.
// Owns the window stack, panel, launcher, quick settings, notifications,
// the contextual AI layer, and the demo state machine (states 1-9).
// In shot mode a single state is applied on completion and the C++
// runner captures the window; in live mode keys 1-9 / a / l / q / n / Esc
// drive the same states interactively.
Item {
    id: shell
    focus: true

    readonly property int designW: 1920
    readonly property int designH: 1080

    readonly property string mode: (typeof conceptMode !== "undefined") ? String(conceptMode) : "live"
    readonly property int initialState: (typeof conceptState !== "undefined") ? Number(conceptState) : -1

    // taskbar entries, in stack order
    property var taskList: {
        var out = []
        for (var i = 0; i < winOrder.length; i++) {
            var id = winOrder[i]
            out.push({ id: id, title: winState[id].title, icon: winState[id].icon, minimized: winState[id].minimized })
        }
        return out
    }
    property int notifCount: notifs.length

    // --- window stack -------------------------------------------------------
    // winOrder: bottom -> top. winState: id -> {title, icon, minimized, maximized, lastX, lastY}
    property var winOrder: []
    property var winState: ({})
    property var notifs: MockData.notifications
    property bool notifsVisible: false
    property bool launcherOpen: false
    property bool quickOpen: false
    property bool aiCtxOn: false
    property var chat: MockData.chat
    property string clock: ""
    property string toast: ""

    readonly property var frames: ({})

    function meta(id) { return winState[id] }
    function isOpen(id) { return winOrder.indexOf(id) >= 0 }
    function winVisible(id) { return isOpen(id) && !winState[id].minimized }

    // winState is mutated in place; reassigning (deep copy) is what makes
    // QML bindings on it re-evaluate.
    function bumpState() {
        winState = JSON.parse(JSON.stringify(winState))
        winOrder = winOrder.slice()
        applyZ()
    }

    function focusedId() {
        for (var i = winOrder.length - 1; i >= 0; i--)
            if (!winState[winOrder[i]].minimized)
                return winOrder[i]
        return ""
    }

    function applyZ() {
        for (var k in frames)
            frames[k].z = Math.max(0, winOrder.indexOf(k))
    }

    function openAt(id, x, y, w, h, title, icon) {
        if (!winState[id])
            winState[id] = { title: title || id, icon: icon || "grid", minimized: false, maximized: false, lastX: x, lastY: y }
        if (!isOpen(id)) { winOrder.push(id); winOrder = winOrder.slice() }
        var m = winState[id]
        m.minimized = false
        m.maximized = false
        if (title) m.title = title
        if (icon) m.icon = icon
        var f = frames[id]
        f.x = x; f.y = y
        f.defaultW = w; f.defaultH = h
        f.title = m.title
        f.icon = m.icon
        bumpState()
    }

    function focusWin(id) {
        if (!isOpen(id)) return
        winOrder = winOrder.filter(function(v) { return v !== id })
        winOrder.push(id)
        winState[id].minimized = false
        bumpState()
    }

    function minimizeWin(id) {
        if (!isOpen(id)) return
        winState[id].minimized = true
        bumpState()
    }

    function closeWin(id) {
        if (!isOpen(id)) return
        winState[id].minimized = true
        winOrder = winOrder.filter(function(v) { return v !== id })
        bumpState()
    }

    function toggleMax(id) {
        if (!isOpen(id)) return
        var m = winState[id]
        var f = frames[id]
        if (!m.maximized) {
            m.lastX = f.x; m.lastY = f.y
            m.maximized = true
            f.x = 0; f.y = 0
        } else {
            m.maximized = false
            f.x = m.lastX; f.y = m.lastY
        }
        bumpState()
    }

    function taskClick(id) {
        if (winState[id].minimized) { winState[id].minimized = false; focusWin(id) }
        else if (focusedId() === id) minimizeWin(id)
        else focusWin(id)
    }

    // --- AI layer -------------------------------------------------------------
    readonly property var aiReplies: ({
        "Summarize these files": "9 items in ~/Projects/ai-arch: a layered theme profile, the Stage B wallpaper pipeline, and the Stage C QML concept. Most recent activity is this concept prototype and its screenshots.",
        "Find duplicates": "2 candidate duplicates: the installed wallpaper and the Stage B backup in /tmp are identical. No other duplicates found.",
        "Explain top memory users": "llama-server holds ~18 GB for the loaded 27B model (Q4_K_XL). qml-concept is a transient render buffer for offscreen capture. Neither needs action.",
        "Why is this app using memory?": "The selected process is qml-concept: an offscreen 1920x1080 render allocates a full framebuffer plus scene-graph resources. Expected, and released on exit."
    })

    function actionsFor(appId) { return MockData.appActions[appId] || [] }

    function aiBarFor(appId) {
        return aiCtxOn && focusedId() === appId && actionsFor(appId).length > 0
    }

    function aiContextLabel() {
        var f = focusedId()
        if (f === "files") return "Files — ~/Projects/ai-arch"
        if (f === "monitor") return "System Monitor — qml-concept"
        if (f === "ai-control") return "AI Control Center"
        return "Desktop"
    }

    function pushChat(who, text) {
        chat = chat.concat([{ who: who, text: text }])
    }

    function sendContextAction(appId, label) {
        if (!isOpen("ai-control"))
            openAt("ai-control", 1180, 90, 640, 760, "AI Control Center", "mark")
        focusWin("ai-control")
        pushChat("user", label)
        pushChat("ai", aiReplies[label] || ("Mock: I would now " + label.toLowerCase() + " using the active model (qwen3-27b)."))
    }

    // --- popups -----------------------------------------------------------------
    function toggleLauncher() { launcherOpen = !launcherOpen; quickOpen = false }
    function toggleQuick() { quickOpen = !quickOpen; launcherOpen = false }
    function toggleNotifs() { notifsVisible = !notifsVisible }

    function toggleAi() {
        if (isOpen("ai-control") && !winState["ai-control"].minimized) {
            if (focusedId() === "ai-control") minimizeWin("ai-control")
            else focusWin("ai-control")
        } else {
            openAt("ai-control", 560, 140, 800, 660, "AI Control Center", "mark")
            focusWin("ai-control")
        }
        winOrder = winOrder.slice()
    }

    function launchApp(id) {
        var app = null
        for (var i = 0; i < MockData.apps.length; i++)
            if (MockData.apps[i].id === id) { app = MockData.apps[i]; break }
        if (!app) return
        if (id === "files") { openAt("files", 160, 120, 960, 640, "Files — ai-arch", "folder"); focusWin("files") }
        else if (id === "monitor") { openAt("monitor", 640, 220, 900, 560, "System Monitor", "gauge"); focusWin("monitor") }
        else if (id === "ai-control") { openAt("ai-control", 560, 140, 800, 660, "AI Control Center", "mark"); focusWin("ai-control") }
        else { openAt("ph", 560, 200, 720, 480, app.name, app.glyph); focusWin("ph") }
        winOrder = winOrder.slice()
    }

    function removeNotif(index) {
        notifs = notifs.filter(function(n, i) { return i !== index })
    }

    function pushNotif() {
        notifs = notifs.concat([{
            kind: "normal", app: "Discover", title: "Package update ready",
            body: "kwin 6.7.1 · plasmashell 6.7.1", time: "now"
        }])
        notifsVisible = true
    }

    function mockAction(label) {
        toast = label
        toastTimer.restart()
    }

    // --- demo states ----------------------------------------------------------------
    function setState(n) {
        closeWin("files"); closeWin("monitor"); closeWin("ai-control"); closeWin("ph")
        launcherOpen = false
        quickOpen = false
        notifsVisible = false
        aiCtxOn = false
        chat = MockData.chat
        switch (n) {
        case 1:
            break
        case 2:
            openAt("ai-control", 560, 140, 800, 660, "AI Control Center", "mark")
            focusWin("ai-control")
            break
        case 3:
            openAt("ai-control", 560, 140, 800, 660, "AI Control Center", "mark")
            minimizeWin("ai-control")
            break
        case 4:
            openAt("files", 160, 120, 960, 640, "Files — ai-arch", "folder")
            openAt("monitor", 640, 220, 900, 560, "System Monitor", "gauge")
            focusWin("files")
            break
        case 5:
            openAt("files", 160, 120, 960, 640, "Files — ai-arch", "folder")
            openAt("monitor", 640, 220, 900, 560, "System Monitor", "gauge")
            focusWin("monitor")
            break
        case 6:
            aiCtxOn = true
            openAt("files", 480, 160, 960, 640, "Files — ai-arch", "folder")
            focusWin("files")
            break
        case 7:
            quickOpen = true
            break
        case 8:
            notifs = MockData.notifications
            notifsVisible = true
            break
        case 9:
            aiCtxOn = true
            openAt("ai-control", 1180, 90, 640, 760, "AI Control Center", "mark")
            openAt("files", 140, 110, 980, 660, "Files — ai-arch", "folder")
            focusWin("files")
            break
        }
        winOrder = winOrder.slice()
        applyZ()
    }

    function handleKey(event) {
        if (mode === "shot") return
        switch (event.key) {
        case Qt.Key_1: case Qt.Key_2: case Qt.Key_3: case Qt.Key_4: case Qt.Key_5:
        case Qt.Key_6: case Qt.Key_7: case Qt.Key_8: case Qt.Key_9:
            setState(event.key - Qt.Key_1)
            break
        case Qt.Key_A: toggleAi(); break
        case Qt.Key_L: toggleLauncher(); break
        case Qt.Key_Q: toggleQuick(); break
        case Qt.Key_N: pushNotif(); break
        case Qt.Key_Escape:
            if (launcherOpen) launcherOpen = false
            else if (quickOpen) quickOpen = false
            else if (notifsVisible) notifsVisible = false
            break
        }
    }

    Component.onCompleted: {
        frames["files"] = winFiles
        frames["monitor"] = winMonitor
        frames["ai-control"] = winAi
        frames["ph"] = winPh
        clock = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
        if (mode === "shot" && initialState >= 0)
            setState(initialState)
    }

    // --- wallpaper ---------------------------------------------------------------
    Image {
        id: wallpaper
        anchors.fill: parent
        source: Theme.wallpaperPath
        fillMode: Image.PreserveAspectCrop
        cache: true
        z: 0
    }

    // --- desktop icons -------------------------------------------------------------
    Column {
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.margins: 24
        spacing: 18
        z: 5

        Repeater {
            model: [
                { glyph: "home",   label: "Home" },
                { glyph: "doc",    label: "Documents" },
                { glyph: "close",  label: "Trash" }
            ]
            delegate: Item {
                width: 72; height: 78
                Column {
                    anchors.fill: parent; spacing: 5
                    Rectangle {
                        anchors.horizontalCenter: parent.horizontalCenter
                        width: 48; height: 48; radius: 10
                        color: ma.containsMouse ? Theme.glass(0.9) : Theme.glass(0.55)
                        border.color: ma.containsMouse ? Theme.hairline() : "transparent"
                        border.width: 1
                        Glyph { anchors.centerIn: parent; name: modelData.glyph; size: 22; color: Theme.textSecondary }
                    }
                    Text {
                        anchors.horizontalCenter: parent.horizontalCenter
                        text: modelData.label
                        font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro
                        color: Theme.textPrimary
                        // subtle dark backdrop for readability over wallpaper
                        Rectangle {
                            anchors.fill: parent; anchors.margins: -2
                            z: -1
                            color: Qt.rgba(0, 0, 0, 0.35)
                            radius: 3
                        }
                    }
                }
                MouseArea {
                    id: ma; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                    onClicked: shell.mockAction(modelData.label + " (mock)")
                }
            }
        }
    }

    // --- window area ---------------------------------------------------------------
    Item {
        id: windowsArea
        anchors.fill: parent
        z: 10

        WindowFrame {
            id: winFiles
            appId: "files"
            desktopW: shell.designW
            desktopH: shell.designH
            minimized: shell.meta("files") ? shell.meta("files").minimized : true
            focused: shell.focusedId() === "files"
            contentComponent: filesComp
        }
        WindowFrame {
            id: winMonitor
            appId: "monitor"
            desktopW: shell.designW
            desktopH: shell.designH
            minimized: shell.meta("monitor") ? shell.meta("monitor").minimized : true
            focused: shell.focusedId() === "monitor"
            contentComponent: monitorComp
        }
        WindowFrame {
            id: winAi
            appId: "ai-control"
            desktopW: shell.designW
            desktopH: shell.designH
            minimized: shell.meta("ai-control") ? shell.meta("ai-control").minimized : true
            focused: shell.focusedId() === "ai-control"
            contentComponent: aiComp
        }
        WindowFrame {
            id: winPh
            appId: "ph"
            desktopW: shell.designW
            desktopH: shell.designH
            minimized: shell.meta("ph") ? shell.meta("ph").minimized : true
            focused: shell.focusedId() === "ph"
            title: shell.meta("ph") ? shell.meta("ph").title : ""
            icon: shell.meta("ph") ? shell.meta("ph").icon : "grid"
            contentComponent: phComp
        }
    }

    Component { id: filesComp; FileManager { } }
    Component { id: monitorComp; ExampleApp { } }
    Component { id: aiComp; AICommandCenter { } }
    Component {
        id: phComp
        PlaceholderApp {
            appName: shell.meta("ph") ? shell.meta("ph").title : "Application"
            appGlyph: shell.meta("ph") ? shell.meta("ph").icon : "grid"
        }
    }

    // --- outside-click scrim for popups ------------------------------------------
    Rectangle {
        anchors.fill: parent
        z: 35
        visible: shell.launcherOpen || shell.quickOpen
        opacity: visible ? 1 : 0
        color: Qt.rgba(0, 0, 0, 0.18)
        Behavior on opacity { NumberAnimation { duration: Theme.animFast } }
        MouseArea {
            anchors.fill: parent
            onClicked: { shell.launcherOpen = false; shell.quickOpen = false }
        }
    }

    // --- panel ---------------------------------------------------------------------
    Panel { z: 20 }

    // --- launcher --------------------------------------------------------------------
    Launcher { z: 40 }

    // --- quick settings -----------------------------------------------------------------
    StatusControl { z: 40 }

    // --- notifications ------------------------------------------------------------------
    Column {
        anchors.right: parent.right
        anchors.rightMargin: 24
        anchors.top: parent.top
        anchors.topMargin: 24
        spacing: 10
        z: 30
        visible: shell.notifsVisible
        opacity: visible ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.animMed; easing.type: Easing.OutQuad } }

        Repeater {
            model: shell.notifs
            delegate: Notification {
                kind: modelData.kind
                app: modelData.app
                title: modelData.title
                body: modelData.body
                time: modelData.time
                count: modelData.count || 0
                onDismissed: shell.removeNotif(index)
                onAiAction: (label) => { shell.mockAction(label + " (mock)"); }
            }
        }
    }

    // --- toast (mock action feedback) ---------------------------------------------------
    Surface {
        visible: toastTimer.running && shell.toast !== ""
        height: 40
        width: toastText.implicitWidth + 36
        radius: Theme.radiusChip
        alpha_: Theme.overlayAlpha
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        anchors.topMargin: 28
        z: 50

        Text {
            id: toastText
            anchors.centerIn: parent
            text: shell.toast
            font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
            color: Theme.textPrimary
        }
    }
    Timer { id: toastTimer; interval: 2200; repeat: false; onTriggered: shell.toast = "" }

    // --- clock --------------------------------------------------------------------------
    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: shell.clock = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    }
}
