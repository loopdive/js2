---
id: 5197
title: "ES2015 standalone promise — r2 residual pass"
status: in-progress
sprint: current
created: 2026-08-29
updated: 2026-08-30
priority: high
horizon: m
feasibility: hard
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
---

# #5197 — promise r2: cluster and fix the residual promise-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5143, part of PR #5179) plus a
second pass that yielded only +5 (PR #5213, added
`src/codegen/promise-newtarget.ts`). The stopped r2 planning pass has now been
completed against exact upstream `main`
`b6adee3156e9642ed221174a69e6f6f1a381484f`.

The implementation branch was rebased onto upstream `main`
`02b7a33b58362ef16c703f29d687842066beaae1` on 2026-08-30 before fanout.
The intervening upstream changes are host-init marshalling, issue metadata, and
npm-compat artifacts; they do not replace the isolated evidence below. The
implementer must rerun Slice A on the rebased head before claiming a fix.

The force-refreshed maintained artifacts supplied 152 ES2015
`built-ins/Promise/**` rows whose standalone status was not pass. Every row was
rerun in a fresh child process through `runTest262File`, with two workers and
the QuickJS eval adapter present. Fresh standalone is **12 pass / 138 fail / 2
compile_error / 0 timeout / 0 skip**. Fresh host is **75 pass / 77 fail**.

Cross-lane classification is 64 standalone-fail/host-pass, one standalone-
compile-error/host-pass, 74 fail/fail, one compile-error/host-fail, ten
pass/pass, and two standalone-pass/host-fail. The last two host regressions are
`promise.js` and `undefined-newtarget.js`; they remain explicit controls even
though the authoritative completion target is standalone.

## Implementation Plan

### Fresh residual table

| Provider surface | Rows | Fresh standalone | Fresh host | Primary invariant |
| --- | ---: | --- | --- | --- |
| `Promise.all` | 46 | 1 pass / 45 fail | 10 pass / 36 fail | observable element pipeline and resolve-element closures |
| `Promise.race` | 35 | 1 pass / 34 fail | 11 pass / 24 fail | same element pipeline with shared capability functions |
| `Promise.prototype.then` | 16 | 1 pass / 15 fail | 11 pass / 5 fail | SpeciesConstructor and NewPromiseCapability |
| executor/resolve/reject function metadata | 15 | 0 pass / 15 fail | 13 pass / 2 fail | escaped synthesized closures must be real callable objects |
| `Promise.resolve` / `Promise.reject` | 14 | 2 pass / 12 fail | 13 pass / 1 fail | generic constructor capability and settlement identity |
| `Promise.prototype.catch` | 7 | 2 pass / 5 fail | 6 pass / 1 fail | generic `Invoke(this, "then", ...)` |
| constructor / settlement core | 6 | 2 pass / 4 fail | 5 pass / 1 fail | already-resolved guards and thenable job timing |
| `allSettled` / `any` iterator-close tail | 4 | 0 pass / 4 fail | 0 pass / 4 fail | shared abrupt-combinator iterator closing |
| arbitrary NewTarget/prototype | 3 | 1 pass / 2 CE | 1 pass / 2 fail | #3371 Reflect.construct NewTarget substrate |
| Promise prototype misc | 3 | 2 pass / 1 fail | 3 pass | canonical `@@toStringTag` |
| `Promise[Symbol.species]` | 2 | 0 pass / 2 fail | 2 pass | canonical species accessor value/descriptor |
| cross-realm prototype | 1 | 0 pass / 1 fail | 0 pass / 1 fail | realm-correct Promise prototype identity |

The two remaining compile errors are
`get-prototype-abrupt-executor-not-callable.js` (host passes) and
`get-prototype-abrupt.js` (host fails), both still refused by the documented
#3371 arbitrary-NewTarget boundary. The twelve fresh standalone passes remain
in the 152-row regression corpus; do not count them as new r2 yield.

### Implementation slices

Each completed slice is one separate mergeable upstream PR. A checkpoint that
only changes a compile error into a runtime failure is not a completed fix.

1. **Slice A — Promise symbol object model (3 rows).** Add the two
   `Promise/Symbol.species` rows and `prototype/Symbol.toStringTag.js` to
   `tests/issue-5197-es2015-promise-r2.test.ts`. Reuse the canonical builtin
   species accessor and native-prototype symbol-tag machinery; direct value
   reads and property descriptors must agree, with no Promise-specific fake
   object. Acceptance is standalone 3/3 and host 3/3.
2. **Slice B — synthesized promise callables (15-row metadata corpus).** Make
   executor, resolve, and reject functions escape as the repository's standard
   non-constructible callable carrier. They need `typeof === "function"`,
   `Function.prototype`, extensibility, own `length` then `name` descriptors,
   correct invocation arguments, and `new fn()` TypeError behavior. Apply the
   same substrate to combinator resolve-element functions rather than creating
   another representation.
3. **Slice C — generic catch/then capability.** Implement `catch` as observable
   `Invoke(this, "then", «undefined, onRejected»)` for arbitrary objects, then
   route native `$Promise.prototype.then` through ordered constructor/species
   Gets and NewPromiseCapability when those properties are observable. Keep the
   intrinsic unpatched fast path. Re-run the exact 23-row then/catch corpus,
   including its three already-passing controls.
4. **Slice D — generic Promise resolve/reject and settlement.** Generalize
   NewPromiseCapability for `Promise.resolve/reject.call(C, value)`, preserve
   constructor identity and already-resolved guards, and schedule custom
   thenables in the established microtask ring. Close the 12 static-method and
   four settlement-core failures without regressing the two host-only controls.
5. **Slice E — common observable combinator pipeline.** Build one shared
   provider for `Get(C, "resolve")` once, per-element Call, observable Get/Call
   of `then`, per-element interleaving, and IteratorClose on abrupt completion.
   It must compose the existing native thenable scheduler and the Slice-B
   callable carrier, not add host imports or drain the iterable before
   subscription.
6. **Slices F1-F3 — completed combinators separately.** Wire the common
   provider into `all`, `race`, then `allSettled`/`any`. A PR is complete only
   when its exact method corpus passes; preserve aggregate identity,
   remaining-element/once semantics, result ordering, and the method's shared
   resolve/reject function identity. Combine methods only when the same changed
   helper closes their full claimed corpora.
7. **Slice G — arbitrary NewTarget (2 rows), delegated to #3371.** Keep both
   rows in acceptance, but do not weaken Reflect.construct semantics or the
   diagnostic locally. Re-measure after #3371 supplies distinct-NewTarget
   prototype lookup and abrupt propagation.
8. **Slice H — cross-realm tail (1 row).** Close `proto-from-ctor-realm.js`
   through the canonical eval-realm Promise provider; never special-case the
   Test262 harness or treat the primary realm prototype as universal.

For every completed slice, run isolated exact host and standalone rows, the
other 152 rows as a regression sweep, already-green Promise/async controls,
TS5/TS7, zero-host-import assertions, formatting/lint, LOC/function budgets,
oracle/coercion ratchets, numeric-local parity, issue integrity, and the full
commit/pre-push hooks with at most two workers.

### Handoff

Planning/implementation worktree:
`/private/tmp/js2-es2015-promise-symbol-object-model-20260830`.
Planning/implementation branch: `codex/5197-promise-symbol-object-model`.
Exact candidate list: `/private/tmp/js2-promise-r2-baseline152.txt`.
Exact owned Slice-A list:
`/private/tmp/js2-promise-symbol-object-model3.txt`.
Fresh isolated results:
`/private/tmp/js2-promise-r2-fresh-main-{standalone,host}.jsonl`.

The implementation owner must use a separately provisioned worktree, update
this markdown issue with exact before/after evidence and remaining rows, push
checkpoints to `ttraenkler/js2` without force, and open a completed fix as a
non-draft PR on `loopdive/js2`. A semantically incomplete/non-mergeable
checkpoint may remain draft with explicit blockers. No GitHub issue is to be
created.

## Acceptance criteria

- All 152 exact rows pass standalone with zero host imports; interim PRs pass
  every row they claim and do not lose any previously passing row.
- The 75 currently passing host controls remain green. The two host-only
  regressions are restored by the shared provider work that owns their
  invariant, not hidden from the corpus.
- Both compile errors become passes after #3371 lands, never merely runtime
  failures.
- Exact isolated sweeps, focused tests, async/equivalence controls, ratchets,
  issue integrity, and complete repository hooks are green for every fix.

## References

- #5143 (wave-1 plan), PRs #5179, #5213.
