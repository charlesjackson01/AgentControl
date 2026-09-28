import QtQuick
import ".."

// One notification card. kind: "normal" | "ai" | "urgent" | "group".
// AI notifications carry a 2px accent left edge; urgent a warn edge.
// AI cards offer one AI-suggested action (mock).
Rectangle {
    id: root
    property string kind: "normal"
    property string app: ""
    property string title: ""
    property string body: ""
    property string time: ""
    property int count: 0
    property bool expanded: false
    signal dismissed()
    signal aiAction(string label)

    width: 320
    height: expanded ? 118 : 72
    radius: Theme.radiusCard
    color: Theme.glass(Theme.overlayAlpha)
    border.color: Theme.hairline()
    border.width: 1

    Behavior on height { NumberAnimation { duration: Theme.animMed; easing.type: Easing.OutQuad } }

    // priority edge
    Rectangle {
        anchors.left: parent.left; anchors.top: parent.top; anchors.bottom: parent.bottom
        width: 2
        visible: root.kind === "ai" || root.kind === "urgent"
        color: root.kind === "urgent" ? Theme.warn : Theme.accent
    }

    Row {
        anchors.fill: parent
        anchors.leftMargin: 12
        anchors.rightMargin: 8
        anchors.topMargin: 10
        anchors.bottomMargin: root.kind === "ai" && !root.expanded ? 10 : (expanded ? 10 : 8)
        spacing: 10

        Rectangle {
            anchors.top: parent.top
            width: 34; height: 34; radius: 8
            color: Theme.tint(root.kind === "ai" ? Theme.accent : Theme.textPrimary, 0.07)
            border.color: Theme.hairlineSoft(); border.width: 1
            Glyph {
                anchors.centerIn: parent
                name: root.kind === "ai" ? "mark" : (root.kind === "group" ? "bell" : "bell")
                size: 16
                color: root.kind === "ai" ? Theme.accent : Theme.textSecondary
            }
        }

        Column {
            width: parent.width - 44 - 24
            spacing: 3
            Text {
                text: root.app + (root.kind === "group" ? " · " + root.count : "")
                font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro
                color: Theme.textSecondary
            }
            Text {
                width: parent.width
                text: root.title
                font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall; font.weight: Font.DemiBold
                color: Theme.textPrimary
                elide: Text.ElideRight
            }
            Text {
                width: parent.width
                text: root.body
                font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro
                color: Theme.textSecondary
                elide: Text.ElideRight
                maximumLineCount: 1
                visible: !root.expanded
            }
            Row {
                visible: root.kind === "ai" && !root.expanded
                spacing: 6
                Chip {
                    text: "Suggest with AI"
                    ai: true
                    height: 22
                    onActivated: root.aiAction("Suggest with AI")
                }
            }
            // expanded group children
            Column {
                visible: root.expanded
                spacing: 4
                Repeater {
                    model: ["Network reconnected", "Backup completed", "Disk usage at 40 %"]
                    delegate: Row {
                        spacing: 6
                        Rectangle { width: 4; height: 4; radius: 2; color: Theme.textDisabled; anchors.verticalCenter: parent.verticalCenter }
                        Text { text: modelData; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textSecondary }
                    }
                }
            }
        }

        // actions
        Column {
            anchors.right: parent.right
            anchors.top: parent.top
            spacing: 4
            Item {
                width: 24; height: 24
                Rectangle {
                    anchors.fill: parent; radius: Theme.radiusControl
                    color: xMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.10) : "transparent"
                }
                Glyph { anchors.centerIn: parent; name: "close"; size: 12 }
                MouseArea { id: xMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.dismissed() }
            }
            Rectangle {
                width: 24; height: 24; radius: Theme.radiusControl
                visible: root.kind === "group"
                color: gMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.10) : "transparent"
                Glyph {
                    anchors.centerIn: parent
                    name: root.expanded ? "min" : "plus"
                    size: 11
                }
                MouseArea { id: gMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: root.expanded = !root.expanded }
            }
        }
    }

    Text {
        anchors.right: parent.right
        anchors.rightMargin: 10
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 6
        visible: !root.expanded
        text: root.time
        font.family: Theme.fontSans; font.pixelSize: 10
        color: Theme.textDisabled
    }
}
