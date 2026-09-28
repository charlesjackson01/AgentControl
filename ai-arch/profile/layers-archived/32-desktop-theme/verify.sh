#!/usr/bin/env bash
# Verify 32-desktop-theme — config-level checks (no GUI session required).
# Runs as root inside the VM. Exit 0 = PASS.
set -uo pipefail

fail=0
err() { echo "32-desktop-theme: FAIL — $*" >&2; fail=1; }

DESK_USER=archdev
DESK_HOME=/home/$DESK_USER
WALLPAPER=/usr/share/wallpapers/ai-arch/contents/images/1920x1080.png
WALLPAPER_SHA=12cc0e7a3051febdbb64b78b6fe349e5461034106001774ff9e1bab39e7b37ac

# --- color scheme
[ -f /usr/share/color-schemes/AIArch.colors ] \
  || err "AIArch.colors not installed"
grep -q "^\[General\]" /usr/share/color-schemes/AIArch.colors \
  || err "AIArch.colors missing [General]"
grep -q "ColorScheme=AIArch" /usr/share/color-schemes/AIArch.colors \
  || err "AIArch.colors does not self-identify as AIArch"
# System-wide default: what makes AIArch the live default for the existing
# desk user (whose kdeglobals lacks the key and so falls back to /etc/xdg).
if [ -f /etc/xdg/kdeglobals ]; then
  sys_scheme="$(grep '^ColorScheme=' /etc/xdg/kdeglobals | tail -1 | cut -d= -f2-)"
else
  sys_scheme=""
fi
[ "$sys_scheme" = "AIArch" ] \
  || err "system-wide /etc/xdg ColorScheme is '${sys_scheme:-unset}' (want AIArch)"
# Per-user default for users created after this layer.
user_scheme="$(sudo -u "$DESK_USER" env HOME="$DESK_HOME" XDG_CONFIG_HOME="$DESK_HOME/.config" \
  kreadconfig6 --file kdedefaults/kdeglobals --group General --key ColorScheme 2>/dev/null || true)"
[ "$user_scheme" = "AIArch" ] \
  || err "kdedefaults ColorScheme is '${user_scheme:-unset}' (want AIArch)"

# --- KWin decoration (aurorae QML package)
for f in \
  /usr/share/kwin/decorations/ai-arch/metadata.json \
  /usr/share/kwin/decorations/ai-arch/contents/ui/main.qml \
  /usr/share/kwin/decorations/ai-arch/contents/ui/TitleButton.qml; do
  [ -f "$f" ] || err "decoration file missing: $f"
done
grep -q '"Id": *"ai-arch"' /usr/share/kwin/decorations/ai-arch/metadata.json \
  || err "decoration metadata Id is not ai-arch"
lib="$(sudo -u "$DESK_USER" env HOME="$DESK_HOME" XDG_CONFIG_HOME="$DESK_HOME/.config" \
  kreadconfig6 --file kwinrc --group org.kde.kdecoration2 --key library 2>/dev/null || true)"
theme="$(sudo -u "$DESK_USER" env HOME="$DESK_HOME" XDG_CONFIG_HOME="$DESK_HOME/.config" \
  kreadconfig6 --file kwinrc --group org.kde.kdecoration2 --key theme 2>/dev/null || true)"
[ "$lib" = "org.kde.kwin.aurorae" ] \
  || err "kwinrc decoration library is '${lib:-unset}' (want org.kde.kwin.aurorae)"
[ "$theme" = "ai-arch" ] \
  || err "kwinrc decoration theme is '${theme:-unset}' (want ai-arch)"

# --- wallpaper (pinned asset)
for f in \
  /usr/share/wallpapers/ai-arch/metadata.json \
  "$WALLPAPER" \
  /usr/share/wallpapers/ai-arch/contents/screenshot.png; do
  [ -f "$f" ] || err "wallpaper file missing: $f"
done
actual_sha="$(sha256sum "$WALLPAPER" 2>/dev/null | awk '{print $1}')"
[ "$actual_sha" = "$WALLPAPER_SHA" ] \
  || err "wallpaper sha256 mismatch (got ${actual_sha:-none})"

# Desktop wallpaper points at the pinned asset (fresh build seeds Containments[1]).
# Plasma 6.7 loads the wallpaper plugin's KConfig through a KConfigLoader that
# wraps the plugin keys in a "General" group, so the key must live in
# [Containments][N][Wallpaper][org.kde.image][General]; the Plasma-5-style
# "wallpaperpluginorg.kde.image.Image" key in the containment is ignored.
applet="$DESK_HOME/.config/plasma-org.kde.plasma.desktop-appletsrc"
if [ -f "$applet" ]; then
  grep -q '^\[Containments\]\[[0-9]*\]\[Wallpaper\]\[org\.kde\.image\]\[General\]$' "$applet" \
    || err "appletsrc missing [Containments][N][Wallpaper][org.kde.image][General] section"
  grep -q "Image=file://$WALLPAPER" "$applet" \
    || err "desktop wallpaper Image not set to AI-Arch wallpaper"
else
  err "plasma appletsrc not present (no desktop wallpaper config)"
fi

# --- SDDM login background (ai-arch theme = breeze + AI-Arch theme.conf)
[ -d /usr/share/sddm/themes/ai-arch ] \
  || err "sddm theme ai-arch missing"
[ -f /usr/share/sddm/themes/ai-arch/theme.conf ] \
  || err "sddm theme ai-arch/theme.conf missing"
grep -q "background=$WALLPAPER" /usr/share/sddm/themes/ai-arch/theme.conf 2>/dev/null \
  || err "sddm ai-arch theme background not set to AI-Arch wallpaper"
[ -f /etc/sddm.conf.d/theme.conf ] \
  || err "/etc/sddm.conf.d/theme.conf missing"
grep -q "Current=ai-arch" /etc/sddm.conf.d/theme.conf 2>/dev/null \
  || err "sddm drop-in does not select the ai-arch theme"

[ "$fail" -eq 0 ] \
  && echo "32-desktop-theme: AIArch palette + ai-arch KWin decoration + wallpaper wired" \
  && echo "32-desktop-theme: PASS (visual identity installed)"
