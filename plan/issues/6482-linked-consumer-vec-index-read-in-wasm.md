---
id: 6482
title: "Linked test262 harness: a provider reading a consumer array by index is lowered in-wasm and misses the consumer's vec type"
status: in-progress
sprint: current
created: 2026-09-15
updated: 2026-09-18
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: arrays
goal: test262-conformance
depends_on: [6477]
related: [3451, 5225, 6477, 6491, 6495]
# 2026-09-17 (round 2): +75 LOC in src/runtime.ts for the vec arms of
# `__for_in_keys` (`_vecEnumerableIndexKeys`) and `_wasmStructHasOwn`. A vec
# receiver previously enumerated as `[]` and reported no own index properties
# through the host imports, which is the only path once the receiver crosses a
# linked-module edge. Measured: linked descriptor bucket 49→68/114 (+19, 0
# regressions); honest 818-row vec/for-in/own-property slice 692→699 (+7, 0
# regressions).
# 2026-09-17 (round 2, mechanism 2): +2 LOC in
# src/codegen/property-access-dispatch.ts — the well-known-symbol arm now also
# brands when this module is one side of a linked project (`linkBrandRoleOf`),
# so `Symbol.iterator` stops crossing the link as the NUMBER 1. One import line
# plus one local. Measured: linked descriptor bucket 68→98/114 (+30, 0
# regressions); honest unchanged across 2,102 rows.
# 2026-09-18 (round 4): the `__vec_has_own_index` export. `idx < __vec_len` is
# not own-ness for a sparse array, and no pre-existing export can supply the
# difference — `__vec_get` deliberately maps BOTH the hole marker and an
# explicit `undefined` element to `undefined` (#4491 T11), so the distinction is
# erased at the boundary by design. Guessing it cost 7 hole rows in PR #5964 and
# 10 dense-literal rows in PR #5967. The new export answers from the RAW element
# before that boxing; `vec-define-writeback.ts` gains the matching
# absence-marker fill for a `length` change (§10.4.2.1).
# 2026-09-18 (round 3 iii): +51 LOC in src/codegen/object-ops.ts for the
# representability veto — `defineProperty(obj, "foo", {value: "abc"})` on a
# struct field typed `f64` silently lost the value in the struct fast path, and
# the runtime route (which stores into the sidecar every reader consults) is the
# correct destination for a value the field cannot hold. Measured on the
# 2,570-row vec-define matrix: +1 (`15.2.3.6-4-60`), 0 regressed.
# 2026-09-18 (round 4b): the WRITE side of the same rule. `__vec_has_own_index`
# can only be as honest as the backing store, and §10.4.2.1 ArraySetLength makes
# a shrink DELETE the dropped elements — so every `length` store must mark the
# region it orphans. `vec-length-hole-fill.ts` is the one ladder the two
# `$__vec_base`-typed sites share (`expressions/assignment.ts` +9,
# `array-length-define.ts` +11); `array-holes.ts` (+18) arms the READ-side
# marker for a plain `x.length = n`, because a store that can now produce holes
# needs hole-aware reads emitted by the same pre-pass (reads and stores must be
# armed together — function compilation order is not source order). `runtime.ts`
# gains the `Object.keys` vec arm and the hole-aware host mirror, without which
# `Object.keys` and `for…in` disagree on a sparse array (`15.2.3.14-6-2`).
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/vec-access-exports.ts
  - src/codegen/vec-define-writeback.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/array-length-define.ts
  - src/codegen/array-holes.ts
  - src/codegen/object-ops.ts
# 2026-09-18 (round 7): +25 LOC in src/runtime.ts (the round-5 element-default
# seeding and its two tombstone consults) and +58 in src/codegen/object-ops.ts /
# vec-length-hole-fill.ts for the pre-grow absence-marker fill — §10.4.2.1's
# "a grow creates HOLES, not zeros", the same rule round 4b applied at the
# `defineProperty(arr, "length", …)` site. Measured: linked 114-row bucket
# 100 -> 103 (+3, 0 lost); linked 368-row `15.2.3.6-4-*` control 289 -> 290
# (+1, 0 lost); honest `harness/**` unchanged.
# 2026-09-18 (round 7, INHERITED): `emitObjectProtoToStringClassifier` is a
# STRANDED GRANT — it grew on `claude/compiler-performance-bn5g3l` before this
# branch started, and the CI-base (`LOC_GATE_BASE=origin/main`) run of
# check-func-budget attributes it here because this PR is the one being diffed
# against `origin/main`. Restated in a file this change-set touches, per the
# stranded-grant rule in CLAUDE.md; nothing in round 7 goes near that file.
func-budget-allow:
  - src/codegen/object-proto-tostring.ts::emitObjectProtoToStringClassifier
  - src/runtime.ts
  - src/runtime.ts::resolveImport
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/codegen/vec-access-exports.ts::_emitVecAccessExportsInner
  - src/codegen/vec-define-writeback.ts::emitVecDefineWritebackExports
---

# #6482 — cross-module vec index read never reaches the host

## Problem (measured 2026-09-15 under #6477)

`verifyEqualTo(arr, "0", v)` inside the harness provider is `arr[name]`. With
`_safeGet` and the `__extern_get` import traced, **zero** runtime imports fire
for that read once the body runs after registration (#6477 P1). The read is
lowered to in-wasm vec access that `ref.test`s the receiver against the
PROVIDER's own vec types; a consumer-minted vec misses and the read yields the
null/0 shape default — `Expected obj[0] to equal NaN, actually null`.

No host-side `_decoderExportsFor` redirect can see it. The linked ABI must
make a consumer-minted vec castable in the provider (canonical rec-group
membership for the vec carrier, or a boundary terminal that routes the miss to
the cross-module decoder instead of the default).

Rows: `built-ins/Object/defineProperty/15.2.3.6-4-{299-1,300,540-8}.js`, the
`arr540` and `plainval` minimal bodies in #6477; after #6474 (script goal moves
top-level values from module globals to global-object properties, which routes
the provider's read down the same in-wasm vec path) also
`built-ins/Object/defineProperty/15.2.3.6-4-258.js` and `15.2.3.6-3-185.js`
(reproduced in isolation by the #6474 lane, 2026-09-15).

## Acceptance criteria

- [ ] A minimal body (`var arr = [1]; verifyEqualTo(arr, "0", 1)`) passes in the
      linked lane; the lowering site of the in-wasm index read is named here.
- [ ] The three defineProperty rows flip to agreement; honest lane byte-identical.

## Re-measured 2026-09-16 (Fable lane) — the class splits in three

The in-process lanes (smoke script, `issue-3451/6475/6476/6477` suites) ran the
body with the consumer's runtime UNWIRED: `wireCompiledInstance` read
`imports.__setInstance`, but `buildImports` publishes the consumer hook as
`setInstance` (only provider import objects carry the `__setInstance` alias).
With `getExports()` undefined, `_vecDefineOwnProperty` bailed to the sidecar
and the provider read the stale element. The sharded worker calls
`importObj.setInstance` itself, so its numbers were right. Fixed in
`src/linked-provider-runtime.ts` (`__setInstance ?? setInstance`); after the
fix `arr540`, `arr258` and `plainidx` pass in-process, matching the worker.

What remains, each a different mechanism:

| row(s) | message | mechanism |
| --- | --- | --- |
| `15.2.3.6-4-540-8.js`, `plainval` | `to equal NaN, actually …` | #6487 — provider param body-inferred to f64 — **fixed 2026-09-16, both pass linked** |
| `15.2.3.6-4-299-1.js`, `-300.js` | `Expected obj[0] to equal 10, actually 0` | `arguments` object with a defineProperty ACCESSOR read from the provider — `_safeGet`'s arguments fast path or the vec index path answers the raw slot |
| `15.2.3.6-4-258.js` | `0 descriptor should be enumerable/writable/configurable` | element VALUE now right; the per-index flags (`_wasmPropDescs`) the consumer wrote are not what the provider's `_readOwnDescriptor` vec branch reads |
| `15.2.3.6-3-185.js` | `Invalid descriptor field: label` | provider's `__getOwnPropertyNames` on the consumer's `{ value: undefined, writable: false }` literal returns a phantom name — decoder still resolving to the wrong module's `__struct_field_names` ladder for this shape |

The original "in-wasm vec read never reaches the host" attribution was an
artifact of the unwired in-process lane; keep this issue for the last three
rows (accessor / flags / phantom name), all provider-side reads of
consumer-minted values.

## Implementation notes (2026-09-17, Opus lane)

### Measurement setup

Everything below is from runs executed in this worktree
(`/home/user/js2/.claude/worktrees/agent-aa15a6ecbb49aa77d`, branch
`issue-6482-linked-descriptor-family`) with the REAL runner —
`tests/test262-chunk-dynamic.test.ts`, one chunk
(`TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1`), `TEST262_INCLUDE_PROPOSALS=1`,
path-filtered to the 114 rows of `.tmp/parity-buckets/bucket-descriptor.txt`
(filter file `.tmp/rows114.txt`, runner script `.tmp/run-lane.sh`). Linked lane
adds `TEST262_ORACLE_MODE=linked`; honest lane leaves it unset. Before/after
were produced by reverting `src/codegen/{shape-brand,index}.ts` to `HEAD` and
rebuilding `scripts/compiler-bundle.mjs` between runs (file-copy A/B — no
stash). Result artifacts:
`benchmarks/results/test262-{linkedbefore,linkedafter,honestbefore,honestafter}-results-*.jsonl`.

### Before / after on the 114 descriptor-bucket rows

| lane | before | after | rows whose verdict changed |
| --- | --- | --- | --- |
| linked (`TEST262_ORACLE_MODE=linked`) | 0 / 114 pass | **44 / 114 pass** | +44, **0 regressions** |
| honest (audit lane) | 105 / 114 pass | 105 / 114 pass | **0** |

The honest lane's 105 (not 114) is this container's own before-state, not CI's;
what matters for the order-preservation constraint is that the same 105 pass
before and after and **not a single row flipped either way**. That is expected
by construction: the change is gated on link participation, so a single-module
compile takes the identical code path it took before.

### Mechanism 1 — FIXED: cross-MODULE shape-type collision (`Invalid descriptor field: label`, 35 rows)

Root cause, measured by probing every module's `__struct_field_names` from the
#5225 registry: WasmGC canonicalizes two struct types with the same field
layout to ONE runtime type, and that does **not** stop at the module edge. The
harness provider declares `__anon_{label,restore}` (propertyHelper's `options`
shape); a `prop-desc.js` body declares `__anon_{enumerable,configurable}`. Both
are `(struct (field externref) (field externref))` — the same type. The
provider's `ref.test` ladder therefore HITS a consumer-minted descriptor and
answers `"label,restore"`; `verifyProperty`'s own-name scan rejects `label`.
The instrumented probe printed exactly this:
`[xmod] 0*:label,restore | 1:enumerable,configurable` (`0*` = the reading
module).

**No host-side fix is possible.** `decoderFor` prefers `local` precisely
because `local` answered a non-empty name list, and a canonical-collision false
positive is indistinguishable from a real hit by any probe the host can make
(`__sget_*`, `__shas_*` are equally structural). The collision is symmetric, so
"prefer the peer" would break the provider reading its own `options` object.

The fix is type-level and reuses #2853's brand chain, with two changes that
apply ONLY to a module that is one side of a linked project
(`src/codegen/shape-brand.ts`):

1. brand EVERY brandable `__anon_*`/`__fnctor_*` shape, not just those that
   collide with a sibling **in this module** — a cross-module collision is
   invisible to a per-module `keyCount`;
2. anchor each side's chain at a DIFFERENT pre-registered runtime type:
   provider → `__vec_base` (unchanged), consumer → `__arr_f64`.

Distinctness follows by #2853's own induction: if a provider-branded `P` were
canonically equal to a consumer-branded `C`, their trailing brand fields force
`target(P) ≅ target(C)`; peeling down ends at `__vec_base ≅ __arr_f64`, an open
`sub` STRUCT against an ARRAY type. Both anchors are eagerly registered in
every context (`RUNTIME_RECGROUP_TYPE_NAMES`), so neither side needs a new
type-table entry — no index shift (the #2043 hazard class), and the canonical
runtime rec group is untouched.

Role detection is `linkBrandRoleOf` (same file): `linkedPackageBindings`
non-empty ⇒ consumer, `exportsConsumedByWasm` ⇒ provider, otherwise
`undefined` ⇒ exact #2853 behaviour. The +44 is larger than the 35
`Invalid descriptor field` rows because the same mis-decode also produced some
own-property and flag failures.

Test: `tests/issue-6482-linked-shape-brand.test.ts`.

### Mechanism 2 — ROOT-CAUSED, DELIBERATELY NOT SHIPPED: symbol brand lost at the linked call boundary (36 residual `N should be an own property` rows)

`verifyProperty(Array.prototype, Symbol.iterator, …)` reports
`1 should be an own property` — the label is `String(name)`, so the provider
received the NUMBER 1, the well-known id. Confirmed in the emitted consumer
WAT: `Symbol.iterator` lowers to `f64.const 1; call __box_number`. The site is
`src/codegen/property-access-dispatch.ts` (~L3777), which returns the
`{kind:"i32", symbol:true}` brand only when `usesNativeSymbolProvider(ctx)`
(standalone/WASI); the js-host lane is deliberately unbranded for the #4626
index-shift reason. In ONE module that is harmless — the id never leaves, and
every consumer of it knows statically that it is a symbol key. Across a
wasm→wasm link the callee's parameter is a plain `externref`, so the brand-less
i32 boxes as a number.

A two-line patch (brand when `linkedPackageBindings.size > 0 ||
exportsConsumedByWasm`) makes `__box_symbol` fire and **fixes the own-property
reads**: the `provider hasOwnProperty on builtin symbol key` and
`vp sym own only` probes flip to pass.

**It was reverted, because it converts a fast failure into a HANG.** With a
real symbol key, `isConfigurable(obj, name)` — `delete obj[name]` — reaches
`__delete_property` with `obj === Array.prototype`, *the host realm's own*
`Array.prototype` (instrumented:
`[del] symbol Symbol(Symbol.iterator) wasmStruct:false hostArrayProto:true`).
The delete succeeds, the test process loses array iteration, and the vitest
worker never returns. Today the honest lane "passes" these rows partly by
accident: the key is the number `1`, so the delete is a no-op and
`!hasOwnProperty(obj, 1)` is trivially true.

So the real blocker is realm isolation, not the brand: a compiled program must
not be able to mutate the host's intrinsics through `__delete_property` /
`__defineProperty`. That is a separate change with its own honest-lane blast
radius (rows that currently pass BY deleting a host builtin), and it must land
before the symbol brand does. Next concrete step: file the realm-isolation
issue, land it, then re-apply the two-line brand and re-measure these 36 rows.

### Residual after this change (70 of 114)

| count | message shape | mechanism |
| --- | --- | --- |
| 36 | `N should be an own property` | mechanism 2 above (symbol key), blocked on realm isolation |
| 19 | `N descriptor should be enumerable` | mechanism 3 below — NOT the descriptor sidecar |
| 6 | `N descriptor should be enumerable; … writable; … configurable` | mechanism 3 below |
| 6 | `Cannot convert undefined or null to object` (inside `verifyProperty`) | not investigated |
| 2 | `typeof descriptor.get is function` | accessor descriptor crossing, not investigated |
| 1 | `foo descriptor value should be abc` | not investigated |

Not reached this round: the `arguments`-accessor row (#6482 row 2) — the
minimal mapped-`arguments` probe `verifyProperty(args, "0", {…})` PASSES in the
linked lane in-process, so whatever remains there is narrower than the issue
text suggests.

`build`: `scripts/compiler-bundle.mjs` / `runtime-bundle.mjs` must be rebuilt
before any runner lane picks up a codegen change — the worker imports the
bundle, not `src/`.

### Mechanism 3 — LOCALIZED, not fixed: provider-side own-property PREDICATES on a consumer `arguments` object (25 rows)

The 19 + 6 flag rows are **not** a `_wasmPropDescs` problem, which is what the
2026-09-16 note assumed. Measured in-process against the real provider:

| provider-side call on a consumer `arguments` object | verdict |
| --- | --- |
| `__getOwnPropertyDescriptor(arguments, "0").enumerable` | **true** (correct) |
| `Object.getOwnPropertyDescriptor(...)` consumer-side | true (correct) |
| `__hasOwnProperty(arguments, "0")` | **false** (wrong) |
| `__propertyIsEnumerable(arguments, "0")` | **false** (wrong) |

So the DESCRIPTOR path already crosses correctly; the two own-property
PREDICATES do not, and `verifyProperty` reaches them through
`isEnumerable(obj, name)`. The `Object.defineProperty(arguments, "0",
{configurable:false})` in the row is incidental — the predicates answer false
without it too. A plain object with an index property defined the same way
answers correctly, so this is specific to the `arguments` vec.

Minimal repro (linked lane, `includes: [propertyHelper.js]`):

```js
function f(a) { assert.sameValue(__propertyIsEnumerable(arguments, "0"), true, "pie"); }
f(1);
```

Next concrete step: follow `__hasOwnProperty`'s arguments arm in
`src/runtime.ts` — `_argumentsObjects.has(obj) && _argumentsHasOwn(obj, key)`,
then the `_wasmStructHasOwn` fallback — and establish which of the two reads
the READER's exports instead of the owner's (`_argumentsObjects` itself is a
module-level WeakSet SHARED by both sides, since `linked-provider-runtime.ts`
imports `./runtime.js`, so registration is not the gap). Route it through
`_decoderExportsFor` the way `_readOwnDescriptor` already is (#6477 P2) — that
is almost certainly why the descriptor path works and these two do not.

## Round 2 (2026-09-17, Opus lane)

### Setup

Worktree `/home/user/js2/.claude/worktrees/agent-a6d0fed89c03acce8`, branch
`issue-6482-r2-linked-descriptor-residual`, based on `origin/main` with three
not-yet-merged commits cherry-picked first so every number below is measured on
top of them: #6491's under-application fix and round 1's two commits
(shape-brand + notes). All three applied clean.

Real runner, both lanes, path-filtered to the same 114 rows round 1 used
(`.tmp/rows114.txt`, driver `.tmp/run-lane.sh`):
`tests/test262-chunk-dynamic.test.ts`, one chunk, `TEST262_INCLUDE_PROPOSALS=1`.
Linked lane adds `TEST262_ORACLE_MODE=linked`; honest leaves it unset. Bundles
(`scripts/compiler-bundle.mjs`, `scripts/runtime-bundle.mjs`) rebuilt between
edits; a per-tag `JS2WASM_TEST262_HARNESS_CACHE` (#6488). A/B by file copy
(`.tmp/runtime.base.ts`), never `git stash`.

### Before / after on the 114 rows

| lane | round-1 end | r2 base (after cherry-picks) | after mechanism 3 | flips |
| --- | --- | --- | --- | --- |
| linked | 44 / 114 | **49 / 114** | **68 / 114** | **+19, 0 regressions** |
| honest | 105 / 114 | 105 / 114 | 105 / 114 | **0 rows changed** |

The r2 base is 5 above round 1's end; that delta is the #6491 cherry-pick, not
this work.

### Mechanism 3 — FIXED, and round 1's attribution was wrong

Round 1 concluded the two own-property PREDICATES
(`__hasOwnProperty` / `__propertyIsEnumerable`) answer false on a consumer
`arguments` object and named "route them through `_decoderExportsFor`" as the
next step. **Instrumented, neither predicate is ever reached.** propertyHelper's
`isEnumerable` is

```js
return stringCheck && __hasOwnProperty(obj, name) && __propertyIsEnumerable(obj, name);
```

and `stringCheck` comes from a `for (var x in obj)` above it. On the linked
lane that `for…in` reaches the host `__for_in_keys` import — and it returned
`[]`:

```
[forin] args: true keys: [] redirect: false
```

(`redirect: false` = `_decoderExportsFor` returns the reader's own exports, so
this was never a cross-module decoder problem.) `stringCheck` false ⇒ the `&&`
short-circuits ⇒ `verifyProperty` reports `N descriptor should be enumerable`.
The `__hasOwnProperty` import and `_wasmStructHasOwn` both logged **zero**
calls on these rows.

Root cause: `__for_in_keys`' per-level walk collects struct FIELD names
(`_getStructFieldNames`) and sidecar keys. A **vec** — a compiled array or a
registered `arguments` object — has neither: its elements live in the array
carrier and their attributes in the `_wasmPropDescs` table. So a vec enumerated
as nothing. Single-module this never showed, because a same-module `for…in` is
lowered in-wasm and never reaches the import; across a #5225 linked boundary the
receiver is an opaque externref in the reader, so the import is the only path.

Fix (`src/runtime.ts`), two parts:

1. `_vecEnumerableIndexKeys(obj, exports)` — the own enumerable index keys of a
   vec, ascending, filtered by the tombstone set and the descriptor table's
   enumerable bit; `length` deliberately excluded (non-enumerable on both an
   Array §23.1.4.1 and an arguments object §10.4.4). Wired into
   `__for_in_keys`' per-level walk before the field-name collection, so the
   existing `_orderOwnKeysSpec` ordering and shadowing (`seen`) logic apply
   unchanged.
2. A vec arm in `_wasmStructHasOwn`: an in-bounds element index — and
   `length` — is an own property even with no sidecar entry. Needed because
   once the `for…in` gate starts passing, `__hasOwnProperty(arguments, "0")` is
   reached for the first time and the struct-shape probe below it answers false
   for a vec.

The 19 rows fixed are the 11 `language/arguments-object/mapped/*` rows plus
`Object/defineProperty/15.2.3.6-4-{258, 289, 289-1, 293-1, 293-3, 293-4, 295,
295-1, 307}`.

Guards: `tests/issue-6482-r2-linked-vec-for-in.test.ts` (four cases, including
the `length`-must-not-enumerate one). Equivalence gate green
(22 failing / 1720 passing, all 22 in baseline); `npm run -s typecheck` clean.

### Mechanism 2 — FIXED (see the replacement section below; this heading is kept for the diagnosis)

Unchanged diagnosis from round 1 (`Symbol.iterator` crosses the link as the
number `1` because `src/codegen/property-access-dispatch.ts` ~L3777 brands
`{i32, symbol:true}` only under `usesNativeSymbolProvider`), and the two-line
link-role-gated brand still turns a fast fail into a worker HANG.

Round 2 located the realm hole precisely, which round 1 had only characterised:
the runner **does** build a per-row `vm.createContext` realm, but
`src/runtime.ts`'s `builtin()` resolves through it only when the sandbox was
registered via `markCoherentBuiltinRealm` — and `tests/test262-runner.ts` calls
that only when `HOST_INTRINSIC_DEFINE_RE`, a deliberately narrow **source
regex**, matches a literal `Object.defineProperty(Array.prototype, …)` in the
test body. These rows' intrinsic mutation happens inside the HARNESS
(`verifyProperty` → `isConfigurable` → `delete obj[name]`), which the regex
cannot see, so `__get_builtin("Array")` falls back to `(globalThis as any).Array`
— the worker's own realm. Filed as **#6495** with the three candidate fixes and
the measurement each needs. #6482 mechanism 2 is blocked on it.

### Exact residual after round 2

Of the 46 linked non-passes, **8 also fail in the honest lane** and are
therefore NOT disagreements — they are unimplemented globals
(`DisposableStack`, `AsyncDisposableStack`, `SuppressedError`), identical
message in both lanes. The real honest-pass/linked-fail residual is **38**:

| count | message | mechanism |
| --- | --- | --- |
| 30 | `N should be an own property` | mechanism 2 — symbol key, **blocked on #6495** |
| 7 | `0 descriptor should be enumerable/writable/configurable` | vec `[[DefineOwnProperty]]` element defaults, below |
| 1 | `foo descriptor value should be abc` | not investigated |

(The 31st `should be an own property` row,
`built-ins/Iterator/prototype/Symbol.dispose/prop-desc.js`, fails honestly too.)

**The 7 flag rows are a THIRD, separate mechanism — not the linked edge.**
`_vecDefineOwnProperty` (`src/runtime.ts` ~L8233) deliberately treats an
in-bounds element with no descriptor entry as a FIRST definition, so omitted
attributes default **false**:
`var arr = []; arr[0] = 101; Object.defineProperties(arr, {"0": {}})` leaves
w/e/c all false, and §10.1.6.3 says an all-absent descriptor must make **no
change at all**. The in-code comment states why it cannot simply seed
`_SC_ELEM_DEFAULT`: codegen pre-grows the vec (`maybeEmitVecLengthGrowth`)
before the runtime call, so `idx < oldLen` cannot distinguish a genuine element
from a compiler-created hole, and seeding suppressed the non-configurable
rejection matrix (15.2.3.6-4-252). `arguments` objects are already special-cased
to seed the default, which is why they work. Rows:
`Object/defineProperties/15.2.3.7-6-a-{206,208,247,249}`,
`Object/defineProperty/15.2.3.6-4-{258,260}`. `-208` is anomalous within the
group — it defines all four attributes explicitly and still loses only
`configurable`, which points at `verifyProperty`'s own delete/restore cycle
rather than the define. Deliberately left out of this round: fixing it means
finding a real hole-vs-element discriminator, with the whole vec-define
validation matrix as blast radius.

### Mechanism 2 — FIXED after #6495 landed (30 rows)

#6495 (coherent builtin realm for every row) removed the hang, so the two-line
brand could finally be applied: `src/codegen/property-access-dispatch.ts`'s
well-known-symbol arm now returns `{ kind: "i32", symbol: true }` when
`usesNativeSymbolProvider(ctx)` **or** `linkBrandRoleOf(ctx) !== undefined`,
i.e. when this module is either side of a linked project. Single-module js-host
compiles take the identical unbranded path they took before (#4626's
index-shift reason is untouched).

| lane | before (post-mechanism-3) | after | flips |
| --- | --- | --- | --- |
| linked, 114-row bucket | 68 / 114 | **98 / 114** | **+30, 0 regressions** |
| honest, 114-row bucket | 105 / 114 | 105 / 114 | 0 |
| honest, 818-row for-in/own-property slice | 699 / 818 | 699 / 818 | 0 |
| honest, 1,170-row realm-sensitive slice | 933 / 1,170 | 933 / 1,170 | 0 |

Guard: `tests/issue-6482-r2-linked-symbol-brand.test.ts`.

### Final residual: 16 of 114, and only 8 are disagreements

| count | message | status |
| --- | --- | --- |
| 8 | `Cannot convert undefined or null to object` (6) and `typeof descriptor.get is function` (2) | **NOT disagreements** — identical failure in the honest lane. Unimplemented globals: `DisposableStack`, `AsyncDisposableStack`, `SuppressedError`. |
| 7 | `0 descriptor should be enumerable/writable/configurable` | vec `[[DefineOwnProperty]]` element defaults — a THIRD mechanism, described above. `Object/defineProperties/15.2.3.7-6-a-{206,208,247,249}`, `Object/defineProperty/15.2.3.6-4-{258,260}` |
| 1 | `foo descriptor value should be abc` (`Object/defineProperty/15.2.3.6-4-60.js`) | not investigated |

So the honest-pass/linked-fail residual is **8 rows**, down from 114 at the
start of round 1 and 70 at the start of round 2.

## Round 3 (2026-09-18, Opus lane) — fixing the 7 regressions round 2 shipped

PR #5964 merged with +95 net and **12 regressions** against the promoted linked
baseline. Seven of them were mine.

### Attribution (A/B, real runner, linked lane, the 12 rows path-filtered)

Each of the three round-2 commits was reverted one at a time by file copy
(`git show <sha>^:<file>`), rebuilding both bundles between arms:

| reverted | 12-row result | verdict |
| --- | --- | --- |
| `a056ac355e` (vec enumerates its own element indices, `src/runtime.ts`) | 12 → 5 | **the 7 array rows are MINE** |
| `73799237cf` (#6495 coherent builtin realm, `tests/test262-runner.ts`) | 12 → 12 | exonerated |
| `a72468b98c` (symbol brand, `property-access-dispatch.ts`) | 12 → 12 | exonerated |

The 5 async rows (`await/await-awaits-thenables`,
`dynamic-import/.../await-expr`, three `optional-chaining/*`) are **not** from
any of the three. They fail identically in the HONEST lane on the same commit,
so they are not a linked-lane effect either — they belong to the #6492 lane's
round-6/7 work.

### The defect: `idx < length` is not own-ness for a SPARSE array

Round 2 read own-ness off `idx < __vec_len(obj)`. That is sound for a
registered `arguments` object — §10.4.4 maps exactly `0 .. length-1`, so an
arguments vec is DENSE — and wrong for an ordinary array: `[0, , 2]` has a hole
at index 1 that is in bounds and is **not** an own property. The host cannot
tell them apart: sparseness lives in the in-wasm #3251 overlay and `__vec_gopd`
is not an export, so length is the only signal it has. All 7 rows assert
`hasOwnProperty("1") === false` for a hole.

Round 2's honest "+7" (`Object/keys/*`, `getOwnPropertyNames/15.2.3.4-3-1`) was
**the same defect seen from its flattering side** — the over-broad rule happened
to give the right answer on dense arrays while giving the wrong one on sparse
ones. It was never a gain, and this round gives it back.

### The rule now

- a registered **arguments** vec yields every in-bounds index (dense by
  construction);
- **any other vec** yields only indices the HOST positively knows about — a
  `_wasmPropDescs` entry or a sidecar value, both written by
  `Object.defineProperty` or a host write, neither of which can be a hole;
- an in-bounds index the host has never seen is declined, because it may be one.

Arguments-only alone was measured first and lost 2 further rows
(`15.2.3.6-4-201/203`, `0 descriptor should be enumerable`) — a
`defineProperty`-created index on an empty array, which is exactly the
unambiguous case the second clause restores. `_wasmStructHasOwn` needs no such
widening: its sidecar and descriptor-table checks already run before the vec
arm.

### Measured

| lane / slice | rows | before (main `e9e7a968c6`) | after | flips |
| --- | --- | --- | --- | --- |
| linked, the 12 regression rows | 12 | 0 pass | 7 pass | **+7**, the 5 async untouched |
| linked, `defineProperty/** defineProperties/** copyWithin/** await/** optional-chaining/**` | 1,862 | 1,451 | **1,458** | +7, **0 regressed** |
| honest, same slice | 1,862 | 1,415 | **1,422** | +7, **0 regressed** |
| linked, 114-row #6482 bucket | 114 | 98 | **98** | 0 |
| honest, 114-row bucket | 114 | 105 | 105 | 0 |
| honest, 818-row for-in/own-property control vs its PRE-round-2 baseline | 818 | 692 | 692 | **0** |

Equivalence gate green (22 failing / 1720 passing, all 22 in baseline).

Guard: `tests/issue-6482-r3-sparse-vec-own-indices.test.ts` — and it is a
**linked-lane** test on purpose. A single-module `compile()` lowers all of these
expressions in-wasm and never reaches the host arms, so a plain test asserts
nothing about this fix; the first draft of this guard was written that way and
disagreed with both the old and the new rule. Verified to FAIL on the pre-fix
runtime (1 of 4) and pass after.

### Still open from round 3's own scope (not attempted after the interrupt)

The `15.2.3.7-6-a-{206,208,247,249}` / `15.2.3.6-4-{258,260}` element-default
family and `15.2.3.6-4-60` were investigated before this interrupt and are
**not** fixed. Findings worth keeping:

- `15.2.3.6-4-60` is a VALUE-REPRESENTATION bug, not a flags bug: `obj.foo = 101`
  types the struct field `f64`, and `defineProperty(obj, "foo", {value: "abc"})`
  takes the `useStruct` fast path in `compileObjectDefineProperty`
  (`src/codegen/object-ops.ts`), which `struct.set`s a string into an f64 slot.
  The value is lost with no sidecar entry for `_readOwnDescriptor` to prefer.
  Instrumented: `[dp-struct] foo struct: __anon_0 fieldType: {"kind":"f64"}`.
  A representability veto on that fast path fixes the value.
- The 6 element-default rows need `_vecDefineOwnProperty` to treat an in-bounds
  element with no descriptor entry as a PRE-EXISTING default data property
  (§10.1.6.3 keeps omitted attributes) rather than a first definition. The
  blocker the in-code comment describes — codegen pre-grows the vec before the
  runtime call, so `idx < oldLen` cannot distinguish a real element from a slot
  this define just created — is solvable: the pre-grow's own `idx >= vec.length`
  guard is the only place that knows, so it can mark the index and the define
  consume the mark. That keeps `15.2.3.6-4-252` (the row an earlier attempt at
  this regressed) passing, verified in-process.
- **Both are gated on a THIRD bug and flip 0 rows without it.** `verifyProperty`
  reaches `isConfigurable` → `delete obj[name]` → `!__hasOwnProperty(obj, name)`,
  and for a vec receiver `__hasOwnProperty` never reaches the host import at
  all: `fillVecHasOwnHelpers` (`src/codegen/vec-bag-seed.ts`) unshifts a
  prologue that answers from the in-wasm `__vec_gopd` overlay and returns.
  The host `__delete_property` tombstones in `_wasmStructDeletedKeys`; the
  in-wasm prologue never sees it, so the delete looks like it failed and every
  one of these rows fails `descriptor should be configurable`. Note the recorded
  precedent in `carrier-bag-hasown.ts`: widening `__hasOwnProperty` *generally*
  cost 684 host-free passes and was auto-parked (#4017), so the fix belongs on
  the delete/overlay side — make the host delete clear the overlay entry — not
  on the predicate.

## Round 4 — the hole oracle, and the write side that makes it honest

Measured 2026-09-18, real runner, linked lane, **fresh provider cache per run**
(see the methodology note below — this is load-bearing).

| slice | before (`origin/main` 278b5d1aa5) | after | delta |
| --- | --- | --- | --- |
| the 17 contested rows, linked | 10 dense pass / 7 hole fail | **17 pass** | +7, 0 regressed |
| 2,570-row vec-define matrix, linked | 2,108 pass | 2,114 pass | **+6, 0 regressed** |
| 818-row for-in / keys / assign slice, linked | 699 pass | 699 pass | 0, **0 regressed** |
| 114-row #6482 descriptor bucket, linked | 98 pass | 98 pass | unchanged |
| the 17 rows, honest | 10 pass | 17 pass | +7, 0 regressed |
| 114-row bucket, honest | 105 pass | 105 pass | unchanged |

Equivalence gate: 22 failing / 1720 passing, all 22 in baseline.

### The rule

`idx < __vec_len(v)` is not own-ness. `[0, , 2]` has a hole at index 1 that is
in bounds and is not an own property, and **no pre-existing export can supply
the difference**: `__vec_get` deliberately maps BOTH the hole marker and an
explicit `undefined` element to `undefined` (#4491 T11), so the boundary erases
it by design. Guessing cost rows in both directions across two merge groups —
claiming every in-bounds index lost 7 hole rows (PR #5964), declining every
unconfirmed one lost 10 dense-literal rows (PR #5967).

`__vec_has_own_index(vec, i32) -> i32` answers from the RAW element, before that
boxing: `1` own · `0` hole · **`-1` I-do-not-know**. The third value matters —
the export is reachable with a vec minted by ANOTHER module, where every
`ref.test` fails; answering `0` there reported a perfectly dense foreign array
as all holes. A caller that receives `-1` falls back to its own rule.

### The write side (round 4b) — three stores, one ladder

The oracle can only be as honest as the backing store, and the store did not
agree with §10.4.2.1 (a shrink DELETES, a grow creates HOLES — neither leaves a
value behind):

- `arr.length = n` (`expressions/assignment.ts`) writes ONLY field 0, through
  the `$__vec_base` supertype, so a shrink left the dropped element in its slot;
- `Object.defineProperty(arr, "length", …)` (`array-length-define.ts`)
  reallocates with `array.new_default`, which ZERO-fills the new tail;
- `__vec_set_len` (`vec-define-writeback.ts`) is the host-mirror replay path.

`vec-length-hole-fill.ts` is the single ladder the two `$__vec_base`-typed sites
share — the receiver there has only a `length` field, so reaching the data array
needs a per-vec-type `ref.test` chain, and writing that chain twice more is how
three copies of a rule drift apart.

**The fill is SHRINK-ONLY at two of the three sites, and that restriction is the
non-obvious part.** Both `arr.length = n` and `__vec_set_len` also carry the
APPEND shape — `arr[len] = v` (or `set_elem(i)`) immediately followed by the
length store — so the element is already in the slot when the store runs.
Filling a grown tail there erased it: a plain `[0, 1]` literal came back with
index 1 absent. Only the `defineProperty` site, which has no pending element
write, fills a grow. Both failure directions were measured, not reasoned about.

`array-holes.ts` then arms `usesArrayHoles` for a plain `x.length = n` for the
same reason it already does for a descriptor-define reference: a module whose
literals are all dense would otherwise emit hole-UNAWARE reads against a store
that can now produce holes, and `arr[1]` after `[0,1]; length = 1; length = 10`
read the raw marker back as **NaN** instead of `undefined`. Reads and stores
must be armed by the same pre-pass — function compilation order is not source
order.

### `Object.keys` reaches the vec through the host MIRROR, not `__for_in_keys`

`15.2.3.14-6-2` (`[1,2,,4,,6]`) failed after everything above, with `for…in`
and `Object.keys` disagreeing by one index. A vec is not a `_isWasmStruct`
receiver, so `__object_keys` fell through to the native `Object.keys` on the
materialized mirror — and the mirror was DENSE, every hole present as
`undefined`. The materializers now leave a hole slot ABSENT (asking the same
oracle, so a module that cannot answer behaves exactly as before), and
`__object_keys` gained a vec arm. The 818-row for-in/keys/assign slice moved 0
rows in either direction, which is the evidence that making the mirror sparse
did not disturb the surrounding surface.

### Methodology — the local lane inverts without a fresh provider cache

Every measurement above uses a **per-run** `JS2WASM_TEST262_HARNESS_CACHE`
(`mktemp -d`) and rebuilds BOTH `scripts/compiler-bundle.mjs` and
`scripts/runtime-bundle.mjs` from the tree under test.

Without that, this box reproduces the exact INVERSE of CI on unmodified
`origin/main`: the 10 dense rows fail and the 7 hole rows pass. The default
cache dir is `$TMPDIR/js2wasm-test262-harness-cache`, shared across every
compiler build on the machine, and its key carries only
`PROVIDER_COMPILER_ABI_VERSION` — not a compiler hash (#6488) — so a run links
today's body units against a harness prefix compiled by some earlier compiler.
`scripts/run-test262-vitest.sh` leaves the variable unset, so the official
entry point agrees with the stale rig and the divergence looks like a code
difference. It cost most of a round to find, and it invalidates any local linked
measurement on this family taken without the override. Never reuse a provider
cache dir across trees.

### Known limitation, NOT introduced here

`arr.hasOwnProperty("1")` with a LITERAL key is answered by a constant-key path
that never leaves wasm, and it is wrong about `[0, 1]` (index 1 reads as absent)
— identically on `origin/main` and on this branch, verified by A/B. The guard
test therefore asserts through COMPUTED keys, which is also what the test262
rows use. That in-wasm path deserves its own issue.

## Round 3 — deferred (2026-09-18, Opus lane)

Measured and working, parked while round 4 (the hole oracle) is built. Working
files preserved at `.tmp/rt.r3v.ts` / `.tmp/oo.r3v.ts` on branch
`issue-6482-r3-vec-define-matrix` (base: `origin/main` + the round-3 sparse-hole
commit cherry-picked).

**(iii) `15.2.3.6-4-60` — FIXED, +1 row, 0 regressed across 2,570.** Two parts:
a representability veto on `compileObjectDefineProperty`'s `useStruct` fast path
(it was `struct.set`ting a string into an `f64` field — instrumented
`[dp-struct] foo struct: __anon_0 fieldType: {"kind":"f64"}` — losing the value
with no sidecar entry to fall back on), plus default-seeding in
`__defineProperty_value`'s opaque-TypeError arm so a property that ALREADY
exists is validated as a REDEFINE (§10.1.6.3 keeps omitted attributes) rather
than a first definition. Linked vec-define matrix: 2114 → **2115**, 0 regressed.

**(i) The pre-grow discriminator works but flips 0 rows on its own.** The
discriminator is NOT `.length`: it is the pre-grow's own `idx >= vec.length`
guard in `maybeEmitVecLengthGrowth`, the only place that knows the slot is new.
Mark there, consume at the define; `15.2.3.6-4-252` stays passing (verified
in-process).

**(ii) is NOT tombstone visibility — that diagnosis was wrong.** Probed on the
linked lane against the real provider:

| provider-side call on a consumer-minted vec | verdict |
| --- | --- |
| `isConfigurable(arr, "0")` on `var arr = [101]` | **false** (wrong) |
| `isWritable(arr, "0")` on the same | **false** (wrong) |
| `delete arr[0]` then `__hasOwnProperty` — CONSUMER side | pass |
| `isConfigurable(obj, "foo")` on a struct | pass |

Both predicates fail on a plain literal array **with no `defineProperty` at
all**, while the identical delete works consumer-side. So the blocker is
**cross-module vec MUTATION** — a provider-side write or delete to a
consumer-minted vec is not visible to the provider's own subsequent reads — not
tombstone plumbing. The 6 remaining element-default rows
(`15.2.3.7-6-a-{206,208,247,249}`, `15.2.3.6-4-{258,260}`) are gated on it, so
(i) and the element-default seeding cannot flip them until it is fixed.

Note for whoever takes it: `carrier-bag-hasown.ts` records that widening
`__hasOwnProperty` generally cost 684 host-free passes and was auto-parked
(#4017). The fix belongs on the mutation/overlay side.

## Round 5 (2026-09-18, Opus lane) — round 3 (ii)'s diagnosis is WRONG, and the real blocker is one hardcoded answer

Worktree `/home/user/js2/.claude/worktrees/agent-a33c2f05cad4f2d7d`, branch
`issue-6482-r5-xmod-vec-mutation`, base `887e87650a` (the
`claude/compiler-performance-bn5g3l` tip, i.e. rounds 3 (iii) + 4 + 4b
included). Real runner, one chunk, `TEST262_INCLUDE_PROPOSALS=1`, a **fresh**
`JS2WASM_TEST262_HARNESS_CACHE` per run, both bundles rebuilt between arms.

### The 114-row bucket's true residual is SIX rows, not fifteen

| linked, base `887e87650a` | 99 / 114 |
| --- | --- |

Of the 15 non-passes, **9 are not disagreements** — they fail identically in
the honest lane (`DisposableStack`, `AsyncDisposableStack`, `SuppressedError`
are unimplemented globals; `Iterator/prototype/Symbol.dispose/prop-desc`).
The honest-pass/linked-fail set is exactly the six element-default rows:
`Object/defineProperties/15.2.3.7-6-a-{206,208,247,249}` and
`Object/defineProperty/15.2.3.6-4-{258,260}`.

### Round 3 (ii) said "cross-module vec MUTATION". It is not. Measured.

An in-process linked probe (`runLinked`, the same rig
`tests/issue-6482-r3-sparse-vec-own-indices.test.ts` uses; ~36 s per cycle)
against the REAL provider, consumer bodies with `includes: [propertyHelper.js]`:

| provider-side call on a consumer-minted receiver | verdict |
| --- | --- |
| `__hasOwnProperty([101], "0")` — **no delete anywhere** | **false (wrong)** |
| `__hasOwnProperty([101], "length")` | **false (wrong)** |
| `__hasOwnProperty(["a"], "0")` | **false (wrong)** |
| `__hasOwnProperty({a: 1}, "a")` — **a plain object, not a vec** | **false (wrong)** |
| `[101].hasOwnProperty("0")` (consumer-side, in-wasm) | true |
| `Object.hasOwn([101], "0")` (consumer-side) | true |
| `Object.prototype.propertyIsEnumerable.call([101], "0")` | true |

`__hasOwnProperty` is propertyHelper's
`Function.prototype.call.bind(Object.prototype.hasOwnProperty)` alias, and
`isConfigurable` / `isWritable` are each **a probe plus that call**. The call
answers `false` for every consumer-minted receiver with no mutation involved at
all — so the failure is not a lost delete, not a tombstone, and **not specific
to vecs**. Round 3 (ii) inferred "mutation" from `isConfigurable` being false
without checking the no-mutation control; that control is the whole finding.

### It never reaches the host, so no `_decoderExportsFor` redirect can fix it

Three independent instrumentations, all zero calls on these rows:

- the `__hasOwnProperty` / `__propertyIsEnumerable` closures in `resolveImport`;
- a catch-all print at `resolveImport`'s entry (77 distinct intents observed,
  none own-property-shaped);
- `createHostCallImport`'s `invoke` in `src/runtime/host-call-abi.ts`
  (`__call_function_*`), which is the arm that WOULD wrap a foreign receiver
  through `_wrapForHost` → `_decoderExportsFor`.

So the brief's premise — "find which host arm handles it and route it through
the minting module's exports" — is falsified: there is no host arm. The answer
is produced entirely in the provider's own wasm.

### Where it is produced, and the next concrete step

In the provider, `ctx.funcMap` has **no** `__hasOwnProperty` entry and
`ctx.mod.functions` has **no** such function (dumped at finalize: the only
matching names are the `__js2wasm_get___h___hasOwnProperty_*` getters and
`__fn_tramp_*` trampolines). `tryCompileStoredObjectBuiltinCall`'s uncurried
arm — `src/codegen/expressions/call-object-builtins.ts` ~L190, the site that
lowers this exact alias to `__hasOwnProperty` — is **never reached** for the
provider's call (instrumented: no print). So
`resolveUncurriedBuiltinPrototypeMethod` does not match there, almost certainly
because #6474 moved the harness's top-level `var` to a global-object property
and `oracle.variableInitializerOf` can no longer see the
`Function.prototype.call.bind(...)` initializer.

Note the shape of that lowering's miss arm, because it is the likeliest
producer of a hardcoded `false` once the alias DOES resolve in a module with no
`__hasOwnProperty` provider:

```ts
const finalHelperIdx = ctx.funcMap.get(helperName) ?? helperIdx;
if (finalHelperIdx !== undefined) fctx.body.push({ op: "call", funcIdx: finalHelperIdx });
else fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 0 }); // always false
```

**Next step (one probe, not a round):** print the lowering actually taken for
`__hasOwnProperty(obj, key)` inside the provider — start at
`resolveBoundFunctionInitializer` / `oracle.variableInitializerOf` on a
#6474-hoisted global, then follow the generic dynamic-call path it falls back
to. Fixing the alias resolution (or giving the provider a real
`__hasOwnProperty`) is what unblocks the six rows; the element-default work
below is already correct and waiting on it.

### The element-default seeding is CORRECT and currently invisible

The preserved WIP (`__vec_mark_hole` + a host-side vec arm in
`__delete_property` + `_vecDefineOwnProperty` seeding an in-bounds element as a
pre-existing default data property when `__vec_has_own_index` says so) was
measured on the 114-row bucket: **99 → 99, zero flips either way**. But the
failure MESSAGES shrink, which is the evidence it works:

| row | base message | with the WIP |
| --- | --- | --- |
| `15.2.3.7-6-a-206`, `-249`, `15.2.3.6-4-260` | `0 descriptor should be enumerable; … writable; … configurable` | `0 descriptor should be configurable` |
| `15.2.3.7-6-a-247`, `15.2.3.6-4-258` | same three | `0 descriptor should be writable; … configurable` |

`enumerable` (and for two rows `writable`) become correct cross-module;
`configurable` cannot, because `isConfigurable` bottoms out in the broken
`__hasOwnProperty` above. **Nothing from this round is shipped** — a
codegen+runtime change that flips zero rows is exactly the shape that cost rows
in PR #5964 and PR #5967, and it should land together with the alias fix that
makes it observable, in the same measured commit.

### Methodology note that saved a round

`tests/test262-chunk-dynamic.test.ts` filters on a path RELATIVE TO THE
TEST262 ROOT — `test/built-ins/…`, WITH the `test/` prefix — and
`TEST262_PATH_FILTER` is a pipe-separated SUBSTRING list, not a regex
(`parsePathFilter`, `tests/test262-runner.ts` ~L495). A newline-joined filter
file passed through `TEST262_PATH_FILTER` matches nothing and the run reports
`No test suite found`, which reads like a broken harness. Use
`TEST262_PATH_FILTER_FILE` (exact paths, one per line, `test/`-prefixed).

### Where the unshipped work lives

Commit `ae5802f99f` on branch `issue-6482-r3-fix-regressions` (worktree
`/home/user/js2/.claude/worktrees/agent-a6d0fed89c03acce8`) — 3 files,
+211/−13: `__vec_mark_hole` in `src/codegen/vec-access-exports.ts`, the
`delete a[i]` hole-marker arming in `src/codegen/array-holes.ts`, and the host
vec delete arm + tombstone consults + element-default seeding in
`src/runtime.ts`. It cherry-picks clean onto `887e87650a` and typechecks. Do
not merge it on its own.

## Round 6 (2026-09-18, Opus lane) — the alias arm was gated on `standalone`, and a linked module needs it too

Same worktree and rig as round 5, branch `issue-6482-r5-xmod-vec-mutation`, base
`887e87650a`. Real runner, fresh `JS2WASM_TEST262_HARNESS_CACHE` per run, both
bundles rebuilt from the tree under test between every arm.

### The lowering site round 5 could only point at

Round 5 found the answer was produced entirely in wasm and named
`call-object-builtins.ts`'s uncurried-alias arm as never reached. Probed this
round, `resolveUncurriedBuiltinPrototypeMethod` resolves the alias in the
provider perfectly well (`[rbfi] __hasOwnProperty init: CallExpression
Function.prototype.call.bind(Object.prototype.hasOwnProperty)`). The arm is
never *called*: both call sites in `call-identifier.ts` — L~526
(`tryCompileStoredStandaloneCarrierCall`) and L~1794 — are behind
`ctx.standalone || noJsHost(ctx)`. **The linked harness provider is a js-host
module, so neither held.** The #6474 hoist theory in round 5's note is wrong;
the initializer is visible.

That gate was right when it was written: in a single module the alias's generic
`$__bound_fn` dispatch runs the ENGINE's `Object.prototype.hasOwnProperty`
against a receiver the host wraps through `_wrapForHost`, which is correct for
anything this module minted. Across a #5225 edge the receiver is foreign and
that wrap cannot see it, so the engine answers `false`.

The gate is now `uncurriedBuiltinAliasArmActive` (`call-object-builtins.ts`):
`ctx.standalone || noJsHost(ctx) || linkBrandRoleOf(ctx) !== undefined`. A
single-module js-host compile keeps the identical pre-#6482 path, which is what
leaves #4017's 684 host-free passes and #4626's index-shift reasoning untouched.

### Two `length` rules ship with it, and they are consequences of it

Routing the alias to the host predicate exposed two arms that had never been
asked about a vec's `length`, and the intermediate measurement (gate alone,
below) LOST `Object/defineProperties/15.2.3.7-6-a-114-b` to exactly them:

- `_wasmStructPropertyIsEnumerable`'s raw sidecar shortcut (`prop in sc`) read
  the `length` entry that `Object.defineProperties(arr, {length: {}})` leaves in
  `_wasmStructProps` as ENUMERABLE. A vec's `length` is non-enumerable on an
  Array (§23.1.4.1) and on an arguments object (§10.4.4) alike, so that is
  decided before the shortcut now.
- `__delete_property`'s generic WasmGC arm TOMBSTONED `length`. §10.4.2.1 makes
  an Array's `length` non-configurable, so the delete must refuse; an
  `arguments` object's `length` IS configurable (§10.4.4 step 4) and keeps the
  ordinary path. Without this, `isConfigurable` — a delete plus a presence
  question — read `length` as configurable.

### Measured

| lane / slice | rows | base `887e87650a` | shipped | flips |
| --- | --- | --- | --- | --- |
| linked, 114-row #6482 bucket | 114 | 99 | **100** | **+1, 0 lost** |
| linked, `Object/defineProperty/15.2.3.6-4-*` control (every other file) | 368 | 285 | **289** | **+4, 0 lost** |
| honest, `harness/**` | 116 | 113 | 113 | **0 in either direction** |

Rows gained: `defineProperties/15.2.3.7-6-a-208` (the bucket row) and
`defineProperty/15.2.3.6-4-{303, 309, 310, 354-2}` on the control. Equivalence
gate green (22 failing / 1720 passing, all 22 in baseline).

Guard: `tests/issue-6482-r6-linked-uncurried-hasown.test.ts`, linked-lane for
the reason the round-3 guard documents. Each half is independently pinned —
with the gate reverted the `isConfigurable` case fails; with only the runtime
rules reverted the `length` case fails.

### The intermediate arm, and why the round-5 WIP is parked again — with a sharper reason

Three arms were measured on the 368-row control, not two:

| arm | 368-row control | verdict |
| --- | --- | --- |
| base | 285 | — |
| gate + `length` rules (shipped) | **289** | +4, 0 lost |
| gate + `length` rules + the round-5 WIP | 279 | +4, **−10** |

The WIP (`__vec_mark_hole`, the host vec `delete` arm, and
`_vecDefineOwnProperty` seeding an in-bounds element as a pre-existing default
data property) costs ten rows: `15.2.3.6-4-{201, 203, 216, 218, 238, 241, 246,
248, 251, 538-6}`, failing as `0 descriptor should not be
{writable,enumerable,configurable}` and `Expected TypeError, got …`. That is the
§10.1.6.3 first-definition matrix the in-code comment has warned about since
round 2, and the reason is now specific rather than suspected:
`maybeEmitVecLengthGrowth` pre-grows the vec BEFORE the runtime call and
ZERO-fills the slot it creates, so `__vec_has_own_index` reads a real `0.0`
there and answers "own" for an index that did not exist a moment ago.

**That is a fixable, named next step, and it is the same rule round 4b already
applied elsewhere**: a grow creates HOLES, not zeros. Make the define pre-grow
fill its new tail with the absence marker (as `vec-length-hole-fill.ts` does for
the `defineProperty(arr, "length", …)` site) and the oracle answers 0, the
seeding correctly does not fire, and the six element-default rows become
reachable again. Until then the WIP stays parked at `ae5802f99f` on branch
`issue-6482-r3-fix-regressions`.

### Residual on the six rows

With the WIP applied, four of the six passed (`15.2.3.7-6-a-{206, 208, 249}`,
`15.2.3.6-4-260`) and two did not: `15.2.3.7-6-a-247` and `15.2.3.6-4-258`, both
`0 descriptor should be writable`. Those are a DIFFERENT mechanism —
`isWritable` stores propertyHelper's `unlikelyValue` STRING into a consumer f64
vec from the provider and reads the old number back, i.e. cross-module vec-WRITE
representability. Shipped, only `-208` flips, because it is the one of the six
whose failure was purely the `configurable` probe.

### Not done, deliberately: the hardcoded-false miss arm

`call-object-builtins.ts` ends its uncurried arm with
`drop, drop, i32.const 0` when no `__hasOwnProperty` provider resolves — a
silent `false`. It is unreachable in every configuration measured (a
standalone/`noJsHost` module registers the import even when
`refuseStandaloneObjectImport` refuses it; a linked js-host module resolves it),
and replacing it with an `__extern_method_call` that may itself be unregistered
would swap one unmeasured answer for another. Left as-is and recorded here.

### Methodology note (extends round 4's)

Two traps cost time this round and belong with the harness-cache one above:

- **`node scripts/compiler-bundle.mjs` does NOT rebuild anything.** Those files
  are the esbuild OUTPUTS; running them is a no-op (here it exits
  `MODULE_NOT_FOUND`, which is the lucky case — a stale bundle that merely runs
  is the dangerous one). Rebuild with
  `pnpm run -s build:compiler-bundle && pnpm run -s build:runtime-bundle`, and
  check `ls -la scripts/runtime-bundle.mjs` against your last edit's mtime.
- **`TEST262_PATH_FILTER` is a pipe-separated SUBSTRING list, not a regex, and
  its paths are TEST262-ROOT-relative — `test/built-ins/…`, WITH the `test/`
  prefix** (`parsePathFilter`, `tests/test262-runner.ts` ~L495). A newline-joined
  filter file matches nothing and the run reports `No test suite found`, which
  reads like a broken harness rather than an empty filter. Use
  `TEST262_PATH_FILTER_FILE` — one exact path per line — and confirm the
  `Chunk 1/1: N tests` line reports the N you expect.
- The honest lane is memory-hungry on this box: two 114-row honest runs were
  OOM-killed (exit 137) while other runners were live. Run one lane at a time.

## Round 7 (2026-09-18, Opus lane) — a pre-grow creates holes, and the round-5 WIP finally ships (minus one piece)

Same worktree and rig, base `887e87650a` + round 6 (`ab95b7f81b`). Real runner,
fresh `JS2WASM_TEST262_HARNESS_CACHE` per run, both bundles rebuilt with
**`pnpm run -s build:{compiler,runtime}-bundle`** between every arm.

### (1) `maybeEmitVecLengthGrowth` zero-filled the slot it invented

`Object.defineProperty(arr, "<index>", desc)` at or past the length pre-grows
the vec BEFORE the runtime define runs, and `array.new_default` ZERO-fills the
tail. `__vec_has_own_index` reads the RAW element, so it answered "own" for an
index that did not exist a moment earlier, and `_vecDefineOwnProperty` read the
define as a REDEFINE (§10.1.6.3 keeps omitted attributes) instead of a FIRST
definition. That is exactly the 10-row §10.1.6.3 loss round 6 measured, and the
fix is the rule round 4b already applied at the `defineProperty(arr, "length", …)`
site: **a grow creates HOLES, not zeros.** The pre-grow now calls the shared
`vec-length-hole-fill.ts` emitter over `[oldLen, array.len(data))`.

Two restrictions are load-bearing, both measured rather than reasoned:

- **The fill must cover the EXTERNREF carrier, not just f64.** An EMPTY array
  literal (`var arr = []`) has no element-type evidence and is minted on the
  externref carrier, where a default slot reads back as `null` — which the
  oracle does not recognise as a hole. f64-only left **all ten** rows still
  failing; the carrier check took one instrumented compile
  (`[vlhf] f64Vecs: 1 allVecs: externref,f64`). Externref is opt-in
  (`includeExternref`) and only sound because `ctx.usesArrayHoles` is already
  armed here (`isDescriptorDefineReference`); minting `$Hole` in a module
  without it would shift every type index (#2043).
- **Only for a statically recognisable DATA descriptor.** An accessor define
  writes no element, so the marker would survive with nothing to overwrite it.

### (2) The round-5 WIP ships — WITHOUT its host vec `delete` arm

Round 6 parked `ae5802f99f` wholesale. With the fill in place it was re-measured
piece by piece, and **one piece is responsible for the only regression**:

| arm, 368-row `15.2.3.6-4-*` control (linked) | result |
| --- | --- |
| round 6 (shipped) | 289 |
| + pre-grow fill + the FULL round-5 WIP | 295 (**+7, −1**) |
| + pre-grow fill + WIP **minus the host vec `delete` arm** (shipped) | **290 (+1, 0 lost)** |

The `−1` is `15.2.3.6-4-538-6`, and five separate single-piece reverts did NOT
clear it (the marker write, the `_readOwnDescriptor` tombstone read, the
`_vecOverlayOwnIndex` tombstone read, the element-default seeding, the
tombstone clear); removing the whole `__delete_property` vec-index arm did.
Instrumented, the receiver there is an `arguments` exotic object that the host
does **not** recognise as one at that moment (`_argumentsObjects.has(obj)` is
`false`), so the arm treats a vec §10.4.4 requires to stay dense as an ordinary
array. `__vec_mark_hole` and the `delete a[i]` hole-arming in `array-holes.ts`
went with it (both existed only to serve that arm; leaving them would ship an
unreferenced export).

**The forfeited six** — `15.2.3.6-4-{191,199,229,234,236,244}` — are real and
recoverable: they need that delete arm with a correct arguments discriminator.
The host has none today; the wasm side has the #4658 `$__arguments_vec` brand,
so the missing piece is an export that answers "is this receiver an arguments
exotic object" from the MINTING module. That is the next concrete step, and it
is worth +6 against the one row it currently costs.

### Measured (shipped state)

| lane / slice | rows | round 6 | shipped | flips |
| --- | --- | --- | --- | --- |
| linked, 114-row #6482 bucket | 114 | 100 | **103** | **+3, 0 lost** |
| linked, `Object/defineProperty/15.2.3.6-4-*` control (every other file) | 368 | 289 | **290** | **+1, 0 lost** |
| honest, `harness/**` | 116 | 113 | 113 | **0 either way** |

Rows gained: `Object/defineProperties/15.2.3.7-6-a-{206,249}` and
`Object/defineProperty/15.2.3.6-4-260`. Equivalence gate green (22 failing /
1720 passing, all in baseline). The honest 114-row control was **skipped** —
the honest lane compiles the whole harness per test and this box OOM-killed it
(exit 137) twice while other runners were live.

Guard: `tests/issue-6482-r7-pregrow-holes.test.ts` (4 linked-lane cases; 2 fail
with the codegen reverted). A case body must use the ROW's own literal:
`[12]` mints the f64 carrier and fails on the unrelated round-6 `isWritable`
residual, while `15.2.3.6-4-260`'s actual `[undefined]` mints externref.

### The last two rows are NOT a linked-lane problem — the brief's premise is wrong again

`15.2.3.7-6-a-247` / `15.2.3.6-4-258` fail `0 descriptor should be writable`.
The brief attributed this to "a provider-side write of a non-number into a
consumer f64 vec" needing `_decoderExportsFor` + the writeback veto. Measured,
none of that applies:

```
var arr = [100]; arr[0] = "s"; String(arr[0])  →  "NaN"     (CONSUMER side, in-wasm, single module)
[vset] 0 val: unlikelyValue result: 1                        (the host setter ACCEPTS it)
```

`__vec_set_elem`'s f64 arm is **lossy, not rejecting**: it coerces the string to
`NaN` and reports success, so the sidecar fallback both writers already have
never fires and there is nothing for a read-side override to prefer. The defect
reproduces in one module with no boundary involved, and the fix is a
**representability veto on the f64 carrier's setter** — reject a non-number
instead of coercing — whose blast radius is every host-driven vec write in the
project (host `Object.assign`, mirror writeback, dynamic `this.x[i] = …`), not
the linked edge. A `_decoderExportsFor` + read-override prototype was written
and measured: it flips **0** rows, because the write never fails. Reverted
unshipped; recorded here so the next lane does not rebuild it.
