---
name: project_type_index_shift_and_deadelim
description: Type-index (not funcIdx) hazards — dead-elimination prunes+remaps unreferenced WasmGC types; registering a struct type mid-class-collection desyncs class struct typeidx
metadata: 
  node_type: memory
  type: project
  originSessionId: 3ace5709-7f99-4941-9309-3687c91e42eb
---

The funcIdx late-shift hazards ([[project_standalone_emit_layer_bug_classes]],
[[project_addunionimports_late_shift_hazard]]) have a **type-index** sibling
worth treating as its own class (learned implementing #2158 P0 `$ClassMeta`,
2026-06-17):

1. **`src/codegen/dead-elimination.ts` prunes AND renumbers unreferenced types.**
   It is a "Dead import and type elimination pass" that scans function bodies,
   globals (incl. `g.type` valtype, ~L241), exports, elements, tags for
   referenced type indices, drops the rest, and remaps survivors. So a struct
   type you `ctx.mod.types.push(...)` but never reference (no `struct.new`/
   `struct.get`/`ref.cast`/`ref.test`/`(ref $T)`-typed global/local) is **pruned
   from the output** — it won't appear in the emitted wat even though it's in
   `ctx.mod.types` during codegen. To keep a speculatively-registered type alive,
   give it a real reference (e.g. type a global `(ref null $T)` not `externref` —
   the pass reads global valtypes). This is harmless if nothing references the
   stale cached idx (codegen ran before the pass, which remaps instructions too),
   but it means "register a type now, reference it later in a follow-up phase" is
   unsound across the pass boundary unless the type is referenced.

2. **Do NOT push a new type into `ctx.mod.types` mid-class-collection.** Class
   struct types use a placeholder→fill pattern (`collectClassDeclaration` in
   `src/codegen/class-bodies.ts`: push `placeholderDef`, later overwrite at the
   resolved index). Inserting an unrelated type (e.g. a shared `$ClassMeta`)
   between a placeholder's registration and its fill — or between sibling
   classes — shifts the class struct-type indices, so `struct.get`/`struct.new`
   typeidx already baked into earlier class method bodies point at the wrong
   type: verified as `struct.get expected (ref null 16), found (ref null 10)`
   across ~24 class tests. **Fix:** register shared/singleton struct types ONCE
   at a stable point AFTER all class struct types are final (the object-runtime
   helpers do exactly this — `ensureObjectRuntime` registers its `$Object`/etc.
   late, never interleaved with class collection). For #2158, P0 reserves only a
   per-class externref global slot; `ensureClassMetaType(ctx)` is called by the
   first P1 reader, not in the collection loop.

Rule of thumb: type indices are as shift-sensitive as funcIdx. Register shared
types late and once; reference any type you want to survive dead-elimination.
