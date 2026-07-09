# Compiler Consolidation Plan — structure / DRY / quality audit

**Date:** 2026-07-09 · **Author:** fable-refactor (architecture audit) ·
**Baseline:** `origin/main` @ `928c85179d105`
**Companion issues:** #3102–#3114 (all `sprint: Backlog`)
**Scope:** compiler STRUCTURE and quality only. Hard FEATURE problems are the
parallel fable-arch audit's domain — no overlap intended.

---

## 0. The doctrine: behavior-preserving or it doesn't ship

Every issue in this plan is bound by one constraint: **emitted Wasm stays
byte-identical and test262 conformance does not regress.** The enforcement
tool exists and is cheap: `scripts/prove-emit-identity.mjs` (#2710 slice 0)
hashes `sha256(emitBinary)` per `(file, target)` over a corpus across the
gc/standalone/wasi matrix. The protocol used throughout:

```
baseline → one mechanical slice → check must print IDENTICAL → commit → repeat
```

Two gaps in the tool, fixed as early slices inside the issues that need them:
the default corpus is only **13 files** (`website/playground/examples`) —
#3108/#3111 add targeted corpus roots; and the `linear` backend is **not in
the target matrix** — #3105 adds it. Refactors that cannot be proven
byte-identical (shared-state extraction in #3111 Phase 3, #3112, #3114
Phase 2) are explicitly phased so the provable phases land first and the
unprovable step can stop without stranding the rest.

Note on `src/runtime.ts` and `tests/`: neither is in the Wasm emit path, so
refactors there are byte-identical _by construction_ — the guardrail is the
vitest suite + test262 CI, and those two are therefore the safest big wins.

---

## 1. What the code actually measures (2026-07-09)

### 1.1 Size

- `src/`: **246 files, 309,130 LOC**. 13 files > 5,000 LOC; 28 files > 3,000.
- `tests/`: 1,923 files, **292,655 LOC**.
- **27 top-level functions ≥ 1,000 lines.** The leaders:

| Function                    | Lines      | File                                  |
| --------------------------- | ---------- | ------------------------------------- |
| `compileCallExpression`     | **12,210** | codegen/expressions/calls.ts:4190     |
| `ensureObjectRuntime`       | **6,960**  | codegen/object-runtime.ts:176         |
| `resolveImport`             | **6,517**  | runtime.ts:7560                       |
| `ensureNativeStringHelpers` | **4,851**  | codegen/native-strings.ts:215         |
| `compilePropertyAccess`     | 3,183      | codegen/property-access.ts:3458       |
| `compileBinaryExpression`   | 3,015      | codegen/binary-ops.ts:253             |
| `compileNewExpression`      | 2,930      | codegen/expressions/new-super.ts:2546 |
| `ensureAnyHelpers`          | 1,815      | codegen/any-helpers.ts:846            |

### 1.2 Regrowth (the meta-problem)

Splits don't stick. `codegen/index.ts`: 14,344 (#1013, Apr 10) → **6,368**
after the split (Apr 25, #1172 audit) → 14,379 (Jun 27) → **16,566** (Jul 9).
Last-12-days growth of the four giants (`git show bf56e3060:<f> | wc -l`):

| File                         | Jun 27 | Jul 9  | Δ      |
| ---------------------------- | ------ | ------ | ------ |
| codegen/expressions/calls.ts | 15,292 | 17,246 | +1,954 |
| codegen/index.ts             | 14,379 | 16,566 | +2,187 |
| codegen/object-runtime.ts    | 7,834  | 9,726  | +1,892 |
| runtime.ts                   | 13,959 | 15,032 | +1,073 |

**+7.1k LOC into god-files in 12 days.** `CodegenContext` grew 120 → **282
fields** since April. The `compileCallExpression` cascade doubled (~5,800 →
12,210). Conclusion: without a ratchet (#3102), every other issue here is a
treadmill.

### 1.3 Duplication

Windowed scan (8-line normalized windows, comments/trivial excluded):
**21,389 lines — 6.9% of src/ — sit inside duplicated blocks.** Worst
self-duplication: `codegen-linear/runtime.ts` **24%** (map/set/numeric-map/
numeric-set are 4 near-copies of one hash-probe runtime),
`parse-number-native.ts` 26%, `array-methods.ts` 14%. Named idioms with
copy-counts: throw-error guard ×17 (calls.ts), counter-loop scaffold ×12+9+9
(array-methods, json-runtime, json-codec), proxy guard ×12 (object-runtime),
hash-probe advance ×10 (codegen-linear). Cross-file pairs: declarations↔index
55 windows, assignment↔property-access 46, literals↔object-ops 46.
Supporting boilerplate: **514 `ensureLateImport` sites** re-declaring import
signatures inline; 1,463 `__extern_*` refs across 51 files; 400
`ctx.standalone` branches; 186/153/85 sites for the string-const/throw trio.

### 1.4 Quality debt

- Casts: **10,678 `as Instr`** single-asserts (CLAUDE.md still claims "few
  computed-op sites"), 104 `as Instr[]`, 129 regrown `as unknown as Instr`,
  341 `as unknown as` total, 579 `as any`.
- **128 exported symbols referenced nowhere** else in src/tests/scripts
  (conservative textual scan).
- Layering: **6 `src/ir/` files import `src/codegen/`** (25 import lines;
  `ir/integration.ts` alone imports 17 codegen modules — was 2 in April).
- 109 distinct `ensureXxx` helper families each hand-rolling memoization onto
  CodegenContext; 226 raw `ctx.mod.*.push` sites.
- Tests: **132 files define a private `compileAndRun`** in ≥10 divergent
  signatures; 793 files hand-roll instantiate boilerplate; `tests/helpers/`
  contains one 19-line file.

---

## 2. Ranked plan

Ranking = (LOC-impact × safety) / effort, with safety dominating per the
behavior-preservation doctrine. Tier 1 is provably-safe motion/tooling with
big payoff; Tier 3 needs design (model: fable) and is phased to stay safe.

| Rank | Issue                                                                                                                               | Target                                                                                                           | Est. LOC delta                                        | Safety                                                                                                    | Effort / model |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------- |
| 1    | **#3102** LOC regrowth ratchet (`check:loc-budget`)                                                                                 | CI gate + baseline; per-function ceilings for the 5 worst                                                        | +200 tooling; freezes ~75k of god-file growth         | trivial (tooling only)                                                                                    | S / opus       |
| 2    | **#3103** Split `runtime.ts` (15,032) by concern; `resolveImport` (6,517-line switch) → handler maps                                | `src/runtime/{imports/*,wrap-host,to-primitive,polyfills,wasi-polyfill,instantiate}.ts`; barrel keeps public API | −300…−500; no module >2k                              | **not in emit path** — bytes identical by construction                                                    | L / opus       |
| 3    | **#3104** Re-split `codegen/index.ts` (16,566) into subsystem modules                                                               | wasi/, registry/late-import-suites, extern-registry, emit-exports, hoist-scan; driver <3k                        | ~0 motion, −400…−800 follow-up                        | pure motion, identity-proven per region; **late-import region waits for #2710**                           | L / opus       |
| 4    | **#3105** Emit-idiom builder library (throw-guard, counter-loop, proxy-guard, hash-probe, + linear target for the proof tool)       | `codegen/emit-idioms.ts` + linear twin                                                                           | **−1,200…−1,800**                                     | identity-proven per idiom×file slice                                                                      | M / opus       |
| 5    | **#3106** Host-import signature registry (514 sites)                                                                                | `HOST_IMPORT_SIGS` table + `ensureKnownImport` in registry/imports.ts                                            | **−1,800…−2,200** + kills signature-drift bug class   | identity-proven; **after #2710**                                                                          | M / opus       |
| 6    | **#3107** Cast-debt codemod (10,678 `as Instr` …)                                                                                   | `satisfies`/plain literals; ≤50 documented computed-op casts                                                     | ~0 LOC; restores type-checking on every instr literal | type-level only — erased at compile time                                                                  | M / opus       |
| 7    | **#3108** Decompose giant `ensure*` emitters (6,960 / 4,851 / 1,815 / 1,273)                                                        | object-runtime/ + native-strings sections, ordered-call orchestrator + explicit emit-context                     | ~0 motion, −500…−900 dedup                            | emission-ORDER-sensitive → identity proof is precisely the right oracle; needs corpus extension (slice 0) | L / opus       |
| 8    | **#3109** Test-helper consolidation (132 dup `compileAndRun`)                                                                       | `tests/helpers/compile.ts`, batch migration                                                                      | **−2,000…−3,500** (tests)                             | zero compiler changes                                                                                     | M / opus       |
| 9    | **#3110** Dead-export sweep (128 candidates + dead fields)                                                                          | demote→delete in batches                                                                                         | **−1,000…−2,500**                                     | tsc + vitest sufficient                                                                                   | S / opus       |
| 10   | **#3113** IR↔codegen layering (js-tag below IR; integration.ts → codegen/ir-bridge; CI boundary guard)                              | zero `codegen` imports in `src/ir/`                                                                              | ~0 motion; enforced boundary                          | pure motion + import rewrites, identity-proven                                                            | M / opus       |
| 11   | **#3111** Decompose `compileCallExpression` (12,210-line fn) into ordered call-shape probes                                         | `expressions/call-shapes/*`; dispatcher <800                                                                     | ~0 motion, −600…−1,000 dedup                          | **hard**: phased tail-first peeling, identity per branch; Phase 3 (shared state) may stop early           | XL / **fable** |
| 12   | **#3114** CodegenContext diet (282 fields; 109 memo families)                                                                       | helper-memo map (Phase 1, mechanical) + sub-contexts (Phase 2)                                                   | −300 + <150-field context                             | Phase 1 identity-provable; Phase 2 needs aliasing audit                                                   | L / **fable**  |
| 13   | **#3112** Remaining lowering god-fns (`compilePropertyAccess` 3,183, `compileBinaryExpression` 3,015, `compileNewExpression` 2,930) | same probe recipe as #3111; read/write receiver-resolution sharing                                               | ~0 motion, −500…−900                                  | **hard**; depends on #3111's proven pattern                                                               | XL / **fable** |

Aggregate direct LOC reduction across Tiers 1–2: ≈ **−7k to −11k** (src +
tests), with the god-files capped by #3102 and `codegen/index.ts`,
`runtime.ts`, `object-runtime.ts` each dropping to reviewable sizes. The
larger payoff is structural: subsystem ownership (merge-conflict surface),
type-checked instruction literals, an enforced ir/codegen boundary, and a
call-shape dispatcher that new builtins extend by adding a module instead of
another 300 lines to a 12k-line function.

### Suggested sequencing

```
now:            #3102 (ratchet) → #3103 (runtime split) → #3105 → #3109 → #3110
after #2710:    #3104 (index split) → #3106 (import registry)
anytime:        #3107 (casts, per-file), #3113 (layering, at a quiet moment for from-ast)
design first:   #3111 → then #3112; #3114 Phase 1 anytime, Phase 2 with #3108
```

---

## 3. Coordination with in-flight work (do-not-collide map)

- **#2710 — late-bind module indices (in-progress, senior-dev).** Owns
  `expressions/late-imports.ts`, `registry/imports.ts`, and the index-shift
  blocks inside `codegen/index.ts`. #3104's late-import region move and all
  of #3106 are sequenced AFTER its producer slices. Everything else here
  avoids index-representation changes entirely, and this plan adopts its
  proof tool as the universal guardrail.
- **#2855 / #2856 — IR front-end migration.** IR adoption is itself the
  consolidation that retires the direct-AST hack layer — this plan
  deliberately does NOT restructure direct-path lowering logic that the IR
  will absorb (no semantic rewrites of statements/expressions lowering).
  What this plan covers is what the IR migration does NOT: `runtime.ts`
  (host JS), `codegen-linear/`, the emitter/registry/context substrate that
  BOTH front-ends share, tests, and mechanical hygiene (casts, dead code,
  duplication). #3113 actively helps #2855 by giving the IR a clean
  downward-only dependency cone. #3111/#3112 are the one judgment call: the
  call/member cascades are direct-path code the IR will eventually own —
  but at +160 LOC/day growth and `external-call`/`body-shape-rejected`
  buckets still >0, they will be load-bearing for quarters; tail-first
  modularization keeps them maintainable without betting against the IR
  (pure motion, no semantic investment).
- **Prior art disposition.** #1172 (modularity audit, Apr 25): findings
  directionally valid, ALL line anchors and counts stale (index.ts 2.6×,
  context fields 2.4×, `ir/integration` imports 9× worse); its slices are
  re-grounded and superseded by #3104 (A/B/H), #3107 (D), #3113 (E), #3114
  (F/G), and its C (walk-instructions consolidation) is folded into #2710's
  domain — recommend closing #1172 as superseded, pointing here. #1849
  (diverged copy-paste) stays open and complementary: it lists _diverged_
  duplicates needing semantic reconciliation; #3105 handles the _identical_
  scaffolds that are provable byte-identical. #1098 (patch-layer audit)
  remains a semantics-review issue, orthogonal to this structural plan.
  #1013 is done-but-regrown; #3102 is the guard it lacked.

---

## 4. Measurement appendix (reproduction)

All numbers gathered on `origin/main` @ `928c85179` (2026-07-09):

- LOC: `find src -name '*.ts' | xargs wc -l | sort -rn`
- 12-day deltas: `git show bf56e3060:<file> | wc -l` (oldest commit in the
  shallow clone, 2026-06-27) vs current.
- God functions: top-level `function` regex scan + brace-depth scan for
  runtime.ts (`resolveImport` verified by depth; the naive scan misreports a
  `$DONE` string artifact).
- Duplication: 8-line sliding-window MD5 over trimmed/space-normalized lines,
  windows <160 chars or containing comment lines excluded; per-file
  duplicated-line sets deduplicate overlapping windows.
- Casts: `grep -rnE 'as Instr[^[a-zA-Z]'` (10,678), `as Instr\[\]` (104),
  `as unknown as Instr` (129), `as any` (579).
- ensureLateImport sites: `grep -rc 'ensureLateImport(' src/codegen` (514).
- Dead exports: name-based cross-reference of 1,440 `export
function|const|class|let` decls against src+tests+scripts (over-counts
  usage → conservative dead list of 128).
- Context fields: field-line count inside `interface CodegenContext` (282)
  and `FunctionContext` (49) in `codegen/context/types.ts`.
- IR layering: `grep -rn 'from "\.\./codegen' src/ir` (25 lines / 6 files).
- Test duplication: `grep -rl 'function compileAndRun' tests` (132);
  signature histogram via `grep -rh 'function compileAndRun' | sort | uniq -c`.
