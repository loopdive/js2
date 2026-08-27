---
id: 4781
title: "ES2015 standalone WeakMap constructor prototype identity"
status: in-progress
created: 2026-08-27
updated: 2026-08-27
priority: medium
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: weakmap
es_edition: 2015
goal: standalone-mode
sprint: current
assignee: "ttraenkler/es6-next-bounded-fix-5"
related: [2162, 4740]
loc-budget-allow:
  - src/codegen
  - tests
---

# #4781 — ES2015 standalone `WeakMap` constructor prototype identity

## Scope and baseline

This issue owns one exact official ES2015 Test262 row:

```text
test/built-ins/WeakMap/prototype-of-weakmap.js
```

The row checks the ES2015 requirement that `Object.getPrototypeOf(WeakMap)` is
the intrinsic `Function.prototype`. It is deliberately separate from the
nearby `WeakMap` constructor iterable/adderr protocol row
(`set-not-callable-throws.js`), which has a different root cause and is out of
scope. It is also separate from the active Map/Set iterator-tag,
ArrayBuffer.isView, class-name, and yield-star residuals.

The latest available standalone cache census classifies this row as an
assertion failure: the compiled `WeakMap` constructor's prototype is observed
as `null` instead of the host `Function.prototype`. The JS-host cache row also
fails the same identity assertion, so the host lane is retained as a
regression control rather than a completion denominator.

Before implementation, rerun this exact row through the assembled official
harness on the clean `upstream/main` baseline and record the fresh host and
standalone JSONL artifacts here. The authoritative standalone acceptance
target is one pass with zero failures, compile errors, timeouts, or skips.

## Root-cause hypothesis

The compiler's static builtin constructor materialization gives the native
`WeakMap` constructor a missing or non-identity-stable `[[Prototype]]` in the
standalone path. `Object.getPrototypeOf` therefore returns a null/opaque
carrier when the source asks for the constructor's prototype, while the host
runtime's constructor has the ordinary intrinsic function prototype. The
existing native WeakMap collection operations are not part of this issue.

## Implementation plan

1. Reproduce the exact row on the current upstream baseline in both host and
   standalone lanes, inspect the generated constructor/prototype path, and
   identify the narrowest existing builtin-constructor identity hook.
2. Repair only the `WeakMap` constructor `[[Prototype]]` materialization or
   its `Object.getPrototypeOf` observation path, preserving the existing
   standalone WeakMap `new`/`get`/`set`/`has` behavior and all other builtin
   constructor identities.
3. Add a focused regression test covering the exact Test262 row in both lanes,
   plus nearby positive controls for constructor identity and WeakMap native
   collection behavior. Assert no unrelated standalone host import is
   introduced.
4. Run the exact one-row A/B on host and standalone with at most two workers,
   prove zero losses in the controls, run the focused regression suite and
   repository gates, then update this issue with artifact paths and hashes.

## Acceptance criteria

- `prototype-of-weakmap.js` passes through the assembled official harness in
  standalone and host lanes.
- The standalone A/B is exactly one `fail` → `pass` improvement for the target
  and has zero target/control losses or new hard errors.
- Focused WeakMap controls remain green and no unrelated builtin behavior
  changes.
- TypeScript, lint, formatting, issue metadata, budget, and pre-push checks
  pass; the branch is clean and pushed to `ttraenkler/js2`.
- A separate upstream PR targets `loopdive/js2:main` with the repository's
  required `## Description` / `## CLA` body. It stays draft with `hold` only
  until the verified branch is current and mergeable.

## Implementation / evidence

To be filled as the exact baseline, implementation, and post-fix evidence are
produced. Do not claim the ES2015 edition complete from this one-row result;
the umbrella's final 11,704/11,704 authoritative run remains required.

