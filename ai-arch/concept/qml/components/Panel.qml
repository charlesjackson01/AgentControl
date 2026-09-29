import QtQuick
import ".."

// Bottom floating task panel: kickoff + AI entry (left), task entries
// (left of center), workspace indicator + tray (right). 48px, 85% width.
Surface {
    id: root
    width: shell.designW * 0.85
    height: 48
    radius: Theme.radiusPopup
    alpha_: Theme.raisedAlpha
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 12

    // --- left cluster: kickoff + AI entry ------------------------------------
    Row {
        id: leftGroup
        anchors.left: parent.left
        anchors.leftMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        spacing: 6

        Item {
            width: 36; height: 36
            Rectangle {
                anchors.fill: parent; radius: Theme.radiusControl
                color: kickMa.containsMouse || shell.launcherOpen ? Theme.tint(Theme.textPrimary, 0.08) : "transparent"
            }
            Glyph { anchors.centerIn: parent; name: "grid"; size: 19 }
            MouseArea { id: kickMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: shell.toggleLauncher() }
        }

        // AI command center entry (the subtle global AI affordance)
        Item {
            width: 36; height: 36
            Rectangle {
                anchors.fill: parent; radius: Theme.radiusControl
                color: aiMa.containsMouse || shell.winVisible("ai-control") ? Theme.tint(Theme.accent, 0.10) : "transparent"
                Behavior on color { ColorAnimation { duration: Theme.animFast } }
            }
            Glyph { anchors.centerIn: parent; name: "mark"; size: 19; color: Theme.tint(Theme.accent, 0.9) }
            MouseArea { id: aiMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: shell.toggleAi() }
        }

        Rectangle {
            width: 1; height: 24
            anchors.verticalCenter: parent.verticalCenter
            color: Theme.hairlineSoft()
        }
    }

    // --- task entries ----------------------------------------------------------
    Item {
        id: taskHost
        anchors.left: leftGroup.right
        anchors.leftMargin: 6
        anchors.verticalCenter: parent.verticalCenter
        width: taskRow.width + 8
        height: 36

        Row {
            id: taskRow
            spacing: 4

            Repeater {
                model: shell.taskList
                delegate: Item {
                    width: taskMa.containsMouse ? 150 : 132
                    height: 36
                    Behavior on width { NumberAnimation { duration: Theme.animFast } }

                    Rectangle {
                        anchors.fill: parent; radius: Theme.radiusControl
                        color: taskMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.06) : "transparent"
                    }
                    // active-window accent underline
                    Rectangle {
                        anchors.bottom: parent.bottom; anchors.left: parent.left; anchors.right: parent.right
                        anchors.bottomMargin: 2
                        height: 2; radius: 1
                        visible: shell.focusedId() === modelData.id && !modelData.minimized
                        color: Theme.accent
                    }

                    Row {
                        anchors.centerIn: parent
                        spacing: 6
                        Glyph {
                            anchors.verticalCenter: parent.verticalCenter
                            name: modelData.icon
                            size: 15
                            opacity: modelData.minimized ? 0.45 : 1
                        }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: modelData.title
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.typeSmall
                            color: modelData.minimized ? Theme.textDisabled : Theme.textSecondary
                            elide: Text.ElideRight
                            width: Math.max(20, 132 - 34 - (taskMa.containsMouse ? 18 : 0))
                        }
                    }
                    MouseArea {
                        id: taskMa
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: shell.taskClick(modelData.id)
                    }
                }
            }
        }
    }

    // --- right cluster: workspace + tray ---------------------------------------
    Row {
        id: rightGroup
        anchors.right: parent.right
        anchors.rightMargin: 10
        anchors.verticalCenter: parent.verticalCenter
        spacing: 6

        Row {
            anchors.verticalCenter: parent.verticalCenter
            spacing: 5
            Repeater {
                model: 3
                delegate: Rectangle {
                    width: modelData === 1 ? 14 : 6; height: 6
                    radius: 3
                    color: modelData === 1 ? Theme.tint(Theme.accent, 0.85) : Theme.tint(Theme.textPrimary, 0.25)
                }
            }
        }

        Rectangle {
            width: 1; height: 24
            anchors.verticalCenter: parent.verticalCenter
            color: Theme.hairlineSoft()
        }

        Item {
            width: 30; height: 30
            anchors.verticalCenter: parent.verticalCenter
            Rectangle {
                anchors.fill: parent; radius: Theme.radiusControl
                color: wifiMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.08) : "transparent"
            }
            Glyph { anchors.centerIn: parent; name: "wifi"; size: 16 }
            MouseArea { id: wifiMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: shell.toggleQuick() }
        }
        Item {
            width: 30; height: 30
            anchors.verticalCenter: parent.verticalCenter
            Rectangle {
                anchors.fill: parent; radius: Theme.radiusControl
                color: volMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.08) : "transparent"
            }
            Glyph { anchors.centerIn: parent; name: "volume"; size: 16 }
            MouseArea { id: volMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: shell.toggleQuick() }
        }
        Item {
            width: 30; height: 30
            anchors.verticalCenter: parent.verticalCenter
            Rectangle {
                anchors.fill: parent; radius: Theme.radiusControl
                color: bellMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.08) : "transparent"
            }
            Glyph { anchors.centerIn: parent; name: "bell"; size: 16 }
            Rectangle {
                anchors.right: parent.right; anchors.rightMargin: 1
                anchors.top: parent.top
                width: 12; height: 12; radius: 6
                visible: shell.notifCount > 0
                color: Theme.accent
                Text {
                    anchors.fill: parent; anchors.margins: 2
                    verticalAlignment: Text.AlignVCenter; horizontalAlignment: Text.AlignHCenter
                    text: shell.notifCount
                    font.pixelSize: 9; font.family: Theme.fontSans; font.weight: Font.Bold
                    color: Theme.bgDeep
                }
            }
            MouseArea { id: bellMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: shell.toggleNotifs() }
        }
        Item {
            width: 64; height: 30
            anchors.verticalCenter: parent.verticalCenter
            Rectangle {
                anchors.fill: parent; radius: Theme.radiusControl
                color: clkMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.08) : "transparent"
            }
            Text {
                anchors.centerIn: parent
                text: shell.clock
                font.family: Theme.fontSans
                font.pixelSize: Theme.typeSmall
                color: Theme.textPrimary
            }
            MouseArea { id: clkMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: shell.toggleQuick() }
        }
    }
}
