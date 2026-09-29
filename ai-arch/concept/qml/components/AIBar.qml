import QtQuick
import ".."

// Contextual AI layer for app windows: a subtle chip bar with 1-2 AI
// suggestions relevant to the focused app. Cyan only as state markers.
Row {
    id: root
    property var actions: []
    signal action(string label)

    spacing: Theme.spaceSm
    height: Chip.height

    Repeater {
        model: root.actions
        delegate: Chip {
            ai: true
            text: modelData
            onActivated: root.action(text)
        }
    }
}
