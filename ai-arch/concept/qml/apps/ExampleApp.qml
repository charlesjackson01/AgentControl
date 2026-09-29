import QtQuick
import ".."
import "../components"

// System Monitor (concept): process table with selection. The AIBar in
// the window frame offers AI explanations for the selected process.
Item {
    id: root
    property int selected: 2

    Item {
        anchors.fill: parent

        // header
        Surface {
            id: header
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: 40
            radius: 0
            alpha_: Theme.raisedAlpha
            hasBorder: false
            Row {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 12
                spacing: 8
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "Processes"
                    font.family: Theme.fontSans; font.pixelSize: Theme.typeBody; font.weight: Font.DemiBold
                    color: Theme.textPrimary
                }
                Item { width: 1; height: 1 }
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "7 shown · sorted by memory"
                    font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro
                    color: Theme.textSecondary
                }
            }
        }

        // column headers
        Row {
            id: colHead
            anchors.top: header.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.leftMargin: 16
            anchors.rightMargin: 16
            height: 26
            spacing: 0
            Text { width: parent.width * 0.10; text: "PID"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
            Text { width: parent.width * 0.45; text: "Name"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
            Text { width: parent.width * 0.20; text: "CPU"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
            Text { width: parent.width * 0.20; text: "Memory"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
        }

        // rows
        Column {
            anchors.top: colHead.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            spacing: 2

            Repeater {
                model: MockData.processes
                delegate: Item {
                    width: parent.width
                    height: 34
                    Rectangle {
                        anchors.fill: parent
                        anchors.leftMargin: 8
                        anchors.rightMargin: 8
                        radius: Theme.radiusControl
                        color: root.selected === index
                            ? Theme.tint(Theme.accent, 0.10)
                            : (ma.containsMouse ? Theme.tint(Theme.textPrimary, 0.05) : "transparent")
                        Behavior on color { ColorAnimation { duration: Theme.animFast } }
                    }
                    Row {
                        anchors.fill: parent
                        anchors.leftMargin: 12
                        anchors.rightMargin: 12
                        spacing: 0
                        Text {
                            width: parent.width * 0.10
                            text: modelData.pid
                            font.family: Theme.fontMono; font.pixelSize: Theme.typeSmall
                            color: Theme.textSecondary
                        }
                        Row {
                            width: parent.width * 0.45
                            spacing: 8
                            Glyph {
                                anchors.verticalCenter: parent.verticalCenter
                                name: modelData.name.indexOf("llama") >= 0 ? "cpu" : (modelData.name.indexOf("kwin") >= 0 ? "display" : "file")
                                size: 14
                                color: Theme.textSecondary
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.name
                                font.family: Theme.fontSans; font.pixelSize: Theme.typeBody
                                color: root.selected === index ? Theme.textPrimary : Theme.textSecondary
                            }
                            Rectangle {
                                anchors.verticalCenter: parent.verticalCenter
                                width: 6; height: 6; radius: 3
                                visible: modelData.name === "llama-server"
                                color: Theme.tint(Theme.accent, 0.9)
                            }
                        }
                        Text {
                            width: parent.width * 0.20
                            text: modelData.cpu
                            font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                            color: modelData.cpu === "18.4 %" ? Theme.warn : Theme.textSecondary
                        }
                        Text {
                            width: parent.width * 0.20
                            text: modelData.mem
                            font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                            color: Theme.textSecondary
                        }
                    }
                    MouseArea {
                        id: ma
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.selected = index
                    }
                }
            }
        }
    }
}
