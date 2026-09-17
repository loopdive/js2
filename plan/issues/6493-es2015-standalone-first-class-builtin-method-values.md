---
id: 6493
title: "ES2015 standalone: a first-class builtin method value refuses instead of working (Function.prototype.call and friends)"
status: ready
sprint: current
created: 2026-09-17
updated: 2026-09-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/fable-es2015
model: opus
# 2026-09-17 (#6493 S1): +12 lines in the `makeGlue` god-file. The Function
# family's `emitMemberBody` ladder and its `memberIsVariadic` predicate both
# live there and are the ONLY hooks by which a native-proto member body can be
# wired; the body itself is a new module (`src/codegen/function-proto-call-apply.ts`,
# ~250 lines), so what lands in the god-file is one import plus the two arms
# that dispatch to it — the same shape as the `emitFunctionProtoToStringBody`
# arm immediately above.
loc-budget-allow:
  - src/codegen/array-object-proto.ts
---

# A first-class builtin method value refuses instead of working

Reading a builtin prototype method as a **value** and then calling it — the
`Function.prototype.call.call(f, thisArg)` shape, and every
`<builtin>.prototype.<m>` grabbed off the prototype rather than invoked at a
static call site — throws
`TypeError: <key> is not yet implemented in --target standalone`.

The refusal is not per-method. `builtin-value-read.ts:1747` is a **generic
fallback**: any first-class builtin method value that reaches that arm without
a body gets the degrade-to-catchable TypeError. So a method that is perfectly
well implemented at a static call site has no first-class value at all.

## Measured (standalone baseline fetched 2026-09-16 10:46 UTC)

Two error families, 30 ES2015 rows between them, plus 3 more inside the #6484
acceptance set that fail for exactly this reason:

| refusal | rows |
| --- | --- |
| `Function.prototype.call is not yet implemented` | 17 |
| `Object.prototype.toString is not yet implemented` | 13 |

The 17 are not all about `Function.prototype.call` being interesting in itself —
they are rows whose harness reaches a builtin method through a value. The
clusters: `built-ins/Error/prototype/stack/*` (5), `built-ins/Object/prototype/toString/symbol-tag-*` (5),
`built-ins/TypedArray*` (5), `built-ins/Promise/executor-function-prototype.js`,
`built-ins/Function/prototype/Symbol.hasInstance/this-val-not-callable.js`.

## Implementation Plan

### S1 — give `Function.prototype.call` and `.apply` real first-class bodies

1. Find where `builtin-value-read.ts` dispatches a first-class builtin method
   value (the chain ending at the `genericThrowBody` arm, line ~1747). Add an
   arm for `Function.prototype.call` and `Function.prototype.apply` BEFORE that
   fallback, modelled on the `Math` arm immediately above it
   (`emitMathValueReadBody`), which is the existing example of a family that
   mints its own kernel late.
2. The body is §20.2.3.3 / §20.2.3.1: take the receiver as `this`, the first
   argument as the new `this`, and forward the rest. The standalone lane already
   has a closure-apply substrate (`__apply_closure` / the closed-struct
   dispatchers); route through it rather than inventing a second ABI. A
   non-callable receiver throws a catchable TypeError, never a trap.
3. Arity: `call.length` is 1, `apply.length` is 2, both non-writable,
   non-enumerable, configurable, and `name` is `"call"` / `"apply"`. Several
   target rows read exactly this metadata.

### S2 — `Object.prototype.toString` as a value

The class-tag classifier exists (`object-proto-tostring-native.ts`); what is
missing is the first-class value that reaches it. Wire the value read to the
same helper the static call site uses, so
`Object.prototype.toString.call(x)` and a bare `Object.prototype.toString`
handed to `verifyProperty` both answer. Watch the receiver rules: §20.1.3.6
answers `[object Undefined]` / `[object Null]` for those two receivers rather
than throwing.

### S3 — only if S1 and S2 are green and measured

Audit which other `<builtin>.prototype.<m>` values still hit the generic arm.
Report the list with row counts rather than implementing them all; this lane
should not become a sweep.

## Acceptance

Rows, `COMPILER_POOL_SIZE=2 npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone`,
against a base tree built from the merge-base in its own worktree:

- S1: the 17 `Function.prototype.call` rows, and the three `Function.prototype.call`
  rows inside `built-ins/ArrayIteratorPrototype/next/*`.
- S2: the 13 `Object.prototype.toString` rows.

Controls, 0 lost: `built-ins/Function/prototype`, `built-ins/Object/prototype`,
`built-ins/Error/prototype`, `built-ins/TypedArray/prototype`,
`built-ins/Reflect`, `language/expressions/call`.

## Hazards

- **The generic arm is a load-bearing safety net.** It turns an unimplemented
  builtin into a catchable TypeError instead of a trap. Do not remove or widen
  it — add arms before it.
- **A refusal that becomes a wrong answer is worse than the refusal.** If a
  shape cannot be implemented correctly, leave it refusing and say so.
- Host and gc output must be byte-identical; this lane is standalone/wasi only.
  Prove it on a corpus with sha256 rather than asserting it.
- Execute each new site twice on different arms — a late-minted kernel cached in
  a global must initialise its result local on every execution, not only the
  first.

## Validation required before the PR

TS7 typecheck, lint, prettier; the five source-ratchet gates bare and with
`LOC_GATE_BASE=origin/main`; the compiler-boundaries inventory (a new module
must be classified in `scripts/compiler-boundaries.json` — this gate has caught
two lanes this session); the equivalence gate; and a pin file
`tests/issue-6493-first-class-builtin-method-values.test.ts` asserting, on
standalone with `result.imports` `[]`: `Function.prototype.call` invoked through
a value, its `length` and `name`, the non-callable receiver TypeError, and
`Object.prototype.toString` through a value including the undefined and null
receivers. Growth allowances go in this frontmatter with a dated rationale,
never in `scripts/*-baseline.json`.
