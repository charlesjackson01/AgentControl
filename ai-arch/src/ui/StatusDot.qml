import QtQuick

// 6 px endpoint status dot, shared by AIBar, the panel plasmoid, and the KCM.
// state: offline | connected | degraded | working
Item {
    id: root
    property string state: "offline"

    readonly property color dotColor:
        (state === "connected" || state === "working") ? Theme.accent
        : state === "degraded" ? Theme.warn
        : Theme.textDisabled

    width: 12
    height: 12

    Rectangle {
        anchors.centerIn: parent
        width: 6; height: 6; radius: 3
        color: root.dotColor
        opacity: root.state === "offline" ? 0.55 : 1.0
    }

    // pulse ring while a request is working
    Rectangle {
        id: ring
        anchors.centerIn: parent
        width: 6; height: 6; radius: 3
        color: root.dotColor
        visible: root.state === "working"
        opacity: 0.0
        scale: 1.0
        SequentialAnimation {
            running: root.state === "working"
            loops: Animation.Infinite
            ParallelAnimation {
                NumberAnimation { target: ring; property: "scale"; from: 1.0; to: 2.4;
                                  duration: Theme.animMed; easing.type: Easing.OutQuad }
                NumberAnimation { target: ring; property: "opacity"; from: 0.5; to: 0.0;
                                  duration: Theme.animMed }
            }
            NumberAnimation { target: ring; property: "scale"; to: 1.0; duration: 1 }
            NumberAnimation { target: ring; property: "opacity"; to: 0.0; duration: 1 }
        }
    }
}
