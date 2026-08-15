# Plan 4 — author decisions and cross-task issues for assembly

Four agents wrote 26 task files in parallel against the locked contract. Two of them built and RAN
their modules first (tasks 6-11b: 64 new tests green plus mutation testing; tasks 1-5: every
hand-computed byte fixture machine-verified). This records what they decided where the contract was
silent, and what the assembler must resolve.

## Cross-task issues the assembler MUST resolve

1. **Execution order is NOT numeric.** After the net tasks, the server group runs
   `16 -> 18 -> 17 -> 22 steps 1-4 -> 20 -> 19 -> 19b -> 21 -> 22 steps 5-8 -> 23 -> browser multiplayer bridge -> 24`, because `hub.ts`
   imports `LogSink`, `RateLimiter`, `ContentProvider` and `startRace`, and the barrel needs all
   twelve modules. Task 22 says so at its top and commits once at the end.
2. **`packages/net/src/socket.ts` is claimed by BOTH Task 2 and Task 7**, and both write
   `packages/net/test/socket.test.ts`. Task 7 already carries the resolution: verify-don't-recreate
   the module, APPEND its two describe blocks rather than overwrite (each pins coverage the other
   lacks), skip barrel edits already present.
3. **`packages/server/package.json` is claimed by BOTH Task 1 and Task 16.** Task 23 assumes Task
   1's `ws`/`@types/ws` pins and adds only `build`/`start` plus root `esbuild`.
4. **Task 15 claims to close the `net` barrel** with all nine `export *` lines, which double-adds
   against the per-task wiring in Tasks 2 and 7-11b. Reduce Task 15's barrel step to *verify and
   add only what is missing*; its own "each line appears exactly once" assertion is what catches a
   double-add.
5. **`transport-conformance.ts` (§9.2) is owned by Task 11c.** It creates the
   shared suite and invokes it for Loopback, LocalInput, WebSocket and WebRTC;
   Task 18 later invokes that same suite for `RoomTransport`. Task 11c also owns
   the two browser-only factories and their package subpath exports, which are
   deliberately absent from the DOM-free net barrel.
6. **Barrel wiring is per-task, deliberately.** Task 18's shipped `barrel.test.ts` fails the moment
   a file exists in `src/` without an `export *` line, so deferring barrel edits leaves `npm test`
   red across the whole middle of the plan.

## A cross-PLAN dependency Plan 3 does not know about

**The browser lanes declare ELEVEN cross-plan `data-testid` hooks: Plan 4's ten plus Plan 5's
`solo-button`. The shell must carry all eleven.** A selector mismatch is deliberately not skipped,
so the dependency stays visible rather than silently green.
(`lane.spec.ts` is green today and proves the lane itself, including no-redirect on
`/.well-known/` over real HTTP.)

## The gate, verified rather than assumed

CLOSED in two places at authoring time: promotion state now has the free reader
`promotionTickOf(loop)` backed by Plan 2's WeakMap (it is deliberately not a `ShadowLoop` member),
and `packages/content` landed in Plan 3. `isDemoted` had already landed.

## Decisions worth keeping (contract silent)

- **`playerIdOfInput` takes the whole datagram, not the body.** §8.1's "returns -1 on a 0-, 1- and
  2-byte buffer" is only meaningful with the header included, and it makes §4.7's "allocation-free"
  literally true (no `subarray`).
- **Every `RoomClient`->server message is addressed to peer `'p0'`, never broadcast.** A broadcast
  on `WebSocketTransport` emits one frame to `WS_SLOT_BROADCAST`, which the server fans out to
  *other guests* — a `hello` sent that way never reaches the room, and the join hangs forever.
- **The room is a peer from CONSTRUCTION**, else `RoomClient`'s first `hello` is a no-op.
- **`signal.ts` <-> `webrtc.ts` is a deliberate type-only cycle.** Erased at runtime, so vitest is
  green with either file alone, but `tsc` reports one TS2307 until both land. Both tasks forbid
  stubbing or re-defining the type: a second definition makes the barrel's `export *` AMBIGUOUS,
  which ESM resolves by SILENTLY DROPPING the name.
- **`parseSignal` rejects unknown keys at all three levels**, so `__proto__`/`constructor` fall out
  as cases rather than a blocklist the next key walks around.
- **One WebRTC FIFO flushed when BOTH channels open** (per-channel would reorder across channels);
  ICE buffered until the remote description; every promise chain has a `.catch`, because Node's
  default unhandled-rejection policy kills the process — the same failure class as a throwing
  decoder.
- **`seatMapOf().isAuthority`**: the contract's literal
  `promotionTickOf(room.race.shadow) < 0`
  does not compile. Ruled: no race => nothing has promoted => the host is authoritative. The other
  reading drops the host's first snapshots, because `startRace` builds the map before `room.race`
  is assigned.
- **A malformed frame logs `badFrame` and drops; only a version mismatch closes (4001).**
- **Inbound frames are stamped with the newest `poll(nowMs)`** — a socket callback carries no time
  and `Date.now()` lives in one file. <=8 ms stale, never backwards.
- **The Playwright harness binds a fixed loopback port from harness-only `E2E_PORT`** (default
  3132) and maps it to the child server's `PORT`. Do not pass `TAPKART_E2E_PORT`: the server
  correctly rejects unknown `TAPKART_*` variables. Playwright must know the URL before starting
  the server; loopback-only is preserved.
- **`ENV_SCHEMA` is twelve rows** including the two `TAPKART_*` the container sets (ruling L3), and
  **an empty value is a value, not an absence** — `ICE_SERVERS=` disables STUN, which is exactly
  what F-P4-16's disclosure promises a self-hoster.
- **Registry**: `removePeer` keeps a SEATED record (the token is the reconnect credential) and
  deletes an unseated one; the freed slot stays on the record so `reclaim` allocates a strictly
  different one; `reclaim` RE-POINTS `room.seats[playerId]` rather than assigning, or the vanished
  peer stays authorised in `seatMapOf` and the returning player does not.

## Verification the authors did unprompted

- **Tasks 1-5**: every hand-computed byte fixture machine-verified against a reference `BitWriter` —
  six lobby byte arrays, four `*_MAX_BYTES` derivations, the room-code and token anchors,
  `utf8Truncate` over 6 samples x 41 caps, and every `soleDifferingBit` offset. **Caught a real
  bug**: `peerSlot 1 vs 3` differs at bit **1**, not bit 0, so the original fixture would have had
  `writeCodeAt` corrupting the wrong field while the test passed.
- **Tasks 6-11b**: all seven modules built and run (64 new tests, full suite 869 green), then
  mutation-tested. **Three webrtc mutations initially SURVIVED**, so the fixture was changed until
  they didn't: the fake pair now opens its two channels at DIFFERENT instants, because a fixture
  opening both at once structurally cannot detect a transport that flushes its queue on the first
  open.
- **Tasks 12-17**: every authz test has a negative case with a peer that provably should be
  refused, a state assertion, and — where the refusal is the whole point — a POSITIVE CONTROL
  proving the test can fail: the same forged input through an undecorated transport *does* flip
  `karts[0].connected`, and the same ten forged bytes *do* set `isDemoted(loop)`.
