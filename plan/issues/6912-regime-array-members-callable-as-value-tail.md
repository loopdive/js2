---
id: 6912
title: "S3-m: the twelve Array.prototype members still refused as callable VALUES on the native regime and standalone (70 rows, 46 of them host passes)"
status: in-progress
assignee: ttraenkler/opus-6912
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
loc-budget-allow:
  # 2026-10-07 (#6912): routing lines for the member closure bodies; the bodies live in src/codegen/array/
  - src/codegen/array-object-proto.ts
import-cycles-allow:
  - largestSccSize: 701 # 2026-10-07, re-based on main 699 2026-10-09 (#6912): array/array-search-proto-value.ts (PR A) and array/array-generic-value-bodies.ts (PR B) join the codegen SCC (it is called from array-object-proto.ts and uses shared.js coerceType/ensureLateImport, like array-fill-proto-value.ts); the pure scan core array/array-search-core.ts stays outside it
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

## Progress

### PR A — `indexOf`, `lastIndexOf`, `includes` (2026-10-07)

- Extracted the AST-free core of the array-like search out of the direct
  borrow `compileArrayLikePrototypeSearch` (array-prototype-borrow.ts) into
  `src/codegen/array/array-search-core.ts` (fromIndex clamp, default start,
  HasProperty-gated scan). The direct `.call` borrow now emits through it
  (byte-identical: same instructions, same local order), and the new callable
  VALUE body (`src/codegen/array/array-search-proto-value.ts`) runs the same
  core, so the two spellings cannot drift.
- The value closure takes the variadic ABI on the native regime only; the
  argument-vector unpack was factored out of #6709's reduce body
  (`emitVariadicArgsUnpack`, array-reduce-proto-value.ts) and is shared.
  `lastIndexOf`'s fromIndex is presence-tested on `argc` (an explicit
  `undefined` is present → n = 0). len = 0 returns before fromIndex is
  converted (§23.1.3.17 step 3); fromIndex goes through the coercion engine
  (observable `valueOf`).
- `includes` (1 row) rides along because it shares the core.
- Deviation from the plan text: no `compileArray<member>FromVecLocal` typed-vec
  core was written. The rows are array-LIKE receivers; the matching direct
  lowering is the array-like borrow, and that is the one now shared. The
  typed-vec `arr.indexOf(x)` fast path is a different receiver class and was
  left untouched.
- Default `gc` and `wasi`: probe sha256 identical base vs after
  (`.tmp/probe-sha.mjs`: indexOf/lastIndexOf/includes `.call` borrows, values,
  reduce value, typed-vec indexOf/lastIndexOf).

### PR B — `pop`, `shift`, `toString` (2026-10-07)

- `src/codegen/array/array-generic-value-bodies.ts`: spec-literal bodies on
  the dynamic array-like substrate (`__extern_length` / `__extern_get_idx` /
  `__extern_has_idx` / `__extern_set_strict` / `__delete_property`). Every
  Set is Set(O, P, V, true); every delete is DeletePropertyOrThrow (a `false`
  from `__delete_property` throws a TypeError). `shift` preserves holes.
- These members take no arguments, so their closures keep the fixed ABI.
  `pop`/`shift` were missing from `PROTO_METHOD_LENGTH` and had picked up the
  table's default of 1. They now have their spec `.length` of 0, which also
  drops the unused argument slot from their native closures.
- `toString` (§23.1.3.36): `Get(O, "join")`; if it is callable, call it with
  no arguments; otherwise use `Object.prototype.toString` (the minted
  `__object_proto_to_string_runtime` classifier). Residual workaround: a dynamic
  `vec["join"]` read does not see the inherited `Array.prototype.join`
  (measured: `typeof ([1,2] as any)[k]` with `k = "join"` is not `"function"`
  on standalone). A real Array whose `join` read misses is therefore joined
  natively with the default separator (`prepareArrayLikeDefaultJoin`,
  array-like-native.ts), which is what the inherited method does. An Array
  whose `Array.prototype.join` was REPLACED is not observed on that path. The
  missing inherited-method read is a separate gap and is not this issue's.
- No direct-call core to share: `arr.pop()` / `arr.shift()` lower against the
  typed vec, a different receiver class, and there is no array-like borrow
  arm for these members. The closure is the only array-like lowering.
- Default `gc` / `wasi` probe sha256 identical.

