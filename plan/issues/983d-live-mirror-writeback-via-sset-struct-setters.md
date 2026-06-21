---
id: 983d
title: "Live-mirror write-back: host mutations to a WasmGC struct's proxy sidecar never reach the struct field (~11 Array.prototype.*.call fails)"
status: suspended
assignee: sd-4
created: 2026-05-27
updated: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: Array, host-boundary, wasmgc-struct
goal: async-model
sprint: 64
related: [983, 1630, 1631, 1090]
test262_fail: 11
---
# #983d — Live-mirror write-back via `__sset_<field>` struct setters

## Problem

When a WasmGC struct is exposed to the JS host (via `_wrapForHost`, the live
mirror + sidecar machinery in `src/runtime.ts`), **host-side writes** to the
proxy land in the sidecar map but **never propagate back into the underlying
WasmGC struct field**. The Wasm side then reads the stale struct field and
never observes the host mutation — a one-way (read-only) mirror.

This surfaces as ~11 residual `Array.prototype.*.call` mutation-observability
failures: a generic-method call like
`Array.prototype.push.call(wasmBackedObj, v)` (or `.reverse`, `.sort`,
`.fill`, `.copyWithin`) mutates the host-visible proxy, but the compiled Wasm
that later reads the same object's indexed/length fields sees the pre-mutation
values, so the assertion comparing the two views fails.

Found during the #983 re-baseline (task #115, 2026-05-27): the literal
"WebAssembly objects are opaque" cluster is fully closed (read path / live
mirror works), but the **write-back** half of the mirror was never built.

## Root cause

`_wrapForHost` installs a Proxy whose `get` trap resolves through Wasm-exported
struct getters (`__sget_<field>`, `src/runtime.ts:1024`) and the sidecar. There
is a corresponding **`__sget_`** export but **no `__sset_<field>`** setter
export — the `set` trap can only write the sidecar, it has no way to call back
into Wasm to store the value in the actual struct slot. So:

- host `obj.x = v`  →  sidecar gets `x=v`  →  struct field `x` unchanged
- Wasm `this.x`     →  reads struct field  →  sees old value

The divergence is invisible for read-only host access (the dominant case, hence
#983 closing green) and only bites when the host mutates a Wasm-backed object
that Wasm subsequently re-reads.

## Fix sketch

1. **Emit `__sset_<field>` struct setters** alongside the existing
   `__sget_<field>` getters for any struct type that can escape to the host
   (mirror the export-generation site that produces `__sget_`).
2. **Wire the proxy `set` trap** in `_wrapForHost` to call the matching
   `__sset_<field>` export (coercing the JS value to the field's Wasm type)
   instead of, or in addition to, writing the sidecar. Keep the sidecar only
   for keys with no backing struct field (genuinely dynamic props).
3. **Type coercion at the boundary**: the setter import must coerce host values
   to the field's declared Wasm type (f64 / i32 / externref / ref) — reuse the
   `coerceType` boundary helpers.
4. Indexed Array storage (`data` vec) needs an element-store export too, not
   just named fields, for the `Array.prototype.*.call` generic-method cases.

## Acceptance criteria

1. `Array.prototype.push.call(o, v)` (and `.reverse`/`.sort`/`.fill`/
   `.copyWithin`) on a Wasm-backed `o` is observable from subsequent Wasm reads
   of `o`.
2. The ~11 residual `Array.prototype.*.call` mutation-observability test262
   entries flip to PASS.
3. No regression in the read-path live-mirror (#983) or in the sidecar
   descriptor work (#1630/#1631).
4. Focused test: host write → Wasm read roundtrip through `_wrapForHost`.

## Notes

- This is the dual-store **write-back** half of the live-mirror model; #983
  closed the read half. Feasibility hard: touches struct-setter codegen +
  proxy trap + boundary coercion, and the indexed-store path for Arrays.
- Overlaps the descriptor/struct-target-writeback design in #1630/#1631 —
  coordinate so both share one struct-setter export mechanism rather than two.

## 2026-06-21 sd-4 investigation — cluster bounded + two findings that revise the framing

Reproduced on origin/main (`075d90ee5`). The concrete, coherent slice is the
**generic-Array-method-on-plain-object** cluster — **19 official fails** of the
shape `var obj = {}; obj.m = Array.prototype.m; obj.m()`:

```
pop/{S15.4.4.6_A2_T1,S15.4.4.6_A3_T1,S15.4.4.6_A3_T2}, push/{A2_T1,A4_T1},
shift/{A2_T1,A3_T3}, unshift/A3_T2, reverse/{A2_T1,A2_T2,A2_T3,A3_T3},
sort/A4_T3, join/{A2_T1,A4_T3}, …  (19 total; grep error text
"var obj = \{\}; obj.<method>" in the baseline jsonl)
```

The minimal repro (`var obj = {}; obj.pop = Array.prototype.pop; obj.pop()`)
returns **JS `null`** (`typeof === "object"`) where the spec mandates
**`undefined`** — that is the first assertion every one of these tests trips on
(before they even check mutation-observability).

### Finding 1 — `__sset_<field>` setters ALREADY exist (issue framing is partly stale)

The issue's root-cause ("there is a `__sget_` export but **no `__sset_`**
setter export") is **no longer true** on current main. Compiling
`obj.pop = Array.prototype.pop; obj.pop()` emits BOTH `__sget_pop` (func 7,
exported) AND **`__sset_pop`** (func 9, exported) — the struct-setter codegen
half already landed. So the "emit `__sset_<field>` setters" step (Fix sketch
#1) appears done for named fields; the remaining gap is narrower than the
issue implies. (Indexed `data`-vec element-store, Fix sketch #4, still needs
verification.)

### Finding 2 — the call is a CODEGEN dispatch gap, NOT a host write-back / boundary bug. `obj.pop()` is compiled to **drop-the-method + push null** (the call is never emitted)

This is the decisive finding and it **revises the whole issue framing**. The
failure is NOT in the host runtime at all. Dumping the runner-wrapped WAT for
`var obj = {}; obj.pop = Array.prototype.pop; var r = obj.pop();` shows the
import table has **no `__extern_method_call`** (confirmed: instrumenting
`src/runtime.ts:8439` never fires), and `$test` compiles `obj.pop()` to:

```wasm
local.get $obj
struct.get $__anon_0 0     ;; read the `pop` field (the method value)
drop                       ;; <-- the method value is DROPPED
ref.null extern            ;; <-- r is set to null (the call is NEVER emitted)
local.set $r
```

So `r === null` (typeof "object"), not `undefined`, and no Array.prototype.pop
ever runs — hence the leading assertion `obj.pop() === undefined` fails, and
the later mutation-observability assertions can never pass either (nothing
mutated `obj`).

**Why:** `obj` is a plain object literal `{}` → an anonymous WasmGC struct
(`$__anon_0` with field `pop: externref`). `obj.pop = Array.prototype.pop`
stores the **host function value** into the `pop` field (externref). `obj.pop()`
is a call where the callee is a struct-field externref holding a HOST function
(no wasm impl).

The intended handler is `compileCallablePropertyCall`
(`src/codegen/expressions/calls-closures.ts:449`) — but instrumenting it shows
it is **NEVER reached** for this case (the `[CPC]` log never prints). Some
earlier branch in `compileCallExpression`
(`src/codegen/expressions/calls.ts:2708`) claims the call, reads the field,
drops it, and emits `ref.null.extern`. Even if CPC *were* reached, its
externref-field branch (calls-closures.ts:618) assumes the field holds a
**wasm closure struct** and does `any.convert_extern` + `emitGuardedRefCast`
to a wasm wrapper struct — which would null out for a host function anyway
(a `Array.prototype.pop` externref is not a wasm `__fn_wrap_*` struct).

**The real fix** is a dual-path dispatch for `obj.<field>()` when `<field>` is
an externref method value: (a) if it ref.tests as a wasm closure wrapper →
`call_ref` (existing path); (b) **else** → route to the host method bridge
`__extern_method_call(receiver, "<field>", args)` (runtime.ts:8439), which runs
the host function with the live-mirror `_wrapForHost` proxy as `this`. Today
branch (b) is missing — the call silently nulls.

### Suggested next-agent plan

1. **Pin the exact handler** in `compileCallExpression`
   (`src/codegen/expressions/calls.ts:2708`) that claims `obj.pop()` and emits
   `struct.get; drop; ref.null.extern`. Instrument the branch returns (the
   receiver-is-struct block around calls.ts:8163 calls CPC, but CPC isn't
   reached — so an EARLIER branch wins; find it). Likely a "field exists but no
   wasm method / not a known closure → undefined" fast path.
2. **Add the host-bridge fallback (branch b above).** When the callee is a
   struct-field externref that is NOT a wasm closure wrapper at runtime, emit
   `__extern_method_call(receiver, methodName, argsArray)` instead of nulling.
   This reuses the exact host bridge generic `Array.prototype.<m>.call`
   patterns already use, with the live-mirror proxy receiver — so the host runs
   `Array.prototype.pop` against the proxy and BOTH the return value AND the
   mutation (via the proxy's set-trap → `__sset_`) round-trip. This single
   change likely fixes most of the 19 (return value + observability together).
3. Verify the proxy `set` trap actually calls `__sset_<field>` (Finding 1 — the
   setters exist; confirm the trap is wired to them, not just the sidecar). If
   the trap only writes the sidecar, wire it to `__sset_` so the post-mutation
   `obj.length === 0` / element reads observe the change.
4. Re-bucket: 19 generic-method-on-plain-object fails is the target; watch for
   regressions in `this.callback()` callable-property calls and object-literal
   method calls (the same CPC / call-dispatch code).

## Suspended Work

- **Status:** `suspended` (was `in-progress`). sd-4 scoped + root-caused the
  framing (Findings 1 & 2 above) but did not implement — the real fix needs
  the dispatch-path pin (Finding 2) which needs fresh-context investigation.
- **Branch / worktree:** `issue-983d-live-mirror-writeback` at
  `/workspace/.claude/worktrees/issue-983d-live-mirror-writeback` (branched
  from origin/main `075d90ee5`; only this issue-doc edit committed, no code
  changes).
- **Resume steps:** re-enter the worktree, start from "Suggested next-agent
  plan" step 1. The repro file is trivial:
  `var obj = {}; obj.pop = Array.prototype.pop; var r = obj.pop();` — assert
  `r === undefined` (currently fails: `r === null`). Cluster = 19 fails,
  grep the baseline for `var obj = \{\}; obj\.`.
