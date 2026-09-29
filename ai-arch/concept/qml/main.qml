import QtQuick
import QtQuick.Window
import QtQuick.Controls
import "."
import "desktop"

// Entry point. The design canvas is always 1920x1080 (the concept's
// design space). In shot mode the window is exactly 1920x1080 and the
// C++ runner captures it offscreen. In live mode the window fills the
// real screen and the design is fit-scaled (letterboxed).
ApplicationWindow {
    id: win
    visible: true
    title: "AI-Arch concept"
    flags: Qt.FramelessWindowHint
    font.family: Theme.fontSans
    font.pixelSize: Theme.typeBody
    color: "#0a0c0f"

    readonly property string mode: (typeof conceptMode !== "undefined") ? String(conceptMode) : "live"
    readonly property int shotW: (typeof conceptW !== "undefined") ? Number(conceptW) : 1920
    readonly property int shotH: (typeof conceptH !== "undefined") ? Number(conceptH) : 1080

    width: mode === "shot" ? shotW : (Screen.width || 1920)
    height: mode === "shot" ? shotH : (Screen.height || 1080)
    visibility: mode === "shot" ? Window.Windowed : Window.FullScreen

    function fit() {
        return mode === "shot" ? 1.0 : Math.min(win.width / 1920, win.height / 1080)
    }

    Item {
        id: stage
        anchors.fill: parent

        Item {
            id: design
            width: 1920
            height: 1080
            x: (stage.width - 1920 * win.fit()) / 2
            y: (stage.height - 1080 * win.fit()) / 2
            transform: Scale {
                xScale: win.fit()
                yScale: win.fit()
                origin.x: 0
                origin.y: 0
            }

            DesktopShell {
                id: shell
                anchors.fill: parent
            }
        }
    }

    // single key entry point at window level (keys not consumed by a
    // focused text field land here)
    Keys.onPressed: (event) => { if (mode !== "shot") shell.handleKey(event) }
}
