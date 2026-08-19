# ADR-0021: A direct native backend emits C

Status: Accepted 2026-08-17 — as a **target choice, not a schedule**. Whether
to build a direct native backend at all is gated on evidence from #4544; this
record fixes what it emits *if* that gate opens, so the question is not
re-litigated each time it resurfaces.

> **Gate result 2026-08-19: CLOSED — the direct backend is not justified.**
> #4544 Part A measured the AOT route and it is not inadequate on either axis:
> a real program becomes a **22.9 KB self-contained native binary** starting
> **0.14–0.20 ms above bare process creation** (1.58x the size of the same
> program hand-written in C, and indistinguishable from it on startup), via
> `wasm2c` + clang. Even the whole QuickJS tier links into one 1.60 MB binary
> that evaluates JavaScript in 0.64 ms. This ADR therefore stays Accepted as a
> **target choice** and stays unscheduled — including its stated prerequisite of
> finishing `ir-full-coverage` (#2855) first, which does not have to be paid for
> this reason.
>
> **Still open:** the Wasm→C **throughput** objection under "Alternatives
> rejected" was NOT tested — Part A measured size and startup only. Note it is
> an argument about the *engine*, and the engine is already C, so a native build
> can link `libquickjs` compiled directly by clang and route only generated code
> through `wasm2c`. Evidence:
> [`benchmarks/results/native-aot-baseline.json`](../../benchmarks/results/native-aot-baseline.json),
> generator `scripts/benchmark-native-aot.mjs`.

## Context

The goal behind #4538 is standalone **native binaries**. The near-term route is
ahead-of-time compilation of the Wasm we already produce (`wasmtime compile`,
WAMR AOT) — no new lowering, full coverage inherited from finished output, and
a Cranelift AOT lane already exists in the benchmark harness. #4544 owns that
baseline and is the evidence gate.

If those numbers prove inadequate on size or startup, the alternative is a
direct native backend, and the question becomes what it targets. The candidates
are Wasm→C, C emitted from our IR, LLVM IR, Binaryen, and Cranelift.

## Decision

**A direct native backend emits C.** Three reasons, in order of weight for this
project:

1. **The dynamic tier is a C library.** [ADR-0020](./0020-linear-dynamic-tier-quickjs-jsvalue.md)
   makes QuickJS the engine for the dynamic residue. Emitting C makes every
   seam crossing an ordinary call against the real headers, type-checked by the
   C compiler. Any other target requires re-declaring that ABI and keeping it
   in sync with a pinned engine — new drift surface for no gain.
2. **Distribution.** "Needs a C compiler" is a mild dependency. "Needs a
   specific LLVM" is a support burden, and LLVM IR is not stable across
   releases.
3. **Reviewability.** This repo runs explicit reviewability ratchets. Generated
   C can be read, diffed and bisected by a person; LLVM IR effectively cannot.

## Alternatives rejected

- **Wasm→C.** Reuses coverage, but our engine's path becomes
  `quickjs.c → Wasm → C → clang`. The intermediate Wasm destroys the aliasing
  and control-flow structure the C optimiser needs, so the engine would run
  measurably slower than simply compiling it. This defect is specific to us:
  it does not arise for a compiler with no embedded C runtime.
- **LLVM IR.** Best codegen and exact semantic control (`nsw`, `musttail`,
  landing pads), and it can target wasm32 *and* native from one path — a real
  unification argument. But it cannot serve the WasmGC lane (no meaningful
  WasmGC support), so it unifies only linear-Wasm and native, which C reaches
  too via clang at lower cost.
- **Binaryen.** A genuine compiler backend, not merely an optimiser — but its
  output target is **WebAssembly**. Choosing it for a native path returns us to
  Wasm, i.e. the AOT route with extra steps. It remains the strongest option
  for *Wasm* codegen, which is a separate question from this one.
- **Cranelift.** Sound, but it is what `wasmtime compile` already runs for us;
  building our own path duplicates the AOT route without inheriting its
  coverage.

## Consequences

C is a weaker target than Wasm in specific ways we already depend on, and these
are semantic requirements to design in up front, not optimisations:

- **Tail calls.** We emit `return_call` / `return_call_ref`. C has no portable
  guaranteed TCO; this needs clang's `musttail` or an explicit trampoline.
- **Integer overflow.** JS `|0` wraps; signed overflow in C is undefined.
  Wrapping must come from unsigned types or `-fwrapv`, pinned in the build.
- **Float semantics.** Strict IEEE; `-ffast-math` must be impossible to enable.
- **Unwinding is the hard one.** A `throw` crossing frames must run the
  refcount releases on the way out, so the exception mechanism and #4542's
  destructor-insertion pass are one design, not two.

One genuine simplification: because ADR-0020 chose reference counting over
tracing, we need no stack maps or precise GC roots — the usual reason C is a
painful target for a managed language largely does not apply.

**The real prerequisite is IR coverage, not the emitter.** Coverage today lives
in the *Wasm output*, not in the IR: `plan/log/ir-adoption.md` still carries
`direct-only` and `mixed` rows. A backend emitting from IR would compile only
the IR-clean subset — a coverage regression. So the honest price of this
backend is finishing `ir-full-coverage` (#2855, #2856–#2859) first.
