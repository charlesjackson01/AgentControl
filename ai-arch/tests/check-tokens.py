#!/usr/bin/env python3
"""check-tokens.py — assert AIArch.Ui/Theme.qml matches AIArch.colors.

Source of truth: profile/layers/32-desktop-theme/assets/color-schemes/AIArch.colors
(docs/AI-ARCHITECTURE.md / TESTING.md T2). Exit 0 = in sync.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COLORS = ROOT / "profile/layers/32-desktop-theme/assets/color-schemes/AIArch.colors"
THEME = ROOT / "src/ui/Theme.qml"

# theme token -> (section, key) in AIArch.colors
MAPPING = {
    "bgDeep": ("ColorEffects:Disabled", "Color"),
    "bgWindow": ("Colors:Complementary", "BackgroundNormal"),
    "textPrimary": ("Colors:Button", "ForegroundNormal"),
    "textSecondary": ("Colors:Button", "ForegroundInactive"),
    "accent": ("Colors:Button", "DecorationFocus"),
    "violet": ("Colors:Button", "ForegroundVisited"),
    "ok": ("Colors:Button", "ForegroundPositive"),
    "warn": ("Colors:Button", "ForegroundNeutral"),
    "err": ("Colors:Button", "ForegroundNegative"),
}


def parse_colors(path):
    sections = {}
    section = None
    for line in path.read_text().splitlines():
        line = line.strip()
        m = re.match(r"^\[(.+)\]$", line)
        if m:
            section = m.group(1)
            sections.setdefault(section, {})
            continue
        if section and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            sections[section][k.strip()] = v.strip()
    return sections


def parse_theme(path):
    tokens = {}
    for line in path.read_text().splitlines():
        m = re.search(
            r'readonly property color (\w+):\s+"#([0-9a-fA-F]{6})"(?:\s+//\s+(\d+),\s*(\d+),\s*(\d+))?',
            line,
        )
        if m:
            tokens[m.group(1)] = {
                "hex": m.group(2).lower(),
                "rgb": tuple(int(m.group(i)) for i in (3, 4, 5)) if m.group(3) else None,
            }
    return tokens


def rgb_to_hex(rgb):
    return "%02x%02x%02x" % rgb


def main():
    if not COLORS.exists() or not THEME.exists():
        print("check-tokens: missing input files", file=sys.stderr)
        return 2

    colors = parse_colors(COLORS)
    theme = parse_theme(THEME)
    failures = []

    for token, (section, key) in MAPPING.items():
        expected = colors.get(section, {}).get(key)
        t = theme.get(token)
        if expected is None:
            failures.append("%s: %s.%s missing in AIArch.colors" % (token, section, key))
            continue
        if t is None:
            failures.append("%s: token missing in Theme.qml" % token)
            continue
        expected_rgb = tuple(int(x) for x in expected.split(","))
        if t["hex"] != rgb_to_hex(expected_rgb):
            failures.append(
                "%s: Theme.qml #%s != AIArch.colors %s" % (token, t["hex"], expected)
            )
        if t["rgb"] and t["rgb"] != expected_rgb:
            failures.append(
                "%s: Theme.qml comment rgb %s != AIArch.colors %s"
                % (token, t["rgb"], expected)
            )

    # every token with an RGB comment must agree with its own hex
    for token, t in theme.items():
        if t["rgb"] and t["hex"] != rgb_to_hex(t["rgb"]):
            failures.append("%s: hex #%s disagrees with comment rgb %s" % (token, t["hex"], t["rgb"]))

    if failures:
        for f in failures:
            print("MISMATCH:", f, file=sys.stderr)
        return 1
    print("check-tokens: %d tokens verified against AIArch.colors" % len(MAPPING))
    return 0


if __name__ == "__main__":
    sys.exit(main())
