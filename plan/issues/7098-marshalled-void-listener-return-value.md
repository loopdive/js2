---
id: 7098
title: "Runtime-marshal gap: a void event listener marshalled through `_wrapWasmClosureUnknownArity` returns a null-prototype object instead of `undefined`"
status: done
created: 2026-10-19
updated: 2026-10-20
completed: 2026-10-20
assignee: ttraenkler/opus-7098-void-listener
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: host-interop
goal: architecture
sprint: current
parent: 6708
related: [7091, 7095, 6979]
loc-budget-allow:
  # 2026-10-20 (#7098): the probe-export trigger runs right after the closure
  # call bridge is emitted (codegen/index.ts: +1 import, +1 call), and runtime.ts
  # injects its closure-bridge registries into platform-arg-marshal (+1 line).
  - src/codegen/index.ts
  - src/runtime.ts
func-budget-allow:
  # 2026-10-20 (#7098): one call after the closure-dispatcher emission block.
  - src/codegen/index.ts::generateModule
---

# #7098 — return value of a marshalled void closure

Found by #7091 (2026-10-19) when making `tests/issue-3214-void-host-callback.test.ts`
green on the default profile. On the native regime in a JavaScript
environment, a closure passed to a platform extern (`el.addEventListener("click",
() => { … })`) is marshalled by the runtime's generic closure wrapper
(`_wrapWasmClosureUnknownArity` in `src/runtime/*`), which does not convert
the Wasm result: a `void` closure comes back as an empty null-prototype
object where the host-assisted lane's callback wrapper returned `undefined`.
Legacy and IR producers both reach the same wrapper. The affected
`issue-3214` row ("keeps multiple certified callback sites distinct in source
order") is pinned to `host-assisted` until this is fixed; S7 (#6979)
retires that pin, so this issue is an entry condition for it.

## Plan

1. Measure: a `.tmp` probe under native-first (JS environment via
   `wrapCompiledExports` with a stub `document`) for closures returning
   nothing, a number, a string, a boolean, an object, and a closure, as seen
   by the host; against `host-assisted` and Node.
2. Fix in the runtime wrapper: convert the closure's result through the same
   value adapter the exports use (undefined sentinel → `undefined`, boxed
   primitives → primitives, native strings → JS strings when the bridge is
   exported, cf. #7095), keyed on the closure's declared result kind when the
   manifest records it and on the value otherwise. Wasm bytes must not
   change (runtime-only).
3. Tests: a focused test; un-pin the `issue-3214` row and quote it green.
4. Acceptance: equivalence gate "No new equivalence regressions";
   `check:host-import-policy` unchanged.

## Measurements (2026-10-20, base `6246514c9d` = PR 6779 head)

### Corrected premise

**The runtime alone cannot recognise the `$undefined` singleton.** A void
closure's `__call_fn_*` result is the tag-1 `$AnyValue` singleton
(`buildClosureResultBoxing` → `undefinedExternInstrs`), and a Boolean result is
a native box. The listener module from the `issue-3214` row exports no probe
that can tell either apart: there is no `__dynamic_boundary_tag` and no
`__typeof_boolean`/`__unbox_boolean`. The only exports are `__str_is_native`,
`__is_closure`, `__closure_arity`, `__is_data_struct`, `__error_boundary_*`
and the `__call_fn_*` dispatchers. Mapping "unrecognised carrier → undefined"
would also turn `true` into `undefined` (truthy becomes falsy). The import
manifest is built from `mod` alone (ValTypes only, no per-closure result kind),
so no declared result kind could be recorded without codegen either.

The lead chose option 1: export the existing probes where the closure call
bridge meets a JS value boundary.

### Change

- **Codegen (registration only):** `exposeClosureResultProbes`
  (`src/codegen/native-dynamic-boundary-tag.ts`) runs once after the
  `__call_fn_*` / `__call_fn_method_*` dispatchers are emitted. When the module
  has native strings, a JS value boundary (`jsValueBoundary`, the gate the
  #6708/#7095 bridge triggers use), an `$AnyValue` type and a `__call_fn_*`
  export, it exports:
  - the existing `ensureNativeDynamicBoundaryTag` probe;
  - the already-present `__typeof_boolean`/`__unbox_boolean` pair, if the
    module has them.

  No new helper and no change to any body emitter. Standalone and WASI have no
  JS value boundary and are untouched. Note: `ctx.standalone` is `true` in a
  JS-environment native module, so the gate is the boundary, not that flag.
- **Runtime:** `src/runtime/platform-arg-marshal.ts`. When a closure argument
  of an `extern_class` import or a user `declare function` becomes a callable,
  that callable is now a cached, identity-stable adapter. It is aliased in the
  runtime's closure-target map, so a callable handed back to Wasm still unwraps
  to its closure. Its result goes through `_nativePrimitiveToHost`, the export
  adapter's primitive converter: tag → `undefined`/`null`, Boolean/number/bigint
  boxes → primitives, native strings → JS strings. A closure result becomes a
  callable (itself adapted); anything else passes through. This is scoped to
  dynamic bridges crossing this boundary. The generic
  `_wrapWasmClosureUnknownArity` bridge keeps raw returns, because marshalling
  generic call exits regressed in #3123/#2835. `runtime.ts` only injects its two
  registries (`closureBridges.configure(...)`, +1 line, within the
  `maximumRuntimeTsLines` 20,243 ceiling).

### What the host reads from the callback (`.tmp/probe-7098b.mts`)

Default profile, `target: "gc"`, `buildImports` + `wrapCompiledExports`, the
callback captured from `target.addEventListener("tick", f)`:

| closure returns | before | after | host-assisted | Node |
| --- | --- | --- | --- | --- |
| nothing (`{ sink.textContent = "x"; }`) | `{}` (null proto) | `undefined` | `undefined` | `undefined` |
| `undefined` | `{}` | `undefined` | `undefined` | `undefined` |
| `null` | `null` | `null` | `null` | `null` |
| `true` / `false` | `{}` / `{}` | `true` / `false` | `true` / `false` | `true` / `false` |
| `42` | `42` | `42` | `42` | `42` |
| `"lit"` | `{}` | `"lit"` | `"lit"` | `"lit"` |
| `() => (y) => y + 1` | `{}` | callable, `f(1) === 2` | `{}` | callable |
| `({ a: 1 })` | `{}` | `{}` (opaque struct, unchanged) | `{}` | plain object |

The same closures handed to a user `declare function hostCall(f: () => any)`
(the #7095 path) give the same "after" column. Exceptions: the object row is
`null` both before and after, and host-assisted passes the closure itself
opaque, both unchanged.

### Byte identity (`.tmp/hash-corpus.mts`)

The corpus is 1,768 sources: the 13 playground `.ts` examples plus every
backtick literal in `tests/equivalence` that is at least 30 characters long and
contains a declaration keyword. This extraction differs slightly from #7095's
1,707. Each source was compiled for gc, standalone and wasi, and the sha256
hashes were compared against base. Base and after ran on the same tree, swapping
only the four changed files.

| target | sources differing | of which without a `__call_fn_*` export | new CE |
| --- | --- | --- | --- |
| gc | **252 / 1,768** (11 of the 13 playground files) | **0** | 0 |
| standalone | **0** | n/a | 0 |
| wasi | **0** | n/a | 0 |

On gc, 253 of the 1,768 sources emit the closure bridge, and every changed
binary is one of them. The one bridged source that did not change
(`issue-1454.test.ts`, literal #7) already exported all three probes through
the `any`-boundary bridge.

### Tests

- `tests/issue-7098-marshalled-closure-result.test.ts`: 19/19. It covers both
  crossings × undefined/void/null/true/false/number/string/closure, plus
  identity across `add`/`removeEventListener`, the probe exports present on gc
  and absent on standalone/wasi, and host-assisted unchanged.
- `tests/issue-3214-void-host-callback.test.ts` › "keeps multiple certified
  callback sites distinct in source order" now runs on the **default profile**
  (the `HOST_ASSISTED` pin is removed; the `label` string crosses through
  `wrapCompiledExports`) and passes. The file is 30/30.
- Related set, run on base and after (dom-capability-adapter, all
  `issue-2856-*`, all `issue-3214-*`, 3325, 3657, 7091, 7095, 7098; 260 rows):
  70 failed on base, 56 after. **No new failures.** The 14 rows that flipped are
  the new 7098 rows; the 56 shared failures are pre-existing IR-claim
  assertions.
- Equivalence gate (single fork, `--configLoader runner` copy): `20 failing,
  2020 passing, 22 known-failures in baseline` — "✓ No new equivalence
  regressions." (2 baseline failures now pass: delete-sentinel, reflect-api.)
- `check:host-import-policy`: exit 0. Output identical to base except
  `runtimeTsLines` 20,240 → 20,241 (ceiling 20,243). tsc: 0 errors.

### Left out

- `() => "s" + sink.textContent` reads `"s[object Object]"`, and
  `() => sink.textContent` reads `null`, inside a native-lane listener with a
  plain-object stub element. That is a DOM read inside the closure, not a
  result crossing: the `string read` row is already `null` on base. It belongs
  to the #7091 DOM-read lowering, not this marshal.
- `const f = () => {}; target.addEventListener("a", f)` (no capture, empty
  body) throws `called value is not a function` inside `install`. This happens
  identically on base and is a lowering defect, not a result one.
- Object results stay opaque structs, as on host-assisted. A host view
  (`_wrapForHost`) would break identity when the host hands the value back.
