# Design: Same Ten Minutes

## World

A printed transit map on warm paper. The basemap is almost silent; the only strong colour on screen is two inks: deep blue for a person on foot, vermilion for a person in a wheelchair. Barriers are small black marks, like the ticks on a metro diagram. The interface is a single paper card beside the map, set in a typeface designed for low-vision readers.

Light only. (A dark theme would need a second basemap and ink calibration; not finished, so not shipped.)

## Colour roles (tokens in `src/styles.css`)

| Token | Value | Role |
|---|---|---|
| `--paper` | `#F3EEE4` | page and map land |
| `--card` | `#FBF8F2` | the result card |
| `--ink` | `#1B1A17` | primary text, barrier marks |
| `--ink-2` | `#4D483F` | secondary text (8.1:1 on card) |
| `--ink-3` | `#6B6458` | captions, attribution (5.3:1 on card) |
| `--rule` | `#DDD4C4` | hairlines, control borders |
| `--walk` | `#1F4FA3` | walking ink, focus ring, links |
| `--walk-band` | `rgba(31,79,163,.30)` | the walking ink band on the map |
| `--wheel` | `#E4572E` | wheelchair ink on the map |
| `--wheel-text` | `#B23B14` | wheelchair figures as text (5.2:1 on card) |
| `--danger` | `#9E2A12` | error text |

Blue/vermilion stays distinct for protanopia and deuteranopia. Colour is never the only cue: walking ink is a wide translucent band, wheelchair ink is a narrow solid line on top, unverified wheelchair street is dashed, barriers are black glyphs.

## Type

Atkinson Hyperlegible Next (variable, self-hosted). Tabular numerals for every figure.

Scale (px): 12 / 14 / 16 / 20 / 28 / 44 / 72. Body 16/1.5. The gap figure is 72/0.95, weight 700, tracking -0.03em. Labels 12, weight 600, no all-caps eyebrows.

## Space, radius, depth

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64. Card padding 24 (16 on phones). Section gap 24. Control height 40 (44 on touch).
- Radius: 6 controls, 14 card.
- Shadow (card only): `0 1px 2px rgba(27,26,23,.06), 0 12px 32px -12px rgba(27,26,23,.28)`.

## Screens

One screen.

- **Hero:** the map with the two inks.
- **Primary action:** drop the pin (click or tap the map; or type a place and press Enter; or focus the map and press Enter for its centre).
- **Card (desktop: floating left, 400 px; phone: below the map):** place search, time budget (5/10/15), the gap figure and sentence, places reached (health / schools / transit, n of m), data confidence, "Fix first" (top three barriers), legend, sources. Everything after the gap figure is visually quieter.

## Motion

- Ease: `--ease-out: cubic-bezier(.23,1,.32,1)`; UI transitions 160-240 ms on transform and opacity only.
- **Signature: the ink spread.** Every street segment fills at its real computed arrival time, so the animation is the algorithm's output. Ten minutes of travel plays in 2.6 s (ease-out on the clock). Walking ink leads; wheelchair ink follows on the same streets and stops at barriers, each of which pulses once when the ink reaches it. The gap figure counts with the same clock. A new pin interrupts and restarts.
- **Second beat: the flood.** Choosing a fix lifts its barrier mark away (scale 1 to 1.6, fade, 360 ms) and the orange ink runs on from that point at its new arrival times (1.8 s) while the figure counts up.
- Loading: the pin drops (240 ms) and a thin progress line runs along the top of the card; no spinner.
- First load: card sections fade up with a 50 ms stagger.
- `prefers-reduced-motion`: inks and numbers appear in their final state with a 200 ms cross-fade; no pulses, no drop.
