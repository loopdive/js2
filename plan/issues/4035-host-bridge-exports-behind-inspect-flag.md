---
id: 4035
title: "gate the host-bridge export suite behind an inspect/debug option — standalone modules pay ~17-20 kB for a JS-interop ABI no wasmtime deployment uses"
status: done
sprint: 78
created: 2026-08-01
updated: 2026-08-18
completed: 2026-08-02
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [4034, 2083, 2962, 3469]
depends_on: [4034]
origin: "2026-08-01 follow-up to #4034: the flag fix only helps array-free programs; everything else still pays the bridge"
loc-budget-allow:
  # The policy needs a documented CompileOptions/CodegenOptions field and one
  # ctx flag (types.ts, +16 incl. the doc comments that explain WHY the bridge
  # is a calling convention in one mode and debug surface in the other), plus
  # the strip call at both generateModule finalize sites (index.ts, +11). The
  # pass itself is a NEW module, src/codegen/host-bridge-exports.ts — nothing
  # that could live outside a god-file was put in one.
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  # +1: forwarding the option through buildCodegenOptions, next to nativeStrings.
  - src/compiler.ts
func-budget-allow:
  # createCodegenContext: the resolved `emitHostBridge` boolean must be derived
  # where the other target-implication chains live (nativeStrings, strict mode),
  # so it cannot move. generateModule: two one-line call sites + their comment.
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/codegen/index.ts::generateModule
  # The multi-module finalize path needs the identical strip call — a policy
  # that applied to single-file builds only would be a silent ABI split.
  - src/codegen/index.ts::generateMultiModule
---

# #4035 — should the host bridge be exported at all in standalone mode?

## Problem

#4034 stops the native-string prelude from faking array usage, which takes an
arith-only standalone module from 21,043 → 804 bytes. **It does nothing for a
module that genuinely uses an array or throws** — those still pay the full
runtime, because the export suite they legitimately trigger is still emitted
unconditionally:

| standalone program (post-#4034, `-O3`) | today | minus `__exn_render_*` | minus whole bridge |
| --- | --- | --- | --- |
| `return [1,2,3]` | 21,082 | 4,067 | **299** |
| `return 'a,b'.split(',')` | 21,356 | 4,291 | **546** |
| `if (n<0) throw new TypeError('neg')` | 20,516 | 3,479 | **2,907** |

Measured by deleting export entries from the disassembly and re-running `-O3`
(`__exn_render_*`, `__vec_*`, `__sget_*`/`__sset_*`, `__call_fn_*`,
`__closure_*`, `__is_*`, `__struct_field_names`, the `js2_*_host_bridge`
tables/globals).

So the aggregate size lever is not #4034 — it is this. Most real programs use
an array somewhere.

## The question

Do these exports need to be in every binary, or should they be an opt-in
(`--inspect` / `--debug` / `hostBridge: …`) that the JS runtime and the test262
harness request explicitly?

## What the audit says

The exports are **two different things wearing one name**, and the answer
differs per mode:

**js-host mode — load-bearing ABI, must stay default-on.** `src/runtime.ts` is
the consumer, and it is not debugging: it *materializes* WasmGC values for JS
callers. `_materializeIterable` uses `__vec_len`/`__vec_get`; array methods are
served by `__vec_push`/`__vec_pop` (`src/runtime.ts:2366`); property reads on
compiled structs go through `__sget_<key>` (`src/runtime.ts:2436`) because a
plain `result[field]` on a WasmGC struct yields `undefined`; prototype walking
uses `__sget_prototype` (`src/runtime.ts:168`). Take these away and js-host
interop breaks, not just introspection. Note the suite is already formalized —
`_VEC_HOST_BRIDGE_EXPORTS` / `_CLOSURE_HOST_BRIDGE_EXPORTS` /
`_DATA_STRUCT_HOST_BRIDGE_EXPORTS` with short aliases (`$v0`, `$c0`, `$d0`) and
a manifest global — so it is already a nameable unit, which is what makes
gating it tractable.

**standalone / WASI — inspection, not ABI.** The target is a JS-free host
(wasmtime). A deployed module needs `run` / `_start` and nothing else; the
landing benchmark calls exactly that. The actual consumers are harness-side:
`__exn_render_*` exists so the test262 harness can render a natively-thrown GC
payload with zero host imports (#2962, `tests/test262-runner.ts:3908`), and
`__stdout_prepare`/`__stdout_char` exist so it can read the host-free async
completion marker (#3469, `tests/test262-runner.ts:4259`). Both are testing
affordances that every production standalone binary currently pays for.

That is the case for the flag: **in standalone mode the bridge is a debug
facility**; in js-host mode it is the calling convention.

## Fix direction

Add a compile option — working name `hostBridge: "auto" | "always" | "off"`
(CLI `--inspect` / `--no-host-bridge`), defaulting to:

- js-host → `always` (today's behaviour, byte-identical)
- standalone/WASI → `off`, i.e. emit `run`/`_start` and the WASI surface only

and have the test262 runner + any JS-side standalone instantiation pass
`always` (or a narrower `inspect`) explicitly. The runner already guards every
bridge access with `typeof exp.__x === "function"`, so the *absence* is safe by
construction — the work is in making the harness opt in rather than assume.

Sub-lever worth taking regardless of the flag: **emitting `__vec_*` should not
force the exception renderer.** Today `emitVecAccessExports` → `addUnionImports`
→ native host-import replacement → `throwNativeError` → `ensureExnTag`, and the
tag alone satisfies the `__exn_render_*` gate — which is how an array literal
ends up shipping Ryu. Gating the renderer on a *user-visible* throw instead of
on tag registration is worth ~17 kB on the array cases above and is independent
of any new option.

## Risks / open questions

- **Do not regress test262.** The standalone lane's pass rate depends on the
  harness reading exception messages and the stdout marker. If the flag lands
  before the harness opts in, standalone conformance drops and the merge_group
  standalone-floor gate parks the PR. Sequence: teach the harness to request
  the bridge *first*, then flip the default.
- **npm-compat / playground / dogfood harnesses** also instantiate compiled
  modules from JS. They are js-host, so unaffected by the proposed default —
  but this must be verified, not assumed, before flipping anything.
- **Naming.** `--inspect` collides with Node's flag in muscle memory;
  `--host-bridge` describes what it is. Pick before implementing — this option
  is public API surface once released.
- Is a middle tier worth it (`exceptions-only` for standalone, so a deployed
  module can still surface a readable trap message)? Probably yes; decide with
  the numbers above — the renderer is the single most expensive family.

## Acceptance criteria

- A standalone module that uses arrays and throws compiles to < 4 kB at `-O3`
  with the bridge off.
- js-host output is byte-identical to today at the default setting.
- test262 standalone pass count does not regress (harness opts in explicitly).
- The option is documented in `docs/` and surfaced in `--help`.

## Dupe check

- **#4034** — the prerequisite: stops the string prelude from *fabricating* the
  usage that triggers the suite. This issue is about programs where the usage is
  real. Not a dupe; `depends_on`.
- **#2083** (done) — first pass at not leaking the suite into every module,
  by gating on usage. This issue asks the next question: even for genuine
  users, does the *standalone* target want it at all? Not a dupe.
- **#2962 / #3469** — introduced `__exn_render_*` and the stdout sink for the
  harness. They establish the consumers this issue would make opt-in. Not dupes.

## Resolution (2026-08-02)

Implemented as `hostBridge: "auto" | "always" | "off"` (`CompileOptions`) /
`--host-bridge <mode>` (CLI). `"auto"` — the default — resolves to `"always"`
for js-host and `"off"` for standalone/WASI.

**Naming**: `--host-bridge`, not `--inspect` (the issue flagged the Node
collision). The mode says what is published, not why.

**Mechanism — one sink, not ~15 gated emitters.** Every producer stays
unconditional; `stripHostBridgeExports` (`src/codegen/host-bridge-exports.ts`)
removes the bridge export entries at finalize, immediately **before**
`eliminateDeadLayoutAndPlanProgramAbi`, so the existing DCE + `-O3` reclaim
everything those roots were pinning. Gating each emitter would have spread the
policy across codegen and invented new half-built-bridge states. Both
`generateModule` finalize sites are patched.

Not stripped, because they are not JS-inspection surface: `memory`, `_start`,
`__exn_tag`, `__module_init`, and every user export.

### Measured, `-O3`

| program | standalone before | standalone after | js-host |
| --- | --- | --- | --- |
| `run(n){return n}` | 804 | **51** | 37 |
| fib | 848 | **90** | 76 |
| `return [1,2,3]` | 21,082 | **125** | 778 |
| `return 'a,b'.split(',')` | 21,356 | **447** | 989 |
| class + array + closure + `join` | ~21 k | **1,000** | 3,715 |
| class + array + closure + **throw** | 23,149 | 18,472 | 3,715 |

js-host is byte-identical (asserted in the test).

### The throw case is NOT fixed — and it is a different bug

A module that genuinely throws still pays ~19 kB even with the bridge off and
no `_start` (measured on both `wasi` and `standalone`). The Ryu tables are
reachable from `run` itself: `throw new TypeError('neg')` constructs the error,
which routes through the polymorphic `__any_to_string`, whose number arm is
force-emitted (#2969) and pulls `number_toString` → Ryu. The message here is a
*constant string*; nothing needs float formatting. Specialising
`__any_to_string` when the argument is statically a string is a separate lever
— filed as #4072.

### Harness opt-in (the sequencing the issue called for)

Done FIRST, in the same change, or standalone conformance would have collapsed
onto opaque labels:

- `scripts/test262-worker.mjs` — injected in `compileSingleSource` /
  `compileMultipleSources`, the two wrappers every worker compile funnels
  through, so no call site can be missed. Callers may still override.
- `tests/test262-runner.ts` — passes `hostBridge: "always"` on its compile.

Guarded by `tests/issue-4035-host-bridge-policy.test.ts` (6 tests): default off
for standalone, opt-in restores it, js-host keeps it, explicit `off` works for
js-host too, `auto` is byte-identical to the default, and a user export named
`__vector_norm` is not eaten by prefix matching.
