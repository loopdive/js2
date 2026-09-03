---
id: 5283
title: "`legacyBodyEmitted: true` on units where NO direct pass ran — 26 of 33 dogfood rows, and it inflates every legacy-body count built on that flag"
status: ready
created: 2026-09-03
updated: 2026-09-03
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
area: ir
goal: backend-agnostic-ir
requested_by: ttraenkler/fable-ir-takeover
related: [3523, 3518, 3519, 3521]
---

## Problem

`IrObservedOutcome.legacyBodyEmitted` is supposed to mean "the direct front end
emitted a body for this unit". It is set on units where **no direct pass ran**,
and the same row records **no `directBodyEmissions` at all**.

Minimal confirmation — `tests/fixtures/extern-demo.ts`, one compile through the
`check:ir-only` single-host observer:

```json
{ "unitKind": "module-init", "kind": "unsupported",
  "code": "body-shape-rejected", "stage": "select",
  "legacyBodyEmitted": true, "irBodyEmitted": false }
```

`directBodyEmissions` and `prepareAttempts` are **absent**, not zero. The row
asserts a legacy body while recording nothing that emitted one.

This was predicted by the #3523 gap-6b census as P4 ("a truthfulness defect
adjacent to gap 4"), which instructed: confirm with one compile and file
separately. That is what this is.

## Scale — it is not one fixture

Counting rows with `legacyBodyEmitted === true` and `(directBodyEmissions ?? 0) === 0`:

| corpus / lane | legacyBodyEmitted | of which phantom |
| --- | --: | --: |
| `tests/dogfood/corpus`, single-host | 33 | **26** |
| `tests/dogfood/corpus`, standalone | 31 | **23** |
| playground uncovered eight, single-host | 10 | **0** |
| playground uncovered eight, standalone | 14 | **0** |

**Roughly four in five dogfood legacy-body rows are phantom; the playground has
none.** That the two corpora differ this sharply is itself the diagnostic: the
flag is not uniformly wrong, it is wrong for a population the playground does
not contain.

## Suspected mechanism (not yet proven)

`collectModuleInitPopulation` (`src/ir/module-init.ts:11-24`) skips
`FunctionDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`,
`TypeAliasDeclaration`, `Import*`, `Export*` and `EmptyStatement` — but **not
`ModuleDeclaration`**, so `declare namespace Host { … }` counts as module-init
population even though a `declare` namespace emits nothing. That explains
`extern-demo.ts` exactly. Whether it explains all 26 dogfood rows is
**unverified** — those are `.js` files with no `declare namespace`, so at least
one other path must set the flag without a direct emission. Do not assume one
cause.

## Why this is worth priority

Every "how much does the direct front end still emit" number is built on this
flag, including the R9 denominator work on `#3518`. Measurements taken there on
2026-09-02/03 quote dogfood legacy-body counts of 33 and 31; the direct-emission
counts are **7 and 8**. Those figures have been corrected in place on `#3518`
with a pointer here. Any other consumer of `legacyBodyEmitted` — a ratchet, a
census, a slice's byte-neutrality argument — is overstating by the same shape.

## Acceptance

1. Root-cause every phantom row, not just the `ModuleDeclaration` one. The
   dogfood `.js` rows are the proof the `declare namespace` path is not the
   whole story.
2. Either `legacyBodyEmitted` becomes true only when a direct body was actually
   emitted, or it is renamed to what it really means and every consumer is
   updated. Do not leave a flag whose name and meaning disagree.
3. A pin per distinct phantom-producing path, each failing before the fix.
4. State whether any committed baseline or ratchet floor was seeded from
   inflated counts. If so, the reseed is part of this issue, not a follow-up.

## Reproduce

```ts
import { observeSingleHostLane } from "./scripts/check-ir-only.js";
const obs = await observeSingleHostLane(["tests/fixtures/extern-demo.ts"]);
// module-init row: legacyBodyEmitted true, directBodyEmissions absent
```

For the corpus scale, run the same observer over `tests/dogfood/corpus` and
filter `legacyBodyEmitted === true && (directBodyEmissions ?? 0) === 0`.
