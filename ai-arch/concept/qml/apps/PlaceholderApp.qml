import QtQuick
import ".."
import "../components"

// Generic placeholder for launcher apps without a dedicated concept
// surface. Proves the normal-app window model works for any app.
Item {
    id: root
    property string appName: "Application"
    property string appGlyph: "grid"

    Column {
        anchors.centerIn: parent
        spacing: 12

        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            width: 64; height: 64; radius: 14
            color: Theme.tint(Theme.textPrimary, 0.05)
            border.color: Theme.hairlineSoft(); border.width: 1
            Glyph { anchors.centerIn: parent; name: root.appGlyph; size: 30; color: Theme.textSecondary }
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: root.appName
            font.family: Theme.fontSans; font.pixelSize: Theme.typeView; font.weight: Font.DemiBold
            color: Theme.textPrimary
        }
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "Concept placeholder — window model only"
            font.family: Theme.fontSans; font.pixelSize: Theme.typeSmall
            color: Theme.textSecondary
        }
    }
}
