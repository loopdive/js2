---
id: 1066
title: "Support eval in standalone mode via host-compiled Wasm child module"
status: ready
created: 2026-04-11
updated: 2026-04-11
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
language_feature: eval
goal: platform
model: fable
fable_role: spec
sprint: Backlog
depends_on: [1164, 1058]
required_by: [1584]
es_edition: multi
---

# #1066 — Support `eval` in standalone mode via host-compiled Wasm child module

Companion to **#1006** (eval via JS host import). #1006 covers the JS-host mode
path where `eval` trampolines back to a real JavaScript runtime. This issue
covers the standalone / non-JS path where no host JavaScript engine is
available and the host is expected to be a pure Wasm runtime such as
`wasmtime`, `wasmer`, or any WASI-capable runtime.

## Goal

Define a **portable host-import eval interface** that standalone hosts can
implement by invoking js2wasm itself to compile the eval'd source string into
a fresh Wasm child module, instantiating it, and returning the evaluated
result. The call-site contract is identical to #1006 — the compiler lowers
`eval(...)` to a host import with the same shape — but the host side uses
**Wasm-to-Wasm recursive compilation** instead of delegating to a JS engine.

This preserves the dual-mode architecture principle (#679 dual string backend,
#682 dual RegExp backend): every feature that works in JS-host mode must have
a standalone implementation path, even if slower and more constrained.

## Design sketch

### Interface (same shape as #1006)

A single host import with signature approximately:

```wit
// eval-host.wit (draft)
interface eval-host {
    /// Evaluate a source string and return the serialized result.
    /// source:  the source text to evaluate
    /// direct:  1 = direct eval (inherits caller scope), 0 = indirect (global)
    /// returns: a tagged union: ok(externref) | throw(externref)
    eval: func(source: string, direct: u32) -> result<externref, externref>
}
```

The compiler emits the same call in both modes. In JS-host mode the import is
backed by a JavaScript shim that calls native `eval`/`Function`. In standalone
mode the import is backed by a Wasm-native implementation below.

### Standalone implementation strategies

**Option A — js2wasm as a library in the host process (recommended reference)**

The host embeds the js2wasm compiler itself and on each `eval(...)` call:

1. Compiles the source string through `compileMultiSource` with
   `{ target: 'wasi', allowJs: false }`
2. Wraps the source in a function body that returns the evaluated expression
3. Instantiates the resulting module using the same WASI context as the parent
4. Calls the wrapped entry, captures return or trap
5. Marshals the result back across the host-import boundary

Pros: no runtime dependency on a JS engine; reuses the existing compiler.
Cons: compilation latency on every call; standalone deployment must ship the
compiler.

**Option B — pre-compiled eval snippet cache**

For workloads where eval strings are known ahead of time (common in test262
tests), allow eval expressions that the static analyzer can resolve to be
compiled AOT into per-call functions and dispatched through an indirect call
table. Only fall back to Option A for truly dynamic strings.

Pros: zero runtime overhead for common cases.
Cons: misses genuinely dynamic eval. Layer on top of Option A, not a replacement.

**Option C — reference wasmtime host implementation**

Ship a reference host in `runtimes/eval-host-wasmtime/` (Rust + wasmtime) that
implements the `eval-host` WIT interface by shelling out to the js2wasm CLI
or linking the compiler as a Rust-native library via N-API. This becomes the
portable reference implementation; other hosts (wasmer, browser-wasm-runtime,
etc.) can mirror its contract.

### Portable API vs wasmtime-specific

Ideal: standardize the `eval-host` interface as a **WIT world** so any WASI
Preview 2 / Component Model host can satisfy it. Until the Component Model
stabilizes, ship a wasmtime-specific reference implementation **with identical
semantics to the planned WIT world** so migration is mechanical.

Avoid wasmtime-specific ABI leakage: the guest-side import signature should be
expressible as plain WIT with no runtime-specific extensions.

## Scope

1. Define the `eval-host` WIT interface (draft in this issue, ratify in a
   follow-up once #1006 lands and the JS-host shape is fixed)
2. Make the compiler emit the same host-import shape in both modes
   (`--target wasi` vs `--target js`) with the import wired to different
   providers
3. Ship a reference host implementation in Rust + wasmtime that recursively
   compiles + runs the eval'd source
4. Integration tests that run test262 eval-positive cases under the standalone
   host and confirm parity with the JS-host path
5. Documentation: dual-mode architecture note explaining when eval is expected
   to work standalone vs the JS-host fast path

## Non-goals

- Full JavaScript engine inside Wasm — this is recursive js2wasm compilation,
  not a general interpreter
- Direct-eval scope capture semantics beyond what the compiler can statically
  prove — direct eval in standalone mode MAY behave as indirect eval where the
  caller scope cannot be reified
- Compile-time eval (folding `eval("1+2")` to `3` at compile time) — that's a
  separate optimization, see #1006 for the static-resolution discussion
- Shipping the compiler inside every deployed standalone binary — hosts that
  do not need eval can omit the import and the compiler from their runtime

## Relationship to #1006

- **#1006** ships first: JS-host shim, compiler call-site lowering, test262
  baseline parity
- **#1066** lands after: standalone wasmtime reference host, WIT interface
  draft, dual-mode parity tests

Both issues share the same guest-side code path. Only the host-provider side
differs.

## ECMAScript spec reference

- [§19.2.1 eval(x)](https://tc39.es/ecma262/#sec-eval-x) — global eval semantics
- [§19.2.1.1 PerformEval](https://tc39.es/ecma262/#sec-performeval) — parsing and evaluation in the caller's variable environment

## Acceptance criteria

- [ ] WIT interface draft for `eval-host` committed under `wit/eval-host.wit`
- [ ] Compiler emits the same import shape under `--target wasi` as under
      `--target js`, wired to different provider names
- [ ] Reference wasmtime host in `runtimes/eval-host-wasmtime/` compiles and
      runs `eval("1 + 2")` returning `3` round-tripped through the WIT boundary
- [ ] Reference host handles throw-and-rethrow (e.g. `eval("throw 1")`
      propagates as a Wasm trap translated to the guest's throw tag)
- [ ] At least 10 test262 eval-positive cases pass under the standalone host
      with results identical to the JS-host path
- [ ] Dual-mode architecture doc updated to list eval as a dual-mode feature
      with standalone limitations documented

## Risks

- **Compilation latency**: recursive compile on each call is expensive. Cache
  by source-string hash to amortize within a single execution.
- **Memory pressure**: each compiled child module holds a non-trivial amount
  of state. Consider reusing a single compiler instance across eval calls.
- **Scope capture**: direct eval with `var` declarations visible to the caller
  is the hardest case. Document the boundary; standalone may only support
  indirect-eval semantics initially.
- **Security**: a standalone host that can compile arbitrary source is a
  dynamic-codegen surface. WASI deployments that care about determinism or
  sandboxing should be able to opt out by not linking the eval provider.

## Long-term native path: `func.new`

The [Wasm JIT interface proposal](https://github.com/WebAssembly/jit-interface/blob/main/proposals/jit-interface/Explainer.md)
(`func.new`) is the eventual native replacement for both this issue and #1164.
Once `func.new` ships in Wasm runtimes (tracked in #1165):

- js2wasm compiled to Wasm (#1058) generates bytecode for the eval string
- `func.new` materialises it as a funcref — no recursive host process needed
- Works in any `func.new`-capable Wasm runtime, not just wasmtime

This issue's wasmtime-specific approach is the interim path until `func.new`
is widely available.

## Notes

- Parallels the dual-mode architecture principle: JS-host is the fast path,
  standalone is the portable path, both reach spec-level correctness on the
  shared subset.
- Opens the door to `Function(...)` constructor support as a follow-up via
  the same mechanism.
- The WIT interface design should ideally be proposed upstream so other
  TypeScript/Wasm compilers could implement the same host contract.

## Implementation Plan (added 2026-05-21)

### Entry points

- New `wit/eval-host.wit` — interface definition (Option A reference)
- New `runtimes/eval-host-wasmtime/` (Rust crate) — reference standalone host
- `src/codegen/typeof-delete.ts` — wherever `eval(...)` is currently lowered (`grep -n eval`); ensure WASI target emits the same import shape
- `src/cli.ts` — accept `--eval-host=auto|wasm|disabled`

### Algorithm

1. **Guest-side codegen** (unchanged from #1006): every `eval(s)` becomes:
   ```wasm
   local.get $s_externref
   i32.const <direct_flag>
   call $__eval_host_eval
   ```
   The import signature is `(externref, i32) -> externref`; throw maps to the guest's exception tag.
2. **Reference host** (Rust):
   - Embed js2wasm as a library; if not, shell out to the `js2wasm` CLI with `--target wasi --stdin`.
   - For each `eval` invocation: hash source; lookup in LRU cache (key = source-string SHA256); on miss, compile and instantiate; on hit, just instantiate.
   - Wrap the source as `(function() { return (\n${source}\n); })()` for expression form; detect statement-form source and emit `void (function() { ${source} })()` instead.
   - Run the child module under the same WASI context; capture return as externref or trap as throw.
3. **Cache**: source → compiled-module map, sized to e.g. 64 entries with LRU eviction.

### Wasm output (guest side)

```wasm
(import "env" "__eval_host_eval" (func $eval (param externref i32) (result externref)))
```

For WASI target, the import module name becomes `"eval-host"` to match the WIT mapping.

### Edge cases

- **Direct eval scope capture**: standalone mode cannot reify the caller's variable environment. Per the design, treat direct eval as indirect in standalone mode (document limitation).
- **Throws**: the host returns a "result" envelope `{ ok | throw }` via a 2-cell struct, or the import returns externref and re-throws on the guest side via a sentinel tag.
- **Strict mode propagation**: pass a third arg `strict: i32`.
- **Recursive eval (eval inside eval)**: child module instantiates a new host context; cache is shared.
- **Security**: gate behind explicit `--enable-dynamic-codegen` flag in the standalone host; default OFF.

### Test plan

- `tests/issue-1066-standalone-eval.test.ts`:
  - `eval("1+2")` → 3
  - `eval("throw 1")` → caught by guest's `try/catch`
  - Direct-eval `var` declaration (must explicitly fail with a clear message in v1)
- Cross-mode parity: same test files compiled with `--target js` and `--target wasi` produce identical results for indirect-eval cases.

### Dependencies

- **Hard**: #1006 (JS-host eval) — lands first; this issue mirrors its import shape
- **Hard**: #1058 (js2wasm self-host) — required to embed compiler as a library; until then, shell out to CLI
- **Soft**: #1165 `func.new` proposal — eventually replaces this approach

### Files touched

- new `wit/eval-host.wit`
- new `runtimes/eval-host-wasmtime/` (Rust crate)
- `src/codegen/typeof-delete.ts` (eval call lowering, if target-aware)
- `src/cli.ts` (`--eval-host` flag)
- new `tests/issue-1066-standalone-eval.test.ts`

## Implementation Plan (Fable, 2026-07-18) — re-grounded against the tier ladder

> **Everything above this section predates the eval tier ladder and must not
> be implemented as written.** The authoritative strategy is
> `docs/architecture/runtime-eval-interpreter.md` (Part II wins; §12 routing
> table, §16 slice sequencing). Verified state 2026-07-18: #1006/#1164
> (Tier 1 host shim) done; #1102 (Tier-0 constant-frontier widening, PR
> #3113) done; #2960 (Tier-3 refuse-loudly) done; #2927 `ready`
> (sprint: current), #2928/#2929 backlog. The **standalone-primary answer to
> dynamic eval is Tier 2** — the embedded self-compiled bytecode interpreter
> (E-slices, §16) — NOT this issue's recursive-host-compilation design.

### Where this issue now fits: "Tier 1w" — host-provided eval for pure-Wasm embedders

The ladder's Tier 1 assumes a _JS_ host. This issue's surviving, real use
case is an embedder running wasmtime/wasmer-class runtimes who is willing to
ship js2wasm on the host side and wants eval without paying Tier 2's
in-module interpreter size (§16 E6 floor). That is a **host-choice rung
parallel to Tier 1** (same "meta-circular recompile" mechanism, different
host language), NOT a conformance rung: the test262 CI standalone lane runs
no such host, so **this issue buys zero conformance points** — Tier 0
(landed) and Tier 2 (E2/E3) own the standalone cliff (~490
currently-trapping tests, doc §5.3). Its value is embedder capability + the
Component-Model-facing WIT artifact none of the E-slices produce.

### Options considered (recommendation: Option 3)

1. **Build now as originally spec'd** (WIT `eval: func(source, direct)` +
   Rust/wasmtime host). REJECTED as written — two defects: (a) the drafted
   import shape has **no environment handle and no strictness**, so the
   child module compiles free identifiers against its own empty globals —
   recreating exactly the #3017 `ReferenceError`-shape/global-sharing bug
   class the doc's §14 unified name-resolution semantics exists to fix;
   (b) it duplicates Tier 2's win at high host-integration cost while
   Tier 2 is already the committed direction.
2. **Close as superseded by Tier 2.** REJECTED — the embedder story and the
   WIT standardization are real and not covered elsewhere; and Tier 2's E6
   size analysis may itself motivate a host-provided option for
   size-constrained deployments.
3. **Keep, re-chartered as Tier 1w, sequenced AFTER #2928 E2/E3 land**
   (RECOMMENDED). The interface is designed to be observably equivalent to
   Tiers 1/2 on name resolution (§14), so a program migrated between modes
   behaves identically. Stays `sprint: Backlog`; do not schedule into a
   budget window before E2/E3 — sequencing it earlier would spend the eval
   budget twice.

### Phases (each independently landable)

**P0 (S) — WIT world draft, §14-aligned.** `wit/eval-host.wit`:

```wit
interface eval-host {
    resource js-env {            // §14 object-record protocol over the
        get: func(name: string) -> result<value, missing>;   // parent's
        set: func(name: string, v: value) -> result<_, err>; // globalThis
        has: func(name: string) -> bool;
        delete: func(name: string) -> bool;
    }
    enum mode { direct, indirect, function-ctor }
    eval: func(source: string, mode: mode, strict: bool,
               global-env: borrow<js-env>) -> result<value, thrown>
}
```

The load-bearing delta vs the old draft is `js-env`: a WasmGC `$Object`
cannot cross a WIT boundary, so the parent module exports the object-record
_protocol_ (get/set/has/delete over its globalThis) and the host threads it
into every child module it compiles — child free-identifier misses walk this
record and throw the §14 root-miss `ReferenceError`, and an eval'd
`var x = 1` lands in the PARENT's globals (visible to AOT code, §4.3), not
the child's. Mirror whatever concrete host-shim linkage #3017-gap-2 lands
for Tier 1 — that work defines the guest-side calling convention this WIT
world formalizes; do not invent a second one. Direct-eval scope capture:
out of scope for v1 exactly as Tier 1's is (#2925's reified declarative
record slots in later as an additional chain-head parameter — leave a
reserved option, do not block on it).

**P1 (S) — guest-side opt-in routing.** New flag (`--eval-host`, default
OFF). Default standalone behavior is UNCHANGED — Tier-3 refuse-loudly
(#2960) stays, satisfying ladder invariant L1 and the dual-mode rule ("no
host import without a standalone fallback" — the fallback IS Tier 3). With
the flag on, the Tier-3 throw sites in `src/codegen/expressions/calls.ts`
(eval) and `src/codegen/expressions/new-super.ts` (`new Function`) emit the
`eval-host` import instead. Routing-rule-3 compliance: this replaces a
throw with an execution — the only allowed direction.

**P2 (L) — reference host.** Pragmatic correction to the old plan: the
natural reference host is a **Node-based WASI runner embedding the compiler
in-process** (`compileSourceSync`, LRU keyed on source hash — the same cache
discipline as `createEvalShim`), landed under `runtimes/eval-host-node/`.
A Rust+wasmtime host that shells out to the CLI is the _portability proof_,
second, and only if an embedder actually asks — do not gate the issue on
writing Rust. Security: the host gates dynamic codegen behind an explicit
opt-in, default off.

**P3 (M) — cross-tier parity harness.** Same fixture programs through
Tier 1 (JS host) and Tier 1w; results identical on the indirect-eval /
`Function`-ctor subset; ≥10 test262 eval-positive cases (the original AC),
plus the throw-propagation case (`eval("throw 1")` → catchable in the
guest). Assert the §14 semantics specifically: free-var miss →
`ReferenceError`; eval'd `var` visible to the parent.

### Dependencies (corrected)

- **Hard**: #3017 gap 2 (defines the env-handle linkage this formalizes);
  #2928 E2/E3 (sequencing gate, see Option 3 rationale).
- **Dropped**: #1058 self-hosting is NO LONGER a hard dependency — the P2
  host embeds the TS compiler in a Node process or shells out; self-hosted
  compiler-in-Wasm remains the long-term `func.new` path (the existing
  "Long-term native path" section stands).
- #1102 is **done** (PR #3113) — its Tier-0 leg is landed; nothing in this
  issue reopens it.

---

## Measured evidence — the standalone-only eval cost (2026-07-25, #3631 partition)

Baselines: `test262-current.jsonl` and `test262-standalone-current.jsonl`
(`loopdive/js2wasm-baselines`), both fetched 2026-07-25 18:21. Population =
ES5-classified (post-#3626 classifier), `eval`-dependent, **775 tests** in both
lanes. Standalone uses the host-free pass definition (`--host-free`: a `pass`
carrying `host_import_leak_class` is demoted).

| lane                   | pass | not passing |
| ---------------------- | ---- | ----------- |
| host                   | 291  | 484         |
| standalone (host-free) | 143  | **632**     |

**149 of these tests pass in the host lane and fail in standalone.** Of those,
**110 fail with literally `TypeError: dynamic eval is not supported in
standalone mode`** — the folded path declined the body (constant string, but a
node kind `allNodesInlineSupported` rejects) and there is no host fallback to
catch it. Path split of the 149: 88 `annexB/language/eval-code`, 18
`language/statements/function`, 5 each `language/eval-code/{direct,indirect}`,
5 `language/expressions/object`, 5 `built-ins/String/prototype`, 4
`language/literals/regexp`, remainder in ones and twos.

This is the concrete, measured statement of the asymmetry that motivates this
issue: **in the host lane a folder bail is harmless (it routes to a working host
eval); in the standalone lane a folder bail is a hard failure.** Any claim that
"widening the constant folder is not worth it" is a **host-lane-only** claim —
it does not transfer here.

Sizing caveat (gates ≠ flips): 88 of the 110 are `annexB/language/eval-code`,
which pass at only 19 % in the host lane even with a working eval. Removing the
standalone bail unmasks them; it does not by itself flip them. See #2200.
