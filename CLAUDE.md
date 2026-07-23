# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What this project is

This codebase started as a **copy of `pilgrims-progress-game`** (a Pilgrim's Progress themed,
Fall-Guys-style cooperative multiplayer physics obstacle-course game), kept at
`C:\Users\skkco\OneDrive\바탕 화면\연습\pilgrims-progress-game` — that original repo is untouched
and still deployed at https://pilgrims-progress-game.onrender.com. This folder is a fresh
starting point to build a **different game** on top of the same working engine/architecture.

**The new game's theme/content has not been decided yet.** If the user hasn't told you what
game they want to build, ask before making content decisions (theme, level names, villain
design, etc.) — but feel free to work on generic/engine-level tasks without asking.

Not yet a git repo (`.git` was deliberately not copied) — offer to `git init` when the user is
ready to start committing.

## Tech stack

- Node.js + Express + Socket.IO for real-time multiplayer, **server-authoritative** physics.
- `cannon-es` for physics simulation (server-side).
- Three.js for client-side rendering.
- Deploy target: Render.com free tier (see `render.yaml`), `npm start` runs `server/index.js`.

## Architecture

- **`shared/level.js`** — UMD module loaded by both server and client (via `<script>` tag in
  `index.html` and `require()` on the server). Contains pure data (level/obstacle/villain
  definitions) and pure functions (e.g. `kinematicTransform(piece, t)` which computes a moving
  obstacle's position/rotation at time `t`). Keeping this shared and side-effect-free is what
  lets client and server agree on where obstacles are without extra sync traffic.
- **`server/index.js`** — authoritative game loop: owns the `cannon-es` `World`, steps physics,
  applies player input, runs collision/hazard/villain logic, broadcasts state via Socket.IO.
- **`public/client.js`** — Three.js renderer + input handling + UI (HUD, toasts, victory
  screen). Never trusts its own physics for gameplay outcomes — it renders what the server says.
- **`public/index.html`** / **`public/style.css`** — screens (lobby / world / victory), HUD,
  mobile joystick/jump button, toast, confetti/victory CSS animations.

## Important gotchas learned building the original game

These are non-obvious things that cost real debugging time — worth knowing before you hit them
again in a new game built on this engine.

1. **Forced velocity overwrite defeats cannon-es collision response for fast kinematics.**
   The movement model sets `body.velocity.x/z = input * MAX_SPEED` unconditionally every tick
   (arcade-style movement, not physics-driven). This overwrites whatever pushback the cannon-es
   solver computed in response to a collision, so fast-moving KINEMATIC hazards (rotating bars,
   rolling spheres) get silently passed through with zero collision effect. Vertical (Y) is
   unaffected because velocity.y is only ever *added to* (gravity/jump), never force-reset — so
   standing on platforms works fine, only horizontal hazard-blocking breaks.
   - **Fix pattern used**: for hazard-type obstacles that need real pushback (not just
     stand-on-able platforms), don't give them a cannon-es body at all — do simple per-tick
     distance/closest-point math directly against `kinematicTransform(piece, t)` output, and
     apply a manual knockback velocity. This mirrors the villain-AI collision pattern (villains
     were never cannon-es bodies either, just plain objects with distance-based hit detection).
   - Platform-type kinematics (box/cylinder you stand on) are fine to keep as real cannon-es
     KINEMATIC bodies — that path is proven to work correctly.

2. **Bot-based full-course traversal testing has a real ceiling.** A simple steering bot with no
   jump-timing/bob-phase adaptation cannot reliably clear zigzagging/bobbing platform sections —
   this is a bot limitation, not necessarily a gameplay bug. Don't chase "bot got stuck" as proof
   of a regression; A/B test against the previous committed version first.

3. **Preferred verification method for physics/collision bugs**: write an isolated,
   server-free, minimal `cannon-es`-only reproduction script (no sockets, no Express) that
   replicates just the relevant movement/collision pattern. This gives deterministic,
   millisecond-scale answers instead of relying on flaky full end-to-end bot runs. Pair with a
   pure-math unit test when the fix involves new geometry (e.g. quaternion-based closest-point
   math for rotated boxes) before wiring it into the server loop.

4. Temporary repro/test scripts belong outside the repo (or deleted before committing) — this
   project's history has none lingering, keep it that way.
