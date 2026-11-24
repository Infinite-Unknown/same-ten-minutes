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
| `--ink-2` | `#4D483F` | secondary text (8.6:1 on card) |
| `--ink-3` | `#6B6458` | captions, attribution (5.5:1 on card) |
| `--rule` | `#DDD4C4` | hairlines, control borders |
| `--walk` | `#1F4FA3` | walking ink, focus ring, links |
| `--walk-band` | `rgba(31,79,163,.30)` | the walking ink band on the map |
| `--wheel` | `#E4572E` | wheelchair ink on the map (graphics only: 3.5:1, never small text) |
| `--wheel-text` | `#B23B14` | wheelchair figures as text (5.6:1 on card) |
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
- **Card (desktop: floating left, 400 px; phone: a sheet under a fixed map that takes the top half of the screen and scrolls on its own):** place search, time budget (5/10/15), the gap figure and sentence, places reached (health / schools / transit, n of m), data confidence, "Fix first" (top three barriers), legend, sources. Everything after the gap figure is visually quieter.
- **Pinned readout:** when the gap figure scrolls out of the card (or, on a phone, before it is scrolled to), a strip at the top edge of the card shows the same figure at 44 px with a one-line caption. It counts with the same clock, so the figure is always on screen beside the map, above all during the flood.
- **Fix cards:** rank, barrier name, the change and what it gives back; the reach after the fix sits right-aligned at 28 px in wheelchair text colour, with the starting figure small above it.
- **Barrier marks:** the three ranked fixes are drawn heavier and in full ink, with a numbered badge on a short leader, placed on the side away from the pin and pushed clear of it; the other barriers recede to `--ink-2`.

## Motion

- Ease: `--ease-out: cubic-bezier(.23,1,.32,1)`; UI transitions 160-240 ms on transform and opacity only.
- **Signature: the ink spread.** Every street segment fills at its real computed arrival time, so the animation is the algorithm's output. Ten minutes of travel plays in 2.6 s (ease-out on the clock). Walking ink leads; wheelchair ink follows on the same streets and stops at barriers, each of which pulses once when the ink reaches it. The gap figure counts with the same clock. A new pin interrupts and restarts.
- **Second beat: the flood.** Choosing a fix lifts its barrier mark away (scale 1 to 1.6, fade, 360 ms), one vermilion ring runs out from where it stood (900 ms), and the orange ink runs on from that point at its new arrival times (1.8 s) while the figure counts up in the pinned readout. Each place the fix brings within reach is stamped in as the ink arrives (lands at 1.6x and settles, 420 ms).
- Loading: the progress line runs along the top of the card from the first paint and the card says "Loading the map…"; the chip row keeps its height while the sample list loads. The pin drops (240 ms); no spinner.
- Map hint: appears once the first spread settles ("Click / Tap any street to move the pin"), leaves on the first drag, the next pin or after 6 s.
- Readout: 200 ms fade and 6 px rise in, same out. Fix cards rise in with a 50 ms stagger on each new result.
- First load: card sections fade up with a 50 ms stagger.
- `prefers-reduced-motion`: inks and numbers appear in their final state with a 200 ms cross-fade; no pulses, rings, stamps or drop.
