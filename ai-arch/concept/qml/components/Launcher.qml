import QtQuick
import QtQuick.Controls
import ".."

// Kickoff launcher: search (filters the grid live), recent, favorites,
// full app grid. AI-native apps carry a subtle cyan dot. 720x560.
Surface {
    id: root
    width: 720
    height: 560
    radius: Theme.radiusPopup
    alpha_: Theme.overlayAlpha
    anchors.centerIn: parent
    visible: shell.launcherOpen
    opacity: visible ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutQuad } }
    Behavior on y { NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutQuad } }

    property string query: ""

    function launch(id) { shell.launchApp(id); shell.launcherOpen = false }

    Item {
        anchors.fill: parent
        anchors.margins: 20

        // --- search -----------------------------------------------------------
        Rectangle {
            id: searchBar
            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: 38
            radius: Theme.radiusControl
            color: Theme.tint(Theme.textPrimary, 0.05)
            border.color: searchMa.activeFocus ? Theme.focusLine() : Theme.hairlineSoft()
            border.width: 1

            Row {
                anchors.fill: parent
                anchors.leftMargin: 12
                anchors.rightMargin: 10
                spacing: 8
                Glyph { anchors.verticalCenter: parent.verticalCenter; name: "search"; size: 16 }
                TextField {
                    id: search
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width
                    text: root.query
                    onTextChanged: root.query = text
                    background: null
                    color: Theme.textPrimary
                    placeholderText: "Search applications"
                    placeholderTextColor: Theme.textDisabled
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.typeBody
                    selectByMouse: true
                    onAccepted: {}
                }
                MouseArea { id: searchMa; anchors.fill: parent; anchors.leftMargin: 40; onClicked: search.forceActiveFocus() }
            }
        }

        // --- recent -------------------------------------------------------------
        Column {
            id: recentCol
            anchors.top: searchBar.bottom
            anchors.topMargin: 14
            anchors.left: parent.left
            anchors.right: parent.right
            spacing: 8
            Text {
                text: "Recent"
                font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; font.weight: Font.DemiBold
                color: Theme.textSecondary
            }
            Row {
                spacing: 8
                Repeater {
                    model: MockData.recent
                    delegate: Item {
                        width: 156; height: 40
                        Rectangle {
                            anchors.fill: parent; radius: Theme.radiusControl
                            color: ma.containsMouse ? Theme.tint(Theme.textPrimary, 0.06) : Theme.glass(0.90)
                            border.color: Theme.hairlineSoft(); border.width: 1
                        }
                        Row {
                            anchors.centerIn: parent; spacing: 8
                            Glyph { anchors.verticalCenter: parent.verticalCenter; name: modelData.glyph; size: 16 }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.name
                                font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                                color: Theme.textPrimary;                                 elide: Text.ElideRight
                                width: 100
                            }
                        }
                        MouseArea { id: recentMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor }
                    }
                }
            }
        }

        // --- favorites ---------------------------------------------------------
        Column {
            id: favCol
            anchors.top: recentCol.bottom
            anchors.topMargin: 14
            anchors.left: parent.left
            anchors.right: parent.right
            spacing: 8
            Text {
                text: "Favorites"
                font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; font.weight: Font.DemiBold
                color: Theme.textSecondary
            }
            Row {
                spacing: 8
                Repeater {
                    model: MockData.apps.filter(function(a) { return a.fav })
                    delegate: Item {
                        width: 80; height: 64
                        Column {
                            anchors.fill: parent; spacing: 6
                            Rectangle {
                                anchors.horizontalCenter: parent.horizontalCenter
                                width: 44; height: 44; radius: 10
                                color: favMa.containsMouse ? Theme.tint(Theme.accent, 0.08) : Theme.tint(Theme.textPrimary, 0.05)
                                border.color: Theme.hairlineSoft(); border.width: 1
                                Glyph { anchors.centerIn: parent; name: modelData.glyph; size: 22; color: modelData.ai ? Theme.tint(Theme.accent, 0.9) : Theme.textPrimary }
                            }
                            Text {
                                anchors.horizontalCenter: parent.horizontalCenter
                                text: modelData.name
                                font.family: Theme.fontSans; font.pixelSize: 10
                                color: Theme.textSecondary
                                elide: Text.ElideRight; width: 76; horizontalAlignment: Text.AlignHCenter
                            }
                        }
                        MouseArea {
                            id: favMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                            onClicked: root.launch(modelData.id)
                        }
                    }
                }
            }
        }

        // --- all apps grid -------------------------------------------------------
        Item {
            anchors.top: favCol.bottom
            anchors.topMargin: 14
            anchors.bottom: parent.bottom
            anchors.left: parent.left
            anchors.right: parent.right

            Text {
                id: gridTitle
                anchors.top: parent.top
                text: "Applications"
                font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; font.weight: Font.DemiBold
                color: Theme.textSecondary
            }
            GridView {
                id: appGrid
                anchors.top: gridTitle.bottom
                anchors.topMargin: 8
                anchors.bottom: parent.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                cellWidth: 92
                cellHeight: 72
                model: MockData.apps.filter(function(a) {
                    return root.query.length === 0 || a.name.toLowerCase().indexOf(root.query.toLowerCase()) >= 0
                })
                delegate: Item {
                    width: GridView.cellWidth
                    height: GridView.cellHeight
                    Column {
                        anchors.centerIn: parent; spacing: 6
                            Rectangle {
                                anchors.horizontalCenter: parent.horizontalCenter
                                width: 44; height: 44; radius: 10
                                color: gridMa.containsMouse ? Theme.tint(Theme.accent, 0.08) : Theme.tint(Theme.textPrimary, 0.05)
                                border.color: Theme.hairlineSoft(); border.width: 1
                                Row {
                                anchors.centerIn: parent; spacing: 4
                                Glyph { anchors.verticalCenter: parent.verticalCenter; name: modelData.glyph; size: 22; color: modelData.ai ? Theme.tint(Theme.accent, 0.9) : Theme.textPrimary }
                                Rectangle {
                                    anchors.verticalCenter: parent.verticalCenter
                                    width: 5; height: 5; radius: 2.5
                                    visible: modelData.ai
                                    color: Theme.accent
                                }
                            }
                        }
                        Text {
                            anchors.horizontalCenter: parent.horizontalCenter
                            text: modelData.name
                            font.family: Theme.fontSans; font.pixelSize: 10
                            color: Theme.textSecondary
                            elide: Text.ElideRight; width: 84; horizontalAlignment: Text.AlignHCenter
                        }
                    }
                    MouseArea {
                        id: gridMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: root.launch(modelData.id)
                    }
                }
            }
        }
    }

    // (outside-click dismissal is handled by the shell overlay)
}
