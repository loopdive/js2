---
name: project_standalone_hostimport_gate_index_shift
description: "Gating which lib globals register as host imports under standalone (collectReferencedGlobalNames,"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

PR #1787 (#2520) added `collectReferencedGlobalNames` in `src/codegen/index.ts`, gating ambient `declare function` lib-global host-import registration to referenced names — but ONLY under wasi/standalone. That gating reorders the import/type table under standalone, so a host-import constructor (e.g. `__new_Test262Error`) ends up bound to the WRONG type index. Result: the constructor `call` has the wrong static result type, and a `throw new Foo()` (which needs externref) sees an i64-result call → invalid Wasm: `throw[0] expected type externref, found call of type i64`. It hit ~133 standalone tests (132 DataView, which throw RangeError/TypeError from inside valueOf/toString closures) = −84 on the floor.

This is the classic late-import index-shift hazard (CLAUDE.md: "addUnionImports shifts function indices"). Symptom signature: a standalone-only `pass→compile_error` cluster concentrated in one builtin family, all with `found call of type i64` (or similar wrong-type at a throw/call).

**Why:** changing which/whether host imports register, or their ordering, desyncs every downstream func/type index unless ALL references are shifted in lockstep.
**How to apply:** Any change touching `collectExternDeclarations` / `collectReferencedGlobalNames` / host-import registration MUST be validated on the STANDALONE lane, not just gc — and the floor only catches it at merge_group (see [[project_standalone_floor_only_on_merge_group]]). Fix direction: keep the import/type table byte-stable across the gate, or shift all dependent indices. Note #1774 (#2503b loose-eq) and #1798 (#2551 numeric-key trunc) were NET-POSITIVE on standalone and clean — not the regressor.
