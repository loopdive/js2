---
id: 6777
title: "codegen: `in` on array carriers — type-confused lowering (invalid module on `any[]`), wrong answers on holes/`delete`, non-boolean result"
status: done
sprint: Backlog
created: 2026-09-30
updated: 2026-10-01
completed: 2026-10-01
assignee: "ttraenkler/claude-dev-6777"
branch: "claude/issue-6777-in-array-carrier"
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: in-operator
goal: core-semantics
related: [6776, 2130, 2741, 3280, 1991]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — C1/H5"
---

# #6777 — `in` on arrays is wrong three ways, and one of them emits an invalid module

## Problem

Probe results (JS-host lane, `compile()` + `buildImports`, diffed against Node):

| source | wasm | JS |
|---|---|---|
| `const arr: any[] = [1,2,3]; arr[5] = 9; [2 in arr]` | **invalid module** (`struct.get[0] expected (ref null 2), found (ref null 4)`) — `success: true` | `[true]` |
| `const arr: number[] = [1,2,3]; delete arr[0]; 1 in arr` | `false` | `true` |
| `const arr: any[] = [1,2,3]; delete arr[0]; 0 in arr` | `true` | `false` |
| `[2 in arr]` on a dense `number[]` | `[1]` / `[0]` (i32, not boolean) | `[true]` / `[false]` |

## Root cause

`src/codegen/binary-ops-in.ts`:

- `:383-394` detects the vec carrier by **struct-name prefix**, then the typed
  arm at `:482` emits `struct.get` against a struct type that does not match the
  local's actual carrier type when the array is `any[]` (the `any` vec and the
  typed vec have different struct indices). That is the invalid module.
- `:482-490` answers `idx < length` for the dense case — a hole created by
  `delete` (#2130 made `delete arr[i]` work) still reads as present, and the
  comparison result is left as i32 instead of going through the boolean box.
- The comment at `:490` already names the `__extern_has_idx` chokepoint that
  handles holes correctly; the typed fast path bypasses it.

## Correction

1. Route every `in` whose RHS is an array carrier (typed vec, `any` vec,
   sparse-capable vec) through one helper that consults the carrier's hole
   representation (whatever `delete arr[i]` writes) and returns a proper
   boolean.
2. Keep a fast path only where the carrier is statically known dense AND the
   key is a statically-in-range integer; otherwise call the helper.
3. Resolve the carrier struct type from the compiled receiver's `ValType`,
   never from a name prefix.

## Acceptance

- All four rows above match Node.
- Regression file `tests/issue-6777-in-array-carrier.test.ts` covering `any[]`,
  `number[]`, `string[]`, holes via `delete`, out-of-range index, negative
  index, string keys (`"length" in arr`, `"0" in arr`), and the result being a
  real boolean (`=== true`).
- With #6776 landed, the first row is a compile error until fixed; after this
  issue it is `[true]`.

## Implementation Plan

1. New module `src/codegen/in-array-carrier.ts` owns every `in` whose RHS
   is an array carrier:
   - `isPlainArrayCarrierType` replaces the `__vec_` name-prefix test with a
     structural one (`$__vec_base`, or a `$__vec_base` subtype that is exactly
     `{ length, data: array }`), so subviews / TypedArray views / the RegExp
     match vector keep their own arms as before.
   - `compileArrayCarrierIn(ctx, fctx, expr, constantKey)`:
     - constant key `"length"` → evaluate both operands, `true`;
     - constant key that is a canonical array index (`String(n) === key`,
       `0 ≤ n ≤ 2^32−2`) → `emitConstantIndexIn`;
     - any other constant key → declined, so `"push" in arr` / bag expandos
       keep the named-property fold;
     - no constant key → `emitKeyFirstExternHas(…, rawReceiver = true)`.
   - `emitConstantIndexIn` keeps the inline `index < length` compare only when
     `arrayCarriersStaticallyDense(ctx)` (none of `usesArrayHoles`,
     `vecIndexDeleteDirty`, `vecAccessorDescriptorDirty`, `protoIndexDirty`,
     `dynamicCodeDirty`) AND the receiver compiled to a `$__vec_base` subtype;
     the `struct.get` type index comes from that compiled ValType. Otherwise
     it calls the lane's presence chokepoint: native lanes
     `__extern_has_idx(vec, f64)`, js-host `__extern_has(vec, boxed index)`
     (the host `__extern_has_idx` has no vec arm — it answered 0 for every
     index, which is what made row 2 false).
   - The receiver is handed over as the vec itself (`extern.convert_any`, and
     compiled without an externref hint): `coerceType` / the hint route a vec
     through `__make_iterable`, whose detached JS mirror ignores the host
     delete tombstone (`delete a[2]` on an array of objects still answered
     present).
   - Every arm returns `{ kind: "i32", boolean: true }`.
2. `src/codegen/binary-ops-in.ts`: detection uses `isPlainArrayCarrierType`;
   the old vec block (the `:482-550` arm the review pinned) is replaced by one
   call; `leftType` is hoisted once and reused (net −1 `getTypeAtLocation`,
   −1 `ctx.checker`); `emitRuntimeExternHas` keeps its #5358/#5383 records and
   delegates its body to the shared `emitKeyFirstExternHas` (byte-identical
   for non-array receivers); the now-unused `vecCarrierElementIsF64` and the
   `f64HolesActive` / `overlayRouteActive` / `getArrTypeIdxFromVec` imports are
   gone.

## Resolution

Probe harness `.tmp/6777/probe.mts` (compile + run, diffed against node on the
type-stripped source), 43 shapes / 79 lane runs (`.tmp/6777/cases*.json`),
base = `5a001e24`:

| shape | lane | before | after | node |
|---|---|---|---|---|
| row 1 `any[]` + `arr[5] = 9`, `[2 in arr]` | host | **invalid module** | `[true]` | `[true]` |
| row 1, bitmask | standalone | **invalid module** | correct | — |
| row 2 `number[]`, `delete arr[0]`, `1 in arr` | host | `false` | `true` | `true` |
| row 3 `any[]`, `delete arr[0]`, `0 in arr` | host | `true` | `false` | `false` |
| `string[]` after delete | host | wrong | correct | — |
| dynamic `i in arr` (any key) | both | always `false` | correct | — |
| elisions `[1, , 3]` | host (number), both (`any[]`) | wrong | correct | — |
| literal-typed keys (`const k = 1`) | both | wrong | correct | — |
| `delete` on an array of objects | host | wrong | correct | — |
| §13.10.1 key-before-receiver order | host | `false` answer | correct | — |

Row 4 (`[2 in arr]` → `[1]`) does not reproduce on current main:
`JSON.stringify([2 in arr])` already prints `[true,false]`. The `1`/`0` shape
does reproduce through `unknown[].push(2 in arr)` and a raw `boolean` export
return — but identically for `a < 2`, `a === 1`, `!a` and `delete o.x`, so it
is a general boolean-boxing defect at those sinks, not an `in` defect, and is
left for its own issue. The `in` arms now return a boolean-branded i32
regardless.

Totals: **42 divergences before → 9 after**. The nine: the gap index of row 1
on both lanes (below), the raw `boolean` export return (above), and six runs
(five causes) that also diverge on the base, outside the `in` site:

- standalone `(string | undefined)[]` elision: `hasOwnProperty(1)` is also
  true — the native-string carrier stores no hole (store side);
- standalone `delete` on an array of objects: `arr[2]` still reads the object
  and `Object.keys` still lists it — the delete never reaches the carrier;
- standalone non-canonical numeric STRING keys (`"01" in arr`, `"1.0" in arr`):
  native `__extern_has` parses the key with `__str_to_number` and never checks
  `ToString(n) === key` (object-runtime.ts numeric arm);
- js-host `Array.prototype[1] = …` over a hole: host `__extern_has` vec arm
  does not consult the Array prototype;
- js-host named expando through a CONSTANT key (`'foo' in arr` after
  `arr.foo = 1`): the #4062 bag route is standalone-only by design
  (`vecNamedKeyNeedsRuntime`); the dynamic-key spelling is now correct.

Also out of scope, documented in `in-array-carrier.ts`: an f64 grow gap
(`a[4]` after `a[5] = 9`) in a module with no hole source holds the T8-A
`UNDEF_F64_BITS` marker, indistinguishable from a stored `undefined`
(`vec-f64-hole-presence.ts` "Demand gate"); no `in` lowering can recover it.

Tests: `tests/issue-6777-in-array-carrier.test.ts` — 16 sources on both lanes
plus 4 js-host-only, every binary `WebAssembly.validate`d, standalone modules
asserted import-free. Base: 27/36 fail; fix: 36/36 pass.

Gates (exit codes): `check-loc-budget` 0, `check-func-budget` 0 (also with
`LOC_GATE_BASE=origin/main`), `check-coercion-sites` 0, `check:oracle-ratchet`
0 (net `getTypeAtLocation` −1, `ctx.checker` −1), `check:dead-exports` 0,
`typecheck` 0, `format:check` 0. `test:guard`: 254/255 — the one miss is
`issue-3613-vacuity-machinery` "repo is clean" timing out at 35 s with load
average ~20 on 4 cores; alone it passes 28/28 in 24 s. Related suites
(`in-operator-*`, equivalence `in-operator-edge-cases`, #1444, #2130, #2617,
#2741, #2856, #3920, #4062, #4369, #4491-wave4, #4515, #6485, #6670, #2001-s1,
#6482-r7, es5 holes): 12 failures, the identical 12 on the base (file-copy
revert, same box) — none touched by this change.
