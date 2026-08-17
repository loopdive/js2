---
id: 4236
title: "exploration: QuickJS JSValue as the linear lane's BOXED tier — native representation for typed code, QuickJS for the eval-visible/dynamic frontier (Static-Hermes-shaped)"
status: backlog
sprint: Backlog
created: 2026-08-08
updated: 2026-08-08
# 2026-08-08 (post-slice-1): "## Regex measurements" appended — engine-tie
# benchmark, standalone lre-only artifact recipe/sizes, our engine's per-module
# size A/B; cross-refs #4237 (compile-time regex specialization exploration).
# 2026-08-08 (later): "## Design variant C" appended — QuickJS as the eval
# ENGINE for the WasmGC lane behind the existing js2wasm:runtime-eval provider
# seam, with a code-grounded staged effort estimate and an ABI probe record.
# 2026-08-08: acceptance box 1 (the link/identity/measurement spike) executed —
# see "## Spike findings" — then slice 1 built the real WASI artifact and
# re-proved the results on it, see "## Slice 1 — WASI artifact". Status stays
# `backlog`: the exploration's remaining boxes (frontier A/B, strings, cycle
# policy, split-brain audit, go/no-go) are untouched. The version pin is now
# recorded (quickjs-ng v0.16.1 / 954dc53); the upgrade policy is not.
priority: low
horizon: xl
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: eval
goal: backend-agnostic-ir
related: [1527, 1584, 2928, 3288, 3927, 4157, 4229, 4538]
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
      The *WASI-standalone* half is now proven too — see "Slice 1 — WASI
      artifact" (2026-08-08): a wasi-sdk-style build importing only five
      `wasi_snapshot_preview1` functions, with R2/R3/R4 reproduced on it.
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

## Decision (project lead, 2026-08-08) — ADOPT the linear-lane boxed tier

Stakeholder decision after the spike + benchmark review: **adopt QuickJS's
`JSValue` as the linear lane's boxed/dynamic representation**, under the
representation policy discussed and agreed in-session:

1. **Typed code is untouched** — unboxed `i32`/`f64` and the existing static
   fat-slot layouts stay; they beat any tagged representation and carry the
   measured 4× AOT-over-QuickJS win. The program-level perf promise rests on
   frontier-analysis precision, not on the representation choice.
2. **`JSValue` is OPAQUE by default** — all manipulation through the C API
   with codegen-enforced refcount discipline; internal layouts are never
   open-coded (unstable ABI).
3. **Immediates get inline fast paths via BUILD-TIME TAG EXTRACTION** — a tiny
   C shim in the artifact exports the tag constants / float64 encoding, so
   number box/unbox compiles to `i64.reinterpret_f64`-class sequences learned
   from the pinned build rather than hardcoded. Refcounted values stay
   API-mediated.
4. **Migration story**: the C-API seam is the engine boundary. If the dynamic
   tier ever becomes hot enough to justify an owned runtime (own NaN-box,
   tracing GC, specialized accessors), it swaps in behind the same seam; until
   then the borrowed runtime carries builtins, RegExp, and eval at QuickJS
   speed. Nothing about this decision forecloses that future.

Rationale in one line: adoption costs nothing where js2wasm is fast, buys a
finished runtime where the linear lane has nothing today (no dynamic value
representation exists — `layout.ts` is a static fat-slot model), and caps only
the cold dynamic tier at best-in-class-interpreter speed.

Slice 1 (the wasi-built artifact + tag-extraction shim + link re-proof) is
dispatched; findings land below when complete. The variant-C (WasmGC-lane)
question is SEPARATE and remains an estimate — see its own section's verdict
(MVP tiered provider ≈ one budget window; full membrane deferred).

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
## Slice 1 — WASI artifact (2026-08-08)

Closes the spike's blocker. **The artifact exists, it is genuinely standalone,
and every R2/R3/R4 result reproduces on it.** Rung reached: **S1–S5 complete.**

### Verdict

**Both halves of the design claim now hold.** The one-heap identity result was
already proven; what was missing was that the pair can link with *no JS host*.
It can:

```
IMPORTS (5): wasi_snapshot_preview1.{clock_time_get, fd_close, fd_fdstat_get,
                                     fd_seek, fd_write}
```

Zero `env.*`, zero emscripten. That was the spike's sole disqualifier and it is
gone. The peer module drives QuickJS over the shared memory and gets **42**,
**411**, and correct tag/float64 decoding — same as the spike, now on a WASI
artifact.

The go/no-go blocker is therefore lifted. **The next blocker is not QuickJS, it
is `src/codegen-linear/`** — see the slice-2 handoff.

Deliverables landed: `scripts/quickjs-artifact/{qjs_shim.c, build.sh,
extract-abi.mjs, wasi-stub.mjs, README.md, probe/{peer.c, probe.mjs}}` and the
`workflow_dispatch`-only `.github/workflows/quickjs-wasi-artifact.yml`. The
`.wasm` is not committed; its sha256 is below.

### Build recipe (exact)

Pins: **quickjs-ng `954dc53628e36891f93c359aa60895c2ae3dac6b` (v0.16.1)**,
wasi-libc `8d8348ec24253d0638a693b8af82445c13d92d32`, builtins from
wasi-sdk-34-rc.1. Toolchain: stock Ubuntu **clang 18.1.3** + `wasm-ld`/`llvm-ar`.
**No wasi-sdk install.** Total cold build **~3 min** on 4 cores.

```bash
# S1 sysroot (~30 s build; wasi-libc has NO Makefile any more — CMake only)
cmake -S wasi-libc -B build -DCMAKE_C_COMPILER=clang-18 -DCMAKE_AR=llvm-ar-18 \
  -DCMAKE_RANLIB=llvm-ranlib-18 -DCMAKE_INSTALL_PREFIX=$SYSROOT \
  -DTARGET_TRIPLE=wasm32-wasip1 -DMALLOC=dlmalloc -DBUILD_TESTS=OFF \
  -DBUILD_SHARED=OFF -DBUILTINS_LIB=$BUILTINS
cmake --build build -j4 && cmake --install build

# S2 quickjs core: FOUR files, 19 s, zero patches, zero warnings
clang-18 --target=wasm32-wasip1 --sysroot=$SYSROOT -resource-dir $RD \
  -O2 -ffunction-sections -fdata-sections -fno-strict-aliasing -funsigned-char \
  -D_GNU_SOURCE -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL -DNDEBUG \
  -c {dtoa,libregexp,libunicode,quickjs}.c

# S3 link (~1 s). Memory is EXPORTED: this module owns the shared heap.
clang-18 ... -mexec-model=reactor -Wl,--export-memory -Wl,--gc-sections \
  -Wl,--strip-all -Wl,--export={malloc,free,realloc,calloc} \
  -Wl,--initial-memory=16777216 -Wl,--max-memory=1073741824 -Wl,--stack-first \
  -lwasi-emulated-process-clocks -lwasi-emulated-signal -o libquickjs.wasm ...
```

`sha256(libquickjs.wasm) = 550ebe4d88a5db7b32c93de7a5e6bc6389ade5d6daf837a60acce7851a2927c9`

### Friction list (what actually cost time)

1. **wasi-libc has no `Makefile`** — it is CMake-only now. Any recipe of the
   form `make -C wasi-libc CC=clang AR=llvm-ar …` fails at "no such file".
2. **Ubuntu's clang 18 ships no wasm32 `compiler-rt`**, and the link hard-fails:
   `cannot open .../lib/wasip1/libclang_rt.builtins-wasm32.a`. Fixed by staging
   a `-resource-dir` holding the builtins (with `include/` symlinked to the real
   resource dir so `stddef.h` still resolves). wasi-libc's own CMake needs the
   same library via `-DBUILTINS_LIB=`, otherwise it ExternalProject-downloads it.
3. **The builtins ARE downloadable.** The spike concluded GitHub was gated after
   a 403 on `/archive/refs/tags/…`; `/releases/download/…` returns **200**. Both
   `git clone`s also succeed (~1 s each). The gating is narrower than recorded.
4. **No setjmp anywhere** — QuickJS returns `JS_EXCEPTION` sentinels, so no
   Asyncify, no `libsetjmp`, no exception-handling proposal needed. The one
   `setjmp.h` mention in `dtoa.c` is commented out.
5. Signals/clocks are quickjs-ng's own documented WASI knobs
   (`_WASI_EMULATED_SIGNAL` / `_WASI_EMULATED_PROCESS_CLOCKS` + the matching
   `-lwasi-emulated-*`), taken straight from its `CMAKE_SYSTEM_NAME STREQUAL
   "WASI"` branch. Threads stay off.
6. **Upstream already ships `qjs-wasi-reactor.c`** (a `QJS_WASI_REACTOR` CMake
   option). It was *not* used: it pulls in `quickjs-libc` and
   `-Wl,--export-dynamic`, which is a much wider syscall and export surface than
   the thin wrapper set this design mandates. Worth knowing it exists.
7. **Two measurement traps, both of which produce believable wrong numbers:**
   - LLVM **closes a pure arithmetic baseline loop into a formula** — the
     `acc += i & 1` baseline measured **0.05 ns/iter** because the loop was
     deleted, which silently inflates any "gross minus baseline" call cost. The
     baseline must be un-deletable (a `volatile` load). A local-call baseline is
     *also* deleted (constant-returning callee), so `noinline` is not enough.
   - **Benchmark ordering**: whichever eval driver runs first pays a one-off
     ~2.7 ms warm-up. Straight A-then-B read as "wasm-driven eval is 1.6×
     slower than JS-driven" (6.01 vs 3.79 ms). Alternating the drivers shows
     them **equal** (3.85 vs 3.81). The spike's equality result replicates only
     if you alternate.
8. **No `wasm-opt`/binaryen on the box** (no `node_modules`), so that size lever
   is untested — see the size table.

### Sizes — vs the spike's emscripten numbers

| artifact | raw | gzip |
| --- | ---: | ---: |
| **this build, `-O2` + gc-sections + strip (default)** | **1,011,134** | **350,017** |
| this build, `-Oz` + gc-sections + strip | 626,104 | 261,243 |
| this build, `-O2`, no strip/gc | 1,037,624 | 359,626 |
| emscripten release-sync (spike) | 503,134 | 233,588 |
| emscripten release-asyncify (spike) | 1,027,523 | 362,445 |
| `peer.wasm` (the js2wasm stand-in) | 1,896 | 1,064 |

`--gc-sections` is worthless without `-ffunction-sections -fdata-sections`
(1,037,630 → 1,037,639, i.e. nothing); the 26 KB it appears to save is really
`--strip-all` dropping the `name` section.

**`-Oz` is not free: it costs ~23% on both eval (3.85 → 5.03 ms) and per-property
cost (66.6 → 82.0 ns).** The boxed tier is by definition the tier running code we
could *not* compile, so `-O2` is the default and `OPT=-Oz` is the documented
knob. The residual gap to emscripten's 503 KB is mostly `wasm-opt`, which
emscripten runs and this build does not — untested, and the obvious next lever
if size matters.

### R2/R3/R4 re-measured on THIS artifact

All PASS. `peer.wasm` is a separate module that imports the artifact's **memory
object** plus 17 `qjs_*` functions; JS appears only as the instantiation harness
and the timer.

| check | result |
| --- | --- |
| R2 `eval("40+2")`, source bytes authored by the peer | **42** |
| R3 identity round-trip (`x*10 + identityBit`) | **411** |
| R3 object tag via `qjs_tag` wrapper | −1 = `JS_TAG_OBJECT` |
| R3 object tag **open-coded** (`i32.load offset=4`) | −1 — matches |
| R3 float64 decoded from the raw NaN-boxed JSValue | 3.75 |
| peer module data segments | **none** |

| measurement | spike (emscripten, JS-hosted) | **this artifact (WASI, glue-free)** |
| --- | ---: | ---: |
| wasm→wasm trampoline, net | 1.86 ns | **2.34 ns** |
| JS host→QuickJS, net | 8.77 ns | **4.56 ns** |
| GetProp+ToFloat64+Free, wasm-driven | 62.1 ns | **66.6 ns** |
| GetProp+ToFloat64+Free, JS-driven | 85.9 ns | **77.5 ns** |
| eval(100k loop), wasm-driven | 3.30–3.45 ms | **3.85 ms** |
| eval(100k loop), JS-driven | 3.29–3.37 ms | **3.81 ms** |
| Node/V8 indirect eval (same box, same session) | 0.123 ms | **0.251 ms** |

**Read the last row before the others.** The V8 baseline is 2× slower than the
spike's, so this box is under materially more load; against that, the WASI
artifact's eval being only 15% slower than the emscripten one means it is *at
least as fast* per unit of machine. Two conclusions survive intact:

- **Driving `JS_Eval` from wasm costs nothing** vs driving it from JS (3.85 vs
  3.81 — within noise, and only once the ordering artifact is removed).
- The boundary is **not** the limit: one property op is ~28× the trampoline. The
  cost is set by how much of the program lands in the boxed tier, which is the
  frontier analysis, which is still the real risk.

vs the Phase-1 interpreter's 1857 ms, the boxed tier is **~480×** faster here.

### The tag-extraction shim (the build-time trick, implemented)

QuickJS layouts are explicitly not a stable ABI, so nothing is hardcoded in the
compiler: the artifact **exports** its own constants and `extract-abi.mjs` reads
them out of the built module into `qjs-abi.json`. A version or flag change shows
up as different JSON, not as silent miscompilation.

```json
{ "quickjs": { "major": 0, "minor": 16, "patch": 1 },
  "value": { "nanBoxing": true, "jsValueSize": 8, "handleSize": 4,
             "tagOffset": 4, "payloadOffset": 0,
             "float64TagAddend": 2146959370 },
  "tags": { "FIRST": -9, "BIG_INT": -9, "SYMBOL": -8, "STRING": -7,
            "STRING_ROPE": -6, "MODULE": -3, "FUNCTION_BYTECODE": -2,
            "OBJECT": -1, "INT": 0, "BOOL": 1, "NULL": 2, "UNDEFINED": 3,
            "UNINITIALIZED": 4, "CATCH_OFFSET": 5, "EXCEPTION": 6,
            "SHORT_BIG_INT": 7, "FLOAT64": 8 },
  "isFloat64Predicate": { "kind": "unsigned-ge", "subtrahend": -9, "threshold": 17 } }
```

Exports: `qjs_abi_{version,qjs_version_major/minor/patch,nan_boxing,jsvalue_size,
handle_size,tag_offset,payload_offset,float64_tag_addend}` plus one
`qjs_abi_tag_*` per tag. What codegen buys with them, verified by the probe:

- **tag test with no call** — `i32.load offset=tagOffset` on the handle, compare
  against the exported constant (`r3_open_coded_tag` returns the same −1 as the
  wrapper).
- **number unboxing with no call** — `double bits == rawJSValue + (addend << 32)`
  (probe decodes 3.75 from the raw i64).
- `isFloat64Predicate` is stated once so codegen does not re-derive
  `(unsigned)(tag − TAG_FIRST) >= 17`.

### Two ABI decisions worth reviewing

1. **Handles, not raw JSValues** (adopting variant C's recommendation). A handle
   is an i32 pointer to an 8-byte cell. i64 JSValues do cross wasm→wasm natively
   — `qjs_handle_raw` is exported and used by the probe — but an i32 is uniform
   at every boundary and is a stable identity codegen can park in a local or a
   struct field.
2. **The shim converts QuickJS's MOVE semantics into BORROW semantics.** Raw
   `JS_SetPropertyStr` consumes its value; the spike's R3 probe only worked
   because it hand-inserted a `JS_DupValue`. Every wrapper here borrows its
   arguments and returns owned handles, so the codegen obligation collapses from
   per-callsite ownership knowledge to one rule: **free every returned handle
   exactly once.** This retires R5 gap 6 as a codegen problem.

### Slice-2 handoff — `src/codegen-linear/`

R5's gap list, restated against what slice 1 changed:

| R5 gap | status |
| --- | --- |
| 5. no standalone artifact | **CLOSED** — this slice |
| 6. refcount discipline | **CLOSED** — shim borrows; one destructor rule |
| 1. lane emits zero imports | open — now needs 17 + a memory import |
| 2. `c-abi.ts` is export-direction only | open — but the handle type is just i32 |
| 3. memory ownership | open, and the **direction is now fixed** |
| 4. arena vs QuickJS malloc | open, **collision confirmed and measured** |
| 7. linear-lane coverage | open, unchanged (`return "n=" + n` still fails validation) |

Ordered work:

1. **Import direction in `c-abi.ts`** — an extern-C declaration table. Cheap
   because every wrapper is `(i32…) -> i32 | f64 | i64`: the opaque handle needs
   no new ValType.
2. **Emit imports at all** (`index.ts:144`/`311` hard-code `ctx.numImportFuncs
   = 0`). Add them **before** codegen starts; the index arithmetic is already
   parameterised. Do **not** replicate WasmGC's late `addUnionImports` shifting.
3. **Import the memory instead of defining it.** `codegen-linear/runtime.ts:84-95`
   unconditionally pushes and exports `(memory 1 256)`. The artifact **exports**
   memory, so js2wasm must import it — the `--link node:fs` shape at
   `codegen/wasi.ts:97` is exactly this topology and has no analogue in
   `codegen-linear/`. Note `max 256` pages (16 MiB) is also below what a QuickJS
   heap wants; the artifact ships `initial 256 / max 16384` pages.
4. **Relocate the arena — the collision is real.** Measured on this build: the
   artifact's first `malloc` returns **171,696 (0x29EB0)**, with a 64 KiB
   `--stack-first` shadow stack at 0 and ~105 KiB of static data above it.
   js2wasm's linear `__heap_ptr` initialises to a hard-coded **1024**, i.e.
   *inside the artifact's shadow stack*. The boxed tier must allocate from the
   artifact's `malloc`; the native arena must sit above `__heap_base` or be
   dynamic. Two independent growers over one memory stays a corruption hazard.
5. **No active data segments, no shadow-stack traffic.** `probe/peer.c` proves a
   peer module can share the heap safely, but only by construction: it links to
   **zero `DATA` section and zero `global.get`/`global.set`**, so the only bytes
   it touches are ones it got from `malloc`. A js2wasm module emitting an active
   data segment writes at a link-time offset straight through QuickJS's static
   data. Three options, in preference order: (a) passive segments + `memory.init`
   into a `malloc`'d pointer (what the spike's WAT did — local to codegen, no
   link-time negotiation); (b) `--global-base` above the artifact's heap base
   (fragile: the heap grows); (c) PIC/side-module dynamic linking (correct, much
   larger).
6. **A handle-scope / destructor-insertion pass.** The one rule is simple but it
   is still a rule codegen must implement on every path, including exceptional
   ones.

Not attempted, still open from the original acceptance list: the object-frontier
A/B (tainted-alloc vs exotic wrappers), the string story, cross-heap cycles, the
split-brain builtins audit, and the honest go/no-go against #4157 / #3288.

### Repro

```bash
bash scripts/quickjs-artifact/build.sh          # ~3 min cold -> .tmp/quickjs-artifact/
node scripts/quickjs-artifact/probe/probe.mjs   # R2/R3/R4; exits non-zero on any failure
```

## Design notes from the 2026-08-08 adoption review (project lead Q&A)

Recorded so the decisions survive the session; each amends or sharpens an
acceptance box above.

### Cross-heap cycle policy — mostly SOLVABLE in the linear lane (amends that box)

The leak needs a cycle crossing heaps in BOTH directions. Two levers close it:

1. **Keep cycles homogeneous**: with tainted allocation, eval-visible objects
   are QuickJS objects from birth, so dynamic-object cycles live entirely in
   QuickJS's heap and its cycle collector handles them normally.
2. **Teach QuickJS the through-native edges**: `JSClassDef.gc_mark` lets an
   exotic wrapper class participate in cycle collection by marking every
   JSValue its wrapped native object holds — codegen knows these edges because
   it emits every JSValue store into a native field. A wrapper→native→JSValue
   path becomes visible as wrapper→JSValue, making cycles THROUGH native
   objects collectable. This is the browser-vendor technique for JS↔DOM
   cycles (Firefox's cycle collector, Chromium's unified heap tracing).
3. Backstop: epoch/session bulk-release of the handle set (REPL line, eval
   session).

Honest residual: this works where the native side has no independent tracing
GC. In **variant C** (WasmGC lane) the host VM's GC cannot be taught QuickJS
edges, so the leak class persists there — one more reason variant C's verdict
capped at the MVP tier.

### Acorn scoping after adoption

In the linear lane QuickJS parses AND executes eval'd code — acorn and the
bytecode interpreter drop out of that lane's eval path entirely. Acorn is NOT
retired from the project: the WasmGC lane keeps the #2928 Acorn+interpreter
provider (JSValue cannot hold GC refs; variant C's own verdict keeps the
interpreter), the Tier-0 splice uses the TypeScript parser at compile time,
and compiled-acorn remains the flagship dogfood/benchmark workload
independently of eval.

### Builtin routing policy (boxed tier gets the whole engine)

For boxed values the entire engine comes along, not just functions — RegExp,
Date, JSON, string methods, and the census's largest remaining buckets
(property-descriptor MOP ~795 files, `with` ~162, Proxy) become QuickJS's
problem for dynamic values in this lane. Routing:

| operation | where it runs |
| --- | --- |
| Math/arithmetic on typed `f64`/`i32` | native wasm instructions — never leaves the typed tier |
| RegExp, Date, JSON, `toLocale*`, coercion corner cases | delegate to QuickJS (box in, call, unbox out) |
| property access on dynamic values | QuickJS shapes via the C API |

Structural bonus: all dynamic objects in this lane are QuickJS objects, so
there is exactly ONE `String.prototype` etc. at the dynamic level — the
split-brain audit shrinks to the typed↔boxed frontier only.

### Typed code calling builtins — transient adapters (and the string decision)

Typed values can use QuickJS builtins through call-site adapters; resident
representation stays native, only the boundary pays:

| argument kind | crossing cost | mechanism |
| --- | ---: | --- |
| numbers | ~free | immediate boxing via tag extraction (verified open-coded in slice 1) |
| strings | one copy per call — or ZERO, see below | `qjs_new_string_len` in / copy out |
| RegExp pattern | once per literal, then cached | compile at first use, hold the handle |
| typed structs (e.g. `JSON.stringify`) | per-property traps, or one copy | exotic wrapper vs eager conversion |

**Recommendation for the "string story" box: adopt `JSString` as the linear
lane's native string type.** "Unboxed" was always a fiction for strings (heap
things in any representation); if typed strings ARE QuickJS strings, every
string builtin call is zero-copy on data already in the right heap, while
numbers stay truly unboxed and structs stay native. Cost: refcount discipline
flows into typed string locals (dup/free, codegen-inserted — the slice-1
borrow-semantics shim makes the obligation "free every returned handle once").
Decide before slice 2 shapes the ABI.

## Regex measurements (2026-08-08, post-slice-1) — engine tie, lre-only artifact, our engine's size

Follow-up to the builtin-routing table's "delegate RegExp to QuickJS" row:
measured whether that delegation wins on *speed* (no) and what it costs on
*size* (favorable past one module). Harness: `.tmp/bench-regex.mjs` —
`/([a-z]+[0-9]+)@([a-z]+)\.([a-z][a-z][a-z])/` over 200 subjects × 500 iters.

| engine | ms | note |
| --- | ---: | --- |
| V8 native | 6.5 | Irregexp JIT tier — per-pattern specialized code |
| QuickJS libregexp (wasm) | 112.1 | generic bytecode interpreter |
| js2wasm own engine (wasm) | 121.7 | generic interpreter — statistical tie |

So the case for QuickJS's regex in the boxed tier is **completeness and
single-`RegExp.prototype` coherence, not speed**. The 18× V8 gap is
specialization-vs-interpretation, not native-vs-wasm — pursued separately in
**#4237** (compile literal patterns to per-pattern wasm functions at build
time; orthogonal to this adoption, shares the fallback-engine decision).

**libregexp ships standalone** — proven 2026-08-08 in `.tmp/lre-only/`:
compile `libregexp.c` + `libunicode.c` + a 3-export shim
(`lre_compile_pattern` / `lre_exec_pattern` / `lre_capture_count`, plus the
three host hooks `lre_realloc` / `lre_check_stack_overflow` /
`lre_check_timeout`) with the slice-1 toolchain (stock clang-18,
wasi-libc sysroot, quickjs-ng v0.16.1 pin; note quickjs-ng inlined cutils
into `cutils.h` — there is no `cutils.c` to compile). Result: **115,480 raw /
53,211 gzip**, imports = 4 `wasi_snapshot_preview1`, functional probe green
(4 capture groups, match + negative correct). This gives the **GC lane** a
regex-completeness option without adopting any of the boxed tier.

**Our engine's cost is per-module, not shared** — A/B compile
(`.tmp/regex-size.mjs`): standalone module without regex 21,188 raw /
9,896 gzip; with one regex literal 96,737 / 40,009 → **≈75.5 KB raw /
≈30 KB gzip marginal, duplicated in every regex-using binary**. The shared
lre-only artifact is ~1.5× bigger once but breaks even at the second module.

## Feature-subset builds + the split regex module (2026-08-08, measured)

Two follow-up questions answered empirically on the slice-1 build env
(scratchpad `noregex/`, reusing the pinned quickjs-ng v0.16.1 objects):

**QuickJS builds without regex — intrinsics are runtime-modular.**
`JS_NewContextRaw` + per-intrinsic adders (13: BaseObjects, Date, Eval,
RegExp(+Compiler), JSON, Proxy, MapSet, TypedArrays, Promise, BigInt,
WeakRef, DOMException, AToB); skip an adder and `--gc-sections` strips its
code. Shim variant calling every adder except RegExp: **933,497 raw /
316,778 gzip vs 1,037,624 / 359,899 full** (−104 KB raw / −43 KB gzip).
Probe green — eval/JSON/Promise/async/MapSet/BigInt/TypedArray all work;
`/a/` → `SyntaxError: RegExp are not supported`, `new RegExp` →
`ReferenceError`. This is the general knob for trimming the boxed-tier
engine to what the frontier actually needs.

**libregexp links as a SEPARATE wasm module — built and proven.** Core with
the RegExp builtin ON, engine imported cross-module:

- Seam: 7 functions core→regex (`lre_compile`, `lre_exec`, 5 bytecode
  accessors) and shared memory + 3 hooks regex→core (`lre_realloc`,
  `lre_check_stack_overflow`, `lre_check_timeout`). Sizes: core 966,775 raw
  / 326,254 gzip; regex module 114,284 / 52,636 (libunicode rides along —
  data symbols cannot cross wasm module boundaries).
- Functional through the seam: `exec` captures, named groups,
  `String.replace`/`split` with regex, `/u` flag, negatives.
- Wrinkle 1: wasm-ld-18 SEGFAULTS on `--wrap` + `--import-undefined`; the
  working cut is preprocessor renames (`-Dlre_compile=…_local_unused`) on
  the core's libregexp compile plus a 7-thunk import file.
- Wrinkle 2: the core's LEXER uses libregexp's `lre_parse_escape` + an ident
  **data** table — those ~2 KB stay in core; the cut is at the engine entry
  points, not the file boundary.
- Wrinkle 3 (the real productization work): the probe parks the regex
  module's static data at a fixed 14 MB `--global-base` and late-binds the
  circular imports with harness closures — production needs the same
  memory-region coordination as the slice-1 allocator-collision finding.

Payoff: ONE shared regex module can serve BOTH lanes — the GC lane binds it
directly (the lre-only artifact recorded above is the same class of build),
the linear lane's core imports it, and non-regex users load neither. The
builtin-routing "delegate RegExp to QuickJS" row therefore does not force
regex bytes into every deployment.

## Slice-2 program (2026-08-17) — issues filed, decision promoted to an ADR

The project-lead goal was restated as **standalone native binaries**, which
makes the slice-2 handoff above schedulable work rather than exploration. Two
things changed on 2026-08-17:

1. **The 2026-08-08 adoption decision is now an ADR** —
   [ADR-0020](../../docs/adr/0020-linear-dynamic-tier-quickjs-jsvalue.md). It
   had lived only in this issue's "Decision" section, which is the wrong home
   for a decision that amends ADR-0017's deferred-reclamation position and
   carves a scoped exception to the backend-agnostic-IR non-goal (#3299).
2. **The handoff table is now six filed issues** under umbrella **#4538**:

   | handoff item | issue |
   | --- | --- |
   | 1–3 import direction, emit imports, import the memory | #4539 |
   | 4–5 arena relocation, passive data segments | #4540 |
   | representation + tag fast paths + strings + cycles | #4541 |
   | 6 refcount / handle-scope pass | #4542 |
   | object frontier A/B (was an open acceptance box here) | #4543 |
   | native binary emission, size baseline, tier elision | #4544 |

This issue stays the **exploration record** — the benchmark triangle, spike
rungs, build recipe, ABI decisions, and design Q&A live here and are cited by
the slices rather than copied into them. Its remaining open acceptance boxes
are now owned as follows: the object-frontier A/B by #4543, the string story
and cross-heap cycle policy by #4541, and the split-brain builtins audit by
#4543 (prototype identity at the frontier). The version pin is recorded above;
**the upgrade policy for the pinned engine is still unowned** and should be
filed separately if it is not folded into #4539's ABI table work.
