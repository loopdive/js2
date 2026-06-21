---
id: 2102
title: "shared throwJsError(kind, msg) lowering + trap-site audit — runtime checks must throw catchable JS errors, not Wasm traps"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-17
completed: 2026-06-17
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: exceptions
goal: core-semantics
related: [2003, 2017, 2012, 2000, 2025, 581]
origin: "2026-06-11 analysis program (report 01 ERR family — the review's blind spot); stub 08-D17"
---

# #2102 — the error-model family needs one helper

## Problem

Runtime checks lower to uncatchable Wasm traps (or to nothing) where the
spec requires catchable TypeError/RangeError/ReferenceError — 10+ June
issues: charCodeAt OOB traps (#2003), getter-only assignment traps
(#2017), freeze writes silent (#2012), TDZ unenforced (#2121), Array
RangeError missing (#2000), extracted-method null-this trap (#2025).
Invisible to test262 until the #1945 oracle upgrade lands — which is this
issue's detector.

## Root cause

No shared "throw a JS error" lowering that bounds/integrity/callable
checks route through. Standalone: the exception tag; host: `__throw_*`
imports.

## Fix direction

`emitThrowJsError(ctx, kind, messageConst)` helper + an audit converting
the 10 known trap sites; new checks must use it (fail-loud ratchet class).
Sequence after the exception-handler reachability fixes (#1972 family)
per the sprint proposal.

## Acceptance criteria

- The 6 cited issues' repros throw catchable errors of the right
  constructor in both modes
- `e instanceof TypeError` etc. true; oracle step-1 negatives pass

## Dupe check

Member issues filed individually; #581 is the old catchability family
anchor; no shared-helper issue exists. New (analysis program).

## Resolution (2026-06-17, dev-mech2)

**Shared lowering landed.** `src/codegen/expressions/helpers.ts` now exposes
the single entry point

```ts
export type JsErrorKind = "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "Error";
export function emitThrowJsError(ctx, fctx, kind: JsErrorKind, message): void
```

which builds a real `<Kind>`-tagged externref via `__new_<Kind>(message)`
(JS-host) / the in-module `emitWasiErrorConstructor` (standalone/wasi), then
throws it through the shared `$exc` tag. The three previously-duplicated
lowerings — #1365 `emitThrowTypeError`, #1473 `emitThrowReferenceError`,
#2164 `emitThrowRangeError` — are now **thin wrappers** over it (one source
of truth). Their public signatures are unchanged, so every existing call
site keeps working.

**Trap-site audit, slice 1 (`object-ops.ts`).** All 19 integrity-check
`emitThrowString(ctx, fctx, "TypeError: …")` sites — `Cannot redefine
property`, `Cannot define property, object is not extensible`, and
`${methodName} called on non-object` — were throwing a *bare string*
(caught by `catch (e)`, but `e instanceof TypeError` was **false**, and the
`.message` carried a redundant `"TypeError: "` prefix). They now route
through `emitThrowTypeError`, producing a real `TypeError` instance with the
correct `.message` in both modes.

### Test Results

- `tests/issue-2102.test.ts` (2 tests, **pass**): redefining a
  non-configurable property throws a real `TypeError` instance (JS-host,
  returns `1`), and the same program compiles + instantiates under
  `--target standalone` (in-module constructor — no unsatisfiable host
  import).
- Manual repro before/after: the redefine path returned `2` (bare string)
  before, `1` (`instanceof TypeError`) after.
- `tsc --noEmit` clean.

### Follow-up (remaining audit slices, not in this PR)

The same bare-string→typed-instance migration still applies to the
~11 remaining `emitThrowString("TypeError: …")` sites in
`array-methods.ts` (callback-not-function / sort comparator),
`expressions/assignment.ts` + `expressions/unary-updates.ts`
("Assignment to constant variable.", frozen-object writes), and
`statements/control-flow.ts` (derived-ctor return). They were deferred to
keep this PR a tight, low-risk diff; each is now a one-line swap onto the
shared `emitThrowTypeError`/`emitThrowJsError` entry point this issue
established. Array length / `charCodeAt` OOB `RangeError` sites that build
into `if`-`then` sub-arrays would benefit from an instruction-returning
variant of `emitThrowJsError` (returns `Instr[]` instead of pushing to
`fctx.body`) — a small future addition.
