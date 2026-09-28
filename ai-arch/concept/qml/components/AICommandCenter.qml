import QtQuick
import QtQuick.Controls
import ".."

// AI Command Center: the OS-level AI surface. Conversation with mock
// responses, context chips (model/agent state), command input with
// suggestions, and visually distinct system-action cards. This is a
// concept prototype: all data is mock, no inference runs here.
Item {
    id: root

    function pushUser(text) { shell.pushChat("user", text) }

    // --- context strip -----------------------------------------------------
    Surface {
        id: ctxStrip
        anchors.top: parent.top
        anchors.left: parent.left
        anchors.right: parent.right
        height: 44
        radius: 0
        alpha_: Theme.raisedAlpha
        hasBorder: false

        Row {
            anchors.fill: parent
            anchors.leftMargin: 14
            anchors.rightMargin: 14
            spacing: 8

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "Context: " + shell.aiContextLabel()
                font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                color: Theme.textSecondary
            }
            Item { width: 1; height: 1 }
            Repeater {
                model: MockData.context
                delegate: Item {
                    height: 26
                    width: 10 + cName.width + cSub.width + 34
                    Row {
                        anchors.fill: parent
                        spacing: 6
                        Rectangle {
                            width: 7; height: 7; radius: 3.5
                            anchors.verticalCenter: parent.verticalCenter
                            color: modelData.state === "idle" ? Theme.textDisabled : Theme.ok
                        }
                        Text { id: cName; anchors.verticalCenter: parent.verticalCenter; text: modelData.name; font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall; color: Theme.textPrimary }
                        Text { id: cSub; anchors.verticalCenter: parent.verticalCenter; text: modelData.sub; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textSecondary }
                    }
                }
            }
        }
    }

    // --- conversation -------------------------------------------------------
    Flickable {
        id: convo
        anchors.top: ctxStrip.bottom
        anchors.bottom: cmdStrip.top
        anchors.left: parent.left
        anchors.right: parent.right
        contentWidth: convoCol.width
        contentHeight: convoCol.height
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        onContentYChanged: if (atYEnd) contentY = contentHeight - height

        Column {
            id: convoCol
            width: parent.width - 28
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: 12

            Repeater {
                model: shell.chat
                delegate: Item {
                    width: parent.width
                    height: childCol.height
                    Row {
                        id: childCol
                        width: parent.width
                        spacing: 10

                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            width: 30; height: 30; radius: 8
                            visible: modelData.who !== "system"
                            color: modelData.who === "ai" ? Theme.tint(Theme.accent, 0.10) : Theme.tint(Theme.textPrimary, 0.06)
                            border.color: Theme.hairlineSoft(); border.width: 1
                            Glyph {
                                anchors.centerIn: parent
                                name: modelData.who === "ai" ? "mark" : "user"
                                size: 14
                                color: modelData.who === "ai" ? Theme.accent : Theme.textSecondary
                            }
                        }
                        Item { width: modelData.who === "system" ? 0 : 30; height: 1 }

                        Column {
                            width: parent.width - (modelData.who === "system" ? 0 : 30)
                            spacing: 4

                            // user bubble
                            Rectangle {
                                visible: modelData.who === "user"
                                width: parent.width - 40
                                height: userT.implicitHeight + 18
                                radius: Theme.radiusCard
                                color: Theme.tint(Theme.violet, 0.10)
                                border.color: Theme.hairlineSoft(); border.width: 1
                                Text {
                                    id: userT
                                    anchors.fill: parent; anchors.margins: 14
                                    text: modelData.text
                                    font.family: Theme.fontSans; font.pixelSize: Theme.typeBody
                                    color: Theme.textPrimary
                                    wrapMode: Text.WordWrap
                                    width: parent.width - 28
                                }
                            }

                            // ai bubble
                            Rectangle {
                                visible: modelData.who === "ai"
                                width: Math.min(parent.width - 40, aiT.implicitHeight > 44 ? parent.width - 40 : aiT.implicitWidth + 28)
                                height: aiT.implicitHeight + 18
                                radius: Theme.radiusCard
                                color: Theme.glass(Theme.raisedAlpha)
                                border.color: Theme.hairlineSoft(); border.width: 1
                                Text {
                                    id: aiT
                                    anchors.fill: parent; anchors.margins: 14
                                    text: modelData.text
                                    font.family: Theme.fontSans; font.pixelSize: Theme.typeBody
                                    color: Theme.textPrimary
                                    wrapMode: Text.WordWrap
                                    width: parent.width - 28
                                }
                            }

                            // system action card (distinct from conversation)
                            Rectangle {
                                visible: modelData.who === "system"
                                width: parent.width - 20
                                height: 52
                                radius: Theme.radiusCard
                                color: Theme.tint(Theme.textPrimary, 0.045)
                                border.color: Theme.hairline(); border.width: 1
                                Row {
                                    anchors.fill: parent
                                    anchors.leftMargin: 12
                                    anchors.rightMargin: 12
                                    spacing: 10
                                    Rectangle {
                                        anchors.verticalCenter: parent.verticalCenter
                                        width: 30; height: 30; radius: 7
                                        color: Theme.tint(Theme.accent, 0.08)
                                        border.color: Theme.hairlineSoft(); border.width: 1
                                        Glyph { anchors.centerIn: parent; name: "layers"; size: 15; color: Theme.accent }
                                    }
                                    Column {
                                        anchors.verticalCenter: parent.verticalCenter
                                        spacing: 2
                                        Text { text: "SYSTEM ACTION"; font.family: Theme.fontSans; font.pixelSize: 9; font.weight: Font.DemiBold; color: Theme.textDisabled; font.letterSpacing: 0.8 }
                                        Text { text: modelData.title; font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall; font.weight: Font.DemiBold; color: Theme.textPrimary }
                                    }
                                    Item { width: 1; height: 1 }
                                    Text {
                                        anchors.verticalCenter: parent.verticalCenter
                                        text: modelData.detail
                                        font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro
                                        color: Theme.textSecondary
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // --- command input ---------------------------------------------------------
    Surface {
        id: cmdStrip
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: 86
        radius: 0
        alpha_: Theme.raisedAlpha
        hasBorder: false

        Column {
            anchors.fill: parent
            anchors.leftMargin: 14
            anchors.rightMargin: 14
            anchors.topMargin: 10
            anchors.bottomMargin: 10
            spacing: 8

            Row {
                spacing: 6
                Repeater {
                    model: MockData.suggestions
                    delegate: Chip {
                        text: modelData
                        height: 22
                        onActivated: inputText.text = modelData
                    }
                }
            }
            Row {
                width: parent.width
                spacing: 8
                Rectangle {
                    width: parent.width
                    height: 38; radius: Theme.radiusControl
                    color: Theme.tint(Theme.textPrimary, 0.05)
                    border.color: inputText.activeFocus ? Theme.focusLine() : Theme.hairlineSoft()
                    border.width: 1
                    Behavior on border.color { ColorAnimation { duration: Theme.animFast } }

                    Row {
                        anchors.fill: parent
                        anchors.leftMargin: 10
                        anchors.rightMargin: 10
                        spacing: 8
                        Glyph { anchors.verticalCenter: parent.verticalCenter; name: "mark"; size: 15; color: Theme.tint(Theme.accent, 0.9) }
                        TextField {
                            id: inputText
                            anchors.verticalCenter: parent.verticalCenter
                            width: parent.width - 30
                            placeholderText: "Ask the AI, or command the system…"
                            placeholderTextColor: Theme.textDisabled
                            color: Theme.textPrimary
                            background: null
                            font.family: Theme.fontSans
                            font.pixelSize: Theme.typeBody
                            selectByMouse: true
                            onAccepted: { root.pushUser(text); text = "" }
                        }
                    }
                }
                Rectangle {
                    width: 38; height: 38; radius: Theme.radiusControl
                    color: sendMa.containsMouse ? Theme.tint(Theme.accent, 0.25) : Theme.tint(Theme.accent, 0.12)
                    Behavior on color { ColorAnimation { duration: Theme.animFast } }
                    Glyph { anchors.centerIn: parent; name: "chat"; size: 16; color: Theme.accent }
                    MouseArea {
                        id: sendMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
                        onClicked: { root.pushUser(inputText.text); inputText.text = "" }
                    }
                }
            }
        }
    }
}
