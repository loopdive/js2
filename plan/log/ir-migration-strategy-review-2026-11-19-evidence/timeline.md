# IR migration, 2026-11-01 … 2026-11-19: where the time went

Evidence file for the strategy review. Read-only reconstruction from `git` (`origin/main` = `89e4748241`, clone shallow to 2026-10-25) and the GitHub API (`gh api`, repo `loopdive/js2`), collected 2026-11-19 14:30–15:10 UTC.

Conventions:

- **Measured** = computed here from git or the API. **Self-reported** = a number quoted from a PR body, issue or log in the repository. **Estimate** = labelled as such.
- Weeks: W1 = 11-01..07, W2 = 11-08..14, W3 = 11-15..19 (W3 has 4.6 days).
- "Day" in the git tables is the merge commit's committer date (UTC). With the merge queue this is when the merge group was built, not when it landed. The API's `merged_at` is later (section 5), so 5 PRs fall in W1 by git and W2 by API.
- Raw data sits beside this file: `commits.json`, `classified.json`, `pr_details.tsv`, `pr_events.tsv`, `pr_comments.tsv`, `cycle.json`, `sa_series.json`, `ir_deltas.json`, `wf_runs.tsv`, `jobs.tsv`, `ir_ci_series.tsv`, `bodies/`.

## 0. Headline

| | W1 | W2 | W3 | window |
|---|---:|---:|---:|---:|
| PRs merged to main, total | 148 | 68 | 67 | 283 |
| … of which bot `ci/npm-compat-refresh` PRs | 51 | 25 | 39 | 115 |
| … of which agent/human PRs | 97 | 43 | 28 | 168 |
| Direct bot commits on main (baseline refreshes) | 110 | 77 | 56 | 243 |
| `src/ir/**` lines +/− | +6,932/−2,972 | +6,767/−2,967 | +2,665/−783 | +16,364/−6,722 |
| other `src/**` | +5,938/−2,019 | +12,582/−44,000 | +1,920/−553 | +20,440/−46,572 |
| `tests/**` | +16,569/−364 | +8,408/−2,104 | +5,281/−270 | +30,258/−2,738 |
| `plan/**` + `docs/**` | +20,484/−108 | +16,607/−29 | +5,881/−31 | +42,972/−168 |
| Ordinary-pipeline metric, `summary.ir_only_pass` (all editions, of 48,232), end of week | 1,591 | 2,383 | 2,518 | 703 → 2,518 |
| Prepared-path CI figure, ES5 pass / 9,029 | not measured per merge | not measured per merge | 415 (all runs, 11-16..11-19) | flat |
| PRs serving the Prepared path (class C) | 0 | 0 | 10 | 10 |

- W2's `src` deletions are one PR: #7226 (JS-host retirement, −42,429 lines), not IR work.
- More plan/doc lines were added (42,972) than `src` lines (36,804).
- Days with no agent/human PR merged: 11-03, 11-09, 11-10. One on 11-11, one on 11-19. Nothing merged between 11-18 04:56 and 11-19 13:36 UTC. The reason is not in git or the API.

## 1. Merges and lines per day and week

Command: `git log --first-parent origin/main --since=2026-11-01T00:00:00Z --until=2026-11-20T00:00:00Z` (526 commits: 283 two-parent merges "Merge pull request #N", 243 one-parent bot commits), then `git diff --numstat -M <commit>^1 <commit>` per commit. Area rules: `src/ir/` · other `src/` · `tests/` · `plan/` + `docs/` + root `*.md` · `scripts/` + `.github/` + `.husky/` + `.claude/` · generated = `benchmarks/`, `website/public/`, `runs/`, `dashboard/`, `public/`, `*baseline*.json`, lockfiles · other = the rest (mostly `website/` source).

### Per day

| day | agent/human PRs | bot PRs (npm-compat) | bot direct commits | src/ir | other src | tests | plan+docs | scripts+ci | generated | other |
|---|---:|---:|---:|---|---|---|---|---|---|---|
| 11-01 | 9 | 8 | 23 | +1157/−607 | +807/−367 | +1414/−114 | +1755/−11 | +72/−0 | +42392/−40297 | 0 |
| 11-02 | 2 | 3 | 7 | +392/−230 | 0 | +284/−14 | +268/−0 | 0 | +14983/−15691 | 0 |
| 11-03 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | +681/−681 | 0 |
| 11-04 | 13 | 8 | 20 | +204/−24 | +1834/−202 | +6460/−5 | +2121/−13 | +228/−0 | +47170/−43475 | 0 |
| 11-05 | 18 | 16 | 22 | +1235/−439 | +856/−175 | +3374/−116 | +6103/−70 | +326/−26 | +56725/−54762 | +148/−127 |
| 11-06 | 30 | 13 | 16 | +2067/−1072 | +844/−319 | +2540/−82 | +4080/−9 | +397/−61 | +38473/−35568 | 0 |
| 11-07 | 25 | 3 | 16 | +1877/−600 | +1597/−956 | +2497/−33 | +6157/−5 | +63/−0 | +14342/−13434 | 0 |
| 11-08 | 25 | 9 | 24 | +3864/−1218 | +1510/−983 | +4193/−68 | +9100/−24 | +149/−23 | +16920/−15875 | +60/−25 |
| 11-09 | 0 | 1 | 5 | 0 | 0 | 0 | 0 | 0 | +1084/−1038 | 0 |
| 11-10 | 0 | 0 | 5 | 0 | 0 | 0 | 0 | 0 | +681/−681 | 0 |
| 11-11 | 1 | 1 | 8 | 0 | 0 | 0 | 0 | +343/−2 | +1709/−1663 | +32/−7 |
| 11-12 | 5 | 1 | 9 | +691/−501 | +445/−280 | +1237/−22 | +917/−0 | +44/−19 | +7427/−7232 | 0 |
| 11-13 | 9 | 9 | 15 | +1717/−598 | +765/−308 | +1772/−16 | +3568/−4 | +78/−1 | +27356/−25600 | 0 |
| 11-14 | 3 | 4 | 11 | +495/−650 | +9862/−42429 | +1206/−1998 | +3028/−7 | +178/−257 | +9553/−9248 | 0 |
| 11-15 | 9 | 8 | 15 | +763/−295 | +422/−53 | +789/−19 | +2561/−11 | +8/−0 | +11644/−11069 | 0 |
| 11-16 | 7 | 13 | 11 | +371/−85 | +385/−130 | +661/−4 | +1034/−20 | +82/−17 | +29880/−28553 | 0 |
| 11-17 | 8 | 13 | 16 | +1241/−282 | +842/−200 | +2552/−195 | +1376/−0 | +61/−2 | +31652/−30054 | 0 |
| 11-18 | 3 | 5 | 11 | +290/−121 | +271/−170 | +1279/−52 | +788/−3 | +8/−0 | +15027/−14157 | 0 |
| 11-19 | 1 | 0 | 3 | 0 | 0 | 0 | +128/−3 | 0 | +495/−495 | 0 |

### Per week, agent/human PRs only (bot commits excluded)

| week | PRs | src/ir | other src | tests | plan+docs | scripts+ci | generated | other |
|---|---:|---|---|---|---|---|---|---|
| W1 | 97 | +6932/−2972 | +5938/−2019 | +16569/−364 | +20484/−108 | +1086/−87 | +8/−7 | +148/−127 |
| W2 | 43 | +6767/−2967 | +12582/−44000 | +8408/−2104 | +16607/−29 | +792/−302 | +14/−92 | +92/−32 |
| W3 | 28 | +2665/−783 | +1920/−553 | +5281/−270 | +5881/−31 | +159/−19 | 0 | 0 |
| total | 168 | +16364/−6722 | +20440/−46572 | +30258/−2738 | +42972/−168 | +2037/−408 | +22/−99 | +240/−159 |

Bot traffic (class G): 358 first-parent commits, +368,172/−349,474 lines, all generated artifacts.

PR creation dates of the 168 merged agent/human PRs (API `created_at`): 11-01 13 · 11-04 10 · 11-05 17 · **11-06 40 · 11-07 33** · 11-08 8 · 11-11 4 · 11-12 3 · 11-13 8 · 11-14 3 · 11-15 7 · 11-16 7 · 11-17 9 · 11-18 1 · 11-19 1 (10 older). 43 % of the window's merged PRs were opened on two days.

## 2. Classification of the 168 merged agent/human PRs

Classified by title, issue number, branch name and files touched (`classify.py`; per-PR list in `classified.json`).

- **A** IR ordinary-pipeline slice or fix: one refusal label, one construct, one built-in family, or a bug fix in it. Sub-tags: 58 slice, 19 fix/test follow-up, 2 perf.
- **B** IR mechanism in the ordinary pipeline. Judgement call; the 9 are: #7026 (module-init chunks), #7136 #7155 #7163 #7146 #7177 #7197 (runtime-eval A1–A3 and its two fixes), #7164 (script-var closures callable), #7193 (open-object script vars as dynamic homes).
- **C** Prepared whole-program path: the 10 PRs of #7354 (#7268 R, #7272 V+G, #7277 D1, #7283 P, #7286 H, #7290 loop-var fix, #7291 Str, #7296 perf, #7294 DCE fix found there, #7300 T+X).
- **D** plan/docs only (no line outside `plan/`, `docs/`).
- **E** CI, tooling, website, test maintenance (includes #7262 "measure the IR path on every merge").
- **F** non-IR compiler work (legacy codegen fixes, linear backend, #7226 host retirement).
- **G** bots.

### Count and lines per class per week

| class | week | PRs | src/ir | other src | tests | plan+docs | scripts+ci |
|---|---|---:|---|---|---|---|---|
| A | W1 | 48 | +6581/−2911 | +2513/−1435 | +7302/−189 | +9509/−26 | +217/−2 |
| A | W2 | 25 | +5994/−2311 | +1223/−743 | +4786/−54 | +7068/−20 | +158/−21 |
| A | W3 | 6 | +1134/−380 | +422/−53 | +1025/−23 | +1918/−9 | +24/−0 |
| A | total | 79 | +13709/−5602 | +4158/−2231 | +13113/−266 | +18495/−55 | +399/−23 |
| B | W1 | 4 | +344/−59 | +530/−253 | +812/−81 | +1308/−0 | +16/−0 |
| B | W2 | 5 | +592/−162 | +642/−496 | +606/−47 | +1193/−1 | +16/−0 |
| B | W3 | 0 | 0 | 0 | 0 | 0 | 0 |
| B | total | 9 | +936/−221 | +1172/−749 | +1418/−128 | +2501/−1 | +32/−0 |
| C | W1, W2 | 0 | 0 | 0 | 0 | 0 | 0 |
| C | W3 | 10 | +1531/−403 | +1498/−500 | +4179/−136 | +2087/−0 | +85/−2 |
| D | W1 | 26 | 0 | 0 | 0 | +4895/−3 | 0 |
| D | W2 | 5 | 0 | 0 | 0 | +1359/−0 | 0 |
| D | W3 | 8 | 0 | 0 | 0 | +1696/−22 | 0 |
| D | total | 39 | 0 | 0 | 0 | +7950/−25 | 0 |
| E | W1 / W2 / W3 | 5 / 3 / 4 | 0 | 0 | +674/−189 (total) | +584/−60 | +1068/−126 |
| F | W1 | 14 | +7/−2 | +2895/−331 | +7942/−19 | +4368/−19 | +246/−0 |
| F | W2 | 5 | +181/−494 | +10717/−42761 | +2932/−2000 | +6987/−8 | +207/−257 |
| F | W3 | 0 | 0 | 0 | 0 | 0 | 0 |
| G | W1 / W2 / W3 | 161 / 102 / 95 commits | 0 | 0 | 0 | 0 | 0 (all generated) |

### Share of non-doc work that serves the Prepared-path goal

"Non-doc" = classes A, B, C, E, F. `src` churn = added + removed lines under `src/`.

| period | non-doc PRs | class C | share by count | share of IR PRs (A+B+C) | share of `src` churn |
|---|---:|---:|---:|---:|---:|
| W1 | 71 | 0 | 0 % | 0 % | 0 % |
| W2 | 38 | 0 | 0 % | 0 % | 0 % |
| W3 | 20 | 10 | 50 % | 62 % | 66 % (3,932 of 5,921) |
| 11-16..11-19 (after the redirect) | 15 | 10 | 67 % | 91 % | 90 % (3,932 of 4,388) |
| 11-17..11-19 | 11 | 9 | 82 % | 100 % | 100 % |
| whole window | 129 | 10 | **8 %** | **10 %** (10 of 98) | **11 %** (3,932 of 37,140, #7226 excluded; 4 % with it) |

- File check for hidden Prepared work before 11-16: lines touching Prepared-only modules (`src/ir/program*`, `src/ir/program/`, `src/ir/source-dynamic-*`, `src/compiler/prepared-*`, `src/compiler/ir-program-presentation.ts`, `src/backend/wasmgc/{program,resources}/`, `src/test262/test262-prepared-entry.ts`) in non-#7354 PRs: 0 in IR PRs apart from 31 incidental lines in `prepared-component-*` / `multi-prepared-*` files.
- Supporting class D/E work for the Prepared path: #7266 and #7274 (plan), #7262 (CI measurement per merge).
- The four "foundations" for the ordinary pipeline planned on 11-15/16 (#7349 function values, #7350 globals, #7352 object literals, eval) have **no merged code PR**. #7263 (#7350 G1) has been open on `hold` since 11-16; #7315 (#7350 B2a) opened 11-19.

### How much ordinary-pipeline IR code can the Prepared path reuse (measured by module)

Per #7354, the Prepared path shares only `lowerFunctionAstToIr` (`src/ir/from-ast.ts`) with the ordinary pipeline, not the selector or the codegen-backed resolver.

| `src` churn of classes A+B (28,778 lines) | lines | share |
|---|---:|---:|
| `src/ir/from-ast.ts` (shared lowering entry) | 4,119 | 14 % |
| `src/ir/*select*` (selector, ordinary only) | 4,545 | 16 % |
| `src/ir/integration*.ts` (codegen-backed resolver, ordinary only) | 658 | 2 % |
| `src/codegen/**` (legacy codegen and seams) | 5,808 | 20 % |
| other `src/ir/**` (not split into shared / ordinary-only here) | 11,146 | 39 % |
| other `src/**` | 2,502 | 9 % |

Class C (3,932 lines) put 4 % into `from-ast.ts` and 1 % into the selector; the rest is Prepared-side modules.

## 3. Metric history

### 3a. The claim "1,088 → 1,601 → 1,767" mixes two series

| figure | what it is | source |
|---|---|---|
| 1,088 (11-06) | `summary.ir_only_pass`, **all editions**, of 48,232: standalone passes compiled with zero legacy units, CI | `benchmarks/results/test262-standalone-current.json` at main commits 11-05 05:14 … 11-06 03:17; quoted in `plan/log/ir-migration-handoff-2026-11-07.md` |
| 1,601 (11-14) | **ES5 files** with zero legacy units, of 8,591 compiled (9,174 ES5 files); local census, compile-only | `plan/log/es5-ir-only-census-2026-11-14.md`, main `8e2a65b374` |
| 1,767 (11-19) | same ES5 census, +166 since 11-14, 0 lost; 1,759 of them pass | `plan/log/es5-ir-only-census-2026-11-19.md` on branch `claude/es5-census-1119` (open PR #7308, **not on main**), main `ee3fcdd610`; self-reported |

Corrected, each series on its own:

- **ES5 census (files, of 8,591):** 1,505 (17.5 %, 11-11, main `7ce9bc8fbf`) → 1,601 (18.6 %, 11-14) → 1,767 (20.6 %, 11-19). No ES5 census exists for 11-06.
- **CI all editions (`ir_only_pass`, of 48,232):** 1,088 (11-05/06) → 2,383 (11-14) → 2,518 (11-16 onward, unchanged to 11-19).

### 3b. `summary.ir_only_pass` per day (measured)

Command: `git log origin/main -- benchmarks/results/test262-standalone-current.json` (334 versions), `git show <sha>:<path>`, keyed by the `baseline_sha` each version measured. Value = last measured main commit of the day. `configuredCompilerPath` is `hybrid` in every version, so this is the ordinary pipeline.

| main commit day | measured sha | pass / 48,232 | compile errors | ir_only_pass | Δ |
|---|---|---:|---:|---:|---:|
| 10-28 | 41d01ec257 | 42,441 | 1,245 | 2 | |
| 10-29 | b8183d88e0 | 42,434 | 1,246 | 679 | +677 |
| 10-31 | 789548c24c | 42,437 | 1,246 | 703 | +23 |
| 11-01 | 00ded33ca4 | 42,436 | 1,246 | 910 | +207 |
| 11-02 | ca39930f93 | 42,431 | 1,246 | 927 | +17 |
| 11-03 | 431abed34a | 42,444 | 1,246 | 927 | 0 |
| 11-04 | 5695b5dbbc | 42,447 | 1,246 | 929 | +2 |
| 11-05 | ed76cef7a0 | 42,445 | 1,246 | 1,088 | +159 |
| 11-06 | a4284ecc17 | 42,460 | 1,241 | 1,236 | +148 |
| 11-07 | 8b409daa12 | 42,453 | 1,246 | 1,591 | +355 |
| 11-08 | a4c8bafd28 | 42,455 | 1,240 | 2,262 | +671 |
| 11-09 … 11-11 | | | | 2,262 | 0 |
| 11-12 | 566636f159 | 42,457 | 1,246 | 2,317 | +55 |
| 11-13 | 9745e46d72 | 42,455 | 1,246 | 2,367 | +50 |
| 11-14 | 7996e61a23 | 42,460 | 1,206 | 2,383 | +16 |
| 11-15 | 4ad0b21bb7 | 42,467 | 1,201 | 2,488 | +105 |
| 11-16 | 47f94f8928 | 42,466 | 1,206 | 2,518 | +30 |
| 11-17 … 11-19 | ee3fcdd610 (11-19) | 42,459 | 1,206 | 2,518 | 0 |

- Per week: W1 +888 (703 → 1,591), W2 +792, W3 +135. Per merged A/B PR: W1 17, W2 26, W3 22.
- Total standalone passes moved 42,436 → 42,459 in the window (+23).
- 2,518 of 48,232 = 5.2 %. `summary.ir_measured` = 39,011.
- `runs/index.json` does not exist at repo root. `benchmarks/results/runs/*.json` are stale (last entries from August).

### 3c. Per-PR yield, CI-measured (ordinary pipeline, all editions)

Method: consecutive baseline measurements ordered by position of `baseline_sha` on first-parent main; a change in `ir_only_pass` is attributed to the code PRs merged in between (`ir_deltas.json`).

Intervals containing one code PR (26):

| Δ ir_only_pass | PR | | Δ | PR |
|---:|---|---|---:|---|
| +222 | #7176 RegExp exec (R2+S2) | | +28 | #7037 destructuring S5 |
| +161 | #7026 module-init chunks (B) | | +25 | #7192 lever SR |
| +106 | #7033 string concat | | +17 | #7034 wrapper operands |
| +100 | #7103 ambient parseInt… | | +16 | #7214 `new Object()` |
| +58 | #7188 lever O | | +12 | #7121 native ArrayBuffer |
| +53 | #7234 own-property rows | | +10 | #7221 primitive wrappers |
| +47 | #7193 open-object script vars (B) | | +9 | #7186 lever V |
| +46 | #7024 for-head destructuring | | +9 | #7231 inert Function |
| +46 | #7170 literal array/string rows | | +3 | #7142 Object.create |
| +41 | #7246 descriptors | | +2 | #7101, #7243 |
| +40 | #7212 Object statics | | +1 | #7049, #7054 |
| +30 | #7251 string module binding | | | |
| +29 | #7147 throw with scalar | | | |

- Median about +28. 8 of 26 delivered ≤ 10.
- The six largest intervals (#7176; #7026; #7190+#7162 +147; #7167+#7185 +123; #7033; #7103) carry 859 of 1,838 (47 %).
- 33 of the 88 A/B PRs sit in an interval where the figure did not move (fixes, tests, refactors, eval A1–A3, and slices with zero yield).
- After 11-16 08:31 (#7251) the figure is flat: every later IR PR is class C and the Prepared path does not feed it.

Claimed versus measured, where a PR or doc states a number (self-reported unless marked):

| PR | claim | measured |
|---|---|---|
| #7026 | plan: about +260 `ir_only_pass` (95 % CI 130–510) | CI +161 |
| #7239 (#7345) | planned +16 files; delivered +2 (CLAUDE.md, 11-15) | CI: no change (2,383 before and after) |
| #7210 | census 11-14: +55 ES5 files | CI +55 for #7210 + #7209 together |
| #7209 | census 11-14: −8 ES5 files (a regression nothing flagged) | same interval |
| #7212 | census: +39 ES5 files | CI +40 |
| #7221 | 10 files, "down from 19 in the first cut and 28 in the plan" | CI +10 |
| #7176 | census +42 IR-only (41 ES5) | CI +222 (all editions) |
| #7177 | "+6 IR-only passes" | CI: no change |
| #7150 | title "+1 zero-legacy" | CI +57 shared with #7174 |
| #7121 / #7161 | plan: ≤ +7 files over three slices | CI +12 / +53 (shared with #7169) |
| #7164, #7166, #7172 | "yield 0, as planned" | CI: no change |
| #7192 | A/B 101 → 124 files (+23) | CI +25 |

- 16 plan-only PRs on 11-05..11-07 record a slice that was measured and stopped at yield 0 or ≤ 1 (#7069, #7093, #7110, #7112, #7113, #7119, #7139, #7141, #7144, #7145, #7148, #7152, #7153, #7158, #7165, #7159); plus #7249 (#7348 parked) and #7306 (#7353 parked).
- Census 11-14 (self-reported): of 6,990 blocked ES5 files, 1,653 carry one reason, 5,337 carry two or more.

### 3d. Prepared whole-program path (`TEST262_COMPILER_PATH=ir`)

CI figure, measured here from the log of job "merge complete IR standalone measurement" in each push-to-main run of `test262-sharded.yml` (`gh api repos/loopdive/js2/actions/jobs/<id>/logs`, 15 runs; `ir_ci_series.tsv`):

| run created | main sha | ES5 pass / total | ES5 fail | ES5 compile errors | all editions pass / total |
|---|---|---:|---:|---:|---:|
| 11-16 07:22 (run 43822939252, first per-merge run after #7262) | 643b937e47 | 415 / 9,029 | 0 | 8,614 | 4,597 / 48,735 |
| 11-16 08:50, 09:57; 11-17 00:23, 10:02, 10:54, 12:00, 14:34, 19:45, 22:11; 11-18 00:28, 01:51, 04:17, 10:25 | … | 415 / 9,029 | 0 | 8,614 | 4,597 / 48,735 |
| 11-19 10:33 (run 44506349812) | ee3fcdd610 | 415 / 9,029 | 0 | 8,614 | 4,597 / 48,735 |

- **Identical in all 15 runs**, before and after all 10 merged #7354 PRs. Zero runtime failures means nothing positive runs at all.
- #7354 (self-reported, 411-row local sample): all passes are `negative:` tests, whose expected outcome is a compile failure.
- Census 11-19 (self-reported, PR #7308 branch, main `ee3fcdd610`): real prelude **0 of 8,717 positive ES5 files pass**; all but 3 stop in the harness prelude; first gap `typeof` in `assert.js` (6,488 files). Behind a stand-in harness: 148 pass, 8,074 stop at a gap, 495 crash the compiler.
- The three earlier weekly runs (10-28, 11-02, 11-09) have artifacts but their logs print no summary; artifact zips could not be downloaded from here (blob storage is not reachable through the proxy). Not obtained.
- `benchmarks/results/test262-ir-status.json` and `test262-standalone-ir-status.json` on main still say `state: "unavailable"` (last touched by PR #6903, before the window). The per-merge figure lives only in the CI artifact `test262-ir-standalone-measurement`.

## 4. Reverts and rework

| item | count | source |
|---|---:|---|
| `Revert` commits on main, first-parent or inside PR branches | 0 | `git log origin/main --since … | grep -i revert` |
| PRs that fix or replace an earlier PR of the window | 14 of 129 non-doc | titles/branches: #7038 (→#7032), #7131 (→#7040), #7155 (→#7136), #7197 (→eval A2), #7060, #7185, #7187 (test follow-ups), #7175, #7208/#7209/#7210 (replace held #7199/#7171/#7130), #7222 (→#6944), #7290 (→#7286), #7294 (DCE bug found in #7300's review) |
| PRs closed without their own merge commit (superseded; GitHub shows "merged") | 8 | API merged list minus first-parent: #6896, #7090, #7094, #7109 (into #7226), #7130, #7171, #7199 (replaced), #6995 (boundary) |
| PRs closed unmerged | 0 found | search `is:pr is:closed -is:merged closed:>=2026-11-01` returned 0 |
| Test files red on main, repaired | 2 PRs | #7278, #7281 |
| Bot auto-park (`hold` set by `github-actions[bot]` after a merge-group failure) | 11 PRs | issue events: #7107, #7131, #7146, #7163, #7177, #7179, #7182, #7226, #7231, #7249, #7268 (W1 2, W2 6, W3 3) |
| Merge-queue entries for the 168 PRs | 216 (48 re-entries on 26 PRs; 10 PRs entered ≥ 3 times, max 6: #7118) | `added_to_merge_queue` events; 20 of the 26 landed 11-08 |
| Manual `hold` set / removed by the account | 179 / 166 | events; `hold` is the release gate: PRs open held and are released after review |
| Fresh-context review verdicts posted as PR comments (W1–W2) | 63 APPROVE, 26 BLOCKER on 37 PRs; 18 PRs got ≥ 1 BLOCKER; median 2 rounds, max 8 | `pr_comments.tsv`, header pattern "review … **VERDICT**" |
| Review rounds recorded in PR bodies (from 11-13) | 16 merged IR PRs record ≥ 1 "NOT MET" round; all 10 class C PRs record 2–5 rounds, 9 of 10 with ≥ 1 NOT MET | `bodies/*.md` |
| Sync merges of main into PR branches | 369 of the 383 non-first-parent merge commits | `git log --merges` subjects |

- GitHub review objects: 18, all `COMMENTED`, on 14 PRs; 0 inline review comments. Review happens in comments and PR bodies by the same account.
- Regression that no gate caught (self-reported, census 11-14): #7209 lost 8 ES5 IR-only files.

## 5. PR cycle time and CI

### 5a. Open → merge (all 168 agent/human PRs, not a sample)

Source: `gh api repos/loopdive/js2/pulls/<n>` (`created_at`, `merged_at`, `commits`), issue events. Week = week of `merged_at`. 99 of the 168 are in the #7131–#7318 number range.

| week | PRs | median h | p90 h | commits, median | created → first enqueue, median h | last enqueue → merged, median h / p90 h |
|---|---:|---:|---:|---:|---:|---|
| W1 | 92 | 4.6 | 41.9 | 4 | 3.0 | 0.44 / 8.7 |
| W2 | 48 | 22.0 | 43.9 | 10 | 7.6 | 1.43 / 3.4 |
| W3 | 28 | 2.0 | 10.4 | 5 | 1.7 | 0.26 / 0.3 |
| all | 168 | 5.1 | 41.9 | 5 | 3.5 | 0.38 / 7.5 |

Code PRs only:

| set | week | PRs | median h | p90 h | commits, median |
|---|---|---:|---:|---:|---:|
| A+B+C+F | W1 | 61 | 5.2 | 93.4 | 7 |
| A+B+C+F | W2 | 40 | 28.1 | 56.2 | 13 |
| A+B+C+F | W3 | 16 | 4.3 | 29.6 | 10.5 |
| IR only (A+B+C) | W1 / W2 / W3 | 47 / 35 / 16 | 5.2 / 28.8 / 4.3 | 29.6 / 43.9 / 29.6 | |
| class C | W3 | 10 | 3.2 | 7.4 | 12.5 |
| class D (docs) | all | 39 | 0.5 | 11.9 | 1 |

- Distribution of code PRs: < 2 h 9 · 2–6 h 36 · 6–24 h 36 · 1–3 d 23 · > 3 d 13 (the > 3 d group is mostly old `codex/*` PRs, up to 37.7 days).
- W2's slow median is the 73 PRs opened on 11-06/07 draining through a congested CI and queue on 11-07/08.

### 5b. What a PR triggers

From `.github/workflows/*.yml` and the runs of two PR heads (#7300, #7286):

| workflow | on `pull_request` | on `merge_group` | measured duration |
|---|---|---|---|
| CI (`ci.yml`): `quality`, 7 equivalence shards, `linear-tests`, **8 `issue-tests-shard`**, gates | all jobs, when code changed | all jobs; the non-required ones are cancelled once the group merges | PR: 102–103 min wall on a quiet day (11-05, 11-17), about 580–620 job-minutes. `quality` 8–14 min, equivalence shards 3–11 min |
| Test262 Sharded | no shards (designed no-op: 22 jobs, 17 skipped) | 102 standalone shards (123 jobs) when `src/**` changed | PR: 1–3 min. Merge group: 13.7 min wall, about 630 job-minutes, on a quiet day |
| Test262 Sharded on `push` to main | | | 4–5 min wall, 120–150 job-minutes; includes the 102-shard Prepared-path measurement since #7262 |
| native-messaging smoke | yes | | 11 min |
| Landing four-lane backend evidence | yes | | 6 min |
| Cross-backend parity, Porffor canary, Porffor A/B, Test262 PR stub, CLA, arm-merge, stack-retarget, "PR #N" | yes | | ≤ 2 min each |

- **The 102 minutes are one job family.** `issue-tests-shard` runs all root tests (4,958 `tests/*.test.ts` files today; 113 added in the window) in 8 shards with a 100-minute step timeout. In every sampled code-PR run the slowest shard ends at 101.0–101.2 min, i.e. at the timeout. `scripts/issue-tests-baseline.json` does not exist, so the step runs in seed mode (`continue-on-error`) and the job still reports success.
- `issue-tests-shard` is not a required check, but `auto-enqueue` fires on completion of the `CI` workflow (or a 30-min cron), so a code PR push normally waits the full 102 min before it can be enqueued.
- In the merge group the required checks finish in about 15–17 min (`ci.yml` merge-group runs are cancelled at 15.0–17.7 min when the group lands).

### 5c. Run durations by day (`updated_at − run_started_at`, completed runs)

Source: `gh api repos/loopdive/js2/actions/workflows/<wf>/runs?created=<day>` (`wf_runs.tsv`, 912 runs).

| day | workflow, event, conclusion | n | median min | p90 min |
|---|---|---:|---:|---:|
| 11-05 | CI, pull_request, success | 44 | 15.2 | 102.4 |
| 11-05 | Test262, merge_group, success | 37 | 1.4 | 18.3 |
| **11-07** | CI, pull_request, success | 184 | **127.2** | **238.7** |
| **11-07** | CI, pull_request, failure | 22 | 218.1 | 256.9 |
| **11-07** | Test262, merge_group, success | 45 | 29.2 | 71.8 (max 277) |
| **11-07** | Test262, pull_request, cancelled (superseded by a new push) | 63 | 50.5 | 101.4 |
| 11-17 | CI, pull_request, success | 27 | 102.3 | 102.8 |
| 11-17 | Test262, merge_group, success | 22 | 1.3 | 14.8 |
| 11-19 (to 15:00) | CI, pull_request | 3 done, 36 not finished | 17.7 | 114.9 |

CI workflow runs created per day: 11-05 130 · 11-07 283 · 11-17 72 · 11-19 41 by 15:00.

### 5d. Job queue time (job `created_at` → `started_at`), sampled runs

Source: `gh api …/actions/runs/<id>/jobs` for 56 sampled runs (`jobs.tsv`, 1,935 jobs). All jobs run on `ubuntu-latest`.

| day | run type | job queue time |
|---|---|---|
| 11-17 (quiet) | CI PR, Test262 merge group | median 0.0 min, max 0–4.9 min |
| 11-07 (busy) | CI PR (5 runs) | medians 0.0 / 3.5 / 7.4 / 16.4 / 55.7 min; max 68.7 min; wall up to 227.7 min |
| 11-07 (busy) | Test262 merge group (3 full runs) | medians 8.4 / 19.6 / 26.4 min; max 58.9 min; wall 29–72 min for 13 min of work |
| 11-19 afternoon | CI PR (5 unfinished runs) | started jobs waited median 14.6–16.3 min, max 39.1 min; in 3 runs 19 of 21 jobs had not started after 15–25 min |

### 5e. State of the runners on 2026-11-19, 14:53 UTC

Source: `gh api repos/loopdive/js2/actions/runs?status=queued|in_progress`.

- **120 runs queued** (API `total_count` 121), 18 listed in progress (`total_count` 68), 11 pending.
- Queued by workflow: CI 27 · CLA Check 16 · Test262 PR stub 14 · Test262 Sharded 13 · Cross-backend parity 7 · stack-retarget 6 · others 37.
- Oldest still-running CI PR run started 13:15 (98 min); oldest queued CI run was created 13:59 (54 min waiting). Even 20-second jobs (CLA Check) were queued.
- Cause visible in the data: 15 PRs were opened between 12:43 and 14:53, each triggering about 12 workflows, and several were pushed again.

## 6. Open PRs (2026-11-19 15:01 UTC)

Source: `gh api repos/loopdive/js2/pulls?state=open` plus per-PR detail (`open_now.tsv`, `open_detail.tsv`).

| | count |
|---|---:|
| Open PRs | 19 (18 agent, 1 bot #7317) |
| Labelled `hold` | 17 (all by the account; none is a bot park) |
| Not held | 2: #7317 (bot), #7304 (`clean`, open 34 h, 15 commits, 6 comments) |
| Draft | 1 (#6990, open 20 days, `dirty`) |
| Base branch other than `main` | 0 |
| Logically stacked (body says the branch contains another open PR) | 1: #7320 on #7307. #7305 waits on #7304; #7315 names a follow-up stacked on an unpublished branch |
| Opened today (since 12:43 UTC) | 16 |
| Older | #7304 (1.4 d), #7263 (3.3 d), #6990 (20 d) |
| `mergeable_state` | behind 13 · blocked 2 · unstable 2 · clean 1 · dirty 1 |

By topic (titles/branches):

- Prepared path (#7354 slices, crashes, realm, eval refusal): #7305, #7309, #7310, #7312, #7314, #7319, #7321 (7 PRs; +5,785/−1,152 lines).
- Ordinary-pipeline fixes and refusals: #7304, #7307, #7311, #7313, #7316, #7318, #7320 (7).
- Foundation #7350 (built-in globals): #7263, #7315 (2).
- Tooling: #7308 (census scripts and lists, +10,481 lines).
- Other: #7317 (bot), #6990 (old draft).

## 7. Not obtained, and caveats

- Prepared-path CI figures before 11-16: logs carry no summary and artifact downloads are blocked here.
- Why no PR merged on 11-03, 11-09, 11-10 and for 33 h on 11-18/19: not visible in git or the API.
- Agent or token cost per PR: not in git or the API.
- Class A versus B is a judgement by title; the nine B PRs are listed in section 2 so the split can be redone.
- Per-PR CI yields are exact only for the 26 single-PR intervals; the others are shared between the PRs named.
- The ES5 census numbers (1,505 / 1,601 / 1,767; 0 of 8,717) are the project's own measurements, not re-run here. The CI figures (`ir_only_pass`, 415 / 9,029) were read directly from committed artifacts and job logs.
- Run-level durations in 5c include job queue time; 5d separates it for the sampled runs only.
