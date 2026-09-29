import QtQuick
import ".."

// Quick settings / system controls popup, anchored above the tray:
// network, bluetooth, volume + display sliders, power actions, system
// status. Dense but readable; toggles are mock (no system changes).
Surface {
    id: root
    width: 340
    height: 440
    radius: Theme.radiusPopup
    alpha_: Theme.overlayAlpha
    anchors.right: parent.right
    anchors.rightMargin: 16
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 72
    visible: shell.quickOpen
    opacity: visible ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutQuad } }

    property bool wifiOn: true
    property bool btOn: false
    property real volume: 40
    property real brightness: 80

    function isOn(key) { return key === "wifi" ? root.wifiOn : root.btOn }
    function subFor(d) {
        if (d.key === "wifi") return root.wifiOn ? "ai-arch-lan · wired" : "Off"
        return root.btOn ? "On · 2 devices" : "Off"
    }

    Column {
        anchors.fill: parent
        anchors.margins: 16
        spacing: 10

        // toggle rows
        Repeater {
            model: [
                { key: "wifi", glyph: "wifi", on: root.wifiOn, label: "Network", sub: "ai-arch-lan · wired" },
                { key: "bt",   glyph: "bluetooth", on: root.btOn, label: "Bluetooth", sub: "Off" }
            ]
            delegate: Item {
                width: parent.width
                height: 44
                Rectangle {
                    anchors.fill: parent; radius: Theme.radiusControl
                    color: togMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.05) : "transparent"
                }
                Row {
                    anchors.fill: parent; anchors.leftMargin: 10; anchors.rightMargin: 10
                    spacing: 10
                    Glyph {
                        anchors.verticalCenter: parent.verticalCenter
                        name: modelData.glyph; size: 18
                        color: root.isOn(modelData.key) ? Theme.accent : Theme.textSecondary
                    }
                    Column {
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 1
                        Text { text: modelData.label; font.family: Theme.fontSans; font.pixelSize: Theme.typeBody; color: Theme.textPrimary }
                        Text { text: root.subFor(modelData); font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textSecondary }
                    }
                    Item { width: 1; height: 1 }
                    // toggle
                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 34; height: 18; radius: 9
                        color: root.isOn(modelData.key) ? Theme.tint(Theme.accent, 0.35) : Theme.tint(Theme.textPrimary, 0.12)
                        Behavior on color { ColorAnimation { duration: Theme.animFast } }
                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            anchors.left: parent.left
                            width: 14; height: 14; radius: 7
                            x: root.isOn(modelData.key) ? 18 : 2
                            color: root.isOn(modelData.key) ? Theme.accent : Theme.textSecondary
                            Behavior on x { NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutQuad } }
                        }
                    }
                }
                MouseArea {
                    id: togMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        if (modelData.key === "wifi") root.wifiOn = !root.wifiOn
                        else root.btOn = !root.btOn
                    }
                }
            }
        }

        Rectangle { width: 1; height: 10; color: Theme.hairlineSoft() }

        // volume
        Row {
            width: parent.width; height: 22
            spacing: 8
            Glyph { anchors.verticalCenter: parent.verticalCenter; name: "volume"; size: 16 }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "Volume"; font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall; color: Theme.textSecondary
            }
            Item { width: 1; height: 1 }
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width * 0.5; height: 4; radius: 2
                color: Theme.tint(Theme.textPrimary, 0.12)
                Rectangle {
                    anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                    width: parent.width * (root.volume / 100); height: 4; radius: 2
                    color: Theme.textPrimary
                }
                MouseArea {
                    anchors.fill: parent; anchors.margins: -8; anchors.topMargin: 8; anchors.bottomMargin: 8
                    cursorShape: Qt.PointingHandCursor
                    onPressed: (m) => root.volume = Math.round(100 * m.x / width)
                    onPositionChanged: (m) => { if (pressed) root.volume = Math.round(100 * m.x / width) }
                }
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Math.round(root.volume) + " %"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textSecondary
                width: 34
            }
        }

        // brightness
        Row {
            width: parent.width; height: 22
            spacing: 8
            Glyph { anchors.verticalCenter: parent.verticalCenter; name: "display"; size: 16 }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "Brightness"; font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall; color: Theme.textSecondary
            }
            Item { width: 1; height: 1 }
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width * 0.5; height: 4; radius: 2
                color: Theme.tint(Theme.textPrimary, 0.12)
                Rectangle {
                    anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                    width: parent.width * (root.brightness / 100); height: 4; radius: 2
                    color: Theme.textPrimary
                }
                MouseArea {
                    anchors.fill: parent; anchors.margins: -8; anchors.topMargin: 8; anchors.bottomMargin: 8
                    cursorShape: Qt.PointingHandCursor
                    onPressed: (m) => root.brightness = Math.round(100 * m.x / width)
                    onPositionChanged: (m) => { if (pressed) root.brightness = Math.round(100 * m.x / width) }
                }
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Math.round(root.brightness) + " %"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textSecondary
                width: 34
            }
        }

        Rectangle { width: 1; height: 10; color: Theme.hairlineSoft() }

        // power actions
        Row {
            width: parent.width
            spacing: 8
            Repeater {
                model: [
                    { glyph: "power", label: "Suspend" },
                    { glyph: "bell", label: "Lock" },
                    { glyph: "max", label: "Restart" },
                    { glyph: "close", label: "Power off" }
                ]
                delegate: Item {
                    width: parent.width / 4; height: 52
                    Column {
                        anchors.centerIn: parent; spacing: 5
                        Rectangle {
                            anchors.horizontalCenter: parent.horizontalCenter
                            width: 34; height: 34; radius: 8
                            color: powMa.containsMouse ? Theme.tint(Theme.accent, 0.10) : Theme.tint(Theme.textPrimary, 0.05)
                            border.color: Theme.hairlineSoft(); border.width: 1
                            Glyph { anchors.centerIn: parent; name: modelData.glyph; size: 15 }
                        }
                        Text {
                            text: modelData.label
                            font.family: Theme.fontSans; font.pixelSize: 10; color: Theme.textSecondary
                            horizontalAlignment: Text.AlignHCenter; width: parent.width
                        }
                    }
                    MouseArea {
                        id: powMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: shell.mockAction(modelData.label + " (mock)")
                    }
                }
            }
        }

        Item { width: 1; height: 1 }

        // system status
        Column {
            width: parent.width
            spacing: 6
            Rectangle {
                anchors.fill: parent
                radius: Theme.radiusControl
                color: Theme.tint(Theme.textPrimary, 0.04)
                border.color: Theme.hairlineSoft(); border.width: 1

                Column {
                    anchors.fill: parent; anchors.margins: 10; spacing: 6
                    Text { text: "System"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; font.weight: Font.DemiBold; color: Theme.textSecondary }
                    Row {
                        spacing: 4
                        Text { text: "Uptime 42 min"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textPrimary }
                        Item { width: 1; height: 1 }
                        Text { text: "Disk 40 %"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textPrimary }
                        Item { width: 1; height: 1 }
                        Text { text: "3 agents active"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.tint(Theme.accent, 0.95) }
                    }
                }
            }
        }
    }
}
