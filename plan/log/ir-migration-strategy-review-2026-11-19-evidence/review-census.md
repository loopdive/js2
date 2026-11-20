# Is "one fresh reviewer per PR, every finding fixed" paying for itself?

Evidence review, 2026-11-19. Repo `loopdive/js2`, PRs created 2026-11-05 … 2026-11-19 14:47Z. Read-only.

## 0. Answer

**Half of it pays; the other half does not.**

- **The defect hunt pays.** 30 of 85 first reviews (35 %) found a behaviour defect: a wrong answer, a trap, a compile crash or a test-verdict regression. 29 were introduced by the PR, 1 was already on main. Existing CI would have caught about 4 of the 29. A blocking round costs about 1 hour (median 62 min).
- **"Every finding fixed, re-review until MET" does not pay.** About two thirds of review rounds find no real defect. In the 14 reviews I read end to end, 73 % of findings were design, proof/ceremony or nits. 13 first reviews blocked on design or proof alone, and 10 more on a claim-then-withdraw with no change in output.
- **The valuable part is mechanical.** Every real defect was found by the same hand procedure: write 20–1,400 probe programs, run base, head and node on 2–3 lanes, diff. The probes stay in the reviewer's scratchpad and are thrown away. A committed differential harness would do this on every PR.
- **Review is not the last line of defence, and it leaks.** The merge queue caught 3 distinct real regressions on 4 PRs that review had approved. 2 defects reached main and needed forward fixes. 4 PRs exist only to repair tests that were red on main.

## 1. Sample and limits

| | count |
|---|---:|
| PRs in window (search API, 4 date slices) | 254 |
| of which bot `chore(ci): refresh npm-compat` | 97 |
| non-bot PRs (all fetched: body, comments, reviews, commits, timeline) | 157 (141 merged, #7063–#7318) |
| PRs with a recorded review verdict | **85** |
| … verdict posted as PR comments (11-05…11-08 and 11-19) | 44 |
| … verdict only in the PR body (11-06…11-18) | 41 |
| threads read end to end (evidence `T`) | 22: #7065 #7081 #7092 #7104 #7174 #7185 #7187 #7263 #7304–#7316 #7318 |
| threads where I read every blocker section (first 2.6 kB of each blocking comment) and nit headlines (evidence `B`) | 17 |
| PRs judged from the PR body's review record only (evidence `S`, some truncated at 1.5 kB) | 37 |
| verdict comment headline only (evidence `t`) | 14 |

- **I did not reach "30 threads in full".** 22 were read end to end; 17 more were read for all blocking findings.
- **Body-only records are the author's summary of the review**, not the reviewer's text. Finding counts there are lower bounds.
- **Round counts are partly inferred**: #7212 rounds 1–3, #7186, #7193.
- **11 of the 13 PRs opened today have no review yet** or one round only. All PRs opened on 11-19 are included: #7305–#7316, #7318 (#7317 is the bot).
- **A second, source-only reviewer** also posted on 15 PRs on 11-06 (GitHub reviews by the same account). I did not classify its findings, except where noted.
- The 13-lane setup and "1–3 rounds, blockers in 5 of 7 first reviews" match what I see for today: blockers on #7305, #7307, #7310, #7314, #7315; approvals on #7263 and #7304 (its third round).

Classes used:
- **REAL**: wrong answer, trap, compile crash, invalid Wasm or test-verdict regression.
- **CTW**: claim-then-withdraw only (the IR selects a unit and later fails; the legacy fallback gives the right output). The brief counts this as REAL; I report it separately because nothing observable changes.
- **DESIGN**, **PROOF** (proof/ceremony), **NIT**: as in the brief.

## 2. Totals

### First-review outcome per PR (n = 85)

| first review | PRs | share | PR numbers |
|---|---:|---:|---|
| passes (approve / met) | 32 | 38 % | #7065 #7071 #7075 #7081 #7085 #7092 #7095 #7096 #7100 #7101 #7116 #7120 #7121 #7135 #7156 #7157 #7161 #7162 #7163 #7172 #7173 #7174 #7177 #7182 #7185 #7187 #7190 #7239 #7243 #7263 #7294 #7300 |
| blocks on a REAL behaviour defect the PR introduced | 29 | 34 % | #7103 #7104 #7107 #7111 #7118 #7131 #7140 #7142 #7143 #7150 #7164 #7168 #7169 #7176 #7179 #7186 #7188 #7192 #7193 #7221 #7231 #7246 #7251 #7272 #7277 #7286 #7304 #7305 #7307 |
| blocks on a REAL defect already on main | 1 | 1 % | #7290 |
| blocks on claim-then-withdraw only | 10 | 12 % | #7136 #7138 #7147 #7166 #7170 #7178 #7212 #7214 #7234 #7314 |
| blocks on DESIGN only | 7 | 8 % | #7146 #7175 #7183 #7215 #7226 #7283 #7310 |
| blocks on PROOF/ceremony only | 6 | 7 % | #7151 #7167 #7268 #7291 #7296 #7315 |

- #7192 and #7193 are soft REALs: the wrong answer needs a monkey-patched built-in or an unusual receiver form.
- #7300 passed its first review; rounds 2 and 3 then found two REAL defects.

### Rounds (estimate, ±10)

| | count |
|---|---:|
| review rounds on authored code, 85 PRs | ≈196 (2.3 per PR; maximum 7 on #7212, 6 on #7167, 5 on #7193 and #7268) |
| blocking rounds | ≈87 |
| rounds that found a REAL behaviour defect | ≈41 (21 %) |
| rounds that found only claim-then-withdraw | ≈20 (10 %) |
| **rounds that found no REAL defect (brief's definition, CTW counted as REAL)** | **≈135 (69 %)** |
| rounds that found no behaviour defect | ≈155 (79 %) |
| extra re-reviews of merge-conflict resolutions, 0 findings | ≥19 (#7118 ×6, #7140 ×4, #7157 ×2, #7166 ×2, #7167 ×2, #7173 ×2, #7142, #7151, #7156) |

### Findings by class (hand count, 14 reviewed PRs read end to end, ≈94 findings)

| class | findings | share | fixed? |
|---|---:|---:|---|
| REAL, introduced by the PR | 7 | 7 % | all fixed |
| claim-then-withdraw only | 1 | 1 % | fixed |
| REAL, already on main (by-product of the probes) | ≈17 | 18 % | 3 fixed in the PR, the rest filed (#7261, #7334, #7362, #7367, #7370 …) |
| DESIGN | ≈17 | 18 % | mostly fixed, about 4 deferred |
| PROOF/ceremony | ≈30 | 32 % | mostly fixed |
| NIT | ≈22 | 23 % | mostly fixed |

PRs: #7065 #7081 #7092 #7104 #7174 #7185 #7187 #7263 #7304 #7305 #7307 #7310 #7314 #7315.
This sample over-represents today's PRs. In the 11-06…11-08 wave the REAL share of *blocking* findings is higher (12 of 18 blocking first reviews).

### Density (estimates, lower bounds)

| | value |
|---|---:|
| changed lines in the 85 reviewed PRs | 128,505 (70,415 without the 58 k-line deletion PR #7226) |
| distinct PR-introduced behaviour defects found | ≥45 (29 PRs, several with 2–6 each) |
| per reviewed PR | ≈0.5 |
| per 1,000 changed lines (without #7226) | ≈0.6 |
| with claim-then-withdraw shapes added (≥25 more) | ≈0.8 per PR, ≈1.0 per 1,000 lines |

### Reviewer errors

Findings that were wrong, rebutted or did not reproduce: about 10 that I could identify, under 5 % of findings (estimate).
- #7183 finding 1: "JS-host/gc binaries change for the claimed shapes. Rebutted."
- #7104: the source reviewer's candidate was marked "UNRUN" and did not reproduce ("your candidate does not reproduce as a claim"); the guard was restructured anyway.
- Rebuttals accepted on #7164 (nit 2), #7168 (N3 not taken), #7169 (N3), #7192 (finding 8), #7193 (use-before-declaration), #7246 (1), #7272 (1, in part), #7304 (round-2 item 4).
- One reviewer miss admitted: #7164 round 2, "my first review missed it because I did not record `irPostClaimErrors` per probe".
- One author rebuttal was wrong: #7167 N3, "The rebuttal against a non-mutating peek does **not** hold".

## 3. Delay

Measured from PR timelines and comment timestamps. The `hold` label also covers stacking and lead release, so hold time is an upper bound for review delay.

| measure | value | n |
|---|---:|---:|
| `hold` set → first verdict comment, median | 56 min (7 min … 15 h) | 41 |
| blocking verdict → next verdict, median (**one blocking round**) | **62 min** (1 min … 14 h) | 26 |
| first blocker → first approval after the last blocker, median | 97 min; sum 48.5 h | 18 PRs |
| first hold, PRs that passed first review (comment era / body era), median | 1.8 h / 3.6 h | 20 / 11 |
| first hold, PRs blocked at first review (comment era / body era), median | 8.6 h / 6.2 h | 18 / 29 |
| sum of first-hold time on the 47 blocked PRs | 448 h | 47 |
| slowest | #7214 42 h (4 rounds), #7231 41 h, #7234 29 h (4 rounds), #7212 25 h (7 rounds) | |
| fastest multi-round | #7296 0.4 h (2 rounds), #7300 0.7 h, #7286 0.9 h (3 rounds) | |

- **Total reviewer-induced delay (estimate):** 53 blocked PRs × about 2.7 h ≈ 140 PR-hours, plus about 80 PR-hours waiting for the first verdict. That is about 220 PR-hours in 14 days, spread over parallel lanes.
- **Upper bound:** 574 hold-hours on the reviewed, merged PRs.
- Not measured: reviewer and author token cost. Each review reruns all gates, compiles 100–3,600 binaries and writes its own probe set.
- Queue noise in the same window, unrelated to review: 46 extra merge-queue removals on 24 PRs (#7118 ×5, #7138 ×4, #7140 ×4, #7146 #7162 #7163 #7176 #7188 ×3 each). Five PR comments blame a wasmtime download failure (#7138 #7176 #7177 #7186 #7192).

## 4. Could a cheap automated check have caught the real defects?

| PR | defect the reviewer found | did existing CI catch it? | cheapest automated check |
|---|---|---|---|
| #7143 | import-cycle edge; 14 equivalence regressions; perf pin test red | **yes**, required checks were already red | none needed; the review repeated CI |
| #7150 | 4 ES5 files pass → compile error | merge queue would (ES5 completed-edition ratchet) | test262 on the changed directories at PR level |
| #7169 | 21 test262 files pass → fail | **yes**, the author's A/B flagged it 28 min earlier ("known-bad. Do not release") | same |
| #7179 | nested var reads non-undefined | **yes**, "same root cause as CI's equivalence regression" | none needed |
| #7167, #7170 | gate red; own test times out | **yes** (`quality`) | none needed |
| #7140 #7142 #7131 #7221 #7246 #7307 #7300 (r2) #7118 | wrong answers over an operand-kind × operator × position matrix | no; equivalence gate and test262 samples were green | **differential test against node and base** from a typed program generator. The #7307 reviewer says so: "The test file hard-codes node's answers. Computing them by running node would have caught M1 in an extended table." |
| #7104 #7107 #7168 #7176 | new trap where base returned a value | no | same differential run with base as oracle ("head never traps where base does not") |
| #7103 #7111 #7164 #7188 #7272 #7251 #7186 #7231 | wrong answer that needs one insight (script shadowing of a lib name, a side effect through `toString`, `this` after a throw, a mutator hidden in `eval`, multi-file script scope) | no; #7164's 838-file test262 A/B was row-identical | a differential fuzzer with those mutators would reach some; **none cheap** for #7164 and #7272 |
| #7305 #7277 #7286 (×2) | invariant error escapes `compile()` | no (the Prepared path passes 0 tests, so no verdict moves) | **crash-count ratchet** on the Prepared census from PR #7308 |
| #7304 (r1) | new compile failure on plain JS | no | compile-only run of the test262 corpus, new compile errors = 0 |
| all 10 CTW blockers and about 15 CTW shapes inside other reviews | post-claim error | no; `irPostClaimErrors` is recorded but not gated | **ratchet: 0 new post-claim errors** on corpus and fuzz output. The corpus alone misses some (#7147: "I did not find this shape in the real test262 corpus") |
| mutation survivors (#7263 M4/M5, #7305 M4, #7310 M2, #7315) | untested guard | no | mutation testing on changed lines; reviewers do it by hand every round |

Summary for the 29 PR-introduced behaviour defects:
- about 4 were or would have been caught by existing gates: #7143, #7150, #7169, #7179;
- about 17 need only a generated differential run (base/head/node), which does not exist as a gate (#7192 and #7193 included);
- about 4 need a crash or compile-error ratchet: #7277, #7286, #7304, #7305;
- about 4 probably need a human or a much smarter generator: #7164, #7272, #7188, #7103.

## 5. What escaped review

| what | PRs | caught by |
|---|---|---|
| `eval("f();")` call silently dropped by write-precise eval liveness. The review had run "72 runtime probes with the interpreter provider (identical on A1 and A3)". | #7146, #7163 (same code; also in A2/A2c, #7177) | **merge queue**, ES5 completed-edition ratchet: "It fails 3/3 on main + this branch and passes 3/3 on main alone." |
| merged-state failure after 3 review rounds (MET); fix commits pushed after the park (host-import classification, a test re-anchor) | #7226 | **merge queue** (bot `hold` 11-14 00:24Z) |
| regression after 2 review rounds (MET); fix "the bare Function.prototype value is no boundary site again" pushed after the park | #7231 | **merge queue** (bot `hold` 11-15 15:52Z) |
| recursive self-reference treated as local at the eval boundary | #7136 → forward fix #7155 | reached main; found by the second, source-only reviewer after merge |
| `var x;` in a loop reset each iteration; slice H "widened it to 14 of 30" probes after 3 review rounds | #7286 → fix #7290 | reached main (Prepared path only) |
| tests red on main after reviewed merges | #7185 (after #7164/#7175), #7187 (after #7143), #7278 and #7281 ("16 reviewed commits changed them since the last re-pin without updating the hash") | nobody: CI runs these files only when a PR touches them |
| reverts on main | 0 (`git log origin/main --since=2026-11-05 --grep '^Revert'`, 393 first-parent commits) | |

Bot parks in the window: 11 PRs.
- Real, missed by review: #7146, #7163, #7226, #7231.
- Not caused by the PR: #7107 (artifact-upload flake in a batched group), #7131 (two ES5 compile timeouts, measured as not caused by it).
- Unverified: #7177, #7179, #7182, #7249, #7268. The bot label was followed by a merge within 15–90 min with no fix commit. I did not read the CI logs.

## 6. Examples

Most valuable:

1. **#7307, REAL, wrong value, today.** "M1. A number on the left of `??` is lost when the right side is not a number … This silently changes a correct value into a wrong one for any `number | undefined ?? <non-number>`." The equivalence gate was green and 200 binaries were byte-identical. Found in 16 min, fixed and re-approved 24 min later.
2. **#7168, REAL, trap.** "`7e90ac9e` turns programs that ran correctly into traps on all three targets. The shared presize analysis never checks for writes to the loop counter `i`." Round 2 found the same trap through a class field initializer.
3. **#7164, REAL, wrong result.** "B1 — wrong result after a throwing callee: `this` is not restored (head only, all 3 targets)". The reviewer's own 838-file test262 A/B showed 0 row differences: "This sample does not reach B1".
4. **#7111, REAL, lost side effect.** "Blocker: an unused `var x = __hasOwnProperty(o, k)` is deleted, so its side effects are lost". Root cause was one missing row in the effects table.
5. **#7300 round 3, REAL, already on main.** "an unused `&&`/`||`/`?:` dropped its effectful arm; the bug was in dead-code elimination and also hit the ordinary pipeline." It became #7359; with the fix reverted, "54 of the 80 are wrong".

Most ceremonial:

6. **#7315, PROOF, blocker on a table nothing imports.** The review says "The rows themselves are right … I found no wrong cell, no missing row and no invented row." It still returns BLOCKER with 3 must-fixes, 6 should-fixes and 3 nits on a 300-line data file. One must-fix: "the B2a plan must name `AMBIENT_TYPEOF_TAGS` as the duplicate and say who deletes it and when". The PR body: "nothing under `src/` imports the table yet, so every binary is unchanged by construction."
7. **#7268, PROOF, five rounds on forged inputs.** "Round 2, NOT MET on tests. The code refused every attack (about 20 …), but seven checks could each be deleted without a test failing." Then "Round 4, NOT MET. That fix introduced a crash: an altered native provider on a program with two native providers threw a TypeError instead of refusing." The attacks alter the compiler's own plan objects. #7291 and #7296 have the same pattern: 8 blocking rounds in total, on a path that passes 0 of 8,717 ES5 tests.
8. **#7151, PROOF.** "BLOCKER 1: #7283's own growth has no budget grant", in a review that opens with "Correctness checks are clean."
9. **#7314, CTW with no observable change.** BLOCKER because the linear lane now claims and then withdraws, while "Compiled bytes are unchanged because both versions fail."
10. **#7310, DESIGN (latent).** BLOCKER although "**Impact today:** no wrong answer, but the refusal is mislabelled".
11. **#7187, NIT.** A 34-line test fix gets a full review (probes on 3 lanes, a test262 spot check, all gates). Its one finding: "frontmatter still says `status: in-progress`".
12. **#7143, duplicated CI.** "two required checks are red on head, and I reproduced both locally".

## 7. What the evidence supports

Keep:
- One fresh-context review whose job is behaviour: head against base and node. It finds about one real defect per three PRs at about one hour per round.
- Filing the pre-existing defects the probes turn up. About 17 came out of 14 reviews, including a real ordinary-pipeline miscompile (#7359).

Change:
- **Only behaviour defects and new claim-then-withdraws block.** Design, proof and nit findings go into one follow-up commit or a linked issue. That removes 13 of the 53 blocking first reviews outright and shortens most multi-round chains.
- **Cap blocking rounds at 2**, then the lead decides. #7212 (7 rounds), #7193 and #7268 (5), #7214 and #7234 (4) each repeated one defect class per round; the design was the problem, not the diff.
- **No re-review of a conflict-resolution merge when `git merge-tree` equality holds.** At least 19 such rounds found nothing.
- **No review for docs-only, test-only or data-only PRs** with no importer (#7187, #7185, #7315, #7306).
- **Commit the probes.** Turn the reviewers' procedure into gates:
  - a typed differential generator (base/head/node, 2 lanes);
  - a ratchet of 0 new post-claim errors;
  - a crash ratchet on the Prepared census;
  - mutation testing on changed lines.
  This covers about 21 of the 29 behaviour defects and all claim-then-withdraw findings, and it keeps the coverage that is now discarded after every review.
- **Run changed-directory test262 at PR level.** Reviewers sample 200–800 files by hand each round because the PR-level regression check is a no-op by design.
- **Stop "attack the certificate" reviews on the Prepared path** until that path passes tests.

## 8. Per-PR table

¹ Hours under the author-set `hold` label; includes stacking and lead-release waits. "open" means still held.
² T = thread read end to end; B = all blocker sections plus nit headlines; S = PR-body review record; t = verdict comment headline only.
Classes: REAL(CI) = also caught by existing CI or the author's own run; REAL(pre) = already on main; CTW = claim-then-withdraw only.

| PR | ± lines | rounds | first verdict | first-blocker class | hold h¹ | evidence² | note |
|---|---:|---:|---|---|---:|---|---|
| #7065 | 257 | 1 | APPROVE | - | 1.6 | T | 3 nits (design/perf); found pre-existing silent wrong value (legacy) |
| #7071 | 487 | 1 | APPROVE | - | 1.4 | t |  |
| #7075 | 492 | 1 | APPROVE | - | 1.4 | t |  |
| #7081 | 463 | 1 | APPROVE | - | 1.5 | T | 2 nits (1 doc claim wrong); 3 pre-existing legacy bugs reported |
| #7085 | 448 | 1 | APPROVE | - | 1.7 | t |  |
| #7092 | 387 | 1 | APPROVE | - | 1.8 | T | 3 nits (2 test-strength); 4 pre-existing bugs reported |
| #7095 | 278 | 1 | APPROVE | - | 1.7 | t | tooling only |
| #7096 | 455 | 2 | APPROVE | - | 2.6 | t | nit: new claim-then-demote left open |
| #7100 | 302 | 1 | APPROVE | - | 1.8 | t | 2 nits |
| #7101 | 672 | 2 | APPROVE | - | 2.4 | t | 4 nits design |
| #7103 | 582 | 2 | BLOCKER | REAL | 324.7 | B | user escape/unescape silently replaced by builtin (wrong answer, gc+standalone) |
| #7104 | 435 | 3 | BLOCKER | REAL | 4.0 | T | head traps where base returns (all targets); +1 hypothetical finding that did not reproduce |
| #7107 | 685 | 2 | BLOCKER | REAL | 4.0 | B | strict obj[k]=v throws TypeError on arrays/typed arrays |
| #7111 | 456 | 3 | BLOCKER | REAL | 21.5 | B | DCE deletes unused own-property call, side effects lost |
| #7116 | 293 | 1 | APPROVE | - | 1.6 | t |  |
| #7118 | 996 | 2 | BLOCKER | REAL | 28.3 | B | JSON.parse literal loses fold -> wrong numbers; +6 conflict-resolution re-reviews, 0 findings |
| #7120 | 308 | 1 | APPROVE | - | 17.3 | t | (2nd source reviewer: P2 boolean brand) |
| #7121 | 2319 | 2 | APPROVE | - | 15.5 | t | (2nd source reviewer: P1 helper ownership, confirmed real) |
| #7131 | 272 | 2 | NOT MET | REAL | 4.3 | S | new pass->fail: o.n = b stores 1 instead of true |
| #7135 | 1301 | 1 | APPROVE | - | 3.0 | S | 4 nits |
| #7136 | 412 | 2 | NOT MET | CTW | 3.0 | S | callers of withdrawn fn fail at build; self-reference bug MISSED -> forward fix #7155 |
| #7138 | 452 | 2 | NOT MET | CTW | 11.8 | S | 2 claim-then-withdraw + duplicated predicate |
| #7140 | 1104 | 2 | BLOCKER | REAL | 8.8 | B | relational on dynamic operands wrong (0>=[]); +4 conflict re-reviews |
| #7142 | 859 | 2 | BLOCKER | REAL | 11.6 | B | `in` answers true for null-proto receivers (standalone/WASI) |
| #7143 | 362 | 3 | BLOCKER | REAL(CI) | 7.8 | B | 2 required checks already red (import-cycles; equivalence gate 14 regressions); r2: quality red + perf regression |
| #7146 | 782 | 2 | NOT MET | DESIGN | 6.7 | S | latent soundness hole (no runtime impact) + 2nd write walker; real defect MISSED -> merge-queue park |
| #7147 | 309 | 2 | BLOCKER | CTW | 5.5 | B | claim-then-withdraw under narrowing; not in test262 corpus |
| #7150 | 471 | 3 | BLOCKER | REAL | 8.0 | B | 4 ES5 test262 files pass->compile_error (merge queue ES5 ratchet would also catch) |
| #7151 | 613 | 3 | BLOCKER | PROOF | 25.3 | B | missing loc/func budget grant in own issue file |
| #7156 | 1685 | 2 | APPROVE | - | 9.4 | t | 5 nits |
| #7157 | 470 | 3 | APPROVE | - | 28.9 | t | nits: 2 inherited claim-then-withdraw |
| #7161 | 3834 | 2 | APPROVE | - | 10.0 | t | 4 nits |
| #7162 | 782 | 1 | APPROVE | - | 3.7 | S |  |
| #7163 | 1382 | 1 | APPROVE | - | 4.0 | S | naming nit; later parked by merge queue (A3 defect) |
| #7164 | 1137 | 4 | BLOCKER | REAL | 11.5 | B | `this` not restored after throwing callee (wrong result); compile error; r2: claim-then-withdraw (reviewer admits r1 missed it) |
| #7166 | 581 | 3 | BLOCKER | CTW | 21.7 | B | new post-claim errors; r2 same class via binding |
| #7167 | 885 | 6 | BLOCKER | PROOF | 18.2 | B | gate red (CI would catch) + tests never reach IR; r2 bytes on declined units; r3 flaky test exit |
| #7168 | 1339 | 3 | BLOCKER | REAL | 21.4 | B | string presize too small -> out-of-bounds trap; r2 class-field write, same trap |
| #7169 | 420 | 3 | BLOCKER | REAL(CI) | 7.6 | B | ToPrimitive broken, 21 test262 pass->fail; author own A/B flagged it 28 min before the review |
| #7170 | 715 | 4 | BLOCKER | CTW | 13.7 | B | own test times out (CI) + claim-then-withdraw |
| #7172 | 173 | 1 | APPROVE | - | 3.6 | S | test file not committed |
| #7173 | 863 | 1 | APPROVE | - | 30.7 | t | nit: 3 withdrawal arms newly reachable |
| #7174 | 93 | 1 | APPROVE | - | 3.5 | T | 2 doc nits |
| #7175 | 276 | 2 | BLOCKER | DESIGN | 8.6 | B | special case unnecessary; rule generalised |
| #7176 | 976 | 3 | NOT MET | REAL | 8.0 | S | element store traps; .groups/.indices wrong; 3 claim-then-demote; 14 findings |
| #7177 | 1121 | 2 | APPROVE | - | 7.8 | S | 5 quality findings fixed |
| #7178 | 656 | 2 | NOT MET | CTW | 7.2 | S | i++ after top-level for(var) claimed then fails |
| #7179 | 1156 | 2 | NOT MET | REAL(CI) | 7.5 | S | nested string var reads non-undefined; same root cause as CI equivalence regression |
| #7182 | 318 | 2 | APPROVE | - | 4.4 | S | 2 quality nits |
| #7183 | 248 | 2 | NOT MET | DESIGN | 2.6 | S | finding 1 REBUTTED (reviewer wrong); dup check; test gaps |
| #7185 | 153 | 3 | APPROVE | - | 0.9 | T | 2 should-fix (docs, coverage) + 1 wording; found pre-existing trap (#7334) |
| #7186 | 900 | 4 | NOT MET | REAL | 7.2 | S | a.constructor===Array false; 12 claim-then-demote shapes; r2 again |
| #7187 | 34 | 1 | APPROVE | - | 0.3 | T | frontmatter status |
| #7188 | 855 | 3 | NOT MET | REAL | 3.2 | S | eval-hidden mutator -> stale constant fold (regression); r2 indirect routes |
| #7190 | 554 | 1 | APPROVE | - | 0.4 | S | medium: pre-existing, not regression |
| #7192 | 1186 | 3 | NOT MET | REAL | 3.0 | S | guard skipped for search(); r2 exotic patch routes |
| #7193 | 1178 | 5 | NOT MET | REAL | 2.3 | S | parenthesized receiver bypasses use checks; 4 not-met rounds |
| #7212 | 2722 | 7 | NOT MET | CTW | 25.1 | S | rounds 4-6 each: selector predicts from-ast (claim-then-withdraw) |
| #7214 | 1633 | 4 | NOT MET | CTW | 42.2 | S | rounds 1-3 same class: claimed then withdrawn |
| #7215 | 1488 | 3 | NOT MET | DESIGN | 6.6 | S | module size 8KB->56KB; r2 two duplications |
| #7221 | 1710 | 2 | NOT MET | REAL | 6.2 | S | 4 wrong answers + 2 post-claim errors + dup scan |
| #7226 | 58090 | 3 | NOT MET | DESIGN | 6.2 | S | quality only (dead branches, leftover params); real failure MISSED -> merge-queue park |
| #7231 | 874 | 2 | NOT MET | REAL | 41.0 | S | 2 programs passing on main fail; another regression MISSED -> merge-queue park |
| #7234 | 1626 | 4 | NOT MET | CTW | 29.2 | S | rounds 1-3 units claimed then lost; design changed twice |
| #7239 | 427 | 1 | APPROVE | - | 2.7 | S | 2 should-fix design |
| #7243 | 539 | 1 | APPROVE | - | 10.1 | S | should-fix incl. 1 claim-then-fallback |
| #7246 | 498 | 2 | NOT MET | REAL | 7.9 | S | defineProperties defines earlier keys before a later TypeError |
| #7251 | 1024 | 3 | NOT MET | REAL | 12.6 | S | redeclared String wrong answer; lost unit; 5 claim-then-withdraw |
| #7263 | 1190 | 1 | APPROVE | - | open | T | 4 should-fix (2 untested guards, dups); 4 nits |
| #7268 | 1060 | 5 | NOT MET | PROOF | 5.5 | S | forged provider lists accepted; untested checks; r4 fix introduced crash under forged input |
| #7272 | 641 | 2 | NOT MET | REAL | 1.7 | S | multi-file script read sees 0 before initializer |
| #7277 | 2011 | 2 | NOT MET | REAL | 6.7 | S | two crashes; silent dynamic->number conversion |
| #7283 | 541 | 2 | NOT MET | DESIGN | 1.2 | S | quality only: dup JSDoc arm refused correct programs |
| #7286 | 1271 | 3 | NOT MET | REAL | 0.9 | S | compile() invariant crash; r2 defineProperty crash; widened wrong answer MISSED -> #7290 |
| #7290 | 488 | 2 | NOT MET | REAL(pre) | 2.2 | S | second wrong answer in same family, already on main |
| #7291 | 1433 | 4 | NOT MET | PROOF | 1.3 | S | census accepts forged provider lists; r2 three forged setups |
| #7294 | 482 | 2 | APPROVE | - | 2.5 | S | 3 should-fix |
| #7296 | 795 | 3 | NOT MET | PROOF | 0.4 | S | forged frozen collection passes plan check |
| #7300 | 1699 | 4 | APPROVE | - | 0.7 | S | r2 REAL (&&/|| returned Boolean); r3 REAL pre-existing DCE bug (-> #7359) |
| #7304 | 638 | 4 | NOT MET | REAL | 31.9 | T | r1 new compile failure on plain JS + wrong cast answers; r2 3 fns moved IR->legacy; r3 approve |
| #7305 | 2953 | 3 | NOT MET | REAL | open | T | r1 switch skips non-literal case test; delta: typeof void 0 (pre-existing); r3 invariant crash on typeof-guarded return |
| #7307 | 415 | 2 | BLOCKER | REAL | open | T | x ?? "d" loses the number (silent wrong value); 3 pre-existing defects found |
| #7310 | 359 | 1 | BLOCKER | DESIGN | open | T | hoisted var eval mislabelled as realm eval: no wrong answer today (latent) |
| #7314 | 376 | 1 | BLOCKER | CTW | open | T | linear lane: claimed then withdrawn; both versions fail to compile, only error text differs |
| #7315 | 300 | 1 | BLOCKER | PROOF | open | T | ES2025 vs ES2026 row gap, untested Float16Array row, plan omits duplicate; table has no importer |