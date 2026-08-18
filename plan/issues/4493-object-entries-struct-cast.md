---
id: 4493
title: "Object.entries over a struct-typed record throws RuntimeError: illegal cast on the host round-trip"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: correctness
loc-budget-allow:
  - src/codegen/declarations.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
---

# #4493 — `Object.entries` struct round-trip: `illegal cast` at runtime

Found by the #4451 investigation (recorded in that issue's Results as an open
finding, pre-existing — reproduced on the compiler BEFORE the #4451 fix, so
not caused by it): once #4451 made the module VALID, the interface-typed
variant of its repro trips a runtime `RuntimeError: illegal cast`
(`WebAssembly.Exception`) in the host round-trip of a WasmGC struct through
`Object.entries`. Reproducible with **no callback at all**:

```ts
interface ExportSignature { arity: number; }
const sigs: Record<string, ExportSignature> = { a: { arity: 1 }, b: { arity: 2 } };
for (const [name, sig] of Object.entries(sigs)) {
  // touching `sig.arity` (or even just iterating) throws illegal cast
}
```

Mechanism sketch (verify, don't trust): `Object.entries` is serviced by the
host; the record's VALUES are WasmGC structs that get boxed to `externref`
for the host, and the tuple/element rebuild on the way back
(`buildTupleFromExternref` / the vec arms in `src/codegen/type-coercion.ts`)
`ref.cast`s the value back to the declared struct type. Something in that
round-trip presents the wrong carrier — either the outbound boxing loses the
GC identity (e.g. structs materialized into a host object become plain JS
objects, which can never cast back), or the inbound arm casts against the
wrong type index.

## Implementation Plan (Fable, 2026-08-15)

1. **Reproduce first**: the snippet above via `compileAndInstantiate`
   (harness pattern:
   `/home/user/js2wasm/.claude/worktrees/selfhost-baseline/.tmp/run-repro.mts`).
   Confirm `illegal cast`, and capture the WAT of the failing function to see
   WHICH cast fires (target type index + producing instruction).
2. **Decide which side is wrong** — this is the fork in the road, and it is a
   SEMANTIC decision, not just a codegen one:
   - If the host materializes struct values into plain JS objects (identity
     lost), then casting back is impossible BY CONSTRUCTION and the fix is on
     the consumer side: the rebuilt tuple's value slot must be treated as a
     host object (externref + dynamic property access), not re-cast to the
     struct. Follow how `Object.entries` results are TYPED by the checker
     lowering (grep the `Object.entries` handling in `src/codegen/` and the
     oracle's answer for the element type) — the element type decision is
     where the fix belongs.
   - If the host preserves the externref identity of the boxed struct
     end-to-end, the cast should succeed and the bug is a wrong type index in
     the rebuild arm — fix the index derivation.
3. **Check the sibling surfaces** once root-caused: `Object.values`,
   `Object.keys` (safe — strings), `for-in` over the same record, and the
   `#4451` interface-slot repro (its runtime-value assertion had to use the
   array-typed slot because of this bug — flip it to interface-typed as the
   regression test once fixed).
4. **Dual-mode**: verify what standalone mode does on the same snippet — if
   it has its own entries lowering that works, do not disturb it; if it
   shares the broken path, fix must cover both or explicitly scope to host
   with a documented standalone follow-up.
5. **Tests** (`tests/issue-4493*.test.ts`): the snippet above computing a
   value through `sig.<field>` (assert the right number, not just no-throw);
   an `Object.values` twin; and the #4451 interface-slot variant. A/B each
   against unpatched HEAD (must throw before, pass after).
6. **Scope guard**: if the root cause turns out to be the generic
   "structs lose identity across ANY host boundary" architecture issue
   (bigger than entries), STOP after root-causing, write Findings with the
   evidence, and leave status in-progress — that variant needs an
   architecture decision (it borders the value-representation goal), not a
   spot fix.

## Acceptance criteria

- [x] Root cause documented: which cast, which side of the round-trip, and
      why.
- [x] The repro computes correct values (or a documented STOP with findings
      if it is the architecture-level identity issue).
- [x] Sibling surfaces checked and covered by tests where fixed.
- [x] Typecheck + gates green; A/B'd collateral on coercion/tuple suites.

## Results

### Which cast, which side — and why the plan's fork is answered "neither"

**GC identity SURVIVES the host round-trip**, so the scope guard's
architecture-level variant is ruled out by construction. The record is
materialized as a WasmGC struct, handed to `__object_entries` as an
`externref`, and the host enumerates it through the data-struct bridge
(`__is_data_struct` / `__struct_field_names` / `__sget_<key>`); `__sget_a`
returns `extern.convert_any(struct.get …)`, i.e. the SAME GC object.

The plan's second branch — "the rebuild arm casts against a wrong type index"
— is half right and misleadingly framed. The index the consumer casts to is
**correct for the declared type**; the *value* carries a different one. Both
sides are locally right, and the defect is upstream of both: **one declared
shape was lowered to TWO WasmGC struct types.**

TypeScript gives a nested object literal its own fresh anonymous type even
under a contextual named type — in
`const sigs: Record<string, ExportSignature> = { a: { arity: 1 } }`, property
`a` is typed as the fresh `{ arity: number }`, not as `ExportSignature`.
`ensureStructForType` (`src/codegen/index.ts`) deduped that only against other
ANONYMOUS shapes (`ctx.anonStructHash`), so the module carried both:

```wat
(type $ExportSignature (struct (field $arity (mut f64))))
(type $__anon_0         (struct (field $arity (mut f64)) (field $$shapeBrand (ref null 0))))
```

That was invisible for as long as WasmGC canonicalization merged them —
identical layouts are ONE runtime type, so every `ref.test`/`ref.cast` matched
by structural luck. The **#2853 shape-branding pass** then appended the
`$shapeBrand` field to the `__anon_0` half (it "collides" with
`$ExportSignature` under `shallowStructKey`, which deliberately ignores field
names), making the two nominally distinct — and every consumer typed by the
DECLARED name started failing.

The concrete cast, from the WAT of the repro's `$main`: the destructured
`sig` slot lowers to

```wat
(if (result (ref null $ExportSignature))
  (ref.test (ref $ExportSignature) (any.convert_extern <entry value>))
  (then (ref.cast (ref null $ExportSignature) …))
  (else (ref.null none)))          ;; ← taken: the value is $__anon_0
```

so `sig` is null and `sig.arity` throws `TypeError: Cannot access property on
null or undefined` (as a `WebAssembly.Exception` on tag `$tag$0`). Where the
same value flows through an UNGUARDED `ref.cast` — #4451's `.sort(…)`
comparator, whose tuple slot is rebuilt by `buildTupleFromExternref` — the
identical mismatch surfaces as the `RuntimeError: illegal cast` in this
issue's title.

**`Object.entries` is only the loudest surface, not the defect.** Measured
with `.tmp/matrix.mts`, A/B by swapping the changed files against
`git show HEAD:`:

| surface | before | after |
| --- | --- | --- |
| `sigs.a.arity` (member read) | OK 3 | OK 3 |
| `take(sigs.b)` — interface-typed **parameter** | **RuntimeError: dereferencing a null pointer** | OK 1 |
| `const s: ExportSignature = sigs.a` | **WebAssembly.Exception** | OK 1 |
| `for (const [n, sig] of Object.entries(sigs))` | **WebAssembly.Exception** | OK 5 |
| `for (const v of Object.values(sigs))` | OK 3 | OK 3 |
| `for (const k of Object.keys(sigs))` | OK 2 | OK 2 |
| `for (const k in sigs)` | OK 3 | OK 3 |
| `Object.entries(sigs).sort(([l],[r]) => …)` | **RuntimeError: illegal cast** | see residual below |
| `const arr: ExportSignature[] = [{…}]` | OK 3 | OK 3 |

Two of the four broken surfaces involve **no host round-trip at all**, which
is what ruled the entries lowering out as the fix site.

### The fix

`publishDeclaredShapesForDedup` in
`src/codegen/declarations/struct-type-registration.ts` (+58 lines, mostly the
rationale comment), called from `collectDeclarations`
(`src/codegen/declarations.ts`, +7) right after `resolveStructFieldTypes`, plus
one word in `src/codegen/index.ts` (`fieldsHashKey` exported).

It publishes every user-declared STRUCTURAL shape — interfaces and object type
aliases from non-`.d.ts` source — into the existing anonymous-struct dedup
index `ctx.anonStructHash`, keyed by the same `fieldsHashKey` (field names +
wasm types + brands). An identically-shaped object literal then reuses the
declared struct instead of minting `__anon_N`. All three consumers of that map
(`ensureStructForType`, `ir/integration.ts`, `ir/prepared-closure-support.ts`)
resolve a name → `structMap`, so none of them needed changing.

Scope guards: classes are excluded (nominal — subtyping, methods,
`instanceof`), compiler carriers (`__Date`, vec/arr, tuples, iterator records)
are never published because only `collectInterface`/`collectObjectType` shapes
are, empty shapes are skipped (they would swallow every `{}`), and an existing
key is never overwritten so declaration order decides ties. It runs after
`resolveStructFieldTypes` because that pass's externref → `ref $Struct`
re-resolution changes the very field types the key is built from.

This also makes the nested case behave exactly like the directly-annotated
one, which already resolved to the declared struct
(`const s: ExportSignature = { arity: 5 }` → `struct.new $ExportSignature`,
verified in the WAT).

### Rejected: refining the shape-brand pass

The first cut was in `src/codegen/shape-brand.ts` — skip branding a shape when
every same-layout partner carries the identical field-NAME sequence (the case
where keyed dispatch, the only thing the brand protects, is already exact). It
fixed all four broken surfaces and kept `tests/issue-2853.test.ts` green, but
it has a hole a one-line probe finds: a shape must be branded apart from any
same-layout DIFFERENTLY-keyed shape, so **one unrelated literal** anywhere in
the module re-separates the exempted `__anon_N` from its declared twin.
Measured — adding `const other = { beforeExpr: 7 };` to the repro put it
straight back to `WebAssembly.Exception`, while the shipped fix returns
`"a1b2|7"`. Reverted; the duplicate type is the defect, not the brand. Both
cases are pinned as tests.

### Dual-mode

The defect and the fix are **target-independent** — the fix sits in shared
front-end type registration (`collectDeclarations`), above both the WasmGC and
linear backends and above the host/standalone split. A/B'd on the entries
repro (`.tmp/standalone.mts`); all three compile and validate on both sides,
so the only difference is the run:

| target | before | after |
| --- | --- | --- |
| `{}` (gc host) | `WebAssembly.Exception` | 5 |
| `{ target: "standalone" }` | `WebAssembly.Exception` | 5 |
| `{ target: "wasi" }` | `WebAssembly.Exception` | 5 |

No standalone follow-up is needed.

### Residual (separate, pre-existing, NOT this issue)

A comparator with DESTRUCTURED parameters dispatched through the host callback
wrapper receives `null` for its tuple slots:
`Object.entries(r).sort(([l], [q]) => l.localeCompare(q))` throws
`TypeError: Cannot read properties of null (reading 'localeCompare')`. A/B'd on
unpatched HEAD for `Record<string, string>`, `Record<string, number>` and
`Record<string, number[]>` — **identical failure for every value type**, so it
is independent of this fix and of the value type. This fix moves the
interface-typed variant off `illegal cast` and onto that same pre-existing
path (#4451's array-slot test passes for the same reason: its record is
declared already sorted, so the no-op sort is unobservable). Not filed as its
own issue here — it belongs with the `__cb_N` tuple-parameter work.

### Tests

`tests/issue-4493-object-entries-struct-cast.test.ts` — 7 tests, ~17 s:
the entries repro computing `5`; an `Object.values` twin; an
`Object.keys` + `for-in` negative control; the interface-typed parameter and
local; the same-layout differently-keyed collision that sank the brand-pass
fix; a non-aliasing guard that #2853 bug A stays fixed; and #4451's
interface-slot construct, which the plan asked to flip to a runtime assertion
— it now returns `"bBaA"`.

A/B: **5 of the 7 fail on unpatched HEAD** (the two that pass are the
already-correct negative controls), including `RuntimeError: illegal cast`
raised from `__cb_1` on the #4451 variant. All 7 pass after.

The stale note in `tests/issue-4451-cb-tuple-struct-f64.test.ts` that
described this defect as open was updated to point here.

### Collateral

- `pnpm run typecheck` exit 0. `npx biome lint src tests scripts
  --diagnostic-level=error` clean; prettier clean on all changed files.
- `tests/issue-2853.test.ts` 4/4 and
  `tests/issue-4451-cb-tuple-struct-f64.test.ts` 4/4 pass — the two suites
  this change is most likely to disturb (shape branding, and the
  entries/tuple round-trip whose coercion matrix #4451 repaired).
- `node scripts/equivalence-gate.mjs` run on BOTH sides: **byte-identical
  verdicts** — `24 failing, 1661 passing, 36 known-failures in baseline`,
  `✓ No new equivalence regressions`, and the same 12 baseline entries
  reported as newly passing. Those 12 are pre-existing branch/main drift, not
  produced here; the baseline is deliberately left un-ratcheted (post-merge
  job).
- Gates green: `check:oracle-ratchet` (no raw `checker.*` added — the new pass
  reads `ctx.structFields`, not the checker), `check:any-box-sites`,
  `check:coercion-sites`, `check:stack-balance`, `check:dead-exports`.
- `check:loc-budget` (`src/codegen/declarations.ts` 3517 → 3524) and
  `check:func-budget` (`collectDeclarations` 1388 → 1394) are this change's own
  call-site growth and are granted in this file's frontmatter.
- `check:godfiles` A/B'd: **11 regressions, identical list before and after**
  (`expressions/calls.ts`, `object-runtime.ts`, `array-methods.ts`,
  `native-strings.ts`, and `index.ts` functions this change does not touch) —
  the same pre-existing drift #4451 recorded.
