# #7354 Prepared-path program: C lead hand-over, 2026-11-20

Written by the C lead session at the end of the budget window the project
lead set ("use the weekly limit until tomorrow evening"). All lanes were told
to finish the push in hand, write `## Suspended Work` in their issue files and
stop. Re-verify every hash below before acting; they are pointers, not state.

Goal unchanged: tests passing on the Prepared whole-program path
(`TEST262_COMPILER_PATH=ir`), standalone only. Plan of record:
`plan/issues/7354-prepared-path-harness-prelude-milestone.md`.

## Where the program stands

- **Prepared-path passes on the real harness prelude: still 0.** Integration
  round 7 (`claude/7354-integration` e24d01e175) and S9's census agree.
- **The first prelude wall moved.** S3's runtime OrdinaryToPrimitive (O2b)
  removed the ToPrimitive-of-an-object wall (assert.js:127, 6,690 files). On
  S3's 411-file sample, 301 rows now stop at assert.js:27,
  `JSON.stringify(value)` ("dyn.json_stringify has no Prepared intrinsic").
  The full-table confirmation is pending in integration round 8.
- **Next walls, in order:** J's object row (`JSON.stringify` of objects), then
  not-direct module-binding homes in runtime.js / propertyHelper.js (64 rows),
  then "assert not in scope in verifyProperty" (25).
- **With harness stand-ins:** 165 pass (+2 in round 7, 0 lost), 18 crashes.
  Ranking of blockers: B (built-in globals as values) 1,271 · C (function
  objects) 1,196 · `var obj = {…}` 1,069 · ToPrimitive 708 · array literals 574.

## Compile time: the root cause is found (#7436)

The full prelude (assert.js + sta.js + one test) compiles in about 1,000 s. The
census budget is 60 s.

| tree | compile | peak RSS |
| --- | --- | --- |
| base (S1's stand-in tree 23c7f9ec) | 1,002 s | 1,550 MB |
| base + B′ (#7365) + #7397 + #7415 | 967 s | 1,540 MB |

B′ is not the lever. S6's CPU profile:
- **67 % of self time:** `src/ir/program/data.ts`, the compare walker and
  immutable copies.
- **26 %:** garbage collection.
- **TypeScript and binaryen:** not in the top frames.

Cause: every emitted string literal re-plans the string-value physical input,
which re-derives the invocation, realm and source-closure requirements and
deep-compares each against its snapshot. Nothing settles, because
`planNativeSourceClosureRequirements` issues `Object.freeze({ ...data, demands })`
over unfrozen arrays. S6 was testing two fixes:
1. freeze at the issuing site;
2. settle `assertNativeInvocationRequirementsCurrent` through
   `PreparedIrSettledChecks`.

It was also asked whether the plan should be computed once per program instead
of per literal. Result: see #7436's issue file. **The #7365 B′ decision should
wait for that number.** #7398 was withdrawn: perf2's `preparedAllocationSites`
(merged in #7349) covers it.

## Merged since 2026-11-19 14:00Z (program PRs)

#7316, #7311, #7314, #7310, #7308, #7323, #7321, #7319, #7307, #7333, #7331,
#7332, #7318, #7313, #7341, #7342, #7312 (realm + O1), #7304 (typeof static),
#7349 (perf2: Str2 + linear string compile time), #7353 and #7356 (#7380 pins).

**#7346 (#7376, harness shim on demand) was merged and then reverted by #7355.**
It caused 237 standalone pass→fail rows: Temporal stack overflow and TypedArray
copyWithin out-of-bounds. The reviewer's 487-file sample beyond ES5 missed
both. Lesson: a harness change needs a full standalone run, not a sample.
#7376 must be re-done with that run before it lands again.

## Open PRs and the next action for each

"Approved" means a fresh-context reviewer posted `APPROVE on <head>`. Release =
remove `hold` and dispatch `auto-enqueue.yml`, only when the approval is on the
exact head and no check failed.

| PR | issue | state | next action |
| --- | --- | --- | --- |
| #7334 | #7374 | approved bdeedb9f89; bot park-hold | The park was collateral from #7346 (the 237-row standalone regression). #7355 reverted it. Re-check the cited run, then remove the bot hold only if the failure is that 237-row set. |
| #7336 | #7395 | approved 4f7b1a8d2f; bot park-hold | same as #7334 |
| #7335 | #7394 | approved 81558b0f7a; `equivalence-gate` red on shard 7 | Real failure: the #7164 share-group and hole pre-scans only see bare `g.length =`. S7 has the fix (array-share-group.ts, array-holes.ts, via the transparent-expression helpers). It re-adds hold, pushes, and RV7335 re-confirms. |
| #7339 | #7373 | approved 63f16c021b; DIRTY | merge main (with hold), RV7339 re-confirms |
| #7344 | #7428 | approved 72a42c2856; hold | release |
| #7325 | #7370 | approved 18f3b2ad88 | predecessor #7307 has merged: check it is clean and release |
| #7327 | Ty | approved 4b8cb983d0; DIRTY | predecessors #7315 and #7304; #7304 has merged; merge main, then re-confirm |
| #7309 | Fa | approved e22cb7c872; DIRTY | S4 is replacing `intoCarrier`'s `default:` with an exhaustive `never` check (a required change). RV7309 confirms the delta. Then merge main. |
| #7338 | #7401 | approved c265dec8; head 24a7e51310 carries both should-fixes | RV7338 confirms 24a7e513, then release |
| #7337 | #7369 (RegExp VM R0) | approved 79fc2e37b4; `quality` red | `check:orphaned-scripts`: scripts/check-regexp-byte-identity.mjs. RV7337's rework (fold into byte-diff-corpus.mts) removes it. S12. |
| #7340 | #7355 refactor | approved af0efa4e02, released | none |
| #7343 | #7410 | BLOCKER on 805df500 | (1) fold `.name` only for user-source declarations: lib aliases are "values"/"entries"; (2) drop the oracle-ratchet grant and use `ctx.oracle.declarationsOf`. S5. |
| #7330 | B2c-2 | approved 698e094e; head 113000e82a; DIRTY | RV7330 delta confirmation, then merge main |
| #7329 | #7372 R1 | BLOCKER | S10 move-only rework |
| #7320 | #7366 | BLOCKER on 76b75507f7; head ab51454950 | RV7320 re-review |
| #7326 | Fb | review running (RV7326) | merge Fa's next head first |
| #7345 | Fa × Ty | review running (RV7345) | base is #7327 |
| #7347 | #7416 | review running (RV7347) | BEHIND |
| #7348 | #7434 | review running (RV7348) | none yet |
| #7362, #7363 | F0, M1 | opened after the last check-in by another lane | no reviewer started by this lead |
| #7315 | B2a | approved; DIRTY | merge main and re-confirm |
| #7263 | G1 | BLOCKER on an old head, DIRTY | verify the author's last head |
| #7322, #7324 | strategy review, S15 spike | docs, hold | user decision |
| #7328 | docs collector | hold, DIRTY | S8 merges main; release once writers have stopped |
| #6990 | #7106 | hold, DIRTY | outside this program |

Unpushed work on branches, not PRs yet:
- `claude/7354-o` e5878297 (O3 + O2b): S3 owns the **Fa × O merge**, with
  decisions given:
  - a held callable toString/valueOf goes through a run-time `is_function`
    test to a named abort until Fb supplies Call;
  - one program record `{objects, functions, catches}`;
  - one `MEMBER_ACCESS_ARM` with function rows.
- `claude/7354-json` 7ffbb9d7e3 (J primitives, S1): the object row waits for
  the Fa × O merge.
- `claude/7427-symbol-keyed-member-keys` (S5): stacked on #7343. 0 verdict
  changes on 349 files; it removes two duplicate symbol-id tables.
- `claude/7354-arrays` a477e3c920 (Array.isArray) and `…-arrays-strprops`
  1923c40270 (S13).
- B2b (S5), declaration-as-value (S4), eval A0–A3 (S2), C1/C3 (S11): see
  their issue files.

Suspended-work pointers the lanes reported at wind-down (ls-remote verified by
each lane):
- **S3:** `claude/7354-o` c6c1b4e8c8 holds `## Suspended Work`. Not started:
  the Fa × O merge (decisions above), S13's shared-exn merge, the error-object
  kind, and the O7 harness homes (`claude/7354-o-homes` was never pushed).
- **S11:** `claude/7354-c` a80249cf. `claude/7354-c-int` 38400188 is
  unverified. Step 1 is to diagnose why #7344 was dequeued with CI_FAILURE on
  2026-11-20 09:32Z; it is probably the #7346 collateral, but that is not
  confirmed.
- **S2:** `claude/prepared-eval-a5` 765ef1e5 (eval A0–A3, no PR). Next: merge
  main, re-measure, and open one held PR.
- **S9:** `claude/es5-census-integ-rounds` c6b4d85484 (no PR). Next: merge
  main and open it as the rounds docs PR.
- **S8:** integration stays at e24d01e175. Round 8 (the O2b merge) was aborted
  at the weekly limit. Next steps are in `plan/agent-context/s8-c8-integration.md`
  on #7328 (2771b10115, main merged in).
- **S13:** `claude/7354-arrays` 9d3a111d11. Its Suspended Work is in the #7352
  issue file. `…-arrays-strprops` 1923c40270 and `claude/7354-shared-exn`
  048fdd1df7 are done. The o3merge and the shared-exn re-merge were cut off
  locally; redo both from the pushed branches.
- **S10:** #7329 at 75a590b7 carries the RV7329 fix, not yet re-reviewed.
  `claude/7375-compound-rhs` 18bc06b2 carries #7375 and #7408; it has no PR yet.
- **S1:** `claude/7354-json` 760ceb3f18 (J, no PR) and
  `claude/7362-legacy-typeof-effects` 6d399abc69. #7327 next: merge main, pin
  the `typeof void 0` probes, then a delta review.
- **S15b:**
  - #7338 at 4061d667 waits on RV7338.
  - #7347 at 32afe752 has `quality` red: the new
    src/codegen/helpers/required-helper.ts is not classified in
    compiler-boundaries.json.
- **#7340** was approved on af0efa4e02 and released at wind-down.

## Decisions still open for the project lead

1. **Cancelling stale CI runs.** 260+ were queued on 2026-11-19; the
   permission classifier refused it from this session.
2. **#7365 B′.** Wait for #7436's number (see above).
3. **#7419.** JS-environment string boundary: the default/node/web targets
   throw "type incompatibility". Fix or record?
4. Also open: #7322 (strategy proposals), #7393, #7324 (does a
   legacy-compiled runtime library count as IR-only?), #7406 (representation),
   the other #7354 lane.

## Issues filed in this window

Ids reserved by this lead: #7420–#7432, #7435, #7436. **#7433 is an unused
hole**: S11 filed the same finding as #7434 via its own allocation.

- #7420: compound assignment to an unlowerable target is a silent no-op.
- #7421: `RegExp | undefined` parameter: `?.test`/`?.exec` answer false.
- #7422: fold padMissingArg into absentArgInstrs (also fixes a trapping ref pad).
- #7423: `arguments.length` is 1 in padded next/return calls.
- #7424: array destructuring never calls `return()` on early exit.
- #7425: `yield*` over a user iterator throws.
- #7426: on gc, a native undefined reaches JS as an opaque object.
- #7427: symbol-keyed member keys go through one canonical `@@<id>` helper.
- #7428: the Prepared front door applies the ordinary TS-diagnostic policy.
- #7429: `obj[Symbol.iterator]` on an object literal answers undefined.
- #7430: `o?.f?.()` traps when `f` is a class field holding undefined.
- #7431: local test262 on Node < 23 recycles workers after every test
  (Promise.try polyfill), about 4.5× slower. A second canary failure is
  recorded there.
- #7432: one representation for well-known symbol keys (design; four
  spellings today).
- #7434: const write on the Prepared path hits a driver invariant.
- #7435: `?.byteLength` gives NaN; on wasi `Uint8Array?.length` gives 0.
- #7436: Prepared compile time (see above).

Unowned finding without an id: a typed `s[1]` / `s.charAt(1)` inside a
function crashes from-ast ("charAt delegation produced no value"). Found by
S13; pre-existing.

## Process notes for the next lead

- **Answer the user in German.** Lanes run on Opus; Fable's limit reset on
  2026-11-20 21:00Z.
- Every PR is gated by a fresh-context reviewer session that the lead starts.
  Lanes do not start reviewers, and lanes do not push to a released PR. If a
  push is needed, re-add `hold` first.
- **Announce a head only after `git ls-remote` shows it**, and message the
  reviewer directly.
- **Check failed checks before releasing.** An approval does not imply a green
  `quality` check (#7337).
- **Diagnose from the step that failed, not from the loudest output in the
  log.** The "moved-runtime gate FAIL" lines in `check:dead-exports` are
  informational, on main too.
- **A harness or test-runner change needs a full standalone run** (#7346).
- Lane and reviewer session ids are in each lane's issue files and in the PR
  comment threads; `list_sessions` with `children: true` from the lead session
  lists them.
