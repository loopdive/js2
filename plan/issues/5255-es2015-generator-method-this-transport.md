---
id: 5255
title: "ES2015 standalone: preserve generator method receiver context"
status: done
sprint: current
created: 2026-09-01
updated: 2026-09-01
completed: 2026-09-01
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: conformance
area: codegen, generators, calls
es_edition: ES2015
goal: standalone-mode
assignee: ttraenkler/codex-gen-method-this-terra-20260901
related: [3591, 4168, 5147]
origin: "Post-#3591 exact Test262 validation: obj.g() drops both the native generator state carrier and the deferred dynamic receiver context."
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/generators-native.ts
func-budget-allow:
  - src/codegen/generators-native.ts::registerNativeGenerator
  - src/codegen/generators-native.ts::ensureNativeGeneratorResumeFunction
---

# #5255 — Preserve generator method receiver context

## Problem and locked evidence

Before the repair, the authoritative isolated standalone runner failed:

- `built-ins/GeneratorPrototype/next/context-method-invocation.js`

The exact source invokes a generator declaration through an object property,
resumes the returned iterator, and requires the generator body's `this` to be
the original object:

```ts
var context;
function* g() {
  context = this;
}
var obj = { g: g };
var iter = obj.g();
iter.next();
assert.sameValue(context, obj);
```

Read-only tracing on the #3591 candidate found two sequential gaps:

1. `obj.g()` crosses the standalone callable-property result bridge. The
   checker-declared `Generator` result maps to `externref`, while the native
   factory returns a concrete `$GenState_g` ref. The bridge rejects or erases
   that ref-to-external transport, so the subsequent `.next()` misses the
   native-state brand before the body resumes.
2. Even after state transport is repaired, a generator call defers execution.
   Its property-call receiver must be captured at factory invocation and
   restored as dynamic `this` when the generator body resumes. Current
   object-literal receiver recognition excludes generator declarations.

This is separate from #3591's completed late-registration repair: the final
dispatch can recognize the type only if the property call preserves it, and
recognizing the state alone cannot reconstruct the required receiver. No
GitHub issue was created. ID 5255 was allocated and claimed atomically on
`upstream/issue-assignments`.

## Pre-change trace (locked)

The minimal standalone fixture keeps the Test262 shape while making both
boundaries observable:

```ts
let context: any = null;
let calls = 0;
function* g() { context = this; calls++; }
const obj = { g: g };
export function test(): number {
  const iter: any = obj.g();
  const deferred = calls === 0 ? 100 : 0;
  iter.next();
  return deferred + (context === obj ? 1 : 0);
}
```

It compiles with no imports but traps at `.next()` before the fix. The emitted
callable-property ladder invokes the concrete native factory (a
`(ref $__GenState_g)` result) and then emits the loss directly:

```wat
call_ref $g
drop
ref.null extern
```

The opaque `.next()` consumer consequently sees `externref(null)` rather than
the native state and rejects it at its `$__GenState_g` brand test. The completed
#3591 late-filled dispatcher itself is correct: its native-state arm casts the
concrete state, calls `__gen_resume_g`, and exports the result through
`extern.convert_any`. The loss is strictly before that dispatcher.

After manually following the receiver path, the detached resume function reads
`global.get $__current_this`; its state struct has only frame headers and
params/spills, with no receiver field. The `g: g` property assignment is
currently refused by `objectLiteralMethodNeedsReceiver` because the referenced
`FunctionDeclaration` carries `asteriskToken`. Even admitting the call-site
install alone would restore the global before `.next()`, so the factory must
capture the resolved dynamic receiver in the native frame and the resume
context must expose it as the body's local `this`.

## Repair trace (verified)

The two boundaries are repaired independently and remain fail-closed:

1. `callablePropertyRefBridge` now permits an `extern.convert_any` result only
   in standalone/WASI when the concrete `ref` is a `stateTypeIdx` already
   registered in `ctx.nativeGenerators` and the declared result is an erased
   external carrier. Arbitrary struct results still refuse the crossing, and
   this arm never converts an external input into a native state.
2. A free `FunctionDeclaration` native generator that owns a dynamic `this`
   gets an immutable `dynamic_this: externref` frame field. The factory snapshots
   the property-call receiver before the caller restores `__current_this`; the
   resume function loads that field into its local `this` before compiling any
   body expression. `NativeGeneratorInfo.capturesDynamicThis` records the ABI
   explicitly: inferring it from `paramNames` would confuse TypeScript-only
   `this` parameters and leading closure/TDZ capture slots with a call receiver.
3. The object-literal receiver planner admits exactly a named native-generator
   declaration reference in the existing property-assignment and computed-key
   paths. Ordinary function expressions retain their existing path; arrows,
   non-generator declaration references, and unknown/dynamic function values
   remain excluded.

Post-fix standalone WAT for the reduction has a
`$__GenState_g` field `(field $dynamic_this externref)`. Its factory obtains
the current receiver before `struct.new`; `__gen_resume_g` begins with a
`struct.get` of frame field 5 into `(local $this externref)`. At the property
result boundary the selected concrete factory arm now ends:

```wat
ref.cast (ref <native-generator-factory-type>)
call_ref <native-generator-factory-type>
extern.convert_any
```

where the numeric factory type index is module-local. This replaces the locked
pre-fix `drop` / `ref.null extern` loss without broadening the bridge.

## Focused validation (pre-push)

- The authoritative isolated standalone command
  `JS2WASM_ROW_ONE='built-ins/GeneratorPrototype/next/context-method-invocation.js' node --import tsx scripts/run-test262-paths.mts --standalone`
  reports `ROW pass` (1/1) on the #3591 substrate.
- `tests/issue-5255.test.ts` passes 4/4: the exact Test262 shape remains
  deferred until `.next()`, preserves object identity, has zero Wasm imports,
  evaluates a receiver base and a computed property key once, carries lexical
  arrow `this`, and returns the expected marker through the host-runtime lane.
- Focused #3591/native-generator/expression-generator/call-boundary controls
  pass. The #4025 ordinary `.call`/`.apply` file has 14 passing cases and three
  known nullish-receiver failures; the same three failures reproduce unchanged
  on a clean `b603a4da69` (#3591) baseline. They predate this repair and are
  out of #5255 scope, so no change was made to their lowering.
- TS7 typecheck, targeted Biome lint, targeted Prettier, oracle/coercion
  ratchets, and LOC/function budgets pass. The two budget grants above cover
  the deliberate native frame/resume ABI and the narrow callable result bridge;
  no baseline file is changed.

Fresh process/memory census was taken before each compiler, Vitest, or Test262
process tree. The normal pre-push hook passed TS7 typecheck, lint, format,
oracle/coercion ratchets, 18/18 numeric-local parity, and issue integrity;
`5890005e858772ae0b11999f964b83e063b81427` was then published to the fork.

## Completion and handoff

The completed implementation is commit
`5890005e858772ae0b11999f964b83e063b81427`
(`fix(generators): preserve property receiver across native resumes ✓`) on
draft PR #5407. It is intentionally stacked on #5402's #3591 late-dispatch
substrate: keep the PR draft until that dependency is merged and the stack is
dependency-clean. Luna owns the ready-for-review transition after that handoff.

## Implementation plan

1. Add `tests/issue-5255.test.ts` covering the exact declaration/property-call
   shape in standalone. Prove that the body is still deferred until `.next()`,
   that `this` is the exact receiver object, that receiver/property evaluation
   happens once, and that the module has zero compiler/Wasm/host imports.
2. Trace `obj.g()` through property resolution, callable bridge construction,
   generator factory invocation, state allocation, and resume. Record the
   concrete result and receiver ValTypes plus the precise drop sites in this
   issue before editing production code.
3. Repair the callable-property result transport narrowly for a proven native
   generator result. Use the existing Wasm GC `anyref`/`externref` conversion
   discipline; do not broadly coerce arbitrary reference results or admit host
   values to native GeneratorValidate.
4. Extend the native generator state/factory ABI to retain the dynamic method
   receiver when the call is a property reference, then restore it for the
   generator body's `this`. Preserve ordinary `g()` semantics, detached calls,
   explicit `.call`/`.apply`, strict/sloppy behavior, arrows, and non-generator
   method calls. The base and property key must each be evaluated exactly once.
5. Run the exact Test262 row with the authoritative isolated standalone runner
   on a tree containing #3591. Run #3591's original acceptance suite, generator
   declaration/expression controls, ordinary method-`this` controls including
   #4168, detached-call controls, and a host/GC lane control. Run typecheck,
   focused lint/format, issue integrity, source ratchets, and normal pre-push.

## Acceptance criteria

- The exact `context-method-invocation.js` row passes in isolated standalone.
- `obj.g()` returns a resumable native generator whose body observes `obj` as
  `this` only when resumed.
- Receiver and property expressions are evaluated exactly once.
- Direct/detached generator calls, `.call`/`.apply`, non-generator calls,
  generator brand checks, and host/GC behavior do not regress.
- Generated standalone modules remain host-free with zero new imports.
- The issue records exact before/after evidence, the two repaired boundaries,
  focused validation, and the final commit.

## Dependency and handoff

The exact state-brand symptom is observable on #3591 / PR #5402's late-filled
dispatcher candidate. Implementation may be developed as a temporary stack on
that head, but the final PR must target `loopdive/js2:main`, contain only
#5255's completed fix after dependencies land, and remain draft while it is
dependency-blocked or otherwise not mergeable.
