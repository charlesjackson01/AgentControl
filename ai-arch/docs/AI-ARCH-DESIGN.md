# AI-Arch visual design brief

Owner design brief, 2026-08-27. Authoritative visual direction for the
AI-Arch Desktop chrome and the AI Control Center. This document is the
spec the implementation is built against — if an implementation choice
conflicts with this brief, the brief wins.

## Design principle

> "Tony Stark's workstation if he designed a modern Linux desktop —
> intelligent, elegant, technical, and understated."

The most important part: the futuristic aesthetic comes from the
**materials, typography, transparency, spacing, motion, and information
design** — not from covering the screen in holographic graphics.

## 1. Overall feel

Dark, minimalist, futuristic, technical — inspired by Tony Stark/JARVIS
and modern sci-fi interfaces, but **restrained**.

- High-end AI workstation, not a flashy spaceship HUD
- Lots of negative space
- Subtle glass/transparency
- Thin borders, soft lighting
- Clean typography
- **Dark mode is the primary/default experience**

## 2. Palette

Cool cyan/blue primary accent, very subtle secondary violet/blue tones.

| Role | Value |
|------|-------|
| Background | near-black / charcoal |
| Surfaces | dark translucent glass |
| Primary accent | muted electric cyan |
| Secondary accent | subtle blue/violet |
| Text | white / light gray |
| Status colors | conventional green / yellow / red |

Accents are **restrained** — not everything glows.

## 3. AI Control Center character

Distinctly an AI product, but still clearly part of the desktop. It has
its own refined AI-Arch styling rather than looking like a stock Plasma
application:

- Custom subtle window decorations
- Transparent/glass surfaces
- Minimal borders
- Contextual panels
- Clean data visualization
- Smooth, restrained animations
- AI-specific visual language

However it must **behave like a normal desktop application**: movable,
resizable, minimize/maximize, multiple instances/windows where
appropriate.

The Control Center is the **command center of the OS, not the OS
itself.**

## 4. Wallpaper / branding

- Minimal abstract futuristic wallpaper matching the palette
- No giant robots, spaceships, glowing cityscapes, or overly literal
  sci-fi imagery
- Target: dark abstract technological environment, subtle cyan
  illumination, geometric/architectural forms, depth, a sense of advanced
  computing infrastructure
- Branding subtle: AI-Arch should feel like a **professional operating
  system**, not a gaming theme

## 5. Implementation mapping

How the brief becomes reproducible components (rules unchanged: official
repos only, assets pinned by SHA256 in layers, no AUR):

| Brief element | Component | Layer |
|---------------|-----------|-------|
| Dark default + palette | Plasma color scheme + custom Plasma 6 (QML) theme | `32-desktop-theme` |
| Thin borders / glass titlebars | Custom KWin decorations package (QML, `/usr/share/kwin/decorations/`) | `32-desktop-theme` |
| Wallpaper (Plasma + SDDM) | Generated PNG asset, SHA256-pinned | `32-desktop-theme` |
| AI Control Center | Standalone Qt/QML app with its own styling; normal window behaviors | `40-ai-apps` (2b) |

Phased, risk-ordered:

1. **Chrome first** (high impact, low risk): palette/color scheme +
   custom KWin decorations + wallpaper, applied system-wide (Plasma +
   SDDM login).
2. **SDDM theming** so the login matches the session.
3. **Full Plasma component restyle** (panels, applets, KCMs) — the larger
   QML effort; only after 1+2 are proven on the build path.

## 6. Status

- Brief approved by owner: 2026-08-27.
- Implementation phase: **2a3 — visual identity** (before 2b), see
  `ROADMAP.md`.
