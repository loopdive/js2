---
id: 2162b
title: "Standalone array-spread of a pair-producing array iterator ([...arr.entries()])"
status: done
sprint: 64
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: iterators-collections
goal: standalone-mode
parent: 2162
depends_on: [2162a]
---

# Standalone array-spread / Array.from of pair-producing iterators

## Problem

On standalone (`--target wasi`), spreading any **pair-producing iterator** into
an array literal — or destructuring one — is broken, and it is NOT Map-specific:

```ts
const arr = [10, 20];
[...arr.entries()]; // VALIDATE-FAIL: array.set expected f64, found call externref
const m = new Map<number, number>();
m.set(1, 9);
[...m.entries()]; // VALIDATE-FAIL (identical)
[...m]; // bare Map → entry pairs: leaks env.__array_from_iter; length 0
Array.from(m.entries()); // VALIDATE-FAIL (same family)
```

Proof it is general: `[...arr.entries()]` (a plain **array** entries iterator,
no Map) fails identically. `for-of ([k,v] of map)` works zero-import (it consumes
pairs inline, never materializing a vec-of-pairs), so the **producer** is fine —
the gap is purely consumer-side **materialization** of `$ObjVec` `[k,v]` pair
externrefs into an array/tuple. Cluster ≈ 300 tests (entries spread/Array.from +
the array-rest / tuple destructuring that shares the materialization path).

## CORRECTION (2026-06-18, sdev-iter — building PR-A disproved the split below)

**PR-A (sites (1)+(2), literals.ts only) is a NO-OP — do not implement it as
written.** Verified empirically: with the `isPairSpreadSource`→externref
element-type heuristic applied, `[...arr.entries()]` / `[...map.entries()]` still
VALIDATE-FAIL identically (`array.set expected f64, found <externref>`), and even
`const e: any[] = [...arr.entries()]` and the bare `[...arr.entries()].length`
form fail the same way.

**Why:** the `[...x.entries()]` array literal does NOT take its element type from
the `compileArrayLiteral` heuristic that (1) targets. `x.entries()` materializes
an externref-pair `$Vec`; the spread→array-literal path coerces it through
`type-coercion.ts`'s `buildVecFromExternref` / `__tup_*` **vec-of-tuple-structs**
machinery (WAT-confirmed: `$__tup_vec_*` / `$__tup_mat_*` locals + a per-pair
tuple `struct.new` with numeric `[number,number]` fields, pulling
`__array_from_iter`). So the result is a vec of `[number,number]` tuple structs
and the break is coercing an externref pair into f64 tuple fields — entirely in
the **core type-coercion.ts path**, not reachable from the literals.ts heuristic.

**Consequence:** the safe literals.ts-only PR-A does not exist. The only fix is
the high-blast-radius `__tup_*`/`buildVecFromExternref` materialization change,
which backs ALL tuple/`[k,v]` spread + destructure. **The real design fork is the
externref-pair-vec REPRESENTATION**: should entries materialize a vec-of-(externref
`$ObjVec` pairs) — read back via `__extern_get_idx`, host-import-free — vs the
current vec-of-(tuple struct)? That representation decision is architect-scale.
ESCALATED to tech lead for a true architect / second pair of eyes (2026-06-18).

---

## RE-GROUNDING (2026-06-18 PM, sdev-iter — base advanced under the spec; DE-ESCALATED)

Re-probed against current upstream/main (rev e9579720). The landscape moved —
the array-entries spread VALIDATE-FAIL is **gone** (a sibling slice, #2169/task
#18, landed the native array-iterator path). The residual is now NOT a
representation rewrite. Current standalone state (zero host imports):

| form                                                      | result         | want            |
| --------------------------------------------------------- | -------------- | --------------- |
| `[...a.entries()].length`                                 | **2** OK       | 2               |
| `[...a.entries()][i][j]`                                  | **0** WRONG    | the pair fields |
| `for (const [k,v] of a.entries())` (inline)               | **30** OK      | 30              |
| `[...Object.entries(o)][0][1]`                            | **5/`"x"` OK** | correct         |
| `[...m.entries()]` / `[...m]` / `Array.from(a.entries())` | VALIDATE-FAIL  | —               |

**Two distinct, tractable (NOT architect-scale) defects remain:**

**Defect A — pair-field read keying (FIX FOUND, applied, partial).**
`buildVecFromExternref`'s `buildElemCoerce` tuple-struct branch
(`type-coercion.ts` ~L256–285) read each pair field with `__extern_get(pair,
box(fi))` — the string-keyed reader, which casts its key to `$AnyString` and
returns undefined on a native `$ObjVec`, so every field read 0. The **outer**
loop already chose `__extern_get_idx` (f64 index) under `useNativeObjVec`; the
inner pair-field read did not. Fix: mirror the outer reader choice — use
`getIdxIdx` (`__extern_get_idx`) when `useNativeObjVec`. WAT-confirmed the
emission flipped from `box;call __extern_get` to `f64.const;call
__extern_get_idx`. **Necessary and correct, but alone does NOT make
`[...a.entries()][i][j]` non-zero** — Defect B masks it.

**Defect B — `array.entries()` canonical-vec pairs read back 0; `Object.entries`
(structurally identical `$ObjVec` pairs) reads 5.** This is the live blocker.
`compileNativeArrayIterator` (`array-methods.ts` ~L3360) builds each `.entries()`
slot as an `$ObjVec` via `__objvec_new`/`__objvec_push` (key idx0, value idx1) —
**exactly** mirroring `__object_entries`, per the L3460–3465 comment — then stores
the pair externref into a **canonical externref `$Vec`** (`canonVecTypeIdx`) and
returns it `extern.convert_any`-wrapped. The spread's outer
`__extern_get_idx(canonVec, i)` returns the pair externref; the inner
`__extern_get_idx(pair, j)` then returns 0. Since `Object.entries`'s pairs (same
`$ObjVec` builders) read back correctly through the SAME `buildVecFromExternref`,
the divergence is in how `array.entries()` wraps/stores the pair vs how
`Object.entries` does — likely the pair externref is double-wrapped or stored
under a type the inner `ref.test objVecTypeIdx` no longer matches after the
canonical-vec round-trip.

**Defect B root cause (RESOLVED).** It is NOT a double-wrap. `__extern_get_idx`
simply had **no indexing arm** for the canonical externref `$Vec` container.
`boxVecElementToExternref` (object-runtime.ts) deliberately returns `null` for
EVERY externref/ref element (the #2190 round-2 hardening — a blanket externref
arm left a `(ref null N)` on the helper's `externref` return for the
`ref`/`ref_null`-element `arguments`/closure-arg carriers, breaking ~120 modules
and breaching the #2097 floor by −116). So `fillExternGetIdxVecArms` skipped the
canonical externref carrier; the OUTER `__extern_get_idx(canonVec, i)` fell
through to the `$ObjVec`-only path, failed `ref.test objVecTypeIdx` (a canonical
`$Vec` is not an `$ObjVec`), and returned null → the pair was lost → every tuple
field defaulted to 0. `Object.entries` works because it returns the pairs in an
`$ObjVec`-of-`$ObjVec` directly, which DOES hit the `$ObjVec` arm.

## RESOLUTION (2026-06-18 PM, sdev-iter) — both defects fixed, NOT architect-scale

Two narrow, type-safe, additive codegen changes:

1. **Defect B (load-bearing)** — `boxVecElementToExternref` (object-runtime.ts):
   return `[]` (identity pass-through) when the carrier's `arrDef.element.kind`
   is **exactly `externref`** — the loaded element already satisfies the helper's
   `externref` return, no boxing. Keyed on the real `arrDef.element`, NEVER the
   `"externref"` vecTypeMap key (the #2190 / [[reference_vec_externref_key_not_uniform]]
   trap). The dangerous `ref`/`ref_null` carriers stay `null` (skipped), so the
   exact regression the round-2 note hardened against cannot recur. This adds one
   `ref.test`-gated arm to `__extern_get_idx`; user-code codegen is byte-identical.
2. **Defect A** — `buildVecFromExternref`'s tuple-struct inner read
   (type-coercion.ts): read each pair field with `__extern_get_idx` (f64 index)
   under `useNativeObjVec`, mirroring the outer loop, instead of the string-keyed
   `__extern_get`.

**Verified:** `[...a.entries()]` → `e[0][0]=0,e[0][1]=10,e[1][0]=1,e[1][1]=20`
(all correct), for-of over the spread result yields the pairs, zero host imports.
Plain `[...arr]` / nested spread WAT byte-identical to HEAD; `[a,b]=[1,2]` user
codegen byte-identical (only the shared helper gains one gated arm). Non-regressing
on every #2190 floor-risk carrier probed (rest params, array-rest destructure,
generator spread, nested spread, closure-capture arg, any-index) — `rest params`
THROWs on HEAD too (pre-existing). IR-fallback gate OK. Dedicated test:
`tests/issue-2162b-array-entries-spread.test.ts` (6/6).

**Scope landed:** the array-spread form `[...a.entries()]` (and for-of over its
result). **Still out of scope / separate bugs:**

- `Array.from(a.entries())` VFAILs with `invalid struct index: NN` inside the
  `__iterator` driver — a distinct `Array.from` iterator-driver type-registration
  bug, NOT this consumer pair-read path (my fix is in the spread coercion, which
  `Array.from` does not route through). Tracked separately.
- `[...m.entries()]` / bare `[...map]` VFAIL on the **Map**-iterator producer
  (`invalid struct index` in `__iterator`; `i32.add … found struct.get`) — the
  Map-iterator slice (#2162 / task #8).

---

## Original (DISPROVEN) Implementation Plan — kept for context only

The breakage crosses THREE interacting sites. The load-bearing one is (3); the
(1)+(2) PR-A above turned out NOT to close the spread cases (see CORRECTION).

### (1) `src/codegen/literals.ts` `compileArrayLiteral` — element-type heuristic

For a spread-first-element, force the **result vec element type to externref**
when the spread source is a pair source — `isPairSpreadSource(spreadType)`:

- `spreadType.symbol?.name === "Map"` (bare `[...map]` → `[k,v]` pairs §24.1.3.\*), OR
- name matches `/Iterator$/` (`ArrayIterator`/`MapIterator`/`SetIterator`) AND its
  first type-arg is a TUPLE (`isTupleTypeArg`) — i.e. `.entries()`, not
  `.keys()`/`.values()` (those stay scalar). Discriminators confirmed via the
  checker (`ArrayIterator`/`MapIterator` + `objectFlags & Reference`, target
  `objectFlags & Tuple`).
  The pair element is an externref `$ObjVec`, so an f64/i32 backing array can't hold
  it. Scalar iterators keep their numeric result type and #2162a's per-element
  fill-loop coerce handles them — UNCHANGED.

### (2) `compileArrayLiteral` spread loop — route bare `[...map]`

Extend #2162a's Set branch: a bare `Map` subject routes through
`emitCollectionIteratorVec(ctx, fctx, el.expression, "entries", /*isSet*/ false)`
(the same for-of driver, which already builds `$ObjVec` pairs via
`ensureObjVecBuilders`). It returns a canonical externref `$Vec`; the fill loop
consumes it (externref→externref no-op coerce, now that result elem is externref
from (1)).

### (3) `src/codegen/type-coercion.ts` `buildTupleFromIterableFallback` (~L374) — THE load-bearing change

This is the `__tup_mat_*` path. It currently:

- materializes the externref via **`__array_from_iter`** (a HOST import — the
  `env.__array_from_iter` leak in bare `[...map]`), then
- reads each field by `__extern_get_idx` + per-field `__unbox_number`.

For the **spread fill** path the source vec is already a WasmGC `$Vec` of
externref pairs (from (2)) — so the array-literal Step-3 fill loop must copy the
pair externref DIRECTLY into the externref result array (no per-field unbox, no
`__array_from_iter`). The `__tup_mat_*` tuple-struct build is the
DESTRUCTURING path (`const [a,b] = pairExternref` — e.g. `for (const [k,v] of
[...map])`). There, when the source resolves to a native collection, route it
through `emitCollectionIteratorVec` FIRST (standalone-native, zero host import),
THEN destructure the resulting `$Vec` via the existing typed-vec
`buildTupleFromExternref` branch — NOT the `__array_from_iter` fallback. Gate the
`__array_from_iter` fallback behind `!noJsHost(ctx)` so standalone never emits it
(falls to `ref.null` → the existing destructure guard throws the spec TypeError,
which is at least valid Wasm and host-import-free).

### (4) Nested `a[0][1]` pair read

Reading `pair[1]` off an externref `$ObjVec` already works in standalone via the
`__extern_get_idx` arm (verified: `[...set][0]` reads correctly in #2162a). For
a pair the inner index read is the same arm; confirm it stays host-import-free
for the entries case (it should, since `$ObjVec` is a WasmGC struct).

## PR split (tight, to bound the high-regression blast radius)

`buildTupleFromExternref`/`__tup_mat_*` backs ALL tuple/`[k,v]` spreads &
destructuring, so split:

- **PR-A** — (1)+(2): force-externref + bare-`[...map]` routing in `literals.ts`
  only. Closes `[...arr.entries()]`/`[...map.entries()]`/`[...map]` SPREAD into a
  variable + nested index. Does NOT touch type-coercion.ts. Lowest blast radius;
  ship + measure first.
- **PR-B** — (3): the `type-coercion.ts` `__tup_mat_*` host-leak removal +
  native-collection destructure routing. Higher blast radius (destructuring of
  ALL iterables). Ship only after PR-A is green on the shard.

## Regression-guard strategy (REQUIRED gate, run before AND after each PR)

- Full local suites: `tests/{issue-2169-*,issue-2151-spread-literal,
issue-2162-collection-from-array,basic-destructuring,array-rest-destructuring,
for-of-array-destructuring,for-of-generator,issue-2079,issue-2172,issue-42-*}`.
- **WAT-diff a plain `[a,b]=[1,2]` tuple destructure + a plain `[...arr]`** (no
  pairs) — confirm NON-pair tuples/spreads are byte-identical (the change must be
  gated strictly on pair sources / native collections).
- `pnpm run check:ir-fallbacks` OK. Hard floor-gate the standalone HW shard
  (no breach of 20,803).
- Helpers BY NAME (#2191 lesson — never index a funcIdx captured before a later
  import-adding phase).

## Source

Root-caused in the #2162b investigation (2026-06-18, sdev-iter); spec written by
sdev-iter per tech-lead direction (own-lane, zero collision). Implement PR-A then
PR-B from this spec.
