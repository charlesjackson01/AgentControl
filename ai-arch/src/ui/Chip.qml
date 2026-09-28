import QtQuick

// Small pill button: hairline border, label, optional glyph. Used for
// suggestion chips and context actions.
Item {
    id: root
    property string text: ""
    property string glyph: ""
    property bool ai: false          // ai chips carry the command mark
    property bool showDot: false     // tiny accent dot (AI apps in launcher)
    signal activated()

    height: 28
    width: Math.max(10, text.length * 7.2 + (glyph || ai ? 30 : 14) + (showDot ? 14 : 0))
    opacity: ma.containsMouse ? 1.0 : 0.92
    Behavior on opacity { NumberAnimation { duration: Theme.animFast; easing.type: Easing.OutQuad } }

    Rectangle {
        anchors.fill: parent
        radius: Theme.radiusChip
        color: ma.containsMouse ? Theme.glass(0.95) : Theme.glass(0.88)
        border.color: ma.containsMouse ? Theme.focusLine() : Theme.hairlineSoft()
        border.width: 1
    }

    Row {
        anchors.centerIn: parent
        spacing: Theme.spaceSm

        Glyph {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.ai
            name: "mark"
            size: 15
            color: Theme.accent
        }
        Glyph {
            anchors.verticalCenter: parent.verticalCenter
            visible: !!root.glyph && !root.ai
            name: root.glyph
            size: 15
        }
        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.text
            font.family: Theme.fontSans
            font.pixelSize: Theme.typeSmall
            color: Theme.textPrimary
        }
        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: 5; height: 5; radius: 2.5
            visible: root.showDot
            color: Theme.accent
        }
    }

    MouseArea {
        id: ma
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.activated()
    }
}
