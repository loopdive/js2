---
id: 6682
title: "standalone: axios `redactConfig` trips codegen invariant #2182 (liveBodies unbalanced, entry=1 exit=2)"
status: done
sprint: current
created: 2026-09-26
updated: 2026-09-26
completed: 2026-09-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: closures
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1472, 2182, 5301, 6660]
# 2026-09-26: +4 lines in emitCollectionAdderGuard restore the #2182 swap
# discipline (savedBodies push/pop + paired liveBodies add/delete); the fix
# belongs at the leaking site, not in a new module.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
---

# #6682 — axios `redactConfig`: liveBodies unbalanced under `--target standalone`

## What you will see

After [#1472](https://js2wasm.loopdive.com/dashboard/issue.html?slug=1472-no-js-host-object-property-ops)'s
`Buffer` receiver slice, the npm-compat **axios** standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-26) stops at:

```
Internal error compiling function 'redactConfig': codegen invariant (#2182): liveBodies unbalanced after compiling 'redactConfig' (entry=1, exit=2) — a detached-body liveBodies.add() is missing its matching .delete(), risking funcIdx over-shift.
```

at `package/lib/core/AxiosError.js:29:1`. The full error list of that compile
has one more entry after it:
`.js2-npm-compat-perf-standalone-dynamic.mjs:4:32 Codegen error: Maximum call stack size exceeded (at src/codegen/fixups.ts:207:17)`
(also listed in #6660; possibly a consequence of the unbalanced body).

## Shape

`redactConfig(config, redactKeys)` builds a `Set` from `redactKeys.map(...)`,
then a self-recursive arrow `visit` that closes over `lowerKeys`, `seen`, and
the module imports `utils` / `AxiosHeaders`; the array arm recurses from a
`forEach` callback, the object arm from a `for (const [key, value] of
Object.entries(source))` loop with a ternary (`lowerKeys.has(...) ? REDACTED :
visit(value)`).

A single-file copy with local stubs for `utils` and `AxiosHeaders` compiles and
runs correctly under standalone (`1`), so the trigger involves the imported
bindings (`utils` from `../utils.js`, `AxiosHeaders` from
`./AxiosHeaders.js`) — start the reduction from the real two-module graph.

## Pointers

- `#2182` liveBodies invariant: a detached-body `liveBodies.add()` without a
  matching `.delete()` on some early-return path.
- #5301 fixed the JS-host trap in the same function (self-recursive arrow
  conditional box).

## Implementation Plan

1. Reduce: instrument `ctx.liveBodies` to record the stack of every `.add()`
   not matched by a `.delete()`, compile the axios standalone-dynamic driver.
   Both leaked adds came from `emitCollectionAdderGuard`
   (`src/codegen/expressions/new-super.ts`), reached from
   `new Set(redactKeys.map(...))` (direct and via the iterable drive).
2. Why only in the two-module graph: the guard is emitted only when
   `ctx.protoNamedDirty` is set (a named write onto a builtin prototype —
   axios's `utils.js` has one). A one-file reduction therefore needs such a
   write: `(Array.prototype as any).__extra = 1` + `new Set(iterable)` inside a
   function reproduces `entry=0, exit=1` under `--target standalone`. The
   js-host lane never registers `__protoidx_has_r`, so the guard is a no-op
   there (unaffected, byte-identical).
3. Fix the swap discipline in `emitCollectionAdderGuard`: push the real body on
   `fctx.savedBodies`, register the detached `thenArm` and `throwArm` in
   `liveBodies` for the duration of `emitThrowTypeError`, and release all three
   in `finally` (the `then-thenable-miss.ts` pattern). The old code added
   `throwArm` and never deleted it, and left the real body and `thenArm` off the
   late-import shifter's walk.
4. Regression test `tests/issue-6682-collection-adder-guard-livebodies.test.ts`
   (standalone + gc).

## Resolution

Fixed in `emitCollectionAdderGuard`. Measured 2026-09-26:

- Regression test: parent 3 fail / 2 pass (all standalone cases fail to
  compile; gc control passes), fix 5 / 5.
- Scoped standalone test262 (`built-ins/{Set,Map,WeakMap,WeakSet}/**`, 813
  rows, `scripts/run-test262-paths.mts --standalone`, interpreter eval engine):
  parent and fix both `pass 741 / fail 59 / compile_error 13`, identical
  non-pass sets — no losses.
- JS-host: binaries byte-identical parent vs fix; axios dogfood suite
  208/231 (unchanged).
- axios standalone-dynamic lane: `compile-error` "codegen invariant (#2182):
  liveBodies unbalanced after compiling 'redactConfig'" → next blocker
  `Codegen error: Maximum call stack size exceeded (at src/codegen/fixups.ts:207:17)`
  (already listed in #6660; not a consequence of the unbalanced body).
