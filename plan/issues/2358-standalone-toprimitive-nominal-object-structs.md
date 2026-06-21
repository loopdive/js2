---
id: 2358
title: "Standalone native __to_primitive can't reduce typed (nominal) object structs through the externref boundary"
status: ready
sprint: Backlog
model: opus
created: 2026-06-18
updated: 2026-06-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, type-coercion
language_feature: to-primitive, abstract-operations
goal: standalone-mode
related: [1917, 10, 50, 1673]
folds_in: [10]
origin: "2026-06-18 sdev-coerce root-cause of the #50 standalone ToPrimitive residual (re-scoped from #50)"
---

# #2358 — Standalone native `__to_primitive` over nominal object structs

This is the **engine half** of the re-scoped #50. The arithmetic *headline*
(typed object operands with `valueOf():number` across `*`, `-`, unary-minus)
is already closed on `main`. The genuine residual is one engine gap, surfacing
in several operators. It is a #1917-coercion-engine sub-task and wants this
spec + its own properly-scoped impl session — **not** a session-tail change.

## Problem

In standalone / `--target wasi` (nativeStrings, no JS host), `ToPrimitive` on a
value that reaches the coercion boundary as an **externref** is performed by the
native runtime helper `__to_primitive` (`src/codegen/object-runtime.ts:1910`).
That helper recognizes a runtime object **only** via
`ref.test (objectTypeIdx)` — i.e. it only handles the *dynamic* `$Object`
runtime struct. A **typed object literal** (e.g. `{ valueOf() { return 42 } }`)
compiles to a **nominal** WasmGC struct. When that nominal struct is coerced to
externref and handed to `__to_primitive`, `any.convert_extern` →
`ref.test objectTypeIdx` **misses**, so the object is returned unchanged; the
caller then `__unbox_number(object)` → **NaN** (or carries the raw object
through).

The working `*` / `-` / unary-minus path does **not** hit this: it uses
**static** `valueOf` dispatch in `coerceType` (ref(struct)→f64,
`type-coercion.ts:1723`), which reads the struct's TS fields at compile time and
inlines the call — but that requires the concrete `typeIdx`, which is **erased**
the moment an operand is coerced to externref. `+` (via `emitAnyAdd`,
`binary-ops.ts:2845`) and any `any`-typed parameter path lose the typeIdx and
must fall back to the runtime helper — which can't reduce nominal structs.

## Repro (current `main`, `--target wasi`)

A single engine fix closes all of these:

| expr | actual | expected | path |
|------|--------|----------|------|
| `{valueOf:()=>4} + {valueOf:()=>3}` | raw object | `7` | `emitAnyAdd` → `__to_primitive` |
| `{valueOf:()=>4} + 1` | raw object | `5` | `emitAnyAdd` → `__to_primitive` |
| `1 + {valueOf:()=>4}` | raw object | `5` | `emitAnyAdd` → `__to_primitive` |
| `function f(x:any){return x*2}` with object arg | `NaN` | `84` | `type-coercion.ts:1360` externref→f64 |

**Correction to the #50 re-scope:** the re-scope stated `obj+obj`/`obj+7` were
correct on main — they are NOT. `+` with object operands is broken (returns the
raw object), because `+` routes through the externref/`__to_primitive` path, not
the static struct-valueOf path. `-`/`*`/unary-minus ARE correct (static path).

### Two latent codegen bugs in the same area (valueOf returns an object)
Fold these into the impl — same root (the reduction must fall through
valueOf→toString and the arms must stay well-typed):
- `1 * ({valueOf:()=>({}),toString:()=>1} as any)` → **compile error**
  "type error in fallthru[0] (expected f64, got externref)".
- `"x" + ({toString:()=>({})} as any)` (object-returning toString) → **trap**
  "illegal cast".

## Exact sites

- `src/codegen/object-runtime.ts:1910` — native `__to_primitive`; the
  `ref.test objectTypeIdx` recognition that only matches `$Object`.
- `src/codegen/type-coercion.ts:1360` — standalone externref→f64 arm; calls
  `__to_primitive` then `__unbox_number`, degrading to `drop; f64.const NaN`
  when the reduction yields a non-primitive.
- `src/codegen/type-coercion.ts:1723` — the WORKING static struct-valueOf
  dispatch (ref(struct)→f64); the reference behaviour to reproduce host-free
  over the externref boundary.
- `src/codegen/binary-ops.ts:2845` — `emitAnyAdd`; the `+` site that compiles
  operands to externref (to preserve runtime strings for concat) and so loses
  the static typeIdx.

## Proposed approach — two representational options

The crux: at the externref boundary the runtime needs a host-free way to (a)
**detect** that an externref wraps a user object carrying `valueOf`/`toString`
(or `@@toPrimitive`), and (b) **dispatch** that method. `$Object` already
supports this; nominal structs do not.

### Option A — brand/RTTI on nominal object structs (recommended)
Give every nominal object-literal/class struct a detectable brand so
`__to_primitive` can recognize it and dispatch its `valueOf`/`toString`
host-free. Concretely: a shared supertype or a reserved tag/brand field that
`__to_primitive` can `ref.test`/read, plus a small per-struct dispatch trampoline
(reuse the `${name}_valueOf` / `${name}_@@toPrimitive` functions the static path
at `type-coercion.ts:1723`/`1768` already emits — register them so the runtime
helper can reach them by a brand→funcidx table, mirroring how `__call_@@toPrimitive`
is exported at `index.ts:1596`).
- **Pros:** additive; nominal structs keep their compact field layout and fast
  static paths; only objects that actually cross the externref boundary pay; no
  rep change to the hot WasmGC object model.
- **Cons:** needs a brand allocation + a runtime brand→method dispatch table;
  must keep the table in sync across late-import index shifts (use the
  ensureLateImport / `funcMap.get(name)`-AFTER-flush discipline, never a baked
  snapshot — see #1673 / the `reference_no_rebuild_helper_body_at_finalize`
  lesson).

### Option B — unify nominal object literals to `$Object`
Compile object literals that can reach a dynamic boundary as `$Object` so
`__to_primitive` already works.
- **Pros:** no second mechanism; one object representation at the boundary.
- **Cons:** broad blast radius and likely **hot-path regression** — every such
  literal loses its nominal struct's compact layout / static field access; risks
  the standalone high-water floor. Heavier and riskier than A.

### Recommendation
**Option A.** It is additive and confines cost to objects that actually cross
the externref boundary, matching the #1673 "additive, zero hot-path cost"
discipline. Option B is a representational change with a standalone-perf risk
disproportionate to the bucket.

## Guardrails (#1673 discipline)
- **Additive only** — do not alter the existing `$Object` path or the nominal
  struct field layout used by the fast static paths.
- **Floor-gate the standalone high-water** (`benchmarks/results/test262-standalone-highwater.json`,
  `scripts/check-standalone-highwater.mjs`) — coercion + object dispatch are hot.
- **WAT-diff** a representative standalone module before/after to confirm the
  hot static `*`/`-` paths are byte-identical (no accidental routing of
  already-working operators through the new runtime path).
- **Late-import index discipline:** resolve any new helper/dispatch funcidx by
  name AFTER the last `flushLateImportShifts`/`addUnionImports`; never bake a
  snapshot into a helper body (the #2043 / `reference_string_global_sentinel_guard`
  family).

## Scope folded in
- **#10** (route `Number(array)`→primitive through the #1917 engine) — same
  externref-boundary ToPrimitive reduction; do it on the same mechanism so the
  `#2108` coercion-site gate stays flat (reuse the sanctioned shared helper, do
  not hand-roll a new coercion site).

## Acceptance
- All four repro rows above return the spec-correct value standalone.
- The two latent `as any` cases compile + run (no fallthru type error, no illegal
  cast).
- `Number([1])` / `Number(arr)` reduce correctly standalone (#10).
- Standalone high-water floor not regressed; `*`/`-`/unary-minus WAT unchanged.
- `#2108` coercion-drift gate stays flat (`node scripts/check-coercion-sites.mjs`).

## Re-measure
The 2026-06-12 standalone JSONL `object-to-primitive` bucket (107) is **stale**
and the headline is partly closed — re-measure the true tractable count on a
**fresh standalone shard** before sizing the impl.

## PR-2 design — call-site struct→$Object materialization (chosen over brand)

**Measured residual (current main, 2026-06-18, sdev-toprimitive):**
- any-typed PARAMETER over nominal struct — `function g(x:any){ return x*2 | x-1 |
  x+1 | +x }`, class-instance param, `x==21` loose-eq — ALL null/broken.
- `Number([1])`/`Number([42])` (ARRAY) broken (#10). `Number(obj)` with valueOf
  ALREADY PASSES on main, so #10 is specifically Number(**array**).

**Root cause (any-param):** inside `g`, `x` is a plain `externref` param with NO
typeIdx — the nominal struct is genuinely erased at the CALL boundary (`g`
compiles independently of its callers). `x*2` already routes through
`__to_primitive`→`__unbox_number`; it fails only because `__to_primitive` can't
recognise the nominal struct. PR-1's typeIdx-recovery is impossible here. The
typeIdx IS still known at the *coercion site* that performs the erasure
(`coerceType` ref-struct→externref, `type-coercion.ts:1573`; equivalently the
call-arg coercion in `stack-balance.ts`).

**Chosen approach (tech-lead approved over the spec's brand Option A):**
MATERIALIZE the nominal struct into a dynamic `$Object` at the
ref-struct→externref coercion, reusing the already-working
`__to_primitive($Object)` path verbatim. The materializer mirrors
`compileObjectLiteralAsExternref` (`literals.ts:175`): `__new_plain_object` +
`__extern_set(obj, "<field>", value)` per struct field (methods stored as their
closure value, the same way the `as any`-literal path does). The boxed `$Object`
then satisfies `__to_primitive`'s `ref.test objectTypeIdx`.

Why this over the brand-supertype: **no struct-layout change, no `$brand` field,
no field-index shift** — so the hot static field-access path is byte-identical
(it never enters this coercion arm). Cost is confined to the
user-object→externref coercion (the cold path). Matches the #1673 "additive,
zero hot-path cost" bar. The brand-supertype is only needed for nominal
**identity** preservation across an `any` round-trip (`===`/`Object.is`), which
ToPrimitive/arithmetic/`Number()` do not require.

**Surgical gate (avoid the #1525 regression):** only materialize when the struct
carries a user `valueOf`/`@@toPrimitive`/`toString` (a dynamic-ToPrimitive
object). A plain data struct (`{x:1}`, no methods) keeps the status-quo
`extern.convert_any` — byte-identical — so `typeof obj==="object"`, plain field
reads, and reference identity for method-less data objects are unchanged.

**Identity caveat (tech-lead flagged):** materialization makes a *copy*. If a
test262 case round-trips a method-bearing object through `any` and then checks
`===`/`Object.is` reference identity, it would see a different `$Object` and
regress. The standalone HW floor-gate catches this. Any identity-dependent
residual found stays DEFERRED to the heavier brand approach (noted, not broken).

**Folds in #10:** `Number([arr])` reduces via the same `$Object`/array→primitive
path on the shared engine.

**Guardrails:** floor-gate standalone HW (no breach of 20,706); WAT-diff hot
static `*`/`-` + plain-data-struct→externref byte-identical; reuse the #1917
engine (keep `check-coercion-sites.mjs` flat); helpers BY NAME (late-import
funcidx-shift class).
