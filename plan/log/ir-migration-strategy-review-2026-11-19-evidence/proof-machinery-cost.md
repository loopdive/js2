# Is the Prepared path's architecture the bottleneck? — evidence

Measured 2026-11-19 on main `89e47482` (checkout `/home/user/js2`), 4 cores, Node 22.23.5, `tsx`.
Branches read: `claude/7354-o` `4a316775`, `claude/7354-perf2` `ec0843a7`, `claude/7354-perf3-reservations` `dfb397e4`,
`claude/7354-integration` `bc07f68f`, `claude/es5-census-1119`. Branch trees were exported with `git archive` into
`/home/user/js2/.tmp/proofcost/tree-*` (nothing tracked was changed). All scripts and raw outputs are in
`/home/user/js2/.tmp/proofcost/`.

**Short answer: yes.** The mechanism of the Prepared path is small and mostly shared with the ordinary pipeline. What
is expensive is a layer that defends the compiler's own data structures against forgery and mutation *inside its own
process*. That layer costs 70–95 % of compile time, about 40 % of the Prepared-only source, about 85 % of its tests, and
it decides which performance fixes are allowed. It caught none of the wrong answers found in the #7354 slices.

Terms used below:

- *Mechanism (M)*: code any compiler needs (plan, lower, reserve an index, emit). Example: `emitPreparedNativeStringEquals`
  ends in `return [{ op: "call", funcIdx: … }]`.
- *Validation (V)*: a type or shape check on a value. Example: `verifyIrFunction`, `assertPreparedIrProgram`.
- *Proof machinery (P)*: code that re-proves something M already established, against a mutation or forgery of
  compiler-internal data. Example: `#verifyLayout` re-serialises every reserved function, type and global and compares
  it with a stored copy, on every index query.

---

## 1. Map: what is Prepared-only, shared, ordinary-only

### 1.1 The claim "shares only `lowerFunctionAstToIr`" is false

`src/ir/program-source.ts:1752` calls `lowerFunctionAstToIr`. But the Prepared path also calls:

| shared piece | where the Prepared path calls it |
| --- | --- |
| IR passes `constantFold`, `deadCode`, `inlineSmall`, `monomorphize` | `src/ir/program-middleend-ir.ts:43–75`, `program-middleend.ts:22` |
| IR verifier `verifyIrFunction` | `src/ir/program-middleend-ir.ts:60`, `src/ir/program/validation.ts:357` |
| IR → Wasm instruction lowering `lowerIrFunctionBody` (`src/ir/lower-generic.ts`) | `src/ir/program-consumer.ts:889`, `program-native-invocation.ts:238` |
| binary emitter, early errors, engine validation of the module (`gateEmittedModule`, `src/compiler.ts:1478`) | `finalizePipelineModule` in `src/compiler.ts` |
| runtime body builders `src/runtime/wasmgc/values/*`, runtime manifest `src/ir/runtime/*` | resources in `src/backend/wasmgc/resources/*` |

Not shared: the selector (`src/ir/select*.ts`), the codegen-backed resolver (`src/ir/integration*.ts`) and module
assembly (`src/codegen/index.ts`). Those 12 selector/resolver files are 30,152 LOC.

Dynamic check (V8 coverage, `NODE_V8_COVERAGE`, 12 small programs compiled once per pipeline through
`src/test262/test262-prepared-entry.ts`; script `.tmp/proofcost/cov-run.mts`, analysis `cov-analyze.mjs`; unit is bytes of
executed function bodies in the esbuild-transpiled JS):

| | executed bytes |
| --- | ---: |
| executed by both pipelines | 542,495 |
| executed by Prepared only | 340,891 |
| executed by ordinary only | 2,527,490 |

So 61 % of what a Prepared compile executes is code the ordinary pipeline also executes. Largest shared files:
`from-ast.ts` 55 KB, `lower-generic.ts` 19 KB, `emit/binary.ts` 16 KB, `ir/runtime/verify.ts` 15 KB,
`ir/runtime/manifest.ts` 15 KB. Largest Prepared-only: `program-consumer.ts`, `compiler/ir-program-presentation.ts`,
`program-physical-plan.ts`, `wasm/physical/module-reservations.ts`, `backend/wasmgc/program/native-string-values.ts`,
`program-source.ts`. `select.ts` (73 KB) and `integration.ts` (68 KB) ran only for the ordinary pipeline.

Side fact from the same run: the same trivial program is a 5.8 KB module on the Prepared path and a 287 KB module on
the ordinary standalone path. The demand-driven resource reservation is a real advantage of the Prepared mechanism.

### 1.2 LOC per group

Source (`.tmp/proofcost/graph.mjs`, `classify.mjs`; `src/` is 2,080 files, 962,611 LOC):

| group | files | LOC |
| --- | ---: | ---: |
| **Prepared-only family** (`src/ir/program*`, `src/ir/program/`, `src/compiler/{ir-program,prepared}*`, `src/backend/wasmgc/`, `src/wasm/physical/`, `src/test262/`, `src/ir/source-dynamic*`, `src/frontend/`) | 182 | 45,646 |
| shared IR core: `from-ast.ts` | 1 | 17,428 |
| shared IR core: `lower-generic`, `builder`, `core/`, `passes/` | 46 | 19,633 |
| shared `src/ir/runtime/` | 25 | 10,871 |
| ordinary-only IR: `select*.ts`, `integration*.ts` | 12 | 30,152 |
| ordinary-only "prepared" bookkeeping in legacy codegen: `src/codegen/{multi-prepared,program-abi}*` | 37 | 27,982 |

Module-level reachability cannot separate the two (static import graph, `reach2.mjs`): `from-ast.ts` imports
`src/codegen/statements/control-flow.ts`, which imports `src/codegen/index.ts`, so every IR module statically reaches
all of legacy codegen. That is why the table above is by name family plus the coverage run.

Tests (`.tmp/proofcost/tests-classify.mjs`; `tests/` has 4,958 test files):

| group | files | LOC |
| --- | ---: | ---: |
| tests that import a Prepared-family module | 232 | 97,551 |
| — of which `issue-3518-*` | 145 | 58,329 |
| — of which `issue-3519..3529-*` | 51 | 24,483 |
| — of which `issue-7354-*`, `issue-7188-*`, `test262-prepared-*` | 15 | 4,743 |
| `issue-3518-*` tests that do not import it (ordinary-side "ownership" receipts) | 142 | 71,596 |
| all other tests (control) | 4,717 | 761,506 |

Test-to-source ratio of the Prepared family: 97.6K / 45.6K = 2.1 : 1.

---

## 2. Mechanism vs proof

### 2.1 Source

Rule: a function is P when its only job is to show that data handed over by another part of the compiler is still what
was issued (owner maps, snapshots, re-derive-and-compare, frozen/brand/prototype checks, censuses, inventories);
V when it checks type or shape; M otherwise. A function that plans or emits and starts with a currentness check is
split by lines.

Three measurements, all on the 182 Prepared-family files (1,388 functions, 34,864 function-body lines):

| method | M | V | P |
| --- | ---: | ---: | ---: |
| function name only (`classify.mjs`, lower bound for P) | ~75 % | ~18 % | ~8 % |
| name + line keywords (`classify.mjs`) | ~67 % | ~21 % | ~12 % |
| **hand classification of 40 functions sampled in proportion to LOC** (`sample.mjs`, seed 20261119) | **56 %** | **6 %** | **38 %** |

The hand sample is the estimate to use (n = 40, so roughly ±15 points). The keyword classifier undercounts P, because
proof code hides inside mechanism-named functions, and what it calls V is mostly currentness checking. Same classifier
on controls: legacy `src/codegen/expressions/` P 1.3 %, `src/codegen/statements/` 0.7 %, shared IR core 0.7 %,
`src/emit/` 1.2 %. So the proof layer is specific to the Prepared family (and to `src/codegen/{multi-prepared,program-abi}*`,
P 24 % by the keyword method).

Hand count of one hot file, `src/backend/wasmgc/program/native-string-values.ts` (926 lines, 722 outside declarations):
M ≈ 391 lines, P ≈ 331 lines (46 %). Concrete examples in it:

- `emitPreparedNativeStringEquals`: one line of mechanism. Before it, `requireOwnerOccurrence` → `completedOwner` →
  `tx.audited(checkCompletedOwner)` → `ownerFor` re-check the whole resource pack and that this instruction was in the
  plan.
- `planNativeStringValuePhysical` opens with
  `same(demands, collectNativeStringValueDemands(demands.program, demands.projection), "stale or mismatched demand census")`:
  it recomputes its own argument from the program and deep-compares, to prove the caller did not pass a stale or forged
  one. Taking `program` as the argument would remove the question.
- `assertNativeStringValueReservationInput` re-runs the whole planner and deep-compares with the stored plan. The
  planner therefore runs four times per compile (plan text, #7354 Perf step 2: "two setup derivations, the
  reservation check, the settle pass").
- `sharedPrototypeState()` snapshots every own property of `Object.prototype` and `Array.prototype`, so that a
  "settled" verdict is dropped if someone patched them. Its comment says the `Map`/`Set` built-ins are "TRUSTED".

Other P files, by purpose:

- `src/wasm/physical/module-reservations.ts` `#verifyLayout` (l.379): the quadratic audit of section 5.
- `src/ir/program/data.ts` `hasNativeCollectionState`: calls `Map.prototype.has`, `Set.prototype.has`,
  `WeakMap.prototype.has`, `WeakSet.prototype.has` on every plain object inside try/catch, to detect an object that is
  secretly a collection "even when the prototype was erased".
- `src/wasm/physical/owned-function-data.ts` `copy`: deep copy through captured primordials
  (`apply(setHas, active, [value])`).
- `src/compiler/prepared-provider-census.ts`: 419 lines, all but the 20-line policy function re-derive what the emitted
  module should contain and compare it with what was emitted.
- `src/test262/test262-prepared-entry.ts` `selected()`: rejects a `wholeProgram` option that is inherited, an accessor,
  or not a plain record.

The threat model is written down in `plan/issues/7321-realm-reaudit-trap-window-inside-audit.md`: a Proxy trap firing
during the compiler's own comparison. Its own words: "It cannot be reached from a compiled program, only through
compiler-internal data." PR #6924, which closed one such window, "changes no output (… 624/624 binaries …)".

### 2.2 Tests

Rule per `it`/`test` block (`tests-classify.mjs`): *source pin* = reads repository source, hashes it or calls git;
*forgery* = mutates, forges, substitutes or replays a structure and expects a refusal; *refusal* = expects a named
compile refusal; *behaviour* = compiles, runs, checks the answer; *structure* = the rest (compares plans, counts).
Classification is by regex on the block text. A spot check of 35 block titles showed some mislabels in every class, so
read the shares as rough (±10–15 points); the gap to the control is far larger than that.

| group | blocks | behaviour | forgery | refusal | source pin | structure |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| tests importing Prepared-family modules (232 files) | 2,837 | **13 %** | 34 % | 18 % | 17 % | 18 % |
| — `issue-7354/7188/prepared-entry` (15 files) | 209 | 20 % | 40 % | 31 % | 0 % | 10 % |
| control: all other tests | 33,614 | 67 % | 5 % | 4 % | 7 % | 17 % |

(Shares are of test-block LOC.) 85 of the 232 files read source text, hash it or call git.

What a "receipt" is: `tests/issue-3518-semantic-verification-ownership.test.ts` pins the SHA-256 of the text of the
`INTRINSIC_DEFINITIONS` table and re-derives the previous hash through an inverse patch ("predecessor chain").
Folding a duplicated function therefore needs a hash-checked inverse step (#7354 D1 review, item 4:
`beforeStrictEqualityFold`, 9 spans). And a duplicate was left in place because of a pin (#7354 D1 review, item 7:
"`vectorProviderMismatch` and `nativeAsyncProviderMismatch` are source-hash pinned").

The pins are not even kept green:

- `pnpm exec vitest run tests/issue-3518-runtime-program-relocation.test.ts` on main `89e47482`: **298 of 298 fail**
  ("length/SHA256: src/ir/prepared-component-dependencies.ts"), 10 s. Log: `.tmp/proofcost/vitest-relocation.log`.
- The issue file of #7365 (the quadratic reservation audit; it exists only on branch perf3-reservations): of 2,907 tests in the 43 files that name a
  reservation-audit failure, 331 already fail on main.
- Cause, from `plan/issues/7357-red-ir-pin-tests-on-main.md`: "CI runs a root test file only when a PR touches it".

---

## 3. The last 10 Prepared-path PRs merged to main

`git log --first-parent origin/main`, first-parent diff per merge, added lines classified by
`.tmp/proofcost/pr-analyze.mjs` (same rules as section 2; output `pr-out.json`). Merged 2026-11-17 04:54 to 11-18 03:56.

| PR (branch) | files | src +M | +V | +P | +decl | comments | tests: behav. | refusal | forgery | src pin | struct. | test data/helpers | plan/docs | older tests edited: files / blocks / lines |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| #7278 core-vocab-receipt | 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 21 | 1 | 30 | 83 | 1 / 3 / 52 |
| #7281 red-pins | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5 | 20 | 95 | 2 / 1 / 25 |
| #7277 d1 | 37 | 435 | 37 | 64 | 156 | 206 | 67 | 132 | 50 | 7 | 55 | 218 | 322 | 9 / 12 / 165 |
| #7283 p | 5 | 19 | 0 | 0 | 1 | 37 | 11 | 75 | 73 | 0 | 14 | 107 | 168 | 1 / 4 / 19 |
| #7286 h | 18 | 204 | 23 | 13 | 47 | 135 | 43 | 132 | 124 | 0 | 42 | 156 | 200 | 3 / 8 / 68 |
| #7290 h-loopvar | 7 | 33 | 23 | 0 | 4 | 35 | 86 | 65 | 0 | 0 | 0 | 95 | 92 | 0 |
| #7291 str | 17 | 264 | 4 | 28 | 62 | 73 | 86 | 54 | 234 | 0 | 13 | 278 | 241 | 4 / 27 / 323 |
| #7296 perf | 6 | 10 | 6 | 92 | 4 | 46 | 0 | 22 | 183 | 0 | 0 | 106 | 300 | 0 |
| #7294 logical-unused | 8 | 21 | 11 | 0 | 2 | 12 | 21 | 0 | 0 | 0 | 22 | 169 | 202 | 0 |
| #7300 tx | 25 | 197 | 5 | 3 | 51 | 101 | 168 | 130 | 37 | 1 | 123 | 297 | 283 | 7 / 11 / 55 |
| **total** | **128** | **1,183** | 109 | 200 | 327 | 645 | 482 | 610 | 701 | 29 | 275 | 1,476 | 1,986 | **27 / 66 / 707** |

- Mechanism is 1,183 of 8,023 added lines: **15 %**. Tests are 3,573 lines, of which 482 (13 %) sit in behaviour
  blocks. Plan text is 1,986 lines, more than all source code added (1,819).
- Two of the ten PRs (#7278, #7281) contain no source at all: they repair pin tests that were red on main.
- "Older tests edited" counts files that existed before the PR and are not the slice's own new test file.
  ("test data/helpers" is lines outside any `it` block, mostly program tables; part of it is behaviour data.)

**The "66–216 pinned tests" change** is #7365 (branch `claude/7354-perf3-reservations`, 2026-11-19), the fix for the
quadratic audit. From its commit messages and issue file:

| option | realm compile (their box) | pinned tests that fail |
| --- | ---: | ---: |
| before (`claude/7354-realm`) | 20.6 s | — |
| prototype: audit only at freeze and seal (`f36e81f6`) | 1.5 s | 216 |
| keep the per-read audit after seal (`5d569fa7`) | — | 186 |
| A: one audit per post-seal reader block (`c73f53a7`) | 9.2 s | 0 |
| **chosen B′** (`8371dfa1` src, `0247e42e` tests) | 3.1 s | 66 (65 re-pointed, 9 files, +176/−18, plus a new `scripts/check-pinned-refusals.mjs`) |
| B, "not built" | 1.5 s | 186 |

The src change is one file, +35/−15. The option that was twice as fast was not built because of the pin count, and the
choice needed a project-lead decision ("This changes a pinned guarantee, so it needs the lead's decision before code").

---

## 4. Cost of one new value kind / one intrinsic

Example A, merged: #7300 slice T, `js.value.to_boolean` plus the `null` kind (`5310a38b` + pins `b34ad60a`), 17 files
(15 + 2; the table folds `src/codegen/registry/imports.ts` into its first row):

| file | why |
| --- | --- |
| `src/runtime/wasmgc/values/to-boolean-body.ts` (+103) | the Wasm body (moved out of legacy `codegen/registry/imports.ts`, −155): **mechanism** |
| `src/ir/program/dynamic-value-legalization.ts` (+29) | rewrite `dyn.truthy` to the intrinsic: **mechanism** |
| `src/ir/source-dynamic-contracts.ts` (+27) | admit `null` into the dynamic value: **mechanism** |
| `src/backend/wasmgc/resources/native-dynamic-values.ts` (+25) | reserve and fill the function: **mechanism** |
| `src/ir/core/intrinsic-vocabulary.ts` | table 1: the id list |
| `src/ir/core/intrinsics.ts` | table 2: id → signature |
| `src/ir/runtime/contracts/intrinsics.ts` | table 3: the id list again (runtime features) |
| `src/ir/runtime/contracts/manifest.ts` | table 4: provider id `native.js.value.to_boolean` |
| `src/ir/runtime/dynamic-value-callables.ts` | table 5: id → runtime symbol `__is_truthy` |
| `src/backend/wasmgc/program/native-primitive-boundary-abi.ts` | table 6: `canonicalRow(id, role)` |
| `tests/issue-3518-core-vocabulary-seam.test.ts` | pin: `INTRINSIC_IDS` `toHaveLength(41 → 42)`, twice |
| `tests/issue-3518-semantic-verification-ownership.test.ts` | pin: SHA-256 of the definitions table text, catalogue length |
| `tests/issue-7354-r-provider-census.test.ts` | census forgeries for the new provider |
| `tests/issue-7354-d1-…`, `-p-…` | refusal pins that moved |
| `tests/issue-7354-t-truthiness-null.test.ts` (+233) | the behaviour test |

Example B, on `claude/7354-o`: slice Ty, two `typeof` tag tests whose runtime bodies already existed (`1ac186e0`,
`0d78e04c`, `361e97c5`): 16 files, the same six tables plus `native-string-values.ts` (a seventh place that switches on
the id).

Count: `grep -rlF '"js.value.to_boolean"' src` gives **7 source files**, one line each, for one id. Five of them
(id list, signature, feature list, symbol, ABI role) are columns of one record and could be one table.
Two are already typed `Record<IntrinsicId, …>` / `Record<DynamicValueRuntimeFeature, string>`
(`core/intrinsics.ts:209`, `dynamic-value-callables.ts:19`), so TypeScript already refuses a missing row. The length
and hash pins repeat that check by hand. The lane has found this itself: `ab4040fc` (Fa, the `function` kind) routes
every admission through "one exhaustive `admit`, so a per-kind table without a `function` row fails to compile", and
that commit touches 2 files.

---

## 5. Compile time

All through `src/test262/test262-prepared-entry.ts` with the CI worker's options (standalone, `allowJs`, `scriptGoal`).
Scripts: `.tmp/proofcost/time.mts`, `one.mts`, `prof.mjs`. "Warm" is the second or third compile in one process.

### 5.1 Times

| program | tree | compile |
| --- | --- | ---: |
| `var x = 1; x = x + 1; if (x !== 2) throw 1;` | main, Prepared | 0.26–0.31 s warm (5.8 KB) |
| same | main, 7 checks stubbed (below) | 0.085 s warm, same bytes |
| 1 string line in a function (literal + concat + length + `===`) | main | 1.3 s cold |
| 50 string lines | main / perf2 / 7354-o (first compile in the process) | 7.7 s / 3.2 s / 5.2 s (main warm: 5.2 s) |
| 200 string lines | main | **27.1 s** |
| 200 string lines | ordinary pipeline, main | 1.1 s warm |
| `function f(){ var o = { a: 1 }; return o.a; } if (f() !== 1) throw 1;` (native realm) | 7354-o | **13.0 s warm** (23.8 KB) |
| same | 7354-o merged with perf2 tip (`git merge-tree`) | 13.0 s |
| same | perf3-reservations (B′) | 3.0 s |
| same | 7354-integration | 7.9 s |
| same | 7354-o with `#verifyLayout` returning at once | **0.60 s**, same bytes (sha1 `402d14d4…`) |
| same | ordinary pipeline, main | 0.49 s warm |
| 20 object literals in one function | 7354-o / perf3-reservations / integration | 17.5 s / **28.7 s** / 33.2 s |
| same | 7354-o with `#verifyLayout` off | 2.7 s, same bytes |

The harness prelude cannot be timed: it is refused at its first gap in about 0.5 s on every tree (census of
2026-11-19: 0 of 8,717 positive ES5 files pass with the real prelude).

### 5.2 The claims

- **"~20 s with the native realm": confirmed.** 13.0 s here, 18–20.6 s on the lane's machine, for a one-literal program.
- **"Quadratic reservation audit": confirmed.** `PhysicalModuleReservations.#verifyLayout`
  (`src/wasm/physical/module-reservations.ts:379`) re-serialises every record, type, filled function and global to
  text on every reserve, fill, `physicalIndex`, `physicalIndices` and `assertCompletedReservation`. #7365's bench:
  N = 250 / 500 / 1,000 / 2,000 functions → 0.4 / 1.8 / 6.7 / 29.3 s.
- **`claude/7354-perf2` does not address it.** Its commits settle string-plan currentness checks; the realm program
  takes 13.0 s with or without its tip. `claude/7354-perf3-reservations` addresses the one-literal case (3.0 s) but
  keeps the audit in completion checks, so 20 object literals still take 28.7 s there.

### 5.3 Where the time goes (CPU profiles, `node --cpu-prof`, `prof.mjs`)

Time under the outermost proof-named function (audit, census, inventory, `requireCompleted*`, `assert*Current`,
snapshot, freeze, mismatch) against everything else:

| profile | total | under proof functions | GC | TypeScript parse/check | from-ast + IR passes + lowering + binary emit |
| --- | ---: | ---: | ---: | ---: | ---: |
| realm program ×2, 7354-o | 30.2 s | 24.2 s (80 %) | 2.7 s | 0.6 s | < 0.05 s |
| 200 string lines, main | 29.8 s | 21.1 s (71 %) | 3.2 s | 0.6 s | 0.2 s |
| trivial numeric ×8, main | 5.4 s | 1.9 s (36 %; 2.3 s is one-time module loading) | 0.35 s | 0.33 s | 0.04 s |

Top self time, realm: the `dataText` encoder closure 14.4 s, `data-snapshot.ts` 5.2 s. Strings: `hasNativeCollectionState`
6.1 s, `dataText` 5.8 s, `alloc-registry.ts` snapshot restore 5.0 s.

Stub experiment (scratch copy `tree-main-noproof`, seven one-line early returns: `#verifyLayout`,
`assertNativeStringValueReservationInput`, `checkCompletedOwner`, `ownerFor`,
`assertNativeObjectAccessRequirementsCurrent`, `authenticateCensus`, and `hasNativeCollectionState` → `instanceof`):

| program | main | stubbed | bytes |
| --- | ---: | ---: | --- |
| trivial numeric, warm | 0.28 s | 0.09 s | identical |
| 50 string lines, warm | 5.2 s | 1.5 s | identical |
| 200 string lines | 27.1 s | 6.1–7.5 s | identical |

The output does not depend on these checks. What is left at 200 lines is still mostly defensive copying
(`AllocSiteRegistry.fromSnapshot` 3.6 s self, `immutableCopy` 1.0 s), so the mechanism floor is lower again (estimate:
about 1 s, from the ordinary pipeline's 1.1 s for the same program).

---

## 6. What the proof buys

### 6.1 Bugs found in the #7354 slices, and by what

Findings in the review records of `plan/issues/7354-prepared-path-harness-prelude-milestone.md`. Eleven review rounds
returned NOT MET or a must-fix; one of them (P round 1) was code quality only and is not listed.

| finding | found by |
| --- | --- |
| D1: `f(id(true))` answered 1, node 0; an `any` returned from a `number` function crashed; `**` on `any` crashed (l.361–380) | reviewer's probe programs, run against node |
| V/G: reads of a script `var` from another script were invisible to the home proof (l.669) | review of the classifier |
| H: provenance answered "typed" for every kind it did not model (l.1102) | review |
| H: `var o = 1; Object.defineProperty(o, …)` threw an invariant (l.1150) | running a program |
| H follow-up: `var x;` in a loop body reset to `undefined` each iteration, answered `undefined`, node 5 (l.1197) | running a program |
| H follow-up: a repeated `var x;` opened a second slot (l.1239) | running a program |
| T: `bool && dyn` as a value yielded a Boolean (l.1932) | running a program |
| T: unused `a > 0 && boom(b)` never called `boom` (#7359; same wrong answer in the ordinary pipeline, in plain TypeScript) (l.1286) | running a program |
| Str round 1: "string semantics correct; the string provider census did not fail closed" (l.1393) | forgery review of the census |
| Str round 2: "three forged setups passed the census" — "In production the plan is one frozen object, so that check is not reachable" (l.1425–1430) | forgery review, through a vitest module mock |
| Perf round 1: a forged `FrozenMap` recognised by prototype alone (l.1691) | forgery review |

Eight findings are wrong answers, crashes or unsound analyses. **None was caught by a census, receipt, audit or
forgery test**; all were found by running programs against node or by reading the analysis. Three rounds were spent on
defects of the proof layer itself that no production input can reach. I found no record, in the #7354 plan, the #7106
plan or the two logs, of a census, audit or receipt catching a miscompile (grep for "caught|found|detected|revealed"
next to those words: one hit, about the audit's own ordering).

The proof layer also caused work. Slice R's plan row is "fix the receipt failure after `finalizePipelineModule` once
a native type is reserved ('altered type descriptor')", and its answer was a "detached finalization, which widens a
copy" (header of `tests/issue-7354-r-provider-census.test.ts`): the audit had rejected the pipeline's own finalization
step. And the layer cannot see a semantic error: a census compares the emitted population with the planned one, and
both come from the same lowering.

### 6.2 Would Wasm validation + IR verifier + differential runs give the same assurance?

For compile correctness, yes, and all three already exist and already run on this path: `verifyIrFunction`
(`program-middleend-ir.ts:60`), engine validation of every emitted module (`gateEmittedModule`,
`src/compiler/validation.ts`, on by default), and the "run as written, then with one wrong answer" tests of #7354 Str.
The probe sweeps in the plan (for example 438 programs, "201 equal node, 235 named refusals, 0 wrong answers,
0 invalid Wasm") are what actually established correctness per slice.

| component | verdict | reason |
| --- | --- | --- |
| IR verifier, engine validation of the module | **essential**, cheap | catch type-confused lowering before anything runs |
| named refusal at the first unsupported construct (fail closed) | **essential**, cheap | a wrong accept is a wrong answer; a compile failure is also what `negative:` tests expect |
| "strict entry": the Prepared request never reaches a legacy generator | **essential**, but a few lines | it is what makes the published IR-only figure honest; an import-boundary rule or one spy does it |
| reserve → fill → seal phases with an O(1) state check; one population check at `seal()` | useful, cheap | catches a missing or extra function once, in linear time |
| differential runs against node | **essential** | the only thing that found the wrong answers |
| per-query layout audit, owner `WeakMap`s, re-derive-and-compare "currentness", snapshot text, primordial-safe copies, prototype-state and brand checks | **ceremony** | defends against mutation of compiler-internal data by code in the same process; identical bytes without them |
| "settled verdicts" | ceremony | a cache that exists only to pay for the row above |
| provider census against forged setups | ceremony beyond the one population check | the forged inputs come only from test mocks |
| receipts (source-text SHA-256 pins, historical reconstruction) | **ceremony** | they pin where a declaration lives, not what the compiler does; 298 of them are red on main unnoticed |

None of the proof components is needed "because the output is trusted without being run": the test262 runner runs
every output, and the engine validates every module.

---

## Limits of this evidence

- The M/V/P split of source is an estimate from a 40-function sample plus two keyword classifiers; the test split is a
  regex classification. Shares are good to roughly ±10–15 points, not to the digit.
- Per-PR line classes use the keyword classifier, which undercounts P (section 2.1).
- Timings are single runs on a shared 4-core box; the ratios are large enough that this does not change a conclusion.
- The stub experiment shows identical bytes on 4 programs, not on a corpus.
- The repository is a shallow clone from 2026-10-25, so I could not date or size the origin of the #3518 machinery.
- I did not run the full test suites, and I did not verify #7365's "331 of 2,907 already fail" beyond the one file
  (298 of 298).
