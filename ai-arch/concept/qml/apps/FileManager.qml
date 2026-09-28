import QtQuick
import QtQuick.Controls
import ".."
import "../components"

// Files (concept): sidebar, breadcrumbs, search filter, file rows with
// selection. The contextual AIBar (from the window frame) offers AI
// actions on the current folder.
Item {
    id: root
    property int selected: 5
    property string filter: ""

    Row {
        anchors.fill: parent

        // --- sidebar -----------------------------------------------------------
        Surface {
            width: 180
            height: parent.height
            radius: 0
            alpha_: Theme.raisedAlpha
            hasBorder: false

            Column {
                anchors.fill: parent
                anchors.margins: 10
                spacing: 2

                Text {
                    text: "Places"
                    font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; font.weight: Font.DemiBold
                    color: Theme.textDisabled
                }
                Repeater {
                    model: MockData.sidebar
                    delegate: Item {
                        width: parent.width
                        height: Theme.rowHeight - 6
                        Rectangle {
                            anchors.fill: parent; radius: Theme.radiusControl
                            color: modelData.name === "Projects" ? Theme.tint(Theme.accent, 0.08) : (sideMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.06) : "transparent")
                            Behavior on color { ColorAnimation { duration: Theme.animFast } }
                        }
                        Row {
                            anchors.fill: parent; anchors.leftMargin: 8; spacing: 8
                            Glyph { anchors.verticalCenter: parent.verticalCenter; name: modelData.glyph; size: 15 }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: modelData.name
                                font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                                color: modelData.name === "Projects" ? Theme.textPrimary : Theme.textSecondary
                            }
                        }
                        MouseArea { id: sideMa; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor }
                    }
                }
                Item { width: 1; height: 12 }
                Text {
                    text: "Storage"
                    font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; font.weight: Font.DemiBold
                    color: Theme.textDisabled
                }
                Item {
                    width: parent.width; height: 44
                    Column {
                        anchors.fill: parent; anchors.leftMargin: 8; anchors.rightMargin: 8
                        spacing: 4
                        Row {
                            spacing: 6
                            Glyph { anchors.verticalCenter: parent.verticalCenter; name: "layers"; size: 13; color: Theme.textSecondary }
                            Text { anchors.verticalCenter: parent.verticalCenter; text: "Arch Linux · 231 GB"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textSecondary }
                        }
                        Rectangle {
                            width: parent.width; height: 4; radius: 2
                            color: Theme.tint(Theme.textPrimary, 0.10)
                            Rectangle {
                                anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
                                width: parent.width * 0.4; height: 4; radius: 2
                                color: Theme.ok
                            }
                        }
                        Text { text: "92 GB used"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
                    }
                }
            }
        }

        // --- main area ------------------------------------------------------------
        Item {
            width: parent.width
            height: parent.height

            // toolbar: breadcrumbs + search
            Surface {
                id: toolbar
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

                    Glyph { anchors.verticalCenter: parent.verticalCenter; name: "chevron-r"; size: 14; color: Theme.textDisabled }
                    Repeater {
                        model: ["Projects", "ai-arch"]
                        delegate: Item {
                            height: parent.height
                            width: t.width + (index < 1 ? 18 : 0)
                            Row {
                                anchors.fill: parent
                                spacing: 6
                                Text {
                                    id: t
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: modelData
                                    font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                                    color: index === 1 ? Theme.textPrimary : Theme.textSecondary
                                    font.weight: index === 1 ? Font.DemiBold : Font.Normal
                                }
                                Glyph {
                                    anchors.verticalCenter: parent.verticalCenter
                                    visible: index < 1
                                    name: "chevron-r"; size: 12; color: Theme.textDisabled
                                }
                            }
                        }
                    }
                    Item { width: 1; height: 1 }
                    Rectangle {
                        width: 200; height: 28; radius: Theme.radiusChip
                        color: Theme.tint(Theme.textPrimary, 0.05)
                        border.color: Theme.hairlineSoft(); border.width: 1
                        Row {
                            anchors.fill: parent; anchors.leftMargin: 10; spacing: 6
                            Glyph { anchors.verticalCenter: parent.verticalCenter; name: "search"; size: 13; color: Theme.textDisabled }
                            TextField {
                                width: parent.width
                                anchors.verticalCenter: parent.verticalCenter
                                text: root.filter
                                onTextChanged: root.filter = text
                                placeholderText: "Filter files"
                                placeholderTextColor: Theme.textDisabled
                                color: Theme.textPrimary
                                background: null
                                font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                                selectByMouse: true
                            }
                        }
                    }
                }
            }

            // file list
            Item {
                anchors.top: toolbar.bottom
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom

                // column headers
                Row {
                    anchors.top: parent.top
                    anchors.left: parent.left
                    anchors.leftMargin: 16
                    anchors.right: parent.right
                    anchors.rightMargin: 16
                    height: 26
                    spacing: 0
                    Text { width: parent.width * 0.55; text: "Name"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
                    Text { width: parent.width * 0.2; text: "Size"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
                    Text { width: parent.width * 0.18; text: "Modified"; font.family: Theme.fontSans; font.pixelSize: Theme.typeMicro; color: Theme.textDisabled }
                }

                Flickable {
                    anchors.top: parent.top
                    anchors.topMargin: 26
                    anchors.bottom: parent.bottom
                    width: parent.width
                    contentHeight: listCol.height
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: listCol
                        width: parent.width

                        Repeater {
                            model: MockData.files.filter(function(f) {
                                return root.filter.length === 0 || f.name.toLowerCase().indexOf(root.filter.toLowerCase()) >= 0
                            })
                            delegate: Item {
                                width: parent.width
                                height: Theme.rowHeight
                                Rectangle {
                                    anchors.fill: parent
                                    anchors.leftMargin: 8
                                    anchors.rightMargin: 8
                                    radius: Theme.radiusControl
                                    color: root.selected === index
                                        ? Theme.tint(Theme.accent, 0.10)
                                        : (rowMa.containsMouse ? Theme.tint(Theme.textPrimary, 0.05) : "transparent")
                                    Behavior on color { ColorAnimation { duration: Theme.animFast } }
                                }
                                Row {
                                    anchors.fill: parent
                                    anchors.leftMargin: 12
                                    anchors.rightMargin: 12
                                    spacing: 0
                                    Row {
                                        width: parent.width * 0.55
                                        spacing: 10
                                        Glyph {
                                            anchors.verticalCenter: parent.verticalCenter
                                            name: modelData.type === "dir" ? "folder" : (modelData.type === "image" ? "image" : (modelData.type === "doc" ? "doc" : "file"))
                                            size: 16
                                            color: modelData.type === "dir" ? Theme.tint(Theme.accent, 0.85) : Theme.textSecondary
                                        }
                                        Text {
                                            anchors.verticalCenter: parent.verticalCenter
                                            text: modelData.name
                                            font.family: Theme.fontSans; font.pixelSize: Theme.typeBody
                                            color: root.selected === index ? Theme.textPrimary : Theme.textSecondary
                                        }
                                    }
                                    Text {
                                        width: parent.width * 0.2
                                        text: modelData.size
                                        font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                                        color: Theme.textSecondary
                                    }
                                    Text {
                                        width: parent.width * 0.18
                                        text: modelData.date
                                        font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
                                        color: Theme.textDisabled
                                    }
                                }
                                MouseArea {
                                    id: rowMa
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
        }
    }
}
