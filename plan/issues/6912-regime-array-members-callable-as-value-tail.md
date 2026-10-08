---
id: 6912
title: "S3-m: the twelve Array.prototype members still refused as callable VALUES on the native regime and standalone (70 rows, 46 of them host passes)"
status: ready
created: 2026-10-07
updated: 2026-10-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: array-methods
goal: architecture
sprint: current
parent: 5385
related: [6709, 6651, 6750, 6708, 3098]
---

# #6912 — finish the array-member closure table

#6709 made `reduce`/`reduceRight` (and `slice`) callable as values on the
native regime and left the members without an AST-free core on the refusal
("`Array.prototype.X is not yet callable as a value in --target standalone`").
Nightly 37596924980 (2026-10-07) regime artifact, rows failing with that
message, by member:

| member | rows | | member | rows |
| --- | --- | --- | --- | --- |
| `lastIndexOf` | 13 | | `toSpliced` | 6 |
| `pop` | 10 | | `toReversed` | 5 |
| `indexOf` | 10 | | `toSorted` | 4 |
| `shift` | 7 | | `sort` | 4 |
| `toString` | 6 | | `with` | 3 |
| `copyWithin` | 1 | | `includes` | 1 |

70 rows; the host lane passes 46 of them. They are the whole of the ES2023
(−5) and most of the ES2016 (−3) ratchet regressions in #6750, and they
block the ES2023 completed-edition rule for S6.

## Plan

Same mechanism as #6709 (`src/codegen/array-reduce-proto-value.ts`,
`array-object-proto.ts` ≈ L1000 routing): give each member a closure on the
receiver-aware variadic native-proto ABI `(self, this, (ref null $vec_externref))`,
reading `argc` from the packed vector for presence-sensitive arguments
(`indexOf`/`lastIndexOf` `fromIndex`, `with` index, `toSpliced` start/count,
`sort` comparator). Where an AST-free `compileArray<member>FromVecLocal` core
is missing (`indexOf`, `lastIndexOf`, `pop`, `shift`, `toString`, `sort`,
`toSpliced`, `toSorted`, `toReversed`, `with`, `copyWithin`, `includes` —
grep `array-methods.ts`), extract one from the direct-call lowering first,
then route both the direct call and the value through it, so the two never
drift. Keep the §23.1.3 step-1 receiver guard via
`emitArrayProtoHofReceiverGuard`. Work in the table's row order; one PR per
two or three members is fine; `.length` from `nativeClosureMeta`.

## Acceptance

- [ ] The 70 rows pass on the regime lane (scoped runs per member:
      `TEST262_SEMANTIC_PROVIDERS=native-first TEST262_PATH_FILTER="built-ins/Array/prototype/<member>/"`)
      and on `--target standalone`; no row that passed before fails.
- [ ] Focused test per member: `Array.prototype.<member>.call(arrayLike, …)`
      with and without the optional argument (including an explicit
      `undefined`, which counts as present).
- [ ] Default `gc` byte-identical; standalone high-water floor moves up only.
- [ ] `check:edition-ratchet --compare` reports no `pass → not-pass` in ES2023.
