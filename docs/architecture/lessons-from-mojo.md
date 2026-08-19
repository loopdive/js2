# What we can learn from Mojo (modular/modular)

> Read against **Mojo / KGEN at `modular/modular@main`, read 2026-08-19**
> (shallow clone; 341 MB). Primary sources are in-repo, not marketing pages:
> `KGEN/docs/MojoCompilerWalkthrough.md`, `mojo/proposals/*.md`,
> `mojo/stdlib/std/python/python_object.mojo`. `docs.modular.com` is blocked
> by this container's egress proxy — nothing below is sourced from it.
>
> Companion to [`compiler-design-lessons.md`](compiler-design-lessons.md)
> (vendor-neutral) and [`codegen-axes.md`](codegen-axes.md) (our axes).
> Read time ~12 min. Prioritized action table at the bottom.

---

## TL;DR

Mojo is not a competitor and most of its language design does not transfer
(value semantics, a borrow checker, no GC — none of that is available when
your source language is JavaScript). What transfers is **one structural
decision we are currently making the other way**:

> **Mojo has no fallback compiler.** There is one front end, one pass
> pipeline, and no notion of a construct the front end may *decline*. Where
> Mojo cannot compile something statically it does one of two things: emit a
> located error with a mechanical fix-it, or represent the dynamism as an
> ordinary **value** (`PythonObject`, a plain stdlib struct with
> `__getattr__`/`__call__`). The escape hatch is a *library type* and a
> *dialect*, never a second compiler.

We have the opposite: `src/ir/select.ts` — **456 KB** — exists solely to
answer "may the IR claim this function?", and every `no` routes to a second
front end in `src/codegen/` (**431 files**). That is the shape Mojo
deliberately does not have, and it is the root of the stuck ratchet
described in §1.

Three things worth stealing, one thing worth copying wholesale, and two
places where Mojo is explicitly *not* a model for us.

---

## Where we already align (don't re-litigate)

| Ours | Mojo's | Verdict |
| --- | --- | --- |
| ADR-0018 structured IR (#1925) — loops/ifs in nested instruction buffers, join-free block CFG | `hlcf` dialect (`hlcf.if`/`hlcf.for`/`hlcf.loop`), survives to Phase 6 and lowers straight to LLVM | Same call, independently. Ours is *more* justified: Wasm's control flow is structured, LLVM's is not. Keep it. |
| `src/ir/dialect/js.ts` + the R1/R2 gate (#3954) | `lit` (source-level) → `kgen` (canonical) → `pop`/`hlcf`, seven dialects total | Same idea. Ours is a hand-rolled registry; theirs is MLIR's. §4 is about closing that gap cheaply. |
| `BackendEmitter` trait (#1713/#1714) | MLIR dialect conversion (`LowerKGENToLLVM`, `LowerPOPToLLVM`) | Same. |
| `plan/issues/` with `status:` frontmatter | `mojo/proposals/` with a status legend (Implemented / Accepted / Proposed / Draft / Abandoned) and an index table | Same, and they explicitly say proposals go stale and are *not* kept current — a healthier stance than ours. |
| Tier-3 "refuse loudly", invariant L1 (#2960) | Swift-style fix-it diagnostics (`code-improvement-diagnostics.md`) | Same instinct — ours is scoped to `eval`, theirs is the whole compiler. See §5. |

---

## 1. The claim boundary is the problem, and the ratchet cannot fix it

**Evidence that the ratchet has hit its ceiling.**
`scripts/ir-fallback-baseline.json` (2026-08-03) reads `"unintended": {}` —
every unintended bucket is at **zero**. And `STRICT_IR_REASONS` in
`src/codegen/index.ts` is still an **empty set**, with a 30-line comment
explaining why it must stay empty: corpus-zero is measured against a 13-file
playground corpus, and most rejection reasons "describe LEGITIMATE IR
non-claimability that the legacy path must still catch."

Both statements are correct, and together they mean the instrument is
exhausted. `plan/log/ir-adoption.md` shows the real distribution: **24
`ir-owned`, 35 `mixed`, 5 `direct-only`.** The dominant state is *mixed* —
the IR handles a subset of a node kind, and one unhandled sub-shape demotes
the **whole function**.

**Why Mojo doesn't have this problem.** Its claim unit is the *instruction*,
not the function. Every construct has an op in some dialect; a construct with
no op is a parse error at the source, not a silent routing decision at
function granularity. There is no selector, because there is nothing to
select between.

**The steal, and it is already half-designed.**
`docs/architecture/runtime-eval-interpreter.md` §12.1 already names it:
producer (b), the **IR→bytecode backend as the AOT deopt target** — a
function the backend refuses becomes a bytecode blob in the constant pool
plus a thin Wasm wrapper, and its callers see an ordinary function value.
Today that is scoped to `with` and future deferred features. Widen it and the
picture inverts:

- The IR claims **everything**. `select.ts`'s claim question disappears.
- A construct the WasmGC backend can't lower is a **backend legality**
  question answered per-instruction, not a front-end refusal answered per
  function.
- The demote target is a *lowering* (bytecode blob) rather than a *second
  front end*, so `src/codegen/`'s front-end role can actually die instead of
  being asymptotically ratcheted.
- `STRICT_IR_REASONS` becomes unnecessary rather than unfillable.

This is the highest-value item in this document. It is not a new idea — it is
connecting #2855 (retire the fallback) to eval-doc §12.1 (producer b), which
are currently tracked as unrelated work.

## 2. They collapsed their two-mode split rather than maintaining it

`mojo/proposals/fn-to-def-migration.md` (23 Feb 2026, **Accepted**) retires
`fn` entirely. The stated reason is worth quoting because it is a
maintenance-cost argument, not an aesthetic one:

> "When developers see both `def` and `fn`, they assume a meaningful semantic
> difference. They must then unlearn that assumption, since the two forms
> differ only in whether `raises` is implicit or spelled out. … Choice
> without differentiation increases their mental load without adding
> capability."

Mojo's `def`/`fn` began as *exactly* our situation — a dynamic path and a
static path, with a gradual-typing story between them
(`mojo/proposals/mojo-and-dynamism.md`). Over time the two converged until
the only remaining difference was `raises`. They then **deleted one**, as a
breaking change, with a six-step migration: extend `def` to accept `raises` →
warn with a fix-it → require it → migrate the monorepo → flip semantics →
**remove `fn` before 1.0**.

The transferable discipline: *a split must correspond to a difference the
user can name, and every split that fails that test gets a removal date.*
Applied to our splits:

| Split | Names a real difference? | Status |
| --- | --- | --- |
| WasmGC vs linear backend | Yes — target dictates it | Legitimately permanent (codegen-axes doc says so) |
| JS-host vs standalone | Yes — a JS runtime is present or it isn't | Legitimate |
| IR vs legacy front end | **No** — same source, same semantics, different internal maturity | Deprecation-tracked, but **has no removal date** |

The third row is the gap. `plan/log/ir-adoption.md` has per-bucket owners and
target dates; it has no date at which the direct front end is *deleted*.
Mojo's migration shows that setting that date is what forces the remaining
work to be scoped, and step 2 of their plan — warn with a fix-it before
requiring — is the humane way to do it.

## 3. Elaboration is a phase, not a pass — and TS hands us the declaration site free

Mojo makes monomorphization **Phase 4 of six**
(`KGEN/docs/MojoCompilerWalkthrough.md`): `ElaborateGenerators` walks an
*expansion graph* of `ParamNode`s (generator + concrete parameter values),
runs **in parallel**, and evaluates compile-time code through a dedicated
**interpreter** — which "compiles" functions to `FunctionIRBytecode`,
maintains an emulated memory model, supports full control flow, and needs "no
actual JIT."

Ours is `src/ir/passes/monomorphize.ts`: a middle-end heuristic that clones a
callee when call sites pass distinct argument types, restricted to callees
that are non-recursive, **single-block**, and whose bodies **don't consume any
parameter as an operand**. `type-parameters` remains a `deferred` bucket in
the fallback table.

Two concrete steals:

**(a) The comptime evaluator we need already exists.** `src/interp/` is a
register+accumulator bytecode interpreter (ADR §13) built for Tier-2 `eval`.
KGEN's interpreter serves *compile-time evaluation* with essentially the same
design constraints. Pointing constant-folding and any future comptime
evaluation at the interp engine is one engine instead of two, and it gives
the interpreter a second consumer — which is exactly the pressure that keeps
its opcode set honest (eval-doc §12.1 already asks for this).

**(b) TypeScript gives us the `[]`/`()` split for free.** Mojo had to invent
syntax to separate compile-time parameters from runtime arguments. TS already
has it: `<T>` is Mojo's `[]`, `(x)` is Mojo's `()`. Specializing on
*declared* type parameters is a far more tractable problem than inferring
specialization from call-site argument types, and it retires the
`type-parameters` deferred bucket by construction rather than by heuristic.

## 4. Make the pass pipeline data, and verify after every pass

MLIR gives Mojo a `PassManager`: the pipeline is inspectable, passes are
named and reorderable, every op carries a verifier, and the walkthrough
documents a `--show-passes` invocation to print what actually runs.

Ours (`src/ir/integration.ts`, 320 KB) sequences passes as local variables:

```ts
const afterCF  = constantFold(cur, registry);   // :3709
const afterGVN = gvnFromEnv(afterCF);
const afterDCE = deadCode(afterGVN, registry);
const afterCFG = simplifyCFG(afterDCE);
```

and calls `verifyIrFunction` at **five** ad-hoc sites (`:1335`, `:1341`,
`:2080`, `:2155`, `:2443`). So a pass that corrupts the IR is attributed to
whichever later pass trips first.

This is the cheapest item here and requires adopting no Mojo language idea at
all: a declared pass list, `--print-ir-after=<pass>` / `--print-ir-before`,
and verify-after-every-pass behind a debug flag. Payoff is bisecting a
miscompile to a named pass in one run instead of by hand.

## 5. Diagnostics with fix-its, and the explicit refusal to grow a sea of flags

`mojo/proposals/code-improvement-diagnostics.md` (Lattner & Kindrat, Aug
2025, Accepted) surveys three models and rejects two by name:

- **Clang's flag soup** — pragmatic for C++, but "it encourages and enables
  house dialects, makes the compiler more complicated, and reduces incentive
  to improve the language and compiler."
- **Python's federated tools** (black/ruff/pylint/flake8) — "the ecosystem
  could become fragmented, and the community's effort dispersed."
- **Swift's model — adopted.** Structured `FixIt` rewrites attached to
  warnings and errors; few coarse flags; in-source suppression of specific
  instances; IDE/LSP integration that can auto-apply on version migration.

The load-bearing principle: *"we don't want a compiler to unilaterally change
code on disk"* — the compiler proposes the exact rewrite, the human or tool
applies it.

For us this is the generalization of invariant L1. Today a demote is a
**bucket count** in a warning channel aggregated by
`pnpm run check:ir-fallbacks`. Under Mojo's model each one is a
**source-located diagnostic carrying the rewrite that would fix it** —
"annotate `n: i32` to keep this in unboxed arithmetic", "this `with` body
compiles to the interpreter; hoist the lookup to stay AOT". We already have
`src/compile-explain.ts` and source positions (`src/position-map.ts`); what's
missing is the fix-it as a structured, machine-applicable field rather than
prose. They also note, correctly, that fix-its compose unusually well with
LLM tooling — which matters for a repo driven the way this one is.

---

## What deliberately does NOT transfer

**Mojo gets to walk away from its source language's semantics; we do not.**
`mojo-and-dynamism.md` states it flatly: *"Mojo is not a 'Python compiler'."*
Full Python compatibility is delegated to CPython interop, and Mojo emulates
"a faithful but not quite identical replication of Python behavior." That
freedom shows up in `edge-case-behaviors.md`: integer division by zero is left
as **undefined behavior**, out-of-bounds `List` access is UB in release
builds, and the floating-point model is *still undecided* ("Mojo has not yet
committed to either strict or relaxed").

We are at **32,615 / 43,621 test262 (74.8 %)** precisely because we cannot
make those calls. Do not import the posture. Their *four levels of dynamism*
ladder (static resolution → partial dynamism → full hashtable dynamism →
CPython ABI interop) is still a useful frame, and it maps onto our Tier 0–3
eval ladder — but their rung 4 is "delegate to the real implementation," and
we have no CPython to delegate to. Ours has to be a real interpreter, which
is why §1 matters more for us than it ever did for them.

**The ownership model is not available to us.** `read`/`mut`/`var`/`ref`
argument conventions, the `^` transfer sigil, ASAP destruction and a lifetime
checker are what let Mojo skip a GC. JS semantics don't permit it. Our
bounded version of the same idea already exists and is the right scope:
`src/ir/analysis/escape.ts`, `ownership.ts`, `stack-alloc.ts` — escape
analysis to avoid `struct.new`, not a borrow checker.

**Process footnote.** `AI_TOOL_POLICY.md` is worth five minutes given how
this repo is developed: label AI-assisted work with an `Assisted-by:` commit
trailer; keep PRs small because "AI lowers the cost of writing code, not
reviewing it"; humans write their own PR descriptions; no full automation
without human review. The middle one is the substantive claim, and it is a
direct argument against the large agent-authored PR.

---

## Prioritized action table

| # | Action | Size | Why now |
| --- | --- | --- | --- |
| 1 | Connect #2855 (retire fallback) to eval-doc §12.1 producer (b): make IR→bytecode the **universal** deopt target so the IR always claims and `select.ts`'s claim question dies | XL | The unintended buckets are at zero and `STRICT_IR_REASONS` still can't be filled — the current approach is out of road (§1) |
| 2 | Declared pass list + `--print-ir-after` + verify-after-every-pass under a debug flag | S | Cheapest item here; unblocks bisecting miscompiles to a named pass (§4) |
| 3 | Set a **removal date** for the direct AST→Wasm front end, with a fix-it-warning stage before it | S (decision) | Mojo's `fn` migration shows the date is what scopes the remaining work (§2) |
| 4 | Turn IR demotes into source-located diagnostics carrying a machine-applicable rewrite, not warning-channel bucket counts | M | Generalizes invariant L1 from `eval` to the whole compiler; `compile-explain.ts` + `position-map.ts` are already in place (§5) |
| 5 | Specialize on **declared** TS type parameters instead of inferred call-site types; retire the `type-parameters` deferred bucket | L | TS hands us Mojo's `[]`/`()` split for free (§3b) |
| 6 | Point constant-folding / comptime evaluation at `src/interp/` instead of growing a second evaluator | M | One engine, and a second consumer keeps the opcode set honest (§3a) |

## How this was assembled

Shallow clone of `modular/modular@main` on 2026-08-19, then direct reads of
`KGEN/docs/MojoCompilerWalkthrough.md` (dialect table, six-phase pipeline,
elaboration + interpreter), `KGEN/lib/` (dialect directory listing),
`mojo/proposals/{fn-to-def-migration,mojo-and-dynamism,code-improvement-diagnostics,edge-case-behaviors}.md`,
`mojo/stdlib/std/python/python_object.mojo`, and `AI_TOOL_POLICY.md`.
`KGEN/docs/DesignOverview.md` was read and **not** used — it is a May 2022
pre-Mojo kernel-compiler document, retained in-repo for historical interest
and explicitly marked as not describing the current system.

js2wasm figures were measured in this working tree at commit `8cb0c933`, not
quoted from prior artifacts: file sizes via `du`, `select.ts` 456 KB,
`integration.ts` 320 KB, `from-ast.ts` 632 KB, 431 files in `src/codegen/`;
adoption counts by grep over `plan/log/ir-adoption.md`; the empty
`"unintended"` map read from `scripts/ir-fallback-baseline.json`
(generated 2026-08-03); pass-sequencing and verifier call sites by grep over
`src/ir/integration.ts`.
