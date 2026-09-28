#!/usr/bin/env bash
# 32-desktop-theme — AI-Arch visual identity (docs/AI-ARCH-DESIGN.md).
#
# Installs the AIArch color scheme (dark default), the ai-arch KWin window
# decoration (aurorae QML package), and the pinned abstract wallpaper;
# wires them into Plasma (desktop wallpaper, color scheme, KWin) and SDDM
# (login background). Idempotent. Runs as root.
#
# Note: Plasma 6 stores the desktop wallpaper in per-user KConfig nested
# groups ([Containments][N]); the kwriteconfig6 CLI cannot address those
# (it writes literal group names), so the appletsrc is edited directly.
set -euo pipefail

LAYER_DIR="$(cd "$(dirname "$0")" && pwd)"
DESK_USER=archdev
DESK_HOME=/home/$DESK_USER
WALLPAPER_SRC="$LAYER_DIR/assets/wallpaper/ai-arch-wallpaper-1920x1080.png"
WALLPAPER=/usr/share/wallpapers/ai-arch/contents/images/1920x1080.png

run_user() {
  sudo -u "$DESK_USER" env HOME="$DESK_HOME" XDG_CONFIG_HOME="$DESK_HOME/.config" "$@"
}

# --- color scheme: AIArch (dark, charcoal + muted cyan) ---------------------
install -m 644 "$LAYER_DIR/assets/color-schemes/AIArch.colors" \
  /usr/share/color-schemes/AIArch.colors
# System-wide default in /etc/xdg/kdeglobals: an existing user's session only
# falls back to /etc/xdg when the user's own kdeglobals lacks the key, so this
# is what makes AIArch the live default (archdev's kdeglobals has none).
# kdedefaults below additionally covers users created after this layer.
ETC_KDEGLOBALS=/etc/xdg/kdeglobals
if [ -f "$ETC_KDEGLOBALS" ] && grep -q '^ColorScheme=' "$ETC_KDEGLOBALS"; then
  sed -i 's/^ColorScheme=.*/ColorScheme=AIArch/' "$ETC_KDEGLOBALS"
else
  tmp="$(mktemp)"
  if [ -f "$ETC_KDEGLOBALS" ]; then
    awk '
      !done && /^\[General\]/ { print; print "ColorScheme=AIArch"; done = 1; next }
      { print }
      END { if (!done) { print "[General]"; print "ColorScheme=AIArch" } }
    ' "$ETC_KDEGLOBALS" > "$tmp"
  else
    printf '[General]\nColorScheme=AIArch\n' > "$tmp"
  fi
  chmod 644 "$tmp"
  mv "$tmp" "$ETC_KDEGLOBALS"
fi
run_user kwriteconfig6 --file kdedefaults/kdeglobals --group General \
  --key ColorScheme AIArch

# --- KWin decoration: ai-arch (aurorae QML package) --------------------------
install -d /usr/share/kwin/decorations/ai-arch/contents/ui
install -m 644 "$LAYER_DIR/assets/decoration/metadata.json" \
  /usr/share/kwin/decorations/ai-arch/metadata.json
install -m 644 "$LAYER_DIR/assets/decoration/contents/ui/"*.qml \
  /usr/share/kwin/decorations/ai-arch/contents/ui/
run_user kwriteconfig6 --file kwinrc --group org.kde.kdecoration2 \
  --key library org.kde.kwin.aurorae
run_user kwriteconfig6 --file kwinrc --group org.kde.kdecoration2 \
  --key theme ai-arch

# --- wallpaper (pinned asset; Plasma 6 wallpaper layout) ---------------------
install -d /usr/share/wallpapers/ai-arch/contents/images
install -m 644 "$LAYER_DIR/assets/wallpaper/metadata.json" \
  /usr/share/wallpapers/ai-arch/metadata.json
install -m 644 "$WALLPAPER_SRC" "$WALLPAPER"
install -m 644 "$LAYER_DIR/assets/wallpaper/screenshot.png" \
  /usr/share/wallpapers/ai-arch/contents/screenshot.png

# --- Plasma desktop wallpaper ------------------------------------------------
# Plasma 6.7's image wallpaper plugin loads its config through a KConfigLoader
# that wraps the plugin keys in a "General" group, so the key must live in
# [Containments][N][Wallpaper][org.kde.image][General]; the Plasma-5-style
# "wallpaperpluginorg.kde.image.Image" key in the containment is silently
# ignored (desktop falls back to the default wallpaper). kwriteconfig6 cannot
# address nested KConfig groups, so the appletsrc is edited directly.
APPLET_SRC="$DESK_HOME/.config/plasma-org.kde.plasma.desktop-appletsrc"
if [ -f "$APPLET_SRC" ]; then
  desk_group="$(awk '
    /^\[Containments\]\[[0-9]+\][[:space:]]*$/ { g = $0 }
    /^plugin=org\.kde\.plasma\.folder[[:space:]]*$/ { if (g != "") { print g; exit } }
  ' "$APPLET_SRC")"
  if [ -n "$desk_group" ]; then
    tmp="$(mktemp)"
    awk -v grp="$desk_group" -v wp="$WALLPAPER" '
      function esc(s) { gsub(/\[/, "\\[", s); gsub(/\]/, "\\]", s); return s }
      $0 ~ ("^" esc(grp) "\\[Wallpaper\\]\\[org\\.kde\\.image\\]") { skip = 1; next }
      skip { if ($0 ~ /^\[/) skip = 0; else next }
      in_group && $0 ~ /^wallpaperplugin(=|org\.kde\.image\..*=)/ { next }
      {
        out[++n] = $0
        if ($0 == grp && !done) {
          out[++n] = "wallpaperplugin=org.kde.image"
          in_group = 1
          done = 1
        }
        if ($0 ~ /^\[/ && $0 != grp) in_group = 0
      }
      END {
        while (n > 0 && out[n] == "") n--
        for (i = 1; i <= n; i++) print out[i]
        print ""
        print grp "[Wallpaper][org.kde.image][General]"
        print "Image=file://" wp
        print "PreviewImage=null"
      }
    ' "$APPLET_SRC" > "$tmp"
    chmod a+r "$tmp"
    sudo -u "$DESK_USER" cp "$tmp" "$APPLET_SRC"
    rm -f "$tmp"
  else
    echo "32-desktop-theme: WARNING: no folder containment in appletsrc; wallpaper key not set" >&2
  fi
else
  # Fresh build: pre-seed the first-login desktop containment (observed
  # layout on first session: Containments[1]=desktop folder,
  # Containments[2]=panel) so plasmashell adopts the AI-Arch wallpaper.
  cat > "$APPLET_SRC" <<EOF
[Containments][1]
formfactor=0
immutability=1
lastScreen=0
location=0
plugin=org.kde.plasma.folder
wallpaperplugin=org.kde.image

[Containments][1][Wallpaper][org.kde.image][General]
Image=file://$WALLPAPER
PreviewImage=null
EOF
  chown "$DESK_USER:$DESK_USER" "$APPLET_SRC"
fi

# --- SDDM login background ----------------------------------------------------
# SDDM themes read their background from the theme's own theme.conf
# ([General] type/background); a [Theme] Image= drop-in does not override
# it. So ship an "ai-arch" theme: a copy of breeze with our theme.conf.
SDDM_THEME=/usr/share/sddm/themes/ai-arch
rm -rf "$SDDM_THEME"
cp -a /usr/share/sddm/themes/breeze "$SDDM_THEME"
sed -i \
  -e '2s/^Name=.*/Name=AI-Arch/' \
  -e 's/^Description=.*$/Description=AI-Arch/' \
  -e 's/^Theme-Id=.*/Theme-Id=ai-arch/' \
  "$SDDM_THEME/metadata.desktop"
cat > "$SDDM_THEME/theme.conf" <<EOF
[General]
showlogo=hidden
showClock=true
logo=$SDDM_THEME/default-logo.svg
type=image
color=#40bedc
fontSize=10
background=$WALLPAPER
needsFullUserModel=false
EOF
cat > /etc/sddm.conf.d/theme.conf <<EOF
[Theme]
Current=ai-arch
EOF

# --- live session (lab VM only): apply decoration without a restart ----------
desk_uid="$(id -u "$DESK_USER")"
if run_user pgrep -x plasmashell >/dev/null 2>&1; then
  run_user env DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$desk_uid/bus" \
    /usr/lib/kwin-applywindowdecoration ai-arch || true
fi

echo "32-desktop-theme: AIArch color scheme + ai-arch KWin decoration + wallpaper installed"
