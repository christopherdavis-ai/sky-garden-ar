# Sky Garden AR — Project Handoff

**Project:** "Sky Garden AR" — TrueLayer 10-year anniversary party web-AR app.
Phone-browser AR (Three.js): client & bank logos appear as glowing beams over
London's Sky Garden, with a particle/line network flowing toward TrueLayer.

## Links

| What | URL |
|---|---|
| Live AR experience | https://sky-garden-ar.vercel.app |
| Photo wall (display screen) | https://sky-garden-ar.vercel.app/wall.html |
| Wall admin (moderation) | https://sky-garden-ar.vercel.app/wall-admin.html |
| GitHub repo | https://github.com/christopherdavis-ai/sky-garden-ar |
| Vercel project | https://vercel.com → project `sky-garden-ar` |

> ⚠️ Confirm the exact Vercel subdomain in the dashboard if it isn't `sky-garden-ar`.

## Key files

- `ar.html` — entry page / HUD markup
- `src/ar-main.js` — AR scene: beams, logos, particles, lattice, disco, day/night
- `src/quest.js` — "Find your client" quest + selfie Photo Booth
- `public/wall.html` — photo wall display
- `public/wall-admin.html` — wall moderation
- `data/clients.json`, `data/banks.json`
- `party.png` — party hero logo

## Brand

Lavender `#AFADFF`, indigo `#4D3BD8`, pale `#E7E6FF`, near-black `#060606`; font **Manrope**.

## Delivery preference

Provide updated files written out so they can be downloaded and dropped into the repo
(correct names, `.js` intact). Avoid timestamped/converted downloads that force renaming.

## Current state (as of 17 Jun 2026)

- Control bar = round icon chips (Disco / Snap / Quest / Photo Booth) + "⋯ More"
  popover (Recalibrate / Auto light / Test Mode; Test Mode hidden from guests).
- Hero party logo floats large in the sky above Sky Garden, glowing + bobbing.
- Disco mode tamed: gentle slow rainbow + soft sway (movement-focused).
- Particles: every lattice line carries a glowing particle stream; particles are big,
  glowy, and have random turbulence (drift off the lines, not linear).
- Day/night auto; particles & lines stay visible in day mode.
- Portrait culling fixed (beams/logos no longer vanish when tilting up) — uses the
  camera's real look-direction, not the raw compass heading.
- Photo Booth (selfie): front camera auto-rotates upright on Android (OnePlus 10 Pro
  quirk) with a 🔄 manual rotate button (remembered in `localStorage`); rotation applied
  to live view AND saved/wall photo. Buttons no-wrap. Title = "10 Years Anniversary
  Party!", subtitle "Sky Garden · Summer 2026", corner hashtag removed (`PHOTO` config
  near top of `quest.js`: `title` / `subtitle` / `tag`).

## Open / possible next items

- Optional "fat lines" for genuinely thicker web lines (WebGL ignores `linewidth`).
- Hero party-logo treatment (may redesign later).
- Verify exact Vercel subdomain.
