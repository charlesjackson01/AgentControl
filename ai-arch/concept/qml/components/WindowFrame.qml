import QtQuick
import ".."

// Concept window frame: translucent chrome, 40px title bar with icon,
// title, minimize/maximize/close. Focus state uses the accent hairline.
// Dragging the title bar moves the window (parent must be the desktop).
Rectangle {
    id: root
    property var contentComponent: null

    property string appId: ""
    property string title: ""
    property string icon: "grid"
    property bool focused: false
    property bool maximized: false
    property bool minimized: false

    // area of the desktop usable for windows (above the panel)
    property int desktopW: 1920
    property int desktopH: 1080
    property int defaultW: 960
    property int defaultH: 640

    visible: !minimized
    width: maximized ? desktopW : Math.min(desktopW, defaultW)
    height: maximized ? desktopH : Math.min(desktopH, defaultH)
    z: 0
    opacity: 1
    color: "transparent"
    transformOrigin: Item.Center
    scale: 1.0
    Behavior on scale { NumberAnimation { duration: Theme.animMed; easing.type: Easing.OutQuad } }
    Behavior on opacity { NumberAnimation { duration: Theme.animMed; easing.type: Easing.OutQuad } }

    // animate in when the shell makes the window visible
    onVisibleChanged: {
        if (visible) {
            scale = 0.97
            opacity = 0
            Qt.callLater(function() { scale = 1.0; opacity = 1; })
        }
    }

    // window body (glass fill)
    Rectangle {
        anchors.fill: parent
        radius: Theme.radiusCard
        color: Theme.glass(Theme.surfaceAlpha)
    }

    // title bar
    Rectangle {
        id: titlebar
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: 40
        color: "transparent"
        radius: 0

        Rectangle {
            anchors.left: parent.left; anchors.right: parent.right; anchors.bottom: parent.bottom
            height: 1
            color: Theme.hairlineSoft()
        }

        Row {
            anchors.left: parent.left
            anchors.leftMargin: 14
            anchors.verticalCenter: parent.verticalCenter
            spacing: 10

            Glyph {
                anchors.verticalCenter: parent.verticalCenter
                name: root.icon
                size: 18
                color: root.focused ? Theme.textPrimary : Theme.textSecondary
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.title
                font.family: Theme.fontSans
                font.pixelSize: Theme.typeSmall
                color: root.focused ? Theme.textPrimary : Theme.textSecondary
            }
        }

        // window buttons
        Row {
            anchors.right: parent.right
            anchors.rightMargin: 8
            anchors.verticalCenter: parent.verticalCenter
            spacing: 2

            Repeater {
                model: [
                    { glyph: "min",  act: "min" },
                    { glyph: root.maximized ? "restore" : "max", act: root.maximized ? "restore" : "max" },
                    { glyph: "close", act: "close" }
                ]
                delegate: Item {
                    width: 30; height: 28
                    Rectangle {
                        anchors.fill: parent
                        radius: Theme.radiusControl
                        color: ma.containsMouse ? (modelData.act === "close" ? Theme.tint(Theme.err, 0.18) : Theme.tint(Theme.textPrimary, 0.08)) : "transparent"
                    }
                    Glyph {
                        anchors.centerIn: parent
                        name: modelData.glyph
                        size: 13
                        color: Theme.textSecondary
                    }
                    MouseArea {
                        id: ma
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            if (modelData.act === "min") shell.minimizeWin(root.appId)
                            else if (modelData.act === "max") shell.toggleMax(root.appId)
                            else shell.closeWin(root.appId)
                        }
                    }
                }
            }
        }

        MouseArea {
            anchors.fill: parent
            z: -1
            property point p
            onPressed: p = mouse
            onPositionChanged: {
                if (pressed) {
                    let nx = root.x + mouse.x - p.x
                    let ny = root.y + mouse.y - p.y
                    root.x = Math.max(0, Math.min(root.desktopW - 80, nx))
                    root.y = Math.max(0, Math.min(root.desktopH - 40, ny))
                }
            }
            onDoubleClicked: shell.toggleMax(root.appId)
        }
    }

    Loader {
        id: contentLoader
        sourceComponent: root.contentComponent
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: titlebar.bottom
        anchors.bottom: parent.bottom
        clip: true
    }

    // focus / hairline border overlay: drawn above content so the 1px
    // edge stays visible even where the window content is opaque
    Rectangle {
        anchors.fill: parent
        radius: Theme.radiusCard
        color: "transparent"
        border.color: root.focused ? Theme.focusLine() : Theme.hairline()
        border.width: 1
        z: 100
        Behavior on border.color { ColorAnimation { duration: Theme.animFast } }
    }

    // context AI layer (suggestion chips) - shown by apps via shell
    AIBar {
        id: aiBar
        anchors.right: parent.right
        anchors.rightMargin: 12
        anchors.top: titlebar.bottom
        anchors.topMargin: 10
        visible: shell.aiBarFor(root.appId) && root.focused && !root.maximized
        actions: shell.actionsFor(root.appId)
        onAction: (label) => shell.sendContextAction(root.appId, label)
        opacity: visible ? 1 : 0
        Behavior on opacity { NumberAnimation { duration: Theme.animMed; easing.type: Easing.OutQuad } }
    }
}
