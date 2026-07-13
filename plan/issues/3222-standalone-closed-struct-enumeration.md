---
id: 3222
title: "standalone: native closed-shape struct field enumeration — Object.keys/values/entries/spread/rest all return empty for typed objects (~989 test262 files touch the surface)"
status: done
assignee: ttraenkler/opus-c1
completed: 2026-07-13
sprint: current
model: opus
created: 2026-07-13
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: objects, property enumeration, spread, destructuring
goal: standalone-mode
related: [3218, 2515, 1472, 2714, 987, 2158, 3229]
test262_bucket: standalone-closed-struct-enumeration
# (#3222 C1) Intended growth: the enumerable-own materialize option lives on the
# existing `materializeStructAsDynamicObject` (literals.ts) beside its default
# ToPrimitive caller; the two call sites (object-spread in literals.ts, object-rest
# in statements/destructuring.ts) are the correct homes for the standalone-gated
# closed-struct enumeration.
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/statements/destructuring.ts
---

# #3222 — native closed-shape struct field enumeration (standalone)

## Problem (verified on current main, target standalone)

Under `--target standalone`/`wasi`, native property ENUMERATION of a
**closed-shape struct** object (a typed object, e.g. an object literal whose
inferred type is `{a:number,b:number}`) is broken across the board. The
enumeration helper `__object_keys(externref)` only walks the open-`$Object`
hash-map; it has **no closed-struct arm**, so once a typed object is erased to
externref (or read at a site that routes through the runtime enumeration path),
every enumeration returns EMPTY:

| Expression (standalone) | Result | Host |
| --- | --- | --- |
| `Object.keys({a:1,b:2,c:3}).length` | **0** | 3 |
| `{...closedStruct}` spread | **empty** | 3 |
| `const {a,...rest} = {a:1,b:2,c:3}` (rest) | **empty** | correct |
| `Object.values` / `Object.entries` / `Object.assign` on a typed object | empty / wrong | correct |

The host import path enumerates closed structs via `__sget_<field>` reflection +
a struct field-name registry (`_getStructFieldNames`, `src/runtime.ts`). The
standalone native path has no equivalent.

This is the substrate gap that blocks the DOMINANT test262 object-rest pattern
(`var {a,b,...rest} = {x:1,y:2,a:5,b:3}`) — see #3218, which added the native
`__extern_rest_object` de-leak that is correct for open-`$Object` sources but
inherits this enumeration gap for closed-struct sources. It ALSO blocks
`Object.keys`/`values`/`entries`/spread standalone for typed objects.

## Leverage (test262 syntactic-usage upper bounds)

| Surface | Files touching |
| --- | ---: |
| object-rest only | 417 |
| `{...spread}` | 383 |
| `Object.keys` | 244 |
| `Object.entries` | 239 |
| `Object.assign` | 39 |
| `Object.values` | 30 |
| **union (keys/values/entries/assign/spread/rest)** | **989** |

Fixing enumeration uniformly is ~2.4× the rest-only surface — the real
high-leverage substrate lever, not a rest-only point fix.

## Candidate approaches

1. **Static enumeration at known-type sites (bounded, low-risk, partial).**
   When `Object.keys`/`values`/`entries`/spread/rest sees a source whose
   **static** type is a known closed struct, emit the field list directly (the
   compiler already has `ctx.structFields.get(typeName)` at those sites — see
   `statements/destructuring.ts:745-752`). No runtime metadata, no representation
   change. Misses the erased-to-externref-across-a-fn-boundary case, but that is
   the minority for keys/spread/rest (literals + typed locals dominate).
2. **Runtime closed-struct arm in `__object_keys` (the complete fix, medium-large).**
   Add a generated dispatch: given an externref that `ref.test`s one of the
   registered struct types, return that type's field-name vec. Handles the erased
   case too; needs per-struct-type field metadata + a dispatch (mirrors how the
   host `_getStructFieldNames` works, but Wasm-native).
3. **Typed object literals as open `$Object` in standalone (broad, higher-risk).**
   Make typed literals compile to the open hash representation in standalone so
   ALL enumeration Just Works via the open-hash path. Cleanest conceptually but
   HIGH blast radius (changes core object representation + every field read/method
   call for standalone typed objects) — not a bounded safe first slice on its own.

**Recommended sequencing:** land approach (1) first (bounded, safe, captures the
literal/typed-local majority for keys/values/entries/spread/rest), then approach
(2) for the erased-externref tail. Approach (3) only if (1)+(2) prove insufficient
and the representation tradeoffs are acceptable.

## Notes

- `ctx.standalone`/`ctx.wasi`-gated; host/gc byte-identical.
- Broad-impact → validate on the merge_group standalone floor.
- Once landed, #3218's `__extern_rest_object` handles closed-struct sources
  automatically (it delegates to `__object_keys`).

## Implementation (C1 landed) — WHY, and the measure-first scope correction

**Measure-first correction (important).** Re-probed on FRESH main before coding
(the "keys returns 0" symptom is a classic stale-source artifact). Findings on
current main, `--target standalone`:

- `Object.keys({a:1,b:2,c:3}).length` → **3** already (a bare object LITERAL
  compiles to an open `$Object`; native `__object_keys` walks it fine).
- `Object.keys(typedLocal)` already returns a CORRECT vec via the existing
  compile-time struct fast-path in `compileObjectKeysOrValues`
  (`object-ops.ts`) — `const k = Object.keys(o); k.length` → **3**.
- So `Object.keys`/`values`/`entries` are LARGELY NOT broken. The genuinely
  empty standalone cases are **object-SPREAD `{...closedStruct}`** (copied
  nothing) and **object-REST `{a, ...rest}` of a closed struct** (empty rest).
  Both funnel runtime enumeration through native `__object_keys`, which has no
  closed-struct arm, so a struct erased to externref is invisible to them.

C1 therefore narrowed to **spread + rest** (the actually-broken surface), NOT
all of keys/values/entries.

**The fix (one primitive, two sites, all `standalone`-gated).** Reuse the
existing `materializeStructAsDynamicObject` (`literals.ts`) — which already
copies a closed struct into a real open `$Object` via `__new_plain_object` +
`__extern_set` — with a new `{ skipInternalFields: true }` option that drops
`__`-prefixed brand/tag/method-table slots (mirrors the `userFields` filter in
`compileObjectKeysOrValues`). Once the source is an OPEN `$Object`, the existing
host-free open-hash helpers enumerate it correctly:

1. **Spread** (`literals.ts`, `compileObjectLiteralWithAccessors` spread arm):
   when the spread source's emitted type is a closed struct, materialize →
   `$Object` before the existing `__object_assign(target, [src])` merge. Gated
   on `ctx.standalone` ONLY: this handler's array-builder + `__object_assign`
   merge is host-free only under `standalone` (the `else` arm takes the
   `__js_array_new` host import), so `--target wasi` object-spread has a
   SEPARATE pre-existing gap (open-`$Object` spread is also empty under wasi) —
   out of C1 scope, tracked as a follow-up.
2. **Rest** (`statements/destructuring.ts`, the `hasRestElement` bail): instead
   of `extern.convert_any` (which reinterprets the struct as an opaque externref
   `__object_keys` can't read), materialize → `$Object`, then run the existing
   `compileExternrefObjectDestructuringDecl`. Gated on `ctx.standalone ||
   ctx.wasi` — the rest downstream `__extern_rest_object` is native in BOTH
   (#3223), so wasi rest works too (verified). A `ref.cast` to the resolved
   struct type precedes materialize when the anon-literal source's `typeIdx`
   differs from the resolved `structTypeIdx`.

**Why NET ≥ 0 by construction.** Every change is behind a `standalone`/`wasi`
guard, and the shared helper's DEFAULT path (no opts) is unchanged (all fields,
same struct-field indices/order) so its existing ToPrimitive caller is
untouched. PROVEN byte-identical: host & gc emitted-Wasm SHAs are IDENTICAL to
origin/main on a spread/rest corpus (`b613c0288ad335fc`); only
standalone/wasi bytes change (+the feature). Host/gc cannot regress.

**Correctness validated** (standalone, instantiated with `{}`): spread
keys=3/values=6, spread+override=13 (one key per name, override value wins),
2-struct merge=3; rest keys=2/values=5 (excluded key dropped), nested/multi
rest=2; wasi rest=2. Own-enumerable order = struct declaration order (numeric-
key ascending-first reordering is a pre-existing shared limitation of the
static path, not introduced here).

**Discovered + split off: #3229** — `Object.keys(o).length` read INLINE on the
call result returns 0 (the static keys fast-path returns a vec-of-externref;
`.length` dispatches on the vec-of-string type → `ref.test` fails → `f64.const
0`). Mode-AGNOSTIC (host too), so fixing it changes host bytes — deliberately
kept OUT of C1 to preserve byte-identity. Filed separately.

**C2 (follow-on, NOT this slice):** a runtime closed-struct arm in
`__object_keys` for sources erased to externref across a function boundary
(approach 2 above).
