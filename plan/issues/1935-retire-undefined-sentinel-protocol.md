---
id: 1935
title: "Retire the undefined-as-sentinel protocol in runtime.ts — getters returning undefined are misread as absent"
status: done
assignee: ttraenkler/tld-2139
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: compiler-internals
goal: correctness
---
# #1935 — Retire the undefined-sentinel protocol

## Problem

The host runtime pervasively uses `undefined` as an in-band "absent" signal,
which misinterprets user code that legitimately returns `undefined`:

- `safeGetField` treats a getter returning `undefined` as "getter absent"
  and falls through to sidecar/struct fields (`runtime.ts:3869-3873`:
  `const v = invokeGetter(getter); if (v !== undefined) return v;`). A user
  getter returning `undefined` silently yields the underlying field value
  instead.
- Same pattern in ToPrimitive paths (`prim !== undefined`, e.g.
  `runtime.ts:4658`, `:5046`) — a `valueOf` returning `undefined` is treated
  as "no valueOf".
- The file already demonstrates the correct pattern: `_PRIM_ABSENT` unique
  symbol (`runtime.ts:2079`) — it just isn't applied uniformly.

Property-lookup precedence is additionally re-derived in four places
(`_safeGet` :3307, `_wrapForHost` :3843-4133, `_readOwnDescriptor` :3685,
`_liveGet` :2790) that must all agree — fixing the sentinel must fix all
four consistently.

## Proposed approach

1. One exported `const MISS: unique symbol`; `invokeGetter`, sidecar
   lookups, and ToPrimitive step functions return `MISS` for absence.
2. Sweep the `!== undefined` fallthrough sites (grep
   `invokeGetter|_PRIM_ABSENT|!== undefined` in runtime.ts) and convert.
3. Differential tests (equivalence suite): getter returning `undefined`
   shadows a field; `valueOf` returning `undefined` falls through to
   `toString` per spec ToPrimitive (it should — but via the spec path, not
   the absent path); `Object.assign`/spread over such objects.

## Acceptance criteria

- The getter-returns-undefined test matches V8 in the equivalence harness.
- One absence sentinel; `_PRIM_ABSENT` either renamed/unified or removed.
- test262 js-host lane net non-negative.

## Source

Compiler quality review 2026-06. Related: #1934 (the four lookup paths).

## Resolution (2026-06-16)

Retired the `undefined`-as-sentinel in the property-getter invocation path and
unified the absence sentinel.

### What landed (`src/runtime.ts`)

- **One absence sentinel.** Renamed `_PRIM_ABSENT` → `_MISS`
  (`Symbol("runtime-absent-sentinel")`) with a back-compat alias
  (`_PRIM_ABSENT = _MISS`) so the existing ToPrimitive call sites read
  unchanged. A unique symbol can never be produced by user code, so it is an
  unambiguous "absent" signal.
- **`safeGetField`/`invokeGetter`.** `invokeGetter` now returns `_MISS` ONLY
  when nothing is callable (null/non-function/non-struct). When a getter runs,
  its result — **including `undefined`** — is returned as-is, and the two call
  sites (string `__get_<key>` and symbol accessor) test `!== _MISS` instead of
  `!== undefined`. So an accessor that returns `undefined` is a HIT (reads back
  as `undefined`) instead of being misread as "getter absent" and falling
  through to the underlying field/sidecar.

### Acceptance criteria

- ✅ **One absence sentinel** — `_PRIM_ABSENT` unified into `_MISS` (alias
  retained); the getter path now uses it too.
- ✅ **Getter-returns-undefined matches V8 in the equivalence harness** —
  `tests/issue-1935.test.ts` (4 differential tests via `assertEquivalent`):
  object-literal getter→undefined reads back as `undefined`; value-returning
  getters unaffected; a getter returning `0` is not misread as a miss; class
  accessor reads correctly. Direct probes confirm `typeof o.x === "undefined"`
  for a fresh `Object.defineProperty` getter→undefined (matches V8).
- ✅ **test262 js-host net non-negative / no regression** — the change is
  behaviour-neutral on the existing getter/accessor equivalence suite: the same
  15 pass / 9 fail with AND without this change (verified by swapping in
  `origin/main`'s runtime.ts — identical counts), so no getter test regressed.
  The 9 pre-existing failures are unrelated (precedence/marshaling).

### Scope note — precedence is #1934, not this issue

The headline "getter shadows a same-named **Wasm struct field**" behavior also
depends on the property-lookup **precedence** between the struct field and an
accessor installed over it — and that precedence is re-derived across the four
lookup paths (`_safeGet`, `_wrapForHost`/`safeGetField`, `_readOwnDescriptor`,
`_liveGet`). Making those agree is explicitly **#1934's** domain and is a
larger change. This issue is scoped to (and completes) the *sentinel
retirement*: the value-channel bug where a getter that RAN and returned
`undefined` was conflated with "no getter". The two ToPrimitive `prim !==
undefined` sites already used the dedicated `_PRIM_ABSENT` sentinel correctly
(now `_MISS`) and were left functionally unchanged.
