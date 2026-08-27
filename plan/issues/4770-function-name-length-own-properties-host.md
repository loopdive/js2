---
id: 4770
title: "Compiled functions have no own `name` or `length` property (ES2015, ~85 rows)"
status: ready
sprint: current
created: 2026-08-27
updated: 2026-08-27
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: es6
language_feature: function-properties, descriptors
goal: core-semantics
related: [2175, 4265, 1632]
origin: "ES2015 failure bucketing against the merged baseline, 2026-08-27"
---

# #4770 — compiled functions have no own `name` / `length`

## What is confirmed

Every compiled function shape is missing BOTH own properties, and the accessor
reads fall back to wrong values rather than throwing — so the gap is silent.
Measured on current `main` through the runner's own `wrapTest` (probe reads the
descriptor and reports it via `Test262Error`, so the runner's verdict is the
evidence):

| shape | `getOwnPropertyDescriptor(f, "length")` | `f.length` |
| --- | --- | --- |
| `function* (x) {}` | MISSING | 0 |
| `function* g(a, b) {}` | MISSING | 0 |
| `{ m(a,b,c) {} }.m` | MISSING | 0 |
| `function plain(a, b) {}` | MISSING | 0 |
| `(a) => {}` | MISSING | 0 |
| `class C { m(a, b) {} }` (proto method) | MISSING | 0 |

`name` is the same, and worse in one case:

| shape | `getOwnPropertyDescriptor(f, "name")` | `f.name` |
| --- | --- | --- |
| `function plain(a,b) {}` | MISSING | `undefined` |
| `var anon = function () {}` | MISSING | `undefined` |
| `const cg = function* () {}` | MISSING | `undefined` |
| `{ m(a) {} }.m` | MISSING | `undefined` |
| `class C { m() {} }` (proto method) | MISSING | `undefined` |
| `class C {}` (the class itself) | `w=true e=true c=true` | `"C"` |

Spec (§20.2.4.1 / §20.2.4.2, via SetFunctionName / SetFunctionLength) requires
`{ writable: false, enumerable: false, configurable: true }` for both. The class
row is the only one that HAS `name`, and all three of its attributes are wrong.

## Blast radius

**~85 ES2015 rows** in the merged baseline, all reporting one of two shapes:

- `name descriptor value should be X; name value should be X; name descriptor
  should not be writable; …` — **66 rows**
- `length descriptor should not be writable; length descriptor should be
  configurable` (and, where the arity is also read, `length descriptor value
  should be N`) — **19 rows**

Distribution of the `name` family:
`language/expressions/assignment` 19 · `language/statements/for-of` 14 ·
`language/expressions/object` 12 · `const`/`let`/`variable` 15 ·
`language/statements/class` 2 · plus singletons in `generators`,
`GeneratorFunction/name.js`, `function`.

Not counted above: an unknown further share of the generic
`Expected SameValue(«X», «X»)` bucket (504 rows) and the 11-row
`Cannot convert undefined or null to object [in verifyProperty()]` bucket, which
is `verifyProperty` choking on a missing descriptor — e.g.
`built-ins/ArrayIteratorPrototype/next/name.js`. So ~85 is a FLOOR, not the
total.

## Why it is not a small fix — the specific blocker

The machinery to COMPUTE both values already exists and is already spec-correct.
`src/codegen/expressions/calls.ts` has `resolveStaticFunctionName` (including the
NamedEvaluation rule that a named function expression's inner name wins) and
`resolveStaticFunctionLength` → `countSpecLength` (§20.2.4.2: formals before the
first default/rest/destructured parameter). Both were written for #1632a and are
used ONLY to bake `nameHint`/`lengthHint` into a `__bind_function` call site.

What is missing is a way to get that per-function metadata to a RUNTIME value.
Three facts bound the design:

1. **`ClosureInfo` carries no source identity.** `src/codegen/context/types.ts:348`
   has `structTypeIdx`, `funcTypeIdx`, `returnType`, `paramTypes` and a handful
   of booleans — no name, no declaration node. So nothing downstream can recover
   which source function a closure came from.
2. **`__closure_arity` is TYPE-granular, not per-function.**
   `collectClosureArityEntries` (`closure-exports.ts:1721`) dedupes by
   `funcTypeIdx` and dispatches with a `ref.test` chain, because arity is a
   property of the signature. Two source functions with the same signature are
   indistinguishable through it — which rules it out for `name` outright, and
   makes it wrong for `length` exactly where the failing rows live (a default
   parameter changes spec length but not wasm arity: `function* (x = 42) {}` must
   report `length === 0`).
3. **The read-back path is ready for it — for CLOSURES, and only for closures.**
   `_readOwnDescriptor` (`src/runtime.ts:5894`) is the single source for both
   `Object.getOwnPropertyDescriptor` and `getOwnPropertyDescriptors`, and already
   has per-shape arms (vec, sidecar, class proto-/static-method allowlists with
   spec flags at 2a/2b). **Verified by instrumentation:** a
   `getOwnPropertyDescriptor(f, "name")` on a compiled closure DOES reach it —
   all five function shapes in the first table hit the arm — so a closure arm
   placed just before step 3 is a confirmed insertion point once the metadata
   exists.

   **The class object does NOT reach it.** The same instrumented run shows the
   `class C {}` read never enters `_readOwnDescriptor` at all; its descriptor is
   produced somewhere else (the `_wrapForHost` mirror / proxy path around
   `runtime.ts:7954`, where `Object.defineProperty(fnTarget, "name", …)` already
   passes spec-shaped attributes). So the class row and the closure rows need
   TWO different insertion points, and the class one has to be located first.

   An arm keyed on `_classNamesByObj` was written and measured against this: the
   class descriptor was unchanged (`w=true e=true c=true`), and the probe showed
   `registered=false` for every receiver that did arrive. Reverted. Do not
   re-attempt it from `_classNamesByObj` in `_readOwnDescriptor` — find the
   mirror path instead.

## Candidate designs (none evaluated — pick one deliberately)

- **A. Registration import at closure creation** — mirrors the existing
  `__register_class_ctor(classObj, ctorClosure, …, className)`
  (`runtime.ts:12079`), which already carries a NAME per class object. Precedent
  exists and the runtime side is a WeakMap. Cost: a host call per closure
  ALLOCATION, so a closure created in a loop pays it every iteration — and it is
  a host import, so standalone needs its own answer.
- **B. Per-closure-struct-type dispatch** — a `__closure_meta(externref) -> i32`
  export shaped like `__closure_arity` but dispatching on the CLOSURE STRUCT type
  index (`ctx.closureInfoByTypeIdx` is keyed that way) rather than `funcTypeIdx`.
  Per-function only if distinct source functions reliably get distinct closure
  struct types — **verify that first; the whole design rests on it.**
- **C. Fields on the closure struct** — exact and lane-neutral, but changes every
  closure's layout and allocation cost.

All three need `ClosureInfo` (or its registration sites) to start carrying the
source name and `countSpecLength`, which is the cross-cutting part of the work.

## Implementation Plan

1. Settle the design question in fact 2/B above: dump `ctx.closureInfoByTypeIdx`
   for a module with several same-signature functions and check whether the
   closure STRUCT type indices differ. That single measurement chooses between B
   and A/C.
2. Thread source name + `countSpecLength(decl.parameters)` into `ClosureInfo` at
   every registration site. Reuse `resolveStaticFunctionName` /
   `countSpecLength` — do not write a second implementation of §20.2.4.2.
3. Emit the chosen lookup, and add the closure arm to `_readOwnDescriptor` plus
   the matching `[[Get]]`/`ownKeys` paths so `f.name`, `f.length`,
   `getOwnPropertyDescriptor`, and `Object.keys`-style enumeration all agree.
4. Fix the class case separately — it is the one shape that HAS `name`, with all
   three attributes wrong (`w=true e=true c=true` vs spec `false/false/true`).
   It is independently verifiable, but it is NOT the cheap warm-up it looks like:
   see fact 3 — the class descriptor does not come from `_readOwnDescriptor`, and
   the obvious `_classNamesByObj` arm there has already been tried and reverted.
   Start by locating which path actually answers that read.
5. Re-measure with `scripts/run-test262-paths.mts --isolate` over the two
   families before and after.

## Acceptance criteria

- [ ] Every shape in both tables above reports `{w:false, e:false, c:true}` with
      the spec value
- [ ] `function* (x = 42) {}` reports `length === 0`; `function* (x, y = 42) {}`
      reports `1` (the default-parameter case the wasm arity cannot express)
- [ ] The 66-row `name` family and 19-row `length` family pass
- [ ] No regression in the existing `.name`-read fast paths — the compile-time
      `.name` static resolver (`property-access.ts`) and the #1632a
      `__bind_function` hints must keep agreeing with the new own property
- [ ] Standalone lane stated explicitly: fixed, or refused cleanly (#680)

## Notes

Reproduce any row in this issue with a test262-shaped probe under `.tmp/` run
through `runTest262File` — the runner's `wrapTest` is what makes `verifyProperty`
and the `Test262Error` channel available, and judging by anything else is how
#4764 shipped a regression.
