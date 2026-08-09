---
id: 4057
title: "LEVER 5 — `instanceof` leaks `env::__instanceof_check` in standalone: mechanism CONFIRMED, sizing RE-MEASURED (59 sole-import records, 10 in ES5 goal scope — not ~94), and NOT an S"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: m
feasibility: hard
reasoning_effort: high
task_type: feature
area: standalone
language_feature: n/a
goal: standalone-mode
related: [4112, 3962, 2916, 2998, 2702, 1536, 3977]
---
# LEVER 5 — `instanceof` leaks a host import in standalone: `env::__instanceof_check` refused, ~94 ≤ES5 failures

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Measured 2026-08-01**, standalone lane, ≤ES5 scope.

| area | fail/run | rate | top signature |
|---|---|---|---|
| `language/expressions/instanceof` | 24/34 | 70.6% | `standalone target emitted host imports: env::__instanceof_check (#N)` |
| `built-ins/RegExp/prototype` | 47/126 | 37.3% | `The result of evaluating (e instanceof TypeError) is expected to be true` |
| `built-ins/Number/prototype` | 23/72 | 31.9% | same `e instanceof TypeError` shape |

**36 records** carry the explicit refusal `standalone target emitted host imports: env::__instanceof_check`.

**Why this is smaller but high-leverage per unit of work:** it is a *single missing primitive*. `instanceof` currently routes through a JS host import, which the standalone leak guard (#2961, `status: done` — the guard is working correctly here) refuses. Implementing a Wasm-native `__instanceof_check` should clear the direct `instanceof` tests AND unblock the much larger population of tests that merely *assert* `e instanceof TypeError` inside an otherwise-unrelated test — which is why RegExp and Number prototype failures show this signature.

That second-order effect is the interesting part: **`instanceof` is used as an assertion primitive throughout test262**, so a native implementation may flip tests well outside `language/expressions/instanceof`. Conversely the ~94 figure may *undercount* the reachable population.

**Measure it properly:** implement, then diff the whole ≤ES5 standalone slice rather than just the instanceof directory — and prove attribution by reverting, since a change to a primitive this widely used will co-move with anything else landing concurrently.

Depends on nothing else in levers 1–4; safe to run in parallel.

---

# Re-measurement, 2026-08-02 — mechanism confirmed, sizing refuted, re-spec

Measured before building, per the program's measure-first rule. **The mechanism
above is real. The sizing is not, and the residual is not an "S".** No
implementation was written; the reason is in "Why this was not built" below and
is a deliberate refusal, not an abandonment.

## Provenance

standalone + host baselines from `loopdive/js2wasm-baselines`,
`baseline_sha 6660c1158`, generated **2026-08-02T19:39:50Z**, `oracle_version 12`
— 48,619 / 48,354 rows, **0 corpus files unopenable** (floored). Goal scope
below is the ex-dynamic-code goal's own rule (`es5id` present OR no id key),
validated against its 8,545 denominator — see #4112.

## What the numbers actually are

| claim in the body above | re-measured |
| --- | --- |
| "~94 ≤ES5 failures" | **10** `env::__instanceof_check` records in goal scope; **73** corpus-wide |
| "36 records carry the explicit refusal" | does not reproduce at either denominator (10 goal / 73 corpus) |
| `language/expressions/instanceof` 24/34 | **23 not-pass / 34 run** in goal scope ✓ (close) |
| second-order `e instanceof TypeError` "may undercount" | **overcounts** — see below |

**63 of the 73 are ES2015+**, outside the ES5 goal entirely: Temporal 20,
Set/prototype 8, TypedArray 5, Promise 3, class 2, module-code 2. The lever's
value is real but it is **standalone-mode value, not ES5 value** — which is what
this issue's own `goal: standalone-mode` frontmatter already said.

### The named directory is 43 % out of scope

Of the 23 goal-scope failures in `language/expressions/instanceof`:

| files | mechanism |
| ---: | --- |
| **10** | `env::__instanceof_check` leak — this lever |
| **8** | the dynamic-code refusal — **already in the ex-dynamic-code exclusion set**, not instanceof work |
| 5 | other assertion failures |

So among the 15 in-scope failures the leak is **10/15 = 67 %** — dominant, the
build gate passes on mechanism. It is the *population* that is an order of
magnitude smaller than filed.

### The second-order claim is backwards

The body predicts that a native `instanceof` unblocks the much larger population
of tests that merely *assert* `e instanceof TypeError`. Cross-checked against the
**host lane**, which has a real `instanceof`:

- `(e instanceof <Error>) is expected to be true` failures, goal scope: **31**
- of those, **22 also fail in the HOST lane** → cannot be explained by a
  standalone-only host-import refusal; they are a **separate defect family**
- **9** are standalone-only

**Name that bucket so it is not re-attributed to this leak:** those 22 are the
`instanceof` / error-ctor **identity** family — the 2026-08-01 census sizes the
whole family at 95 files, 62 of them both-lanes. Shared front-end/identity work,
owned by nobody yet, and it will not move when this leak is retired.

### Sole-import is the right addressable filter, not the host lane

A module carrying a *second* unsatisfiable import does not instantiate even if
this one is retired. Filtering the 73 on `imports == ["env::__instanceof_check"]`:

| | files |
| --- | ---: |
| **sole-import** (retiring the leak makes the module instantiate) | **59** |
| — of which goal scope | **10** |
| co-leaking with a second host import (still blocked) | **14** |

The co-leakers are exactly the Set/Promise subclass tests, blocked additionally
on `env::Set_union` / `Set_difference` / `Set_intersection` /
`Set_symmetricDifference` / `Set_has` / `Set_keys` / `Promise_all` / `_any` /
`_race` / `_reject` / `_finally` / `__js_array_new`. My earlier "24 clean
addressable (host-lane passes)" figure is **superseded** by this — the host-lane
proxy counts modules that a second leak still blocks.

**Reproduced locally at `e244251e7`, `target: "standalone"`:**
`S11.8.6_A6_T1.js`, `S11.8.6_A2.4_T3.js`, `S11.8.6_A2.1_T1.js` →
`imports (1): env::__instanceof_check` ✓ ·
`Set/prototype/union/subclass.js` → `imports (2): env::Set_union,
env::__instanceof_check` ✓ (confirms the co-leak filter).

## The 10 goal-scope files, and what each actually needs

These are the entire ES5-goal ceiling for this lever. All sole-import.

| file | needs |
| --- | --- |
| `S11.8.6_A2.4_T1.js`, `S11.8.6_A2.4_T3.js` | **instantiation only** — the expected `ReferenceError` comes from an undeclared LHS/RHS operand, not from instanceof semantics |
| `S11.8.6_A6_T1.js`, `S11.8.6_A6_T4.js` | a spec `TypeError` for a **non-callable RHS** (`({}) instanceof this`) |
| `S15.3.5.3_A2_T2/T5/T6`, `A3_T1/T2` | a spec `TypeError` when **`F.prototype` is not an object** — requires a *dynamic property read* of `.prototype` off a runtime value |
| `S11.8.6_A2.1_T1.js` | a correct `true` through a **variable alias** of a builtin (`var OBJECT = Object; ({}) instanceof OBJECT`) |

## Why this was not built — the residual is a different shape

The three landed slices already took the shapes that can be answered statically:
#2998 (LHS statically primitive), #2916 (RHS is a builtin *name*), #3962 (RHS
names a top-level plain function). What is left routes through
`emitDynamicInstanceOf` (`src/codegen/expressions/identifiers.ts:1519`), reached
at line 1810 whenever the RHS **is not a simple identifier**, or is an identifier
that resolves to neither a builtin name nor a top-level plain function.

Answering those host-free needs a **value-level** model that standalone does not
have:

1. **Is this runtime value callable?** `ref.test` over the closure root types
   proves *callable*; it does **not** prove *non-callable* — builtin
   constructors are not closures. So a `ref.test` miss cannot license the
   TypeError, and licensing it anyway makes `var OBJECT = Object; ({}) instanceof
   OBJECT` throw where the answer is `true`.
2. **Read `.prototype` off that value.** `emitFnctorProtoGet` is keyed by
   *name*, not reachable from a value. A dynamic property read is the same
   substrate that produces the census's `'__get_builtin' (dynamic-shape
   object/property operation) is not yet supported` refusals.

The tempting shortcut is the one the earlier slices used: under `noJsHost` emit
a conservative `0` and cite the standard safety argument (the module cannot
instantiate today, so every reaching test already fails; a native answer can
only convert). **That argument does not carry here.** It is sound when the
conservative answer is *`false` where `false` is defensible*. In this residual
the two largest sub-shapes (`S11.8.6_A6_*`, `S15.3.5.3_A2/A3_*`, 7 of the 10)
demand a **thrown TypeError**, and a conservative `0` converts a loud,
diagnosable link error into a **silent wrong `false`** — for a total of ~2 flips
(`A2.4_T1/T3`, which flip on instantiation alone). Buying 2 flips by making 7
files quietly wrong is negative value, and it destroys the diagnostic that makes
the remaining work findable.

Also worth recording: the class arm is not the easy win it looks like.
`native-user-instanceof.ts` declines classes deliberately, and the corpus-wide
population behind that decline is Set/Promise/TypedArray **subclasses of
builtins**, which need a per-class brand on a `$Map`/promise backing struct —
not a prototype-chain walk. #4033 made prototypes real `$Object`s, which helps
the plain-function arm that #3962 already covers; it does not supply a
builtin-subclass brand.

## Re-spec — what a correct slice looks like

**Not an S. Re-tagged `horizon: m`, `feasibility: hard`.** Two orderable slices,
neither of which should ship a conservative `false`:

- **S1 — provable non-callable → TypeError.** Emit the spec throw only where
  the RHS value is a *provably* non-callable native representation (`ref.is_null`,
  or `ref.test` positive against `$Object` / vec / boxed-primitive structs).
  Everything else keeps today's behaviour. Wins `S11.8.6_A6_T1/T4`; leaves the
  leak in place for the undecidable arm, so it does **not** on its own retire the
  import — which is exactly why it must be measured as flips, not as
  leak-records-retired.
- **S2 — value-level `.prototype` read.** Blocked on the dynamic-property
  substrate; only after that can `S15.3.5.3_A2/A3_*` and the alias case be
  answered, and only then does the import actually retire.

**Sizing to quote from now on:** 59 sole-import records corpus-wide, **10 in ES5
goal scope**, of which a *complete* fix flips at most 10. Do not quote ~94, and
do not quote the 22 both-lanes assertion failures as part of this lever.

