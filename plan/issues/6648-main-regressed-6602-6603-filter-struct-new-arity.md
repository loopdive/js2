---
id: 6648
title: "main regressed tests/issue-6602 + issue-6603 (standalone): `filter` over a nullable vec element fails wasm validation (`struct.new` needs 6, got 2) and an inline native-string concat traps `dereferencing a null pointer`"
status: in-progress
sprint: current
priority: high
horizon: s
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
updated: 2026-09-20
loc-budget-allow:
  # #6648 changes the two existing carrier boundaries in place: fresh Array
  # allocation belongs next to each producer's `struct.new`, and the capture
  # element widening belongs next to the shared element-access decision. Moving
  # either to a side module would split ordered Wasm emission from its type and
  # local allocation context.
  - src/codegen/array-methods.ts
  - src/codegen/property-access.ts
func-budget-allow:
  # The numeric capture boundary is an ordered arm in this existing lowering;
  # the helper's exact carrier check must remain beside its `struct.new` sites.
  - src/codegen/property-access.ts::compileElementAccessBody
---

## Problem

Two committed witnesses fail on `origin/main` alone (measured at `b84d58d64c`,
2026-09-20 ~09:00 UTC, Node 22 and Node 25), and were green on `ea8d7f87ff`
(06:53 UTC) — so a PR in the window `ea8d7f87ff..b84d58d64c` (#5999, #6000,
#6001, #6002, #6004) regressed them. They are found only by the standalone
Temporal stack's witness sweep (`tests/issue-66*.test.ts`), which is why CI
did not block the merge; the S68 landing PR #6005 carries them as "main's".

| witness | expected | received on main |
| --- | --- | --- |
| `tests/issue-6602-standalone-nullable-vec-element-callback-param.test.ts` › array HOFs over a nullable vec element › do not trap on an unmatched capture group | `filter: "2"` | `filter: "!instantiate WebAssembly.compile(): Compiling function #62:"prepare" failed: not enough arguments on the stack for struct.new (need 6, got 2) @+62165"` |
| `tests/issue-6603-standalone-nullable-native-string-element-binding.test.ts` › controls — unchanged on both trees › keeps every binding shape the filter does not name | `inlineConcat: "undefined"` | `inlineConcat: "!dereferencing a null pointer"` |

The first is a **module validation failure** — the emitted `prepare` function
builds a struct with 2 operands where the type has 6 fields — on the `filter`
HOF over a regex match's unmatched capture group (a nullable vec element). The
second is a runtime null deref on an inline concat of a nullable native-string
element. Both shapes come from `RegExp` match results, and the only src commit
in the window that touches that surface is `5eddbfc32c` "fix(regexp): preserve
global match plain-array shape" (PR #6004), so that is the first bisect
candidate; #6001 (iterator length coercion) is the second.

## Acceptance

- Both witnesses green on main under Node 22 and Node 25, without editing the
  witnesses' expectations (they pin behaviour that was correct on `ea8d7f87ff`).
- Bisect recorded here (`git bisect` between `ea8d7f87ff` and `b84d58d64c` on
  the two test files is ~3 steps).

## Repro

```bash
npx vitest run tests/issue-6602-standalone-nullable-vec-element-callback-param.test.ts \
  tests/issue-6603-standalone-nullable-native-string-element-binding.test.ts
```

## Exact introduction receipt (2026-09-20)

The broad window is now reduced to the single-source PR #6004 feature commit,
not merely suspected from changed-file overlap. The two witness files are
byte-identical at every compared revision:

- `issue-6602-standalone-nullable-vec-element-callback-param.test.ts`:
  `53ad9aa79a9e5e41ffecf97cb7df10c6c2e972a09fb561e226be02b79a46eeb4`
- `issue-6603-standalone-nullable-native-string-element-binding.test.ts`:
  `95f33f2cc49ed0fcd4471ae4772b545c7e5416ffa816dab68a383cbf6d4831d3`

All three runs used the same direct Node `v24.19.0` Vitest executable, one
fork, `VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, and no `NODE_OPTIONS` override:

```bash
VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 VITEST_MAX_FORKS=1 \
  /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  /Users/thomas/Code/js2/node_modules/vitest/vitest.mjs run \
  tests/issue-6602-standalone-nullable-vec-element-callback-param.test.ts \
  tests/issue-6603-standalone-nullable-native-string-element-binding.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot
```

| revision | relation | result | durable receipt |
| --- | --- | --- | --- |
| `ae0a46be500e475e514b908361710e6ecbe563c6` | exact first parent of #6004 feature commit | 2 files, **5P / 0F** | `/private/tmp/js2-6648-pr6004-parent-ae0a46be-witnesses-20260920.log` |
| `5eddbfc32c588ec450c3ed13b12a1f554ec15e58` | #6004 feature head | 2 files, **3P / 2F** | `/private/tmp/js2-6648-pr6004-feature-5eddbfc32c-witnesses-20260920.log` |
| `2f6c0f4f57db129c772a476345c28d85010cd175` | current merged main at audit start | 2 files, **3P / 2F** | `/private/tmp/js2-6648-current-2f6c0f4f-witnesses-20260920.log` |

The two feature-head/current failures are byte-for-byte the reported
signatures: `filter` emits a two-operand `struct.new` for a six-field result
type, and `inlineConcat` traps on the null unmatched capture. An earlier
`b37753de` comparison is also green (5P / 0F), but is supporting history only:
the exact parent/head pair above is the attribution proof.

## Forward repair boundary and plan

The source change which introduced the failures intentionally made the
metadata-bearing capture result (`$__regexp_match_vec`) visible as a concrete
local carrier, while a global `@@match` result is the ordinary native-string
vector. That result-shape split is correct and must remain: do **not** revert
the global plain-array repair, erase capture provenance, or change IR/layout
code.

The repair must instead make consumers distinguish an input carrier from a new
ordinary Array result:

1. Audit every native array producer that currently emits `struct.new` using
   the receiver's `vecTypeIdx`. The confirmed failing site is
   `compileArrayFilter` in `src/codegen/array-methods.ts`; its two-field result
   backing is currently constructed as the six-field capture subtype. The
   immediate audit set is `filter`, `map` when the callback preserves the
   native-string element carrier, `slice`, and `concat` (including zero-arg
   copies). Any further `{ length, data }` producer reached by an exact capture
   receiver must be listed and either demonstrated safe or normalized to the
   ordinary native-string vec. Output arrays must not inherit `index`, `input`,
   `groups`, or `indices` metadata.
2. Audit the direct native-string element read used by `"" + m[1]`. It must
   retain the capture subtype for metadata reads while recovering the inherited
   nullable element type for ordinary indexed/string conversion; an unmatched
   capture remains JavaScript `undefined`, not a non-null native-string
   assertion. Prefer the existing structural vec/subtype information over a
   checker-only cast.
3. Add narrowly focused controls in the existing #6602/#6603 test files (or a
   single adjacent #6648 test) for capture `filter` plus each actually admitted
   producing consumer, null-slot stringification, and metadata preservation on
   the original capture. Pair them with the already-merged #6004 global-match
   shape controls and the original `g-success-return-val.js`; do not alter the
   two witnesses' expectations.
4. Validate the repaired tree on the two witnesses under explicit Node 22 and
   Node 25, then rerun the #6004 focused global-match controls and the original
   `g-success-return-val.js`. The Node 24 A/B above is introduction evidence,
   not final cross-runtime acceptance.

Prospective ownership is limited to the #6648 worktree's `array-methods.ts`,
the exact indexed-native-string consumer seam if source proof requires it, the
focused tests, and this issue record. `native-regex.ts`,
`regexp-standalone.ts`, declarations, IR, and layout are deliberately out of
scope unless a separately reviewed source proof demonstrates an unavoidable
dependency.

## Source proof and bounded repair design (2026-09-20)

The exact-parent comparison establishes that the #6004 result-shape split is
the introduction. The forward repair keeps that split and corrects two
consumer families that treated a *capture receiver* as the type of a newly
allocated ordinary Array.

### Fresh Array outputs

`$__regexp_match_vec` is a subtype of the nullable-native-string base vec. It
has the ordinary `{ length, data }` prefix plus four immutable result metadata
fields (`index`, `input`, `groups`, `indices`). Its backing array is already
the same nullable-native-string array used by the base vec. A new Array made
from that receiver must use the base vec, not copy the capture-result runtime
brand or attempt to construct its six-field layout with only two operands.

The audited native producers in `src/codegen/array-methods.ts` are:

- `filter` — **confirmed failing**: line 7550 emits two operands into the
  receiver `vecTypeIdx`.
- `map` — its result is a fresh Array too. A defined-return mapper already
  chooses an ordinary native-string vec at the exact parent, so it is retained
  as an allocation-invariant control, not claimed as a new #6648 gain. An
  unannotated identity mapper traps at the independent closure return boundary
  before its result can be stored; that pre-existing residual is pinned below
  rather than papered over by the output-carrier repair.
- `slice` / `compileArraySliceFromVecLocal` — line 5093, including the
  `Array.prototype` closure caller.
- `concat`, both its zero-argument shallow copy and same-kind fast path —
  lines 5353 and 5447.
- `splice` — only its *deleted-elements result* (lines 6193 and 6420); the
  mutated receiver remains the capture subtype and retains metadata.
- ES2023 copy-producing methods `toReversed`, `toSpliced`, and `with` — lines
  2787, 3020, and 3086.

`toSorted` has the same syntactic constructor at line 2840 but its native arm
admits only `i32`/`f64` elements, so a nullable native-string capture receiver
cannot reach it. `flat`/`flatMap` do not create this output for scalar capture
elements in standalone: `flat` fails loud for non-nested inputs, and native
`flatMap` requires array-returning callbacks. Mutators (`reverse`, `sort`,
`fill`, `copyWithin`, `push`, `pop`, `shift`, `unshift`) deliberately retain
the receiver carrier and are not output-normalization sites.

The implementation adds one exact-carrier helper in `array-methods.ts`:
when `ctx.typeIdxToStructName.get(receiverVecTypeIdx)` is exactly
`REGEXP_MATCH_VEC_STRUCT`, it selects `ensureRegexMatchFlatVecType(ctx)` and
its already-compatible backing-array type for the **result only**. All other
vec subtypes retain their established paths. Input locals, receiver casts,
metadata reads, and mutation paths continue to use the capture subtype. The
map arm keeps its existing callback-derived result type; it does not attempt to
hide the independently measured closure-return `ref.as_non_null` residual.

### Numeric capture-element read

The #6603 inline concat is a distinct read-boundary regression. In
`property-access.ts`, `$__regexp_match_vec` sets `isRegexMatchVec`, which
suppresses the ordinary `oobUndefined` path. Therefore a numeric `m[1]` returns
the raw `ref null $AnyString` from the backing array. Native `+` sees the
checker’s non-null `string` and passes that raw null to `__str_concat`, causing
the reported dereference. Before #6004 the local used the base vec and reached
`emitReferenceArrayUndefinedOobGet`, which converts both an unmatched
in-bounds nullable element and an OOB access to JavaScript `undefined` at the
externref boundary.

The narrow reader repair will restore that existing widening only when a
capture-result `ElementAccessExpression` has a **provably numeric** key via
the existing `isNumericIndexExpression(ctx, key, fctx)` predicate. It does not
alter property accesses (`m.index`, `m.input`, `m.groups`, `m.indices`), nor
ambiguous/string/symbol computed keys, nor the match-result metadata dispatch.
Immediate-member receivers retain the existing TypeError-preserving exception
inside `shouldWidenReferenceArrayOob`.

### Focused validation plan

Add an adjacent #6648 standalone fixture that separately proves:

1. the original capture keeps `.index` / `.input` while each admitted fresh
   Array result is a normal array with no match metadata;
2. `filter`, defined-return `map`, `slice`, `concat`, `splice`, `toReversed`,
   `toSpliced`, and `with` validate fresh ordinary output arrays; identity-map
   nullability remains an explicitly pinned pre-existing closure residual;
3. `"" + m[1]` produces `"undefined"` without changing an immediate-member
   null TypeError, plus the pre-existing #6602 callback/nullability controls;
4. global `@@match` remains a plain vector and the original
   `g-success-return-val.js` remains green.

Run the unchanged #6602/#6603 witnesses and these controls first on Node 22
and Node 25. The #6004 global-match focused controls and the original
`g-success-return-val.js` are required no-regression checks. No type
declarations, regexp producers, IR, or layout changes are required by this
source proof.

## Implementation checkpoint and focused receipts (2026-09-20)

The working repair is in progress, not publication-ready. It has two narrow
production changes only:

- `array-methods.ts` normalizes every admitted fresh `{ length, data }` output
  from the exact capture subtype to the ordinary nullable-native-string vec;
  it leaves capture receivers and mutators on their metadata-bearing subtype.
- `property-access.ts` restores the existing boxed-or-undefined boundary for
  exact numeric capture-element reads. Static negative/fractional keys stay on
  their established named-key route; this is not a general numeric-property
  rewrite.

### Proven #6648 repair receipts

- Unchanged #6602/#6603 witnesses: Node 22 **5P/0F** at
  `/private/tmp/js2-6648-candidate-node22-untouched-witnesses-20260920.log`,
  and Node 25 **5P/0F** at
  `/private/tmp/js2-6648-candidate-node25-untouched-witnesses-20260920.log`.
- Global-match #6004 preservation: Node 25 **5P/0F** at
  `/private/tmp/js2-6648-candidate-node25-global-match-preservation-20260920.log`.
- Original Test262 `built-ins/RegExp/prototype/Symbol.match/g-success-return-val.js`:
  maintained Node 24 `scripts/run-test262-paths.mts --isolate --standalone`,
  manifest SHA `cb3c22547da83fc173fd6085d7efad9ac8c481592e0ea56190b47bdf9948b352`,
  **1 pass / 0 non-pass** at
  `/private/tmp/js2-6648-candidate-node24-g-success-standalone-isolate-20260920.log`.
- Adjacent #6648 fixture: Node 25 Vitest **17/17 framework passes**, comprising
  **14 semantic controls** and **3 `it.fails` residual pins**, at
  `/private/tmp/js2-6648-candidate-node25-producer-numeric-controls-final-20260920.log`.
  The defined-return map is preservation/allocation-invariant evidence, not a
  claimed new map gain.
- After a safe fast-forward to `de232b80e43dc82c2fafc331cc10d658f26a8897`
  (incoming paths were census artifacts/docs and `scripts/loc-budget-baseline.json`,
  with no #6648 source overlap), the repair hashes remained
  `array-methods.ts` `5cd7408c3b78699ca836adcb3339d8d21e9a851dba0c73e0ada6a9423c9f51a7`,
  `property-access.ts` `0cb90279fdd10c2da9f6a5c7835270e5b21b30d0f7e62f138b1ed51230259783`,
  and fixture `c756da802b4bc88818ed22b44157ba5ca40144401dc04331d2f10d2b3b1158a0`.
  Post-sync focused reruns are **17/17 framework passes** at
  `/private/tmp/js2-6648-candidate-de232-node25-producer-numeric-controls-final-20260920.log`
  and original `g-success-return-val.js` **1 pass / 0 non-pass** at
  `/private/tmp/js2-6648-candidate-de232-node24-g-success-standalone-isolate-20260920.log`.
  The same final fixture is **17/17 framework passes** (14 semantic controls,
  3 expected residual pins) under Node 22 at
  `/private/tmp/js2-6648-candidate-de232-node22-producer-numeric-controls-final-20260920.log`.

### Triad-pinned residuals outside this repair

The identical disposable probe was run with source SHA
`a67db3c6d19a88008d85df8e65072ee6b07c07f593f2175edaef877052fd206f` on the
exact #6004 parent `ae0a46be`, clean current `2f6c0f4f`, and this repair.
Each is **6P/3F**:

| residual | ae0 parent | clean 2f6 | #6648 candidate | owner / boundary |
| --- | --- | --- | --- | --- |
| unannotated `map(value => value)` unmatched capture traps | RuntimeError null deref | same | same | closure return ABI (`ref.as_non_null`) |
| dynamic `"index"` / `"input"` capture keys | returns `0` | same | same | standalone dynamic vec-key dispatch decline |
| `m[1].length` on unmatched capture | RuntimeError null deref | same | same | immediate-member null boundary, not JS TypeError |

Receipts are `/private/tmp/js2-6648-baseline-ae0-node25-map-numeric-defined-controls-20260920.log`,
`/private/tmp/js2-6648-baseline-2f6-node25-map-numeric-defined-controls-20260920.log`,
and `/private/tmp/js2-6648-candidate-node25-map-numeric-defined-controls-20260920.log`.
The earlier eight-control receipt (source SHA
`8d5e00739a0d9b911a143665da0441efc3298d4d0c9f781e752f1a327808d7da`) is
retained separately; it had the same three failures without the defined-map
preservation control. These rows are deliberately retained as `it.fails` pins,
not counted as semantic passes or hidden by this PR.
