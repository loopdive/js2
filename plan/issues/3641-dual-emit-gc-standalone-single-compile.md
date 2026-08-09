---
id: 3641
title: "Investigate a dual-emit compile entry point: gc + standalone from one parse/type-check/IR-build pass"
status: ready
sprint: current
created: 2026-07-25
priority: high
feasibility: hard
model: opus
horizon: l
reasoning_effort: high
task_type: investigation
area: compiler, ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [2955, 2956, 1585, 2138, 3640]
---

# #3641 — compile `gc` and `standalone` from one parse/type-check/IR pass, diverge only at lowering

## This is a milestone within an existing initiative, not a new direction

Before proposing anything: this repo already has an **active, large-scale
effort** toward exactly this shape — 35+ issues carry
`goal: backend-agnostic-ir` (linear-memory backend, Porffor-compatible
backend, etc.), and `#2955` states the north star explicitly: **"one
front-end; backends/modes differ at lowering."** That issue is mid-flight
(Slice 1 of 5 landed) de-polymorphizing `src/ir/from-ast.ts` on
`nativeStrings` specifically. `#2956` is `in-review`, wiring a linear
backend to consume the same IR.

I have **not** audited all 35 related issues — I found this cluster while
investigating js2wasm compile-time cost for the test262.fyi integration,
not by design. Whoever picks this up should cross-reference the broader
initiative before scoping work, since there's real risk of duplicating
effort I haven't seen.

What I believe is genuinely missing, and the reason this is its own issue
rather than a comment on #2955/#2956: those issues are about making
**individual backends** (linear, Porffor) consume a shared IR. I did not
find an issue for the **entry point** that would actually run one parse +
type-check + IR-build pass and emit **two WasmGC modules** (`gc` and
`standalone`) from it in a single `compile()` call. That's a nearer-term,
smaller-scoped payoff than the linear/Porffor work — both targets are
already WasmGC, so it doesn't need a second backend built, just the
front-end shared and a lowering pass run twice.

## Why this matters now (not just architecturally — concretely, for compile time)

A CPU profile of a single warm `compile()` call (test262.fyi js2wasm
integration investigation) split roughly:

- ~55% TypeScript's own parser/checker/binder
- ~39% js2wasm's own codegen
- ~5% GC, rest negligible

Today, compiling the same source for both `gc` and `standalone` (as your own
CI already does for the two-lane conformance numbers) pays the ~55%
front-end cost **twice** — once per target — even though the parsed AST and
type information are conceptually identical for the overwhelming majority
of source. If the front-end becomes genuinely target-independent, that cost
is paid once.

## Concrete evidence gathered this investigation (source-verified, not guessed)

**Target already branches before parsing, for a real but narrow set of
cases.** `src/compiler.ts`'s `compileSourceSync`:
- `injectProcessStdinPrelude` — `wasi` only
- `injectIteratorStaticsPrelude` — `standalone`/`wasi` only
- `preprocessImports(source, { wasi: options.target === "wasi" })` — the
  `wasi` flag changes real behavior (see below), not just cosmetic
- `elideWithIrIds` (dead-code elision) — `standalone`/`wasi` only, and this
  one runs **before parsing**, so the parser's *input text* can legitimately
  differ by target, not just the AST that comes out of it

Concretely, in `import-resolver.ts`'s `preprocessImports`: under `wasi`,
timer-shim injection (`setTimeout`/etc.) is **suppressed entirely**, because
standalone/WASI lowers timers natively onto a reactor
(`poll_oneoff`-driven run loop — see #3640, split off from this
investigation) instead of an import call. Injecting the shim unconditionally
would shadow that native lowering. None of these four are byte-inert
no-ops in the general case; they're real, though probably rare in practice
for typical program bodies. Worth measuring: what fraction of a realistic
corpus (test262, or your own benchmark suite) actually triggers any of these
four, vs. being genuinely identical input either way.

**Codegen/lowering is not cleanly separated from IR-building today** —
`ctx.standalone` (357 occurrences), `ctx.wasi` (168), `ctx.nativeStrings`
(151) are checked across 80 of 169 `src/codegen/*.ts` files, woven through
the same expression-compilation functions the profile shows dominating
codegen time (`compileCallExpression`, `compileBinaryExpression`,
property access, array methods). This is exactly what #2955 is already
chipping away at for strings specifically — I did **not** find an
equivalent in-flight issue for the object/array representation split
(native `ObjVec`/array HOF dispatch vs. `__extern_*` host calls,
`extern-declarations.ts`'s native `Map`/`Set`/`WeakMap` runtime vs. host
imports) — that's likely a real gap, and probably the largest one, since
`src/codegen/object-ops.ts` (30 occurrences) and `array-methods.ts` (19) are
both in the top-10 by branching density.

**Cross-module GC type compatibility is not a blocker for the eventual
lowering-time split** (tangential finding, relevant if the lowering split
ever needs multiple compiled units to agree on a shared type shape): WasmGC
type canonicalization is structural and store-scoped, not per-module — two
independently-compiled modules declaring the identical structural type are
treated as the same canonical type by the runtime, no extra proposal
needed. Not independently verified against Wasmtime specifically in this
investigation — worth a small empirical check if this becomes load-bearing
for actual design work.

## Suggested approach (investigation phase, matching #2138's flag-gated pattern)

1. Instrument or grep-audit: for a representative source corpus, how often
   do the four pre-parse target-conditional transforms actually change
   output? If it's a small tail, a fast pre-check ("does this source need
   any wasi/standalone-specific pre-parse handling?") could gate a shared
   fast path vs. a fallback to today's fully-separate compiles.
2. Cross-reference #2955's remaining slices (2–5, per that issue's own
   table: `coerceToExpectedExtern`, number `.toString()`, the string-method
   dispatch table, the for-of loop-strategy selection) and check whether
   any of the broader 35-issue `backend-agnostic-ir` set already covers an
   object/array-representation analog. If not, that's very likely the
   larger remaining blocker for a shared IR between `gc` and `standalone`
   specifically — bigger than the strings work, based on the branching
   density numbers above.
3. Once (or if) the front-end is sufficiently target-independent per the
   above, prototype the actual missing piece: a `compileMulti`-style (or
   new) entry point that runs `analyzeSource`/IR-build once and calls the
   lowering pass twice with different target contexts, producing two
   binaries. Flag-gated, byte-identical-output-when-disabled, matching
   #2138's validation discipline.
4. Measure compile-time delta on a real dual-target corpus (test262 sample
   compiled for both `gc` and `standalone`) before committing further.

## Non-goals

- Does not commit to building this — investigation-first, like #2138.
- Does not extend to the linear-memory/Porffor backends (#1585/#2956/etc.)
  — this is scoped narrowly to gc+standalone, both already WasmGC, as the
  nearer-term, smaller payoff. The broader initiative may subsume this
  later; that's fine, this issue's job is just to name the nearer milestone
  explicitly so it doesn't get lost waiting for the larger effort to land.
- Does not include #3640 (the standalone reactor/syscall-shim
  linked-module idea) — related, filed separately, backlog priority.
