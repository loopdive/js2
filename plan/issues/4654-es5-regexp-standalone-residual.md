---
id: 4654
title: "ES5 standalone: RegExp residual — 12 rows: a RegExp crossing OUT of runtime eval loses its RegExp-ness (7 rows, one root — NOT the filed NUL-truncation), prototype accessor own-ness (3), dynamic-pattern refusal (3)"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-24
completed: 2026-08-24
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp
goal: standalone-gap
related: [3875, 4228, 682, 4664, 4665]
origin: "wave-5 lead sweep (2026-08-23) on campaign HEAD, fresh compiler bundle + eval adapter. All 12 rows re-verified failing. Prior failed attempt at the accessor half is recorded in ensureNativeProtoCompanionSeeder / native-proto.ts — read it before repeating it."
---

# #4654 — ES5 RegExp standalone residual (12 rows)

## A. NUL in regexp source — 7 rows, ONE root (start here)

```
language/literals/regexp/S7.8.5_A1.1_T2.js   Code unit: 0 — SameValue(«undefined», «"\u0000"»)
language/literals/regexp/S7.8.5_A1.4_T2.js   ... «"\\\u0000"»
language/literals/regexp/S7.8.5_A2.1_T2.js   ... «"nnnn\u0000"»
language/literals/regexp/S7.8.5_A2.4_T2.js   ... «"a\\\u0000"»
annexB/built-ins/RegExp/RegExp-leading-escape-BMP.js    ... «"\\\u0000"»
annexB/built-ins/RegExp/RegExp-trailing-escape-BMP.js   ... «"a\\\u0000"»
built-ins/RegExp/S15.10.2_A1_T1.js           XML shallow-parse regex (verify: may be a distinct root)
```

Every one reports the **same shape**: indexing the pattern `source` at the
position of a `\u0000` yields `undefined` where the spec says the NUL code
unit. The signature of a C-string truncation or a length computed before
the NUL. Find the single place the pattern string crosses into the regexp
representation and stops at the NUL; one fix should take the family.

## B. Prototype accessor own-ness — 3 rows

```
built-ins/RegExp/prototype/global/S15.10.7.2_A9.js       __re.hasOwnProperty('global') must be false
built-ins/RegExp/prototype/multiline/S15.10.7.4_A9.js    ... 'multiline'
built-ins/RegExp/prototype/ignoreCase/S15.10.7.3_A9.js   ... 'ignoreCase'
```

An instance answers `hasOwnProperty` **true** for flags that in ES5.1 (and
in the version of the spec these tests encode) live on the prototype, not
the instance. **A prior attempt at this half failed** — the record is in
`ensureNativeProtoCompanionSeeder` / `src/codegen/native-proto.ts` (it
flips issue-2885). Read that record FIRST and say in your report why your
approach differs, or decline with the measurement. Overlaps #3875
(reflection routes disagree on built-in prototype properties) — if the
root is #3875's, hand it back with evidence rather than patching here.

## C. Dynamic-pattern refusal + misc — 3 rows

```
built-ins/RegExp/S15.10.2.8_A3_T15.js   TypeError: Unsupported dynamic regular expression pattern
built-ins/RegExp/S15.10.2.8_A3_T16.js   (same)
annexB/.../RegExp-control-escape-russian-letter.js  (same)
built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js      TypeError: is not a constructor
built-ins/RegExp/S15.10.4.1_A6_T1.js    __re.toString() must return "[object RegExp]"
built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T11.js  "intoint"
```

"Unsupported dynamic regular expression pattern" is an explicit refusal in
the standalone RegExp backend (#682's dual backend). Establish what the
refusal actually cannot handle for THESE patterns — the answer may be a
narrow gap, not the general dynamic-pattern problem. `is not a constructor`
belongs to the builtin-as-value family (#4492 lane); hand it over if that
is its root.

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` — BINDING, read
   fully. Note especially: revert copies at first edit; every claimed
   delta from runs YOU executed; pins must EXECUTE the shape; the
   gitlink hazard (`git status -- test262` before every commit,
   `git diff <base>..HEAD --stat -- test262` empty before finishing).
2. **A first** — one root, 7 rows, highest value per unit of risk.
3. B only after reading the prior-attempt record; decline with a
   measurement rather than repeat it.
4. C last, and scope it by measurement.

## Acceptance

Scoped standalone sweep over `built-ins/RegExp`, `annexB/built-ins/RegExp`,
`language/literals/regexp` before AND after from your own runs; per-file
flip list; **zero regressions**. `tests/issue-4654.test.ts` pinning each
fixed family (executing the operation), verified failing on base by revert;
`it.fails` for residuals with owners. Record `## Root cause` / `## Fix` /
`## Test Results` / `## Residuals` here.

## Root cause

Three independent roots, one per part. The issue's grouping was right about the
COUNTS and wrong about part A's mechanism.

### A — not a NUL truncation. A RegExp loses its RegExp-ness crossing OUT of eval.

All six eval-based rows in part A have the identical body:

```js
for (var cu = 0; cu <= 0xffff; ++cu) {
  …
  var pattern = eval("/" + xx + "/");
  assert.sameValue(pattern.source, xx, "Code unit: " + cu.toString(16));
}
```

`cu = 0` is the FIRST iteration, so the NUL is simply the first — and, because
`assert.sameValue` throws, the ONLY — code unit that ever reported. Measured on
campaign HEAD `c42bdbe3e` with a freshly built bundle + adapter:

| probe (standalone lane, quickjs tier)              | base answer                            |
| -------------------------------------------------- | -------------------------------------- |
| `eval("/" + String.fromCharCode(97) + "/").source` | `undefined`  ← not a NUL at all        |
| `… instanceof RegExp`                              | `false`                                |
| `… .test("xax")`                                   | `TypeError: called value is not a function` |
| `… .lastIndex`                                     | `0`                                    |
| `new RegExp("a\u0000b").source.length` (no eval)   | `3`  ← the NUL survives fine           |

The last row is the one that kills the truncation reading: the compiled RegExp
constructor handles an embedded NUL correctly. The defect is entirely in the
outward half of the QuickJS eval membrane.

`qjsPublish` (`scripts/quickjs-eval-provider.mjs`) publishes a non-callable
QuickJS object as the #4245-slice-2 MIRRORED BOX — a compiled `$Object` carrying
the QuickJS object's own STRING keys, read through
`Object.getOwnPropertyNames`. A RegExp instance has exactly ONE own string key,
`lastIndex`; `source`, `flags`, `global`, `ignoreCase`, `multiline`, `sticky`,
`exec` and `test` are %RegExp.prototype% accessors and methods. So the box
arrived carrying none of them — which is exactly the table above, `lastIndex`
included.

`eval("/a/")` written as a LITERAL answers `source === "a"` even on base,
because `tryStaticEvalInline` folds it at compile time and it never reaches the
membrane. That is why the defect survived: only a runtime-composed eval source
exposes it.

### B — a deleted `RegExp.prototype` ACCESSOR is resurrected by the member CSV

The three rows are `RegExp.prototype` itself, not an instance:

```js
var __re = RegExp.prototype;
assert.sameValue(__re.hasOwnProperty('global'), true);    // passes
assert.sameValue(delete __re.global, true);               // passes
assert.sameValue(__re.hasOwnProperty('global'), false);   // FAILS
```

(The runner's `at L14` attribution on two of the three rows is a heuristic
artifact; the assertion MESSAGE — "must return false" — is authoritative and is
L16 in all three.)

`__nproto_hasown` (`src/codegen/native-proto-own-props.ts`) answers `1` for any
key in the brand's `$memberCsv`, and `global`/`ignoreCase`/`multiline` are in
`REGEXP_PROTO_STRING_MEMBERS`. The seeded-member ladder that consults the
MUTABLE companion — the one #4491 T9 added `constructor` to — is restricted to
`kind === "method"`, because `ensureNativeProtoCompanionSeeder` deliberately
does not seed accessors. So a delete of an accessor member can never be
observed. Structurally the same defect T9 closed for `constructor`, one
member-kind over.

### C — the dynamic-pattern refusal is the GENERAL runtime-grammar gap

The issue asked whether the refusal is narrow for these specific patterns.
Measured: it is not. `regexp-dynamic-pattern.ts` recognises literals, `.`, `|`
and `CharacterEscape`s, and refuses everything else. What each row actually
needs:

| row                                             | pattern that refuses | missing feature                     |
| ----------------------------------------------- | -------------------- | ----------------------------------- |
| `built-ins/RegExp/S15.10.2_A1_T1.js`            | `[^<]+`              | character classes + `+`             |
| `built-ins/RegExp/S15.10.2.8_A3_T15/T16.js`     | 200 nested `(`…`)`   | capture groups                      |
| `annexB/…/RegExp-control-escape-russian-letter` | `\c*`, `\c+`, `\c?`  | quantifiers                         |

(The Annex B `\c`-not-followed-by-an-ASCII-letter rule the russian-letter file
is named for is ALREADY implemented — see the grammar table in
`regexp-dynamic-pattern.ts`. It is the metacharacters in the ASCII half of that
file's generator that refuse.)

`S15.10.2_A1_T1.js` is therefore NOT a distinct root, as the issue suspected it
might be: it is part C's, and it fails with the identical `#0: … [^<]+` message
before and after this change.

The three remaining part-C rows are other families:

- `built-ins/RegExp/prototype/S15.10.6.1_A1_T2.js` — `new RegExp.prototype.constructor`
  → `TypeError: is not a constructor`. Builtin-as-value family (#4492 lane).
- `built-ins/RegExp/S15.10.4.1_A6_T1.js` — needs `Object.prototype.toString`,
  which reports `not yet implemented in --target standalone`. Separate family.
- `built-ins/RegExp/prototype/exec/S15.10.6.2_A4_T11.js` — `__re.lastIndex = {valueOf(){throw "intoint"}}`
  must STORE the object (§22.2.7.1) and coerce inside `exec`. The standalone
  `$StandaloneRegExp` struct types `lastIndex` as an `f64` FIELD, so the
  coercion happens at ASSIGNMENT — one statement ABOVE the test's `try`, which
  is why the raw `"intoint"` escapes uncaught. A value-representation change to
  the regexp struct, not a coercion bug.

## Fix

`scripts/quickjs-eval-provider.mjs` only — the adapter source. No `src/` change.

`qjsPublish` gains a RegExp arm BEFORE the mirrored-box arm: a realm helper
`__js2wasm_eval_reinfo__(o)` returns `""` for a non-RegExp and
`flags ∥ U+0001 ∥ source` for a RegExp (branded by
`Object.prototype.toString.call`, so a prototype-swapped regexp still answers by
its `[[RegExpMatcher]]` slot), and the adapter rebuilds it as a real compiled
`new RegExp(source, flags)`, registered in the handle registry with
`mirror = 0` so identity round-trips in both directions.

Three things make this safe rather than a trade, each measured:

1. **`new RegExp(<dynamic>)` never refuses at CONSTRUCTION.** The runtime
   grammar refuses at MATCH time. Measured: `new RegExp("[a-z]+")` constructs,
   `.source` is `"[a-z]+"` (6 units, first `[`), and only `.test(…)` throws a
   catchable TypeError — exactly what the same pattern does in ordinary user
   code today. So `source`/`flags` are right for EVERY pattern, and nothing that
   worked before regresses (the box could not run `test` at all).
   `tests/issue-4654.test.ts`'s ungated arm pins this premise, because if it
   ever moved to construction time this fix would silently fall back to the
   useless box.
2. **Construction that does throw falls through to the box.** Absent-not-wrong:
   the box is what shipped before.
3. **Only regexps are affected.** A pinned case asserts a plain realm object
   still crosses as the mirrored box.

The separator is split at the FIRST U+0001 only, because a regexp SOURCE may
legitimately contain that code unit; flags cannot.

Stated residual: the reconstruction is a SNAPSHOT, not the box's live view.
`lastIndex` is carried across once at publish time; a later realm-side mutation
of it is not observed, and a compiled write is not pushed back. Every other
piece of regexp state is immutable, so `lastIndex` is the whole divergence.

### …and the part that was NOT optional: the membrane registry was quadratic

The six eval rows are `for (cu = 0; cu <= 0xffff; ++cu)` loops. On base they
abort on iteration 0, so nothing ever ran them; the moment `.source` answers,
they run **65,536 evals**. That turned out to be the real work of this issue.

Three registry costs scaled with the number of PUBLISHED OBJECTS, each paid
once per eval, i.e. O(N²) over a loop:

| site                        | what it did per eval                                            | fix                                                                                |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `qjsFindBoxIndex` (forward) | one `qjs_is_equal` **FFI call per registry row**                | O(1) open-addressing hash keyed by the JSValue PAYLOAD word (`qjs_abi_payload_offset`) |
| `qjsSyncBoxes`              | one array read per row, twice per crossing, to test `mirror==1` | walk a maintained `qjsMirroredRows` index list instead                              |
| `qjsHandleOf` (reverse)     | four `===` per row, **once per global pushed** — globals × rows | partition by `value instanceof RegExp`, **then index the RegExp partition by content** — see the correction below, the partition alone was not enough |

The payload key is safe rather than merely likely-unique **because every row
retains its handle for the instance lifetime** (the slice-3 note), so a
registered object cannot be freed and its `JSObject*` cannot be recycled.

`Map` is not an alternative and that is measured, not assumed: js2wasm's
standalone `Map` is LINEAR — 6.8 µs/lookup at 500 entries, 45 µs at 4,000,
480 µs at 32,000.

Measured on the same build, an N-eval loop with 16 object-valued globals
(`.tmp/evalbench.mts`, no test262 harness):

| what the eval RETURNS                     | N=3,200         | N=12,800       |
| ----------------------------------------- | --------------- | -------------- |
| a number (publishes nothing)              | 2.28 ms/eval    | 2.73 ms/eval   |
| a RegExp (this fix)                       | 1.71 ms/eval    | 4.03 ms/eval   |
| a plain object (the **pre-existing** box) | **116 ms/eval** | (did not finish) |

Two things follow, and the second is the one that matters for merge:

1. The reconstruction's marginal cost over publishing nothing is ~1–1.3 ms/eval
   and roughly flat, not quadratic.
2. **The mirrored box — what base publishes for these very files — is ~68×
   more expensive per eval than the reconstruction, and still super-linear.**
   So this fix does not make these loops slower than base would have been; it
   makes them dramatically cheaper. The box path's own quadratic
   (`qjsPullBox` re-reads every mirrored box's keys from the realm on every
   crossing) is untouched here and is a separate, pre-existing problem.

Before the three fixes the same regexp loop measured 8.9 s at N=800 and 52.0 s
at N=3,200 — a fit of b ≈ 6.7 µs per row per eval, extrapolating to ~4 HOURS at
N=65,536. That is what would have burned the 40-minute CI shard.

### Correction: the partition was necessary and NOT sufficient (the axis the bench held fixed)

The table above shipped a claim that did not survive the first end-to-end run,
and it is worth recording how it failed rather than quietly replacing it.

`qjsHandleOf`'s first fix PARTITIONED the row list by `value instanceof RegExp`,
justified in a code comment by: *"the values that actually reach this function on
the hot path are the caller's GLOBALS … and none of them is a RegExp."* That
sentence generalised from `.tmp/evalbench.mts`, whose eval result was a
**function-local**. The six files this issue exists for write

```js
for (var cu = 0; cu <= 0xffff; ++cu) { … var pattern = eval("/" + xx + "/"); … }
```

and `pattern` is **module-level**, so every reconstructed RegExp is pushed back
INTO the realm as a global on each later iteration — probing precisely the
partition that grows by one row per iteration. The bench varied the eval's
RETURN KIND and the number of extra globals; it never varied **where the result
is bound**, and that was the axis that decided the answer. (Brief methodology 6.)

Measured, end to end, `language/literals/regexp/S7.8.5_A1.1_T2.js` on the
partition-only build: **still running at 16 minutes** (box load 13–17), killed.

The sufficient fix is a second index: an open-addressed **multimap keyed by a
bounded hash of the regexp's `source`**, authoritative for the RegExp partition
(a miss is an answer, never a fallback scan — a fallback would restore the
quadratic on the miss-heavy shape). `source` is immutable for the object's life,
so the key is stable; distinct regexps may share a source, so buckets are
confirmed with the same `===` comparisons the scan used, and the degenerate
all-same-source case is no worse than the scan it replaces.

The index needed two more properties before it held, and both were found by
measurement rather than by reading:

- **an MRU row, checked before the bucket probe.** The index's degenerate case
  is a loop that evaluates the SAME pattern text every iteration: every row
  lands in one bucket and the bucket scan is the linear scan again.
- **chaining instead of open addressing.** Duplicate keys are normal (distinct
  regexps may share a source) and in an open-addressed table they build one
  long primary CLUSTER — the MRU rescues the LOOKUP, but every INSERT still
  probes to the end of the run and every rehash re-inserts N rows into it.

Measured on `.tmp/evalbench2.mts` (26 sources cycled, so N/26 rows per bucket —
the degenerate shape), against the same loop evaluating a NUMBER as the control:

| build                          | N=3,200        | N=12,800       |
| ------------------------------ | -------------- | -------------- |
| number result (control, floor) | 1.412 ms/eval  | 1.396 ms/eval  |
| open-addressed index           | 2.913          | 5.401          |
| + MRU row                      | 1.479          | 2.326          |
| + chained buckets (shipped)    | **1.268**      | **1.900**      |

The control being FLAT is what makes the other rows readable: the membrane's
own per-eval cost does not grow, so everything above the control is the index.

End to end on `language/literals/regexp/S7.8.5_A1.1_T2.js`, all three runs mine:

| build                        | result                          |
| ---------------------------- | ------------------------------- |
| partition only               | still running at **16 min**, killed (load 13–17) |
| + content index              | **pass, 194.6 s** (22.1 compile + 172.1 execute), load ~12 |
| + MRU + chaining (shipped)   | **pass, 127.9 s** (19.9 compile + 107.6 execute), load ~9 |

107.6 s of execute over ~65,500 evals is **1.64 ms/eval**, against a membrane
floor of ~1.40. The reconstruction's own marginal cost is now within ~0.25
ms/eval of publishing nothing at all.

### ⚠ What this costs CI — a decision for the lead, not something I can settle here

On base these six files abort on iteration 0 and cost ~750–920 ms each (that is
literally their weight in `tests/test262-slow-tests-standalone.json` today).
Passing them means actually running 65,536 membrane evals each. Two runner
limits matter, both read out of the source rather than assumed:

- `TEST_TIMEOUT_MS = 15000` (`tests/test262-runner.ts`) is compared **only
  against COMPILE time** (`if (compileMs > timeoutMs)`); execution time is
  never checked against it. So the ~108 s execute is not reported as a timeout.
  Compile for these files is ~20 s on this contended box but well under 15 s on
  a quiet one, which is why they run at all today.
- **`IT_TIMEOUT_MS = 90000`** (`tests/test262-shared.ts`) is vitest's per-test
  timeout in the sharded runner, and its own comment says a test that blows it
  is killed **without a jsonl row** — "the run silently under-reports its own
  denominator". At 1.64 ms/eval these files need ~108 s of execute. A faster,
  quieter CI runner may come in under 90 s; a loaded pool will not, and the
  failure mode is a MISSING row, not a failing one.

Options, in the order I would rank them:

1. Raise `TEST262_IT_TIMEOUT_MS` for the standalone lane in the sharded
   workflow (env-only; the 90 s default stays for every other lane).
2. Seed the six files' weights in `tests/test262-slow-tests-standalone.json`
   from the measured after-arm numbers so weighted sharding gives them room —
   the file is regenerated from a baseline, but a baseline cannot learn a
   timing for a row that was killed before it produced one.
3. Attack the ~1.4 ms/eval membrane floor itself. That is the only option that
   makes these cheap rather than merely affordable, and it is a separate issue:
   it is the pre-existing per-eval cost of a QuickJS crossing, unrelated to
   regexps (measured with an eval that returns a number and publishes nothing).

## Test Results

All runs below are mine, on this branch's tree after merging `origin/main`
(merge commit `90b9ae88d`, main at `f6e094cdb`). One source file separates the
arms — `scripts/quickjs-eval-provider.mjs` — and `git diff --stat` was checked
against exactly that count before each arm. Compiler bundle AND quickjs eval
adapter were rebuilt on BOTH arms (base adapter key `70afda182fdbfd59`, after
key `39960556f160d67a`), so neither arm is reading a stale artifact.

### Scoped standalone sweep — `built-ins/RegExp` + `annexB/built-ins/RegExp` + `language/literals/regexp`

2,179 files, every file run on both arms.

| arm   | pass      | fail | compile_error |
| ----- | --------- | ---- | ------------- |
| base  | 1,781     | 287  | 111           |
| after | **1,790** | 277  | 111           |

Raw tallies above; corrected for the three INFRASTRUCTURE artifacts identified
below they are base 1,783 → after 1,791, i.e. **+8, zero regressions**.

### Flips (fail → pass), all re-run SERIALLY to clear contention

| file                                                    | after-arm ms | why it flipped                       |
| ------------------------------------------------------- | ------------ | ------------------------------------ |
| `annexB/built-ins/RegExp/RegExp-leading-escape-BMP.js`  | 201,630      | 65,536-iteration eval loop           |
| `annexB/built-ins/RegExp/RegExp-trailing-escape-BMP.js` | 200,093      | 65,536-iteration eval loop           |
| `language/literals/regexp/S7.8.5_A2.1_T2.js`            | 134,965      | 65,536-iteration eval loop           |
| `language/literals/regexp/S7.8.5_A1.4_T2.js`            | 128,062      | 65,536-iteration eval loop           |
| `language/literals/regexp/S7.8.5_A1.1_T2.js`            | 127,666      | 65,536-iteration eval loop           |
| `language/literals/regexp/S7.8.5_A2.4_T2.js`            | 126,603      | 65,536-iteration eval loop           |
| `built-ins/RegExp/prototype/source/value-line-terminator.js` | 10,959  | `re.test(…)` on an eval'd regexp     |
| `built-ins/RegExp/prototype/source/value-slash.js`      | 10,196       | `re.test(…)` on an eval'd regexp     |

The last two are the clearest single-line evidence for the root cause: on base
they fail with **`TypeError: called value is not a function`** at
`re.test('\n')` / `re.test('/')` — the mirrored box had no `test` method
because `test` lives on %RegExp.prototype%, which the box never copied.

`built-ins/RegExp/S15.10.2_A1_T1.js` did NOT flip, exactly as the root-cause
section predicts: it is part C's dynamic-pattern grammar gap (`[^<]+`), and its
error text is byte-identical on both arms.

### Regressions: ZERO

The sweep showed ONE apparent regression and TWO apparent flips that are
**measurement artifacts, not results** — each identified by re-running it
serially on BOTH arms, per the brief's contention rule:

| row                                                     | sweep said                       | serial re-run, base | serial re-run, after | verdict |
| ------------------------------------------------------- | -------------------------------- | ------------------- | -------------------- | ------- |
| `…/property-escapes/generated/Script_-_Buginese.js`     | after: `driver_killed`           | pass, 7,228 ms      | pass, 7,835 ms       | my sweep WORKER was cgroup-OOM-killed at 2.4 GB RSS after 233 files; the file is fine |
| `built-ins/RegExp/escape/length.js`                     | base: `DRIVER: test262 repoint failed` | pass, 5,852 ms | pass, 6,382 ms       | the worktree symlink-farm race, on the BASE arm — would have read as a flip |
| `built-ins/RegExp/prototype/Symbol.search/this-val-non-obj.js` | base: same driver error   | pass, 2,318 ms      | pass, 2,343 ms       | same |

Neither of the two base-arm driver errors touches `eval`, which is what made
them suspicious enough to re-run: a file that never reaches the eval membrane
cannot be affected by a change confined to the eval adapter. The OOM was fixed
for the remainder of the run by chunking the sweep into fresh node processes
(`.tmp/chunkrun.sh`), which is a harness fix, not a product one.

### Pins — `tests/issue-4654.test.ts`, 17 tests

- **17 passed (17)** on the after arm (`executed == total`).
- **17 passed (17)** under `JS2WASM_EVAL_ENGINE=interpreter` with the quickjs
  artifact still present.
- **9 passed | 8 skipped (17)** with `.test262-cache` pointed at an EMPTY
  directory — the shape CI's refusal tier actually sees. The 8 eval-gated cases
  skip through `describe.skipIf`, the 9 that compile a plain `new RegExp` still
  run and pass. This is the tier arm the brief requires; the middle run above
  does NOT establish it, because the artifact was reachable.
- **Negative control:** with `qjsFindReRow` stubbed to always answer "not
  registered" and the adapter rebuilt, the run is **1 failed | 16 passed (17)** —
  and the one failure is the reverse-index pin
  (`…the compiled RegExp pushed back IN resolves to the same realm object`,
  `expected +0 to be 1`). So that pin is sensitive to exactly the index it
  guards, and nothing else in the file is.

## Residuals

Pinned as `it.fails` in `tests/issue-4654.test.ts` unless noted.

1. **`lastIndex` is a SNAPSHOT, not a live view.** The reconstruction carries
   `lastIndex` across once at publish time. A later realm-side mutation is not
   observed and a compiled-side write is not pushed back. Every other piece of
   regexp state is immutable, so this is the whole of the divergence from the
   mirrored box's live semantics. No test262 row in the three swept directories
   depends on it. Owner: this issue's arm; revisit only if a row appears.

2. **RegExp reflection through a DYNAMIC receiver answers wrongly** —
   `.flags`, `.global`, `.exec` on a value the compiler types `any` do not
   reach the regexp's own accessors. This is NOT a membrane defect: it
   reproduces on a compiled `new RegExp(...)` that never crosses eval. Two
   further shapes measured while benching this issue:
   - `(x.flags as string).length` on a statically-known regexp typed `any`
     makes the compiler emit an INVALID module (`struct.get[0] expected
     (ref null 6), found local.tee of type i32`) — on this branch AND on base.
   - a `.source` read whose receiver the checker has narrowed to `undefined`
     (`var r: any = undefined; … r = eval(…); r.source`) answers `undefined`,
     while the identical read with an `instanceof RegExp` guard in front of it
     answers correctly. This is what made `.tmp/evalbench2.mts` report
     `out: 0`; the real test262 shape (`var pattern = eval(…)`, no initialiser)
     is unaffected and passes.

   Owner: the standalone RegExp value-representation lane, not the membrane.

3. **Part B — RegExp.prototype accessor own-ness (3 rows) — NOT TAKEN here.**
   Root cause is established (`__nproto_hasown` answers `1` for any key in the
   brand's `$memberCsv`; the seeded-member ladder that consults the MUTABLE
   companion is restricted to `kind === "method"`, so a deleted ACCESSOR can
   never be observed). It is structurally the same defect #4491 T9 closed for
   `constructor`, one member-kind over. It is deliberately left to #4491's lane
   because widening the ladder to accessors touches
   `ensureNativeProtoCompanionSeeder`, whose prior attempt flipped **#2885**,
   and clearing it needs a #2885 canary run on BOTH arms — a measurement this
   lane has not made and must not assert.

4. **Part C — "Unsupported dynamic regular expression pattern" is the GENERAL
   runtime-grammar gap**, not a narrow one. `regexp-dynamic-pattern.ts`
   recognises literals, `.`, `|` and `CharacterEscape`s and refuses everything
   else; the rows need character classes + `+` (`[^<]+`), capture groups (200
   nested parens) and quantifiers (`\c*`, `\c+`, `\c?`). Unchanged before and
   after this issue's fix, by identical error text. Needs its own issue sized
   as a grammar build-out.

5. Three part-C rows belong to other families and are handed over as such:
   `S15.10.6.1_A1_T2.js` (builtin-as-value, #4492 lane),
   `S15.10.4.1_A6_T1.js` (`Object.prototype.toString` in standalone),
   `prototype/exec/S15.10.6.2_A4_T11.js` (`lastIndex` typed as an `f64` FIELD
   on `$StandaloneRegExp`, so §22.2.7.1's "store the object, coerce inside
   `exec`" cannot be expressed — a value-representation change).

## Lead ruling on the escalated timeout decision (2026-08-24)

The lane escalated a decision it correctly declined to make: after the fix the six
`language/literals/regexp/` files pass in **127–202 s**, while `tests/test262-shared.ts`
sets `IT_TIMEOUT_MS = 90000`.

**Ruled: option (1) — raise `TEST262_IT_TIMEOUT_MS` for the standalone lane only.**
Applied in `.github/workflows/test262-sharded.yml` to both shard jobs, mirroring the
existing `JS2WASM_EVAL_ENGINE` conditional so host cells keep the 90 s default:

```yaml
TEST262_IT_TIMEOUT_MS: ${{ matrix.test262_target == 'standalone' && '300000' || '' }}
```

(An empty value is falsy, so `parseInt(env || "90000")` restores the default on host cells —
verified.)

**Why this and not a slow-tests weight.** The decider is not wall-clock, it is
*measurement integrity*: a test that blows the per-test limit is killed **without a jsonl
row**, so the run silently shrinks its own denominator rather than recording a failure.
That is not a hypothetical — the constant's own header in `tests/test262-shared.ts`
records the same mechanism costing **202 of 816 eval-code rows at 2 workers**. A
conformance campaign that reads its pass rate off these rows cannot tolerate a
contention-dependent, silent denominator. The lane was right to refuse option (2):
`tests/test262-slow-tests-standalone.json` is auto-generated by
`scripts/refresh-slow-tests.mjs`, and a scheduling weight does nothing about a per-test kill.

**Cost is bounded and asymmetric.** Only a test that would otherwise have been *killed*
can consume the larger budget — a 5 s row is unaffected — and the job's own
`timeout-minutes` (40) remains the real cap. Six known files at ≤202 s is at most ~20 min
of shard wall in the worst clustering, against a failure mode that corrupts the number the
whole goal is measured by.

**Option (3) stays open as separate work**: ~1.40 ms of the 1.64 ms/eval is pre-existing
membrane cost, i.e. the ~108 s floor is not this fix's doing. File it against the membrane,
not against RegExp.

### Merge verification (lead, on the merged tree)

- `git diff f6e094cdb..f1c6235c2 --stat -- test262` — empty (no GITLINK drift).
- Diff is exactly 3 files: `scripts/quickjs-eval-provider.mjs`, `tests/issue-4654.test.ts`,
  this record. No `src/` change.
- Merged into the campaign branch; branch already contained `origin/main` (behind 0), so the
  lane's "main moved 92 commits" warning is discharged by the campaign branch's own merges.
- Pin file re-run on the merged tree: **17 passed (17)**.

**Trap hit while verifying, worth the line.** The first two re-runs read
`9 passed | 8 skipped (17)` and `1 failed / 9 passed | 8 skipped` — neither is a result.
`scripts/compiler-bundle.mjs` was stale (src files newer), which changes
`computeCompilerBundleHash()`, which changes the adapter cache key, which makes
`quickjsProviderAvailable()` return null, which makes `describe.skipIf` drop the eight
corpus-backed pins **silently**. `pnpm run build:compiler-bundle && node
scripts/build-quickjs-eval-provider.mjs` first, then read the rung-2 line: a quickjs-gated
pin file is only verified when it prints `(17 tests)` with **no** `skipped` suffix.

## Successors (parts B and C are now their own issues)

Part A — the 7-row root, a RegExp losing its RegExp-ness crossing OUT of runtime eval —
is fixed and shipped here (+8 flips, zero regressions). Parts B and C are split out
rather than left inside a `done` issue, so neither becomes invisible:

- **[#4664](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4664-regexp-proto-accessor-own-ness)** —
  part B, prototype accessor own-ness (3 rows). Root located: `__nproto_hasown` answers
  from `$memberCsv` and the companion ladder is `kind === "method"`-only, so a deleted
  accessor is unobservable. Carries the #2885 canary requirement from the prior failed
  attempt.
- **[#4665](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4665-regexp-dynamic-pattern-runtime-grammar)** —
  part C, the dynamic-pattern refusal. The lane refuted this issue's own "maybe it is
  narrow" framing: it is the general runtime-grammar gap. Carries the three part-C rows
  that belong to *other* families so they are not re-attributed to it.
