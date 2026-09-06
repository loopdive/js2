---
id: 5247
title: "An uncaught compiled throw escapes to the HOST as a bare WebAssembly.Exception with no name/message — export-boundary gap, both lanes"
status: done
completed: 2026-09-06
sprint: current
priority: medium
horizon: s
goal: error-model
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
assignee: ttraenkler/dev-5247
loc-budget-allow:
  # 2026-09-06 (#5247) — the fix's own logic lives in the new
  # src/codegen/export-throw-boundary.ts. The growth here is the unavoidable
  # driver/barrel surface it needs: one internal CompileOptions flag threaded
  # through the option → compiler → context chain, the host import beside its
  # two `__throw_*_error` siblings, and two call sites in the finalize
  # pipelines. None of it can move to the subsystem module.
  - src/codegen/index.ts
  - src/runtime.ts
  - src/index.ts
  - src/codegen/context/types.ts
  - src/codegen/registry/imports.ts
  - src/package-linker.ts
  - src/compiler.ts
func-budget-allow:
  # 2026-09-06 (#5247) — same change-set, same reason: these are the option
  # plumbing / finalize-driver functions the flag and the pass have to pass
  # through, not new logic.
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/package-linker.ts::compileLinkedProject
  - src/codegen/context/create-context.ts::createCodegenContext
---

# #5247 — uncaught throws reach the host as bare `WebAssembly.Exception`

## Problem

A `throw new RangeError("x")` inside a compiled exported function that is
NOT caught in wasm surfaces to the calling host as a bare
`WebAssembly.Exception` — no `name`, no `message`, `instanceof Error` false.
Measured by dev-5226 (PR #5369) identically in the single-module control and
the linked lane, before and after the shared-tag fix — so this is an
EXPORT-boundary gap, not a provider-seam one. The #5226 reduction's last test
pins that both lanes agree, giving a future fix a measured starting point.

This matters for the #4628 test262-runner wiring: harness `assert.throws`
runs in the HOST when the runner drives compiled code, so error-type
assertions on uncaught paths read the bare exception unless the runner
catches via a compiled wrapper.

## Direction

The payload already IS the host-native Error (carried on the shared/module
`__exn` tag as externref). At the export boundary the host sees the
`WebAssembly.Exception` wrapper instead of its payload. Likely fix: the
runtime's export-wrapping layer (where `run()`/exported functions are handed
to the host) catches `WebAssembly.Exception`, extracts the payload via
`exn.getArg(tag, 0)` when the tag matches ours, and rethrows the payload.
Cold path — no hot-path concern. Cover both the shared-tag (linked) and
module-local (single-module) tags.

## Acceptance criteria

1. Reduction: uncaught `throw new RangeError` in an exported function reaches
   the host `catch` with identity intact (`instanceof RangeError`,
   name/message), both lanes; base-failing test (flip the pinned #5226 row).
2. No regressions in issue-5221…5226 family + linker family; equivalence at
   baseline; gates green.

## Implementation notes (2026-09-06)

### The fix is in WASM, not in `src/runtime.ts` — there is no export-wrapping layer

The Direction above assumed a host-side seam to patch. There isn't one, and
that is a load-bearing measurement rather than a detail:

- `instantiateLinkedProject` (`src/index.ts:1221`) hands back
  `instance.exports` untouched, and the single-module lane is a plain
  `WebAssembly.instantiate(result.binary, result.importObject)` that never
  enters compiler code at all.
- A `WebAssembly.Instance`'s exports object is not extensible, so no host-side
  shim can intercept an export call after the fact.

A host-side fix would therefore have "flipped" the #5226 pinned row only by
rerouting the control lane through a helper — i.e. by changing what the
control measures. The unwrap has to happen on the wasm side of the boundary.

### Out-of-line wrapper, not an in-place `try`

`src/codegen/export-throw-boundary.ts` mints one wrapper function per
host-facing function export and re-points the **export descriptor** at it:

```
func $__export_throw_boundary_boom (params P) (results R)
  try (result R)
    local.get 0..n ; call $boom
  catch $__exn                       ;; payload externref is on the stack
    call $__rethrow_host_exception   ;; JS frame throws it by identity
    unreachable
  end
```

Wrapping `$boom`'s own body instead would have been a real single-module
regression, because wasm matches `catch` by TAG IDENTITY:

```ts
export function g() { throw new RangeError("x"); }
export function f() { try { g(); } catch (e) { return e.message; } }
```

`f` calls `g` with an intra-module `call`, so if `g`'s body converted its
throw into a JS exception, `f`'s `catch $__exn` would stop matching. Only the
export ENTRY is rewritten; every `call $g` still reaches the raw function.

### Why linked providers are excluded (`exportsConsumedByWasm`)

The same argument bounds the pass by module role. In a linked graph the
consumer reaches a provider function **through its export name**, so wrapping
a provider's exports would convert the provider's wasm exception into a JS one
that the consumer's `catch $__exn` cannot match — undoing #5226 exactly. The
new internal `exportsConsumedByWasm` option is set on the linker's provider
build only (`src/package-linker.ts:1882`). The consumer half is the module the
host actually calls, stays wrapped, and catches the shared `env.__exn` tag —
so both lanes are covered with one mechanism.

### No-op conditions (why the corpus is unaffected)

The pass returns immediately unless the module can actually throw
(`ctx.exnTagIdx >= 0`), targets a JS host (not wasi / standalone /
`strictNoHostImports` — those have no host to receive an `Error`, which is
also the standalone fallback for the new host import), and owns its exports.
Compiler-owned `_`-prefixed exports (`_start`, `__module_init`, `__cb_*`
callbacks whose throws `normalizeModuleCallbackException` already unwraps,
`__class_call_*` dispatchers) keep their existing exception contracts.

### Measurements

Probe (`.tmp/probe-5247.mts`, single module, host lane), before → after:

```
caught: [object WebAssembly.Exception] | instanceof Error: false | name: undefined | message: undefined
caught: [object Error] | instanceof Error: true | instanceof RangeError: true | name: RangeError | message: range-x
```

`tests/issue-5226-provider-error-identity.test.ts` `hostBoundary`, both lanes:
`no-E|[object WebAssembly.Exception]` → `RE|E|[object Error]|n=RangeError|m=range-x`.
Its other three rows (the provider-seam properties) are unchanged.

Suites: the 9 provider suites (#5221/#5225/#5237/#5239/#5241/#5242/#5244/#5248
plus #4628) — 53/53 green; `node scripts/equivalence-gate.mjs` — 24 failing,
1718 passing, exactly the committed baseline, no new regressions. The
error-model suites found by name (`throw`/`catch`/`exception`/`error`) are
green except for pre-existing failures in `error-reporting.test.ts` (3),
`issue-3632-eval-early-errors.test.ts` (2), `issue-4262-error-substrate.test.ts`
(3), `issue-4154-private-brand-check-typeerror.test.ts` (2) and
`null-property-access-throws.test.ts` (1) — every one of them reproduces
identically with this pass disabled, measured row by row —
plus `report-error-patterns-edition-scope.test.ts` (1), which reads a report
JSON artifact and compiles nothing. **Not run here:**
`tests/test262-errors.test.ts`, a full-corpus harvester that OOMs in this
container by design; CI owns conformance.

**One real regression was found and fixed here**, and it names the class to
watch: `tests/equivalence/helpers.ts` builds its `env` namespace BY HAND
instead of using `result.importObject`, so it did not know the new import and
every throwing module failed to link
(`LinkError: … "__rethrow_host_exception": function import requires a
callable`, 7 rows of #3529). That helper is the only hand-built import object
in the tree — `scripts/test262-import-object.mjs` and every other consumer
extend `result.importObject`, so they inherit the import automatically.

### test262

30 baseline rows carry `[object WebAssembly.Exception]` as their failure
reason, and **none of them is this defect**: every one is a
`language/module-code` (or `import`) test whose exception escapes MODULE INIT,
not an exported call, and `__module_init` is deliberately not wrapped (see the
bound below). No baseline row was expected to move, and the value for test262
is prospective — it is the harness `assert.throws` path once the runner drives
compiled exports directly (#4628 criterion 2).

### Reported, NOT fixed — bounds

- **A function export whose descriptor points at an IMPORT is handled** (the
  wrapper simply calls the import), but a **re-export of a provider binding
  that the linker lowers to a host-mirror getter** is not a function export at
  all and keeps its previous behaviour.
- **An export whose Program-ABI alias a prepared IR component already planted
  cannot have its descriptor retargeted.** The ABI keys an export's identity by
  its ORDINAL and refuses a changed `aliasOf` (`ABI draft … was observed with a
  different plan contract`). Those exports take an IN-PLACE wrap instead —
  applied only when a whole-module reference scan proves no wasm caller can
  observe it, since an intra-module `catch $__exn` matches by tag. The scan
  over-approximates (`collectInternalFuncReferences` mirrors the nested-array
  traversal `shiftFuncIndices` already relies on module-wide), so an
  unrecognised reference form SKIPS rather than silently rewriting a function
  wasm still calls. A skipped export keeps exactly today's behaviour.
- **A compiled OBJECT LITERAL thrown uncaught** arrives at the host as an
  opaque WasmGC struct (`[object Object]`, fields unreadable). Pre-existing and
  orthogonal: the same struct is opaque when merely RETURNED. Primitives
  (string, number) and every `Error` subclass cross correctly.
- **A compiler-owned export published under a SHORT PHYSICAL ALIAS** (`$d1`
  beside `__struct_field_names`, the vec host-bridge family) carries no `_`
  prefix to recognise it by. The pass therefore decides on the TARGET HANDLE,
  not the spelling — wrapping one half of such a pair would give one function
  two exception contracts depending on which name the host used.
- **`__module_init` is deliberately not wrapped.** A top-level throw during
  module init still reaches the host as a `WebAssembly.Exception`. The test262
  runner already decodes that case explicitly via `__exn_tag`
  (`tests/test262-runner.ts` ~L3976), and changing it would change what that
  path reports.
- **#5245 is NOT resolved by this.** It is now DIAGNOSED: with the payload
  legible, the two rows turn out to be two unrelated defects —
  `total({unit:"hours"})` throws `SyntaxError: Cannot convert 817405952,3352
  to a BigInt` (a comma-joined pair reaching `BigInt()`, i.e. an
  array/multi-value carrier where a scalar was expected) and
  `round({largestUnit:"days"})` throws `RangeError: roundingIncrement must be
  at least 1 …, not 0` (an absent options-bag property answering `0` instead
  of `undefined`, defeating the polyfill's default). Both still throw, so
  #5245 stays open with those measurements recorded in its file.

## Notes

- Filed from PR #5369's "Reported-NOT-fixed" (dev-5226). Relevant to the
  #4628 criterion-2 runner wiring but not a hard blocker — the runner can
  wrap calls in compiled try/catch meanwhile.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.
