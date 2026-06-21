---
name: project_standalone_collections_arch
description: Standalone Map/Set native runtime architecture — Set reuses the Map backing store; 4 interception sites; any===literal confound
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Standalone (`nativeStrings`/`target standalone|wasi`) collections have a
Wasm-native runtime so they don't leak `Map_*`/`Set_*` host imports a pure-Wasm
engine can't satisfy.

- **Map**: `src/codegen/map-runtime.ts` (#1103a) — ordered WasmGC hash table
  (`$Map` struct, `$MapEntry`, bucket array), SameValueZero key equality,
  tombstone delete. Helpers `__map_new/get/set/has/delete/size/clear`.
- **Set**: `src/codegen/set-runtime.ts` (#2162) — **a Set is a Map with
  value===key**, so it REUSES the entire Map backing store. Only new code is
  `__set_add(m,v)=__map_set(m,v,v)`; has/delete/clear/size route to `__map_*`.
  A `Set`-typed binding resolves to `ref $Map`.

**Both are gated on `ctx.nativeStrings`** and wired at the SAME 4 sites — mirror
them for any new native collection:
1. `new X()` → `expressions/new-super.ts` (calls `__map_new`)
2. method call → `expressions/extern.ts` (dispatch by `className==="Map"/"Set"`)
3. `.size` → `property-access.ts`
4. type resolution `X → ref $Map` → `index.ts` `resolveWasmType`
Plus: **skip the externClass registration under `nativeStrings`** in
`registerBuiltinExternClasses` (index.ts) or it eagerly emits the host import.

**Confound that masks working collections**: standalone `m.get(k) === <literal>`
(or `s.has(v) === true`) FAILS not because the collection is broken but because
`any === literal` boxed-value comparison is itself broken (value-rep gap,
#2104/#2106). Always verify a collection by reading the result into a TYPED
binding (`const v: number = m.get(k)!`) — Map was already fully functional this
way; only Set lacked a runtime. See [[project_standalone_emit_layer_bug_classes]].

Follow-up slices (issue #2162 stays in-progress): Set iteration
(forEach/for-of/keys/values/entries/`new Set(iterable)`, needs `$MapIter`
drive), ES2025 set-algebra, and WeakMap/WeakSet (separate identity-key rep).
