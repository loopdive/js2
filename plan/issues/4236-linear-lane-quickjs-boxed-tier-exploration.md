---
id: 4236
title: "exploration: QuickJS JSValue as the linear lane's BOXED tier — native representation for typed code, QuickJS for the eval-visible/dynamic frontier (Static-Hermes-shaped)"
status: backlog
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
# 2026-08-08 (later): "## Design variant C" appended — QuickJS as the eval
# ENGINE for the WasmGC lane behind the existing js2wasm:runtime-eval provider
# seam, with a code-grounded staged effort estimate and an ABI probe record.
# 2026-08-08: acceptance box 1 (the link/identity/measurement spike) executed —
# see "## Spike findings". Status stays `backlog`: the exploration's remaining
# boxes (frontier A/B, strings, cycle policy, split-brain audit, version pin)
# are untouched, and the WASI-standalone artifact is still blocked.
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

- [x] A spike: link libquickjs (quickjs-ng) into a WASI module alongside
      js2wasm-compiled code sharing one linear memory; round-trip a value and
      an object through `JS_Eval` with identity preserved. Measure binary size
      (expect ~+1.2 MB) and the API-call trampoline cost.
      → **Done 2026-08-08, see "Spike findings" below.** Identity + round-trip
      PROVEN over one shared memory (503 KB / 234 KB gz, 1.86 ns trampoline).
      The *WASI-standalone* half is NOT proven — no wasi-sdk build was
      obtainable in-sandbox; that is the next slice's blocker.
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
- [ ] Variant C decision — QuickJS as the eval ENGINE for the **WasmGC lane**
      behind the existing `js2wasm:runtime-eval` provider seam (see "## Design
      variant C" below): accept/reject the tiered-provider MVP, and separately
      accept/reject the full membrane program.

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

## Spike findings (2026-08-08)

Executes acceptance box 1 (the link + round-trip + measurement spike). Probe
artifacts lived in `.tmp/spike-4236/` (gitignored — every load-bearing number
and the key code is restated here so nothing dies with the worktree).

**Rung reached: R4 complete + R5 complete. R1 route (a) FAILED, route (b)
succeeded.**

### Verdict

**The one-heap identity claim is PROVEN. The standalone-link claim is NOT.**

Two wasm modules over one linear memory, driving QuickJS entirely through its
exported C-API wrappers, preserve object identity and two-way mutation with a
**1.86 ns** cross-module call cost. That is the load-bearing half of the design
and it holds. What the spike did *not* establish is that the pair can be linked
**without a JS host** — the only QuickJS-wasm build obtainable in this sandbox
is emscripten-flavoured (imports `env.emscripten_*` alongside
`wasi_snapshot_preview1`), and the toolchain to build a real WASI one is
unavailable here. Since the WASI/standalone lane is the *entire* premise of
this issue, that gap is the go/no-go blocker, not a detail.

**Signal for the next slice: GO on the architecture, BLOCKED on the artifact.**
The next slice is not codegen — it is "produce a wasi-sdk-built `libquickjs.a`
in CI and prove the link with no JS in the loop". If that cannot be produced,
the rest is moot.

### R1 — toolchain

**(a) clang/wasm-ld source build: FAILED. Two independent causes.**

1. *No WASI sysroot on the box.* `clang 18.1.3` and `wasm-ld` are at
   `/usr/bin`, and `clang --print-targets` does list `wasm32`/`wasm64`. A
   freestanding link genuinely works:
   `clang --target=wasm32 -nostdlib -Wl,--no-entry -Wl,--export-all -O2 -o t.wasm t.c`
   → 446-byte wasm. But the moment libc is involved it falls back to the *host*
   glibc headers:
   ```
   $ clang --target=wasm32-wasi -c t2.c      # t2.c: #include <stdlib.h>
   /usr/include/stdlib.h:26:10: fatal error: 'bits/libc-header-start.h' file not found
   ```
   Nothing under `/opt/wasi-sdk*`, `/usr/share/wasi-sysroot`, or any
   `*sysroot*/wasi` path exists. QuickJS needs a full libc (stdio, stdlib,
   string, math, time), so this is fatal, not a flag away.
2. *QuickJS source is unreachable.* The agent proxy gates GitHub per repository:
   `curl -L https://github.com/quickjs-ng/quickjs/archive/refs/tags/v0.10.1.tar.gz`
   returns **403** with body `{"message":"GitHub access to this repository is
   not enabled for this session. Use add_repo to request access."}` — and no
   `add_repo` tool was available to this agent. npm (which *is* reachable,
   it's in `no_proxy`) has neither the source nor a sysroot: `quickjs-ng`,
   `wasi-sdk`, `@wasmer/wasi-sdk` are all 404; the `quickjs` npm package is an
   unrelated front-end scaffold.

   → **Neither cause is about the design.** Both are sandbox provisioning. A CI
   job with `wasi-sdk` + repo access closes this.

**(b) prebuilt `quickjs-emscripten`: SUCCEEDED, and better than hoped.**

Installed out-of-tree (`npm install --no-save --prefix .tmp/spike-4236/qjs-pkg
quickjs-emscripten`) so `package.json`/lockfile stay untouched. Inspecting the
shipped `.wasm` with `WebAssembly.Module.imports/exports`:

- **The release-sync module IMPORTS its memory** (`a.a:memory`) — it does *not*
  export one. This is the single most important toolchain fact for this design:
  the embedder (or a peer module) owns the memory, so sharing is a *supported*
  configuration, not a hack. 20 imports total (1 memory + 19 functions).
- The **debug-sync** build ships **unmangled** exports: the full thin-C-wrapper
  surface (`QTS_Eval`, `QTS_NewRuntime`, `QTS_NewContext`, `QTS_NewObject`,
  `QTS_GetProp`, `QTS_SetProp`, `QTS_IsEqual`, `QTS_DupValuePointer`,
  `QTS_FreeValuePointer`, `QTS_Call`, `QTS_NewFunction`, …) **plus `malloc` and
  `free`**. Exactly the "thin C wrappers, never struct layouts" ABI this issue
  mandates — it already exists upstream and needs no new C.
- The release build's exports are minified (`QTS_Eval` → `b.pa`). The mapping is
  recoverable mechanically from the shipped glue with one regex
  (`grep -oE "(QTS_[A-Za-z0-9_]+|_malloc|_free)=[a-z]+\.[A-Za-z0-9_$]+"
  emscripten-module.mjs`), which is what the probe did. **This minification is a
  property of the npm distribution, not of QuickJS** — a source build would not
  minify. Do not design around it.

Notably the QuickJS module was instantiated **with no emscripten JS glue at
all** — an embedder-created `WebAssembly.Memory` plus 19 `() => 0` stubs. Only
**3** of the 19 stubs were ever called (two `environ_*`, one other), all
harmlessly returning 0. The runtime does not need the glue for this workload.

### R2 — shared-memory link: PASS

`module2.wat` (1,080 bytes assembled, via `wabt@1.0.39` already in the repo)
imports QuickJS's memory *object* and 12 of its C-API exports, and does real
work over the shared heap:

```wat
(import "qjs" "memory" (memory 0))
(import "qjs" "malloc"          (func $malloc (param i32) (result i32)))
(import "qjs" "QTS_Eval"        (func $eval (param i32 i32 i32 i32 i32 i32) (result i32)))
(import "qjs" "QTS_GetFloat64"  (func $getf64 (param i32 i32) (result f64)))
...
(data $d_code "40+2")                      ;; PASSIVE segment
(func $lit_code (result i32) (local $p i32)
  (local.set $p (call $malloc (i32.const 5)))          ;; QuickJS's allocator
  (memory.init $d_code (local.get $p) (i32.const 0) (i32.const 4))
  (i32.store8 offset=4 (local.get $p) (i32.const 0)) (local.get $p))
```

The **passive** data segment + `memory.init` into a `malloc`-returned pointer is
the load-bearing idiom: module 2 must never pick an absolute address in a heap
it does not own. An *active* data segment would have written at a link-time
offset straight through QuickJS's static data.

Result: `r2_roundtrip(ctx)` → **42** — module 2 authored the source bytes,
called `JS_Eval`, and read the f64 back, with zero JS in the data path.

### R3 — object identity: PASS

`r3_identity(ctx)` returns `x*10 + identity_bit`; measured **411.0**, i.e.
`x === 41` **and** `IsEqual(o, globalThis.c) === 1`. The sequence, entirely from
module 2:

1. `QTS_NewObject(ctx)` → `o`; publish as `globalThis.o` via `QTS_SetProp`
   (handing it `QTS_DupValuePointer(o)` — `SetProp` consumes a reference).
2. `JS_Eval("globalThis.o.x = 41; globalThis.c = globalThis.o;")`.
3. `QTS_GetProp(o, "x")` **through module 2's own handle** → 41. The mutation
   made by eval'd code is visible on the handle module 2 has been holding since
   step 1 — no copy, no marshalling.
4. `QTS_IsEqual(o, globalThis.c, /*strict ===*/ 0)` → 1. Same object.

Cross-checked from the JS side of the same heap:
`typeof globalThis.o + ':' + globalThis.o.x + ':' + (globalThis.o === globalThis.c)`
→ `object:41:true`.

**This is the claim §"The idea" makes, and it holds.** The 2c objection
(identity destroyed at the boundary) genuinely does dissolve when there is one
heap.

### R4 — measurements

All on the 4-core container, Node 22 (V8), `@jitl/quickjs-wasmfile-release-sync`,
median of 5–7 reps.

**Size** (`node .tmp/spike-4236/r4-sizes.mjs`):

| artifact | raw | gzip |
| --- | ---: | ---: |
| QuickJS release-sync | **503,134** | **233,588** |
| QuickJS release-asyncify | 1,027,523 | 362,445 |
| QuickJS debug-sync | 1,218,626 | 456,203 |
| js2wasm `--target linear` (tiny2.ts) | 261 | 230 |
| js2wasm `--target wasi` (tiny.ts, WasmGC) | 16,588 | 13,229 |
| `module2.wasm` (spike stub) | 1,080 | 613 |

The issue predicted **~+1.2 MB**; the real release-sync cost is **~503 KB raw /
234 KB gzip** — 2.4× better. (The 1.2 MB figure matches the *debug* build.) That
is with all intrinsics on — RegExp, Date, TypedArrays, Proxy, Promise, JSON —
so a trimmed source build lands lower. Do not take the asyncify variant: it
doubles the size and this design does not need it.

**Cross-module call cost** — a trivial leaf export (`QTS_BuildIsDebug`, no
args, no work), 20M iterations, with an identical call-free loop subtracted:

| path | gross ns/iter | net call cost |
| --- | ---: | ---: |
| module 2 → QuickJS wasm | 2.2 | **1.86 ns** |
| JS host → QuickJS wasm | 9.1 | **8.77 ns** |
| (loop baseline, no call) | 0.31 | — |

**The wasm→wasm trampoline is ~1.9 ns and is 4.7× cheaper than the JS host
boundary.** For design purposes it is free: it is ~9% of one QuickJS property
operation.

**Realistic C-API op** — `QTS_GetProp` + `QTS_GetFloat64` +
`QTS_FreeValuePointer` per iteration on a live object, 2M iterations:

| driver | ns/iteration (3 calls) | ≈ per call |
| --- | ---: | ---: |
| module 2 → QuickJS | **62.1** | 20.7 |
| JS host → QuickJS | 85.9 | 28.6 |

wasm-driven is 1.38× faster on identical work. Note the *work* (atom lookup,
property lookup, JSValue alloc/free) is ~11× the boundary — so **the tiering is
not boundary-limited**. Its cost is set purely by how much of the program lands
in the boxed tier, which is the design's own thesis and the reason the frontier
analysis (tainted-alloc vs exotic-wrapper) is where the real risk lives.

**The issue's 100k-loop eval workload**, parse + execute per call, 40 evals:

| path | ms/eval | vs V8 |
| --- | ---: | ---: |
| Node/V8 indirect eval (this box) | **0.123** | 1× |
| module 2 → `JS_Eval` (this spike) | **3.30–3.45** | ~27× |
| JS host → `JS_Eval` (raw, glue-free) | 3.29–3.37 | ~27× |
| quickjs-emscripten high-level API (recorded above) | 4.7 | 15×* |
| js2wasm Phase-1 interpreter (#2928, recorded above) | 1857 | ~6000×* |

\* the previously-recorded rows used a V8 baseline of 0.31 ms on a
differently-loaded box; the ratios are not directly comparable across rows, the
**absolute ms/eval column is**.

Two results worth keeping:

- **Driving `JS_Eval` from wasm costs nothing measurable** vs driving it from
  JS (3.30–3.45 vs 3.29–3.37 ms — the two overlap across runs). The boxed tier
  does not pay for being reached from compiled code.
- The glue-free path is **4.7 → ~3.3 ms**, so `quickjs-emscripten`'s
  `Lifetime`/handle bookkeeping is ~30% of the observed cost. A wasm-side
  caller skips it entirely. The honest headline against the alternative:
  **~3.3 ms vs the Phase-1 interpreter's 1857 ms is ~560×.**

### R5 — what the real linear lane would need (no codegen written)

Read `src/codegen-linear/{index.ts,runtime.ts,c-abi.ts}` and compiled through
the real lane. Gaps, most-blocking first:

1. **The linear lane emits ZERO imports — of any kind.** `grep -rE
   "imports\.push|addImport" src/codegen-linear/` returns **nothing**, and a
   compiled module confirms it (`--target linear` on a 3-function file →
   261 bytes, `imports: []`). The C-API call sites this design needs would be
   the *first* imports the lane has ever emitted. This is the largest single
   gap.
   - *Encouraging*: the index arithmetic is already parameterised —
     `ctx.numImportFuncs` exists in `context.ts` and is used at
     `index.ts:159/213/258/326/388/5186/5521`; it is merely hard-coded to `0` at
     both entry points (`index.ts:144` and `index.ts:311`). So imports are
     index-safe **provided they are added before codegen starts**. Do not
     replicate the WasmGC lane's late `addUnionImports` index-shifting.
2. **`c-abi.ts` is export-direction only.** `mapParamsToCabi` /
   `mapResultToCabi` / `emitCabiWrappers` (c-abi.ts:106/169/217) describe *what
   a C host can call in us*. There is no way to declare `extern JSValue*
   JS_GetProperty(...)` and call it. The import direction — an extern-C
   declaration table plus an opaque `JSValue*` handle type in the type system —
   is new surface.
3. **Memory ownership must be inverted or negotiated.**
   `addRuntime` (`codegen-linear/runtime.ts:84-95`) unconditionally does
   `mod.memories.push({ min: 1, max: 256 })` and exports it; verified in the
   emitted wat: `(memory 1 256)`. `--target wasi` likewise self-defines
   (`codegen/wasi.ts:127`). Neither can import one today.
   - *Encouraging*: the topology already exists on the **WasmGC** side —
     `--link node:fs` (#2633, `codegen/wasi.ts:97`) makes the user module
     **import memory at index 0** from an already-instantiated provider, with
     the user module declaring and exporting none. That is precisely the shape
     needed here; it just has no analogue in `codegen-linear/`.
   - Direction to prefer: QuickJS release-sync **imports** memory, so js2wasm
     can keep ownership (define + export) and QuickJS imports it. That inverts
     the gap in our favour — but see (4).
4. **The bump arena and QuickJS's allocator cannot coexist unmodified.**
   Measured in the shared memory (`r5-addrmap.mjs`): QuickJS's **first
   `malloc()` returns 5,333,128 (0x516088)** — ~5.1 MiB of emscripten static
   data + stack sits below it. js2wasm's linear `__heap_ptr` initialises to a
   hard-coded **1024** (`tiny2.wat:3`), i.e. **5,332,104 bytes inside QuickJS's
   region**. On top of that, `__malloc` emits its own `memory.grow`
   (`tiny2.wat:35`) while emscripten grows via `emscripten_resize_heap`/sbrk
   with its own `DYNAMICTOP` — two independent growers over one memory is a
   corruption hazard, not a tuning issue. And `max 256` pages (16 MiB) is a hard
   cap below what a QuickJS heap wants. The clean answer is the design's own:
   **the boxed tier allocates from QuickJS's `malloc`**; the arena keeps only
   the native tier and must be relocated above QuickJS's region (or made
   dynamic).
5. **No standalone (non-emscripten) QuickJS artifact exists.** The available
   build imports `env.emscripten_date_now`, `env.emscripten_resize_heap`,
   `env._mmap_js`, `env.__syscall_*` etc. alongside
   `wasi_snapshot_preview1.*`. A WASI-lane deployment cannot satisfy `env.*`.
   Blocked on R1(a) — needs a wasi-sdk source build.
6. **Refcount discipline is a codegen obligation, and the spike already hit
   it.** `QTS_SetProp` consumes a reference; the R3 probe only worked because it
   passed `QTS_DupValuePointer(o)` and kept its own. Any lowering that emits
   `SetProp`/`Call` must own this, per the issue's ABI rule.
7. **Linear-lane coverage is thinner than the design assumes.** `--target
   linear` on `return "n=" + n` fails wasm **validation**, not codegen:
   `Compiling function #51:"greet" failed: f64.add[0] expected type f64, found
   call of type i32` — a stack-type bug in the linear string-concat path. The
   non-goal "no work while the linear lane's basic coverage is behind" is
   accurate and this is a live instance of it.

### Not established by this spike (deliberately)

- Standalone/WASI linking with no JS in the loop (blocked, see R1(a)/R5#5).
  **The JS in the R2/R3 wiring is only the instantiation harness** — it hands
  the `Memory` object and the export table across — but a real WASI artifact
  needs a wasi-sdk build to exist at all.
- Cross-heap cycle leaks (QuickJS's cycle collector cannot see edges through
  native memory) — untested, still an open acceptance criterion.
- Tainted-allocation vs exotic-wrapper A/B on an eval-heavy fixture — untested.
- The acorn/parse workload through the boxed tier — untested.
- String story (`JSString` adoption vs boundary conversion) — untested.

### Repro

```bash
cd <worktree>
pnpm install --prefer-offline
mkdir -p .tmp/spike-4236/qjs-pkg && cd .tmp/spike-4236/qjs-pkg
npm install --no-save --prefix . quickjs-emscripten   # out-of-tree, never committed
cd -
node .tmp/spike-4236/r1-inspect.mjs                     # R1(b) memory-import + export surface
node .tmp/spike-4236/r1-inspect.mjs .../quickjs-wasmfile-debug-sync/dist/emscripten-module.wasm
node .tmp/spike-4236/build-module2.mjs                  # WAT -> module2.wasm via wabt
node .tmp/spike-4236/r2a-jshost-smoke.mjs               # glue-free instantiation, JS_Eval -> 42
node .tmp/spike-4236/r2r3-link.mjs                      # R2 -> 42, R3 -> 411
node .tmp/spike-4236/r4-bench.mjs                       # trampoline + eval timings
node .tmp/spike-4236/r4-sizes.mjs                       # raw/gzip table
node .tmp/spike-4236/r5-addrmap.mjs                     # QuickJS heap base vs js2wasm arena
node --import tsx src/cli.ts .tmp/spike-4236/tiny2.ts --target linear -o .tmp/spike-4236/out-linear
node .tmp/spike-4236/r5-inspect-js2wasm.mjs .tmp/spike-4236/out-linear/tiny2.wasm
```

## Design variant C — QuickJS-as-eval-engine for the WasmGC lane, via handles + exotic wrappers (arch, 2026-08-08)

Variants A/B above are linear-lane: they make QuickJS's `JSValue` the boxed
*representation*. Variant C targets the **WasmGC lane** and deliberately does
NOT touch representation — it cannot: a WasmGC module has no linear memory to
share with QuickJS, and wasm provides no way to store a GC ref into linear
memory, so representation unification is impossible **by construction**. All
typed code keeps its WasmGC representation. QuickJS (its own wasm module, its
own linear memory) is used purely as the **eval engine**, connected through a
handle-based proxy membrane. The frontier is the SAME eval-taint analysis the
compiler already runs (`functionMayReachDirectEval` /
`collectDirectEvalBindingNames` in `src/codegen/direct-eval-environment.ts:37/64`
— the analysis that drives ref-cell promotion, the direct-eval state cells, and
the C+D global-lexical-cells carrier).

**Beneficiary, precisely:** the `--standalone` WasmGC target. In default
gc/js-host mode dynamic eval routes to the host's real eval
(`emitDynamicNewFunctionHostEval`, `eval-inline.ts:2103`, gated
`if (noJsHost(ctx) …) return undefined`) and is already fast. The 1857 ms
Phase-1 number is the standalone `js2wasm:runtime-eval` provider — that is what
variant C would replace or tier. Consumers exist (#4229 playground REPL runs on
exactly this provider).

### The load-bearing question first: is this just another provider behind the seam?

**Yes — with three named caveats.** The entire user-module/compiler side is
UNCHANGED. This dominates the estimate: variant C is provider-side work, not a
compiler rewrite.

Read from `src/codegen/expressions/runtime-eval-provider.ts` and
`src/codegen/expressions/eval-inline.ts` (current main, c795d299):

| seam import (`js2wasm:runtime-eval`) | signature | declared at |
| --- | --- | --- |
| `__runtime_direct_eval` | `(externref ×10, i32 strict, externref mappedNames) → externref` | runtime-eval-provider.ts:668-687 |
| `__runtime_indirect_eval` | `(externref source, externref globalEnv) → externref` | eval-inline.ts:1899-1905 |
| `__runtime_new_function` | `(externref params, externref body, externref globalEnv) → externref` | eval-inline.ts:2000-2006 |
| `__runtime_apply_interpreted` | `(externref callable, externref this, f64 argc, externref ×8) → externref` | eval-inline.ts:2029-2035 |

Every value crossing the seam is `externref`/`i32`/`f64` — **no i64 anywhere in
the seam**. The seam contract is however MORE than four signatures; a
variant-C provider must honor all of it:

1. **`[ok, value]` result envelope** — decoded caller-side via
   `__extern_get_idx`/`__is_truthy` + `buildRuntimeEvalValueUnwrap`
   (`emitRuntimeEvalResultUnwrap`, runtime-eval-provider.ts:385-428). The
   envelope is a structurally-canonical externref vec carrier; a thrown value
   rides the same vector because exception tags are module instances, not
   structural (comment at :376-384).
2. **Callable rec-group ABI** — interpreted callables returned by the provider
   must be the exact 8-slot `makeInterpClosure` shape; the caller seeds the
   matching rec-group locally so WasmGC structural canonicalization makes the
   two modules' types identical (`ensureRuntimeEvalCallableCarrier`,
   eval-inline.ts:2020-2048).
3. **Push/pull globals + ordered-initializer contract** — the caller runs
   `__runtime_eval_push_globals` before and `__runtime_eval_pull_globals` after
   every entry (runtime-eval-provider.ts:39-41, 362-368, 388-390); global
   lexical bindings cross as live ref cells in the
   `RUNTIME_EVAL_GLOBAL_LEXICAL_CELLS_PROPERTY` carrier (:45, :132-210); direct
   eval additionally hands three name/cell vector layers + a
   `DIRECT_EVAL_STATE_BINDING_CAPACITY = 64` persistent state-cell pool (:39,
   :512-558) whose cells the engine must read/write LIVE (interpreter stores
   update canonical AOT cells directly — the provider side consumes them in
   `src/interp/eval-environment.ts:34-45`).

**The consequence that shapes everything:** those cells, vecs and callables are
WasmGC values. A linear QuickJS module cannot mint, hold or trap on them. So
the variant-C provider is a **sandwich**:

```
user module ──(js2wasm:runtime-eval, externref ABI, UNCHANGED)──▶ GC adapter
GC adapter ──(handle/pointer ABI, i32-in-f64 + shared memory)──▶ QuickJS wasm
QuickJS ──(env.* host-callback imports = membrane hooks)──▶ GC adapter exports
```

The GC adapter is a js2wasm-compiled TS module (built exactly like today's
provider — `scripts/build-runtime-eval-provider.mjs` /
`buildRuntimeEvalProviderSource`), which guarantees for free that its envelope
vecs, ref-cell reads and 8-slot callable carriers are structurally canonical
with the user module. The one packaging invariant that breaks: `verifyProvider`
(build-runtime-eval-provider.mjs:52-57) requires **zero imports**; a variant-C
provider is a 2-module bundle plus a link recipe (instantiate QuickJS first
with memory + stubs, then the adapter with `qjs.*` bound to QuickJS exports and
the hook imports bound to adapter exports via the host trampoline).
`instantiateRuntimeEvalNamespace` and the cache-key machinery need a
multi-module-aware variant — contained in `scripts/runtime-eval-provider.mjs`.

### ABI probe — is the adapter authorable in js2wasm-compiled TS? (probe record, run 2026-08-08)

Probe: `.tmp/probe-4236c/adapter-probe.ts` (gitignored; restated fully here),
compiled `node --import tsx src/cli.ts … --standalone`:

```ts
type i32 = number;
declare function qts_eval_num(ctx: number, ptr: number): number;
declare function qts_free_big(v: bigint): bigint;
declare function qts_getprop_i32(ctx: i32, obj: i32): i32;
export function drive(a: number): number { /* calls all three */ }
```

Results (import section of the emitted standalone binary, verified by
instantiation with JS stubs — `drive(5)` returned the expected 33):

1. **`declare function` externs WORK in the GC lane** and SURVIVE into the
   standalone binary as `env.*` function imports
   (`collectExternDeclarations`, `src/codegen/extern-declarations.ts:643-736` →
   `addImport`, registry/imports.ts:54). Each import currently fires the #2961
   "host import leak" *warning* (not an error) because `qts_*` is not on
   `src/codegen/host-import-allowlist.ts`. Before #2961 ratchets standalone to
   hard-no-leak, variant C needs either allowlist entries or — better,
   following the `RUNTIME_EVAL_IMPORT_MODULE` precedent — a dedicated import
   namespace (`js2wasm:qjs`). S-size compiler change.
2. **`number` params map to f64** (`(f64, f64) → f64` observed). The
   `type i32 = number` native annotation is **NOT honored on extern
   declarations** — `qts_getprop_i32` got the identical f64 type, because
   extern-declarations.ts:728 maps params via `mapTsTypeToWasm` (checker type
   → `numberType` → f64, `src/checker/type-mapper.ts:52-67`) and never
   consults `nativeTypeFromTypeNode`
   (`src/codegen/native-type-annotations.ts:109` — the alias identity only
   survives syntactically). Fix = prefer `nativeTypeOfDeclaration(p)` at that
   one site: S-size.
3. **`bigint` params produce a REAL i64 import** (`(i64) → i64` observed) and
   the call convention works end-to-end (literal `1n` crossed as BigInt 1n,
   result consumed). So a raw-JSValue-as-i64 ABI is authorable today via
   `bigint`-typed externs, with the caveat that the i64 is bigint-branded
   (type-mapper.ts:45-50) and must be kept out of dynamic/boxing contexts.

**ABI recommendation: the handle/pointer ABI — JSValues never leave QuickJS.**
This is what quickjs-emscripten's `QTS_*` C wrappers already are (spike R1(b)):
every `JSValue` is passed as a **pointer** (i32) to a heap cell inside
QuickJS's own memory, exact in f64. No i64 needed at all; the split-hi/lo
workaround is moot. With a JS host in the instantiation loop (Node test262
harness, browser), even the f64-vs-i32 type mismatch dissolves for free — the
import is a JS function calling the QuickJS export, and JS number conversion
bridges the types with zero compiler change. Only a pure wasm-to-wasm link
(wasmtime) needs the S-size native-i32-extern fix (or a generated shim module).

Two further enablers, both already in the tree:

- **The adapter can read/write QuickJS's memory directly.** `wasm:memory`
  accessors `store32/load32/store8/load8` lower to INLINE memory ops
  (`src/codegen/raw-wasi-api.ts:25-55`), and the memory-import-at-index-0
  topology exists on the WasmGC side (#2633, `src/codegen/wasi.ts:89-100`). So
  the adapter can `malloc` (QuickJS export) + write UTF-8 source strings and
  read C strings back without any per-byte trampolining.
- **Handle registry needs no wasm table.** The seed analysis proposed pinning
  GC objects in a wasm table; simpler and authorable today: a plain adapter-TS
  `const handles: any[] = []` (a GC array of anyref) + freelist. Handle =
  index; pin = held slot; release = null + freelist push. Tables buy nothing
  here.

### Membrane design (corrected from the seed analysis)

- **Forward (GC object visible to eval'd code):** one QuickJS-side wrapper per
  handle. MVP mechanism: a QuickJS-side **`Proxy`** created by a small
  bootstrap script run at context init — NOT a custom exotic class — whose
  handler traps call C-function callbacks (`QTS_NewFunction` /
  the host-callback env imports that are among the 19 imports the spike
  stubbed). Those callbacks are adapter **exports**: resolve handle → property
  op through the #4194 dynamic dispatch/accessor substrate (the same
  `__carrier_bag_of`/expando MOP the interpreter uses). Dedup map
  handle→wrapper inside QuickJS so identity (`===`) and two-way mutation hold.
  The custom-C exotic class (JS_NewClass + exotic get/set) is the
  *optimization*, requiring a source build — defer to the wasi-sdk slice.
  ⚠ Unverified: whether the host-callback trampoline works under the spike's
  glue-free instantiation (the spike never exercised `QTS_NewFunction`); this
  is stage 1's probe obligation.
- **Reverse (QuickJS value held by GC code):** primitives convert at the
  boundary (copy is semantics-preserving). Objects/functions come back as a
  GC-side carrier holding the handle-pointer, with a new "qjs-handle" arm in
  the any-dispatch (get/set/call route to `QTS_GetProp`/`QTS_SetProp`/
  `QTS_Call`), and eval-returned callables wrapped in the 8-slot carrier so
  `__runtime_apply_interpreted` keeps working unchanged.
- **Refcount discipline:** every `QTS_SetProp`/`QTS_Call` consumes a
  reference; the spike already hit this (R3 needed `QTS_DupValuePointer`).
  In variant C this discipline lives in ONE audited adapter module — far
  safer than variant A/B's plan to emit it from codegen at every site.
- **Cross-heap cycles leak bidirectionally** — neither collector traces the
  other's edges. QuickJS-side dedup map must be weak-valued (quickjs-ng lists
  WeakRef/FinalizationRegistry support — verify on the pinned build; the
  spike's `@jitl/quickjs-wasmfile-release-sync` is stock quickjs). GC-side:
  FinalizationRegistry is *unsupported in the standalone lane* (#988), so
  reverse-direction handle release has no finalizer hook — QuickJS values held
  by GC code leak until context teardown. Document as the accepted leak class
  or gate on #988; same class of accepted risk as variants A/B's cycle
  criterion above.

### Scope/global bridging

- **Global carrier (indirect eval / `new Function` — both are global-scope-only
  by spec):** for each pushed var/function binding, define the property on
  QuickJS's `globalThis`; for each C+D lexical cell, define an
  accessor property whose get/set callbacks read/write the live ref cell via
  hook exports. Pull-side is already copy-back by contract
  (`emitRuntimeEvalGlobalBindingPullBody`, runtime-eval-provider.ts:289-333).
  Mechanically straightforward.
- **Direct eval** is the hard half. The caller hands live cells; the engine
  must resolve *names* through them mid-eval. Sloppy mode: wrap the source in
  `with (scopeProxy) { … }` where scopeProxy traps into the cell layers —
  QuickJS executes it natively. Strict mode cannot use `with`: needs
  `JS_EvalThis` plus either a source transform or custom C (an internal
  scope-push QuickJS does not expose). And the caller-context semantics that
  are NOT expressible in a foreign engine at all: `super`/`new.target` **of
  the AOT caller** inside direct eval — the interpreter can own these (it owns
  its frames); QuickJS has no API to inject them. **Direct eval should stay on
  the #2928 interpreter in any near-term variant C** — which the seam makes
  trivial: route `__runtime_direct_eval` to the interpreter, the other three
  entries to QuickJS. A tiered provider mixing both engines is a natural
  configuration of the seam, not a hack.

### Conformance analysis — what QuickJS buys, honestly

(The session seed said "19 residual eval-code files"; the measured number on
current main is **32** — `plan/issues/4194-…md:912-915`: `new.target` 4,
`super` 6, `non-definable-global` 6, `var-env-*` 13, realm/lex-env-heritage 2,
this-value-func-strict-caller 1.)

- **Genuinely free inside eval'd source:** the #2928 Phase-2 emitter residuals
  — private names (4), class fields (3), tagged templates (1), catch
  destructuring — plus everything else the Phase-1/2 emitter doesn't cover.
  QuickJS is a complete engine; eval'd-code *language* completeness stops
  being our problem.
- **NOT free — moves, and probably gets harder:** the frontier classes.
  `var-env-*` (13), `non-definable-global` (6), and caller-context
  `super`/`new.target` (10) are exactly membrane/scope-bridge fidelity. The
  interpreter shares the `$Object` substrate natively; the membrane replaces
  that free sharing with trap code. Membrane semantics bound the conformance
  ceiling: `typeof`/`Array.isArray`/`Object.getPrototypeOf` on wrappers,
  prototype identity at the frontier — the split-brain audit criterion above
  applies to variant C verbatim.
- **Performance:** the honest headline stands — wasm-driven `JS_Eval` at
  ~3.3 ms vs the Phase-1 interpreter's 1857 ms on the 100k-loop workload,
  **~560×** — and the spike proved eval driven from wasm costs nothing over
  eval driven from JS. But test262 conformance is gated by semantics, not eval
  throughput; the perf win matters for real consumers (#4229 REPL).

### Staged effort breakdown (each stage independently landable)

| # | stage | size | prereqs | main risk |
| --- | --- | --- | --- | --- |
| 1 | **Browser-friendly QuickJS artifact + CI packaging.** Pin `quickjs-emscripten` release-sync (503 KB / 234 KB gz, imports its memory, glue-free instantiation proven — spike R1(b)/R2); dedicated CI job + cache key + canaries per the #4013 provider-artifact precedent; **probe the host-callback (`QTS_NewFunction`) path glue-free** — unverified, load-bearing for stage 3. The wasi-sdk source build (pure-wasm link, trimmed intrinsics, custom exotic-class C shim) is a separate follow-on slice — same R1(a) blocker as variants A/B, needs CI toolchain + repo access. | **M** (+M for the wasi-sdk follow-on) | none | callback trampoline may require emscripten glue; then stage 3's MVP mechanism needs rework |
| 2 | **GC adapter implementing the seam over the QTS handle ABI**: `__runtime_indirect_eval` + `__runtime_new_function` + result envelope + interpreted-callable 8-slot carrier + refcount discipline; source-string transport via `malloc` + `wasm:memory` accessors; multi-module packaging (`instantiateRuntimeEvalNamespace` variant, drop the zero-import invariant for the bundle). Includes the two S compiler enablers: import namespace/allowlist (`js2wasm:qjs`), native-i32 on externs (extern-declarations.ts:728). | **L** | 1 | envelope/callable structural-canonicalization subtleties (known territory — #2928 E6 solved the same class); error mapping from QuickJS exceptions into the `[ok, value]` vector |
| 3 | **The membrane**: adapter-TS handle registry (GC array + freelist), QuickJS-side Proxy wrapper bootstrap + handle→wrapper dedup, trap hooks as adapter exports → #4194 dispatch/accessors, weak dedup + finalizer→handle-release. | **XL** | 1, 2, **#4194's write half landed** | #4194 substrate maturity; wrapper exotic-behavior leaks (`typeof`, `Array.isArray`, proto identity) = split-brain surface; GC-side finalizer gap (#988) |
| 4 | **Scope/global bridging**: (4a) global carrier — pushed bindings as globals, C+D lexical cells as accessor properties: **M**. (4b) direct-eval scope chain — sloppy via `with(scopeProxy)`: **M**; strict + TDZ + caller `super`/`new.target`: **not fully reachable in QuickJS** — permanent interpreter routing for those shapes. | **L** total | 2 (4a); 3 (4b) | 4b semantic ceiling; state-cell liveness (64-cell pool must behave identically to interpreter semantics) |
| 5 | **Reverse direction**: "qjs-handle" arm in the GC lane's any-dispatch + boundary conversion table + refcount at every crossing. | **M–L** | 3 | double-membrane re-entrancy (GC wrapper of a QuickJS wrapper of a GC object must collapse to the original handle, or identity breaks) |
| 6 | **Validation**: 816-file `language/eval-code/` A/B against the #2928 interpreter provider (reuse `TEST262_FULL_RUNTIME_EVAL` + provider-cache swap — the seam makes this a pure artifact substitution); split-brain audit at the membrane; perf on the issue's workloads. | **M** | any shippable subset | none new — machinery exists (#2928 "MVP acceptance remeasurement" is the template) |

### MVP — the tiered provider (stages 1 + 2 + 4a + 6-subset)

`__runtime_indirect_eval` and `__runtime_new_function` are global-scope-only by
spec — no membrane needed IF no object crosses. Gate at the push boundary:
**if every pushed global/cell value is primitive (or an intrinsic), route to
QuickJS; otherwise route to the #2928 interpreter.** The check is O(#globals)
per entry, conservative, and sound — by construction zero regressions vs the
interpreter, while primitive-frontier eval (the entire 100k-loop benchmark
class, most REPL usage) gets the ~560×. Direct eval stays on the interpreter
entirely. The interpreter is NOT replaced at any stage: it remains the
semantic backstop (object-crossing calls, direct eval, caller-context
constructs) and the only option when the QuickJS artifact is absent. Per-call
routing is a runtime decision inside the adapter — the seam sees one provider.

MVP total: **M + L + M + S-ish validation ≈ one focused budget window for one
senior lane.** Full membrane program (3 + 4b + 5): **+XL +M–L on top, 2-3×
the MVP**, and gated on #4194 landing plus the stage-1 callback probe.

### Verdict

- **Provider-seam verdict: YES** — variant C is another provider behind
  `js2wasm:runtime-eval`; user module and compiler are untouched except two
  S-size enablers (import namespace/allowlist; optional native-i32 externs)
  and the multi-module packaging change. This is the decisive economic fact:
  the expensive halves of A/B (codegen emitting C-API calls with refcount
  discipline everywhere; representation migration) simply do not exist here.
- **Recommend: MVP yes-if, full membrane not now.** The tiered MVP is
  well-bounded, regression-free by construction, and lands real REPL/eval
  performance (~560×) — worth scheduling *if* standalone eval performance is
  a user-facing requirement (#4229). The full membrane is XL+ with its
  conformance payoff concentrated exactly where the membrane is weakest
  (frontier semantics), so:
- **The honest counter-case:** the 32-file residual analysis says remaining
  eval-code failures are frontier/EvalDeclarationInstantiation semantics —
  work the interpreter does natively on a shared substrate and a membrane
  makes *harder*. Finishing #2928 Phase-2 (8 recorded records + catch
  destructuring) + #2929 residuals buys more conformance per token than
  stages 3-5. And the 1857 ms is per-operation interpreter cost, not a
  lookup pathology (measured above) — an interpreter optimization pass
  (dispatch tightening, register caching) plausibly recovers 10-50× at a
  fraction of the membrane's risk, shrinking variant C's perf argument to
  the last ~10-50×. Variant C's unique, non-recoverable advantage is eval'd-
  source language completeness — which only the MVP's QuickJS routing already
  captures for primitive-frontier code.
