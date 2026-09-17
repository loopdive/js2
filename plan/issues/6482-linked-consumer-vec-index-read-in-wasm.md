---
id: 6482
title: "Linked test262 harness: a provider reading a consumer array by index is lowered in-wasm and misses the consumer's vec type"
status: in-progress
sprint: current
created: 2026-09-15
updated: 2026-09-17
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: arrays
goal: test262-conformance
depends_on: [6477]
related: [3451, 5225, 6477]
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
| 19 | `N descriptor should be enumerable` | per-key flags the consumer wrote (`_wasmPropDescs`) vs the provider's `_readOwnDescriptor` — NOT investigated this round |
| 6 | `N descriptor should be enumerable; … writable; … configurable` | same as above |
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
