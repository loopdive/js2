---
id: 6427
title: "A compiled closure has no `name` carrier in gc/host mode — and no exact §15.1.5 `length` for a defaulted parameter"
status: ready
sprint: current
created: 2026-09-12
updated: 2026-09-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Slice 2 of [#5365](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5365-host-closure-bridge-loses-length-and-name),
filed after slice 1 measured where the boundary read actually lands.

In `gc`/JS-host mode a compiled closure that crosses a call boundary as a value
answers `.name` as `undefined`. Slice 1 fixed `.length` for the same read by
answering from the `$arity` header slot; `name` has no carrier at all, and
`length` is still the DECLARED formal count rather than §15.1.5
ExpectedArgumentCount.

Measured on the slice-1 branch (`viaParam(x) { return x.length + "/" + x.name }`,
`target: gc`, `platform: node`):

| declaration        | `.length` | spec | `.name`     | spec     |
| ------------------ | --------- | ---- | ----------- | -------- |
| `(a, b) => a + b`  | 2         | 2 ✓  | `undefined` | `"f"` ✗  |
| `function g(a,b,c)`| 3         | 3 ✓  | `undefined` | `"g"` ✗  |
| `(a, ...rest) => a`| 1         | 1 ✓  | `undefined` | `"rst"` ✗|
| `(a, b = 1) => a`  | **2**     | 1 ✗  | `undefined` | `"dflt"` ✗|

Both residuals need the same thing and should land together.

## The carrier question is already decided — a lookup TABLE cannot work

#5365's plan preferred "a declaration-indexed `__closure_name(idx)` table, read
once at wrap time by `_wrapWasmClosure`", with #4437's `$__fn_instance_meta`
slot as the fallback. Slice 1's measurement retires that preference for two
independent reasons:

1. **There is no wrap.** The value the callee sees at a compiled→compiled
   boundary is the RAW WasmGC closure carrier, not a JS bridge:
   `Object.prototype.toString.call(x)` is `"[object Object]"` and
   `hasOwnProperty(x, "name")` is `false`. `_wrapWasmClosure` is never on this
   path — the read lowers to `__extern_get(carrier, "name")`. So there is no
   moment at which a declaration index could be handed to a table; the only
   thing the reader holds is the carrier.
2. **A `ref.test` ladder over struct types cannot separate declarations.**
   WasmGC canonicalizes types structurally — `function-instance-meta.ts` states
   this in its own rationale ("field NAMES are ours alone and are not in the
   binary") — so two declarations with the same capture shape and signature are
   the SAME struct type. A `__closure_name(externref)` export built like
   `__closure_arity`'s ladder would answer one of them with the other's name.
   That is a soundness failure, not a cost one.

So the index must live ON the carrier, which is exactly `$fnmeta`: a
`(ref null $__fn_instance_meta)` slot pointing at a per-declaration `{name,
length}` singleton. It already IS the declaration-indexed table, reached by
pointer instead of by index, and it already carries the §15.1.5 `length`.

## Implementation Plan

1. Lift the `ctx.standalone` gate in `src/codegen/function-instance-meta.ts`.
   Its scope note ("in gc/host mode the `env::__extern_*` imports own the
   reflective property path, so the extra field would be pure cost") is the
   assumption slice 1 disproved: those imports have nothing to read.
2. Export a host-readable accessor for the slot — the runtime already reserves
   `__fninst_meta(externref) -> externref` (`function-instance-props.ts`) for
   the standalone arms; check whether exporting it is enough, or whether a
   `__closure_name` / `__closure_spec_length` pair reading the same struct is
   cleaner for the host.
3. Answer `__extern_get(carrier, "name")` and tighten the slice-1 `length`
   answer to the meta struct's §15.1.5 value when the slot is present, keeping
   `$arity` as the fallback (a closure whose mint site does not carry the slot
   must keep slice 1's answer, never lose the property).
4. **Measure the module-size delta** on a closure-heavy module (compiled hono,
   compiled acorn) and quote it — one extra field per closure struct plus one
   lazily-filled global per declaration. That number is the whole cost case for
   lifting the standalone gate.
5. Regression test with untyped `.js` two-file fixtures, counts both ways, plus
   an anti-vacuity control; full 17-suite per-file A/B (this touches every
   closure mint site).

## Acceptance criteria

1. `viaParam(f)` reports the declaration's name in `gc`/host mode.
2. `(a, b = 1) => a` reports `length === 1`.
3. hono `src/helper/dev/index.test.ts` improves beyond slice 1's 4/8.
4. Module-size delta measured and quoted; no suite regresses.
