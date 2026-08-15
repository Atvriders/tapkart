# Tapkart Plan 4 — Server, Lobby, and the Real Transports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a game that only plays solo into one strangers join by tapping a phone — a Node server holding rooms and signaling, WebRTC and WebSocket transports, a lobby handshake, and a shadow authority per room that takes over when the host's phone drops.

**Architecture:** `packages/protocol` gains the lobby message kinds. `packages/net` gains `WebSocketTransport` and `WebRtcTransport`, both **pure over injected socket and connection interfaces**, so CI exercises every byte of them with no browser and no network. `packages/server` is a set of pure modules over an injected clock and registry, plus a thin `runtime/` adapter that is the only thing binding a port.

**Tech Stack:** TypeScript 5.9 strict, Node 20, vitest 3 (`environment: 'node'`, `globals: false`), `ws`, esbuild (server bundle), Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md`

**Contract:** `docs/superpowers/plans/2026-08-14-tapkart-plan4-contract.md` — **3,412 lines, 215 exported symbols, locked.** Every signature, constant, bit layout and sole-writer rule is pinned there. Where this plan and the contract disagree, the contract wins; where the contract and the spec disagree, the spec wins.

**Rulings:** `docs/superpowers/plans/2026-08-14-tapkart-plan45-rulings.md` — the forks and cross-plan conflicts, ruled, with reasoning the contract mostly omits.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript 5.9 strict**, plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`.
- **Extensionless imports.** Bare specifiers across packages — never a relative path into another package. Test fixtures are the one exception, test-to-test only.
- **vitest 3**, `environment: 'node'` everywhere, `globals: false`. No jsdom.
- **`packages/server` is DOM-free.** It imports `sim`, `protocol`, `net`, `content` — and **never `game` or `render`** (spec §3). That restriction is why `packages/content` exists.
- **Everything is testable headlessly, with no browser and no external network.** Both real transports are pure over injected interfaces; the adapters that touch `ws` and `RTCPeerConnection` are thin and named. **Exactly one test may bind `127.0.0.1:0`** — contract §0b names it, and it exists because the composition root is otherwise the one thing CI never executes.
- **No wall clock inside anything deterministic.** Time arrives as a parameter, as `net` already does it.
- **A malformed frame closes one socket; it never takes the process down.** The bytes arrive from a public socket, and the expected trigger is a version mismatch after a deploy, not an attacker.
- **Never commit a real LAN IP, hostname, host path, or token.** RFC 5737 ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) and `tapkart.example` (RFC 2606) only. This repository is public.

## Three facts that bind every task

- **`PROTOCOL_VERSION` goes to 2.** Five-character room codes change `hello`'s layout, so version 1 and version 2 cannot interoperate. Cross-version rejection needs a WebSocket close code, because an encoded `welcome` cannot cross a version boundary.
- **`ShadowLoop` does not copy its `ctx`.** `promote()` writes `isLeader` into the **caller's** object, so a memoised `contextFor` would make one room's promotion turn *every* room into a leader. Contract §7.1 states the freshness rule and a two-room test pins it.
- **The shadow owns host-loss detection, counting elapsed milliseconds.** There is no second detector in the server. A tick counter stalls exactly when the ticker clamps — spec §11's second risk — so it would promote late in the conditions that cause host loss.

## The Plan 2 and Plan 3 gate

Contract §2.10 lists what must exist before this plan's first import compiles. Task 1 verifies it and **halts if it is closed** — building against a surface that does not exist yet is how a plan discovers at task 20 that task 3 was fiction.

---
