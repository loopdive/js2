---
id: 904
title: "Add link-time specialization after separate compilation"
status: ready
created: 2026-04-02
updated: 2026-07-17
priority: high
feasibility: hard
reasoning_effort: max
goal: performance
sprint: Backlog
depends_on: [33, 743]
files:
  src/link/:
    modify:
      - "Resolve imported functions/globals to concrete definitions and expose enough information for post-link specialization"
  src/codegen/index.ts:
    modify:
      - "Support late specialization/devirtualization once linked callees are known"
  src/compiler.ts:
    modify:
      - "Preserve type/signature metadata needed by the linker or post-link optimizer"
---

# #904 -- Add link-time specialization after separate compilation

## Problem

Separate compilation hides information temporarily, but the final linked program often becomes closed-world again.

Today that means the compiler may be forced into conservative import/interface paths during compilation even when the linker later knows:

- the concrete callee
- the concrete type/signature
- the concrete object/layout contract

Without a post-link specialization step, that information is lost and the final program stays slower than necessary.

## Goal

Teach the js2wasm toolchain to recover specialization once separately compiled modules are linked.

## Approach

After relocatable objects are linked:

1. resolve imported functions/globals to known definitions
2. propagate concrete signatures across module boundaries
3. remove interface checks that are no longer needed
4. devirtualize/import-direct calls where possible
5. enable post-link monomorphization / inlining / dead-wrapper removal

## Examples

- A module imports `add(x, y)` through a generic interface, but after linking the callee is known to be pure `f64 -> f64 -> f64`
- A property helper import becomes unnecessary because the linked object shape is closed and known
- A conservative import/export wrapper can be removed once both sides are known statically

### Concrete code example

`math.ts`

```ts
export function add(x: number, y: number): number {
  return x + y;
}
```

`main.ts`

```ts
import { add } from "./math";

export function run(): number {
  return add(40, 2);
}
```

If these files are compiled separately, `main.ts` may initially have to call `add`
through an imported/generic interface because the callee body is not yet present in
the local compilation unit.

After linking, the toolchain now knows:

- `add` resolves to the concrete definition from `math.ts`
- both arguments are `number`
- the return type is `number`
- the callee body is a direct numeric `x + y`

So the post-link specialization pass should be able to collapse the boundary from:

```text
main -> imported/generic add wrapper -> concrete add
```

to something materially closer to:

```text
main -> direct typed call to add
```

or, if heuristics allow:

```text
main -> inlined f64.add
```

The key point is that separate compilation should only delay specialization, not
prevent the final linked program from recovering the same direct numeric path as
single-shot compilation.

### JavaScript example

`math.js`

```js
export function twice(x) {
  return x * 2;
}
```

`main.js`

```js
import { twice } from "./math.js";

export function run() {
  return twice(21);
}
```

At per-file compile time, `main.js` may not have enough local information to assume
that `twice` is always the numeric `x * 2` function from `math.js`.

After linking, the toolchain can see the full closed-world program:

- `twice` resolves to the one concrete exported definition in `math.js`
- the reachable call site passes a numeric literal
- the callee body is a direct numeric multiply

So the linked result should be able to recover a specialized path such as:

```text
run -> direct typed call to twice
```

instead of being permanently stuck behind a generic imported-function boundary just
because the source started life as separate `.js` files.

## Acceptance criteria

- the linker or post-link optimizer can specialize across previously imported boundaries
- separate compilation no longer permanently forces conservative runtime checks where linked information is concrete
- linked closed-world programs recover direct call paths materially closer to single-shot compilation

## Implementation Plan (Reviewed: Fable, 2026-07-17 — supersedes 2026-05-21 Opus draft)

### Review findings (what changed and why)

The 2026-05-21 draft predates two months of churn and made four assumptions
that are now stale. Reviewed for consistency with the fresh #1046 architecture
spec (2026-07-17) and verified against current `origin/main`:

1. **`src/link/` now EXISTS (from #33, which is DONE) — and it changes the
   whole model.** The draft proposed `src/link/specialize.ts` as if `src/link/`
   were greenfield. In fact #33 shipped a real relocatable-object linker:
   `link(objects: Map<string, Uint8Array>, opts): LinkResult`
   (`src/link/linker.ts:66`), `resolveSymbols(parsed): Resolution`
   (`src/link/resolver.ts:36`), object reader (`src/link/reader.ts`), isolation
   validation (`src/link/isolation.ts`), and the `.o` emitter
   `emitObject(mod)` (`src/emit/object.ts:45`). **`link()` merges `.o` files into
   ONE wasm module** (multi-memory), remapping every func/type/global index by a
   per-module offset (`linker.ts:245/303/593`). This is the "closed-world after
   linking" model the issue's Problem section actually describes — so #904's home
   is the EXISTING `link()` pipeline, not a hypothetical `.widl`-driven stage.

2. **The WasmGC type-identity risk is REFRAMED, not as the draft framed it.**
   The draft's "Phase 1 trampolines / Phase 2 Binaryen `wasm-merge`" is stale on
   both ends: we do not use Binaryen `wasm-merge` (we have our own `src/link/`),
   and runtime trampolines are only relevant to the SEPARATE-INSTANCE model
   (#1046 host linking with disjoint type sections). For the object-file-merge
   model, `link()` already puts everything in ONE module — the real gap is that
   it **concatenates type sections with offset remapping and does NOT dedup/
   canonicalize them** (verified: no dedup in `linker.ts`). Two `.o`s that both
   define a structurally identical `$NativeString` get two distinct type indices,
   so a value of one crossing into a function expecting the other fails
   `ref.cast`. **The concrete enabling work is type-section canonicalization/
   dedup in `link()`**, not trampolines or an external merger.

3. **Post-link there is no `ts.Program` / checker — the draft's "re-run #743
   type-flow post-link" is an architectural hole.** #743 is an AST/checker-level
   analysis; the merged linker output is pure Wasm with no `ts.Type` and no
   `ctx.oracle`. Feeding "resolved definitions into #743's type-flow" post-link
   is not implementable as written. Specialization therefore splits into two
   passes at two different layers (see below): oracle-driven monomorphization
   BEFORE object emission, and pure-Wasm devirtualization AFTER link.

4. **The boundary value-rep ABI is actively in flux (#745, #2773 — both
   in-progress, sprint current).** The draft hardcodes an
   `extern.convert_any` / `ref.cast` externref-boxing boundary wrapper. #745
   (tagged-union representation to replace externref boxing) and #2773 (value-rep
   substrate: reconstructed-struct field access + finalize-stable typeIdx) are
   changing exactly that boundary representation and the stability of type
   indices the linker relies on. #904 must NOT bake in the externref-boxing
   wrapper shape; express the boundary through whatever value-rep substrate #745/
   #2773 land, and sequence #904 after they stabilize.

Net verdict: **plan revised** — same goal and acceptance criteria, but re-homed
onto #33's real `src/link/` linker, risk re-framed to type-section dedup,
specialization split across the oracle boundary, and the value-rep ABI
dependency made explicit.

### Two linking models — pick the right one for specialization

- **(A) Object-file merge** (`src/link/link()`, from #33): build-time, produces
  ONE closed-world wasm module. **This is #904's primary target** — all callees
  become concrete local functions, so devirtualization is a pure intra-module
  Wasm rewrite. The issue's own examples (`math.ts`+`main.ts` → direct
  `call $add`) are exactly this.
- **(B) Host multi-instance link** (#1046 Slice 1, `.widl` + separate `.wasm`
  instances, scalar/externref boundaries): runtime linking across disjoint type
  sections. Specialization here is limited to what the scalar/externref boundary
  already expresses; deep cross-instance devirt needs model (A). #904 should treat
  (B) as out of primary scope and only ensure it degrades gracefully.

### Prerequisite that neither #1046 nor #904 has yet: wire the emit-`.o` → `link()` pipeline into the driver

`emitObject` and `link()` exist but are **not invoked from `compile` /
`compileProject` / `compileMultiSource`** today (verified: no `link(` caller in
`src/index.ts` / `src/compiler.ts`). Before #904 has anything to specialize,
someone must wire a driver path: compile each unit → `emitObject` → `link()` →
final module. This wiring is shared with #1046 and should land there (or in a
joint slice); #904 assumes it exists.

### Entry point (corrected seam)

New module `src/link/specialize.ts` exporting
`postLinkSpecialize(parsed: ParsedObject[], resolution: Resolution, offsets):
{ rewrites }`. Hook it INTO the existing `link()` pipeline in
`src/link/linker.ts` — **after `resolveSymbols` (`linker.ts:96`) and before the
final `WasmEncoder` emit** — consuming the linker's own `Resolution` (concrete
symbol targets) and `ParsedObject[]`, NOT re-deriving edges from `.widl`. The
`.widl` (#1046) is for model (B) resolution; model (A) already has `Resolution`.

### Algorithm — two passes across the oracle boundary

**Pass 1 — pre-emit monomorphization (oracle-driven, at codegen, DELEGATE to
#773).** Where the producer export is generic/union-typed and the consumer's
call-site pins concrete types, emit a specialized `_spec_<key>` variant by
running #773's monomorphization codegen with `ctx.typeParams = pin`. Type
queries route through `ctx.oracle` (`src/checker/oracle.ts`), never raw
`checker.getTypeAtLocation` (oracle-ratchet #1930/#3273). Record the variant in
the `.o` symbol table (and #1046's `.widl` `specializations[]`). **Do not build a
second specializer** — this is #773 applied at the module boundary, same as
#1046 Slice 4; #904 and #1046-Slice-4 share the specialization-key + variant-emit
helper.

**Pass 2 — post-link devirtualization (pure Wasm, no oracle).** On the merged
module, using `Resolution`:

1. Collect import/call edges from the reloc + symbol tables.
2. Replace `call_indirect` with `call $resolved` when the target is a single
   statically-proven funcref.
3. Replace a boundary wrapper `call $import_wrapper` with `call $direct_target`
   when the wrapper is identity-by-types (both sides now the SAME type index —
   requires the type-section dedup from finding #2).
4. Delete now-redundant boundary conversion wrappers (only once #745/#2773 pin
   the boundary rep — do not assume `extern.convert_any`/`ref.cast` shape).
5. Re-emit through the existing peephole pass (`src/codegen/peephole.ts`) +
   optional Binaryen `wasm-opt -O3` (`src/optimize.ts`) to inline the direct
   calls.

### Type-section canonicalization (the real Phase-1 work — replaces "trampolines")

Add structural type dedup to `link()` (or a pre-pass): canonicalize identical
rec-groups/struct/array types across the merged `.o`s to a single type index,
rewriting all references. This is what actually unblocks cross-module typed-ref
sharing in model (A). Must stay consistent with #2773's finalize-stable typeIdx
work — coordinate so the linker's canonicalization and the codegen's typeIdx
finalization agree. Fallback when dedup can't prove identity: keep the boundary
value at the shared supertype (externref today; the #745 tagged union tomorrow).

### Edge cases

- **Dynamic dispatch through external references** — devirt only when
  single-target proven; preserve indirection when polymorphic.
- **Recursive / circular imports** — SCC analysis; specialize within each SCC.
  (Model (A)'s single-module merge already tolerates cycles that model (B)'s
  instance-init order cannot.)
- **Versioned producer** — `.widl`/`.o` `schemaVersion` mismatch aborts
  specialization → conservative link (correctness before performance).
- **Concrete-type identity across modules** — resolved by the type-section dedup
  above for model (A); model (B) falls back to the shared boundary rep.
- **Globals** — same dataflow as functions; the linker already remaps global
  indices (`globalOffset`), so track resolved global values through `Resolution`.

### Test plan

- `tests/issue-904-link-specialize.test.ts`:
  - `emitObject` for `math.ts` (`add: (number, number) → number`) and `main.ts`
    (import + call), `link()` them, run `postLinkSpecialize`, assert the merged
    wasm contains a direct `(call $add)` — not a `call_indirect` / boundary
    wrapper — and that the two `$NativeString`/struct types (if any) deduped to
    one index.
  - Generic producer + monomorphic consumer pin → asserts a `_spec_<key>`
    variant is bound (Pass 1), shared with the #1046 Slice-4 harness.
  - `schemaVersion` mismatch → graceful conservative link.

### Dependencies (corrected)

- **#33 — DONE.** The relocatable-object linker (`src/link/`) is the substrate
  #904 builds on, not an unknown "honour the ordering" dep. Re-home the plan here.
- **#1046** — separate compile + `.widl` (Fable-specced 2026-07-17). Hard dep for
  model (B) resolution and for the emit-`.o`→`link()` driver wiring. Slice 4 of
  #1046 IS Pass 1 of this plan — coordinate to a single shared specializer.
- **#743** — whole-program type-flow (still Backlog). Hard dep for Pass 1's
  "which signatures are monomorphic" answer, at the AST/oracle layer.
- **#773** — monomorphize-with-call-site-types (still ready). Hard dep: Pass 1
  delegates to it. Do not duplicate.
- **#745 / #2773 (both in-progress, sprint current)** — value-rep substrate /
  tagged-union boundary ABI + finalize-stable typeIdx. Soft-but-blocking: #904's
  boundary wrapper elision and type-section dedup must be built against the
  post-#745/#2773 representation, not today's externref boxing. Sequence #904
  after these stabilize.

### Risks

- **Type-identity across modules** — mitigated by type-section dedup in `link()`
  (above), coordinated with #2773's finalize-stable typeIdx. NOT trampolines /
  Binaryen `wasm-merge`.
- **Oracle boundary** — Pass 1 (monomorphization) needs the checker/oracle and
  must run at codegen, pre-emit; Pass 2 (devirt) runs post-link on pure Wasm.
  Do not attempt AST-level type-flow post-link.
- **ABI drift under #745/#2773** — don't hardcode `extern.convert_any`/`ref.cast`
  boundary shapes; they are changing.
- **Code-bloat** — cap specializations per export at ~4 (beyond → generic
  variant), but manage the cap inside #773's monomorphization budget, not as a
  separate #904 knob.
