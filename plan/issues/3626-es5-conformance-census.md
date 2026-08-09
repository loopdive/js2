---
id: 3626
title: "ES5 conformance census — root-caused work plan for the es5 goal (+ edition-classifier fix)"
status: done
completed: 2026-07-25
sprint: 77
goal: es5
priority: high
horizon: m
feasibility: medium
---

# ES5 conformance census

Census, not implementation. Measures the ES5 gap in both lanes, root-causes it,
ranks it by tests-per-fix, and states what is unreachable.

**Data source**: the CI-produced baselines in `loopdive/js2wasm-baselines`,
fetched fresh on **2026-07-25 15:54** (`scripts/fetch-baseline-jsonl.mjs`
and `--standalone`). Both lanes are post-#3468 and post-#3592, so both
de-inflations are included. All figures below are one snapshot — **no
local-vs-committed diffing** was performed anywhere in this census.

---

## 0. Two premises measured and refuted

### 0.1 The committed edition data was stale — ES5 host was not 69 %

`website/public/benchmarks/results/test262-editions.json` on `main` is dated
**2026-07-19** and reports ES5 at 9,000 / 13,075 = 69 %. Re-running the _same_
(unmodified) classifier over today's baseline gives **9,989 / 13,075 = 76 %**.
The standalone file was worse: dated **2026-07-01**, reporting 24 %; regenerated
it is 61 % under the same classifier.

### 0.2 The "ES5" bucket was not ES5 — a 2 KB read window mis-files 4,220 tests

`parseFrontmatter()` in `scripts/generate-editions.ts` reads only the **first
2,048 bytes** of a test file. If the YAML frontmatter block ends past that
offset, `content.indexOf("---*/")` returns `-1`, the file is recorded as
`noFrontmatter: true`, and `classifyEdition()` takes its "legacy test that
pre-dates YAML metadata" branch → **returns 5 (ES5)**.

Measured over the whole checkout (53,273 `.js` files):

|                                                 | count           |
| ----------------------------------------------- | --------------- |
| files with frontmatter ending past 2,048 bytes  | **4,220**       |
| files with genuinely no frontmatter             | 265             |
| files with frontmatter ending past 65,536 bytes | 0               |
| **largest frontmatter end offset in test262**   | **6,180 bytes** |

Every one of those 4,220 files was silently classified ES5. They are
disproportionately the _procedurally generated_ tests (long `info:` blocks) —
i.e. `class/dstr/private-meth-*`, `dynamic-import/namespace/*`, `await-using`,
`top-level-await`. Concretely, 450 class/private-method tests and 82
dynamic-import tests were being counted as ES5.

Fixing the window (2,048 → 65,536, ~10× the measured maximum) moves:

| edition | tests before | tests after | delta  |
| ------- | ------------ | ----------- | ------ |
| ES5     | 13,075       | **8,931**   | −4,144 |
| ES2015  | 15,386       | 17,184      | +1,798 |
| ES2020  | 1,896        | 2,012       | +116   |
| ES2022  | 4,234        | 5,790       | +1,556 |
| ≤ES3    | 273          | 273         | 0      |

The fix ships with this issue. **No pass/fail result changes** — only which
edition column a test is counted in.

**Net effect on the brief**: the ES5 target was stated as ~4,075 host failures.
The measured figure is **2,432** — 40 % smaller. Two independent errors produced
the gap: the committed file was 6 days stale (§0.1), and **654 of the 3,086
failures previously counted as ES5 belonged to the 4,144 reclassified tests** —
ES2015+ class/private-method/dynamic-import work the existing substrate queue
already owns.

### 0.3 The framing itself survives

"ES5 first is more foundational than the ES2015+ substrate queue" is **correct**.
The corrected buckets are disjoint by construction: class elements, private
fields, iterators, generators and TypedArray tests all live in ES2015+ columns
and contribute zero to the ES5 target. Only the _size_ of the ES5 target was
wrong, and it was wrong in the favourable direction.

---

## 1. Where ES5 actually stands (2026-07-25, corrected classifier)

**Host lane (JS host imports allowed):**

| bucket | pass  | fail  | ce  | total | pct      |
| ------ | ----- | ----- | --- | ----- | -------- |
| ≤ES3   | 230   | 43    | 0   | 273   | 84 %     |
| ES5    | 6,499 | 2,388 | 44  | 8,931 | **73 %** |

**Standalone lane (host-free pass definition, `--host-free`, matching the
#2879 headline and the #2097 floor):**

| bucket | pass  | fail  | ce  | total | pct      |
| ------ | ----- | ----- | --- | ----- | -------- |
| ≤ES3   | 220   | 43    | 10  | 273   | 81 %     |
| ES5    | 5,273 | 3,400 | 258 | 8,931 | **59 %** |

Both lanes use the same classifier and the same baseline date, so they are
directly comparable: standalone trails host by **1,226 ES5 tests**.

**Partition of the 2,432 host ES5 failures** (a test is counted `eval`-dependent
if it lives under `*/eval-code/` or `built-ins/eval`, or its source matches
`eval(`; `with`-dependent if under `statements/with/` or matching `with(`;
`eval` wins ties):

| partition         | tests     | pass      | fail+ce   | pass rate |
| ----------------- | --------- | --------- | --------- | --------- |
| `eval`-dependent  | 826       | 314       | **512**   | 38 %      |
| `with`-dependent  | 171       | 23        | **148**   | 13 %      |
| **reachable ES5** | **7,934** | **6,162** | **1,772** | **78 %**  |

---

## 2. Root causes of the 1,772 reachable failures

### 2.1 Method, and what these numbers are not

Grouping is by **`error_signature`** (the first failing assertion, normalised),
not by directory. A directory is a routing label; several of the path clusters
below are demonstrably _not_ one defect. Signature counts are a **floor**: a test
whose first assertion fails for reason X may also be blocked by reason Y, so
fixing X does not automatically flip it. Path clusters are a **ceiling**. Both
are given; the truth is in between and only a re-run measures it.

The nine signature families below cover **549 of 1,772** failures. The remaining
**1,223 (69 %) are diffuse** — spread across 411 path buckets with no repeating
signature. There is no single mega-fix in ES5.

| family                                                             | count     | notes                                  |
| ------------------------------------------------------------------ | --------- | -------------------------------------- |
| A3 "Expected a TypeError to be thrown but no exception was thrown" | 139       | strict-mode + descriptor validation    |
| C2 null/undefined deref reported `[in __module_init()]`            | 145       | codegen crash class, top-level         |
| A5 "Expected a ReferenceError…"                                    | 109       | 96 of these are Annex B B.3.3          |
| C1 `missing_builtin: X is not a function`                          | 58        | genuinely missing methods              |
| A1 write to non-writable silently succeeds                         | 51        | **probe-confirmed**, see 2.2           |
| B1 `accessed !== true`                                             | 38        | descriptor property read via `[[Get]]` |
| CE (compile error / timeout)                                       | 27        |                                        |
| A2 delete of non-configurable succeeds                             | 22        | **probe-confirmed**, see 2.2           |
| A4 "Expected a SyntaxError…"                                       | 5         |                                        |
| **uncovered / diffuse**                                            | **1,223** | 411 buckets                            |

### 2.1b The "1,223 diffuse" figure is partly an artifact of the GROUPING FUNCTION (#23, 2026-07-26)

**"1,223 diffuse across 411 buckets with no repeating signature" is a claim about
`error_signature`, not about the population.** If the normalisation retains
test-specific data (values, property names, indices), genuinely-shared mechanisms
scatter into singletons and read as irreducible. That is measurable, so it was
measured: the **same** failures, re-grouped at five normalisation strengths.

| normalisation                  | groups | singletons | in clusters | cluster coverage |
| ------------------------------ | -----: | ---------: | ----------: | ---------------: |
| L0 raw                         |    850 |    **632** |       1,334 |           67.9 % |
| L1 strip location              |    850 |        632 |       1,334 |           67.9 % |
| L2 + strip quoted values       |    702 |        522 |       1,444 |           73.4 % |
| L3 + strip numbers/identifiers |    646 |        474 |       1,492 |           75.9 % |
| L4 first clause only           |    499 |    **319** |       1,647 |       **83.8 %** |

**Singletons halve (632 → 319) and cluster coverage rises 67.9 % → 83.8 % purely
from coarser grouping** — no new data, same failures. So a substantial share of
the "irreducible residue" is shared-mechanism work that the census's
normalisation scattered.

**"No single mega-fix in ES5" may still hold, but "1,223 diffuse" overstates the
irreducible residue.** This sharpens §2.1 rather than contradicting it: signature
counts are a floor, **and the floor itself moves with normalisation strength.**

> **CAVEAT — L4 is one END of a range, not the right answer.** Past some
> strength, grouping stops revealing mechanisms and starts inventing them. The
> L4 cluster `Expected SameValue(«V», «V») to be true` × 69 is
> **over-normalised by construction**: L4 erases the very values that
> distinguish those failures, so it is a routing label, not a mechanism. Read
> the table as a range (L0 floor → L4 ceiling), exactly as §2.1 says to read
> signatures-vs-paths. Do not quote L4 alone.

**Cross-validation.** At L4 the top clusters land on independently-derived
census families, which is the evidence that the method is sound:

| L4 cluster                                              | n   | census family                     |
| ------------------------------------------------------- | --- | --------------------------------- |
| `Expected a TypeError to be thrown…`                    | 140 | **A3 = 139**                      |
| `An initialized binding is not created… ReferenceError` | 96  | **A5 Annex B B.3.3 = 96** (exact) |
| `accessed !== true`                                     | 38  | **B1 = 38** (exact)               |
| `null is not a function [in __module_init()]`           | 35  | C2 (145), partial                 |
| `obj[X] descriptor should not be enumerable`            | 82  | **none** — see below              |

The 82 has no census counterpart because it is **#3603 S1's own host
de-inflation** landing in the ES5 population (157 of that PR's 1,066 regressions
are ES5-classified, 2.3 % of the ES5 passing set, concentrated in
`Object/defineProperty` and `Object/defineProperties` — the two largest clusters
below, both heavy `verifyProperty` users). Numbers here therefore post-date
#3603; the census's own figures pre-date it.

> **⚠ POPULATION TRAP — do not repeat this mistake.** A first pass classified
> ES5 membership using only the edition classifier's rules 1 and 4 (`es5id:`
> frontmatter, `annexB/` path) and ran on **2,631** rows. That is the WRONG
> population: the census **partitions eval- and with-dependent tests OUT** of its
> reachable set (§1). The correct population is **1,966** (484 eval-dependent +
> 181 with-dependent were contaminating it). The contaminated run produced a
> spurious top cluster — `assert is not defined` × 184, ALL of them in
> `annexB/language/eval-code` — which looked like the largest lever in ES5 and
> was not part of the diffuse set at all. **Apply the §1 eval/with partition
> before grouping**, or the biggest apparent finding will be an excluded bucket.

Probe: `.tmp/3603/es5-regroup.mjs` (method; re-derive counts against a
current baseline before quoting).

Path clusters, for routing only (**these are not shared-mechanism claims**):

| path bucket (routing label)                 | fail | of tests in bucket  |
| ------------------------------------------- | ---- | ------------------- |
| `built-ins/Object/defineProperty`           | 273  | 1,113               |
| `built-ins/Object/defineProperties`         | 188  | 620                 |
| `annexB/language/global-code`               | 111  | 153                 |
| `annexB/language/function-code`             | 93   | 157                 |
| `built-ins/String/prototype`                | 87   | 620                 |
| `language/expressions/compound-assignment`  | 87   | 265                 |
| `built-ins/Function/prototype`              | 78   | 185                 |
| `built-ins/Object/create`                   | 76   | 314                 |
| `language/statements/function`              | 59   | 169                 |
| `built-ins/Array/prototype`                 | 45   | 123                 |
| `built-ins/Object/getOwnPropertyDescriptor` | 27   | 305                 |
| tail                                        | 481  | 411 further buckets |

### 2.2 The one mechanism that was probe-confirmed

Descriptor signatures repeat across **four independent directories**
(`defineProperty`, `defineProperties`, `create`, `getOwnPropertyDescriptor`),
which is evidence of a shared mechanism rather than a path coincidence. A direct
probe on current HEAD (`tests/probe-desc-census.test.ts`, gitignored) isolates
exactly which half is broken:

| probe                                                                         | result              | spec | verdict  |
| ----------------------------------------------------------------------------- | ------------------- | ---- | -------- |
| `defineProperty(o,'x',{value:1,writable:false}); o.x=2` → `o.x`               | **2**               | 1    | **FAIL** |
| `defineProperty(o,'x',{value:1,configurable:false}); delete o.x` → `'x' in o` | **false**           | true | **FAIL** |
| `defineProperty(o,'x',{value:1,enumerable:false})` → `Object.keys(o).length`  | 0                   | 0    | pass     |
| `defineProperty(o,'x',{value:1})` → descriptor `w,e,c`                        | `false,false,false` | same | pass     |
| `defineProperty(o,'x',{get(){…}})` → `o.x`                                    | 10                  | 10   | pass     |

**Root cause**: the descriptor _record_ is stored correctly (defaults and
accessors read back right), but the **`[[Set]]` and `[[Delete]]` internal-method
paths never consult it**. `OrdinarySetWithOwnDescriptor` does not check
`[[Writable]]`; `[[Delete]]` does not check `[[Configurable]]`. That single
statement explains the A1 (51) and A2 (22) families outright, and plausibly a
large share of A3 (139) — in strict mode a rejected `[[Set]]` must throw
`TypeError`, which is precisely "expected a TypeError, none thrown".

Confirmed floor: **73 tests**. Ceiling if the whole descriptor path cluster is
one mechanism: **564**. The honest estimate needs a post-fix re-run; do not
quote 564 as a flip count.

### 2.2.1 ⚠️ CORRECTION (2026-07-26, opus-loop-e) — §2.2 IS REFUTED. DO NOT USE IT.

**The "confirmed floor of 73" is WITHDRAWN. Both §2.2 "probe-confirmed" rows are
artifacts.** Re-measured on HEAD against the baseline jsonl + V8 controls while
implementing #739 S2. Do not re-derive the old numbers from the table above.

**A2 ("delete of non-configurable succeeds", 22) — the defect does not exist.**
HEAD is already spec-correct:
`defineProperty(o,'x',{value:1,configurable:false}); try{delete o.x}catch(e){e.name}`
→ **"threw TypeError"**, matching a V8 control. The §2.2 probe recorded
`'x' in o` → `false`; but the `delete` **throws**, so `'x' in o` never evaluated
and the recorded `false` is a **swallowed-exception artifact — the probe measured
nothing and reported a defect.** This is the `propertyHelper`/`verifyProperty`
vacuity class (#3468/#3592/#3434) landing on the census written to map that very
area. Corroboration that no mechanism is there: corpus-wide, `configurable`
failure signatures total **~16, all singletons**. A real mechanism leaves a
population behind; this one left none.

**A1 ("write to non-writable silently succeeds", 51) — real defect, but the
DIRECTION is inverted.** Corpus-wide, 18 signatures mention `writable` (~59
failures):

| direction                                        | count | note                                                             |
| ------------------------------------------------ | ----- | ---------------------------------------------------------------- |
| "Expected obj[X] **to be writable, but was not**" | 34    | properties **over**-restricted — the dominant real defect        |
| "Expected obj[name] **NOT to be writable, but was**" | 10 | the §2.2 direction — all in `{using,await-using}/fn-name-*`, i.e. explicit resource management, **not ES5 descriptors** |

So the ES5-scoped count in the claimed direction is **≤10, not 51**, and the
dominant defect points the opposite way. The §2.2 probe used an *inline-literal*
descriptor; with a *variable* descriptor HEAD already throws the correct
TypeError (#739 S1 pinning works). One unvaried axis (descriptor shape) was read
as a general claim.

**The descriptor bucket is NOT one mechanism** — which retires the "ceiling 564"
framing and confirms §2.1's own warning: `built-ins/Object/defineProperty` is
**276 failures across 102 distinct signatures**, largest **17 (6 % of the
bucket)**.

**What IS probe-confirmed** (clean A/B, only the initializer varies):

```
const d = {};           d.value = 1;  Object.defineProperty(d,'configurable',{get})  → getter FIRES  ✓
const d = { value: 1 };               Object.defineProperty(d,'configurable',{get})  → getter SILENT ✗
```

Root cause: #739 S1's representation pin lives in `collectEmptyObjectWidening`,
which only reaches **empty-`{}`** vars. A **non-empty** literal that later
receives a runtime-store-routed define stays a widened struct, the accessor
lands in the `_wasmPropDescs` sidecar, and ToPropertyDescriptor's struct-field
reader never invokes the getter — although §6.2.5.5 requires a full `[[Get]]`
per descriptor field. Same two-store bug as #739, but on the **descriptor**
object rather than the receiver. Population: family B1 `accessed !== true` = 38
ES5-scoped / 61 corpus-wide — **a floor, not a forecast.**

**Method note for whoever measures here next:** if an assertion can throw before
the value you are reading is evaluated, you are measuring the throw, not the
value. Always run a negative control that MUST report failure — several probes
in this investigation silently returned `0` from `String(boolean)` or reported
"invalid wasm" from an unrelated `typeof e` construct, and only the control
caught them.

### 2.3 Mechanical vs hard

**Mechanical** (narrow, well-understood, no representation change):

- C1 `missing_builtin` (58) — `String.prototype.split/lastIndexOf/charCodeAt`
  on non-string receivers, etc. Add/repair the method.
- A2 `[[Delete]]` configurable check (22) — one guard in the delete path.
- `built-ins/Array/length` (17), `Object/getPrototypeOf` (18),
  `expressions/new` (10 of 11 tests in the bucket) — small, self-contained.
- The `≤ES3` bucket (43) — 43 tests, already 84 %.

**Hard** (representation / substrate):

- A1 + A3 `[[Set]]` writable enforcement — this is #739's "store-unification
  (representation pinning)". Writes are lowered to direct struct-field stores
  with no descriptor consult; adding one changes the hot path. `feasibility:
hard`, and #3230 is blocked on the struct-widening split.
- C2 (145) — null deref at `__module_init`, a codegen crash class.
- Anything under `with` (148) — needs the dynamic-scope route of #1387 Tier 2.
- `eval` (512) — an entire programme (`runtime-eval` goal).

---

## 3. Cross-check against existing issues — and two false-done findings

**The ES5 gap is already almost entirely filed.** 50 open issues match ES5-area
keywords. The constraint is sequencing, not coverage. Pre-dispatch gate was run
against `origin/main`, the open-PR list (5 PRs, none in this area) and
`origin/issue-assignments`.

Live and correctly scoped:

| #                                           | status          | covers                                                              |
| ------------------------------------------- | --------------- | ------------------------------------------------------------------- |
| #739                                        | ready           | defineProperty store-unification + defineProperties two-phase apply |
| #2668                                       | in-progress     | ES5 defineProperty/defineProperties descriptor fidelity residual    |
| #2200 / #2552                               | in-progress     | Annex B B.3.3 block-level function hoisting (+ Phase 2 rework)      |
| #2666                                       | in-progress     | ≤ES3 `base[prop]` evaluation order in compound-assignment / ++ / -- |
| #2742                                       | in-progress     | `String.prototype` ToString(this) generic-receiver coercion         |
| #2747                                       | in-progress     | for-in prototype-chain enumeration + defineProperty                 |
| #3420 / #3475 / #3434                       | ready / backlog | write to non-writable silently dropped                              |
| #2726                                       | ready           | `delete` residual semantics                                         |
| #671                                        | backlog         | `with` statement support                                            |
| #1584 / #2925 / #2928 / #2929 / #1263–#1266 | mixed           | the `eval` programme                                                |

### 3.1 Two `done` issues whose area is still failing — FLAGGED, NOT REOPENED

- **#1334** "spec gap: Object.defineProperty — descriptor attribute fidelity
  (664 test262 fails, biggest single bucket)" — `status: done`, sprint 50,
  completed 2026-05-24. Today the `defineProperty` + `defineProperties` +
  `create` directories still carry **537 failures**, and the probe in §2.2 shows
  `[[Writable]]` and `[[Configurable]]` are not enforced at all. Either the issue
  was closed on a partial slice, or it was closed against a harness that could
  not fail (the `propertyHelper.js` vacuity class of #3468/#3592 lives in exactly
  this area — see #3434, "original-harness propertyHelper strict write probe
  rethrows host TypeError"). **Needs a human decision**; not reopened here.
- **#1128** "Destructuring TDZ and AnnexB B.3.3 function-in-block hoisting
  (≥211 tests)" — `status: done`, sprint 45. `annexB/language/global-code` +
  `function-code` carry **204 failures out of 310 tests** (66 % fail rate),
  dominated by the single signature "An initialized binding is not created prior
  to evaluation" (96). #2200 and #2552 exist as live successors, so the work was
  re-filed rather than lost — but #1128's `done` overstates what landed.

Not a false-done, but worth stating: **#1387 (`with` statement)** is `done` and
its own frontmatter says "slice & ship Tier 1 first". Tier 1 shipped; the 148
remaining `with` failures are Tier 2, tracked by #671.

### 3.2 Stale documentation

`CLAUDE.md` claims "Skip filters: eval, with, Proxy, …". `eval` and `with` tests
are **not** skipped — 826 and 171 of them respectively run and are counted. The
line predates the current runner.

---

## 4. Recommended first three slices

Ranked by _confirmed_ mechanism density, not cluster size.

1. **#739 — `[[Set]]`/`[[Delete]]` consult the descriptor** (existing, `ready`,
   high, horizon L, hard). The only probe-confirmed shared mechanism in ES5.
   Floor 73 tests, ceiling 564. Coordinate with the in-progress #2668 and the
   blocked #3230 _before_ starting — three issues overlap this surface, and #739
   is the one framed as the substrate change. Start by re-running the §2.2 probe
   as a regression test.
2. **#2200 / #2552 — Annex B B.3.3 block-level function hoisting**
   (in-progress). 204 failures across 310 tests, one spec section, and measured
   **not** `eval`-dependent (`neither` = 111 and 93 in the textual probe). This
   is a single algorithm by construction — the rare case where a path cluster
   really is one mechanism. Confirm whether #2552's "Phase 2 rework perturbs
   hot-path codegen" blocker still holds before dispatching.
3. **#2742 + C1 missing builtins — `String.prototype` generic receivers**
   (in-progress). 87 failures in `String/prototype`, of which the `missing_builtin`
   family (58 corpus-wide) is mechanical: `split`, `lastIndexOf`, `charCodeAt`
   fail on non-string receivers. Cheapest real flips available; good parallel
   work while #739 is in flight.

Explicitly **not** recommended first: anything `eval`- or `with`-shaped (660
failures, gated on `runtime-eval`/#671), and anything sized off a path cluster
alone.

## 5. No new issues filed

Every failure family above already has an issue. Filing more would duplicate.
The two actions that _are_ needed are decisions, not tickets: (a) adjudicate the
#1334 and #1128 false-done findings, (b) confirm the in-progress state of #2200,
#2552, #2666, #2668, #2742, #2747 — six high-priority issues sit `in-progress`
with no open PR, which usually means stalled rather than active.

## 6. Goal tagging — scope and two incidental findings

**15 host-lane, ES5-primary issues** carry `goal: es5` (plus this
census issue): #671, #739, #2200, #2552, #2666, #2668, #2726, #2737, #2742,
#2747, #3230, #3420, #3434, #3475, #3540.

`goal:` is single-valued (`sync-goal-issue-tables.mjs` matches the goal file
name exactly), so a retag _moves_ an issue rather than adding a second home.
Deliberate exclusions:

- **Standalone-lane ES5 work stays under the standalone goals** — #2036, #2042,
  #2046, #2872, #2875, #2986, #2992, #3180, #3251, #3571. They advance ES5 in
  the standalone lane (59 %, §1) but their home is the standalone programme.
- **#3487 / #3524** (`String.prototype.valueOf`/`toString` non-generic receiver)
  were retagged and then **reverted**: the failing test each cites classifies as
  **ES2015**, not ES5, under the corrected classifier. Checked against the
  per-test edition dump rather than the title.
- **#3017** reverted to `correctness` — see finding (b) below.
- **#3230** is `blocked` (struct-widening split). It is genuinely ES5 descriptor
  work, so it is tagged, but the goal is not gated on it.

Two incidental findings, neither fixed here:

- **(a) `plan/goals/correctness.md` is malformed on `main`** — it contains 4
  `GOAL-ISSUES-START` markers and 8 `GOAL-ISSUES-END` markers, so
  `sync-goal-issue-tables.mjs` is **not idempotent** on it: each run appends a
  duplicate table (measured: +1,419 → +4,230 → +9,825 lines over three
  consecutive runs). Any PR that runs the goal sync will silently inflate that
  file. This PR leaves `correctness.md` byte-identical to `origin/main` and
  reverts #3017 rather than touch it.
- **(b) The other goal tables in this PR's diff are pre-existing drift being
  flushed**, not scope creep — e.g. `ci-hardening.md` gains a row for #2946,
  whose frontmatter has said `goal: ci-hardening` since sprint 69. The sync had
  simply not been run since.

## Reproducing this census

```bash
node scripts/fetch-baseline-jsonl.mjs --force
node scripts/fetch-baseline-jsonl.mjs --standalone --force
node --experimental-strip-types scripts/generate-editions.ts
node --experimental-strip-types scripts/generate-editions.ts \
  --results .test262-cache/test262-standalone-current.jsonl \
  --output website/public/benchmarks/results/test262-standalone-editions.json \
  --host-free
```
