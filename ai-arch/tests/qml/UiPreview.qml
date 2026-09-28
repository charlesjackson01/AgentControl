import QtQuick
import QtQuick.Controls
import AIArch.Ui

// T2 offscreen preview for AIArch.Ui (docs/TESTING.md §3).
// runnerState: 0 connected, 1 working, 2 degraded, 3 AI off, 4 unavailable.
// shot mode drives AIBar from the injected state (TestModel role);
// live mode lets AIBar talk to the real session bus.
Window {
    id: win
    width: runnerW
    height: runnerH
    visible: true
    title: "AIArch.Ui preview"
    color: Theme.bgDeep

    readonly property bool shot: runnerMode === "shot"
    readonly property var barState: shot
        ? ({ "0": "connected", "1": "working", "2": "degraded",
             "3": "offline", "4": "unavailable" }[String(runnerState)] || "connected")
        : null

    Surface {
        anchors.fill: parent
        anchors.margins: Theme.spaceXl
        radius: Theme.radiusCard

        Column {
            anchors.fill: parent
            anchors.margins: Theme.spaceLg
            spacing: Theme.spaceLg

            Text {
                text: "AIArch.Ui — production design tokens"
                font.family: Theme.fontSans
                font.pixelSize: Theme.typeView
                color: Theme.textPrimary
            }

            Text {
                text: "state: " + (shot ? barState : "live (session bus)")
                font.family: Theme.fontMono
                font.pixelSize: Theme.typeSmall
                color: Theme.textSecondary
            }

            AIBar {
                id: bar
                // TestModel: in shot mode the D-Bus state is injected, so the
                // component renders deterministically offscreen.
                Component.onCompleted: {
                    if (shot) {
                        bar.state = win.barState
                        bar.model = "mock-model"
                        bar.label = {
                            "connected": "mock-model"
                            "working": "working…"
                            "degraded": "degraded"
                            "offline": "AI off"
                            "unavailable": "AI unavailable"
                        }[bar.state] || "AI unavailable"
                    }
                }
                Chip { text: "Ask AI" }
                Chip { text: "Summarize" }
            }

            Row {
                spacing: Theme.spaceSm
                Glyph { name: "mark" }
                Glyph { name: "gear" }
                Glyph { name: "wrench" }
                Glyph { name: "folder" }
                Glyph { name: "terminal" }
                Glyph { name: "chat" }
            }

            Row {
                spacing: Theme.space
                StatusDot { state: "connected" }
                StatusDot { state: "working" }
                StatusDot { state: "degraded" }
                StatusDot { state: "offline" }
                StatusDot { state: "unavailable" }
            }

            Row {
                spacing: Theme.space
                Chip { text: "read-only" }
                Chip { text: "ask" }
                Chip { text: "confirm" }
            }

            Rectangle {
                width: parent.width
                height: 60
                radius: Theme.radiusControl
                color: Theme.glass(0.92)
                border.color: Theme.focusLine()
                border.width: 1.5

                Text {
                    anchors.centerIn: parent
                    text: "focus ring (accent, 1.5 px)"
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.typeBody
                    color: Theme.textPrimary
                }
            }
        }
    }
}
