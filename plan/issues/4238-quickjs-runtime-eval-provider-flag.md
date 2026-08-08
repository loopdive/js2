---
id: 4238
title: "QuickJS-backed runtime-eval provider behind a flag — swap the eval engine, keep the Acorn+interpreter default until migration completes (#4236 variant C MVP)"
status: ready
sprint: current
created: 2026-08-08
updated: 2026-08-08
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: runtime-eval
language_feature: eval
goal: runtime-eval
related: [2928, 2929, 4013, 4236]
# id 4238 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08 (gh CLI unavailable; pr_scan=degraded). Equivalent open-PR scan
# via the GitHub MCP at reservation time: sole open PR was PR 4245 (docs-only,
# edits existing issue files 4236/4237, introduces no new issue ids).
---

# #4238 — QuickJS-backed runtime-eval provider, flag-gated

## Request (project lead, 2026-08-08)

> swap out our interpreter with quickjs but keep the old. enabling quickjs
> should be behind a flag to keep things working until migration is done

This is the **#4236 variant C MVP**: QuickJS (the slice-1 WASI artifact,
scripts/quickjs-artifact/, quickjs-ng v0.16.1 pin) becomes an alternative
ENGINE behind the existing `js2wasm:runtime-eval` provider seam. The seam
itself — four imports (`__runtime_direct_eval`, `__runtime_indirect_eval`,
`__runtime_new_function`, `__runtime_apply_interpreted`), externref/i32/f64
signatures, emitted at src/codegen/expressions/runtime-eval-provider.ts —
does NOT change. User modules compile identically under both engines.

## Hard constraints

1. **The Acorn+interpreter provider stays the default.** No behavior change
   anywhere unless the flag is set. CI, test262 baselines, the #4013
   provider-artifact cache, the eval-code 797/816 result — all untouched by
   default.
2. **Flag surface** (architect to finalize naming): an engine selector on
   provider *selection*, not on user-module codegen — e.g.
   `JS2WASM_EVAL_ENGINE=quickjs` for runners/tests and an
   `--evalEngine quickjs` CLI flag. Default `interpreter`. Unknown values
   error loudly.
3. **Keep both engines healthy**: the flag must be exercised by a scoped CI
   or local test lane (a small eval test set run under
   `JS2WASM_EVAL_ENGINE=quickjs`) so the QuickJS path can't rot silently —
   but as a non-required / scoped check, not a change to the required gates.
4. Migration ends (separate future issue) with defaults flipped and the old
   interpreter retired; nothing in this issue removes interpreter code.

## Design substrate (already proven — do not re-derive)

- **#4236 "## Design variant C"**: handle-table ABI for GC-lane values
  crossing into QuickJS, exotic wrappers, `JSClassDef.gc_mark` cycle notes,
  tiered-provider MVP scoping (≈ 1 budget window).
- **#4236 "## Slice 1 — WASI artifact"**: the artifact is genuinely
  standalone (5 wasi imports, zero env.*), i32 handles per QTS convention,
  the shim converts QuickJS move→borrow semantics ("free every returned
  handle once"), tag-extraction exports for immediates.
- `scripts/quickjs-artifact/build.sh` builds reproducibly in ~3 min cold
  with stock clang-18 (no wasi-sdk); `wasi-stub.mjs` instantiates with a
  no-op WASI stub; `extract-abi.mjs` dumps the ABI constants.
- Current provider plumbing: `scripts/build-runtime-eval-provider.mjs`
  (builds the Acorn+interpreter provider), `scripts/runtime-eval-provider.mjs`
  (`selectCachedRuntimeEvalProvider`, #4013 cache keyed on compiler-bundle
  hash), `src/interp/eval-environment.ts` (scope-bridge semantics),
  `tests/` eval suites + `TEST262_FULL_RUNTIME_EVAL=1` runner wiring.

## Known open problems the spec must resolve

- **Value bridging**: the seam's externref args are GC-lane values; QuickJS
  values are linear-memory JSValues behind i32 handles. Where does the
  handle table live, who wraps/unwraps, and what subset of values round-trips
  in the MVP (numbers/strings/booleans/null/undefined at minimum)?
- **Scope bridge**: direct eval's caller-scope read/write (the #2929 C+D
  semantics) — what does the MVP support, and what degrades to the
  documented residual list? Indirect eval + `new Function` (global scope
  only) are the natural MVP tier.
- **Artifact delivery**: the QuickJS wasm is not committed (CI builds it,
  #4243 workflow). How does the provider selector obtain it — build-on-
  demand via build.sh, cache dir, env override — without breaking offline
  default runs?
- **`__runtime_apply_interpreted`**: calling an eval-defined function from
  compiled code — how does a QuickJS function handle get invoked through
  the seam?

## Acceptance criteria

- [ ] With no flag: byte-identical provider selection behavior; full test
      suite + eval test262 subset unchanged.
- [ ] With `JS2WASM_EVAL_ENGINE=quickjs` (name per spec): indirect eval,
      `new Function`, and eval-defined-function invocation work end-to-end
      from a js2wasm-compiled standalone module, with zero JS behind the
      seam beyond the WASI stub.
- [ ] A scoped test lane runs a defined eval subset under the QuickJS
      engine and is green; its pass/residual list is recorded in this file.
- [ ] Direct-eval scope semantics: MVP level defined, implemented or
      explicitly deferred with the residual documented here.
- [ ] Engine selection is observable (e.g. provider reports its tier/engine
      string) so tests can assert which engine served an eval.
- [ ] No new host imports without a standalone fallback (CLAUDE.md
      dual-mode principle) — the QuickJS path must remain pure-wasm+WASI.

## Implementation Plan

(architect, 2026-08-08 — grounded in #4236 "## Design variant C" + "## Slice 1
— WASI artifact"; every file:line reference verified against current main.)

### Decision summary (read this first)

| decision | choice |
| --- | --- |
| flag | env `JS2WASM_EVAL_ENGINE` ∈ {`interpreter` (default), `quickjs`}; unknown value **throws** at selection. NO CLI flag in this issue (rationale below); the name `--evalEngine` is reserved. |
| bridge | **js2wasm-compiled TS "GC adapter" module** + `libquickjs.wasm`, a 2-module bundle. Not C, not harness JS. |
| value bridge | tag-dispatch handle conversion; numbers/strings/booleans/null/undefined copy; QuickJS functions → 8-slot callable carrier; other QuickJS objects → opaque handle box. Compiled GC objects do NOT cross into QuickJS (typed refusal). |
| direct eval MVP | slices 1–2: typed catchable `TypeError` refusal. Slice 3: **scope-snapshot + post-eval write-back** through the live cells (chosen over pure indirect-degrade — the cells are already handed in, write-back is cheap, and it recovers the dominant `eval("x = x + 1")` shape). |
| artifact | prebuild script (sibling of `build-runtime-eval-provider.mjs`) builds/caches; the **selector never builds**; env override for a prebuilt dir; hard error when flag set + artifact absent. |
| default-path guard | every new code path is behind `process.env.JS2WASM_EVAL_ENGINE === "quickjs"` in ONE function; the interpreter/refusal path is not re-indented, not re-ordered, and its cache keys are untouched. |

### 1. Flag plumbing

**Env var (the only selection surface): `JS2WASM_EVAL_ENGINE`.**
Values `interpreter` | `quickjs`; unset ⇒ `interpreter`.

The single branch point is `selectCachedRuntimeEvalProvider()` in
`scripts/runtime-eval-provider.mjs:606-644`. New shape:

```js
export function selectCachedRuntimeEvalProvider() {
  const engine = process.env.JS2WASM_EVAL_ENGINE ?? "interpreter";
  if (engine !== "interpreter" && engine !== "quickjs") {
    // NOT inside the try/catch below — an unknown engine must fail the
    // process loudly, never degrade to the NONE tier.
    throw new Error(
      `JS2WASM_EVAL_ENGINE=${JSON.stringify(engine)} is not a known eval engine ` +
      `(expected "interpreter" or "quickjs")`);
  }
  if (process.env.TEST262_DISABLE_RUNTIME_EVAL_PROVIDER === "1") { /* unchanged, wins over engine */ }
  if (engine === "quickjs") return selectQuickjsEvalProvider();   // new, see §5
  /* ...existing interpreter/refusal body VERBATIM — zero diff below this line... */
}
```

- **Precedence**: `TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1` > engine flag.
  `TEST262_FULL_RUNTIME_EVAL` is an interpreter-tier knob and is **ignored**
  under `quickjs` (the returned message says so explicitly).
- **Return-shape extension (additive)**: the selection object grows an
  `engine` field — `{ module | bundle, message, engine: "interpreter" |
  "refusal" | "quickjs" | "none" }`. Existing consumers destructure only
  `module`/`message` (`scripts/test262-import-object.mjs:81`,
  `tests/issue-2929-cd-global-materialization.test.ts:27`) — unaffected.
- **`instantiateRuntimeEvalNamespace`** (`scripts/runtime-eval-provider.mjs:668-676`)
  keeps its exact behavior when passed a `WebAssembly.Module` (every existing
  caller: `build-runtime-eval-provider.mjs:72,112`, `test262-import-object.mjs:130`,
  tests `issue-2928-refusal-provider`/`issue-1102`/`issue-2960`/`issue-4197`).
  It additionally accepts the quickjs bundle descriptor
  `{ engine: "quickjs", adapterModule, quickjsModule }` and performs the
  2-module link (§2). Discriminate via `arg instanceof WebAssembly.Module`.

**Engine identity, observable three ways** (acceptance box 5):

1. `selection.engine` (programmatic, harness-side).
2. The existing lazy announcement (`test262-import-object.mjs:84`) prints the
   new message: `QUICKJS (artifact <sha12>, adapter key <key>) — flag-gated
   engine (#4238), NOT CI-comparable with the interpreter tier`.
3. In-band: the adapter defines a non-enumerable global
   `__js2wasm_eval_engine` = `"quickjs"` on the QuickJS `globalThis` at
   context init, so eval'd code (and the test lane) can assert
   `eval("typeof __js2wasm_eval_engine")`. The interpreter provider defines
   nothing — absence ⇒ interpreter.

**No CLI flag in this issue — verified rationale.** `src/cli.ts` compiles
only; it never selects, links, or instantiates a provider (grep for
`runtime-eval` in `src/cli.ts`: zero hits — the provider is attached at
run/link time by the harness, `scripts/test262-import-object.mjs:120-133`).
An `--evalEngine` compile flag would be dead surface, and worse, would imply
the emitted module differs per engine — it must not (the seam is frozen; user
modules compile identically). The name is reserved for the #2527 packaging
CLI when it grows a link/run mode.

**Default-path guard (acceptance box 1).** The diff to
`selectCachedRuntimeEvalProvider` is: (a) the engine read + validation throw
before the existing body, (b) one `if (engine === "quickjs") return …` line.
No existing line moves. The interpreter/refusal cache keys
(`runtimeEvalProviderCacheKey`, `:558-567`) take no new inputs. Provable:
with `JS2WASM_EVAL_ENGINE` unset the executed body is character-identical to
today's after the two inserted lines; the scoped test lane (§6) asserts
`selection.engine` and the unchanged message text with the flag unset.

### 2. Provider module graph — the bridge is a js2wasm-compiled TS adapter

```
user module ──js2wasm:runtime-eval (4 imports, externref ABI — FROZEN)──▶ GC adapter (js2wasm-compiled TS)
GC adapter ──js2wasm:qjs (i32/f64 handle ABI) + imported memory──▶ libquickjs.wasm (WASI reactor)
libquickjs.wasm ──wasi_snapshot_preview1 (5 fns)──▶ WASI stub / runtime
```

**Why the adapter must be js2wasm-compiled TS** (the other two options fail
hard constraints):

- *Hand-written C in `qjs_shim.c`*: cannot implement the seam. The seam's
  values are WasmGC — `externref` args wrapping canonical `$Object`s, the
  `[ok, value]` envelope decoded by `emitRuntimeEvalResultUnwrap`
  (`src/codegen/expressions/runtime-eval-provider.ts:385-428`) via
  `__extern_get_idx` on a **structurally canonical externref vec**, the
  8-slot `makeInterpClosure` rec-group callable carrier
  (`eval-inline.ts:2020-2048`), live ref cells. A linear-memory C module can
  neither mint nor trap on any of these; clang's `__externref_t` cannot be
  stored in linear memory by construction.
- *Harness-level JS composition*: implementing the 4 seam functions in JS
  violates "zero JS behind the seam beyond the WASI stub" verbatim — every
  eval would run through a JS data path.
- *js2wasm-compiled TS*: gets structural canonicalization of the envelope
  vec, callable carrier, and ref-cell types **for free** (same argument as
  the current provider — `scripts/runtime-eval-provider.mjs:2-10`), and
  reuses the exact build pipeline that already exists
  (`scripts/build-runtime-eval-provider.mjs`). This was the load-bearing
  economic fact of #4236 variant C ("the sandwich").

**Link topology** (all wasm-to-wasm at runtime; JS appears only in the
instantiation harness, exactly like the sanctioned WASI stub):

1. Instantiate `libquickjs.wasm` with `makeWasiStub`
   (`scripts/quickjs-artifact/wasi-stub.mjs:13-56`), call `_initialize`
   (reactor model, `build.sh:133-138`).
2. Instantiate the adapter with imports:
   - `"js2wasm:qjs".memory` ← `qjs.exports.memory` (the artifact owns +
     exports memory, `build.sh:143`; the adapter imports it at memory index 0
     — the proven #2633 topology, `src/codegen/wasi.ts:89-100`).
   - `"js2wasm:qjs".qjs_*` ← the artifact's exports, **bound directly**
     (no JS wrapper functions — this requires exact signature match, hence
     the native-i32-extern enabler below).
3. The user module links `"js2wasm:runtime-eval"` ← adapter exports, as today.

Per-test isolation: `instantiateRuntimeEvalNamespace` instantiates **both**
modules fresh per call (the comment at `runtime-eval-provider.mjs:663-666`
applies doubly — a QuickJS context accumulates global state).

**Two S-size compiler enablers, both default-off (guarded by new internal
compile options; user-facing behavior byte-identical when unset):**

- `externNativeTypes: true` — in `collectExternDeclarations`
  (`src/codegen/extern-declarations.ts:643-736`), the param/result mapping at
  `:727-733` uses `mapTsTypeToWasm` (→ f64 for `number` and for the
  `type i32 = number` alias — probe-verified in #4236 variant C). Under the
  option, prefer `nativeTypeFromTypeNode(ctx.checker, p.type)`
  (`src/codegen/native-type-annotations.ts:109`) per parameter and for the
  return type, falling back to `mapTsTypeToWasm`. This makes
  `declare function qjs_eval(ctx: i32, src: i32, len: i32): i32` emit a real
  `(i32,i32,i32)→i32` import so the artifact export binds without a JS shim.
  Do NOT change the default mapping — existing user externs must keep f64.
- `externImportModule: "js2wasm:qjs"` — the `addImport(ctx, "env", name, …)`
  at `extern-declarations.ts:733` takes the option's module string instead of
  `"env"` when set. Register `js2wasm:qjs` beside the
  `RUNTIME_EVAL_IMPORT_MODULE` precedent so the #2961 host-import-leak
  warning does not fire for it (allowlist or namespace exemption — whichever
  the #2961 ratchet checks; a *namespaced provider import* is not a host
  leak).
- One packaging enabler: an `importMemory: { module: "js2wasm:qjs" }` compile
  option that emits `addImport(ctx, module, "memory", { kind: "memory",
  min: 256 })` before function imports (mirror `src/codegen/wasi.ts:98` —
  memory imports do not perturb the func index space, per the comment there)
  instead of defining a memory, so the adapter's `wasm:memory` accessors
  (`store32/load32/store8/load8`, `src/codegen/raw-wasi-api.ts:25-55` —
  they lower to INLINE memory ops, no per-byte trampoline) target QuickJS's
  heap.

These options are set only by the provider build script's compile-options
object (a `QUICKJS_ADAPTER_COMPILE_OPTIONS` sibling of
`RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS`, `runtime-eval-provider.mjs:41-46`).

**Shim additions to `scripts/quickjs-artifact/qjs_shim.c`** (all follow the
existing borrow-in/own-out ABI, header contract at `qjs_shim.c:10-55`):

```c
qjs_handle qjs_call(JSContext *ctx, qjs_handle fn, qjs_handle this_val,
                    uint32_t argc, const qjs_handle *argv);  /* argv = i32 array in shared mem; returns owned */
qjs_handle qjs_new_string_len(JSContext *ctx, const char *buf, uint32_t len);
qjs_handle qjs_new_bool(JSContext *ctx, int b);
qjs_handle qjs_new_undefined(void);
qjs_handle qjs_new_null(void);
int        qjs_is_function(JSContext *ctx, qjs_handle h);
char      *qjs_to_cstring_len(JSContext *ctx, qjs_handle h, uint32_t *len_out);
```

Bumping the shim changes the artifact hash — the cache key (§5) accounts for
it. `qjs_eval` (`qjs_shim.c:181-189`), `qjs_get_prop_str`, `qjs_set_prop_str`,
`qjs_global_object`, `qjs_to_f64`, `qjs_new_f64`, `qjs_tag`,
`qjs_is_exception`, `qjs_take_exception`, `qjs_free_value`,
`qjs_malloc_raw`/`qjs_free_raw` are used as-is.

### 3. Value bridging at the seam

**Where things live.** The i32→JSValue handle table IS the artifact's
malloc'd 8-byte cells (`qjs_shim.c:66-81`) — no second table. The adapter
holds handles as plain `number`s inside its own GC values. Ownership is the
slice-1 borrow ABI verbatim: **every handle a wrapper returns is freed by the
adapter exactly once** (`qjs_free_value`), on success AND error paths, except
handles deliberately retained for the instance lifetime (function carriers,
handle boxes, the cached `globalThis` handle) — those are freed never; the
leak class is context-lifetime-bounded (documented residual; cycle collection
across heaps is OUT of scope).

**GC → QuickJS (arguments, pushed globals):**

| GC value | conversion |
| --- | --- |
| number (incl. NaN/±0/∞) | `qjs_new_f64(ctx, v)` |
| string | UTF-8 encode in adapter TS → `qjs_malloc_raw` + `store8` loop → `qjs_new_string_len` → `qjs_free_raw`. Lone surrogates encode as U+FFFD (documented residual). |
| boolean | `qjs_new_bool` |
| null / undefined | `qjs_new_null` / `qjs_new_undefined` |
| qjs handle box (below) | unwrap to its retained handle (identity preserved round-trip) |
| intrinsic eval/Function marker | recognized by the adapter, routed (see `__runtime_apply_interpreted`) |
| any other GC object/function | **typed `TypeError`** `"the quickjs eval engine (MVP) cannot pass compiled objects into evaluated code (#4238)"` — loud beats silently-wrong. Residual. |

**QuickJS → GC (results), by `qjs_tag(h)`** against the constants in
`qjs-abi.json` — never hardcoded: the build script reads `qjs-abi.json` from
the artifact and bakes the constants into the generated adapter *source*, so
a re-pinned artifact changes the json → changes the adapter source → changes
its cache key:

| tag | conversion |
| --- | --- |
| INT, FLOAT64, SHORT_BIG_INT | `qjs_to_f64` → GC number. NOTE: dispatch on tag FIRST — `qjs_to_f64`'s NaN is a *legitimate value* for these tags (conversion cannot fail), never an error sentinel. |
| STRING, STRING_ROPE | `qjs_to_cstring_len` → `load8` loop + UTF-8 decode → GC string → `qjs_free_raw` |
| BOOL | payload (0/1 via `qjs_to_f64`) → boolean |
| NULL / UNDEFINED | null / undefined |
| OBJECT + `qjs_is_function` | retained handle → **qjs-callable carrier**: the exact 8-slot `makeInterpClosure` shape (the adapter is js2wasm-compiled, so its carrier is structurally canonical with the caller's seed, `eval-inline.ts:2026-2048`), with the handle stashed so `__runtime_apply_interpreted` can dispatch on it |
| OBJECT (non-callable) | retained handle → **opaque handle box**: an adapter-local `$Object` `{ __qjs_handle__: h }`. AOT property access sees a near-empty object (residual — no membrane in this issue); passing it back into eval/apply unwraps to the same handle so identity holds *within the provider*. |
| EXCEPTION | never surfaces as a value — see error mapping |

**Error mapping.** After `qjs_eval`/`qjs_call`: `qjs_is_exception(h)` ⇒
`qjs_take_exception` → read `.name`/`.message` via `qjs_get_prop_str` +
string conversion → construct the matching adapter-local error
(`SyntaxError`/`TypeError`/`ReferenceError`/`RangeError`/`EvalError`/else
`Error`) → return `runtimeEvalResult(false, err)` — the same `[ok, value]`
envelope the interpreter wrapper uses (`runtime-eval-provider.mjs:232-235`),
decoded caller-side unchanged. Free both handles.

**The four seam functions** (signatures FROZEN — `eval-inline.ts:1899-1905`,
`:2000-2006`, `:2029-2035`; `runtime-eval-provider.ts:668-687`):

1. `__runtime_indirect_eval(source, globalObject)` —
   - PerformEval step 2: if `source` is not a string, return
     `runtimeEvalResult(true, source)` unchanged.
   - Intrinsic materialization: `source === "eval"` / `"Function"` follows
     the refusal-provider precedent EXACTLY
     (`runtime-eval-provider.mjs:82-140`): memoized
     `__runtime_eval_wrap_intrinsic_callback` /
     `__runtime_eval_wrap_intrinsic_function_callback` markers installed on
     `globalObject` — keeps first-class `eval`/`Function` identity stable
     across reads (`emitStandaloneIntrinsicEvalValue`,
     `eval-inline.ts:1926-1937`) instead of minting a fresh QuickJS handle
     per read.
   - Otherwise: mirror pushed globals (below) → encode source → `qjs_eval`
     (global scope — correct for indirect eval by spec) → convert result →
     write-back globals → envelope.
2. `__runtime_new_function(paramString, bodyString, globalObject)` — compose
   `"(function anonymous(" + params + "\n) {\n" + body + "\n})"` (the
   §20.2.1.1.1 CreateDynamicFunction source form; QuickJS performs the early
   errors) → `qjs_eval` → expect a function handle → qjs-callable carrier.
   No new shim entry needed.
3. `__runtime_apply_interpreted(callable, this, argc, a0..a7)` — unwrap
   `callable`: qjs-callable carrier ⇒ convert `this` + `argc` args (table
   above), `qjs_malloc_raw(argc*4)` + `store32` the arg handles →
   `qjs_call` → convert → free arg handles + argv + result handle →
   envelope. Intrinsic-eval marker ⇒ route arg0 through the indirect-eval
   path; intrinsic-Function marker ⇒ route through the new-function path
   (args joined per spec). Anything else ⇒ typed TypeError.
4. `__runtime_direct_eval(12 args)` — §4.

**Globals push/pull.** The caller runs `__runtime_eval_push_globals` before
and `__runtime_eval_pull_globals` after every entry
(`runtime-eval-provider.ts:362-368`, `:388-391`) against the shared realm
object; the adapter (js2wasm-compiled) enumerates that `$Object`'s own
properties and mirrors **primitive** values onto QuickJS `globalThis` before
eval, then reads them back after (pull-side is copy-back by contract,
`emitRuntimeEvalGlobalBindingPullBody`, `runtime-eval-provider.ts:289-333`).
Non-primitive globals are skipped without error (residual: eval'd code sees
`undefined` for them). The `RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY`
carrier (`runtime-eval-provider.ts:45`; consumed by the interpreter at
`src/interp/eval-environment.ts:34-45`) gets the same treatment in slice 3
(read cell → mirror; after eval → write cell), skipped in slice 2.

### 4. Tier ladder — direct eval under the quickjs engine

- **Slices 1–2 (MVP tier):** `__runtime_direct_eval` returns
  `runtimeEvalResult(false, new TypeError("direct eval is not supported by "
  + "the quickjs eval engine yet — run without JS2WASM_EVAL_ENGINE for the "
  + "interpreter engine (#4238)"))`. Catchable, typed, same envelope
  discipline as the refusal provider. Note: `assembleOriginalHarness`
  injects a direct-eval-bearing `$262.evalScript` shim into every assembled
  test262 file (`test262-import-object.mjs:103-109`), so full test262 under
  the flag is meaningless until slice 3 — the scoped lane (§6) is the gate.
- **Slice 3: scope-snapshot + post-eval write-back.** Chosen over pure
  degrade-to-indirect because the caller ALREADY hands live cells — three
  name/cell layers (activation/lexical/outer) plus the 64-cell activation
  state pool (`runtime-eval-provider.ts:437-558`) — and the adapter can read
  `cell.value` / write it back exactly as the interpreter does. Mechanism:
  before `qjs_eval`, define each caller binding whose value is primitive on
  a fresh plain QuickJS object `S`; evaluate the source wrapped as
  `with (S) { … }` for sloppy callers (QuickJS runs the scope walk
  natively); after eval, read each name back off `S` and write changed
  primitives into the live cells, then mirror new sloppy `var`s into the
  activation-state-pool cells (same slot discipline the interpreter uses).
  Strict callers cannot use `with`: snapshot as a `const`-preamble
  (prepend `const x = <v>;`); writes to caller bindings are then a
  **residual** (assignment throws TypeError instead of updating).
- **Residual buckets this choice costs vs the interpreter's 797/816
  eval-code result** (enumerate now; measure in slice 3 and record the
  numbers HERE):
  1. Caller-context `new.target` / `super` inside direct eval — not
     expressible in a foreign engine, permanent for this engine (~4 + ~6
     files per the #4194 residual census).
  2. `var`-environment fidelity: hoisting eval-created vars into the caller
     varEnv, B.3.3 block-function semantics, redeclaration checks
     (`var-env-*`, ~13 files) — write-back approximates, does not implement
     EvalDeclarationInstantiation.
  3. Strict-caller assignment write-back (above) + TDZ interleaving with
     caller lexicals.
  4. Mapped-`arguments` severing contract (`mappedParamNames`,
     `runtime-eval-provider.ts:560-626`) — not bridged; `arguments`-mutation
     tests fail under the flag.
  5. Object-valued caller bindings (only primitives snapshot).
  6. Mid-eval visibility: writes land at eval-exit, not live — observable
     only if eval'd code calls back into compiled code, which cannot happen
     in this MVP (compiled callables don't cross), so effectively
     unobservable.
- **`new Function` + indirect eval are global-varEnv-only by spec** — no
  scope machinery needed; they are the honest MVP tier, fully served by §3.

### 5. Artifact acquisition

New file `scripts/quickjs-eval-provider.mjs` (selection/cache/link helpers,
imported lazily by `runtime-eval-provider.mjs` **only** inside the
`engine === "quickjs"` branch — the default path never imports it) and new
prebuild script `scripts/build-quickjs-eval-provider.mjs` (sibling of
`build-runtime-eval-provider.mjs`, same idempotent build→verify→publish
shape, `build-runtime-eval-provider.mjs:214-233`).

**Cache layout** (in `defaultRuntimeEvalProviderCacheDir()` =
`.test262-cache`, `runtime-eval-provider.mjs:570-572`):

- `quickjs-artifact-<akey>/{libquickjs.wasm, qjs-abi.json, build-info.json}`
  where `akey = sha256(QUICKJS_NG_REF ∥ WASI_LIBC_REF ∥ BUILTINS_URL ∥ OPT ∥
  sha256(qjs_shim.c) ∥ sha256(build.sh)).slice(0,16)` — the same content-key
  discipline as the #4013 provider job and the existing
  `quickjs-wasi-artifact.yml` "Compute content hash" step.
- `quickjs-eval-adapter-<key>.wasm` where `key =
  runtimeEvalProviderCacheKey(adapterSource, compilerBundleHash)`
  (`runtime-eval-provider.mjs:558-567`) with a distinct filename prefix (the
  `runtimeEvalRefusalCachePath` precedent, `:584-586`); adapterSource embeds
  the baked `qjs-abi.json` consts, so a re-pinned artifact automatically
  invalidates the adapter.

**Acquisition order in `build-quickjs-eval-provider.mjs`:**

1. `JS2WASM_QUICKJS_ARTIFACT_DIR=<dir>` env override — must contain
   `libquickjs.wasm` + `qjs-abi.json`; verified (sha256 recorded, imports
   checked ⊆ `wasi_snapshot_preview1`), then copied into the keyed cache dir.
2. Keyed cache hit — exit fast.
3. Build on demand: `bash scripts/quickjs-artifact/build.sh` with
   `OUT_DIR=<keyed cache dir>` (~3 min cold, pins at `build.sh:21-23`),
   requires clang-18/cmake/git/curl + network. On failure: **hard error**
   naming the missing prerequisite and the env override.

Then: compile the adapter (js2wasm `compile()` with
`QUICKJS_ADAPTER_COMPILE_OPTIONS`), **canary-verify the linked pair before
publishing** (the `verifyProvider` discipline,
`build-runtime-eval-provider.mjs:49-81`, but a new `verifyQuickjsProvider`:
adapter imports ⊆ {`js2wasm:qjs`}, quickjs imports ⊆
{`wasi_snapshot_preview1`} — do NOT touch the existing zero-imports
invariant, which stays load-bearing for the single-module tiers). Canaries
through the real link: indirect eval `"1 + 2"` → 3,
`new Function("a,b","return a + b")(1,2)` → 3 via apply_interpreted, a
thrown-SyntaxError envelope check, the engine identity probe.

**`selectQuickjsEvalProvider()`** (in `quickjs-eval-provider.mjs`): load
BOTH cached binaries; on any miss **throw**:
`Error("JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built "
+ "(missing <path>). Run: node scripts/build-quickjs-eval-provider.mjs "
+ "(or set JS2WASM_QUICKJS_ARTIFACT_DIR to a prebuilt artifact dir)")`.
Rationale: the flag is an explicit opt-in; silent degradation to the
interpreter would invalidate every measurement made under the flag. The
selector NEVER builds (the worker-pool 30s rule,
`runtime-eval-provider.mjs:16-20`, applies unchanged).

**Default (no-flag) path never attempts any of this** — the lazy import and
the single branch are the guard; without the flag there is no probing, no
stat of quickjs cache paths, no path that reaches `build.sh`.

**`scripts/run-test262-vitest.sh:189-203`**: add the symmetric hook — if
`JS2WASM_EVAL_ENGINE=quickjs` and `TEST262_TARGET=standalone`, run
`node scripts/build-quickjs-eval-provider.mjs` in the prebuild step (fail
the run on error). Untouched otherwise.

### 6. Test lane

**New file `tests/quickjs-eval-provider.test.ts`.** Self-gating: a
module-level probe checks (a) `JS2WASM_EVAL_ENGINE === "quickjs"` OR (b) the
keyed cache / `JS2WASM_QUICKJS_ARTIFACT_DIR` artifact is already present; if
neither, `describe.skip` with an explanatory message (default CI has no
clang-toolchain guarantee — the lane must never build implicitly). When the
artifact IS present but the env unset, the file sets
`process.env.JS2WASM_EVAL_ENGINE = "quickjs"` itself and calls
`resetTest262RuntimeEvalProviderForTest()`
(`test262-import-object.mjs:91-94`) so selection is re-made in-process
(compiles happen in-process via `compile()`; no subprocess needed).

Cases (each maps to an acceptance bullet):

1. **default-untouched**: with env deleted + reset,
   `selectCachedRuntimeEvalProvider()` returns `engine !== "quickjs"` and
   the exact pre-existing message strings.
2. **unknown value**: `JS2WASM_EVAL_ENGINE=v8` ⇒ selection throws the §1
   message.
3. **flag-set, artifact-missing** (cache dir pointed at an empty tmp dir):
   selection throws the §5 hard error.
4. Indirect eval of a number literal: compiled standalone module doing
   `(0, eval)("40+2")` → 42 (slice-1 done-signal).
5. String / boolean / null / undefined round-trips; `eval("NaN")` is a real
   NaN (the tag-dispatch edge case).
6. `new Function("a","b","return a+b")(1,2)` → 3 — exercises
   `__runtime_new_function` + `__runtime_apply_interpreted` + carrier.
7. Eval-defined function invoked from compiled code:
   `var f = (0,eval)("(function(x){return x*2})"); f(21)` → 42.
8. Error mapping: `eval("{")` throws a catchable `SyntaxError`;
   `new Function("return", "")` throws `SyntaxError`.
9. Engine identity: `eval("typeof __js2wasm_eval_engine")` → `"string"`;
   `selection.engine === "quickjs"`.
10. Pushed-global visibility: module-level `var g = 7;` then `(0,eval)("g")`
    → 7, and `(0,eval)("g = 8")` then `g` → 8 (push/pull mirror, slice 2).
11. Direct eval refusal (slices 1–2): direct `eval("1")` in a function →
    catchable TypeError with the §4 message; replaced in slice 3 by
    snapshot-semantics cases + the recorded residual list.

**CI (non-required, per the #4013/#4243 precedent — NOT a new gate):**
extend `.github/workflows/quickjs-wasi-artifact.yml` (currently
`workflow_dispatch`-only, content-hash cached) with a second job
`quickjs-eval-provider-lane`: restore/build the artifact, run
`node scripts/build-quickjs-eval-provider.mjs`, then
`JS2WASM_EVAL_ENGINE=quickjs npx vitest run tests/quickjs-eval-provider.test.ts`.
Triggers: `workflow_dispatch` + weekly `cron` (the anti-rot requirement of
hard-constraint 3). NOT added to the ruleset's required checks
(`docs/ci-policy.md` §7 stays at six); because it does not run on
`pull_request` it also cannot drive PR `mergeStateStatus` to `UNSTABLE`.

### 7. Slice order (3 slices, one Opus implementer each)

**Slice 1 — flag + selection + acquisition + first eval (M/L).**
Files: `scripts/runtime-eval-provider.mjs` (branch + return shape),
`scripts/quickjs-eval-provider.mjs`, `scripts/build-quickjs-eval-provider.mjs`,
`scripts/quickjs-artifact/qjs_shim.c` (+`qjs_new_string_len`,
`qjs_new_undefined` at minimum), the compiler enablers
(`src/codegen/extern-declarations.ts:727-733` + option plumbing +
`importMemory`), a minimal adapter source (indirect eval of
**number-literal-only sources**; `new_function`/`apply`/`direct_eval` return
the typed refusal; engine identity global),
`tests/quickjs-eval-provider.test.ts` cases 1–4 + 9 + 11.
*Done-signal:* `node scripts/build-quickjs-eval-provider.mjs &&
JS2WASM_EVAL_ENGINE=quickjs npm test -- tests/quickjs-eval-provider.test.ts`
green locally; `npm test -- tests/issue-2928-refusal-provider.test.ts
tests/issue-2960.test.ts` green with no env set (default-path proof).

**Slice 2 — full MVP value bridge + CI lane (L).**
Full conversion table (strings both directions with UTF-8, booleans,
null/undefined, function carriers, handle boxes), `qjs_call` + remaining
shim additions, real `__runtime_new_function` + `__runtime_apply_interpreted`,
intrinsic eval/Function markers, error mapping, globals mirror (push/pull),
the canary set in the build script, test cases 5–10, the
`quickjs-wasi-artifact.yml` lane job.
*Done-signal:* all §6 cases green under the flag; a workflow-dispatch run
green; acceptance boxes 2, 3 (pass list recorded here), 5, 6 checked.

**Slice 3 — direct-eval scope snapshot + residual measurement (L).**
`with(S)`-wrap for sloppy / `const`-preamble for strict, cell write-back,
activation-state-pool integration, global-lexical-cell carrier mirror, then
run `language/eval-code/` under `JS2WASM_EVAL_ENGINE=quickjs`
(`TEST262_TARGET=standalone`, reusing the `TEST262_FULL_RUNTIME_EVAL` A/B
machinery per #2928's remeasurement template) and **record the pass/residual
numbers in this file** against the interpreter's 797/816.
*Done-signal:* acceptance box 4 checked with the measured residual list
committed here.

### Out of scope (explicit)

- Cross-heap cycle collection / handle finalization (context-lifetime leak
  accepted and documented; #988 blocks the GC-side finalizer hook).
- Any object membrane: compiled GC objects crossing into QuickJS, property
  traps on handle boxes, prototype identity at the frontier (#4236 stages
  3/5 — separate future issue).
- Full EvalDeclarationInstantiation / direct-eval var-hoisting into the
  caller varEnv; caller `super`/`new.target` (engine-permanent residual).
- Flipping the default engine or removing interpreter code (hard
  constraint 4; separate migration issue).
- The linear lane (#4236 slice 2), regex-module split (#4237),
  `-Oz`/wasm-opt artifact-size work, committing any `.wasm`.

### Risks / conflicts

- `src/codegen/extern-declarations.ts` is shared surface — check open PRs
  before slice 1 lands the enabler; the change is option-gated so conflicts
  are textual, not semantic.
- `instantiateRuntimeEvalNamespace` is imported by 6+ test files — the
  `instanceof WebAssembly.Module` discrimination keeps them untouched; do
  not change its export shape.
- The #2961 standalone hard-no-leak ratchet: land the `js2wasm:qjs`
  namespace exemption WITH slice 1, or the adapter compile trips the
  warning→error promotion when it arrives.
- Two implementation traps to call out for devs: (a) `qjs_to_f64`'s NaN is a
  value, not an error — dispatch on tag first; (b) never bind the adapter's
  qjs imports through JS wrapper closures "temporarily" — that silently
  papers over the f64/i32 signature mismatch the `externNativeTypes` enabler
  exists to fix, and violates the zero-JS acceptance criterion while
  appearing to work.
