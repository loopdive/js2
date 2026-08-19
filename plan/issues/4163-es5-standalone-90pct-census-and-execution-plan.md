---
id: 4163
title: "UMBRELLA: es5 standalone → 90% — TARGET MET at 94.2% (2026-08-19); residue is a 523-row long tail, re-partitioned into 6 lanes"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-19
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: umbrella
area: codegen, conformance
language_feature: n/a
goal: es5
related: [3892, 3626, 3628, 1906, 2992, 3251, 2928, 1387, 671, 4168, 4491, 4492, 4515, 4206, 4555, 4556]
origin: "2026-08-01, goal directive: 90% test262 standalone pass rate for es5-tagged tests. Census recomputed from baselines-repo run 20260801-090441 because the committed editions artifact is frozen (#3892)."
---

# #4163 — es5 standalone to 90%: census, ceiling, and lever list

## The number is 66.3%, not 59%

The published artifact
(`website/public/benchmarks/results/test262-standalone-editions.json`) reports
ES5 standalone at **5,273 / 8,931 = 59 %**, and `plan/goals/es5.md` quotes the
same figure. **Both are stale by a week** — this is #3892 (the editions artifact
is frozen since 2026-07-25 because `baseline-summary-sync` has no test262
submodule and `generate-editions` dies silently).

Recomputed on 2026-08-01 by running the authoritative classifier against the
fresh baseline (`loopdive/js2wasm-baselines` run `20260801-090441`, gitHash
`c601e89b`):

```bash
node scripts/claim-issue.mjs --help >/dev/null   # (unrelated)
git submodule update --init --depth 1 test262
npx tsx scripts/generate-editions.ts \
  --results .test262-cache/test262-standalone-current.jsonl \
  --target standalone --output /tmp/editions-standalone-fresh.json
```

| | pass | fail | ce | total | pct |
| --- | --- | --- | --- | --- | --- |
| published (2026-07-25) | 5,273 | 3,400 | 258 | 8,931 | 59 % |
| **fresh (2026-08-01)** | **5,924** | 2,797 | 210 | 8,931 | **66.3 %** |

Fixing #3892 is a **precondition for steering this goal** — nobody should drive
a conformance push against a frozen gauge.

## Reachability: 90 % is attainable, but with almost no slack

`eval` and `with` are out of reach for standalone today (`eval` → #2928, a
bytecode-interpreter programme; `with` → #1387 / #671). Partitioning the 3,007
ES5 standalone failures by whether the **test source** actually depends on them:

| Bucket | Tests |
| --- | --- |
| fail, eval-dependent | 501 |
| fail, with-dependent | 164 |
| fail, both | 11 |
| **fail, neither (reachable)** | **2,331** |

(272 eval-using and 45 with-using ES5 tests already pass, so the dependency is
not automatically fatal.)

```
90 % target      8,038 passes      (of 8,931)
today            5,924
gap              2,114 tests
reachable pool   2,331 tests
CEILING w/o eval+with = 8,255 / 8,931 = 92.4 %
```

**So 90 % is reachable — with 217 tests of headroom.** That is the load-bearing
fact for planning: it requires closing **2,114 of 2,331 = 91 % of every
reachable ES5 standalone failure**. There is no version of this that is a few
targeted fixes. Any single lever below is worth ≤ 15 % of the gap.

If `eval` (#2928) lands, the ceiling rises to ~98 % and the pressure comes off
entirely. **Landing #2928 is plausibly cheaper than closing the last 500 of the
long tail** — that trade should be evaluated explicitly before committing to the
grind.

## Lever list (reachable failures only, by directory)

| Lever | Tests | Share | Notes |
| --- | --- | --- | --- |
| **Property descriptors** — `Object/defineProperty` 331, `defineProperties` 264, `create` 142, `getOwnPropertyDescriptor` 35, `prototype` 22, `isExtensible` 16, `preventExtensions` 15, `Array/length` 18, `types/object` 14 | **857** | **37 %** | the one dominant theme |
| `built-ins/String/prototype` | 194 | 8 % | |
| `built-ins/Function/prototype` | 117 | 5 % | overlaps #4168 |
| annexB hoisting (`global-code` 111, `function-code` 96) | 207 | 9 % | B.3.3 semantics |
| `language/statements/function` | 58 | 2 % | |
| `built-ins/Array/prototype` | 53 | 2 % | |
| `built-ins/RegExp/prototype` | 46 | 2 % | + 44 `__module_init` null-derefs |
| everything else | ~799 | 34 % | genuine long tail |

Top single error signatures in the reachable set are all small — the largest is
132 (`Expected a TypeError to be thrown but no exception was thrown at all`, 6 %),
and the top 30 signatures together are only ~34 % cumulative. **This is a long
tail, not a few big rocks.**

### Property descriptors is the only lever worth a dedicated programme

37 % of the reachable gap sits behind one substrate. The current standalone
`Object.defineProperties` deliberately **fails loud** ("unsupported descriptor
shape in standalone mode (#1906)") whenever the receiver or the properties bag
is not a native `$Object` — see the comment at
`src/codegen/object-runtime-descriptors.ts:1281`, which is explicit that this is
a chosen refusal pending the exotic-receiver own-key MOP substrate
(**#2992 slice 2/5, #3251**). That refusal is correct — removing the gate turns
a loud failure into a silent no-op — so the path forward is the MOP substrate,
not deleting the guard.

**#2992 / #3251 are therefore the critical path for this goal.**

## Recommended sequencing

1. **#3892** — unfreeze the editions artifact. Without it the goal has no gauge.
2. **#2992 / #3251** — exotic-receiver own-key MOP; unlocks the 857-test
   property-descriptor family (37 % of the gap).
3. **#4168** — `this` receiver identity; 200-test family, lane-independent, so
   it pays into the ES5 *host* target too.
4. Decide explicitly: **#2928 (`eval`)** to lift the ceiling to ~98 %, versus
   grinding the last ~500 of the long tail against a 92.4 % ceiling.
5. Long tail: String.prototype, annexB B.3.3 hoisting, RegExp `__module_init`
   null-derefs.

## Honest status

At 66.3 % today, with a 92.4 % ceiling and a 91 %-of-reachable closure
requirement, **this is a multi-PR, multi-agent programme, not a single task.**
It should be tracked as an umbrella with the levers above as children. Anyone
picking it up should re-run the census first (the artifact is frozen, and these
numbers age).

### Reproducing the census

The scripts used are in the session scratchpad, not committed; they are ~40
lines each and re-derivable: classify every standalone JSONL record with
`parseFrontmatter` + `classifyEdition` from `scripts/generate-editions.ts`, keep
`classifyEdition() === 5`, apply the host-free pass rule
(`status === "pass" && !host_import_leak_class`, #2914), then bucket the
failures by `error_signature` and by directory. The eval/with partition greps
the **test source** for `eval(` / `with (` plus the `eval-code/` and `with/` path
segments.

---

## 2026-08-19 re-census — the 90 % target is MET (94.2 %)

Re-run against the fresh standalone baseline
(`loopdive/js2wasm-baselines`, `test262-standalone-current.jsonl`, 48,735
entries, fetched 2026-08-19 04:52), same classifier, same denominator as the
published `test262-standalone-editions.json`:

| date | pass | fail | ce | total | pct |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2026-08-01 (this issue's census) | 5,924 | 2,797 | 210 | 8,931 | 66.3 % |
| 2026-08-16 (#2668 / #4515 census) | 8,454 | — | — | 9,029 | 93.6 % |
| **2026-08-19 (this entry)** | **8,506** | 495 | 24 + 4 timeout | 9,029 | **94.2 %** |

**The goal this umbrella was opened to drive — 90 % standalone ES5 — has been
exceeded.** The 2026-08-01 body above (66.3 %, a 92.4 % ceiling, "close 91 % of
every reachable failure") is superseded and should be read as history, not as
the current plan. The 92.4 % eval+with ceiling estimate was also too
pessimistic: the corpus is at 94.2 % *with* eval and `with` still unsupported,
because far fewer ES5 rows actually depend on them than the source-grep
partition suggested.

### What is left: 523 rows, and it is a long tail

495 `fail` + 24 `compile_error` + 4 `compile_timeout`. **The largest single
error signature in the entire 523-row corpus is 13 rows.** There is no
remaining big lever; the next phase is many small root causes.

Partition dispatched 2026-08-19 as an 8-way fan-out (one lane per row group):

| rows | area | issue |
| ---: | --- | --- |
| 157 | `language/` core semantics (statements, expressions, types) | #4515 |
| 75 | `built-ins/Function`, `language/function-code`, `arguments-object` | **#4555** (new) |
| 73 | `String` / `RegExp` / `Number` / `Boolean` / `Error` / `Date` / global | #4492 |
| 62 | `built-ins/Array` + `annexB/built-ins` | **#4556** (new) |
| 56 | annexB `eval-code`/`global-code`, `language/eval-code`, `with` | #4206 |
| 100 | all of `built-ins/Object` (defineProperty 47 + defineProperties 15 + rest 38) | #4491 |

### Consequence for the goal

`plan/goals/es5.md` and any dashboard quoting **59 %** or **66.3 %** for
standalone ES5 are stale by a wide margin. The gauge-unfreeze precondition
(#3892) is no longer blocking this umbrella — the published editions artifact
now reads 8,506/9,029 and agrees with a fresh classifier run.

### Local-reproduction limitation (dev Mac, 2026-08-19)

CI's standalone lane runs the **QuickJS** eval tier. That artifact builds fine
on macOS once `brew install llvm` + `brew install lld` supply a wasm32 clang and
`wasm-ld` (and two GNU-isms in `scripts/quickjs-artifact/build.sh` are made
portable — `nproc`, `stat -c%s`), but the provider's `functionParityProbe`
canary rejects a clang-22-built artifact (returns 10, expected 11: sloppy-mode
`this` substitution through `Function#apply` does not reach the caller realm).
Matching CI's pinned **clang-18** needs Homebrew `llvm@18`, whose bottle
requires Xcode Command Line Tools at `/Library/Developer/CommandLineTools`
(absent; Xcode.app alone does not satisfy it).

The fallback **interpreter** tier does build locally and canary-verifies, but
diverges semantically from QuickJS on annexB eval-code rows, so it is not a
faithful local oracle. Practical rule for anyone working these lanes on a Mac:
**eval-rooted failures cannot be validated locally — record them as blocked
rather than chasing them.** A 551-test locally-verified-passing regression guard
(the 608-row stratified sample minus 57 rows that fail locally for this
infrastructure reason) is the clean local gate.

## 2026-08-19 — three caveats on how these numbers were measured

Recorded because each one made a lane report, or nearly report, a wrong figure.
They apply to any future push using the same method.

### 1. Some guard rows pass VACUOUSLY — a fix can look like a regression

`15.2.3.7-6-a-195` was passing because `desc.enumerable` read `undefined`, so
`propertyHelper.js`'s `verifyProperty` **skipped the enumerable check entirely**.
Fixing the underlying descriptor-field defect made that check actually run — and
the row went red. That is an **unmasking, not a regression**, and the two are
indistinguishable from the pass/fail delta alone.

Consequence: a red row in this area needs its assertion read before it is
treated as breakage. The repo already ships a detector for this shape —
`pnpm run check:test-vacuity-shapes` (`scripts/check-test-vacuity-shapes.ts`) —
which should be run alongside any conformance batch that touches property
descriptors.

### 2. Parallel runs of prototype-writing tests pollute each other

A 121-module corpus of tests that write a builtin prototype member reports
**6 failures on `main` itself** at 4 jobs, and a 7-row subset reported *0 pass*
at 7 jobs where sequential-isolated reports **7 pass**. Same tree, same commit.

The runner shards across processes and each shard runs its tests sequentially in
one process, so a test that clobbers `Array.prototype` is visible to the next
test in that shard.

**For this family the only trustworthy measurement is one test per process,
sequentially.** A parallel TOTAL is noise.

**And "one test per process" is NOT `t262run.mjs <list> 1`.** With `jobs=1` the
runner creates a single shard and runs **all** the tests in **one** process —
the worst case for pollution, not the best. The correct form is a shell loop
that spawns a fresh process per path:

```bash
while read -r t; do
  npx tsx .tmp/t262.mts "$t" | grep -q '^PASS' || echo "FAIL $t"
done < list.txt
```

A lane caught this in the integrator's own instructions; `jobs=1` and
"sequential-isolated" are opposites here.

**Isolation has a SECOND half: do not edit the tree while the run is in
flight.** A lane launched a 121-test isolated run and kept editing `src/` during
it; the tail compiled against a half-applied change and reported **3 phantom
`String.prototype.toLowerCase` failures**. Re-run with the tree frozen: zero.
The integrator hit the same trap from the other direction — a full 523-row
measurement had to be discarded because four lane merges landed underneath it
mid-run.

So the rule is: **one process per test AND a frozen tree.** A long measurement is
only valid against the commit it started on. This nearly cost a lane a false
5-row regression attribution — the integrator's first reading was 7, the real
number was 5.

### 3. Under heavy load, `compilation timeout` COMPILE_ERRORs are contention

Six concurrent lanes drove the box to load **60 on 10 cores**. The guard then
produced 5 timeout-shaped `COMPILE_ERROR`s that all pass when re-run in
isolation. Timeout-shaped guard failures under load are contention, not the
change under test — but they are indistinguishable from a real hang in the
output, so re-run before reporting.

### 4. "Which code actually runs?" is answered by the emitted module, not the source

The relational/ToPrimitive defect (#4564) was diagnosed wrong **twice** — first
as the typed dispatch, then as the `__any_lt/gt/le/ge` helpers — and the
integrator propagated the second into the issue file as settled fact. Both wrong
answers came from reading **code that could run**: first the gate conditions,
then the call graph into the helpers. Neither is evidence about what *does* run.

Reading the **emitted module** settled it in one look: those helpers are not
emitted at all for the failing programs; the comparison lowers inline to
`ToNumber f64.<op> ToNumber`.

For a "which path is taken?" question, dumping the emitted module is the cheaper
**first** move, not the last resort.

### Corollary for the guard itself

The 551-row guard is a **stratified sample of currently-passing rows**. It
therefore cannot see:

- classes of module it contains none of — notably any module that writes a
  builtin prototype member and then exercises it (this is why a clean 551/551
  coexisted with a real 5-row `String.prototype.split` regression);
- assertions that are being skipped vacuously inside a passing row.

A green guard is necessary, not sufficient. Pair it with the prototype-write
corpus (`.tmp/guard-protowrite.txt`, run isolated), the project's unit suites
**measured relative to the merge base**, and `check:test-vacuity-shapes`.
