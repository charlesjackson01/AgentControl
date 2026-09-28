# AI-Arch Desktop Experience Concept

Prototype workspace for the approved concept phase (spec: `docs/AI-ARCH-CONCEPT.md`,
2026-08-27). Everything under this directory is **concept material, not
production**: QML prototypes, wallpaper candidates, and composition
screenshots that demonstrate the desktop. Nothing here is wired into the
`profile/layers/` build path; if the concept is approved, production
implementation starts separately (future `40-ai-apps` layer etc.).

## Contents

| Path | What |
|------|------|
| `wallpaper/gen-wallpaper.py` | Parameterized procedural wallpaper generator (ported from the 2a3 generator; verified bit-for-bit reproduction of the 2a3 asset with original params) |
| `wallpaper/variants/ai-arch-wallpaper-v1-subtle.png` | Candidate: slight contrast lift |
| `wallpaper/variants/ai-arch-wallpaper-v2-balanced.png` | Candidate (installed on VM): balanced contrast |
| `wallpaper/variants/ai-arch-wallpaper-v3-expressive.png` | Candidate: strongest texture |
| `qml/` | (Stage C) QML concept prototypes for the 4 rendered AI apps |
| `kwin-place.js` | (Stage C/D) window placement script |
| `screenshots/` | (Stage D) the 5 approved composition shots |

## Wallpaper: run

```
cd concept/wallpaper
python3 gen-wallpaper.py all           # regenerate all variants
python3 gen-wallpaper.py stats <png>   # pixel stats (mean/max/p99/area>80)
```

Variant stats (1920x1080, luminance; original 2a3 asset in parentheses):

| Variant | lum mean | lum max | p99 | area > 80 |
|---------|----------|---------|-----|-----------|
| original (2a3) | 24.0 | 47 | 45 | 0.00% |
| v1-subtle | 27.4 | 55 | 50 | 0.00% |
| v2-balanced | 32.0 | 64 | 58 | 0.00% |
| v3-expressive | 38.1 | 70 | 64 | 0.00% |

All stay very dark (spec §13 targets: brightest zone ≤ ~90/255, small area,
no hotspots).

## Wallpaper: VM install/revert (temporary, concept only)

Installed on the lab VM at `/usr/share/wallpapers/ai-arch/contents/images/1920x1080.png`
(the Plasma desktop wallpaper path; the live session reloads it on file
change — no restart needed).

```
# install a candidate (from host)
scp -q concept/wallpaper/variants/ai-arch-wallpaper-v2-balanced.png \
  archdev@192.168.122.50:/tmp/wp.png
ssh archdev@192.168.122.50 'sudo install -m 644 /tmp/wp.png \
  /usr/share/wallpapers/ai-arch/contents/images/1920x1080.png'

# revert to the committed 2a3 wallpaper (authoritative copy is in the repo)
ssh archdev@192.168.122.50 'sudo install -m 644 \
  /home/charlesjackson/ai-arch/profile/layers/32-desktop-theme/assets/wallpaper/ai-arch-wallpaper-1920x1080.png \
  /usr/share/wallpapers/ai-arch/contents/images/1920x1080.png'
# (a backup of the pre-concept file also exists on the VM at
#  /tmp/ai-arch-wallpaper-orig-1920x1080.png, sha 12cc0e7a…)
```

Pinning a final wallpaper into layer `32-desktop-theme` (asset replacement +
SHA256 + verify.sh) is an **implementation-phase** action after concept
approval — deliberately not done here. The baseline qcow2
(`vms/ai-arch-baseline-with-theme.qcow2`, sha 66d0efd2…) is untouched.

## Guardrails honored

- No production code, no `profile/` layer changes, no package installs.
- No core Plasma behavior changes; the only VM change is the wallpaper image
  file (reversible per above).
- Keepalive unit `aiarch-keepalive` stays active during all captures.
