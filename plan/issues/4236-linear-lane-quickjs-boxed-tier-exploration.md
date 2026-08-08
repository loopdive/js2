---
id: 4236
title: "exploration: QuickJS JSValue as the linear lane's BOXED tier — native representation for typed code, QuickJS for the eval-visible/dynamic frontier (Static-Hermes-shaped)"
status: backlog
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
priority: low
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: eval
goal: backend-agnostic-ir
related: [1527, 1584, 2928, 3288, 3927, 4157, 4229]
# id 4236 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-08; equivalent open-PR scan via the GitHub MCP found ZERO open PRs
# at reservation time. The id coincides with a merged PR number — PR numbers
# and issue-file ids share GitHub's sequence but not a namespace (precedent:
# issue 4235 / PR 4235 coexist).
---

# #4236 — exploration: QuickJS as the linear lane's boxed tier

## The idea (and what it is NOT)

NOT "embed QuickJS as the engine" — that is strategy 2c in
[docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md)
§3, rejected for the WasmGC lane because the AOT↔QuickJS boundary destroys
object identity (two heaps, marshalling wall, `ref.eq`/`instanceof`/direct-eval
scope capture all break).

The exploration here is narrower and dissolves that objection **for the linear
lane only** (`src/codegen-linear/`, the WASI target — see #1527's two-axis
model): both worlds already live in linear memory, so if the linear lane's
**boxed/dynamic value representation** were QuickJS's `JSValue`, eval-visible
objects would simply *be* `JSObject`s in one shared heap. Identity preserved,
no wall. Typed code keeps js2wasm's native representation (unboxed
`i32`/`f64`, native structs) and its AOT speed; only the dynamic frontier pays
QuickJS's representation.

This is the **Static Hermes architecture** (AOT-compiled typed code sharing
the VM's value representation, deferring dynamic operations to the VM),
instantiated with QuickJS-compiled-to-wasm as the VM.

## Why now — the 2026-08-08 benchmark triangle

Measured on one machine (4-core container, Node 22 / V8 wasm runtime,
quickjs-emscripten release build; scripts preserved inline below):

| acorn parsing its own 226 KB bundle | ms/parse | vs V8 |
| --- | ---: | ---: |
| Node/V8 (JIT) | 11.9 | 1× |
| **js2wasm AOT wasm** (npm-compat `standaloneDynamic` lane, same corpus/op) | **84.6** | 7.1× |
| QuickJS-wasm | 349.6 | ~26× |

| eval of a 100k-iteration loop (parse + execute per call) | ms/eval | vs V8 |
| --- | ---: | ---: |
| Node/V8 | 0.31 | 1× |
| QuickJS-wasm | 4.7 | 15× |
| **js2wasm Phase-1 interpreter** (#2928 provider) | **1857** | ~6000× |

Two facts, one design conclusion:

1. **AOT-compiled JS beats QuickJS-interpreted JS by ~4×** (84.6 vs 349.6 ms
   on identical work) — compiling wins where types/structure are static.
2. **The Phase-1 eval interpreter loses to QuickJS by ~400×** — the
   self-hosted interpreter is a correctness vehicle, not a performance one
   (globals-vs-locals only changes it ~1.7×, so it is per-operation cost, not
   a lookup pathology).

A tiered design keeps the 4× win where compilation applies and replaces the
400× loss where it does not. (For the WasmGC lane the self-hosted interpreter
remains the only option — `JSValue` cannot hold WasmGC refs.)

## Design sketch

**Representation rule:** a binding/object is QuickJS-represented iff it is
reachable by dynamic code; everything else stays native.

- **Scope frontier (syntactic, cheap):** a function textually containing
  direct `eval` (or `with`) taints all its locals — the same rule mainstream
  engines use to force context allocation. Sloppy indirect eval and
  `new Function` see only the global object. js2wasm already computes exactly
  this taint (it drives `$Frame` reification, the direct-eval state cells, and
  the global-lexical-cells carrier from the #2929 C+D work). Same analysis,
  different box.
- **Object frontier (the hard half), two candidate mechanisms:**
  1. *Tainted allocation sites* — instances that can flow into an
     eval-visible slot are allocated as QuickJS objects from birth
     (structurally the same analysis as #3927's escape gate / receiver flow).
  2. *Live exotic wrappers* — QuickJS classes with exotic get/set + opaque
     payload trampoline eval-side property ops into compiled accessors over
     the native struct; one wrapper per object via a handle table, so
     identity and two-way mutation hold, and the trampoline cost lands only
     on cold eval-side accesses.
- **ABI route: the QuickJS C API, never open-coded layouts.** Emit
  `JS_GetProperty`/`JS_Call`/`JS_NewObject`/… calls with codegen-enforced
  refcount discipline (`JS_DupValue`/`JS_FreeValue`); open-coded fast paths
  only for proven-typed operations. Internal struct layouts (NaN-boxing
  config, shapes, atoms) are not a stable ABI and vary by build flags —
  pinning to them is the failure mode to refuse up front.
- **Functions cross cheaply** both ways (`JS_NewCFunction` over
  `call_indirect`; held `JSValue` callables invoked via `JS_Call`).

## What the exploration must answer (acceptance criteria)

- [ ] A spike: link libquickjs (quickjs-ng) into a WASI module alongside
      js2wasm-compiled code sharing one linear memory; round-trip a value and
      an object through `JS_Eval` with identity preserved. Measure binary size
      (expect ~+1.2 MB) and the API-call trampoline cost.
- [ ] Decide tainted-allocation vs exotic-wrapper for the object frontier
      (or the hybrid: tainted sites for known-escaping types, wrappers for
      the residue), with a measured A/B on an eval-heavy fixture.
- [ ] String story: adopt `JSString` in the boxed tier vs convert at the
      boundary (immutable ⇒ copy is semantics-preserving; measure).
- [ ] Cross-heap cycle policy: QuickJS's cycle collector cannot see edges
      through native memory — document the leak class and the weak-wrapper
      mitigation; decide whether it is acceptable for the WASI lane.
- [ ] Split-brain audit: which builtins does the boxed tier get from QuickJS
      vs native, and where must they agree observably (prototype identity at
      the frontier is the sharp case).
- [ ] Version pin + upgrade policy for quickjs-ng.
- [ ] Honest go/no-go against the alternative uses of the same effort:
      finishing the #4157 representation program on the WasmGC lane, or the
      Porffor-adjacent linear work (#3288).

## Non-goals

- The WasmGC/browser lane — unaffected either way; its eval remains the
  self-hosted #2928 interpreter (whose OWN performance program is separate
  and should cite the 400× number as its baseline).
- Replacing the Tier-0 compile-away splice (~92% of eval sites never need any
  runtime tier).
- Any change while #2527 packaging and the linear lane's basic coverage are
  behind — this is an exploration issue, not scheduled work.

## Repro for the benchmark numbers

`pnpm add -D quickjs-emscripten` (not committed — the dependency was used
ad-hoc and reverted with the branch restart), then the two scripts recorded in
the session log of 2026-08-08: acorn corpus =
`node_modules/.pnpm/acorn@8.16.0/node_modules/acorn/dist/acorn.mjs` parsed
with `{ecmaVersion: 2022, sourceType: "module"}`, checksum `.body.length`
(matches the npm-compat perf lane's sampleOp); eval workload =
`(function(){ var s = 0; for (var i = 0; i < 100000; i = i + 1) { s = s + i; } return s; })();`
through the #2928 provider's four-import seam, QuickJS `evalCode`, and Node
indirect eval. js2wasm AOT number from
`node --import tsx scripts/generate-npm-compat-report.mjs --only acorn
--perf-only --lane standalone-dynamic` (wasmUs 84576, nodeUs 11913).
