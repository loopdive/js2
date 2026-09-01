---
id: 5196
title: "ES2015 standalone proxy — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-09-01
priority: medium
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
pr: 5389
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

# #5196 — proxy r2: cluster and fix the residual proxy-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5140, part of PR #5173) plus the
strongest second pass of the batch (+66, PR #5213 — evolved §7.3.9
trap-callable guard, unified non-constructor meta-statics). This r2 lane starts
from the forced fresh `f841cddc0f0ea665b63700d9944a4372a34a8b57` baseline,
not from the older planning snapshot.

## Provenance and active-owner gate

- Authoritative standalone snapshot:
  `/private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/test262-standalone-current.jsonl`,
  48,735 JSONL records, timestamped `1.9.2026, 02:03:18` onward and carrying
  `oracle_version: 13`, `oracle_lane: honest`. The forced artifact is from
  immutable `loopdive/js2wasm-baselines`
  `8a39bd1d4ddf200f8db3751c878ece02aa8688fe` and has SHA-256
  `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf`.
- Edition source: `website/public/benchmarks/results/test262-file-editions.json`.
  Its `editions[6]` is `ES2015`; the query strips the baseline's `test/`
  prefix before looking up `files[path] === 6`.
- Fresh exact cohort: 310 `test/built-ins/Proxy/**` ES2015 records — 182 pass,
  115 fail, and 13 compile errors. The exact non-pass path set is the 128
  rows selected by the reproducible path/status query below; it excludes all
  non-ES2015 rows and no `pass` row.
- Active-owner check on 2026-09-01: `origin/issue-assignments` contains only
  `81b48a9e830ed2b7350c32d3740dca699c7ef8b4` (`chore(assign): reserve #5196`)
  with `status: "reserved"`, blank assignee, and blank branch; the local
  `upstream/issue-assignments` ref has no #5196 record. This is an unassigned
  reservation rather than a live conflicting owner.

```sh
rg '\"file\":\"test/built-ins/Proxy/' \
  /private/tmp/js2-baseline-census-f841cddc-r1/.test262-cache/test262-standalone-current.jsonl \
  | jq --slurpfile editions website/public/benchmarks/results/test262-file-editions.json \
      -r '(.file | ltrimstr("test/")) as $path
          | select($editions[0].files[$path] == 6 and .status != "pass")
          | [.file, .status, (.error // "")] | @tsv'
```

## Exact status/error inventory

The operation table is an exact partition of the 128 selected non-pass paths.
All omitted Proxy subtrees have zero selected rows.

| Proxy subtree | compile_error | fail |
| --- | ---: | ---: |
| apply | 1 | 5 |
| construct | 8 | 10 |
| defineProperty | 0 | 19 |
| deleteProperty | 0 | 5 |
| enumerate | 1 | 0 |
| function-prototype.js | 0 | 1 |
| get | 0 | 7 |
| get-fn-realm*.js | 2 | 0 |
| getOwnPropertyDescriptor | 1 | 13 |
| getPrototypeOf | 0 | 4 |
| has | 0 | 13 |
| isExtensible | 0 | 1 |
| ownKeys | 0 | 7 |
| preventExtensions | 0 | 4 |
| revocable | 0 | 7 |
| set | 0 | 13 |
| setPrototypeOf | 0 | 6 |
| **Total** | **13** | **115** |

The following is an exact first-stop-signature histogram, not a causal
classification. Shared error text only identifies where a row stopped; it does
not establish that those rows share a repair.

| status | observed first-stop signature | rows | representative exact paths |
| --- | --- | ---: | --- |
| fail | `Expected a TypeError ... no exception was thrown` | 50 | `construct/return-not-object-throws-undefined-realm.js`; `ownKeys/trap-is-not-callable-realm.js` |
| fail | `Expected true but got false` | 5 | `set/return-true-target-property-is-not-configurable.js`; `has/trap-is-undefined-target-is-proxy.js` |
| fail | `Thrown value was not an object!` | 4 | `defineProperty/targetdesc-not-compatible-descriptor-realm.js` |
| fail | handler receiver/context mismatch | 6 | `has/call-in-prototype.js`; `set/call-parameters-prototype.js` |
| fail | `Proxy.revocable is not yet implemented ...` | 3 | `apply/null-handler-realm.js`; `construct/null-handler-realm.js` |
| fail | `0 should be an own property` | 2 | `getOwnPropertyDescriptor/trap-is-undefined-target-is-proxy.js`; `.../trap-is-missing-target-is-proxy.js` |
| fail | object-versus-`undefined` SameValue mismatch | 2 | `deleteProperty/trap-is-undefined-not-strict.js`; `...-strict.js` |
| fail | `null` versus `undefined` SameValue mismatch | 2 | `revocable/revoke-returns-undefined.js`; `.../revoke-consecutive-call-returns-undefined.js` |
| fail | remaining paired signatures (each distinct) | 6 | false-result invariants, `TypeError` versus `ReferenceError`, and nullish property reads |
| fail | singleton first-stop signatures | 35 | descriptor, trap, target, realm, and carrier rows listed by the query above |
| compile_error | distinct-NewTarget `Reflect.construct` refusal (#3371) | 10 | `construct/call-parameters-new-target.js`; `get-fn-realm.js` |
| compile_error | dynamic-shape gOPD refusal (#1472) | 1 | `getOwnPropertyDescriptor/null-handler.js` |
| compile_error | non-array `values()` refusal (#1320) | 1 | `enumerate/removed-does-not-trigger.js` |
| compile_error | generated host imports (#2961) | 1 | `apply/trap-is-undefined-target-is-proxy.js` |

The 35 singleton count plus the grouped rows above totals 115 fails. The
signature table intentionally leaves the broad 50-row TypeError group
unclaimed; it is not evidence for one Proxy implementation change.

## Representative maintained-runner evidence

`node --import tsx scripts/run-test262-paths.mts
/private/tmp/issue-5196-proxy-representatives.txt --standalone --isolate`
ran the repository's `runTest262File` path in fresh child processes. It
reported `2 fail, 1 pass`:

- `built-ins/Proxy/revocable/revoke-returns-undefined.js` — fail at
  `assert.sameValue(r.revoke(), undefined)`, observed `null`.
- `built-ins/Proxy/revocable/revoke-consecutive-call-returns-undefined.js` —
  fail at its second `r.revoke()` assertion, observed `null`.
- `built-ins/Proxy/revocable/revoke.js` — pass; the same result record exposes
  a callable `revoke` field.

This validates both a current failing pair and a current passing control through
the maintained standalone runner, rather than inferring behavior from the
baseline alone.

## Narrow causal slice: revoker return value

The two selected rows are independently causal, not selected because their
error strings match. Both call the `__proxy_revoker` carrier through the one
Proxy-specific branch in `fillApplyClosure` in
`src/codegen/object-runtime.ts`. That branch successfully calls
`__proxy_revoke`, then returns its local `undefinedSentinel()`, which is a bare
`ref.null.extern`. In the default standalone undefined-singleton regime a bare
null is JavaScript `null`; the repository's
`canonicalUndefinedExternInstrs(ctx)` exists specifically to emit the exact
standalone `undefined` carrier without a host import. The Test262 sources
require `undefined` after both the first call (RevocableProxy step 7) and an
already-cleared second call (step 2).

No result-invariant, descriptor, target/handler, array, TypedArray, class,
RegExp, Promise, generator, or global skip behavior is part of this slice.

## Implementation Plan

1. In only the `$Proxy` revoker arm of `fillApplyClosure`, replace the bare
   null sentinel returned after `__proxy_revoke` with
   `canonicalUndefinedExternInstrs(ctx)`. Leave the generic not-callable and
   arity-overflow fallback unchanged; those represent different semantics.
2. Add a focused #5196 test that compiles a revocable Proxy in host and
   standalone lanes, observes `revoke() === undefined` on first and second
   calls, still observes revocation, and checks `null !== undefined`. The
   standalone control must instantiate with zero host imports. Add the two
   exact standalone Test262 rows through `runTest262File`, plus the existing
   passing standalone `revoke.js` control.
3. Re-run the maintained standalone path list after the change. A successful
   slice must convert exactly the two claimed fail rows to `pass`, not merely
   compile them into a different non-pass status. Run proportionate focused
   quality checks without changing skips or importing a host provider.

## Validation on the f841 worktree and b590 delivery head

- One-worker focused Vitest lane:
  `node node_modules/vitest/dist/cli.js run
  tests/issue-5196-es2015-proxy-r2.test.ts --pool=forks
  --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot` —
  **5 passed**. This includes host and standalone compiler controls, the two
  formerly failing exact standalone rows, and the maintained-runner
  `revocable/revoke.js` passing control.
- The standalone compiler control instantiated with `{}` and asserted an empty
  `WebAssembly.Module.imports` list. It checks first and repeated revoker calls
  return `undefined`, remain distinct from `null`, and still revoke the Proxy.
- Focused Prettier check and Biome error-level lint passed for the changed
  production and test files; `git diff --check` passed.
- Before publication, this dirty checkpoint was fast-forwarded without conflict
  to current upstream `b590669a7b0dd9537d9b9e703218d9cd6eec3106` (the only
  intervening source change is disjoint #3521 prepared-free-function routing).
  The same one-worker focused file passed **5/5** at that exact delivery base;
  TS5 and TS7 typechecks also passed. Focused Prettier and Biome checks,
  function budget, oracle ratchet, issue-spec coverage, and `git diff --check`
  passed on that head. The LOC gate passed with this issue's explicit
  `src/codegen/object-runtime.ts` allowance for the five-line import expansion.
- Upstream then released v0.71.0. PR #5389 had no merge-queue entry, so the
  branch was normally merged with release head
  `7fffec534b44e344f9c2b2b310b346084eaa66b6`; its version-only delta is
  disjoint. The focused one-worker matrix passed **5/5** again on the resulting
  merge head before the checkpoint push. PR #5389 remains the single non-draft
  upstream delivery for this completed two-row fix.
- No full 310-row re-census was run after the two exact rows passed: this lane
  preserves the required two-global-compiler-lane cap. Relative to the fresh
  snapshot, the unrerun residual is therefore 113 baseline `fail` rows plus 13
  baseline `compile_error` rows; the two claimed rows are directly verified as
  `pass` rather than inferred from compilation.

## Acceptance criteria

- The exact 128-row inventory and first-stop histogram above are present before
  production implementation.
- The two claimed revocable-return rows pass in the maintained standalone lane,
  while the passing control and focused host/standalone controls stay green.
- Standalone output remains host-import-free; no global skip changes.

## References

- #5140 (wave-1 plan), PRs #5173, #5213.
