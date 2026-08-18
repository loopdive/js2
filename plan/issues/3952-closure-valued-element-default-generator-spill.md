---
id: 3952
title: "Standalone: closure-valued binding-element defaults bail the native generator plan — the round-trip proof #3386 asked for, run; arrow/fn-expr admitted, generator-fn-expr and class-expr measured broken and kept bailed"
status: done
completed: 2026-08-01
sprint: 78
created: 2026-08-01
updated: 2026-08-18
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, destructuring, default-parameters, function-name
es_edition: multi
goal: standalone-mode
umbrella: 3178
assignee: ttraenkler/dev-objlit-gen-dflt
related: [3178, 3386, 3948, 3893, 3164, 1450, 1119, 1049]
loc-budget-allow:
  # (#3102) All growth is the recorded falsification matrix at the decision
  # point: which closure shapes were proven to round-trip and which were measured
  # broken. #3386's stale evidence at this exact site is what made a fresh
  # measurement necessary; leaving the new matrix only in the issue file would
  # set the next person up for the same thing.
  - src/codegen/generators-native.ts
func-budget-allow:
  # (#3400) The predicate has to stay in the binding-element walk — it reads
  # `el.initializer` per element and `decl` for the enclosing-host arm, and it
  # must agree with `isNativeGeneratorCandidate` in lockstep. Hoisting it would
  # create the second decision site that lockstep rule exists to prevent.
  - src/codegen/generators-native.ts::buildNativeGeneratorPlan
origin: "2026-08-01: found as the precisely-bounded residual of #3948's cohort sweep — 8 of 98 objlit rows still leaked. The bail turned out to live in the PLAN BUILDER, not an emit-site gate, so it is family-independent: 162 rows, not 8."
---

# #3952 — closure-valued element defaults in a generator's param pattern

## The bail, and the bar it set

`buildNativeGeneratorPlan`, `src/codegen/generators-native.ts`, in the
binding-element walk:

```ts
if (el.initializer && (isFunctionExpression || isArrowFunction || isClassExpression)) return null;
```

Its own comment set the condition for lifting it: _"A later slice can widen this
once the closure-valued spill round-trip is proven in all lanes."_ So the
acceptance here is **not** import-freedom. A module can be host-free, instantiate
with `{}`, and still hold a broken closure reference it never invokes. Every
admitting assertion therefore **spills the closure, suspends, resumes, and calls
it**.

## Sizing — and a 20× correction to my own first number

I first reported this as an 8-row residual of #3948's cohort. Wrong, and the
reason is structural rather than incidental: this bail is in the **plan
builder**, not an emit-site gate, so it is **family-independent**. Measured on
the 2026-08-01 00:51 standalone baseline (48,088 records), leak rows matching
`init-fn-name`:

| family               | rows | host `pass` |
| -------------------- | ---: | ----------: |
| class                |  128 |         112 |
| object-literal       |   18 |          18 |
| fn-expr / generators |   16 |          16 |
| **total**            |  162 |         146 |

All 162 are `compile_error` today. **162 is a ceiling on instantiation, not a
pass delta.** The NamedEvaluation semantics these tests actually assert
(`arrow.name === 'arrow'`) are already closed (#1450, #1119, #1049), which makes
the yield plausible — not measured.

## Falsification, not assumption

`spillSafeValType` already widens a non-null `ref` to `ref_null`, so the bail
_looked_ pre-emptive. That was the hypothesis to falsify, and it survives only
partly. Bail lifted entirely, then measured — each arm calls the closure after a
suspension:

| arm                                           | result                                        |
| --------------------------------------------- | --------------------------------------------- |
| objlit · arrow                                | **42 ✓ host-free**                            |
| objlit · function-expression                  | **42 ✓ host-free**                            |
| class · arrow                                 | **42 ✓ host-free**                            |
| class · function-expression                   | **42 ✓ host-free**                            |
| array-pattern · arrow                         | **42 ✓ host-free**                            |
| supplied closure beats the default            | **7 ✓**                                       |
| NamedEvaluation `arrow.name`                  | **`"arrow"` ✓**                               |
| objlit · **generator** fn-expr default        | host-free, **traps at runtime**               |
| objlit / class · **class-expression** default | host-free, **"dereferencing a null pointer"** |
| **fn-expr host** · arrow default              | host-free, **traps at runtime**               |

So the round-trip holds for arrow and plain function-expression defaults, and
does **not** hold for three shapes. Per the bar, those keep the bail.

### #3386's recorded evidence is stale

The comment named the failing shape as the **#3164 host-mix fixture**
`*method([gen = function*(){}] = [])` in the **class** lane. That shape **now
passes**. The unsafe set is real but is not the recorded one — which is why this
widening is driven by a fresh matrix rather than by relaxing the predicate to
whatever the old note blamed.

### The fn-expr-host exclusion has a control

The generator **function-expression** host (`const g = function*({…} = {}){}`)
keeps the bail for all closure defaults, and the justification is a control, not
caution: that lane **already traps on an element default with a plain NUMERIC
value** (`{ n = 41 }`), no closure anywhere. Its defect is pre-existing and
closure-**independent**. Admitting those 8 rows would swap a loud host-import
leak for a runtime trap while proving nothing.

### The class-lane generator-fn-expr rows are left on the table deliberately

The class lane passes the generator-fn-expr arm today (32 rows), but the same
shape traps in the objlit lane. Admitting a shape on **lane identity alone**,
when a sibling lane traps on it, is how a leak becomes a silent wrong value.
`gen` stays bailed uniformly; the 32 rows are a measured, bounded follow-up.

## The narrowed predicate

Bail only when the element default is a **generator** function expression, a
**class expression**, or the enclosing generator is itself a **function
expression**. Arrow and plain function-expression defaults are admitted.

**Claimable: 74 rows** (82 `arrow`/`fn`/`cover` rows minus the 8 fn-expr-host).
All 74 are host-`pass`, so this is the highest known-achievable ratio in the
family — **100 %** — though still a ceiling, not a promise.

## Measured effect — construct-sampled, with the control run

Each claimable file's **actual** `*method(<params>)` signature extracted from the
source and re-compiled **in its own family shape** (class vs object literal);
measured quantity is the import set of a bare standalone compile.

| run                 | probes compiled | host-free | still leaking |
| ------------------- | --------------: | --------: | ------------: |
| **pre-fix control** |              42 |     **2** |            40 |
| **post-fix**        |              42 |    **42** |         **0** |

Floored honestly: 32 of the 74 had no signature the extractor could reach (class
lane naming variants — `static`, private `#`), so they are **not measured here**,
not silently counted as wins.

## Acceptance

- [x] Closure survives suspension and is **callable and correct on resume** —
      the bar #3386 set. Not import-freedom alone.
- [x] A supplied closure still beats the default.
- [x] NamedEvaluation intact across the suspension (`arrow.name`).
- [x] Kill-switch: restore #3386's predicate → all 7 admitting tests fail with
      `instantiate(): Import #0 "env"`; the 5 pinning/guard tests stay green.
- [x] The three broken shapes are **pinned by tests**, so a future widening must
      re-measure instead of assuming.
- [x] Numeric and call-expression element defaults unchanged (regression guards).

## Notes

- Stacked on **#3948** (PR #3937): the object-literal arms cannot be observed
  without it, since the objlit whole-param-default bail masks them. Branch is
  `issue-3952-closure-valued-elem-default` off `issue-3948-objlit-method-optional-params`.
- Follow-ups this bounds precisely: the 32 class-lane `gen` rows; the 8
  fn-expr-host rows (a closure-independent defect in that lane's element-default
  handling); and the 40 `class`-expression rows.
