---
id: 7202
title: "`#x in v` own-brand guard costs one ref.eq pair per subclass (linear bytes and time)"
status: done
sprint: Backlog
created: 2026-10-31
updated: 2026-11-04
completed: 2026-11-04
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: classes
goal: performance
related: [7160]
---

# #7202 — make the #7160 singleton exclusion constant-cost

Found by the PR #7003 review (#7160), finding 1. To reject the constructor
and prototype singletons, `emitOwnPrivateBrandPredicate`
(`src/codegen/binary-ops-in.ts`) compares the receiver with `ref.eq` against
the class-object and prototype globals of the declaring class **and every
subclass**. Each `#x in` site therefore grows with the number of descendants:

- A class with 10 subclasses costs +600 B per site (+720 B on wasi).
- On gc, a hot loop of 3M checks on the true path is about 5× slower
  (30–40 ms → 190–220 ms), because every arm is evaluated.

## Plan

1. Pick the receiver's own class by its `__tag` (already read by the brand
   test) and compare against only that class's two globals. The alternative
   is to move the chain into one shared helper function per declaring class.
2. Keep the output identical on the #7160 test file
   (`tests/equivalence/issue-7160-private-in-constructor.test.ts`). Measure
   bytes and time for 1, 3 and 10 subclasses.

## Result (2026-11-04)

A class with descendants now gets one shared helper,
`__private_in_own_brand_<C>_<struct>_<n>(anyref) -> i32`
(`ensureOwnPrivateBrandHelper` in `src/codegen/binary-ops-in.ts`). It does
`ref.test` on the struct, then a `br_table` on `__tag - minTag`. Each class's
arm compares the receiver with that class's two singletons only, and any tag
outside the subtree goes to the default arm, which answers 0. Every site is
`local.get; call`.

- **Why tag dispatch is sound:** every class-object and prototype singleton of
  `K` is built with `K`'s tag (`emitLazyClassObjectGet`, `emitLazyProtoGet`,
  `class-instance-proto.ts`). The standalone prototype is a `$Object` and never
  passes `ref.test`. So for a receiver with tag `t`, only `t`'s own globals can
  match.
- **Why both parts are combined:** folding the brand tag list into the same
  table also makes the brand test constant-time. It is the same set
  (`collectClassAndDescendants` ∩ `classTagMap`).
- **When the inline chain is kept, byte for byte:** a class without
  subclasses, a struct without `__tag`, and a subtree of more than 256 classes
  (to bound `br_table` nesting, #6698).

**Measured** (`p.ts`: `C` with `#x` plus n subclasses; per site = 3 sites minus
2 sites; loop = 3M true-path checks, min of 15 runs):

| subclasses | per-site gc base→head | per-site wasi base→head | gc loop base→head | wasi loop base→head |
| ---------- | --------------------- | ----------------------- | ----------------- | ------------------- |
| 0          | 159 → 159 B           | 289 → 289 B             | 14 → 16 ms (noise) | 15 → 16 ms        |
| 1          | 226 → 80 B            | 423 → 130 B             | 18 → 16 ms        | 18 → 18 ms          |
| 3          | 360 → 80 B            | 691 → 130 B             | 58 → 18 ms        | 35 → 17 ms          |
| 10         | 831 → 82 B            | 1629 → 130 B            | 138 → 18 ms       | 90 → 17 ms          |

Standalone per-site matches gc. The helper is paid once per declaring class.
With a single site and 1 subclass, the module grows by about 50 B (gc and
wasi); at 3 subclasses it grows by 26 B; from 2 sites on, it is a net win. On
the #7160 test corpus (16 rows × 3 lanes) the total is −2,208 B on gc,
−1,752 B on standalone and −6,800 B on wasi.

Test: `tests/equivalence/issue-7202-private-in-guard-constant.test.ts` (50
cases: 1/3/10 subclasses × 16 rows on gc/standalone/wasi against node, plus
two structural checks). All 48 semantic rows also pass on base. A mutant that
skips the singleton arms fails 22 of them.
