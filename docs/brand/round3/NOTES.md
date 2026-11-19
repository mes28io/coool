# coool brand — round 3

A clean start, driven by the reference gallery. Nothing here is built from the earlier rounds' files. That rules out rows of circles, nested rings, pills with holes, dots leaving a c and striped fills.

## What the gallery taught (inspora.design/logos, studied in headless Chrome)

I went through the full Logos feed, the Industry (AI / SaaS / Tech), Style (Playful / Rounded / Geometric) and Shape filters, the Icons tab and about 20 detail pages. I copied no assets. My study screenshots stayed in scratch.

- **One idea per mark.** Every strong entry makes one move and stops there: a cut, a face, a gesture or a pixel grid. Anything that needed explaining read as a diagram.
- **Character beats geometry.** The marks you remember have a bit of life in them: the faces in *Living Things*, the soft one-piece *Blueberry* symbol, Mailchimp's wink, the *OpenClaw* pixel critter. Plain geometric arrangements of circles look generic next to them. *Cosmos* (a ring of six dots) and *Tripadvisor* (two ringed eyes) show how crowded that space already is.
- **Bold, simple colour.** One flat glyph colour on one confident ground (lime, olive, orange, blue, near-white). Rainbow appears only as a small accent, if at all.
- **App icons:** the glyph fills about 55–70% of the tile, is centred and weighty, and its outline is the identity. It still works at 32 px because the silhouette carries it.
- **Repeated letters:** the good wordmarks give repeated letters one shared treatment (all counters become eyes; one stroke runs through every letter) rather than decorating just one of them.

## References → moves → directions

| Reference (gallery) | The move | Used in |
|---|---|---|
| Blueberry Symbol (Studio Nari) | one letter becomes a soft one-piece symbol with a small cut-in detail | **1 Peek** |
| Granola (logo + icon) | a single letter-gesture alone on one bold ground | **1 Peek** |
| Living Things (Studio Nari) | faces hidden in the counters of a heavy wordmark | **2 Lids** |
| Mailchimp | a mascot defined by one expression (the wink) | **2 Lids** |
| Citoos | one cut that turns a letter into a symbol | **3 Night Shift** |
| Claude / Granola app icons | one quiet glyph on a flat ground | **3 Night Shift** |
| OpenClaw | a pixel mascot as the whole identity | **4 Sprite** |
| Lore | pixel lettering | **4 Sprite** |

## The directions

1. **Peek.** The lowercase c is a hood with a calm little agent inside, looking out through the opening. The c is drawn as a weighted bowl with a wedge-cut aperture (the lower jaw reaches further than the upper terminal) and two tall eyes. It is one colour: blue on white, or white on blue.
2. **Lids.** The o's are heavy-lidded eyes glancing sideways: relaxed, but keeping an eye on things. In the wordmark every o gets the same lid and pupil, so the word itself carries the attitude. The icon is just the glance. Ink on yellow.
3. **Night Shift.** The c is cut into a crescent moon that holds a text cursor: your agents keep coding while you sleep. This is the calm side of "cool". Paper on navy, with a yellow cursor.
4. **Sprite.** Each agent is a small pixel being with a visor. Its antenna light is its status (yellow means it needs you), which matches the app's colour language. It is drawn on a 16-cell grid, and the small cut is drawn on a 12-cell grid so that each cell lands on whole pixels at 16 and 32 px.

Killed along the way:
- A cursive one-line "coool": the loops tangled, and it read as a doodle.
- A loose "dots in the c's gap", a fused "Ooo" chain and a "coil": all three were the ring/dot family, and the fused chain read as a key at 16 px.
- A slider "lanes" mark: it read as a Settings icon.

## My ranking

1. **Peek.** It has the most ownable silhouette (a c that is also a character) and it is friendly without being childish. It also works in one colour, from 1024 px down to 32. At 16 px the eyes drop out and it is simply a strong c, which is acceptable.
2. **Lids.** It has the most personality, and the wordmark is the best of the four (the letters themselves carry the idea). Risks: the expression can read as "unimpressed", and two eyes edge towards Tripadvisor territory, though ours are lidded flat shapes, not ringed owl eyes.
3. **Sprite.** It is the most practical (crisp at 16 px, and the antenna doubles as a live status light), but pixel bots are a familiar genre and it is the least distinctive.
4. **Night Shift.** The story is lovely, but crescent moons are everywhere (Do Not Disturb, sleep apps). The cursor saves it but doesn't make it ownable.

## Next refinements for the winner (Peek)

- Hand-draw the c as a final Bézier outline. It is currently generated from signed-distance shapes, so the curves are clean but not yet optically tuned: thin the bowl slightly at 2 and 4 o'clock, and give the upper terminal a little more hook.
- Make the eyes the character's one variable. Test glances (looking out vs. at you), blinks, and a "needs you" state for the dock badge and animation.
- Rebuild the wordmark's o/l spacing optically. The "l" is still a plain rounded bar and wants a terminal that echoes the c's cut.
- Try a softer, Tahoe-style icon material (subtle inner light and depth, like the Icons tab) once the flat form is settled.
- Rainbow: keep it as a variant only, for example one colour per eye-state. A striped six-colour rainbow reads as a direct Apple logo reference, so it should not be the primary.

## Files

`N-name-icon-dark.svg` / `-icon-light.svg` are the 1024 macOS squircle icons (content within the 824 safe area). `-icon-small-*.svg` is the 16/32 px cut. `-mark.svg` is the mark with a transparent ground, `-mark-mono.svg` the one-colour mark. `-wordmark.svg`, `-wordmark-on-dark.svg` and `-wordmark-mono.svg` are the wordmarks. Lids also has `-icon-alt.svg` (yellow on ink). `preview.png` is the presentation sheet.
