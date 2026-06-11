---
id: 1957
title: "test262: realm-contamination canary — detect intrinsic mutations per test, recycle the fork only when actually dirty"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: high
sprint: 61
area: ci
---
## Problem

Tests in the unified fork pool share one JS realm per worker process. test262's
contract is one fresh realm per test, and many tests deliberately mutate
intrinsics (`Array.prototype.length`, `Object.defineProperty` on `JSON`/`Math`,
`Iterator.prototype.next`, `String.prototype`) — in JS-host mode those
mutations flow through host imports into the worker realm and persist into
every later test in that fork:

- victims fail with someone else's mutations (`Cannot redefine property:
  next`, `Property description must be an object: JSON`,
  `Array.prototype.length` asserts);
- the **compiler runs in the same realm** — a prior test poisoning
  `String.prototype` makes later *compiles* throw `wasm exception during
  compile (poisoned built-in)` (#1862's signature, sent with `status: fail`,
  which also bypassed the poison retry that only matched `compile_error`).

Which tests get hit is a function of shard assignment + dispatch order — the
baseline carries an arbitrary set of contaminated victims, the nightly canary's
flip count exists mostly because of this, and **any change to shard weights or
counts redistributes the victims** (blocked #1953 twice with the same 5
deterministic flips, net −1).

## Design decision

Per-test realm isolation (vm context + fresh runtime bundle per test) was
prototyped and rejected: ~5.2 MB bundle re-execution per test plus a full V8
context's GC pressure inside 512 MB forks, and cross-realm edge cases.
Static "this test looks like a mutator" source classification was rejected as
leaky (mutations via computed access and harness helpers).

Implemented instead: **behavioral detection, targeted reset** (in
`scripts/test262-worker.mjs`):

- At worker startup, snapshot a broad intrinsic surface: ~36 constructors +
  their prototypes, `Math`/`JSON`/`Reflect`, `globalThis`, and the exotic
  iterator/generator prototypes — own property descriptors (value/getter/
  setter identity + flags), `[[Prototype]]`, extensibility.
- After **every** result (`sendResult` choke point — also protects the next
  *compile*), diff the live surface against the snapshot. **Measured cost:
  0.21 ms/test.**
- On real drift, attach a recycle request to the result via the existing
  pool protocol (#1862 path): the contaminating test keeps its own valid
  verdict; the **next** test gets a pristine process. Clean tests pay only
  the diff.
- `REALM_CANARY_IGNORE` absorbs *intentional* realm writes discovered in
  log-mode measurement: legacy RegExp statics (`RegExp.input`, `RegExp.$*` —
  written by every regexp match) and Node's lazy symbol-keyed globals
  (`globalThis.Symbol(undici.…)`). Each entry is a documented hole; extend
  only with log-mode evidence. The post-drift re-baseline guard prevents any
  residual intentional install from looping recycles.
- Modes via `TEST262_REALM_CANARY`: `recycle` (default, set by
  `tests/test262-shared.ts` before pool creation), `log` (measurement),
  `""` (off).

Belt-and-braces: the #1862 poison retry in `tests/test262-shared.ts` now also
triggers on `status === "fail"` with a poison-class error (was
`compile_error`-only — the poisoned-builtin signature ships as `fail`).

## Measurements (2026-06-11, log mode, real corpus via fork probe)

- Canary diff cost: **0.21 ms/test** (400-test average).
- Drift rate on contamination-heavy slices (`built-ins/Object/defineProperties`,
  `built-ins/Array/length`, `built-ins/Iterator/prototype/reduce`):
  **15/400 = 3.75 %** (worst case; corpus-wide expected ≲1 %) — i.e. a few
  recycles per shard, ~0.5 s each.
- Caught contaminations include the exact #1953 victim-maker
  (`Array.prototype.length:changed`) plus `Array.prototype.myproperty:added`,
  `Math.*`/`JSON.*` descriptor pollution.

## Acceptance criteria

- Full-matrix CI run is net ≥ 0 vs baseline (expected: small net improvement
  as previously-contaminated baseline victims start passing).
- Shard wall times within noise of pre-change (~70 s run step at pool=3).
- `[realm-canary]`/`[pool] recycling` lines visible in shard logs at sane
  frequency (no recycle storms).
- #1953's weight maps re-land cleanly afterwards (separate PR) — the gate no
  longer sees redistribution flips.

## Follow-ups

- #1953 re-lands after this merges (`depends_on` updated there).
- The #1589 compile-timeout retry and #1862 poison recycle stay as backstops.
- Nightly canary (test262-canary.yml) flip count is the long-term health
  metric — expected to drop.
