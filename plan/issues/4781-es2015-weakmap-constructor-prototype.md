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

The fresh assembled-harness baseline on `upstream/main` was 1 failure and 6
passes in each lane. The target failed in host mode with a non-identical
function object and in standalone mode with `null` versus `[object Function]`.
The six selected controls all passed in both lanes:
`prototype/prototype-attributes.js`, `no-iterable.js`, `length.js`,
`is-a-constructor.js`, `prototype/set/set.js`, and `prototype/has/has.js`.

Baseline artifacts (exact seven-file list, assembled official harness):

```text
.tmp/4781-baseline-host.jsonl       sha256 6db1782989d965a4df054e488d6c9aeae438ce1557c31e6b45cf91c885a838b2
.tmp/4781-baseline-standalone.jsonl sha256 ab0e49808672eae112a55c40d2523906a359fbcc7b4aa3f8ea05c7ab6f9d0ecc
```

The authoritative standalone acceptance target is one pass with zero
failures, compile errors, timeouts, or skips.

## Root-cause hypothesis

The static `Object.getPrototypeOf` lowering recognized the ES5 constructor set
but not the ES2015 `WeakMap` constructor. The later native-collection path is
for WeakMap instances, so it returned the wrong opaque/null value when asked
about the constructor object. The existing native WeakMap collection
operations are not part of this issue.

## Implementation plan

1. Reproduce the exact row on the current upstream baseline in both host and
   standalone lanes, inspect the generated constructor/prototype path, and
   identify the narrowest existing builtin-constructor identity hook.
2. Route only a global `WeakMap` constructor identity query through the
   compiler-owned `%Function.prototype%` singleton, preserving the existing
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

Implemented in `src/codegen/expressions/object-get-prototype-of.ts` with the
focused regression `tests/issue-4781-weakmap-constructor-prototype.test.ts`.
The branch keeps the guard on `isGlobalBuiltinIdentifier`, so a local or
captured `WeakMap` binding cannot use this intrinsic shortcut.

Exact post-fix A/B (same seven-file list and assembled harness):

```text
.tmp/4781-after-host.jsonl       sha256 c653a824bdee14ffb06e71102bf18cca86b0e22917d23c629150b2cabd39ce5e
.tmp/4781-after-standalone.jsonl sha256 36811f35f37ebccbd6fb202cdcf373f0c4ad7e8b7bfb282e72c26c633c1a8427
```

Both lanes changed from `{"fail":1,"pass":6}` to `{"pass":7}`. The
`--diff` partitions each lane as `fail -> pass: 1`, `pass -> fail: 0`,
`other: 0`, `unchanged: 6`; the only gained row is
`prototype-of-weakmap.js`. Determinism checks report 0 disagreements in both
lanes. The focused Vitest suite passes 14/14 (target plus six controls in host
and standalone). TypeScript, lint, formatting, and issue-integrity gates pass.

Handoff: commit `45c857703` is pushed on
`ttraenkler/js2:codex/es2015-next-bounded-fix-5`, merged with the current
`upstream/main` tip `7edc857f1`. Upstream PR
[#5074](https://github.com/loopdive/js2/pull/5074) targets `loopdive/js2:main`
with the required description and checked CLA. It is currently draft while
the initial CI run establishes green mergeability; mark it ready once those
checks are green. Keep the final authoritative 11,704-row standalone run as
the umbrella handoff.

The first upstream quality run exposed a test-harness-only tier mismatch:
`JS2WASM_EVAL_ENGINE=interpreter` selects the intentional refusal provider,
while every assembled Test262 row contains the `$262.evalScript` shim and
therefore needs the runtime-eval import at link time. The compiler fix itself
and all other 13 focused cases passed. Commit `e49619dac` adds the
interpreter-tier direct, host-free predicate fallback; the exact assembled
target remains exercised under the authoritative QuickJS provider. The exact
changed-root command now passes 14/14 under the interpreter refusal tier, and
the QuickJS focused suite passes 14/14.

Do not claim the ES2015 edition complete from this one-row result; the
umbrella's final 11,704/11,704 authoritative run remains required.
