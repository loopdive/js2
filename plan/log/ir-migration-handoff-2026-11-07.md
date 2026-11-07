# IR migration handoff — lane C, 2026-11-07 (03:30Z)

Lead session C (`session_01D4p9zLDnzbUkfbZeVqxjkx`, Fable 5.1) with Opus
cloud lanes R7–R14 and one fresh-context Opus reviewer per PR. Coordination
with the other lanes (A, B, L, Root, Shepherd, the #7106/#7127/#7128/#2949
owners) happens only on PR #6583.

## Goal and metric

Goal: complete the IR path migration and get test262 running on it.
Metric: `summary.ir_only_pass` in `benchmarks/results/test262-standalone-current.json`
(standalone test262 passes whose compile has zero legacy units, harness
included).

| when | main | ir_only_pass |
| --- | --- | ---: |
| 2026-11-06 00:00Z | — | 1088 |
| 2026-11-06 04:18Z (after #7103) | — | 1188 |
| 2026-11-06 21:10Z | d28280a0 | 1190 |
| 2026-11-07 03:30Z | b631a4bc | 1190 (nothing of this session's compiler work has merged yet — all of it sits in the queue or in held PRs below) |

**Rule adopted 2026-11-07 02:40Z:** only files that PASS on standalone count.
Every census and every yield claim carries a `standalone_pass` column and
ranks by passing, genuinely whole-file flips (stub diagnostics are targeting,
not delivered yield).

## Release protocol (unchanged)

A C PR is released (remove `hold`, dispatch `auto-enqueue.yml`) only when:
all checks green, `mergeable_state == CLEAN` (BEHIND/DIRTY → the lane merges
`origin/main`), not draft, no bot park, and a fresh-context review APPROVE
posted as a PR comment on the exact current head (a bare main merge or a
docs-only commit keeps the approval; any code change needs a delta review).
Docs-only PRs release on green without review. Nobody enqueues directly.

## Held and queued PRs (state at 03:30Z)

| PR | issue | head | state | review | next |
| --- | --- | --- | --- | --- | --- |
| #7121 | #7274 s1 native ArrayBuffer | a84cddb15d | queued | APPROVE 6697467037 | merge |
| #7120 | #7265 bool→dynamic, dyn key | 5d5e2b078e | queued (Root released) | APPROVE 6697944335 | merge |
| #7111 | #7269 propertyHelper alias calls | 3c19e1eae9 | queued behind #7120 | APPROVE 6697813484 (delta = main merges) | merge |
| #7118 | #7267 ambient JSON.parse + statics | 2dfa907f83 | queued | delta APPROVE 6699209229 | merge |
| #7152 / #7153 / #7158 / #7144 / #7145 / #7148 | docs | — | queued / released | docs-only | merge |
| #7140 | #7272 isWritable first statement | df225dec2d | hold, 1 check left | APPROVE 6700079126 | release after #7111 |
| #7151 | #7283 five verifyProperty admissions | cfe90a6520 | hold, CI running | round-3 APPROVE 6700932072 (+docs) | release after #7140 |
| #7143 | #7277 legacy refined param slots | 961d52876b | hold, CI running | delta APPROVE 6700525113 (+docs) | release on green/CLEAN |
| #7156 | #7291 IR string builder as buffer locals | 5a12d999e5 | hold, CI running | delta APPROVE 6700897010 (+main merge) | release on green/CLEAN |
| #7147 | #7281 throw with scalar in concat | f53e3db35a | hold, 3 checks left | delta APPROVE 6699843772 (+docs) | release on green/CLEAN |
| #7150 | #7282 boolean operand ToNumber | 02954a956c | hold | BLOCKER 6700553861 fixed; delta by RV7150 pending | delta → release |
| #7142 | #7276 Object.create descriptor map | 0fa6d6a0b0 | hold | BLOCKER 6698801419 fixed (native-`in` change removed; admission narrowed) + strictness fix; delta by RV7142 pending | delta → release; #7304 issue file still owed |
| #7157 | #7288 for-head var is a module binding | 0e558eaf89 | hold, stacked on #7142 | delta APPROVE 6701393374 with nits (#7315 file, `isPatternDeclaration` dedupe) | nit push → release after #7142 |
| #7161 | #7274 s2 native DataView | 01c8e036e1 | hold, stacked on #7121 | APPROVE 6701578180 with nits (N1–N3; #7316/#7317 files) | nit push → delta confirm → release after #7121 |
| #7164 | #7287 script-var closure call via `__apply_closure` | 63018c49ce | hold | RV7164 `session_016FRcLwDhRwu4Q9YyaWL6uy` running | review → release |
| #7166 | #7305 dynamic function-value call (statement position) | 5e3f90fc4b | hold, stacked on #7164 | RV7166 `session_016FRcLwBs4ahHxeiZiEawiS` running; contract question 6700838780 still unanswered | review → release after #7164 |
| #7167 | #7294 builtin-prototype value + gOPD provider | a73828b9aa | hold | RV7167 `session_016FRcLvqWh7RZJhwkTxnwuC` running | review → release |
| #7159 | docs (census logs + measured-zero issues) | moving | hold, docs | — | release on green |
| #7165 | #7311 docs | 874ccd05e3 | hold, docs | — | release on green |
| (opening) | #7291 step 3 presize (R7), #7280 S1 (R13), #7304 native-`in` chain (R9), #7313 literal array/string rows (R11) | — | — | fresh review each | — |

Retroactive review of the already merged #6924 (realm re-audit, 2026-10-26):
RV6924 `session_016FRcLvcwQZqse4ZJAYUige`, verdict to be posted on #6924.

## Measured yield of the work in flight

| PR | zero-legacy delta (stride 40 unless noted) |
| --- | ---: |
| #7167 (#7294) | +5 stride; **0 → 101** on the 133-file corpus candidate list |
| #7157 (#7288) | +1 stride; +11 on the targeted 506-file census |
| #7140 (#7272) | −377 legacy units (isWritable ×128, verifyNotWritable ×126, verifyWritable ×123); 0 files |
| #7161 (#7274 s2) | +2 |
| #7147 (#7281) | +2 |
| #7150 (#7282) | +1 |
| #7143 (#7277) | +5 IR units, param-type-not-resolvable 978 → 776 |
| #7118, #7151, #7164, #7166 | 0 alone (composition pieces) |

## What the censuses established (all on #7159 / #6583)

1. `plan/log/ir-call-graph-closure-census.md` (R14): Step-2 call-graph
   closure (`selectIrFunctions`, select.ts ~L1325) drops every claimed
   function with an unclaimed local callee; `$DONE ← __consolePrintHandle__ ← print`
   and `makeArrayLike ← makeArray ← Array.from` are closure-blocked, but
   `$DONE`, `makeArrayLike` and the verifiers fail their own selection first.
2. `plan/log/ir-module-init-single-lever-census.md` (R11): of 508 stride
   files whose only legacy unit is `<module-init>`, 148 have exactly one
   refusal family (134 pass on standalone), 159 two. Stub-and-recheck of the
   top unowned levers gives the REAL flip counts: array-search / string
   methods with literal arguments 5 of 6 (→ #7313); `.call` borrows 3 of 5
   (→ #7312, blocked on #7294's value row); BigInt ≤ 2; class expressions
   0 of 8; `assert.throws` callbacks 0 of 6 — because an unannotated closure
   literal with no closure plan refuses whatever its body
   (`select-closure-literal.ts:47`; 54 arrow units are the structural gap,
   68 function expressions mask inner refusals). R9's probe (#7314): even
   with every arrow planned, 0/170 module-init-only files flip — module
   storage (46), idents (32), `new X` value flow (17) co-block.
3. L's `vardecl-module-storage-unrepresentable` census (6701117870): 34
   sole-blocker files are object literals refused as `merged-declaration`
   (`Object.defineProperty(obj, …)` makes `obj` a second checker
   declaration); L's identity fix + #7280's `{}` producer = 23 files.
4. Measured-zero lanes, recorded as docs with their design and the next
   lever: #7268, #7271, #7273, #7275, #7278, #7279, #7284, #7285, #7286,
   #7292, #7293, #7295, #7297, #7298, #7299, #7301, #7302, #7303, #7308,
   #7310, #7311, #7312, #7314.

## Open decisions and dependencies

- **Function values on the dynamic carrier + call (6700838780):** asked of
  the #2949/#7127 owners with a 04:00Z deadline; #7166 (#7305) was opened
  before an answer per the wrap-up order, with the contract as recorded in
  its issue. If the owners answer differently, #7166 adapts before release.
- **#7304** (native `in` misses the implicit %Object.prototype% terminal and
  per-brand prototype names for non-$Object receivers; on base the IR
  answers `"name" in new Error("m")` as false): R9 implements (two slices,
  one PR); it gates the async-harness chain (`$DONE` branch) and is a
  correctness fix on standalone/WASI regardless.
- **Stacked order:** #7120 → #7111 → #7140 → #7151; #7142 → #7157 → #7280;
  #7121 → #7161; #7164 → #7166; #7156 → #7291 step 3; #7294 → #7312.
- **Import-cycle / boundary gates:** absolute `import-cycles-allow` ceilings
  collide across stacked PRs (seen on #7157/#7156); prefer moving the shared
  predicate to `src/shared/` (#7157 did) over a grant. New modules must be
  classified in `compiler-boundaries.json` (#7156 was red on it).
- Follow-up issues filed this session: #7289 (dynamic relational
  ToPrimitive), #7296 (legacy own-property providers vs node), #7300 (legacy
  string-builder traps), #7304, #7306 (`localIsRewritten` by text), #7307
  (split `dynamicUsesAreMoveOnly`), #7309 (arrow planner crash), #7315
  (function-arm return typing withdrawal), #7316 (legacy late length-operand
  eval), #7317 (length-tracking DataView parity).

## Lane handoffs

Appended as the lanes report (branch, head, open items, where the numbers
live).

### R8 (C-opus) — #7294 / #7282
- #7294: branch `issue-7294-ir-builtin-proto-gopd-provider` @ a73828b9aa,
  PR #7167; numbers in that lane's `.tmp/` (`base-files.json`,
  `head-files.json`, `hash-{gc,sa}-*.json`, `ab-{sa,gc}-*.txt`,
  `cand133.txt`); open: finish the 648-file A/B for the admission commit,
  equivalence gate, fresh review (running), issue Results + status done.
- #7282: PR #7150 @ 02954a956c, blocker fixed, delta review running.
- Known pre-existing gaps recorded: `throw 1` / `dynVar = null`
  claim-then-demote (#7266), `true < d` with an `any` module binding
  (#7282), legacy WASI builtin-proto identity answers wrong (#7294 notes).

### R7 (C-opus) — #7291 string builder, #7277 slots, #7300
- #7120 (#7265) released, queued. #7143 (#7277) 961d5287 approved, nits
  pushed, nothing open. #7156 (#7291 steps 1–2 + #7300 file) 5a12d999
  approved, main merged, releasing on green. **#7168** (#7291 step 3 +
  #7300 items 4/5 fixed) d52482f0, hold, fresh review RV7168
  `session_016FRcLy1dTakAnLX3UbMpoZ`; base = #7156's branch, retargets
  after #7156 merges. #7148 (#7285 docs) queued.
- Open: #7168 verdict; the codegen->ir 304 grant collides with #7157
  (whichever merges second restates base+1); #7300 items 1–3 open
  (Backlog); literal-only builder loops still 1–2.6 ms slower than legacy at
  n=2M on wasi/gc (follow-up candidate); #7285 unlock is upstream (one
  `dyn.to_string` engine with the boxed-Boolean pre-check).
- Numbers: the #7291 issue file (Progress table, review notes),
  the #7277 issue file ("Scope narrowed"), the #7300 issue file (repros), the #7285 issue file
  (census); PR bodies #7156/#7168; raw logs in that lane's `.tmp/`
  (`ab7291*.txt`, `ab7277*.txt`, `equiv7277e.log`, `equiv7291s3.log`,
  `corpus-*.txt`, `sbfix-*.txt`; bench scripts `perf3.mts`, `frac3.mts`,
  `corpus.mts`, `sbfix.mts`, `watdelta.mts`).

### R9 (C-opus) — #7287 closure calls, #7304 native `in`, #7311/#7312/#7314
- **#7164** (#7287) head 67d7f221 (main merged): fresh review BLOCKER
  6701844712 — `__apply_closure` does not restore `__current_this` when the
  callee throws (pre-existing on main for dynamic-param callees, now
  reachable for every statement-position script-var call); a `+=` carrier
  contradiction surfaces as a post-claim error once `h` goes IR; two inline
  predicates where one shared helper was planned; not-callable message from
  the declaration. Fix in progress (helper fix as its own commit).
- **#7169** (#7304) head 3180ee0d, hold: slice 1 complete (`__extern_has`
  miss tails answer `OBJECT_PROTOTYPE_OWN_NAMES` for `$Object`-rooted
  receivers; 38 standalone / 32 WASI rows fixed, 0 regressions, gc
  byte-identical); fresh review RV7169 `session_016FRcLzJvHmSJSKydzjByx2`;
  slice 2 (arrays/functions/Error/Map/Date and WASI ctor instances via the
  real terminal + a per-brand `NATIVE_REALM_CATALOG` name table — the
  `$DONE` `'name' in error` row) pending on the same branch; #7319 reserved
  for the own-props gap (fn `length`/`name`, Error `message`). Matrix
  harness `.tmp/inmatrix.mts`, TSVs `.tmp/inm-{base,head}.tsv`, base
  worktree `.claude/worktrees/base-7304`.
- #7165 (#7311 docs) hold, needs a bare main merge to read CLEAN; #7312 /
  #7314 docs on #7159 (blocked on #7294 / yield 0).

### R11 (C-opus) — propertyHelper chain, censuses, #7313
- #7111 queued; #7140 df225dec2d approved (releases after #7111); #7151
  cfe90a65 approved (after #7140); #7306/#7307 filed on the #7151 branch
  (Q owns #7306).
- **#7170** (#7313) head 1e9348b8, hold: rows for array
  `indexOf`/`lastIndexOf`/`includes` with numeric fromIndex, boolean-literal
  vecs, string search/fill static literals, `replaceAll`; `normalize`
  refused (legacy validates the form inline → needs a helper). Stride
  zero-legacy 32 → 36, 4 of 5 targets zero-legacy and passing; 745-file
  A/B 0 diffs; equivalence running; fresh review RV7170
  `session_016FRcLvsr5fXNvoV8HgMHrW`.
- Censuses on #7159: `plan/log/ir-module-init-single-lever-census.md`
  (complete refusal sets, standalone-pass column, stub-and-recheck);
  #6583 comments 6701158554 / 6701217976 / 6701292958 / 6701321558.
  Scratch: the #7302 worktree's `.tmp/` (`mi-files.json`, `mi12-*.jsonl`),
  the #7313 worktree's `.tmp/ab`, `.tmp/files-head.json`.
- Stale remote branch `issue-7303-ir-property-helper-verify-pairs`
  (deletion denied to agents).

### R12 (C-opus) — #7274 native ArrayBuffer / DataView
- #7121 (slice 1) a84cddb1 queued. **#7161** (slice 2) head e818a83c: APPROVE
  with nits 6701578180, nits N1–N3 fixed, #7316 (legacy late length-operand
  order), #7317 (length-tracking DataView wrong on both lanes), #7318
  (module-init `throw <literal>` claim-then-demote: `throwOperandAdmissible`
  is applied only by the planned-closure walk, not the module-init /
  function throw arms) filed; needs the one-line delta confirmation and a
  bare main merge after #7121 lands.
- Open: slice 3 (SharedArrayBuffer: `new SharedArrayBuffer()/(n)` via
  `emitSabConstruct` + `byteLength`, target `SharedArrayBuffer/length-is-absent.js`)
  not started; mixed-route proof not exercisable until closures (#7271).
- Numbers: the #7274 issue file ("Slice 1"/"Slice 2": measurements,
  review records, follow-ups); PR bodies; equivalence results as PR comments.

### R14 (C-opus) — #7281, #7305, docs PR #7159, censuses
- #7147 (#7281) f53e3db3 approved, awaiting release. **#7166** (#7305)
  5e3f90fc on #7164, hold: statement call through a top-level subject's own
  dynamic parameter (`ownParameterStatementCall`, also read by
  `buildLocalCallGraph`), one move-only sink reading the same predicate,
  closure-arg boxing via `functionObjectDynamicValue`; 17 probes
  row-identical, 0 post-claim; fresh review RV7166
  `session_016FRcLwBs4ahHxeiZiEawiS`; inherits the `__current_this` fix from
  #7164 and must correct its "latent on #7164" claim (not reproduced by
  RV7164). Measurements in the lane's `.tmp/` (`L-*`, `C-*`, `T-*`).
- #7159 (docs) carries 7297, 7298, 7299, 7301, 7305 (design), 7308, 7309,
  the call-graph-closure census, and this handoff; #7158 (#7295) queued.
- Blocked lanes recorded: #7298/#7299/#7301/#7308 wait on #7277, #7287,
  #7294, Symbol/RegExp value kinds, closure plans (#7314).

### R13 (C-opus) — #7276, #7288, #7280
- Pending at the time of writing: #7142 (#7276) 0fa6d6a0 + strictness fix
  (RV7142 delta running), #7157 (#7288) 0e558eaf (APPROVE with nits
  6701393374; #7315 file + `isPatternDeclaration` dedupe push pending),
  #7280 S1 PR being opened (stacked on #7157; L's merged-declaration fix is
  the dependency for 23 files), #7304 issue file.

## Retroactive review of #6924 (ordered by the project lead, 2026-11-07)

Verdict (PR #6924 comment 6702097137): **SOUND with findings.** The bug is
real and the merge closes it (31 trap points, filling and sealed phases);
intact on main b631a4bc; output unchanged (ledger identical, 624/624
binaries, equivalence clean); the PR's tests test the fix (4/6 fail before,
6/6 after). Findings: a narrower trap window inside the re-audit's own body
walk (pre-existing, compiler-internal data only) → #7321 with the proposed
copy-on-fill fix; the test pins one trap point; the review the PR body cited
was never recorded. Lesson applied this session: every review verdict is a
PR comment, cited in the PR body.
