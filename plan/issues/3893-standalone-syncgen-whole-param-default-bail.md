---
id: 3893
title: "Standalone: one selection bail (`param.initializer`) routes whole-param-default generator FUNCTION EXPRESSIONS onto the host eager-buffer path (~98 rows of the 603-row symptom family)"
status: done
completed: 2026-07-31
sprint: 78
created: 2026-07-31
updated: 2026-08-18
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, default-parameters
es_edition: multi
goal: standalone-mode
umbrella: 3178
assignee: ttraenkler/dev-es3-editions
related: [3178, 3386, 2864]
origin: "2026-07-31 harvest: the standalone `iterator_protocol` leak class (1,907) is not iterators at all — it is generators, and its dominant cluster is blocked by a single line in the native-generator selection predicate."
---

# #3893 — whole-param-default generators bail out of the native path

## The controlled experiment (attribution, not inference)

**Lane: standalone (`target: "standalone"`). Same tree, same commit
(`ae1c79ca`, a merge of `origin/main` `2b3dee60`). One-token source difference
between arms.**

| arm                                     | source                                   | host-import names in the emitted binary                                                         |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **CONTROL** — pattern param, no default | `function*({x:y}) { yield y; }`          | `__gen_resume___closure_` _(the native resume function's own name — not an import)_             |
| **CONTROL2** — identifier param         | `function*(y) { yield y; }`              | `__gen_resume___closure_` _(same)_                                                              |
| **SUBJECT** — whole-param default       | `function*({x:y} = {x:23}) { yield y; }` | **`__gen_create_buffer, __gen_push_f, __create_generator, __gen_next, __get_caught_exception`** |

Both controls take the native path and emit no host imports. Adding **one
whole-param default** flips the same generator onto the eager host-buffer path
and emits **exactly the import set recorded for the dominant baseline cluster**
(`EXN + GEN_SYNC`, 1,271 records) — `__get_caught_exception` included, which
also shows that leak is **generator-lowering collateral, not a separate
exception defect**.

Note `{ standalone: true }` is rejected by `buildCodegenOptions` (#86) — it used
to silently run the gc-host lane. Use `{ target: "standalone" }` or the probe is
vacuous.

## Root cause — one line

`isNativeGeneratorExpressionShape`, `src/codegen/generators-native.ts`:

```ts
if (param.initializer || param.questionToken || param.dotDotDotToken) return false;
```

Its own comment states the intent:

> Whole-param defaults/optionals and rest still bail — the closure trampoline's
> argc/default machinery is not threaded here (#2581-adjacent).

**#3386 (`done`) admitted binding-PATTERN params** to this same predicate;
defaults were deliberately left out of that slice. So **the native machinery
exists and the predicate declines to use it** — a very different cost profile
from building a generator carrier (#2864).

## Sizing — read the denominators, do not round up

Measured on the standalone baseline (48,088 records, all dated 2026-07-31
08:00, from baselines `6cd657e6` / main `ff6dd114`; control: 3,617 records carry
`host_import_leak_class`).

|                                                       |     count |           % of 1,907 |
| ----------------------------------------------------- | --------: | -------------------: |
| `iterator_protocol` population                        | **1,907** |                100 % |
| `*-dflt` template files (whole-param default)         |   **603** |           **31.6 %** |
| …of which inside the `EXN + GEN_SYNC` cluster (1,271) |   **575** | 45 % of that cluster |
| non-`dflt` residue — bail **NOT yet attributed**      | **1,304** |               68.4 % |

The residue is `class/dstr` (384) and `class/elements` (354) plus a long tail.
**Those need their own bail attribution before anyone sizes them.** The 603 is
the size of the whole-param-default **symptom**; the share this fix actually
moves is smaller — see SCOPE below.

**Ceiling ≠ yield.** All 603 are `compile_error` today; they never ran. Removing
the leak buys host-free **instantiation**, after which each test still has to
produce the right answer. **Do not quote 603 as a pass delta.**

### Known-achievable discriminator (host=`pass`)

A standalone row is only _demonstrably_ recoverable if the same file already
passes on the **host** lane — that is a first-party proof the semantics are
reachable. Host-`fail` rows have no such demonstration, and moving a row from
`compile_error` to `fail` is not a conformance gain.

| set                             |    rows |      host `pass` | host `fail` |
| ------------------------------- | ------: | ---------------: | ----------: |
| whole `iterator_protocol` class |   1,907 |   1,094 (57.4 %) |         806 |
| **this slice (`dflt`, 603)**    | **603** | **523 (86.7 %)** |      **78** |

**523 known-achievable is the number to plan against for the whole
whole-param-default SYMPTOM** — the highest achievable ratio measured in this
harvest (for contrast, #2046's 1,484 standalone rows carry **2** host-`pass`).
It is still not a promise: each row must also pass everything else it asserts
once instantiation succeeds.

> **This fix does not claim the 523.** See "SCOPE" below — the predicate it
> touches is reached only by function EXPRESSIONS, so the demonstrated share is
> the ~98 `generators/dstr` rows. The 603/523 figures size the symptom family,
> which spans three declaration shapes with three different gates.

### Denominator reconciliation — 603 vs 497

Two `-dflt` regexes were in circulation and they are **not** the same set:

| pattern                                                    |    rows | host `pass` |
| ---------------------------------------------------------- | ------: | ----------: |
| `/-dflt/` (hyphen-prefixed only)                           |     497 |         425 |
| `/\/dflt-/` (basename **starts** with dflt)                |     106 |          98 |
| **`/(^\|\/)dflt-\|-dflt(-\|\.)\|dflt\.js$/` (this issue)** | **603** |     **523** |

`497 + 106 = 603`, and the 497 set is a strict subset (`only in hyphen: 0`). The
hyphen-only pattern **drops every file whose basename begins with `dflt-`** —
including `generators/dstr/dflt-obj-ptrn-prop-id.js`, the file the probe above
is built on. **This issue quotes 603 / 523.**

## Acceptance criteria

- [x] A generator **function expression** with a whole-param default
      (`function*({x:y} = {x:23})`) routes native in the standalone lane and
      emits **zero** `env::__gen_*` / `env::__create_generator` /
      `env::__get_caught_exception` imports. (Object-literal and class methods
      take a different gate and are explicitly **out of scope** — measured, see
      SCOPE.)
- [x] The default's evaluation stays a **call-time** observable (§27.5
      EvaluateGeneratorBody + §10.2.11 FunctionDeclarationInstantiation): it must
      NOT run at generator-object creation. #3032 is the precedent for exactly
      this violation.
- [x] Kill-switch the guard: revert the predicate change, confirm the new test
      fails, restore.
- [x] Host lane unchanged.
- [x] Re-measure after the fix and record the **measured** result, with
      instantiation-vs-pass stated separately.

## Fix + verification (2026-07-31)

One-line predicate relaxation in `isNativeGeneratorExpressionShape`:
`param.initializer` no longer bails **in the no-JS-host lane**
(`standalone` / `wasi`). `questionToken` and `dotDotDotToken` still bail —
`?` has no runtime arity model here and rest needs an argc-driven vec the
state struct has no slot for. The host lane keeps the old bail explicitly, so
nothing host-side moves.

**Kill-switched.** With the bail restored, all five assertions in
`tests/issue-3893.test.ts` fail with
`WebAssembly.instantiate(): Import #0 "env": module is not an object or function`
— the module needs host imports and cannot instantiate host-free. Restored:
5/5 pass. A test never seen failing is not a test.

**Behavioural, not just structural** — valid Wasm is not correct Wasm. All run
in the standalone lane, instantiated with **no imports**:

- default applied when the arg is omitted → 23 ✓
- default skipped when an arg is supplied → 7 ✓
- identifier-param default → 9 ✓
- **ordering**: with a side-effecting default `mk()`, after `g()` and before any
  `next()`, `calls === 1` and `bodyRan === 0`; the body runs only on `next()` ✓

Adjacent suites green: 8 files / 61 tests (`generators`, `generator-iife`,
`generator-method-destructuring`, `generator-yield-contexts`,
`issue-1665-standalone-generator-forof`, `issue-2864-d4-catch-across-yield`,
`issue-2571-native-method-generators`, `issue-2581-objlit-method-generators`).

## RETRACTED: a `runTest262File` result that was vacuous

An earlier revision of this issue claimed _"3 of 4 test262 files flip to pass."_
**That was wrong and is retracted.** A/B on the two branches — pre-fix
(`issue-3628-es3-editions`) vs post-fix (`issue-3893-gen-param-default`), same
six files — produced **byte-identical output**: 3 pass and 1 fail on _both_
sides. They already passed.

Root cause of the bad claim: **`runTest262File(..., "standalone")` does not
enforce host-import-freedom.** It supplies the host imports, so a leaking module
still runs and still scores `pass`. Its status therefore **cannot** detect this
defect — a green reading is guaranteed regardless of the fix, which is the
definition of a probe that could not have returned the other answer.

The valid instruments are the two that actually gate on imports:

1. the **bare standalone compile + import-set scan** (below), and
2. `tests/issue-3893.test.ts`, which instantiates with **no import object** —
   the only reason it fails pre-fix.

The baseline's `compile_error` rows come from the CI worker, which _does_ apply
the host-free gate; that is why the population is real even though
`runTest262File` cannot see it.

## SCOPE: function expressions only — measured, not assumed

`isNativeGeneratorExpressionShape` is consulted **only** for
`ts.isFunctionExpression(decl)` (`generators-native.ts`, in
`isNativeGeneratorCandidate`). Class and object-literal generators are
`MethodDeclaration`s and take a different gate, so this fix cannot move them.
Verified by import-set A/B across the same two branches:

| shape                                   |   pre-fix | post-fix                              |
| --------------------------------------- | --------: | ------------------------------------- |
| `function*({x} = {…})` (fn-expr)        | **leaks** | **native** ← this fix                 |
| `{ *m({x} = {…}) }` (objlit method)     |     leaks | leaks (unchanged)                     |
| `class { *m({x} = {…}) }`               |    native | native (never leaked for this reason) |
| `class { *#m(…) }` (private, ± default) |     leaks | leaks (a different defect)            |

So the `dflt` population splits by shape, and **only the fn-expr share is
claimable here**:

| path family                       |   rows | this fix?                                               |
| --------------------------------- | -----: | ------------------------------------------------------- |
| `generators/dstr` (fn-expr)       | **98** | **yes — demonstrated**                                  |
| `class/dstr` + `class/elements`   |    388 | no — `MethodDeclaration`; private-gen is its own defect |
| `object/*`                        |    102 | no — still leaks post-fix                               |
| other (async-generator, function) |     15 | not enumerated                                          |

**The claimable number is ~98 of 603, not 603 or 523.** The 603/523 figures
above describe the whole whole-param-default _population_; they are the sizing
of the SYMPTOM, not of this fix. The 388 class-path rows are being attributed
separately (sync private generator methods, `class-bodies.ts`), and the 102
object-path rows have no owner yet.

## Notes / coordination

- **File-overlap check done before claiming** (`src/codegen/generators-native.ts`
  is #2864's territory): all five `issue-2864-*` branches on the fork are
  ancestors of `origin/main` (0 commits ahead), **no open PR touches the file**,
  and main's last touch was 2026-07-25 (#3620). The merged #2864 regions are
  `buildNativeGeneratorPlan` (D4) and yield\*-delegation (D2/R1) — **not**
  `isNativeGeneratorExpressionShape` nor the trampoline argc path. Residual risk
  is the pre-dispatch gate's stated blind spot: unpushed local work.
- **#2864 is live and claimed** (`ttraenkler/dev-opus5-gen`); its
  `updated: 2026-07-24` understates it (merged PR #3575 + D4 commits). This is
  deliberately a _different, smaller_ slice and must not be folded into it.
- **Classifier defect, worth its own fix** (belongs on #3178):
  `classifyHostImportLeak`, `scripts/test262-worker.mjs:1074`, regex
  `/__iterator|__array_from_iter|__gen_|generator|async_iterator/`, files the
  whole generator family under a bucket named **`iterator_protocol`**. Measured:
  **0 of 1,907** records in that bucket carry a genuine `__iterator` /
  `__array_from_iter` import. Any future harvest reading the bucket name sizes
  the wrong defect.
