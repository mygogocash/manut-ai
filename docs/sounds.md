# Sounds

Manut AI plays a few quiet sounds. Most come from GoSpark, our own earlier Mac app, and are synthesized in the page with
the Web Audio API from GoSpark's own numbers (notes, partials, envelopes, durations and volumes, unchanged). The code is
`apps/desktop/src/sound/`; the board that decides when the app's own sounds may play is `apps/desktop/src/lib/sounds.ts`.
Item 131 (26 Nov 2026); its decisions are in [`decisions/131-sounds.md`](decisions/131-sounds.md).

## What plays when

| Sound | When | Volume | Switch (Settings › General › Sounds and chimes) |
| --- | --- | --- | --- |
| Finish chime (Default), or one of five tones | A coding chat's or Buddy's turn ends well while that chat is not in view | 0.35 | Finish chime (on), Finish sound |
| Settle tick | The person puts a chat or lane away with Done for now. Rows that settle by themselves are silent | 0.18 | Done for now sound (on) |
| Effort ticks and impact | The effort slider crosses a level: a tick per level rising up a pentatonic ladder, and an impact at the top level. `effortTick(index, count)` in `src/sound`, called by the effort card | 0.16 to 0.28, impact 0.36 | Effort slider sound (on) |
| Tooltip tick | Built but not used: the app has no tooltip component of its own | 0.12 | None yet (`tooltipSoundEnabled` in `prefs.ts`) |
| Send tick, ask chime, error note | Older sounds from before item 131, unchanged | | Sounds (the master row; its Play button previews the ask chime) |

The master "Sounds" switch and quiet hours hold every sound the app plays by itself; Preview buttons are the person asking
for the sound, so only the gate (below) can stop them.

## A finish sounds once

A finish is named by its chat and its turn. The board lets a name sound once, so a turn that ends twice (a replay, a
reconnect) chimes once, and a finish that came in quiet hours does not ring when they end. The notification for the same
finish is news, which `@manut/notify-rules` makes with no sound, so the chime is its only sound.

## The five tones

Heaven, Highwire, Iridium, Krypton and Kzurb Sonar are from the Android Open Source Project
(`platform/frameworks/base/data/sounds`, revision `1cdfff555f4a21f71ccc978290e2e212e2f8b168`, Apache-2.0; Highwire and Kzurb
Sonar credit Dr. MAD). GoSpark had converted each OGG to 16-bit AIFF; here `afconvert -f WAVE -d LEI16` turned each AIFF into
16-bit PCM WAV, keeping its rate and channels. The files are in `apps/desktop/src/assets/sounds/`, with
`AndroidSoundSources.json` (the source path, the source's SHA-256, the AIFF's and the WAV's). The notice and the licence are in
`apps/desktop/THIRD_PARTY_NOTICES.md`; the credit is in `CREDITS.md`. They ship in the app; nothing is downloaded.

## Tests make no sound

`src/sound/gate.ts` is shut in unit tests, in a browser a driver controls and where there is no `AudioContext`. Every player
asks it first, and `player.test.ts` calls each one and counts it. Playwright specs that count what would play swap in a fake
`AudioContext` and set `window.__manutFakeAudio` (see `e2e/sounds.spec.ts`).
