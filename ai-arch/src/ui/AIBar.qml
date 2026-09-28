import QtQuick
import org.freedesktop.DBus

// In-window AI status chip for AI apps (AIArch.Ui.AIBar).
// Reads org.aiarch.Config + org.aiarch.AI over the session bus; degrades to a
// static "AI unavailable" chip when the services are absent. Extra action
// chips can be added as default content (Chip { ai: true; text: ... }).
Item {
    id: root
    default property alias actions: actionsRow.data

    // offline | connected | degraded | working | unavailable
    property string state: "unavailable"
    property string model: ""
    property string label: "AI unavailable"

    width: statusChip.width + (actionsRow.children.length ? Theme.spaceSm + actionsRow.width : 0)
    height: 28

    function _getAll(service, path, iface, cb) {
        const c = Qt.createQmlObject('DBus { }', root)
        c.call(service, path, "org.freedesktop.DBus.Properties", "GetAll", [iface],
               (r) => cb(r), () => cb(null))
    }

    function refresh() {
        let pending = 2
        let cfg = null, ai = null
        const done = () => {
            if (pending > 0) { pending--; if (pending === 0) apply(cfg, ai) }
        }
        _getAll("org.aiarch.Config", "/org/aiarch/Config", "org.aiarch.Config",
                (r) => { cfg = r; done() })
        _getAll("org.aiarch.AI", "/org/aiarch/AI", "org.aiarch.AI",
                (r) => { ai = r; done() })
    }

    function apply(cfg, ai) {
        if (!cfg) {
            root.state = "unavailable"; root.label = "AI unavailable"; return
        }
        if (cfg["AiEnabled"] === false) {
            root.state = "offline"; root.label = "AI off"; return
        }
        if (!ai) {
            root.state = "offline"; root.label = "starting…"; return
        }
        root.model = ai["Model"] || ""
        const st = ai["State"]
        const active = ai["ActiveRequests"] || 0
        if (st === "connected") {
            root.state = active > 0 ? "working" : "connected"
            root.label = active > 0 ? "working…" : (root.model ? root.model : "AI ready")
        } else if (st === "degraded") {
            root.state = "degraded"; root.label = "degraded"
        } else {
            root.state = "offline"; root.label = "no endpoint"
        }
    }

    Timer { interval: 5000; repeat: true; running: true; onTriggered: root.refresh() }
    Component.onCompleted: refresh()

    Row {
        spacing: Theme.spaceSm

        Rectangle {
            id: statusChip
            height: 28
            width: dot.width + Theme.spaceSm + labelText.width + Theme.spaceLg
            radius: Theme.radiusChip
            color: Theme.glass(0.88)
            border.color: Theme.hairlineSoft()
            border.width: 1

            Row {
                anchors.centerIn: parent
                spacing: Theme.spaceSm
                StatusDot { id: dot; anchors.verticalCenter: parent.verticalCenter; state: root.state }
                Text {
                    id: labelText
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.label
                    font.family: Theme.fontSans
                    font.pixelSize: Theme.typeSmall
                    color: root.state === "unavailable" ? Theme.textDisabled : Theme.textPrimary
                }
            }
        }

        Row {
            id: actionsRow
            spacing: Theme.spaceSm
        }
    }
}
