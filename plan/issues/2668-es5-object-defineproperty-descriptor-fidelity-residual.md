---
id: 2668
title: "ES5: canonical vec-index Object/property MOP residual"
status: ready
created: 2026-06-25
updated: 2026-08-25
loc-budget-allow:
  - src/codegen/vec-overlay.ts
  - src/codegen/typeof-delete.ts
func-budget-allow:
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 5
language_feature: property-descriptors
goal: es5
related: [1460, 1462, 929, 3185, 3663, 4008, 4158, 4197, 4222]
sprint: current
horizon: l
---

# #2668 — ES5 canonical vec-index Object/property MOP residual

## 2026-08-16 standalone census (dispatch context)

Fresh CI baseline (2026-08-16, corpus `b363f29d`): standalone ES5 is
**8,454 / 9,029 (575 nonpasses)**. The defineProperty family
(`defineProperty` 49 + `defineProperties` 17 + `create`/`getOwnPropertyNames`/
`keys`/gOPD ~20) is **86 rows — the largest single-issue cluster**. Per-cluster
signatures and the full file list:
`plan/log/analysis-2026-08-16-es5-standalone-575.md` (§defineProperty-family).
Cluster size is a ceiling, not a flip forecast (#3626 §2.1 method).

Of those 86, **39 are array-receiver** rows (this issue's vec-index MOP scope)
and 47 are not — the largest non-array sub-clusters being mapped-`arguments`
exotics (~8, explicitly out of scope below) and plain-object accessor
attributes (~6, owned by #4479's lane). Classified 2026-08-16 by receiver shape
before any code was touched, so the two lanes do not double-fix.

## Landed slice — S-set: ordinary indexed set creates all-true data (2026-08-16)

PR: `fix(#2668): standalone ordinary indexed set must create an all-true data
property`. Branch `issue-2668-defineproperty-fidelity`, lane
`ttraenkler/opus-es5-a` (stood down after this slice; claim released, so the
issue is back at `status: ready` and **unassigned** — it is NOT done).

**This slice is NOT M1 and does not consume it.** M1 (the four-state classifier,
absence ranges, IR seam) is untouched and still the approved next big step. What
landed is a one-constant defect found while grounding M1 against current main —
it sits *underneath* M1's contract, so fixing it first removes noise from every
later M1 measurement.

### What was wrong

`__extern_set`'s vec prologue routes an indexed write on an `any`/externref
array receiver to `__vec_dp_value` with flags `HOST_HAS_VALUE` (`1 << 7`) —
`hasValue` and nothing else. When the index did **not** already exist,
CompletePropertyDescriptor filled the three omitted attributes with `false`, so
every ordinary `a[i] = v` that grew the array minted a
non-writable/-enumerable/-configurable own property. The follow-on legal
redefine then threw and aborted the module.

Control reaches that site only with **no** companion entry for the key (every
non-null-entry arm above returns), so the index is either an implicit dense
element (effective W/E/C all true, which `__vec_dp_value`'s seed materialises)
or brand new (CreateDataProperty ⇒ all true). All-true is right in both cases,
so the fix is `SEED_FLAGS` in place of `HOST_HAS_VALUE`.

### Why the M1 spec did not name it

The spec's root-cause section correctly names the *host* pre-growth /
first-definition workaround and the standalone `buildRealElementSeed`
`index < length` over-seed. Both are real. This defect is their mirror image on
the **write** side and in the opposite direction — an under-specified descriptor
on the create path — and it is invisible to every probe that presizes, uses a
literal, uses `push`, or uses a typed `number[]`, because each of those makes
the index backed before the write and the seed then supplies the true bits.
Four independent "works fine" readings is why it survived.

### Measured

**Test262, real runner, same population and matched settings.**
`scripts/harness-flip-probe.ts --files <the 86-row family> --target standalone
--timeout 180000`, both arms run back-to-back on the same box, differing only in
`src/codegen/vec-overlay.ts` (base = `d38224d53`, the branch point; head = the
same tree with the flag constant changed):

```
before : {"fail":86}            after : {"fail":82,"pass":4}
union 86 · partition verified 86 == 86
fail -> pass 4 · pass -> fail 0 · other status change 0 · unchanged 82
NET +4
```

The four: `defineProperty/15.2.3.6-4-210`, `defineProperty/15.2.3.6-4-212`,
`defineProperties/15.2.3.7-6-a-206`, `defineProperties/15.2.3.7-6-a-208` — the
dense-default-element sub-cluster exactly, which is what the mechanism predicts.
No claim is made beyond this partition.

**Unit A/B (mechanism only, not conformance).** 11 rows per lane through
`compile()`:

- standalone **5 fixed, 0 regressed** — grow-from-`[]`, grow-from-`new Array`,
  presized-then-write (all `0` → `111` packed W/E/C), same-value redefine
  (threw → clean), empty redefine (`0` → `111`).
- host **byte-identical on all 11**; the change is inside a `ctx.standalone`
  branch. Five host rows are wrong in *both* arms (pre-existing host gaps, named
  in the test's `HOST_SKIP`).

### Still open, measured on current main, standalone (not in this slice)

- `Object.keys` / `getOwnPropertyNames` enumerate the **unbacked tail**:
  `[0,1,2]` with `length = 6` reports 6 keys and 7 names (expected 3 and 4).
  This is the enumeration half of the four-state contract — M1 §4.
- Array `length` above `2^31-1`: `defineProperty(a, "length", {value:
  4294967294})` leaves `length` at `0` (6 rows: `15.2.3.6-4-154/-155/-183`,
  `15.2.3.7-6-a-150/-151/-179`). The vec length field is a signed i32, so this
  needs a uint32 length representation, not a validation fix.
- `delete` on a vec returned by `Object.keys`/`getOwnPropertyNames` is not
  observed by the reader (`15.2.3.14-5-a-4`, `15.2.3.4-4-b-6`).
- Host `_vecDefineOwnProperty`'s first-definition workaround (host reports
  all-false after an empty redefine) — unchanged, host-side.

## 2026-08-25 follow-up slice — indexed `typeof` must observe overlay state

Standalone `typeof a[i]` comparisons were folded from the checker-visible
element type even when the module's descriptor overlay was armed. A delete on
an `Object.keys` result therefore produced a runtime tombstone that dynamic
reads observed, while the static-looking `typeof array[0]` comparison stayed
folded to the original element type. The comparison path now suppresses that
fold only when the standalone overlay route is active; the existing routed
element read and `__typeof_*` helper provide the actual result.

**Measured, authentic harness, exact 86-row family, standalone.** Base
`ef5b5d335` (52 pass / 34 fail); head with this slice (53 pass / 33 fail).
Partition: 1 fail → pass, 0 pass → fail, 0 other status changes, 85
unchanged; **NET +1**. The gained row is
`test/built-ins/Object/keys/15.2.3.14-5-a-4.js`. The four-row controls in the
focused standalone vector suites remained green; the existing dynamic-HOF
control failure (`expected 4, got 3`) is unrelated and unchanged.

### Instrument note for the next lane

`node scripts/build-quickjs-eval-provider.mjs` **cannot build in this
container** (no `clang-18`, no `cmake`) and no prebuilt artifact is cached, so
every eval-shaped row reports a manufactured
`JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built` failure.
`15.2.3.6-4-594` in this family is one of those — treat it as **unmeasured**,
not failing. Separately, under box load `harness-flip-probe`'s default 60 s
timeout turned 20 of 86 rows into `compile_error: compilation timeout (91 s)`;
pass `--timeout 180000` and avoid concurrent compiles or the arm is noise.

### Merge-queue note — the −42 park on this PR is NOT this change

The first `merge_group` run auto-parked PR #4631 with 42 standalone / 44 host
regressions. They are **inherited from `main`**, not caused here:

- PR #4627 (`refactor(#4514)`, unrelated code) reports the **same** standalone
  bucket signature `37d9311a9cb806e4` with the **same 42 files** — the guard's
  own drift test.
- The edit is inside `fillVecOverlayHelpers`, which early-returns unless
  `ctx.standalone`, so it cannot reach host codegen — yet host regressed 44.
- Every regressed file asserts `Array.isArray` (~40 ×
  `dstr/dflt-ary-ptrn-rest-id-exhausted`, 3 × `Object/entries/getter-*`), which
  is the subject of `ef1a41d0d fix(#1888): Array.isArray static fast path
  claimed every ref is an array`, merged to main after the baseline snapshot.

Useful side-effect: the improvement counts differ by exactly 4 between the two
parked PRs (8 here, 4 there), which is an **independent full-corpus
confirmation** of this slice's +4, measured on the same four files as the local
86-row arm.

## Decision

The next approved slice is **2668-M1: IR-first canonical vec own-index MOP**.
It carries the direction landed in PR #4435 forward as an implementation-ready
plan:

1. make the exact ambient `Object.defineProperty(target, key, descriptor)` IR
   operation lane-neutral without widening its carrier proof;
2. give host and standalone vec providers the same four observable index
   states: `ABSENT`, `DEFAULT_DATA`, `EXPLICIT_DATA`, and `ACCESSOR`;
3. converge the readers and writers needed by the fresh 13-row canonical
   vec-index slice on that state query; and
4. prove the change with same-population base/head/kill-switch A/B in both
   lanes, followed by the complete 9,029-file ES5 gate.

This is not a claim that 13 tests will flip. The 13 files are the exact current
at-risk denominator for M1. Report every row after implementation; if a row is
blocked by a different measured mechanism, stop and obtain architecture
approval before narrowing acceptance.

Slices already landed under this issue and must not be reopened by M1:

- Slice A: host routing for literal-resolvable dynamic descriptors and typed
  struct-field value writeback.
- Slice B: host accessor getter/setter identity preservation.
- Slice C: host/standalone array-`length` define validation and simple
  `ArraySetLength` support.

## Current-main ground truth — 2026-08-13

### Provenance

- `git ls-remote origin refs/heads/main` resolved server `origin/main` to
  `cb4d4d7ca2f151ba69f26cff517417e003428df7` before this audit.
- The committed oracle artifacts name compiler baseline SHA
  `1fcb363695415ff3a09e338feade66132c93dd50`, oracle v13, lane `honest`.
  `cb4d4d7` is its direct child and changes only reports, manifests, README,
  and the LOC budget; there is no intervening `src/` or `tests/` change.
- The exact test262 gitlink is
  `b363f29d3c43c626dc852744ad64a0b48a003693`.
- Fresh forced inputs are `.test262-cache/test262-current.jsonl` and
  `.test262-cache/test262-standalone-current.jsonl`, each with 48,735 unique
  full-population rows. They exactly reproduce the committed host and
  standalone aggregates. They are local measurement artifacts and must not be
  committed.
- The edition manifest classifies 9,174 ES5 paths. Removing its 145 Intl402
  paths, which are outside the landing baseline, leaves the authoritative
  **9,029** landing-ES5 paths. The join has no duplicate, missing-host, or
  missing-standalone rows.

The resource gate was satisfied before both forced fetches and the census:
macOS page size 16,384 bytes; free + inactive + speculative memory was
7,583,907,840 bytes (7.063 GiB); disk available was 2,943,584 KiB (2.807 GiB)
before fetching and 2.621 GiB afterward. Disk later fell below 2 GiB, so no
additional heavy run was attempted. Every developer census or full gate must
recheck **free + inactive + speculative memory >= 2 GiB and disk available >=
2 GiB immediately before starting**. A failed resource check invalidates the
run; it is not permission to run a smaller or different population.

### Exact 9,029-row lane census

| Status | Host | Standalone |
|---|---:|---:|
| pass | 7,415 | 8,275 |
| fail | 1,597 | 697 |
| compile error | 14 | 53 |
| compile timeout | 3 | 4 |
| **total** | **9,029** | **9,029** |

The exact joint partition is:

| Joint status | Files |
|---|---:|
| pass in both lanes | 7,160 |
| host non-pass, standalone pass | 1,115 |
| host pass, standalone non-pass | 255 |
| non-pass in both lanes | 499 |
| **total** | **9,029** |

`compile_error` and `compile_timeout` are non-pass results. The published
baseline's full-population totals are not the ES5 denominator and must not be
mixed into this table.

### Exact issue family

The current issue-family selector is:

```text
^test/built-ins/Object/(defineProperty|defineProperties|create|getOwnPropertyDescriptor|freeze|seal|preventExtensions|isFrozen|isSealed|isExtensible|getOwnPropertyNames|keys)/
```

It selects exactly 567 host non-passes: 563 failures and four compile errors.
Of those, 492 pass standalone and 75 are non-passes in both lanes.

| API | Host non-pass | Standalone pass | Both non-pass |
|---|---:|---:|---:|
| `defineProperty` | 299 | 260 | 39 |
| `defineProperties` | 175 | 159 | 16 |
| `create` | 44 | 36 | 8 |
| `getOwnPropertyDescriptor` | 27 | 23 | 4 |
| `getOwnPropertyNames` | 4 | 1 | 3 |
| `preventExtensions` | 3 | 1 | 2 |
| `freeze` | 8 | 7 | 1 |
| `isSealed` | 2 | 2 | 0 |
| `keys` | 5 | 3 | 2 |
| `seal`, `isFrozen`, `isExtensible` | 0 | 0 | 0 |
| **total** | **567** | **492** | **75** |

The family total, its lane split, and the 13 M1 rows are unchanged from the
PR #4435 direction, but the repository tip, oracle provenance, and global lane
counts are refreshed here. Historical estimates are not acceptance inputs.

## Fresh M1 candidate census

The exact current candidate is **0/13 pass in host and 0/13 pass in
standalone**. Host reports 11 failures plus two compile errors; standalone
reports 13 failures.

| Test262 path | Host | Standalone | Contract exercised |
|---|---|---|---|
| `test/built-ins/Object/defineProperty/15.2.3.6-4-191.js` | fail | fail | defining a value-less own index over an inherited index creates present `undefined` and shadows the prototype |
| `test/built-ins/Object/defineProperty/15.2.3.6-4-210.js` | compile error | fail | a dense default element begins W/E/C=true; an empty redefine preserves it |
| `test/built-ins/Object/defineProperty/15.2.3.6-4-212.js` | compile error | fail | an explicit same-value/W/E/C redefine of a default element is legal |
| `test/built-ins/Object/defineProperty/15.2.3.6-4-216.js` | fail | fail | a fresh explicit data index defaults omitted W/E/C to false |
| `test/built-ins/Object/defineProperty/15.2.3.6-4-251.js` | fail | fail | a fresh object value defaults W/E/C false; illegal later value replacement throws and preserves identity |
| `test/built-ins/Object/defineProperties/15.2.3.7-6-a-187.js` | fail | fail | plural define creates a present value-less index rather than exposing backing/prototype data |
| `test/built-ins/Object/defineProperties/15.2.3.7-6-a-198.js` | fail | fail | plural redefine preserves effective enumerable state |
| `test/built-ins/Object/defineProperties/15.2.3.7-6-a-211.js` | fail | fail | plural fresh data definition materializes present `undefined` with false defaults |
| `test/built-ins/Object/defineProperties/15.2.3.7-6-a-231.js` | fail | fail | configurable default data may convert to an accessor while preserving omitted E/C |
| `test/built-ins/Object/freeze/15.2.3.9-2-a-14.js` | fail | fail | freeze makes every present dense data index writable=false and configurable=false |
| `test/built-ins/Object/keys/15.2.3.14-5-13.js` | fail | fail | sparse own-key enumeration omits holes/non-enumerable indices and retains a far present index |
| `test/built-ins/Object/keys/15.2.3.14-5-a-4.js` | fail | fail | deleting index 0 from the returned key vec makes it absent, not present `undefined` |
| `test/built-ins/Object/getOwnPropertyNames/15.2.3.4-4-b-6.js` | fail | fail | deleting index 0 from the returned names vec makes HasOwn report false |

The two host compile errors are invalid Wasm `struct.get` type mismatches, not
passes hidden by the harness. M1 must make them valid and semantically correct;
disabling validation or reclassifying them is not an acceptable flip.

## Root cause

Vec `length`, backing capacity, backing value, descriptor metadata, and
own-property presence are different facts, but current code reconstructs them
as if `0 <= index < length` always meant a live default element.

### Host provider

- `src/codegen/object-ops.ts:1010-1021` pre-grows host vec length before the
  runtime descriptor provider validates the define. By the time
  `_vecDefineOwnProperty` runs, it cannot distinguish the new index from an
  existing default element.
- `_vecDefineOwnProperty` (`src/runtime.ts:6041`) therefore contains a deliberate
  workaround: an in-bounds index with no sidecar can be treated as a first
  definition. That fixes one fresh-index shape while corrupting the opposite
  dense-default shape.
- `_readOwnDescriptor` (`src/runtime.ts:5345`), `_safeGet`
  (`src/runtime.ts:4506`), `_wasmStructHasOwn` (`src/runtime.ts:3625`),
  `_ownStructKeys` (`src/runtime.ts:5573`), and `_wrapVecForHost`
  (`src/runtime.ts:6237`) independently infer vec presence. Proxy traps in
  `_wrapVecForHost` currently expose every index below length as own.
- Host `__object_keys` (`src/runtime.ts:10668`) and
  `__getOwnPropertyNames` (`src/runtime.ts:11542`) have further independent vec
  enumeration loops. Freeze/seal via `_testIntegrityLevel`
  (`src/runtime.ts:787`) cannot synthesize effective attributes for implicit
  default indices from the same source of truth.

### Standalone provider

- The overlay already owns descriptor entries and the flags
  `FLAG_COMPANION_VALUE` and `FLAG_DELETED_INDEX`
  (`src/codegen/vec-overlay.ts:106-107`), but it has no compact representation
  for all absent ranges.
- `buildRealElementSeed` (`src/codegen/vec-bag-seed.ts:109`) seeds every
  in-bounds index as a real default element when no companion entry exists.
  Elisions, length-grown holes, and never-written gaps therefore become
  indistinguishable from dense values.
- `buildVecHasIdxPresencePrologue`
  (`src/codegen/vec-overlay-presence.ts:99`) can recognize an explicit deleted
  entry, but absence is not consistently shared with reflection, reads, or
  enumeration.
- `fillDynamicForinVecArms` (`src/codegen/object-runtime.ts:8108`) gates indexed
  enumeration through presence only when `overlayRouteActive`
  (`src/codegen/typed-lane-overlay-route.ts:63`) is true. That gate omits
  `usesArrayHoles`, and `Object.keys` additionally needs effective
  enumerability, not presence alone.
- `fillGopnVecArm` (`src/codegen/vec-overlay-keys.ts:453`) and integrity
  mutation (`src/codegen/object-runtime-integrity.ts:100`) consume different
  portions of the same state.

### Values cannot encode absence

`$Hole` in `src/codegen/array-holes.ts` works only for externref element
carriers. Numeric array literals select f64 storage, and
`compileArrayLiteral` (`src/codegen/literals.ts:3772`) uses the same sNaN
storage sentinel for an elision and explicit `undefined` in f64 context. Null,
`undefined`, every number, and every string are legal present data values.
Presence therefore needs metadata independent of the backing value and element
type.

## Normative four-state contract

Every canonical vec index is in exactly one state:

| State | Own property? | Descriptor and value authority |
|---|---|---|
| `ABSENT` | no | no own descriptor; Get/HasProperty may continue on the prototype; omit from own keys |
| `DEFAULT_DATA` | yes | backing vec value; effective writable/enumerable/configurable are all true |
| `EXPLICIT_DATA` | yes | explicit descriptor flags; backing value unless `FLAG_COMPANION_VALUE` selects the companion value |
| `ACCESSOR` | yes | explicit getter/setter and attributes; never fall through to backing data |

Use numeric constants `ABSENT=0`, `DEFAULT_DATA=1`, `EXPLICIT_DATA=2`, and
`ACCESSOR=3` in the Wasm helper ABI. Do not expose those numbers outside the
vec MOP modules.

Canonical index parsing retains the exact `_asArrayIndex`
(`src/runtime.ts:5997`) contract: reject `"01"`, `"-0"`, `"1.0"`, symbols,
named keys, and `2^32-1`. Parse once per operation. A rejected key follows the
existing named-property MOP and never enters the vec-index classifier.

### Absence representation

Presence is **default-with-absence-exceptions**: an index below logical length
is `DEFAULT_DATA` unless an absence range or explicit descriptor says
otherwise. Do not allocate a descriptor entry per dense element or per hole.

Host ownership in `src/runtime.ts`:

- add `_wasmVecAbsentRanges: WeakMap<object, number[]>`;
- store sorted, disjoint, half-open bounds as
  `[start0,end0,start1,end1,...]`;
- add `_vecAbsentHas`, `_vecAbsentMarkRange`, `_vecAbsentClearIndex`, and
  `_vecAbsentTruncate`; and
- weakly key all state by vec identity so dead instances remain collectable.

Standalone ownership in `src/codegen/vec-overlay.ts`:

- extend `$__overlay_pair` created by `ensureOverlayCore` at line 269 with a
  mutable nullable `$__overlay_absence` reference;
- define `$__overlay_absence_bounds` as a mutable i32 array and
  `$__overlay_absence` as `{count: mut i32, bounds: mut ref
  $__overlay_absence_bounds}`;
- keep the same sorted, disjoint, half-open representation; and
- emit `__vec_absent_has`, `__vec_absent_mark_range`,
  `__vec_absent_clear_index`, and `__vec_absent_truncate` as native symbolic
  helpers. Growth is geometric; marking `[6,10000)` must not perform 9,994
  descriptor writes.

Construction and typed-write codegen cannot mutate the host WeakMap directly.
Give `src/codegen/vec-index-state.ts` lane adapters for the same three writer
operations:

- host emits imports `__vec_absent_mark_range(externref,i32,i32)`,
  `__vec_absent_clear_index(externref,i32)`, and
  `__vec_absent_truncate(externref,i32)`, implemented by `buildImports`
  (`src/runtime.ts:16239`) over the WeakMap helpers;
- standalone emits direct calls to allocator-owned native helpers over the vec
  `anyref`; and
- the adapter owns any required `extern.convert_any`, late-import flush, and
  symbolic helper lookup. Call sites do not branch on flag bits or know the
  range layout.

During migration, an existing companion entry carrying
`FLAG_DELETED_INDEX` also classifies as `ABSENT`. New writer paths must update
the range owner, and S4 removes duplicate deleted-bit tests only after every
reader/writer has converged. `FLAG_COMPANION_VALUE` selects data value
authority only; it never means present or absent by itself.

## Implementation plan

### 1. Make the exact IR operation lane-neutral

**Files and anchors**

- `src/ir/backend/legality.ts:18-59` — `IrBackendTargetCapability` and
  `supportsIrBackendTargetCapability`.
- `src/ir/select.ts:6841-6859` — exact call selection.
- `src/ir/select.ts:7832-7842` — external-call exemption.
- `src/ir/from-ast.ts:325-333` — `IrFromAstResolver` callback.
- `src/ir/from-ast.ts:6125-6173` — exact ambient lowering.
- `src/ir/integration.ts:4134-4137` — `objectDefinePropertyTarget`.
- `src/codegen/object-runtime.ts:615` — `ensureObjectRuntime`.
- `src/codegen/object-runtime-descriptors.ts:1910-2256` — native
  `__obj_define_from_desc` registration.
- `tests/issue-3663-object-define-property-ir.test.ts:25-94` — existing host
  positive and standalone typed-carrier refusal.

Rename `host-object-define-property` to
`object-define-property-runtime`. The legality matrix is exact:

| Backend profile | Capability |
|---|---|
| WasmGC, target `gc`, host imports allowed | yes |
| WasmGC, target `standalone`, host imports forbidden | yes |
| WasmGC strict/no-host `gc` | no |
| `wasi` | no until a separately measured provider is approved |
| linear, bytecode, Porffor | no |

Factor one selector predicate used by both the selection arm and the
external-call exemption. The existing exemption lacks the selector's lexical
shadow and spread refusals. The shared predicate must require:

- direct dot call on the exact ambient identifier `Object` and method
  `defineProperty`;
- neither direct module binding nor lexical/module shadowing;
- exactly three arguments and no spread;
- all three arguments Phase-1 eligible; and
- `object-define-property-runtime` capability true.

`from-ast.ts` remains the final no-loss carrier gate. Lower each argument once,
left-to-right, with expected externref and admit only:

- IR `extern`;
- Wasm `externref`; or
- argument 1 only, an IR string when `stringIsExternref()` is not false.

Otherwise throw the existing `operand-coercion-unsupported` build refusal and
fall back to legacy. In particular, a typed standalone target or descriptor
that still needs `emitDefinePropertyDescRuntime` reification
(`src/codegen/object-ops.ts:281-390`) must not be lossily cast into the IR call.
Shadowed/aliased/computed/optional/spread/wrong-arity/providerless forms also
remain legacy or unsupported exactly as they are today.

Resolve the symbolic provider in `objectDefinePropertyTarget()`:

- host: `irImportFuncRef("env", "__defineProperty_desc")`;
- standalone: call `ensureObjectRuntime(ctx)`, require
  `ctx.funcMap.has("__obj_define_from_desc")`, then return
  `irRuntimeFuncRef("__obj_define_from_desc")`; and
- strict, wasi, or unavailable helper: return `null`.

Do not add a raw `funcIdx` to IR. `__obj_define_from_desc` is registered by
`ensureObjectRuntime` but is intentionally absent from
`OBJECT_RUNTIME_HELPER_NAMES`; the resolver must ensure then verify it through
`funcMap`. The IR owns call identity, argument evaluation order, externref
coercion, and the externref result. The provider owns ToPropertyDescriptor,
validation, vec classification, attributes, holes, and storage.

Direct IR tests must inspect the `IrInstr` call target binding:

```ts
// host
{ kind: "import", module: "env", field: "__defineProperty_desc" }

// standalone
{ kind: "runtime", symbol: "__obj_define_from_desc" }
```

Retain the existing typed standalone negative test. Add negatives for a
shadowed `Object`, spread, wrong arity, computed access, and a typed descriptor
requiring legacy reification. IR-only convergence has a declared Test262 gain
of zero unless same-population A/B measures a flip.

### 2. Add the canonical provider query

**Host: `src/runtime.ts`**

Add `_readVecIndexState(obj, key, exports)`. It returns `undefined` for a
non-vec or noncanonical key; otherwise it returns the canonical index, one of
the four state constants, and the single sidecar descriptor read used to
classify explicit states.

Classification order is normative:

1. read logical length, not backing capacity;
2. if index is outside logical length, return `ABSENT`;
3. if the absence range contains the index or a migration-era deleted entry is
   present, return `ABSENT`;
4. read the descriptor/companion entry once;
5. no entry means `DEFAULT_DATA`;
6. `ACCESSOR` flag means `ACCESSOR`; otherwise `EXPLICIT_DATA`.

**Standalone: `src/codegen/vec-overlay.ts` and a focused new
`src/codegen/vec-index-state.ts`**

Let `vec-overlay.ts` retain storage ownership and expose only the handles the
new classifier needs. Reserve and fill a symbolic native helper:

```text
__vec_index_state(vec:anyref, index:i32)
  -> (kind:i32, entry:(ref null $PropEntry))
```

String-key callers first use their existing canonical index parser; indexed
callers already have i32. Non-index keys never call this helper.

The emitted Wasm shape is:

```wasm
local.get $vec
ref.test $__vec_base
i32.eqz
if
  ;; caller's ordinary/named fallback; never cast a wrong shape
end

local.get $vec
ref.cast $__vec_base
struct.get $__vec_base $length
local.get $index
i32.le_u
if
  i32.const 0                ;; ABSENT
  ref.null $PropEntry
  return
end

local.get $vec
local.get $index
call $__vec_absent_has
if
  i32.const 0                ;; ABSENT
  ref.null $PropEntry
  return
end

local.get $vec
local.get $index
call $__vec_overlay_lookup
local.tee $entry
ref.is_null
if
  i32.const 1                ;; DEFAULT_DATA
  local.get $entry
  return
end

;; FLAG_DELETED_INDEX -> ABSENT
;; FLAG_ACCESSOR      -> ACCESSOR
;; otherwise          -> EXPLICIT_DATA
```

Use `ref.test` before every `ref.cast`. Use fresh `Instr[]` objects at every
finalize splice site; never reuse one mutable instruction graph across helper
bodies. The classifier is semantic; pre-scan flags may prove it unnecessary
for a module but must not alter its answer.

### 3. Converge host readers and integrity

Modify these exact functions in `src/runtime.ts`:

- `_wasmStructHasOwn` at line 3625;
- `_safeGet` at line 4506;
- `_safeSet` at line 4785;
- `_readOwnDescriptor` at line 5345;
- `_ownStructKeys` at line 5573;
- `_vecDefineOwnProperty` at line 6041;
- `_wrapVecForHost` at line 6237;
- `_testIntegrityLevel` at line 787; and
- import handlers `__object_keys` at line 10668,
  `__defineProperty_desc` at line 11044, and
  `__getOwnPropertyNames` at line 11542.

Required dispatch:

- `ABSENT`: own/descriptor/enumeration miss; Get and `in` continue through the
  recorded prototype path; Set may create an own element if allowed.
- `DEFAULT_DATA`: read backing value and synthesize W/E/C=true.
- `EXPLICIT_DATA`: use explicit attributes; read companion value only when
  `FLAG_COMPANION_VALUE` is set, otherwise backing value.
- `ACCESSOR`: invoke getter/setter with the original vec as `this`; absent
  getter returns `undefined`; do not read backing data.

`Object.keys` requires state not `ABSENT` **and effective enumerable=true**.
`Object.getOwnPropertyNames` requires only state not `ABSENT`. Both emit each
canonical index once in ascending numeric order, then existing named keys in
their established order. Proxy `get`, `has`, `ownKeys`, and
`getOwnPropertyDescriptor` traps in `_wrapVecForHost` must call the same query.

Freeze/seal need not create one descriptor entry per default element. Effective
descriptor synthesis clamps receiver-wide integrity state:

- frozen present data: writable=false, configurable=false;
- sealed present data/accessor: configurable=false;
- holes remain `ABSENT`.

The write, delete, and redefine validators consume that effective descriptor
before mutating anything.

### 4. Converge standalone readers and integrity

Modify:

- `src/codegen/vec-overlay.ts:637` — `fillVecOverlayHelpers` and the
  `__vec_dp_value`, `__vec_dp_accessor`, gOPD, read, set, and delete arms;
- `src/codegen/vec-overlay-presence.ts:99` — replace standalone deleted-only
  presence logic with the classifier;
- `src/codegen/vec-bag-seed.ts:109` — seed from `DEFAULT_DATA` only, never from
  raw `index < length`;
- `src/codegen/vec-overlay-keys.ts:155` and `:453` — companion-key and gOPN
  enumeration;
- `src/codegen/object-runtime.ts:8108` — vec arms for
  `__object_keys_forin` and `__object_keys`;
- `src/codegen/typed-lane-overlay-route.ts:63` — include every condition that
  can make raw dense semantics wrong, including array holes; and
- `src/codegen/object-runtime-integrity.ts:100` — effective freeze/seal state.

Each reader calls `__vec_index_state` once and dispatches on its two results:

```wasm
local.get $recv
local.get $index
call $__vec_index_state
local.set $entry
local.set $kind

local.get $kind
i32.const 0                  ;; ABSENT
i32.eq
if
  ;; own miss; Get/HasProperty may continue to prototype
else
  local.get $kind
  i32.const 1                ;; DEFAULT_DATA
  i32.eq
  if
    ;; typed array.get, effective W/E/C=1/1/1
  else
    ;; one entry owns attrs/accessors;
    ;; FLAG_COMPANION_VALUE selects explicit data value authority
  end
end
```

The typed fast lane and dynamic lane must agree for the same receiver. Do not
fix only `__extern_get_idx`: propertyHelper functions can become typed after
monomorphization, while Object reflection uses dynamic helpers.

### 5. Make every relevant writer preserve the invariant

The update must be atomic from the JavaScript observer's perspective: validate
first; then update absence, explicit metadata/value, backing storage, and
logical length in an order that cannot expose a half-transition. A throw leaves
all state unchanged.

| Operation | Required transition |
|---|---|
| dense literal element | clear absence at that index; no explicit entry, so state is `DEFAULT_DATA` |
| literal elision | mark that index/range absent |
| `new Array(n)` | mark `[0,n)` absent |
| length growth | mark `[oldLength,newLength)` absent before publishing the new logical length |
| length shrink | make `index >= newLength` unobservable, trim ranges, and discard/ignore explicit entries above the new length so later growth cannot resurrect them |
| ordinary assignment / push | after rejection checks pass, clear absence for exactly the written index and keep/create default data semantics |
| define at `index >= oldLength` | validate as `ABSENT`; mark `[oldLength,index)` absent, clear only `index`, store the new descriptor/value, then publish `index+1` length |
| define on a hole | validate as `ABSENT`; a value-less data descriptor creates present `undefined` with W/E/C=false |
| redefine default data | validate against W/E/C=true and preserve omitted fields |
| data/accessor conversion | permit only when effective configurable=true; remove stale value/accessor authority after success |
| delete | reject effective configurable=false; otherwise remove explicit metadata/value and mark the index absent |
| freeze/seal | update receiver integrity and explicit entries; synthesize clamped attributes for default entries |

For a fresh value-less descriptor, use a companion value when the typed backing
cannot store `undefined`; never substitute the backing's numeric/null default.
For an OOB define, do not mark the defined index absent. Large gaps use one
range insertion, not an element loop.

Specific codegen changes:

- In `compileObjectDefineProperty` (`src/codegen/object-ops.ts:846`), stop the
  host-only pre-growth at lines 1010-1021 from running before a vec define that
  will use the runtime MOP. The host provider must own validated growth just as
  standalone already does. Keep a legacy-only branch behind the temporary gate
  for refusal shapes until S4.
- Keep `emitDefinePropertyDescRuntime` (`src/codegen/object-ops.ts:281`) as the
  carrier-reification boundary, not a second descriptor validator.
- Update `maybeEmitVecLengthDefine`
  (`src/codegen/array-length-define.ts:111`) and
  `emitArraySetLengthValidation` at line 496 to call range mark/truncate helpers
  around successful length changes.
- In `compileArrayLiteral` (`src/codegen/literals.ts:3772`) record elision
  ranges independently of `$Hole`/sNaN storage.
- In `compileArrayConstructorCall` (`src/codegen/literals.ts:4872`) record the
  `new Array(n)` absent range.
- In `compileElementAssignment`
  (`src/codegen/expressions/assignment.ts:4516`), update both the typed vec
  branch at lines 4822-5145 and the overlay-routed Set path: preserve old
  logical length, mark `[oldLength,index)` on an OOB write, clear exactly the
  written index after the store succeeds, then publish the new length. The
  existing externref gap fill at lines 5079-5121 is a value normalization, not
  own-property presence, and remains independent.
- In `compilePropertyAssignment`
  (`src/codegen/expressions/assignment.ts:3488`), wrap the typed
  `arr.length = N` branch at lines 3862-3893 with range mark/truncate after
  validation and before the length field becomes observable.
- Audit `compileArrayPush`, `compileArrayPop`, `compileArrayShift`,
  `compileArrayUnshift`, and `compileArraySplice` at
  `src/codegen/array-methods.ts:3189`, `:3322`, `:3428`, `:3524`, and `:4771`.
  Any operation that renumbers or creates indices must transform ranges and
  explicit entries consistently before the old reader paths can be retired.

`compileObjectDefineProperties` remains a legacy/static batching surface in
M1. Each individual descriptor it applies must reach the same single-property
provider, but adding a plural IR instruction is out of scope.

### 6. Temporary gate, staging, and removal

Use one browser-safe temporary compiler kill switch,
`JS2WASM_VEC_INDEX_MOP=0`, with default-on behavior at the candidate head.
Read it through a guarded helper (`typeof process !== "undefined"` and optional
`process.env`); do not add an unguarded browser-module `process.env` access.
The switch chooses complete old versus new vec-index MOP ownership. It must not
mix a new writer with an old reader.

Land as one reviewed series, in this order:

1. **S0 IR seam:** capability/provider/refusal convergence and direct IR shape
   tests. Expected semantic Test262 claim: zero.
2. **S1 state substrate:** host weak range state; standalone overlay-pair range
   state; both canonical classifiers; temporary switch still off in focused
   unit characterization.
3. **S2 M1 readers/writers:** route the operations required by the 13 rows and
   mechanistic tests; make the candidate head default-on.
4. **S3 audit:** complete the named mutator and shared-reader audit, then run
   targeted base/head/head-off A/B and the full two-lane gates.
5. **S4 retire:** after acceptance, remove duplicate deleted/presence tests,
   old host pre-growth for runtime-routed defines, and the temporary switch.
   Re-run targeted tests plus full gates on the switch-free final SHA.

Do not leave both semantic implementations permanently. Do not delete
`definedPropertyFlags` wholesale: remove only vec-index consumers proven to
have converged; retain unrelated compile-time shape facts.

## Tests

### IR shape and refusal tests

Extend `tests/issue-3663-object-define-property-ir.test.ts` or add
`tests/issue-2668-object-defineproperty-ir.test.ts`:

- host exact externref-backed ambient call selects IR and has the import
  binding shown above;
- standalone exact externref-backed ambient call selects IR and has the runtime
  binding shown above;
- both compile to valid Wasm and return the original target;
- evaluation order is target, key, descriptor, each once;
- shadowed `Object`, direct module binding, computed access, wrong arity, and
  spread do not select this operation; and
- the existing typed standalone target/descriptor remains legacy and succeeds.

### Mechanistic cross-lane tests

Add `tests/issue-2668-vec-index-state.test.ts`. Run every case in host and
standalone:

1. dense `[7]` gOPD reports value 7 and W/E/C=true before a sidecar exists;
2. empty/same-value redefine of that element preserves default attributes;
3. `[undefined]` is present while `[, ]` is absent, including f64-inferred
   mixed arrays where a value sentinel cannot distinguish them;
4. a hole with an inherited prototype index is visible to Get/`in` but absent
   from HasOwn/gOPD/own keys;
5. defining `{configurable:false}` on that hole creates a present own
   `undefined` which shadows the prototype and has false omitted attributes;
6. defining index 10000 on a short array leaves the intervening range absent
   and enumerates only present indices;
7. delete makes Get, `in`, HasOwn, gOPD, keys, and gOPN agree on absence;
8. configurable default data converts to an accessor, then invokes it with the
   original vec receiver as `this`;
9. freeze clamps effective W/C on dense defaults without materializing an entry
   per index; and
10. `"01"`, `"-0"`, `"1.0"`, `"4294967295"`, symbols, and named expandos stay
    on the named-property path.

### Exact candidate and positive-control files

Put the 13 paths from the fresh candidate table in the M1 list. Append these
six currently passing controls in both lanes:

```text
test/built-ins/Object/defineProperty/15.2.3.6-4-182.js
test/built-ins/Object/defineProperty/15.2.3.6-4-275.js
test/built-ins/Object/defineProperty/15.2.3.6-4-276.js
test/built-ins/Object/defineProperties/15.2.3.7-6-a-184.js
test/built-ins/Object/keys/15.2.3.14-5-3.js
test/built-ins/Object/getOwnPropertyNames/15.2.3.4-2-2.js
```

## Same-population A/B protocol

Use separate clean worktrees and the same test262 gitlink, dependencies,
harness, timeout, file list, and machine state for every arm. Base is exact
server-main SHA `cb4d4d7ca2f151ba69f26cff517417e003428df7`; record the candidate and
switch-removal SHAs in the issue or PR evidence.

Before any heavy run, execute `sysctl -n hw.pagesize`, `vm_stat`, and `df -k .`.
Proceed only when the resource gate stated above passes.

For the targeted 19-file list:

```text
npx tsx scripts/harness-flip-probe.ts --self-test

npx tsx scripts/harness-flip-probe.ts --files .tmp/issue-2668-m1-files.txt --out .tmp/2668-base-host.jsonl --target host
npx tsx scripts/harness-flip-probe.ts --files .tmp/issue-2668-m1-files.txt --out .tmp/2668-base-standalone.jsonl --target standalone

JS2WASM_VEC_INDEX_MOP=0 npx tsx scripts/harness-flip-probe.ts --files .tmp/issue-2668-m1-files.txt --out .tmp/2668-head-off-host.jsonl --target host
JS2WASM_VEC_INDEX_MOP=0 npx tsx scripts/harness-flip-probe.ts --files .tmp/issue-2668-m1-files.txt --out .tmp/2668-head-off-standalone.jsonl --target standalone

JS2WASM_VEC_INDEX_MOP=1 npx tsx scripts/harness-flip-probe.ts --files .tmp/issue-2668-m1-files.txt --out .tmp/2668-head-on-host.jsonl --target host
JS2WASM_VEC_INDEX_MOP=1 npx tsx scripts/harness-flip-probe.ts --files .tmp/issue-2668-m1-files.txt --out .tmp/2668-head-on-standalone.jsonl --target standalone

npx tsx scripts/harness-flip-probe.ts --diff .tmp/2668-base-host.jsonl .tmp/2668-head-on-host.jsonl
npx tsx scripts/harness-flip-probe.ts --diff .tmp/2668-base-standalone.jsonl .tmp/2668-head-on-standalone.jsonl
npx tsx scripts/harness-flip-probe.ts --diff .tmp/2668-base-host.jsonl .tmp/2668-head-off-host.jsonl
npx tsx scripts/harness-flip-probe.ts --diff .tmp/2668-base-standalone.jsonl .tmp/2668-head-off-standalone.jsonl
```

Base versus head-off must have zero status changes. Head-off versus head-on
isolates the switch on the same source SHA. Base versus head-on is the actual
candidate comparison. Never compare a local arm with a committed baseline
JSONL.

The driver must observe its mandatory pass and fail controls. Publish the full
partition in each lane: fail-like to pass, pass to fail-like, other changes,
unchanged, entered, and left; assert the buckets sum to the union. Keep fail,
compile error, compile timeout, skip, and harness error distinct. A missing
QuickJS/eval provider invalidates the arm rather than producing a compiler
result.

After the targeted matrix, run the authoritative full **same 9,029-file ES5
population** in host and standalone, including `eval`, `Function`, and `with`
tests. Required landing gates in each lane:

- zero pass to non-pass;
- zero new compile errors;
- zero new compile timeouts;
- no loss among the six positive controls;
- every one of the 13 candidate outcomes reported; and
- all new focused and IR tests green.

After removing the switch, rerun the targeted list and the full gates on the
final SHA. Issue-level completion remains **9,029/9,029 pass in host and
9,029/9,029 pass in standalone**; M1 landing does not close #2668 by itself.

## Explicit exclusions and refusal boundary

M1 does not absorb:

- sparse uint32 indices that exceed the signed-i32/dense-backing model;
- mapped `Arguments` exotic semantics;
- ordinary object descriptor convergence tracked by #4008;
- runtime `eval` accessor carrier invocation tracked by #4197;
- named expando/prototype/global-object MOP gaps;
- typed-array integer-indexed exotic semantics;
- plural IR construction for `Object.defineProperties`; or
- arbitrary typed descriptor reification in IR.

These shapes retain their existing provider or decline to legacy. Do not make
the M1 selector broader to capture them.

## Risks and mitigations

- **Partial convergence:** fixing define while leaving Get/Has/keys/delete or
  freeze on raw length creates worse disagreement. The classifier plus reader
  matrix lands before old tests are removed.
- **Pre-growth mutation before validation:** a throwing define must not change
  length, ranges, value, or metadata. Provider-owned validation precedes every
  transition.
- **Prototype distinction:** `ABSENT` continues prototype Get/HasProperty;
  HasOwn/gOPD/own keys stop. A present value-less property shadows the
  prototype.
- **Representation traps:** every standalone cast is dominated by `ref.test`;
  wrong carriers take a fallback or catchable JS `TypeError`, never
  `illegal_cast`.
- **Presence storage cost:** use weak host ownership and compact sorted ranges;
  no O(length), O(gap), or uint32-max descriptor materialization.
- **Stale resurrection:** shrink removes or hides explicit metadata above the
  new length, and later growth marks the complete newly exposed range absent.
- **Enumeration:** gOPN tests presence; keys/for-in test presence plus effective
  enumerable. Deduplicate companion and backing indices and preserve numeric
  order.
- **IR overclaim:** standalone typed carriers remain legacy until reification
  is exact. Selector and external-call exemption share one predicate.
- **Browser compatibility:** the temporary environment switch must be guarded;
  no unguarded `process.env` is added to browser-loaded compiler modules.
- **Hot-file conflicts:** `src/runtime.ts`, `src/codegen/object-ops.ts`,
  `object-runtime.ts`, and `vec-overlay.ts` overlap #4008, #4197, and #4222
  follow-ups. Rebase before implementation and preserve one owner for each
  state transition rather than copying bit tests.

## Terra Max implementation handoff

Implement **2668-M1** in the S0-S4 order above. First prove the symbolic host
import and standalone runtime provider with unchanged typed-carrier refusals;
then add compact absence ranges and one four-state classifier per provider;
finally converge only the readers/writers required by the 13-row matrix before
the mutator audit, same-population kill-switch A/B, both-lane zero-loss gate,
and switch removal. Do not claim a Test262 gain until the measured partitions
exist.
