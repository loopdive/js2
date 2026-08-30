---
id: 5198
title: "ES2015 standalone regexp — r2 residual pass"
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

# #5198 — regexp r2: cluster and fix the residual regexp-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5142, part of PR #5179) plus a
second pass that yielded only +8 (PR #5213). The stopped r2 planning pass has
now been completed against exact upstream `main`
`4881206ab3001505fcfca875589aff8daf375ff9`.

The implementation branch was rebased onto upstream `main`
`02b7a33b58362ef16c703f29d687842066beaae1` on 2026-08-30 before fanout.
The intervening upstream changes are host-init marshalling, issue metadata, and
npm-compat artifacts; they do not replace the isolated evidence below. The
implementer must rerun Slice A on the rebased head before claiming a fix.

The force-refreshed maintained artifacts supplied 165 ES2015 rows under
`built-ins/RegExp/**` and the String
`{match,replace,search,split}` symbol-protocol families whose standalone status
was not pass. Every row was then rerun in a fresh child process through
`runTest262File`, with two workers and the QuickJS eval adapter present. Fresh
standalone is **3 pass / 158 fail / 4 compile_error / 0 timeout / 0 skip**.
Fresh host is **126 pass / 39 fail**. Cross-lane classification is:

- 119 standalone-fail / host-pass;
- 4 standalone-compile-error / host-pass;
- 39 fail in both lanes; and
- 3 pass in both lanes.

The 123 host-pass rows are the authoritative standalone conformance delta. The
39 dual-lane failures are real regression controls, not shared-realm poison:
every row ran in a separate process. A provider fix must not hide them or make
the 126 currently passing host controls worse.

Related known defect, separate issue: the shared-realm strict-rerun regression
on `cstm-matcher-on-boolean-primitive.js` is #5200 (test-infra, not a codegen
gap). It is not part of this isolated 165-row corpus and must not be chased
here.

## Implementation Plan

### Fresh residual table

| Provider surface | Rows | Fresh standalone | Fresh host | Primary invariant |
| --- | ---: | --- | --- | --- |
| `RegExp.prototype[@@replace]` | 38 | 0 pass / 38 fail | 33 pass / 5 fail | observable RegExpExec result/coercion loop |
| `RegExp.prototype[@@match]` | 33 | 0 pass / 30 fail / 3 CE | 29 pass / 4 fail | RegExpExec loop plus runtime flags |
| `RegExp.prototype[@@split]` | 31 | 2 pass / 29 fail | 24 pass / 7 fail | SpeciesConstructor and sticky splitter loop |
| `RegExp.prototype[@@search]` | 15 | 0 pass / 15 fail | 14 pass / 1 fail | observable lastIndex save/restore and result index |
| String symbol-protocol dispatch | 15 | 0 pass / 14 fail / 1 CE | 10 pass / 5 fail | `GetMethod(searchValue, @@method)` before builtin fallback |
| RegExp constructor / regexp-like input | 8 | 1 pass / 7 fail | 3 pass / 5 fail | observable `IsRegExp`, constructor short-circuit, source/flags Gets |
| Cross-realm prototype/flag accessors | 7 | 0 pass / 7 fail | 0 pass / 7 fail | realm-correct builtin prototype identity and brands |
| `RegExp.prototype.exec` | 6 | 0 pass / 6 fail | 6 pass | observable g/y lastIndex Get/Set |
| Generic `flags` getter | 5 | 0 pass / 5 fail | 0 pass / 5 fail | generic ordered flag Gets, no receiver brand requirement |
| `RegExp.prototype.test` | 3 | 0 pass / 3 fail | 3 pass | same g/y lastIndex Set contract as exec |
| Runtime `u`-pattern syntax | 3 | 0 pass / 3 fail | 3 pass | reject restricted identity escapes in runtime compiler |
| `RegExp[Symbol.species]` | 1 | 0 pass / 1 fail | 1 pass | canonical species getter value |

The three fresh passes are
`call_with_regexp_not_same_constructor.js` and the two `@@split` undefined-
species rows. Keep them as controls; do not count them as new r2 yield.

### Implementation slices

Each completed slice is one separate mergeable upstream PR. Do not publish a
half-demotion that merely changes `compile_error` into `fail`; every claimed
row must pass the maintained runner. If a shared helper proves two table rows
are one invariant, combine only those rows and document the proof here.

1. **Slice A — observable builtin-exec lastIndex (9 rows).** Add the exact six
   `prototype/exec` and three `prototype/test` rows to
   `tests/issue-5198-es2015-regexp-r2.test.ts`. Centralize g/y lastIndex read
   and write around `emitRegexSearchCall` and `emitRegExpTestFromLocals` in
   `src/codegen/regexp-standalone.ts`: preserve the deferred raw assignment,
   perform `ToLength` at execution time, and honor the ordinary property
   descriptor/companion on Set so a non-writable `lastIndex` throws instead of
   silently mutating the struct. Reuse `__regex_search`; do not add a matcher.
   Acceptance for this PR is standalone 9/9 and host 9/9.
2. **Slice B — common observable RegExpExec substrate.** Implement one helper
   used by the four symbol methods: observable `Get(rx, "exec")`; call a
   callable override with `rx`; require Object-or-null; otherwise run the
   existing builtin exec path. Its Get/Set lastIndex behavior must reuse Slice
   A. Start with the exact invocation/error/invalid-result rows, then update
   this issue with the measured yield before rebuilding method-specific loops.
3. **Slices C1-C4 — one completed symbol-method loop at a time.** Rebuild
   `@@search`, `@@match`, `@@replace`, and `@@split` around the common helper,
   in that order of increasing surface area. Preserve observable coercion and
   error order. `@@match` must read flags at runtime rather than rejecting the
   three dynamic-flag rows; `@@replace` must read generic result properties;
   `@@split` must implement SpeciesConstructor and the sticky splitter walk.
   Existing closed static string-receiver paths remain performance controls.
4. **Slice D — String symbol-protocol dispatch (15 rows).** In the standalone
   String method dispatcher, implement the spec's `GetMethod(searchValue,
   @@match/@@replace/@@search/@@split)` and callable invocation before native
   regexp or string fallback. Close the custom-replace compile error rather
   than suppressing its diagnostic. Reuse the reified symbol-method closures;
   do not add host imports.
5. **Slice E — regexp-like constructor semantics (8-row corpus).** Implement
   observable `IsRegExp` via `@@match`, called-as-function same-constructor
   short-circuit, and ordered abrupt `source`/`flags` Gets. The already-passing
   `call_with_regexp_not_same_constructor.js` is the regression control.
6. **Slice F — generic flags getter (5 rows).** For `flags` only, accept any
   Object and perform ordered `ToBoolean(Get(R, global/ignoreCase/multiline/
   unicode/sticky))`; keep brand checks on the individual flag getters. Fix the
   shared host/open-object behavior too, since all five rows currently fail in
   both lanes.
7. **Slice G — runtime Unicode syntax (3 rows).** Tighten the emitted runtime
   RegExp compiler, not only `regex/parse.ts`, so `u` mode rejects the three
   restricted identity-escape rows with a catchable construction-time
   `SyntaxError`.
8. **Slice H — realm/species tail (8 rows).** Repair cross-realm RegExp
   prototype identity/brand handling for the seven isolated realm rows, then
   close the independent canonical `RegExp[Symbol.species]` getter row as a
   separate fix if it does not share the changed invariant.

For every slice, run the exact owned rows in isolated host and standalone
mode, the other 165 rows as a regression sweep, already-green RegExp controls,
TS5/TS7, zero-host-import assertions, formatting/lint, LOC/function budgets,
oracle/coercion ratchets, numeric-local parity, issue integrity, and the full
commit/pre-push hooks with at most two workers.

### Handoff

Planning/implementation worktree:
`/private/tmp/js2-es2015-regexp-lastindex-20260830`.
Planning/implementation branch: `codex/5198-regexp-lastindex`.
Exact candidate list: `/private/tmp/js2-regexp-r2-baseline165.txt`.
Exact owned Slice-A list: `/private/tmp/js2-regexp-lastindex9.txt`.
Fresh isolated results:
`/private/tmp/js2-regexp-r2-fresh-main-{standalone,host}.jsonl`.

The implementation owner must use a separately provisioned worktree, update
this markdown issue with exact before/after evidence and remaining rows, push
checkpoints to `ttraenkler/js2` without force, and open a completed fix as a
non-draft PR on `loopdive/js2`. A semantically incomplete/non-mergeable
checkpoint may remain draft with explicit blockers. No GitHub issue is to be
created.

## Acceptance criteria

- All 165 exact rows pass standalone with zero host imports; interim PRs pass
  every row they claim and do not lose any previously passing row.
- The 126 currently passing host controls remain green. Any of the 39 dual-lane
  failures touched by a shared provider fix pass in both lanes.
- The four current compile errors become passes, never merely runtime failures.
- Exact isolated sweeps, focused tests, equivalence checks, ratchets, issue
  integrity, and complete repository hooks are green for every completed fix.

## References

- #5142 (wave-1 plan), PRs #5179, #5213; #5200 (strict-rerun isolation).
