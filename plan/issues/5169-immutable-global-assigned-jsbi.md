---
id: 5169
title: "Emitted module assigns to an immutable global — `JSBI_BigInt` fails WebAssembly.compile on the temporal polyfill"
status: done
completed: 2026-08-29
sprint: current
created: 2026-08-28
updated: 2026-08-29
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
goal: dogfood
related: [4628, 4645, 4644]
assignee: ttraenkler/opus-dev-5169
loc-budget-allow:
  # The fix is 8 mechanical lines (try/finally + liveBodies registration) plus
  # the comment that keeps the next reader from removing them. This file is a
  # god-file at its ceiling, so any addition needs a grant; the fix belongs at
  # the swap site and nowhere else.
  - src/codegen/property-access.ts
---

# #5169 — `global.set` against an immutable global in `JSBI_BigInt`

## Problem

The linked `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` bundle compiles cleanly
but the emitted binary does not validate:

```
CompileError: WebAssembly.compile(): Compiling function #133:"JSBI_BigInt"
failed: immutable global #988 cannot be assigned
```

`compile()` reports `success: true`; only `WebAssembly.compile(binary)` rejects.
Some producer emits a `global.set` (or a `global` init) against a global
declared non-mutable — most likely a string-constant / builtin-carrier import,
which is registered `mutable: false`.

## How it was found

Fell out of #4645. That issue fixed the compile-time/size cliff on the same
bundle; this is a **separate, pre-existing** defect on the same artifact —
verified byte-identical before and after the #4645 fix, so it is not a
regression from it.

## Reproduce

Compile a prefix of the linked bundle cut at ≥262 top-level statements (~109 KB)
with the test262 option set (`allowJs`, `skipSemanticDiagnostics`, `sourceMap`)
and call `WebAssembly.compile` on the result. Below ~109 KB the binary fails
earlier for a different reason (`__call_toString`, #4644), which masks this one.

## Why it matters

Blocks the VALIDATE half of #4628's Temporal lane. After #4645 the bundle
compiles in ~44 s, so the compile gate is green and this is now the first thing
in the way. Per `tests/dogfood/README.md`, a binary that does not validate is an
unverified workload, never a pass.

## Acceptance criteria

1. Name the producer that emits the assignment and the global it targets.
2. Either declare the global mutable at registration or stop assigning it —
   whichever is correct for that global's role, argued in the issue.
3. The ≥109 KB polyfill prefix passes `WebAssembly.compile` (or fails only for
   a different, separately-tracked reason).
4. No test262 regression.

## Resolution (2026-08-29)

**Which side was wrong: the STORE's index, not the global's mutability.** The
`string_constants` import is correctly `mutable: false` — nothing should ever
have been storing there. The class-object singleton's `global.set` had drifted
848 slots down into the import range.

### The producer and the mechanism

`tryEmitConstructorViaTag` (`src/codegen/property-access.ts`) lowers an
`any`-receiver `.constructor` read into a flat `__tag`-equality dispatch, one arm
per tag-bearing class, and builds each arm in a **detached** buffer:

```ts
const arm: Instr[] = [];
const savedBody = fctx.body;
fctx.body = arm;
emitLazyClassObjectGet(ctx, fctx, className);   // interns string constants
fctx.body = savedBody;
```

String constants are **imported** globals, inserted at the end of the import
range — i.e. the start of the module-global range — so every intern slides every
module global up by one. `fixupModuleGlobalIndices` repairs the already-baked
`global.get`/`global.set` instructions it can *reach*: `ctx.mod.functions`,
`ctx.currentFunc.body` + its `savedBodies`, `ctx.funcStack`,
`ctx.parentBodiesStack`, `ctx.pendingInitBody`, `ctx.liveBodies`.

During the swap window `savedBody` is on **none** of those lists —
`ctx.currentFunc.body` *is* `arm`, and the enclosing function is not yet in
`ctx.mod.functions`. `emitLazyClassObjectGet` interns freely (its static-method
CSV, `name`, the class name, each static method name, and via the nested
`emitLazyProtoGet` the instance-method CSV). So the **previous** arm — already
spliced into `savedBody` at the bottom of the loop — kept its pre-shift indices.

**One miss is permanent.** The instruction falls exactly one slot low, which puts
it *below* the next fixup's threshold (`idx >= threshold` is the shift
predicate), so it is frozen there while the module-global range keeps sliding up.
On the linked bundle it froze at 988 while the import range grew to 1,836 — the
store landed on `(import "string_constants" "inLeapYear,monthsInYear,…" (global …
externref))`. Measured with a per-instruction reachability probe: the strand
happened while building the arm for `OneObjectCache`, stranding the arm already
emitted for `TimeDuration`, and so on down the candidate list.

`ctx.classObjectGlobals` itself was always **correct** — `shiftMap` keeps it in
step. Only the emitted instructions desynced, which is why `compile()` is clean
and only `WebAssembly.compile()` objects. This is the same class of defect as
#2023 / #2001 / #3032 / #3933 / #4618, but on a *body* rather than a cached index.

### The fix

Register `savedBody` in `ctx.liveBodies` for the duration of the swap and release
it in a `finally` — the identical discipline `emitLazyClassObjectGet` and
`emitStandaloneClassProtoObject` already apply to their own swaps. Eight
mechanical lines in `tryEmitConstructorViaTag`.

### Verification

| Lane | Before | After |
| --- | --- | --- |
| `tests/issue-5169-immutable-global-class-object.test.ts` | `immutable global #180 cannot be assigned` in `ctorOf` | passes |
| ~109 KB polyfill prefix | `#133:"JSBI_BigInt" … immutable global #988` | error gone |
| full 157 KB linked bundle | (masked) | **0** `global.set` into the import range |

The invariant is asserted directly, not just via the engine's error text: the
regression test scans the emitted WAT for any `global.set` naming a slot inside
the imported-global range and requires the list to be empty.

Scoped A/B on `tests/issue-4618-*`, `tests/issue-2026-*`, `tests/issue-1395-*`,
`tests/issue-4645-dispatch-chain-size` — 15 failures with the fix, the **same 15**
without it, and the same 15 on `origin/main` at `0762bf0231`. Pre-existing and
unrelated. No local test262 run (CI owns conformance).

### Residual — NOT this issue

With #5169 fixed, the full bundle's `WebAssembly.compile` now fails later and for
an unrelated reason:

```
Compiling function #277:"HelperBase_calendarToIsoDate" failed:
type error in fallthru[0] (expected (ref null 109), got (ref null 142))
```

A struct-type mismatch between a class method's declared result and the value its
body produces — no global indices involved. This satisfies AC 3 ("fails only for
a different, separately-tracked reason") but means #4628's validate lane has one
more blocker after this one. Not filed as its own issue here: `gh` is
unavailable in this session, so `claim-issue.mjs --allocate` could not verify an
id against in-flight PRs (exit 6) and reserving an unverified id would leave a
permanent hole in the sequence. **Follow-up owner: file it with a real allocated
id.**
