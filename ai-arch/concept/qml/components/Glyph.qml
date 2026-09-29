import QtQuick
import ".."

// Minimal monochrome line glyphs drawn on a Canvas. One visual language:
// 1.5px strokes, round caps, no fills except small dots. 24x24 design grid,
// scaled to `size`.
Canvas {
    id: root
    property string name: "mark"
    property real size: 20
    property color color: Theme.textSecondary
    property real stroke: Theme.strokeWidth

    width: size
    height: size
    antialiasing: true
    renderStrategy: Canvas.SoftwareRendering

    onNameChanged: requestPaint()
    onColorChanged: requestPaint()
    onStrokeChanged: requestPaint()
    onSizeChanged: requestPaint()

    onPaint: {
        const ctx = getContext("2d")
        ctx.clearRect(0, 0, width, height)
        const s = size / 24.0
        ctx.lineWidth = stroke * s
        ctx.lineCap = "round"
        ctx.lineJoin = "round"
        ctx.strokeStyle = color
        ctx.fillStyle = color

        const line = (x1, y1, x2, y2) => {
            ctx.beginPath(); ctx.moveTo(x1 * s, y1 * s); ctx.lineTo(x2 * s, y2 * s); ctx.stroke();
        };
        const arc = (cx, cy, r, a0, a1) => {
            ctx.beginPath(); ctx.arc(cx * s, cy * s, r * s, a0, a1); ctx.stroke();
        };
        const dot = (cx, cy, r) => {
            ctx.beginPath(); ctx.arc(cx * s, cy * s, r * s, 0, 2 * Math.PI); ctx.fill();
        };

        switch (name) {
        case "mark": // AI command mark: concentric arcs + center dot
            arc(12, 12, 9.5, -Math.PI * 0.85, Math.PI * -0.15);
            arc(12, 12, 6, -Math.PI * 0.85, Math.PI * 0.15);
            dot(12, 12, 1.8);
            break;
        case "folder":
            ctx.beginPath();
            ctx.moveTo(3, 7); ctx.lineTo(9, 7); ctx.lineTo(11, 9.5); ctx.lineTo(21, 9.5);
            ctx.lineTo(21, 18); ctx.lineTo(3, 18); ctx.closePath(); ctx.stroke();
            break;
        case "file":
            line(6, 3, 14, 3); line(14, 3, 18, 7); line(18, 7, 18, 21);
            line(18, 21, 6, 21); line(6, 21, 6, 3); line(14, 3, 14, 7); line(14, 7, 18, 7);
            break;
        case "doc":
            line(6, 3, 14, 3); line(14, 3, 18, 7); line(18, 7, 18, 21);
            line(18, 21, 6, 21); line(6, 21, 6, 3); line(14, 3, 14, 7); line(14, 7, 18, 7);
            line(9, 11, 15, 11); line(9, 14.5, 15, 14.5); line(9, 18, 12.5, 18);
            break;
        case "search":
            arc(10, 10, 6.5, 0, 2 * Math.PI); line(15, 15, 20, 20);
            break;
        case "close":
            line(6, 6, 18, 18); line(18, 6, 6, 18);
            break;
        case "min":
            line(5, 12, 19, 12);
            break;
        case "max":
            ctx.strokeRect(6 * s, 6 * s, 12 * s, 12 * s);
            break;
        case "restore":
            ctx.strokeRect(8 * s, 3 * s, 13 * s, 13 * s);
            ctx.strokeRect(3 * s, 8 * s, 13 * s, 13 * s);
            break;
        case "wifi":
            arc(12, 18.5, 2, 0, 2 * Math.PI);
            arc(12, 18.5, 6, -Math.PI * 0.75, -Math.PI * 0.25);
            arc(12, 18.5, 10, -Math.PI * 0.75, -Math.PI * 0.25);
            break;
        case "bluetooth":
            line(8, 7, 16, 15); line(16, 9, 8, 17); line(12, 3, 12, 21); line(12, 3, 16, 7); line(12, 21, 16, 17);
            break;
        case "volume":
            line(4, 10, 8, 10); line(8, 10, 12, 6); line(12, 6, 12, 18); line(12, 18, 8, 14); line(8, 14, 4, 14);
            arc(12, 12, 6, -Math.PI * 0.4, Math.PI * 0.4);
            break;
        case "display":
            ctx.strokeRect(3 * s, 5 * s, 18 * s, 12 * s);
            line(9, 20, 15, 20); line(12, 17, 12, 20);
            break;
        case "power":
            arc(12, 13, 8, -Math.PI * 0.7, Math.PI * 0.7); line(12, 3, 12, 12);
            break;
        case "bell":
            ctx.beginPath();
            ctx.moveTo(5, 18); ctx.lineTo(19, 18); ctx.lineTo(17, 15);
            ctx.lineTo(17, 10); ctx.arc(12, 10, 5, 0, Math.PI, true);
            ctx.lineTo(7, 15); ctx.closePath(); ctx.stroke();
            arc(12, 20, 2, 0, Math.PI);
            break;
        case "plus":
            line(12, 5, 12, 19); line(5, 12, 19, 12);
            break;
        case "check":
            line(5, 13, 10, 18); line(10, 18, 19, 7);
            break;
        case "warn":
            line(12, 4, 21, 20); line(21, 20, 3, 20); line(3, 20, 12, 4); line(12, 10, 12, 15); dot(12, 18, 0.9);
            break;
        case "chat":
            ctx.beginPath();
            ctx.moveTo(4, 5); ctx.lineTo(20, 5); ctx.lineTo(20, 16); ctx.lineTo(10, 16);
            ctx.lineTo(6, 20); ctx.lineTo(6, 16); ctx.lineTo(4, 16); ctx.closePath(); ctx.stroke();
            break;
        case "cpu":
            ctx.strokeRect(7 * s, 7 * s, 10 * s, 10 * s);
            for (let i = 9; i <= 15; i += 3) { line(i, 3, i, 7); line(i, 17, i, 21); line(3, i, 7, i); line(17, i, 21, i); }
            break;
        case "layers":
            ctx.beginPath();
            ctx.moveTo(12, 3); ctx.lineTo(21, 8); ctx.lineTo(12, 13); ctx.lineTo(3, 8); ctx.closePath(); ctx.stroke();
            line(3, 12.5, 12, 17.5); line(21, 12.5, 12, 17.5);
            line(3, 16.5, 12, 21.5); line(21, 16.5, 12, 21.5);
            break;
        case "flow":
            dot(5, 6, 2); dot(19, 6, 2); dot(12, 18, 2);
            line(7, 6, 17, 6); line(5, 8, 12, 16); line(19, 8, 12, 16);
            break;
        case "agent":
            arc(12, 8, 4, 0, 2 * Math.PI);
            arc(12, 20, 8, Math.PI * 1.15, Math.PI * 1.85);
            dot(6, 4, 1.2); dot(18, 4, 1.2);
            break;
        case "gauge":
            arc(12, 13, 8.5, Math.PI * 1.1, Math.PI * 1.9);
            line(12, 13, 16.5, 8.5); dot(12, 13, 1.6);
            break;
        case "wrench":
            arc(9, 9, 5.5, -Math.PI * 0.45, Math.PI * 0.95);
            line(12.5, 12.5, 20, 20);
            break;
        case "home":
            line(4, 11, 12, 4); line(12, 4, 20, 11); line(6, 10, 6, 20); line(6, 20, 18, 20);
            line(18, 10, 18, 20); line(10, 20, 10, 14); line(10, 14, 14, 14); line(14, 14, 14, 20);
            break;
        case "grid":
            ctx.strokeRect(4 * s, 4 * s, 7 * s, 7 * s); ctx.strokeRect(13 * s, 4 * s, 7 * s, 7 * s);
            ctx.strokeRect(4 * s, 13 * s, 7 * s, 7 * s); ctx.strokeRect(13 * s, 13 * s, 7 * s, 7 * s);
            break;
        case "terminal":
            ctx.strokeRect(3 * s, 5 * s, 18 * s, 14 * s);
            line(6, 10, 9, 12.5); line(9, 12.5, 6, 15); line(11, 15, 15, 15);
            break;
        case "globe":
            arc(12, 12, 8.5, 0, 2 * Math.PI);
            ctx.beginPath(); ctx.ellipse(12 * s, 12 * s, 4 * s, 8.5 * s, 0, 0, 2 * Math.PI); ctx.stroke();
            line(3.5, 12, 20.5, 12);
            break;
        case "gear":
            arc(12, 12, 4, 0, 2 * Math.PI);
            arc(12, 12, 8.5, 0, 2 * Math.PI);
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
                const c = Math.cos(a), si = Math.sin(a);
                line(12 + c * 8.5, 12 + si * 8.5, 12 + c * 10.5, 12 + si * 10.5);
            }
            break;
        case "music":
            line(9, 18, 9, 6); line(9, 6, 18, 4.5); line(18, 4.5, 18, 16);
            arc(6.5, 18, 2.5, 0, 2 * Math.PI); arc(15.5, 16, 2.5, 0, 2 * Math.PI);
            break;
        case "play":
            ctx.beginPath(); ctx.moveTo(7, 5); ctx.lineTo(19, 12); ctx.lineTo(7, 19); ctx.closePath(); ctx.stroke();
            break;
        case "image":
            ctx.strokeRect(3 * s, 5 * s, 18 * s, 14 * s);
            arc(8.5, 10, 1.8, 0, 2 * Math.PI);
            line(3, 17, 10, 12); line(10, 12, 15, 15.5); line(15, 15.5, 21, 10.5);
            break;
        case "camera":
            ctx.strokeRect(3 * s, 7 * s, 18 * s, 12 * s);
            arc(12, 13, 3.8, 0, 2 * Math.PI);
            line(8, 7, 10, 4.5); line(14, 7, 12, 4.5); line(10, 4.5, 14, 4.5);
            break;
        case "calc":
            ctx.strokeRect(5 * s, 3 * s, 14 * s, 18 * s);
            line(8, 7, 16, 7);
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) dot(8 + c * 4, 11 + r * 3.2, 0.9);
            break;
        default:
            dot(12, 12, 1.6);
        }
    }
}
