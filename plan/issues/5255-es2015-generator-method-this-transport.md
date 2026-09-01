---
id: 5255
title: "ES2015 standalone: preserve generator method receiver context"
status: in-progress
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
---

# #5255 — Preserve generator method receiver context

## Problem and locked evidence

The authoritative isolated standalone runner still fails:

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
