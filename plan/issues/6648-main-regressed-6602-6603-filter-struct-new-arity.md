---
id: 6648
title: "main regressed tests/issue-6602 + issue-6603 (standalone): `filter` over a nullable vec element fails wasm validation (`struct.new` needs 6, got 2) and an inline native-string concat traps `dereferencing a null pointer`"
# Reopened after the completed producer/static-key repair for the separately
# planned dynamic numeric-string capture-read residual; the prior receipts stay
# below as completed historical scope, not pending work.
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
  # The follow-up keeps exact-capture dynamic key classification and raw-slot
  # boxing beside the finalized `__extern_get` vector arms that own ordering,
  # locals, and physical backing guards; extracting it would split that state.
  - src/codegen/object-runtime.ts
func-budget-allow:
  # The numeric capture boundary is an ordered arm in this existing lowering;
  # the helper's exact carrier check must remain beside its `struct.new` sites.
  - src/codegen/property-access.ts::compileElementAccessBody
  # This pre-existing >300 LOC finalizer grows by the exact-capture string-key
  # arm. `fillExternGetIdxVecArms` remains below the 300 LOC threshold and is
  # intentionally not granted.
  - src/codegen/object-runtime.ts::fillDynamicForinVecArms
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

## Follow-up: standalone dynamic numeric-string capture reads (planning only)

This is the remaining capture-element half of the dynamic-key work, tracked
under #6648 rather than allocated as a new external issue. It is deliberately
separate from the completed producer/numeric *static-key* repair above and
from #6649's landed metadata-routing change.

### Collision and prerequisite check

- The initial plan branch started at verified upstream
  `05b994b0cc5f7780cb9c7e5fc37c2b73339ba453`; its `plan/issues` inventory
  contained this #6648 record but no competing dynamic-numeric-capture
  follow-up record, and the upstream assignment log had no claim for that
  slice.
- After #6009 landed, this unpublished branch fast-forwarded without a dirty
  path overlap to verified upstream `647d10cc3e1297375e740e03823f8536042174d4`.
  Its merge `1ed7978413` contains the tested #6649 head
  `39d8a4a2d8704b5d74768457dff66001b9ee64b9`, now confirmed as an ancestor.
  The prerequisite's `property-access.ts` route arrives only through that
  upstream fast-forward; this follow-up neither copies it nor takes credit for
  its metadata gains.
- The published #6648 and #6649 worktrees remain frozen. #5198's global-flat
  result shape and generic standalone string-key work remain distinct owners;
  `closures.ts`, IR/context/layout, `array-nonindex-key.ts`, and generic
  expando/runtime behavior are outside this follow-up.

### Current source seam and unresolved representation question

Before the prerequisite, `compileElementAccessBody` explicitly excluded
`$__regexp_match_vec` from the generic dynamic-property route
(`!isRegexMatchVec`). On the current base, #6649 adds the ordered
capture-specific route: an identifier-typed key such as `let key = "1"` is
not a compile-time constant per `arrayIndexConstantKey`, satisfies
`isDynamicStringVecKey`, and reaches `emitDynamicVecElementGet`, then
`__extern_get` and `__extern_get_idx`.

The static literal spelling `result["1"]` is intentionally different:
`arrayIndexConstantKey` recognizes it and emits the physical nullable
native-string element load directly. It must remain an unchanged control.
The generic dynamic string arm instead parses through `__str_to_number`.
That helper is a deliberately broad StringToNumber/for-in mechanism, not an
ArrayIndex classifier: on the measured route it admits `"01"` and `"-0"` as
element indices. `"1.5"` currently reaches an absent result, but that outcome
does not make the helper an ArrayIndex classifier. A repair must not simply
broaden or retarget that generic arm.

The leading source hypothesis, **not yet a runtime conclusion**, is that a
null unmatched capture follows the generic vec arm through
`boxVecElementToExternref` as `extern.convert_any`, yielding null externref
instead of canonical JavaScript `undefined`. A raw probe must distinguish
that from an incorrect index selection or an unrelated lowering refusal before
any runtime code is changed.

### Frozen raw probe contract

`tests/issue-6648-standalone-regexp-dynamic-capture-numeric-string.test.ts`
contains independent, unwrapped semantic assertions for both `gc` and
`standalone`; it uses direct inline `RegExp.prototype.exec` results rather
than a callback/return wrapper. The fixture separately checks:

1. dynamic canonical keys `"0"`, `"1"`, and `"2"` on a fully matched capture,
   plus an unmatched optional capture at `"1"` and OOB `"4"`;
2. non-ArrayIndex spellings `"01"`, `"1.5"`, `"-1"`, and `"-0"`, each of
   which must be absent rather than coerced to a capture index;
3. dynamic `index`, `input`, and `length` metadata, a literal `"1"` static
   control, and exactly-once receiver/key evaluation;
4. standalone `WebAssembly.Module.imports(module) === []`.

The value checks encode a small discriminator: expected `undefined`, null,
and a wrong selected string produce distinct numeric outputs. The fixture is
intentionally **not** wrapped with `it.fails`: after #6649 lands it is the raw
same-base baseline/candidate instrument, not an acceptance-mask mechanism.
No runtime receipt exists yet.

### Conditional implementation and validation plan

After #6649 has landed, first run the frozen fixture unchanged on the fresh
landed base, retain every row and its actual value code, then run it on a
candidate with the identical runner/options. The initial raw A/B uses the
maintained Node 24 executable, `COMPILER_POOL_SIZE=1`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, and one Vitest fork:

```sh
COMPILER_POOL_SIZE=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 \
  /Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/vitest/dist/cli.js run \
  tests/issue-6648-standalone-regexp-dynamic-capture-numeric-string.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

Node 25 parity follows only if that raw evidence warrants a runtime candidate.
If the unmatched/OOB value probe confirms the null-externref hypothesis, a
capture-subtype-specific runtime arm may be proposed in
`src/codegen/object-runtime.ts`, ordered ahead of the generic `$__vec_base`
numeric-string arm. It must accept only proved canonical ArrayIndex strings,
preserve actual string slots, turn only absent/unmatched capture elements into
canonical `undefined`, and fall through for metadata and named/sidecar
properties. The exact runtime classifier and arm order need source proof at
that time; no generic `boxVecElementToExternref` or `__str_to_number` change is
authorized.

Likely eventual file scope is that runtime helper, this focused test, and this
issue record. `property-access.ts` remains #6649's prerequisite boundary
unless a fresh landed-base audit proves an unavoidable, reviewed dependency.
Required validation is the frozen same-base A/B, a literal-key control,
host/GC preservation, standalone zero-import assertion, the original
`g-success-return-val.js`, and normal scoped gates only after the runtime
evidence justifies an implementation.

### Landed-prerequisite raw baseline (2026-09-20)

With #6009 present through upstream `647d10cc3e1297375e740e03823f8536042174d4`,
the frozen fixture was run unchanged under the planned Node 24,
`COMPILER_POOL_SIZE=1`, 3072 MB, single-fork command. The first revision's
28-row receipt is retained separately because its receiver/key assertion
encoded side-effect counts and value representation into a single `0` result:

- revision-1 fixture SHA-256:
  `a91bb7316b155db23fb479698cfeaeae2e46303fbfaa60582550d9046ec3ff32`;
  receipt `/private/tmp/js2-6648-dynamic-capture-numeric-raw647d-node24.54eLqZ`
  (SHA-256 `e76506fa32c020b763d8bee0bd0007f1c4b8e4881cac10cff94174eab079bffd`);
  **24 pass / 4 fail**.

The only probe change made after that receipt was the receiver/key result
encoding: `100 * receiverCalls + 10 * keyCalls + valueCode`, where undefined,
null, and another value are respectively `1`, `2`, and `3`. The corrected raw
fixture SHA-256 is
`169f69f48b3aed247a479586e3f2ca87117b17047018e545de920ae62a481021`.
Its same-base replacement run is
`/private/tmp/js2-6648-dynamic-capture-numeric-raw647d-node24-r2.XrghpI`
(SHA-256 `4607e0266884306857ef03c193bc6257e827ab5507edb56ffcbe9437fa0cc7c6`),
again **24 pass / 4 fail**:

- GC: **14/14 semantic pass**.
- Standalone: **10/14 semantic pass**. Canonical dynamic `"0"`, `"1"`, and
  `"2"`, OOB `"4"`, `"1.5"`, `"-1"`, literal `"1"`, and dynamic
  `index`/`input`/`length` all pass.
- The unmatched optional capture returns discriminator **2**, confirming a
  null value where JavaScript requires `undefined`.
- The exactly-once probe returns **112**, proving receiver count 1 and key
  count 1 while confirming that same null result; it is not a double-evaluation
  defect.
- `"01"` returns discriminator **3** (the matched capture at index 1), and
  `"-0"` returns discriminator **3** (the full match at index 0). They are
  distinct noncanonical-key acceptance defects, retained as raw acceptance
  requirements rather than filtered expected failures.

No production source changed for either run. The output proves a
capture-specific value/classification problem on the landed route, but does
not yet select the runtime arm or justify a generic helper change.

### Revised source-proven capture-only candidate (2026-09-20; pending review)

The candidate stays confined to `src/codegen/object-runtime.ts`, but uses two
deliberately separate finalize-time seams:

1. `fillDynamicForinVecArms` classifies a string key on the exact
   `__regexp_match_vec` carrier and delegates a canonical index to the existing
   `__extern_get_idx` helper.
2. `fillExternGetIdxVecArms` owns the exact capture carrier's physical-slot
   boxing, where and only where a raw unmatched nullable-native-string slot
   becomes canonical JavaScript `undefined`.

It does not alter `property-access.ts` (#6649's landed route),
`boxVecElementToExternref`, `__str_to_number`, generic vec boxing,
`vec-overlay.ts`, IR, context, or layout code. In particular, it must **not**
read capture backing directly in `__extern_get`: that would bypass the indexed
overlay, deletion, getter, and prototype precedence centralized in
`__extern_get_idx`.

#### Exact discriminator and delegated dynamic path

At finalization, resolve `ctx.structMap.get("__regexp_match_vec")` and verify
its nullable-native-string backing through `getArrTypeIdxFromVec`. This is
narrower than `$__vec_base`: the capture carrier has `{ length, data, index,
input, groups, indices }`, whereas a global `@@match` result remains the
ordinary two-field native-string vec.

`fillDynamicForinVecArms` retains its existing `length` and `constructor`
handling. Within its string-key path, the exact-capture sub-arm calls the
existing `__obj_index_of_key` parser:

- for a non-negative result, it calls the **unchanged** `__extern_get_idx`
  with the original receiver and parsed f64 index, returning that result
  without inspecting or normalizing it;
- for parser result `-1`, it neither calls the generic `__str_to_number` arm
  nor returns, so the key falls through to the existing physical/named reader.

#### Canonical classification and physical capture-slot boxing

`__obj_index_of_key` accepts only `"0"` or non-leading-zero decimal digits in
its bounded signed-index domain; it rejects `"01"`, `"-0"`, `"1.5"`, and
negative spellings. This is a capture-slot classifier, not a claim to implement
the complete JavaScript ArrayIndex domain. Rejected spellings remain ordinary
named properties.

`fillExternGetIdxVecArms` currently inserts typed-vector readers immediately
after `__extern_get_idx`'s three-instruction preamble. Add one exact
`ref.test $__regexp_match_vec` reader before the generic native-string vec arm.
It reuses the current truncation, logical-length, physical-backing guard, and
`idxMiss()` behavior exactly. Its sole new operation is at the final raw
`array.get`: tee the nullable native-string slot, test that *raw* value for
null, emit `canonicalUndefinedExternInstrs(ctx)` for that branch, and otherwise
`extern.convert_any` the non-null string.

The later `fillVecOverlayHelpers` pass prepends its `__extern_get_idx`
prologue ahead of these physical arms. Consequently a deleted index, accessor,
or companion-authoritative descriptor returns before the capture reader runs.
A user-defined numeric descriptor whose value is JavaScript `null` remains
`null`; the candidate never post-processes an arbitrary `__extern_get_idx`
result. Likewise, OOB/prototype behavior remains in the existing `idxMiss()`
path rather than being normalized as an unmatched capture.

#### Noncanonical fallback

If `__obj_index_of_key` returns `-1`, the capture branch intentionally does
**not** call the generic `__str_to_number` arm and does not return. Control
falls through to the pre-existing closed-struct field reader, so dynamic
`"index"` and `"input"` retain their physical metadata semantics. Other
noncanonical names then reach the existing non-object miss route:
`buildVecOrClosurePropGetMissArm` → `__vec_prop_get` → the vector's own bag
and receiver-aware Array/Object-prototype lookup, followed by the ordinary
undefined miss. Thus `"01"`/`"-0"` are absent in the raw probe without
silently suppressing a supported named sidecar or prototype property. Existing
same-name metadata shadowing stays the documented physical-field precedence;
this slice neither changes nor claims to repair it.

#### Implementation and validation boundary

The planned production hunk adds only the exact-capture canonical classifier
in `fillDynamicForinVecArms` and exact raw-slot boxing in
`fillExternGetIdxVecArms`. Any helper indices are resolved after any required
provisioning so a finalizer cannot retain stale numeric handles. It must leave
every non-capture vec byte/behavior path unchanged.

The frozen 28-row fixture remains the strict candidate acceptance instrument:
no `it.fails`, no dropped rows, and no rewritten expected values. A successful
candidate must turn the four measured standalone rows green while retaining
all 24 previous semantic passes, the 14/14 GC controls, zero imports,
metadata reads, static literal access, and exactly-once receiver/key evidence.

Add compact, independently compiled baseline/candidate controls for the
precedence this reader relies on:

1. an own numeric descriptor on a capture result with value `null`, read by a
   mutable dynamic `"1"` key, remains `null`;
2. an own numeric accessor on that key runs and returns its accessor value;
3. deleting that numeric own capture slot does not reveal its raw backing
   capture; and
4. after deletion, an inherited numeric Array-prototype value (including
   `null`) remains the existing prototype result rather than being normalized
   as an unmatched capture.

The same separate fixture also keeps two parser-domain controls: an inherited
canonical Array-prototype key at `"2147483648"` (without allocating that
index), and own plus inherited named `"01"` values. The capture parser rejects
all of those spellings, so they prove the named-property fallback rather than
assuming its pre-patch behavior survives.

These controls must keep receiver/key single evaluation and report both
baseline and candidate outcomes. The post-patch blast radius also includes the
existing #6648 capture regression fixture, #6649 dynamic-metadata fixture, and
the two preserved `RegExp.prototype[Symbol.match]` originals; physical-slot
boxing serves indexed HOF reads too. The known nullable-map residual is neither
assumed fixed nor assumed preserved: an unexpectedly passing `it.fails` row is
new evidence, never a reason to restore a bug. No new property store, generic
boxing rule, or runtime-prototype mechanism is authorized.

### Dynamic numeric follow-up: measured runtime checkpoint

Both sides use base `647d10cc3e1297375e740e03823f8536042174d4`, Node
24.19, compiler pool 1, a single Vitest fork, and a 3072 MB fork heap. The
candidate source SHA256 is
`fd91f1c8bfd9523cf63bd373c4a3e048a5be9e85b75b11ef120667b24c02b026`.
These are focused fixtures, not a new authoritative Test262 census.

- Frozen raw28 fixture SHA256:
  `169f69f48b3aed247a479586e3f2ca87117b17047018e545de920ae62a481021`.
  Clean baseline **24/28**; candidate **28/28**, four failures repaired and
  zero previously passing cases lost. All fourteen GC controls pass on both
  sides. The repaired standalone cases are unmatched dynamic `"1"`, absent
  noncanonical `"01"` and `"-0"`, and the exactly-once receiver/key witness.
  Baseline log:
  `/private/tmp/js2-6648-dynamic-capture-numeric-raw647d-node24-r2.XrghpI`.
  Candidate was independently run by root, exit 0, 12.33 seconds; the
  transcription receipt is `.tmp/6648-root-raw28-receipt.md`, backed by task
  tool session 17722, terminal chunk `c278c6` (not a raw log file).
- Frozen overlay7 fixture SHA256:
  `d9d891e1858cb41c4c7168aea908e25c67cf6b5e6862eba76ebdb84b531659fb`.
  Clean baseline **5/7**; candidate **6/7**. Inherited noncanonical `"01"`
  changes from the wrong capture value to the inherited named value. Own
  explicit null, own accessor, deletion, inherited high canonical index, and
  own noncanonical name retain their passing behavior. Inherited explicit
  null after deleting a capture remains wrong (`undefined`) on both sides;
  this preexisting residual is not repaired or counted as a pass. Logs:
  `/private/tmp/js2-6648-overlay-baseline-647d-node24.uKOnCx` and
  `/private/tmp/js2-6648-overlay-candidate-647d-node24.zIibNA`.
- Unmodified prior capture-output and dynamic-metadata fixtures contain
  37 cases. Their baseline has one expected-failure inversion (dynamic
  metadata already repaired by PR #6009); the candidate has that inversion
  plus the newly repaired dynamic numeric-string case. There are no newly
  failing ordinary assertions. The identity-map, immediate-member TypeError,
  and global-match dynamic metadata residuals remain expected failures.
  Preserve these raw receipts, then promote the two repaired pins to strict
  passing tests without attributing the older metadata repair to this patch.
  Logs:
  `/private/tmp/js2-6648-6649-preservation-baseline-647d-node24.KFb1Vl` and
  `/private/tmp/js2-6648-6649-preservation-candidate-647d-node24.EXg2rr`.

Independent read-only review of the two helper changes found no concrete
source-order or ABI defect: no late function/import is minted, overlay reads
precede physical null normalization, and rejected canonical-index spellings
retain named-property fallback. This is source review, not generated-Wasm
verification. Before publication, add a matched/non-null capture deletion
control so undefined normalization cannot mask ignored deletion, finish the
two original Test262 preservation checks, and run scoped repository gates.

### Maintained-fixture reconciliation after the focused A/B (2026-09-20)

The raw A/B fixtures and their immutable receipts above remain the attribution
record. The maintained fixtures are reconciled separately so a passing repair
does not make an `it.fails` pin look green by inversion:

- The #6648 dynamic `index`/`input` pin is strict again because it already
  passes on unchanged `647d`; that behavior belongs to landed PR #6009 and is
  not attributed to this object-runtime change.
- The #6649 standalone dynamic numeric-string capture-element pin is strict
  because it fails semantically on clean `647d` and passes with this candidate.
- The overlay fixture retains all seven original control names. Its inherited
  explicit-null-after-delete row is a clearly marked expected-failure residual:
  it returns `undefined` on both baseline and candidate, while the raw logs
  preserve the real failed assertion. This slice does not broaden into the
  vector prototype/overlay implementation needed to repair it.
- A separate matched-slot deletion control uses `exec("abc")`, deletes the
  non-null capture at dynamic key `"1"`, and expects `undefined`. It ensures
  the candidate's unmatched-null normalization cannot hide an ignored delete.

The final post-sync focused rerun must report framework passes separately from
the one known expected-failure overlay residual; it must never count the pin as
a semantic pass. The source budget grant is intentionally exact: this follow-up
adds `object-runtime.ts` to the file allowance and only
`fillDynamicForinVecArms` to the function allowance. The physical reader stays
below the 300-LOC function threshold.

### Current dynamic-capture follow-up state (2026-09-20)

This bounded reader slice is ready for the normal commit/publication gates on
`ac76d8c6cd63864e04de4592a5179050ff1b1f91`; it does not close the broader
#6648 umbrella or its remaining return-ABI/prototype residuals.

- The four maintained candidate fixtures complete with **73 framework passes**:
  **69 semantic passes** plus four explicitly named expected-failure pins. The
  exact Node 24 pool-1/single-fork receipt is
  `.tmp/6648-root-final73-receipt.md`; it records the unchanged production
  SHA256 `fd91f1c8bfd9523cf63bd373c4a3e048a5be9e85b75b11ef120667b24c02b026`.
- The matched non-null deletion test is 1/1 on clean `647d` with the same
  overlay fixture bytes, so it is a preservation check rather than a claimed
  new gain. The inherited-null deletion row remains the one baseline-matched
  expected failure in that fixture.
- TS7 and explicit Prettier checks are terminal green. The two preserved
  `RegExp.prototype[Symbol.match]` Test262 originals reran after the `ac76d8`
  sync as **2 pass / 0 non-pass** under the maintained isolated standalone
  runner.

Normal repository gates, commit, push, and PR CI remain separate publication
steps. Do not summarize this focused evidence as a full Test262 census or a
resolution of the remaining #6648 umbrella residuals.
