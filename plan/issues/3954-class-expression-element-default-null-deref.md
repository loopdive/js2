---
id: 3954
title: "Standalone: a CLASS-EXPRESSION binding-element default in a generator param pattern compiles host-free and then derefs a null pointer — in BOTH the object-literal and class lanes (40 rows)"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen
language_feature: generators, destructuring, default-parameters, classes
es_edition: multi
goal: standalone-mode
umbrella: 3178
related: [3952, 3386, 3948, 3178, 3164]
origin: "2026-08-01, measured while running #3952's round-trip proof. #3386 bailed arrow / function-expression / class-expression element defaults as one group; the proof separated them. Arrow and fn-expr round-trip and were admitted; the class-expression arm is genuinely broken and keeps the bail."
---

# #3954 — class-expression element defaults deref a null pointer

## Repro (measured 2026-08-01, `target: "standalone"`)

The bail in `buildNativeGeneratorPlan` (`src/codegen/generators-native.ts`)
currently keeps this on the host path, so to see the defect you must remove
`ts.isClassExpression(el.initializer)` from that predicate — then:

```ts
const o = {
  *m({
    K = class {
      v(): number {
        return 41;
      }
    },
  }: { K?: new () => { v(): number } } = {}) {
    yield 0;
    yield new K().v() + 1;
  },
};
export function test(): number {
  const it = o.m();
  it.next();
  return it.next().value as number;
}
```

compiles **host-free**, instantiates with `{}`, and then traps:

```
dereferencing a null pointer
```

**Both lanes.** The class-method form (`class C { *m({ K = class {…} } = {}) {…} }`)
produces the identical trap, and it also traps when the default is used
**before** any suspension — so this is not a spill/round-trip failure, it is the
class-expression default's own lowering inside a generator's parameter pattern.

Contrast, same commit, one token different: an **arrow** or a plain **function
expression** in that position round-trips correctly (spill → suspend → resume →
call → 42). That is what #3952 admitted.

## Why it is filed separately

#3386 bailed arrow / function-expression / class-expression element defaults as
one group with one justification. #3952 ran the round-trip proof #3386 asked for
and the group **split**: two thirds are safe, this third is not. Keeping them
merged would have meant either shipping a known trap or holding 74 good rows
hostage to it.

## Sizing — read the denominator

On the 2026-08-01 00:51 standalone baseline (48,088 records), leak rows whose
template is `*-init-fn-name-class`:

| family         | rows | host `pass` |
| -------------- | ---: | ----------: |
| class          |   32 |          16 |
| object-literal |    4 |           4 |
| fn-expr        |    4 |           4 |
| **total**      |   40 |      **24** |

All 40 are `compile_error` today (they bail to host, which in standalone is a
`host_import_leak` compile error). **40 is a ceiling on instantiation, not a pass
delta**, and only **24** are known-achievable (host `pass`) — the lowest ratio in
the `init-fn-name` family, because half the class-lane rows fail on the host lane
too for unrelated reasons.

## Acceptance

- [ ] Root-cause the null deref. It is present with and without a suspension, so
      start at the class-expression default's lowering in the parameter
      destructure, not at the generator spill.
- [ ] `{ K = class { v() { return 41 } } } = {}` in a generator param pattern:
      host-free **and** `new K().v()` returns 41 — both before and after a
      suspension, in the object-literal and class lanes.
- [ ] NamedEvaluation: the class expression takes the binding name
      (`K.name === "K"`), per #1450/#1119.
- [ ] Remove `ts.isClassExpression` from the bail in the same commit, and delete
      the pinning test in `tests/issue-3952.test.ts`
      ("CLASS-expression default keeps the host path") — that test exists
      precisely so this change cannot happen silently.
- [ ] `prove-emit-identity check` IDENTICAL (the plan builder is lane-shared —
      #3952 verified this and it is cheap to keep).

## Blocks

The **32 class-lane generator-fn-expr rows** (`*-init-fn-name-gen`) are held
behind a related but distinct trap: that arm passes in the class lane and traps
in the object-literal lane. #3952 refused to admit it on lane identity alone.
Whoever fixes this issue should re-measure that arm too — the two may share a
root cause in how a _callable_ default is materialised inside a generator's
parameter destructure.
