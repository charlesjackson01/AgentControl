pragma Singleton
import QtQuick

// AI-Arch production design tokens (AIArch.Ui).
// Source of truth: profile/layers/32-desktop-theme/assets/color-schemes/AIArch.colors
// (values cross-checked by tests/check_tokens.py; do not edit one side only).
//
// Usage rules:
//  - cyan/violet are STATE colors: focus, interaction, selection, AI
//    activity, status. Never surface fills, never glow.
//  - glass alpha creates depth over the v2-balanced wallpaper without
//    sacrificing readability; borders are 1px hairlines.
//  - motion is 120-180 ms ease-out, OS-like, no ambient animation.
QtObject {
    id: root

    // --- colors -------------------------------------------------------------
    readonly property color bgDeep:        "#0e1114"   // 14,17,20   deepest view
    readonly property color bgWindow:       "#12161b"   // 18,22,27   window base
    readonly property color bgAlt:          "#14181e"   // 20,24,30   alt rows / hover
    readonly property color textPrimary:    "#e8ecf0"   // 232,236,240
    readonly property color textSecondary:  "#8c959f"   // 140,149,159
    readonly property color textDisabled:   "#5a626c"   // concept-derived
    readonly property color accent:         "#40bedc"   // 64,190,220 focus/active/AI
    readonly property color violet:         "#606ebe"   // 96,110,190 secondary accent
    readonly property color ok:             "#3fb950"   // 63,185,80
    readonly property color warn:           "#d29922"   // 210,153,34
    readonly property color err:            "#f85149"   // 248,81,73

    // --- glass surfaces ------------------------------------------------------
    readonly property real surfaceAlpha:     0.84   // window content
    readonly property real raisedAlpha:      0.92   // cards, panes, rows
    readonly property real overlayAlpha:     0.96   // popups, launcher
    readonly property real borderAlpha:      0.10   // hairline (white)
    readonly property real focusBorderAlpha: 0.35   // accent focus border

    function glass(alpha)     { return Qt.rgba(bgWindow.r, bgWindow.g, bgWindow.b, alpha); }
    function hairline()       { return Qt.rgba(1, 1, 1, borderAlpha); }
    function hairlineSoft()   { return Qt.rgba(1, 1, 1, borderAlpha * 0.7); }
    function focusLine()      { return Qt.rgba(accent.r, accent.g, accent.b, focusBorderAlpha); }
    function tint(color, a)   { return Qt.rgba(color.r, color.g, color.b, a); }

    // --- geometry ------------------------------------------------------------
    readonly property int radiusCard:    8
    readonly property int radiusControl: 6
    readonly property int radiusPopup:   12
    readonly property real radiusChip:   999

    readonly property int spaceSm:  4
    readonly property int space:    8
    readonly property int spaceLg:  16
    readonly property int spaceXl:  24
    readonly property int rowHeight: 36

    // --- typography ----------------------------------------------------------
    readonly property string fontSans: "Noto Sans"
    readonly property string fontMono: "Noto Sans Mono"
    readonly property int typeMicro:   11
    readonly property int typeSmall:   12
    readonly property int typeBody:    13
    readonly property int typeSection: 15
    readonly property int typeView:    17
    readonly property int typeDisplay: 20

    // --- motion ---------------------------------------------------------------
    readonly property int animFast: 120
    readonly property int animMed:  180
    readonly property int animSlow: 260

    // --- misc -----------------------------------------------------------------
    readonly property real strokeWidth: 1.5
    readonly property string wallpaperPath:
        "file:///usr/share/wallpapers/ai-arch/contents/images/1920x1080.png"
}
