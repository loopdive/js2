---
id: 4496
title: "Standalone/WASI: __drain_microtasks() in an otherwise-empty module emits an INVALID binary (__str_ws_start type mismatch)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: medium
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: standalone
related: [2895, 2867]
---

# `__drain_microtasks()` alone in a module produces invalid Wasm

## Problem

A module whose only content is the `__drain_microtasks()` intrinsic fails to
validate on **both** carrier lanes:

```ts
export function run(): void { __drain_microtasks(); }
```

```
WebAssembly.instantiate(): Compiling function #17:"__str_ws_start" failed:
  array.get_u[0] expected type (ref null 3), found local.get of type (ref null 2)
```

`compile()` reports `success: true` with **zero** imports, so this is not a
missing-host-import case — the emitted binary is genuinely malformed, and
`WebAssembly.validate()` returns `false`.

## Isolation (measured 2026-08-15)

| source | `--target standalone` | `--target wasi` |
|---|---|---|
| `export function run(): void { }` | valid | valid |
| `export function run(): void { __drain_microtasks(); }` | **INVALID** | **INVALID** |

So the empty module is fine and adding **only** the drain call breaks it.
Requesting the drain runtime in a module with **no other native-string usage**
emits a mistyped native-string helper: `__str_ws_start` reads an array of one
string representation while holding a local of another (`ref null 3` vs
`ref null 2` — the two native-string array types).

The larger #2895 drive fixture (a real async function plus `.then`, which pulls
in ordinary string machinery) validates and runs correctly on both lanes, which
is why this went unnoticed: it only fires when the drain runtime is the *sole*
consumer that forces `__str_ws_start` to be emitted.

## Provenance and pre-existence

Found while correcting the stale "inert until slice 1d" assertion in
`tests/issue-2895-drain-hook.test.ts` during #2867 S2. **This is the real reason
that test case was red** — not the inertness claim it appeared to be making. It
had been failing since the #2980 carrier widen (2026-07-10) with its true cause
misattributed.

A/B'd by file copy against the #2867 S2/S2b changes: **byte-identical failure on
both arms**, so it is pre-existing and unrelated to them.

## Pointer

`tests/issue-2895-drain-hook.test.ts` carries a documented `it.skip` reproducing
exactly this, immediately after the case that now pins the post-widen truth
(standalone drives to `41`, same as wasi):

```
it.skip("minimal module with only __drain_microtasks() emits valid wasm (known defect: __str_ws_start)", …)
```

**Un-skip that test as the fix's acceptance check** rather than writing a new
one; it already asserts both lanes.

## Suggested starting point

`__str_ws_start` is a native-string whitespace-scan helper. The mismatch is
between the two native-string array representations (`$AnyString` subtypes), so
the likely defect is the helper being registered against one representation
while the drain runtime's lazy string registration selects the other — i.e. an
ordering/selection bug in which string types exist when the drain runtime pulls
the helper in, not in the helper's own body. Compare against a module that also
uses an ordinary string (which validates) to see which registration differs.

## Acceptance criteria

1. The `it.skip` in `tests/issue-2895-drain-hook.test.ts` is un-skipped and
   passes on both `--target standalone` and `--target wasi`.
2. `WebAssembly.validate()` is true for the minimal drain-only module on both
   lanes, and it instantiates with an empty imports object.
3. No change to the existing drive fixtures' behaviour (they already pass).
