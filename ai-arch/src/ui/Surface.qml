import QtQuick

// Glass surface: translucent fill + 1px hairline border + optional radius.
// Depth comes from alpha over the wallpaper, not from drop shadows.
// radius is the native Rectangle radius (default Theme.radiusCard);
// set hasBorder: false for flush strips inside a window.
Rectangle {
    id: root
    default property alias content: contentItem.data

    property color base: Theme.bgWindow
    property real surfaceAlpha: Theme.surfaceAlpha
    property bool raised: false
    property bool hasBorder: true
    property color borderColor: Theme.hairline()

    radius: Theme.radiusCard
    color: base === Theme.bgWindow ? Theme.glass(surfaceAlpha) : Theme.tint(base, surfaceAlpha)
    border.color: hasBorder ? (raised ? Theme.hairline() : Theme.hairlineSoft()) : "transparent"
    border.width: hasBorder ? 1 : 0

    // 1px darker base edge sells "raised" without a shadow blur.
    Rectangle {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        height: 1
        visible: root.raised
        color: Qt.rgba(0, 0, 0, 0.35)
        radius: 0
    }

    Item { id: contentItem; anchors.fill: parent }
}
