import QtQuick
import org.kde.kwin.decoration

// Flat minimal titlebar button: drawn glyphs (no icon theme dependency),
// subtle cyan-tinted hover (close: muted red tint), 100 ms transitions.
DecorationButton {
    id: control

    // set from the decoration (QML ids are not shared across files)
    property bool windowActive: true
    property real size: 34

    readonly property bool isClose: buttonType === DecorationOptions.DecorationButtonClose
    readonly property bool isMaximize: buttonType === DecorationOptions.DecorationButtonMaximizeRestore

    width: size
    height: size

    readonly property color iconNormal: windowActive ? "#aeb6bf" : "#6b747d"
    readonly property color iconHover: windowActive ? "#e8ecf0" : "#9aa2ab"
    readonly property color iconCloseHover: "#f85149"
    readonly property color hoverBg: isClose
        ? Qt.rgba(0.97, 0.32, 0.29, 0.16)
        : Qt.rgba(0.25, 0.75, 0.86, 0.12)
    readonly property color pressedBg: isClose
        ? Qt.rgba(0.97, 0.32, 0.29, 0.28)
        : Qt.rgba(0.25, 0.75, 0.86, 0.22)

    readonly property color currentIcon:
        pressed ? iconHover :
        hovered ? (isClose ? iconCloseHover : iconHover) : iconNormal

    Rectangle {
        id: bg
        anchors.fill: parent
        radius: 5
        color: pressed ? control.pressedBg
            : hovered ? control.hoverBg : "transparent"
        Behavior on color {
            ColorAnimation { duration: 100 }
        }
    }

    // glyph area, centered
    Item {
        id: glyph
        width: 11
        height: 11
        anchors.centerIn: parent

        // minimize: bar
        Rectangle {
            visible: control.buttonType === DecorationOptions.DecorationButtonMinimize
            anchors.centerIn: parent
            width: 10
            height: 1.5
            color: control.currentIcon
            Behavior on color { ColorAnimation { duration: 100 } }
        }

        // maximize: square outline
        Rectangle {
            visible: control.isMaximize && !control.toggled
            anchors.centerIn: parent
            width: 9
            height: 9
            radius: 1
            color: "transparent"
            border.width: 1.5
            border.color: control.currentIcon
            Behavior on border.color { ColorAnimation { duration: 100 } }
        }

        // restore: two overlapping squares
        Item {
            visible: control.isMaximize && control.toggled
            anchors.centerIn: parent
            Rectangle {
                x: 2.5
                y: 0
                width: 8
                height: 8
                radius: 1
                color: "transparent"
                border.width: 1.5
                border.color: control.currentIcon
                Behavior on border.color { ColorAnimation { duration: 100 } }
            }
            Rectangle {
                x: 0
                y: 2.5
                width: 8
                height: 8
                radius: 1
                color: "#12161c"
                border.width: 1.5
                border.color: control.currentIcon
                Behavior on border.color { ColorAnimation { duration: 100 } }
            }
        }

        // close: X
        Item {
            visible: control.isClose
            anchors.centerIn: parent
            Rectangle {
                anchors.centerIn: parent
                width: 12
                height: 1.5
                rotation: 45
                color: control.currentIcon
                Behavior on color { ColorAnimation { duration: 100 } }
            }
            Rectangle {
                anchors.centerIn: parent
                width: 12
                height: 1.5
                rotation: -45
                color: control.currentIcon
                Behavior on color { ColorAnimation { duration: 100 } }
            }
        }
    }
}
