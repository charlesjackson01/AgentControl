import QtQuick
import org.kde.kwin.decoration

// AI-Arch window decoration (docs/AI-ARCH-DESIGN.md):
// near-black glass titlebar, 1px hairline border, subtle cyan accent
// line on active windows, flat minimal buttons, centered caption.
Decoration {
    id: root

    alpha: false

    readonly property bool active: decoration.client.active
    readonly property bool maximized: decoration.client.maximized

    readonly property int titleHeight: 34
    readonly property int titleHeightMax: 30

    readonly property color borderActive: "#2c3540"
    readonly property color borderInactive: "#1c2128"
    readonly property color accent: "#40bedc"

    DecorationOptions {
        id: options
        deco: decoration
    }

    Component.onCompleted: {
        borders.setBorders(1);
        borders.setTitle(root.titleHeight);
        maximizedBorders.setBorders(0);
        maximizedBorders.setTitle(root.titleHeightMax);
    }

    Rectangle {
        id: frame
        anchors.fill: parent
        color: root.active ? "#12161c" : "#0f1318"
        Behavior on color {
            ColorAnimation { duration: 120 }
        }

        // 1px hairline window frame (non-maximized only); drawn first so the
        // titlebar (and its cyan accent line) wins at the top edge
        Rectangle {
            anchors.fill: parent
            visible: !root.maximized
            border.width: 1
            color: root.active ? root.borderActive : root.borderInactive
            Behavior on color {
                ColorAnimation { duration: 120 }
            }
        }

        Rectangle {
            id: titleBar
            anchors {
                left: parent.left
                right: parent.right
                top: parent.top
            }
            height: root.maximized ? root.titleHeightMax : root.titleHeight
            gradient: Gradient {
                GradientStop {
                    position: 0.0
                    color: root.active ? "#1b2027" : "#151a20"
                }
                GradientStop {
                    position: 1.0
                    color: root.active ? "#12161c" : "#0f1318"
                }
            }

            // 1px cyan accent line, active windows only
            Rectangle {
                anchors {
                    left: parent.left
                    right: parent.right
                    top: parent.top
                }
                height: 1
                color: root.accent
                opacity: root.active ? 0.85 : 0.0
                Behavior on opacity {
                    NumberAnimation { duration: 120 }
                }
            }

            // hairline under the titlebar
            Rectangle {
                anchors {
                    left: parent.left
                    right: parent.right
                    bottom: parent.bottom
                }
                height: 1
                visible: !root.maximized
                color: root.active ? "#232a33" : "#171c22"
            }

            Item {
                id: titleRow
                anchors.fill: parent

                ButtonGroup {
                    id: rightGroup
                    anchors {
                        top: parent.top
                        right: parent.right
                        rightMargin: 1
                    }
                    spacing: 0
                    explicitSpacer: titleBar.height
                    buttons: options.titleButtonsRight
                    minimizeButton: minimizeButtonComponent
                    maximizeButton: maximizeButtonComponent
                    closeButton: closeButtonComponent
                }

                Text {
                    id: caption
                    textFormat: Text.PlainText
                    anchors {
                        top: parent.top
                        bottom: parent.bottom
                        left: parent.left
                        right: rightGroup.left
                    }
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                    elide: Text.ElideMiddle
                    renderType: Text.NativeRendering
                    text: decoration.client.caption
                    font.pixelSize: 13
                    color: root.active ? "#e8ecf0" : "#7d868f"
                    Behavior on color {
                        ColorAnimation { duration: 120 }
                    }
                }

                Component.onCompleted: {
                    decoration.installTitleItem(titleRow);
                }
            }
        }

    }

    Component {
        id: minimizeButtonComponent
        TitleButton {
            buttonType: DecorationOptions.DecorationButtonMinimize
            size: titleBar.height
            windowActive: root.active
        }
    }
    Component {
        id: maximizeButtonComponent
        TitleButton {
            buttonType: DecorationOptions.DecorationButtonMaximizeRestore
            size: titleBar.height
            windowActive: root.active
        }
    }
    Component {
        id: closeButtonComponent
        TitleButton {
            buttonType: DecorationOptions.DecorationButtonClose
            size: titleBar.height
            windowActive: root.active
        }
    }
}
