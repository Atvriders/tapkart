# Tapkart Plan 5 — NFC, the Android App, the PWA, and Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tap real. The host's Android app emulates an NFC Forum Type 4 tag holding the lobby URL; a guest taps and lands in the race. Plus the PWA that makes the browser build installable and offline-capable, the Web Audio backend behind Plan 3's seam, and the CI that builds, signs and publishes all of it.

**Architecture:** `packages/invite` is pure TypeScript — URI building, the Type 4 tag state machine, App Links assets, and a hand-written QR encoder. The Android side mirrors the byte-level parts in Kotlin, and **a shared fixture both languages replay is what keeps them identical.** `apps/android` is a Capacitor project whose only added capability is NFC. Everything that can be a pure function over byte arrays is one, because that is the only part of NFC that CI can test at all.

**Tech Stack:** TypeScript 5.9 strict, Kotlin, Capacitor, Gradle, Vite (PWA), Web Audio, GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-08-13-tapkart-design.md` — §2 is the binding argument for every decision in this plan.

**Contract:** `docs/superpowers/plans/2026-08-14-tapkart-plan5-contract.md` — **2,693 lines, 144 exported symbols, locked.** Where this plan and the contract disagree, the contract wins; where the contract and the spec disagree, the spec wins.

**Rulings:** `docs/superpowers/plans/2026-08-14-tapkart-plan45-rulings.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **TypeScript 5.9 strict**, plus `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`. Extensionless imports; bare specifiers across packages. vitest 3, `environment: 'node'`, `globals: false` — **no jsdom, and no per-file override.**
- **The placeholder rule has no exceptions.** Never commit a real LAN IP, hostname, host filesystem path, keystore, signing key, certificate fingerprint, or token. Use RFC 5737 ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), `tapkart.example` (RFC 2606), and obviously-fake fingerprints. **This repository is public**, and contract §1 states the exact values to use. A grep test enforces it.
- **`dom` and `webworker` cannot coexist in one TypeScript program.** The service worker gets its own tsconfig with `lib: ["ES2022", "WebWorker"]` **and `"types": []`**, and everything `sw.ts` imports must typecheck under both libs.

## Five values that must agree, or App Links silently fails

Contract §3. The invite path, the origin, the room-code length, the package identity and the certificate fingerprint are compiled into the APK's `autoVerify` intent filter and frozen at the first signed release. A mismatch does not error — **the tap opens a browser instead of the app, with no message anywhere.** Every one of them reads from a single constant.

`LOBBY_PATH_PREFIX`, `ROOM_CODE_ALPHABET` and `ROOM_CODE_LENGTH` live in `@tapkart/protocol` and are never restated.

## What CI can and cannot prove

Contract §3.2 and §5.1, and spec §8's "What CI cannot verify". State this honestly in every task it touches:

- **CI can prove**: the APDU command/response exchange byte by byte (it is a pure function over byte arrays), manifest and intent-filter structure, `assetlinks.json` shape, fingerprint format, the caching policy, the QR encoder against **published reference vectors**, and that the Kotlin and TypeScript implementations agree — by replaying one shared fixture through both.
- **CI cannot prove**: that the tap works. HCE needs two physical devices in contact. Also unverifiable: App Links resolution against a live domain, and how the game sounds on a real phone.

A task that claims CI proves the tap works is lying. Say what is owner-verified and put it in the checklist.

---
