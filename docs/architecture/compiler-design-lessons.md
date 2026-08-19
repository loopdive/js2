# What we can learn from general compiler design

> A vendor-neutral synthesis of durable patterns from production language
> runtimes, optimizing-compiler infrastructure, the SSA/IR literature, and
> ahead-of-time source→bytecode compilers — distilled into recommendations
> for **this** compiler (typed SSA middle-end with block arguments,
> late-resolved symbolic refs, multiple backends behind a `BackendEmitter`
> trait, staged AST-kind adoption gated by a fallback ratchet).
>
> Companion to [`codegen-axes.md`](codegen-axes.md). That doc tells you
> *which axis your change is on*; this one tells you *which direction the
> field says to push*. No competitor projects are named — only the patterns
> that recur across all of them, with our own architecture as the subject.
>
> For a single named project read against our architecture, see
> [`lessons-from-mojo.md`](lessons-from-mojo.md).
>
> Read time ~15 min. The TL;DR is the next section; the prioritized action
> table is at the bottom.

---

## The one idea everything else hangs on

A dynamically-typed runtime spends enormous machinery **discovering at run
time** what our compiler **already knows at compile time from TypeScript
types**: object shapes, monomorphic call targets, numeric widths, whether a
value can be `null`. The single most transferable lesson is therefore *not*
"copy what fast runtimes do." It is:

> **Keep the *code shape* a fast runtime arrives at (fixed-slot structs,
> direct calls, unboxed arithmetic) — and delete the *discovery machinery*
> that gets it there (type feedback, inline caches, speculation,
> deoptimization, tiering).**

Static types are the runtime's "profile data," handed to us for free and
known to be total. Our job is to *compile the dynamism away* — exactly the
project's existing `feedback_compile_away` principle — and fall back to a
general dynamic representation only where the types genuinely run out.

Everything below is a corollary of that idea or of the discipline needed to
sustain a staged migration toward it.

---

## Where we already align with the consensus (don't re-litigate these)

These are settled questions in the field, and our existing choices are the
*modern* answers. Flag for new contributors so they aren't re-opened:

1. **CFG + SSA with block arguments** is the representation the field
   converged on. The most aggressive graph-based alternative
   ("everything floats, recover an order later") was tried at the largest
   scale and **abandoned** for a conventional CFG+SSA form: cited reasons
   were an unintuitive mental model, fragile effect-ordering bugs that hid
   for months, cache-unfriendly traversal, and ~2× compile time — with the
   move back *halving* compile time and making bugs tractable. Our IR is
   already block-argument SSA. **Do not drift toward a "sea of nodes" for
   "more optimization freedom."** We delegate heavy optimization downstream
   (see R8), so that freedom would be pure cost.

2. **Block arguments over Φ-nodes.** Representationally identical, but Φ
   carries special cases (must cluster at block top, parallel-execution
   semantics, function params as a *separate* concept, positional operand↔
   predecessor coupling) that block arguments define away. Our entry block's
   arguments *are* the function parameters — one concept, not two — and
   merge values are ordinary typed parameters threaded through branches,
   which suits our **late symbolic-ref resolution** perfectly.

3. **A typed IR replacing accumulated direct-codegen hacks.** With *N*
   backends, direct AST→target codegen costs `features × targets` untyped
   special-cases; a typed mid-level waist collapses that to
   `features + targets` typed, verifiable passes. We have two real backends
   (three emitters) — so this abstraction is *justified by genuine variety*,
   not speculation.

4. **A host-optional dual mode with standalone fallbacks** (dual string
   backend, dual RegExp backend). The field's rule for host imports matches
   ours exactly (R9).

5. **Delegating heavy optimization to a mature external optimizer.** Correct
   division of labor (R8).

If you find yourself arguing against one of these, the burden of proof is
high — the field has the receipts.

---

## Recommendations

Each is: **the general pattern → why it matters → our current state →
concrete action.** Priority tags: **[P1]** do soon / high leverage,
**[P2]** worthwhile, **[P3]** opportunistic.

### R1 — Treat the IR verifier as a hard contract between every pass [P1]

**Pattern.** Define a formal IR invariant verifier and run it *between
passes*: each pass may **assume** valid input and **must** produce valid
output. A pass that emits invalid IR has a bug, attributed to *that pass* —
not to whatever consumes the garbage three layers later. Keep checks *local*
(don't walk def-use chains in the verifier); when many passes re-check the
same thing, promote it into the verifier or into the IR type.

**Why.** This is the single highest-leverage practice for a staged
migration. The fallback ratchet measures *coverage*; the verifier measures
*correctness of what was covered*. It turns "malformed Wasm reached the
backend" into an immediate, localized failure.

**Our state — already started, finish it.** `src/ir/verify.ts`
(`verifyIrFunction`) already enforces SSA single-definition, use-before-def,
one-terminator-per-block, branch-arg arity against target signatures, and
symbolic-refs-only (no raw indices). It is already invoked pre- and
post-pass in `integration.ts` (including `postErrors` after optimization).
This is exactly the right backbone.

**Action.**
- Close the explicit Phase 2 gaps in `verify.ts`: **cross-block use /
  dominance** ("every use is dominated by its def") is currently a TODO.
  Until it lands, a whole class of SSA-violation bugs is invisible.
- Add a **per-backend legality check** at the emit boundary: "is this IR
  legal for *this* target?" (e.g. a struct-allocation node is legal under
  the GC backend, illegal under linear where it must be rewritten). This
  catches "fine for one backend, illegal for another" at the IR boundary
  instead of as a downstream Wasm-validation failure.
- Make verifier failure **fail CI in debug/test builds**, not just feed the
  fallback decision. A demotion-on-verify-failure that nobody counts is a
  silent bug (see R6).

### R2 — Make illegal IR states unrepresentable in the type, not merely detected [P1]

**Pattern.** Prefer encoding an invariant in the data type (so an illegal
combination is *unconstructible*) over a runtime assert (so it's only
*detected*). "Make illegal states unrepresentable." Every invariant the host
type system enforces is one you never verify at runtime and never debug.

**Why.** It shrinks the verifier surface and eliminates whole bug classes at
the source. It's the structural complement to R1.

**Our state.** The discriminated `IrType` union is the right lever; we
already lean on exhaustive `switch`. Some states are still "valid by
convention."

**Action.**
- Make the **"not-yet-resolved symbolic ref"** a *distinct variant* from a
  resolved one, so no backend can accidentally lower an unresolved ref —
  the late-resolution state lives in the types, not in a side flag.
- Keep boxing/representation choices (`val` / `union` / `boxed`) as
  *distinct variants carrying only their legal fields*, so an ill-typed
  combination (e.g. an `externref` where an i32 is structurally required)
  can't be constructed.
- Audit `as unknown as Instr` casts (CLAUDE.md tracks ~158): each is a hole
  in this guarantee. Bank them down as the `Instr` union grows (already
  tracked as #1526) — every retired cast is an invariant moved into the type.

### R3 — Finish the strangler migration: drive each bucket to zero, then delete the legacy path [P1]

**Pattern.** Incremental replacement of a legacy path is a *strangler-fig*:
a façade routes each unit to new-or-legacy, the system keeps shipping, and
the migration **terminates** by *removing* legacy responsibilities — not by
keeping two paths forever. The flag lifecycle per unit is **opt-in →
default → mandatory (legacy deleted)**. The step teams skip — and regret —
is the last one.

**Why.** A fallback retained indefinitely becomes load-bearing again; the
dual-path maintenance cost never ends; and a *silent* fallback masks the
fact that the new path is broken, so your adoption metric stalls invisibly.

**Our state — textbook-correct mechanics, the missing discipline is
finishing.** The per-AST-kind dispatcher *is* the façade. The fallback-budget
ratchet (`pnpm run check:ir-fallbacks`, `scripts/ir-fallback-baseline.json`)
is the right antidote to silent masking: every demotion increments a
*counted* bucket, CI fails if an *unintended* bucket grows, "deferred"
buckets are an explicit decision. The `--update-on-decrease` ratchet banks
gains automatically. The endgame — a zeroed bucket gets promoted into
`STRICT_IR_REASONS` so any future regression is a *hard error*, not a silent
legacy fallback — is exactly the correct termination condition (#1530).

**Action.**
- Keep prosecuting the **unintended** buckets to zero (`body-shape-rejected`,
  `external-call`, `call-graph-closure`, the type-resolution family,
  `class-method`) per the owners/dates in `ir-adoption.md`. This is already
  the plan; the lesson from the field is simply: *it is the whole game —
  don't let it stall at "good enough with a fallback."*
- Phase out the **demote-to-warning escape hatch**
  (`src/codegen/index.ts:889–896`) on schedule (#1530). The end state is
  *two* states per node kind — "IR owns it" or "deferred, by decision" —
  with **no third silent "claimed it then fell back" state.**

### R4 — Make the `BackendEmitter` trait an explicit *legalization* boundary, with state in the IR [P2]

**Pattern.** Lower *progressively* through levels; at the target boundary,
**legalize**: declare what each target's legal op/type set is, then rewrite
illegal ops into legal ones (or fail loudly listing what couldn't be
converted). Split **type-legalization** (map abstract types to a target's
value types) from **op-legalization** (rewrite unsupported ops). Keep all
lowering state **in the IR**, inspectable and verifiable at every step — not
in opaque side-tables. Prefer many small, individually-testable lowering
steps.

**Why.** Target-specific constraints get handled in *one declarative place*
instead of leaking `if (target === …)` into every pass. "Is lowering
finished?" becomes a checkable predicate ("only legal ops remain"), not a
vibe. State-in-IR is what makes a multi-backend pipeline debuggable: you can
dump the module right before each backend diverges and diff it.

**Our state.** The `BackendEmitter` trait (`src/ir/backend/emitter.ts`) with
`wasmgc-emitter`, `linear-emitter`, and a `bytecode-emitter` is precisely
this seam, and the "vec" group already proves it abstracts a real second/
third backend (#1714). `type-coercion.ts` is, in effect, our type-legalizer
(externref boxing, i32↔f64, null/undefined-in-f64-context).

**Action.**
- Frame each backend explicitly as a **legality declaration + lowering
  pattern set**, not a hand-rolled switch. Two (now three) "conversion
  targets"; the same mid-level node is legal/illegal differently per target.
- Lift `type-coercion.ts` into an explicit **type-converter** consulted by
  the legalization step, so "what value type does `IrType X` become on
  backend Y" has one home.
- Insert at least one **backend-neutral, Wasm-shaped level** (calls, locals,
  structured control resolved; object representation still abstract) *above*
  the GC-struct-vs-linear-load/store split, and run shared folding/peephole
  there once for all backends (ties into R8).
- Continue migrating the aggregate/closure/ref-coercion groups behind the
  trait (#1713) — the remaining inline `struct.new`/`struct.get`/`ref.cast`
  in `lower.ts` are the legalization leaks to close.

### R5 — Value representation should be *per-backend*; keep the typed mainline unboxed [P2]

**Pattern.** A uniform tagged value word (NaN-boxing; small-int tagging) is
the right tool *only for the genuinely dynamic residue*. For typed code,
**specialize on the static type and never box in the common case**; the
boxed/tagged form is a *boundary interchange* representation, not the
*compute* representation. The three dynamic-value strategies (uniform
NaN-boxed word / parallel value+tag locals / per-type specialization) trade
the same three axes — codegen complexity, runtime speed, binary size — and
resolve **differently on different backends**.

**Why.** Numbers dominate hot code; boxing them is the difference between
native arithmetic and an allocation per op. And a uniform word that's right
for a linear-memory dynamic path is the *wrong* default on a host-GC backend
that has reference types and small-int-in-a-reference for free.

**Our state.** `coerceType` already keeps the f64 fast path unboxed and
boxes only at the boundary (`__box_number`, `extern.convert_any`, emitting
`f64.const 0/NaN` directly for null/undefined in f64 context to dodge the
externref roundtrip). This is the correct instinct.

**Action.**
- Make the **per-backend** choice explicit at the trait: on the **GC
  backend**, prefer real `ref` types + `ref.cast`/`br_on_cast` (let the
  engine's type info replace a hand-carried tag for proven-monomorphic
  values; fall back to a boxed `anyref`/`i31ref` + tag only on the dynamic
  path — `i31ref` gives small-int-in-a-reference for free). On the **linear
  backend**, a value-`f64` + type-`i32` parallel-locals scheme is the
  natural dynamic representation.
- Hold the line that the boxed form is *interchange only*: unbox at the
  static-type boundary for the whole typed region (we can do at compile time
  what a runtime does per-loop-iteration). Resist "make everything a
  reference" on the GC backend.

### R6 — Never let a fallback or demotion be silent; bucket "compiler error / malformed output" separately from "unsupported" [P1]

**Pattern.** A silent fallback ships *something that works* while hiding that
the new path is broken — the single most insidious failure of an incremental
migration. Every demotion must increment a **counted, reason-bucketed**
metric. Separately, track **"compiler crashed / emitted malformed output"**
as a first-class *stability* bucket, distinct from **"feature not yet
supported."** Conflating them hides regressions behind expected gaps.

**Why.** Coverage and stability are different signals. "We don't support
`Proxy`" is a roadmap fact; "we emitted invalid Wasm for a `for` loop" is a
bug. A dashboard that merges them can't see the bug.

**Our state.** The fallback budget already buckets demotions by reason and
fails on unintended growth (good). The test262 dashboard is bucketed.

**Action.**
- Ensure the test262 / conformance dashboard keeps a **hard-error bucket**
  ("compiler error" / "malformed Wasm") that is watched as a *stability*
  metric and gated, *separately* from the informational "unsupported
  feature" count. Aim to keep the hard-error bucket near-zero; treat any
  growth as a release-blocking regression, not a coverage statistic.
- Tie this to R1: a verifier failure on a claimed function must land in the
  hard-error bucket, never be quietly swallowed.

### R7 — Layer the test strategy; add cross-backend differential testing [P1]

**Pattern.** The highest-yield compiler correctness method is **differential
/ equivalence testing against a reference oracle** (compile-and-run, compare
to a trusted implementation) — it turns the undecidable "is this correct?"
into the tractable "does it match?". Layer on: **conformance** as a
non-regressing ratchet; **UB-free random program generation** (a generator
that avoids undefined/unspecified behavior, or its "wrong" outputs drown the
real bugs); **equivalence-modulo-inputs** self-oracles (inject provably-dead
code; output must not change); and **automated validity-preserving
minimization** so every failure arrives as a small repro.

**Why.** A reference oracle is what makes large-scale automated testing
possible at all. Minimization is what makes a fuzz/conformance failure
*actionable* (nobody debugs a 2000-line repro).

**Our state.** the `tests/equivalence/` suite (compile-and-run-vs-reference,
plus the IR-specific `tests/ir-*-equivalence.test.ts`) is the right backbone;
the test262 baseline regression gate is the conformance
ratchet, and the project already validates the baseline (spot-checking that
"pass" entries still pass on HEAD) so it can't drift into false greens.

**Action.**
- Add a **cross-backend differential test** — compile the same TS to the GC
  backend *and* the linear backend and assert identical observable output.
  This is **nearly free** given the dual backend and catches
  backend-specific lowering bugs a single-oracle test can't. (Now three
  emitters: GC vs linear vs bytecode-VM is a three-way oracle.)
- Invest in a **UB-free TS program generator.** TS is far closer to
  UB-free than low-level languages, so a *sound* generator is markedly
  easier here than the prior art it's modeled on — an unusually high-ROI
  bet for us.
- Wire **automatic minimization** (remove statements/branches, re-run the
  equivalence oracle, keep reductions that still mismatch *and* still
  typecheck) to fire on any equivalence failure, attaching a minimal repro
  to the failing node kind.
- Run equivalence tests **both before and after** the external optimizer —
  miscompiles hide on either side of that boundary.

### R8 — Do the cheap SSA optimizations yourself once for all backends; delegate the heavy/order-sensitive ones [P2]

**Pattern.** The high-ROI, low-cost optimizations are **DCE, constant
folding/propagation, copy propagation, GVN, and conservative inlining** —
all cheap on SSA. Run them at the **mid-level once**, so *every* backend and
the downstream optimizer receive smaller, canonical IR. Don't try to *solve*
phase ordering; adopt the pragmatic recipe of re-running the cheap
canonicalizer after the structural passes. Leave aggressive, order-sensitive
optimization (loop transforms, register/local coloring, machine peepholes)
to a mature external optimizer.

**Why.** Reimplementing aggressive optimization is enormous effort with high
miscompile risk; an external optimizer has absorbed that cost and is tested
at scale. The mid-end's contract is *correct + canonical + small*; the
external pass makes it *fast*.

**Our state.** We integrate an external Wasm optimizer via
`src/optimize.ts` (the `-O`/`--optimize` flag) and keep a focused peephole
pass for patterns we uniquely know (dropping redundant `ref.as_non_null`
after `ref.cast`). Correct division of labor.

**Action.**
- Run a short, **fixed mid-level cleanup pipeline** (fold + copy-prop + DCE,
  re-run after lowering/inlining) at the backend-neutral level from R4, so
  both backends benefit before they diverge.
- Keep inlining **conservative** (small / single-call-site) — the external
  optimizer does the aggressive version.
- The external optimizer's dedicated **GC-optimization** passes benefit the
  GC backend disproportionately; keep leaning on them there.

### R9 — Gate host imports by "hot-or-expensive, always with a standalone fallback" [P2]

**Pattern.** A host import is justified **only** when (i) the operation is
hot enough that a call-boundary hurts, **or** (ii) re-implementing it
standalone is disproportionately expensive — **and even then, always behind
a standalone fallback.** Prefer the platform's reserved-namespace builtins
(engine-recognized at compile time, polyfillable) over bespoke imports.

**Why.** Host imports buy completeness and speed cheaply but cost
portability and grow the host-dependency surface. The discipline keeps the
standalone (pure-Wasm) mode coherent.

**Our state.** This *is* our "JS host optional" principle and CLAUDE.md's
"don't add new host imports without a standalone fallback" rule. The dual
string backend (`nativeStrings` i16 arrays vs `wasm:js-string`) and dual
RegExp backend are exact instances.

**Action.**
- Apply the gate consciously to new work: the strongest host-import
  candidates by this rule are **RegExp and BigInt** (expensive to
  reimplement, well-served by the host); the weakest are **arithmetic and
  simple array ops** (keep standalone). Strings sit in between — keep the
  host fast path as default under a JS host, auto-fall-back to i16 arrays
  for standalone/WASI (already wired).

### R10 — Cooperate with the host collector where one exists; own linear memory only when layout demands it; don't build a pluggable GC [P2]

**Pattern.** Don't ship a garbage collector into an environment that already
has one. Where the host provides a GC, hand it object lifetime (fixed-field
managed structs) — smaller binaries, free cross-boundary cycle collection,
no GC-on-GC interference, and proper closures via reference/function types.
Own linear memory only when you need layout control the managed model
forbids (interior pointers, packed buffers, typed-array backing, arenas).
And **don't** build an "interchangeable GC strategy" abstraction — the field
consensus is that supporting tracing and reference-counting as swappable is
*not viable* (reference counting can't collect cycles, so you bolt on
tracing anyway); pick one.

**Why.** This *is* the WasmGC-vs-linear axis, articulated by the platform
itself, and it validates keeping both backends. The GC subsystem is the
most-redesigned part of every compiler in this space — over-abstracting it
is a documented trap.

**Our state.** The two backends already encode this. CLAUDE.md correctly
frames them as *alternatives, not rivals* — GC backend for browser/WasmGC,
linear for WASI/Component-Model.

**Action.**
- Keep the **GC backend the default where a host GC exists**; reserve
  linear for WASI/standalone and layout-control features.
- For the linear backend's reclamation, if/when needed, pick **one** fixed
  strategy (e.g. tracing, or RC-with-a-cycle-collector) — not a pluggable
  abstraction. A bump/arena "allocate-and-exit" mode is a near-free win for
  short-lived WASI programs (most conformance programs allocate and exit).
- Lean into the closure advantage: managed reference/function types let us
  do closures *properly* (our ref-cell capture pattern,
  `struct (field $value (mut T))`) where linear-only designs were stuck.

### R11 — Keep compile-time-constant metadata *off* the SSA dataflow [P3]

**Pattern.** Distinguish two channels on an IR node: **operands** (runtime
SSA values, in the use-def graph) and **attributes** (compile-time-constant
facts — a comparison predicate, an alignment, a literal's payload, a
backend/feature flag). Keep constants in the attribute channel so they ride
along to whichever backend needs them *without* polluting use-def reasoning
or coercion logic.

**Why.** It keeps the dataflow graph clean (SSA analyses don't trip over
non-values) while keeping the metadata attached and verifiable.

**Our state.** We carry native-type annotations (`type i32 = number`),
`nativeStrings`, string-backend selection, etc. — these are exactly the
"attribute, not operand" facts.

**Action.** When adding IR nodes, carry such compile-time facts as
**node metadata/attributes**, not as synthetic SSA operands. (Closed type
union is the right call for a single-source-language compiler — keep it; the
lesson here is only the operand-vs-attribute split.)

---

## Anti-patterns: roads the field already mapped and turned back from

Stated vendor-neutrally; each is a documented, reversed decision somewhere.

- **Sea-of-nodes for "optimization freedom."** Abandoned at scale: messy
  mental model, fragile effect chains, scheduling/cache waste, ~2× compile
  time. We're already CFG+SSA — stay there.
- **A global whole-program type-inference layer every function pays for.**
  Deleted in favor of *local* type information: it bloated memory, taxed GC,
  forced serialized (non-parallel) compilation, and added complexity for
  benefit only in hot code. For us: lean on **TS annotations + local type
  propagation**; reach for whole-program analysis (e.g. class-hierarchy
  analysis for devirtualization) only where it pays, and keep it optional.
- **Attaching type information where it has no operational meaning.** A
  famous multi-year migration removed pointee-types from pointers because
  they carried no real semantics; the fix was to put the access type on the
  *operation* (load/store) instead. For us: keep memory-access **width/type
  on the linear-backend load/store op**, not on a "typed pointer."
- **"Any value" sentinels (undef/poison-style).** Under-specified values
  that may read differently at each use are an optimization minefield and a
  recurring miscompile source; the long arc is to *remove* them. Our
  `VOID_RESULT` is fine because it's a **typed, total "no value"** marker,
  not an "any value." Keep it that way — never introduce a value that
  legitimately differs per use.
- **Semantics-erasure during lowering.** When the linear backend lowers
  managed references or strings to raw bytes, ensure nothing downstream
  assumes a property the lowering silently dropped (the classic
  lose-provenance-through-`memcpy` miscompile). This is where a dual backend
  is most exposed; let the verifier (R1) record enough to forbid it.
- **Globally-uniqued *mutable* IR state.** It blocks parallel compilation
  after the fact. Keep IR nodes **immutable-by-replacement** (rewrite by
  producing new nodes, as canonicalization does) — easier to verify, and it
  keeps the door open for the project's parallel-compile model
  (`COMPILER_POOL_SIZE`).
- **An indefinitely-retained legacy fallback.** It quietly becomes
  load-bearing again. Finish the strangler (R3).

---

## What deliberately does NOT transfer (we are AOT and statically typed)

Resist cargo-culting runtime machinery. None of these should be built:

| Runtime-only mechanism | Why it doesn't apply to us |
|---|---|
| **Multi-tier JIT / on-stack replacement / frame swapping** | We emit one artifact and never recompile a *running* frame. (The only analogue is a *build-time* `-O` choice — already have it.) |
| **Runtime type feedback / shape discovery** | Static types *are* the feedback, known at compile time and total. Nothing to observe. |
| **Speculation + deoptimization** | No interpreter tier to bail to. Building it would import the worst runtime failure modes (deopt loops, the megamorphic cliff) for zero benefit. |
| **Inline caches for typed access** | A typed `struct.get` needs no cache. Only the genuinely dynamic `any`/reflective residue could want a tiny per-site cache — last resort, not a default. |
| **A universal NaN-boxed / tagged value word for the typed mainline** | Only relevant to the dynamic residue, and even there the GC backend's `anyref`/`i31ref` is the better primitive (R5). |

**But these *static* analogues of runtime tricks DO transfer and we should
exploit them:** **devirtualization** (compile a call to a direct `call` when
the receiver type pins one target; vtable/`call_ref` only for genuinely
polymorphic sites), **monomorphization** (specialize generics per
instantiation at compile time — bounded code-size cost, zero runtime cost),
and **guards that *trap* rather than deoptimize** (`ref.cast`/`ref.test`,
bounds checks, null checks emitted only where types can't prove the fact).

A related boundary lesson: **pure-AOT inference has a hard ceiling** — object
shape/deep type analysis can't always be resolved statically, and the JIT
escape hatch (inline caches) isn't available to us. So the **dynamic-fallback
path is permanent and load-bearing**, not temporary scaffolding. Ratchet a
bucket to zero (R3) *only* for kinds whose semantics are statically
decidable; the genuinely-dynamic residue keeps a correct, reasonably-fast
general path forever.

---

## Don't over-abstract *forward*

We have two/three *real* backends, so the `BackendEmitter` trait is shaped by
genuine variety — justified, not premature. The caution runs the other way:
**don't pre-build trait surface for a hypothetical fourth target we don't
have.** Add an emitter method only when a concrete backend needs it; let a
lowering rule be duplicated across two node kinds until a third appears, then
factor the shared helper. "Prefer duplication over the wrong abstraction"
applies *inside* each backend even though the cross-backend seam itself has
earned its keep.

---

## Prioritized action table

| # | Action | Priority | Anchors in our tree |
|---|--------|----------|---------------------|
| R1 | Close `verify.ts` cross-block/dominance gap; add per-backend legality check; fail CI on verify error | **P1** | `src/ir/verify.ts`, `src/ir/integration.ts` |
| R2 | Move invariants into the `IrType` union (distinct unresolved-ref variant); retire `as unknown as Instr` casts | **P1** | `src/ir/nodes.ts`, #1526 |
| R3 | Keep driving unintended fallback buckets to zero; phase out the demote-to-warning hatch; promote zeroed buckets to hard errors | **P1** | `check:ir-fallbacks`, `src/codegen/index.ts:889–896`, #1530, `ir-adoption.md` |
| R6 | Keep a separate hard-error ("malformed/compiler-error") stability bucket on the conformance dashboard | **P1** | test262 dashboard, baseline gate |
| R7 | Add cross-backend differential tests; build a UB-free TS generator; auto-minimize on failure; test pre+post optimizer | **P1** | `tests/equivalence/`, three emitters |
| R4 | Frame each backend as a legality declaration + pattern set; lift `type-coercion.ts` into an explicit type-converter; add a backend-neutral mid-level; finish trait migration | **P2** | `src/ir/backend/`, `type-coercion.ts`, #1713/#1714 |
| R5 | Make value representation explicitly per-backend (typed refs/`i31ref` on GC; f64+tag on linear); keep typed mainline unboxed | **P2** | `coerceType`, `BackendEmitter` |
| R8 | Run cheap SSA cleanup (fold/copy-prop/DCE/GVN) once at the mid-level; keep delegating heavy opt | **P2** | `src/optimize.ts`, `src/codegen/peephole.ts` |
| R9 | Apply the host-import gate consciously (RegExp/BigInt yes; arithmetic no; always a fallback) | **P2** | dual string/RegExp backends, #679/#682 |
| R10 | GC backend default where a host GC exists; one fixed linear-GC strategy (+ bump mode); lean into proper closures | **P2** | `src/codegen/` vs `src/codegen-linear/` |
| R11 | Carry compile-time-constant facts as node attributes, not SSA operands | **P3** | `src/ir/nodes.ts` |
| — | Don't pre-abstract for a 4th backend; duplicate until the rule-of-three | **P3** | `src/ir/backend/emitter.ts` |

---

## How this was assembled

The patterns above are the points of **convergence** across four
independent research streams (multi-level IR infrastructure; production
language-runtime architecture; ahead-of-time source→Wasm compilers; and the
foundational SSA / nanopass / compiler-testing literature). A lesson earned
its place here when it recurred across streams *and* mapped onto a concrete
seam in our tree. The strongest signals — block-argument SSA over
sea-of-nodes, the verifier-between-passes contract, the strangler+ratchet
migration, and per-backend value representation — were each corroborated by
multiple, unrelated sources, which is why they sit at P1.
