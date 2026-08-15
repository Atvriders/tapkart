# Tapkart Plan 3 — Render, Content and Game Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the completed simulation and netcode into a game a human can open in a browser and play — track and kart rendering, touch controls, HUD, screen flow, and the shipped content the whole project runs on.

**Architecture:** Three new packages plus a thin app. `packages/content` holds the shipped data (tuning, characters, karts, themes, tracks) and is the only package `render`, `game` **and** `server` all depend on. `packages/render` is pure: it turns a `RaceView` into a `RenderFrame` — a data description of a frame — and a thin adapter draws that frame with Three.js. `packages/game` owns the wall clock, the controls, the screen state machine and the composition root for a race. `apps/web` is a Vite shell that calls `startShell` and nothing else.

**Tech Stack:** TypeScript 5.9 strict, Node 20, vitest 3 (`environment: 'node'`, `globals: false`), Three.js 0.180.0 (the repository's second runtime dependency), Vite.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md`

**Contract:** `docs/superpowers/plans/2026-08-14-tapkart-plan3-contract.md` — **160 exported symbols, locked.** Every signature, constant, units convention and sole-writer rule is pinned there. Where this plan and the contract disagree, the contract wins; where the contract and the spec disagree, the spec wins.

**Rulings:** `docs/superpowers/plans/2026-08-14-tapkart-plan3-rulings.md` — the 34 open questions the contract draft raised, ruled. Read a ruling when a task's reasoning is unclear; each says *why*, which the contract mostly does not.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript 5.9 strict**, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` (so type-only imports use `import type`), `isolatedModules`.
- **Extensionless imports.** Bare specifiers across packages — never a relative path into another package. Test fixtures are the one exception, and only test-to-test (contract §2.6).
- **vitest 3**, `environment: 'node'` everywhere, `globals: false` (so `describe`/`it`/`expect` are imported). **No jsdom, and no per-file `@vitest-environment` override** — if a task believes it needs one, the seam is in the wrong place and the boundary moves instead (ruling Q30).
- **DOM lib is widened per package, never in `tsconfig.base.json`** (R35). `render`, `game` and `apps/web` get `"lib": ["ES2022", "DOM", "DOM.Iterable"]`. `content`, `sim`, `protocol` and `net` stay DOM-free — `server` imports them under plain Node.
- **The tick is 60 Hz and nothing invents a different one.** `TICK_DT` and `TICK_HZ` come from `@tapkart/sim`; `TICK_MS` comes from `@tapkart/net` and is imported by `packages/game/src/clock.ts` and nowhere else (contract §6.1).
- **`game/src/clock.ts` holds the only wall clock in the repository.** No other module in `content`, `render` or `game` reads a clock, directly or indirectly.
- **Track parameter `s` is arc-normalised `[0, 1)`, never metres.** This is the project's most error-prone convention.
- **The seat-source rule** (contract §7.1): a renderer reads the **local** seat from `ClientLoop.state()` and **every other seat** from the `RemoteInterpolator`, and never both. `viewSourceViolations` makes this mechanically checkable and runs under `import.meta.env.DEV` as well as in tests.
- **Scratch-object discipline:** no allocation in per-frame or per-tick paths. Caller-owned buffers, allocated once at construction.
- **Never commit a real LAN IP, hostname, or host filesystem path.** Placeholders and RFC 5737 ranges only. This repository is public.

## The Plan 2 surface

Contract §2.5 lists what `@tapkart/net` and `@tapkart/protocol` export. **Plan 2 merged to master on 2026-08-15 (`ff87a46`) and all of it shipped** — 845 tests, typecheck clean. Task 1 still verifies the surface before anything imports it, because a plan that discovers at task 20 that task 3 was fiction has wasted both.

Two things Plan 2 changed late, after this plan was authored: `sampleKart` and `sampleEntity` take a caller-owned `out` and return `boolean` (they allocated ~4,700 objects/s otherwise, on the very API this plan's renderer is built on), and `RemoteSample.kart` is the **newest received keyframe** — roughly 100 ms *ahead* of the interpolated `position`/`heading` it travels with, which a HUD computing placement from `kart.t` is mixing deliberately.

## What this plan does not build

Audio output (the seam is authored, the backend is a no-op — Plan 5 fills it), the PWA manifest, the service worker, the Dockerfile, CI publish, the server, the lobby handshake, WebRTC, and the Android app. Contract §12 is the full list.

---
