---
name: project_wrapforhost_setexports_harness
description: Promise-combinator / host-closure probes need setExports after instantiate or __is_closure is undefined
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

When hand-writing a `buildImports` + `WebAssembly.instantiate` probe in `.tmp/`
to exercise host-glue that dispatches through Wasm exports (`__is_closure`,
`__call_fn_*`, the Promise combinators' `_resolveCtor`), you MUST call
`imports.setExports(instance.exports)` after instantiation. `callbackState.getExports()`
returns `undefined` until `setExports` wires `wasmExports` (runtime.ts ~12420,
`compileAndInstantiate` does it for you). Without it, `__is_closure` is unreachable,
host closure-discrimination silently no-ops, and you get a false "body never ran" /
"not a closure" reading. Cost ~30 min on #1694.

Two-step `WebAssembly.compile(binary)` → `instantiate(mod, imports)` (not the
one-step `instantiate(binary, …)`) avoids a separate lazy-importObject race noted
in the #1694 issue. See [[project_standalone_emit_layer_bug_classes]].
