---
id: 5255
title: "ES2015 standalone: preserve generator method receiver context"
status: done
sprint: current
created: 2026-09-01
updated: 2026-09-01
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
  - src/codegen/expressions.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/generators-native.ts
  - src/codegen/object-literal-method-receiver.ts
  - src/codegen/function-body.ts
  - src/codegen/helpers/body-references-own-this.ts
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

## Initial checkpoint and corrective-review handoff

The initial implementation is commit
`5890005e858772ae0b11999f964b83e063b81427`
(`fix(generators): preserve property receiver across native resumes ✓`) on
draft PR #5407. It remains intentionally stacked on #5402's #3591 late-dispatch
substrate, but independent Terra review and exact-head CI found blockers before
readiness. The issue is reopened; do not mark the PR ready until every item in
the corrective plan below is implemented and revalidated.

### Locked review and CI blockers

1. **Dynamic computed-key admission is unsafe and must be withdrawn in this
   slice.** The new generator arm in `planDynamicElementReceiverBind` installs
   the eventual method receiver before the key/callee is evaluated. A strict
   `key()` helper that reads its own `this` therefore sees `obj`, and a throwing
   key can leave `__current_this` stale after the exception is caught. The
   pre-existing function-expression path documents the same unwind limitation,
   but #5255 newly exposed generator declarations to it. Static `obj.g()` and a
   statically resolved element key remain in scope; arbitrary dynamic element
   keys do not become receiver-aware in this fix.
2. **Parameter-initializer `this` is a distinct call-time use.** The current
   predicates scan only `decl.body`. In
   `function* g(x = this === obj ? 7 : 9) { yield x; }`, the default runs during
   factory invocation, before the deferred frame exists. Receiver installation
   and `readsCurrentThis` must include own-`this` parameter initializers, while
   the persistent `dynamic_this` frame field remains required only when the
   deferred body itself reads `this`.
3. **The implementation introduced an initialization cycle.** Exact head
   `3cbf88f117af09f7e17a11559080dfb33a7c595c` fails `CI / quality` in run
   `33489746460`, job `99798164647`: both IR allocation suites abort before any
   test with `TypeError: Cannot read properties of undefined (reading 'MAP')`
   at `src/codegen/collections-brand.ts:100`, reached from the eager import at
   `src/codegen/expressions/calls.ts:36`. The new
   `generators-native.ts -> expressions/this-keyword.ts` edge closes a cycle
   through identifier/index/expression modules. Receiver snapshotting must move
   to a dependency-light seam or otherwise remove that eager edge; no CI suite
   may rely on import order.

### Corrective implementation plan (required before ready)

1. Add red focused controls for: strict dynamic `key()` reading `this`, a
   throwing dynamic key followed by a receiver-sensitive call, a generator
   parameter default reading `this`, and a body+default combination with
   `arguments`, user params, and spills. Record pre-fix outcomes in this issue.
2. Remove generator-declaration admission from
   `planDynamicElementReceiverBind`; keep the proven static property and
   statically resolved element-access paths. Replace the current dynamic-key
   positive regression with negative/no-new-admission controls so #5255 does
   not widen the documented exception-unwind hazard.
3. Split receiver demand into call-time parameter-initializer use and deferred
   body use. The object-literal planner installs a receiver when either applies;
   the generator frame stores `dynamic_this` only for deferred body use. Ensure
   parameter-default evaluation sees the installed receiver without shifting
   frame offsets unnecessarily.
4. Remove the eager `compileThisKeyword` import from `generators-native.ts`.
   Reuse or extract the minimum receiver-snapshot ladder in a dependency-light
   module, preserving strict/sloppy direct and detached calls, null markers,
   typed/synthesized method `this`, and host/standalone parity. Add a cold
   module-import/IR allocation test that reproduces the exact CI failure.
5. Re-run the exact Test262 row, the expanded #5255 matrix, #3591, native
   generator declarations/expressions, #4025 controls on both clean parent and
   candidate, the two previously failing IR allocation suites, typecheck,
   lint/format, ratchets, issue integrity, normal hooks, and exact-head CI.
6. Only after those gates pass, restore `status: done`, record final SHAs and
   evidence, sync the exact #5402 parent if needed, update the PR body, and let
   Luna re-evaluate readiness.

## Wrap-up handoff (2026-09-01)

Work is intentionally stopped at draft PR #5407 on branch
`codex/es2015-generator-method-this-terra-20260901`. The published code head is
`3cbf88f117af09f7e17a11559080dfb33a7c595c`; it contains the initial fix,
completion-evidence checkpoint, and an exact merge of #5402 head
`7380a1694b3fba806232f571ea3356b899d7a8e6`. Do not mark the PR ready: the
dynamic-key review findings and the `collections-brand.ts:100` module-cycle CI
failure above make this head non-mergeable despite the focused Test262 row and
local pre-push gates passing.

The next owner should start from this branch, implement the corrective plan in
order, and keep the dynamic computed-key generator path withdrawn unless it can
prove key evaluation and exception-safe receiver restoration. The last known
good focused evidence remains exact Test262 1/1 and #5255 4/4, but that evidence
does not supersede the cold-import CI failure or the static P1/P2 review. No
GitHub issue was created; this file is the canonical tracker and handoff.

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

## Corrective completion evidence (2026-09-01)

The corrective plan is complete after merging upstream `main`
`dc29e1f15d`. Generator declarations are no longer admitted by the runtime-key
receiver planner; static property and statically resolved element calls retain
receiver transport. Receiver demand now includes parameter initializers at
call time, while the native frame stores `dynamic_this` only when the deferred
body reads it. The `generators-native.ts -> expressions/this-keyword.ts`
initialization edge now uses the shared late-bound delegate pattern, preserving
the full receiver ladder without closing the collections import cycle.

Focused controls pass: `tests/issue-5255.test.ts` 8/8, including strict dynamic
key evaluation, throwing-key restoration, parameter-default `this`, and the
combined body/default/arguments/params/spills layout. The two cold-import IR
allocation suites pass 16/16, and the authoritative standalone Test262 row
`built-ins/GeneratorPrototype/next/context-method-invocation.js` passes 1/1.
No host-import, baseline, or hold bypass was added.
