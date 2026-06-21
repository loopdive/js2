---
id: 2525
title: "Component Model + WIT for host-API shims (declared-interface composition) — DEFERRED alternative to #2524"
status: backlog
sprint: Backlog
created: 2026-06-20
updated: 2026-06-20
priority: low
feasibility: hard
reasoning_effort: high
task_type: architecture
area: codegen
language_feature: component-model
goal: architecture
related: [2512, 2514, 2524, 2523]
---

## Proposal (deferred — see #2524 for the chosen core-wasm approach)

Express host-API dependencies and linking via the **WebAssembly Component Model**
and **WIT**, instead of (or alongside) core-wasm module linking (#2524).

A js2wasm output compiled as a **component** carries its imported/exported
interfaces — its *world* — as **WIT**, encoded in the standard `component-type`
**custom section**. That *is* the in-wasm, standardized declaration of "this
module depends on the Node process API":

```wit
world nm-host {
  import node:io/process;        // declared dependency, embedded in the .wasm
  export run: func();
}
```

- **Interface identity** = WIT package names `namespace:package/interface@version`
  (e.g. `node:io/process@0.2.0`) — the portable "interface URL".
- **Linking** = composition: `wac` / `wasm-tools compose` wires a user
  component's `import node:io/process` to a **shim component** that *exports* it.
  Swap `node-shim` / `deno-shim` / browser-shim under the same world.
- `wasm-tools component wit app.wasm` reads the declared world back out.

## Why deferred (and where it does NOT fit)

The Component Model's **Canonical ABI copies** values across the component
boundary (lists/records/strings lifted+lowered) and does **not** pass core
WasmGC objects across. So:

- It is a **clean fit for the byte/scalar host-API boundary** (#2512):
  `read: func(buf: list<u8>) -> u32` lowers fine, no GC identity needed.
- It is the **wrong vehicle for the zero-copy shared GC runtime** (#2514): it
  would copy the GC strings/vecs at the boundary, defeating the point — which is
  exactly why #2524 (core linking + canonical rec group, relying on engine
  canonicalization) is the chosen approach for the GC case.

So even if adopted, this would cover the host-API shims, not the GC runtime.

## Open questions (verify before committing)

- Current maturity of `wac` / `wasm-tools compose` and the **registry** story
  (warg) for resolving interface URLs by name — a web check is queued; today you
  compose against a shim you provide rather than fetch-by-URL.
- Whether js2wasm should emit components at all, vs core modules + adapters.
- Interaction with `--target wasi` (WASI Preview 2 is itself component/WIT-based).

## Notes

Filed alongside #2524 (core-wasm, chosen-to-implement-first) from the #389
modularization discussion. This is the declared-interface / multi-host
composition story; implement only if/when the core-wasm path proves insufficient
or component tooling matures.
