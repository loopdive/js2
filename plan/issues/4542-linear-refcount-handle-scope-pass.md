---
id: 4542
title: "Refcount discipline for the boxed tier: a handle-scope / destructor-insertion pass covering exceptional paths"
status: in-progress
sprint: Backlog
created: 2026-08-17
updated: 2026-08-19
priority: high
horizon: l
feasibility: hard
model: fable
reasoning_effort: max
task_type: feature
area: codegen-linear
language_feature: compiler-internals
goal: standalone-mode
parent: 4538
depends_on: [4541]
related: [652, 4236]
# id 4542 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4542 — Refcount discipline as a codegen obligation

Slice 4 of #4538. Implements handoff item 6 from #4236's slice-2 table.

## Problem

ADR-0020 adopts reference counting plus the engine's cycle collector as the
linear lane's reclamation strategy. The engine provides the mechanism
(`JS_DupValue` / `JS_FreeValue`); **we** must provide the discipline. The rule
is simple to state — one owner, released on every exit from its scope — and
still has to be implemented on *every* path codegen can emit, including:

- early `return` / `break` / `continue` out of a scope holding handles;
- `throw` and the unwind path through intervening frames;
- values consumed by an API call that takes ownership (the `SetProp`-consumes-a-
  reference class), versus ones that borrow;
- temporaries that never reach a named binding.

Getting this wrong fails in two directions: a missing release leaks silently,
and an extra release is a use-after-free that surfaces far from its cause.

Precedent worth reading first: **#652** (compile-time ARC / static lifetimes)
covers the same discipline for a different target.

## Scope

- A handle-scope / destructor-insertion pass over the linear lane's IR, placing
  dup/free at the right points rather than at every assignment.
- An **ownership annotation** on each declared engine import (consumes vs
  borrows), so the pass is driven by the ABI table from #4539 rather than by a
  hand-maintained list. The pinned artifact's shim already normalises this —
  the shim borrows, with one destructor rule (#4236 slice 1).
- Exceptional-path coverage designed in from the start, not retrofitted: the
  unwind path is where hand-written discipline reliably breaks.

## Acceptance criteria

- [ ] A stress fixture allocating and dropping dynamic values in a loop shows a
      **flat** heap — no growth over iterations.
- [ ] The same holds when the loop body throws and is caught, and when it
      returns early from nested scopes.
- [ ] A deliberate double-free and a deliberate missing-release are both caught
      by the test suite (negative tests — proving the harness can see the bug
      class it is meant to guard).
- [ ] Every declared engine import carries an ownership annotation; an import
      without one is a compile error, not a default.
- [ ] No refcount traffic is emitted on typed-only paths.

## Validation

- Heap-growth stress fixture across normal, early-exit, and throwing paths.
- Differential execution against Node for the same fixtures (a refcount bug
  frequently shows up first as a wrong value, not as a crash).

## Elision safety condition (agreed 2026-08-18)

Elision stays out of scope for this slice (see Non-goals), but the condition
under which it is *legal* belongs here, because the pass this slice builds is
what a later elision pass would edit, and the rule is easy to get wrong in a way
tests do not catch.

**Rule.** A balanced `JS_DupValue` / `JS_FreeValue` pair around a region R may be
elided only if another reference to the value is held for the whole of R by an
owner that **nothing in R can release**.

**"Alive on entry to R" is not sufficient**, and that is the entire content of
the rule. The engine adjusts refcounts as it runs — the same property ADR-0020
cites when rejecting our own refcounting over engine objects — so a reference
that exists when R begins can be dropped inside R by engine code we called.

**The counterexample the rule exists to reject:**

```js
const a = obj.x;   // pass wants to elide a's dup, reasoning "obj.x still holds it"
f(a);              // borrows — harmless
obj.x = other;     // engine releases the old value; its count may reach zero
use(a);            // use-after-free
```

The proposed owner (`obj.x`) is a container slot, and a container slot is
invalidatable by any engine call able to write it.

**Practical form for the pass:**

- An owner qualifies only if it is a root the pass itself established and no
  engine call in R can reach — a local root, never a slot in an engine-visible
  object.
- Any engine C API call inside R invalidates elision against a container-slot
  owner, unless that import's `ownership` annotation (the #4539 ABI table)
  establishes it cannot release the owner. This is the **second** consumer of
  those annotations, alongside consumes/borrows, and is worth stating because it
  affects what the annotation must be able to express.
- When in doubt, keep the pair. A redundant dup/free costs measurable time; a
  wrong elision is a use-after-free surfacing far from its cause — the failure
  mode this issue's Problem section already names as the expensive direction.

## Non-goals

- Cycles — reclaiming those is the engine's collector, with the residual
  cross-heap leak class documented in #4541.
- Optimising the discipline (elision of provably-balanced pairs). Correct
  first; a measured elision pass is separate follow-up work — its
  safety condition is agreed and recorded above, so the follow-up starts from a
  rule rather than deriving one.

## Implementation notes (2026-08-19) — the pass, and WHY it is shaped this way

Landed in `src/codegen-linear/refcount/`:
`ownership.ts` (declared ABI input) · `handle-ir.ts` (the IR the pass rewrites)
· `handle-scope.ts` (the pass) · `verify.ts` (independent balance checker)
· `lower.ts` (rewritten IR → `Instr[]`) · `pinned-shim.ts` (the real ABI table
+ a drift check against `scripts/quickjs-artifact/qjs_shim.c`).

### The three rules, and why each is the SAFE one

1. **Acquire-owns, scope-releases.** A `+1` belongs to the innermost enclosing
   scope and is released when control leaves it, in reverse acquisition order.
2. **Consume-dups, never moves.** Handing an owned handle to a `consumes`
   parameter emits a dup and leaves the scope's release in place.
3. **Ownership only GROWS within a scope**, so the cleanup handler at any throw
   point is exactly the set of handles already acquired.

Rule 3 is load-bearing and is why **release-at-last-use was rejected**. Last-use
release makes the owned set shrink mid-scope, and then a single `catch_all` per
scope double-frees whatever was already released. The repairs are drop flags (a
runtime branch per handle) or non-nesting live ranges (which cannot be expressed
as nested `try` regions at all). Rule 2 exists for the same reason from the
other side: a move is a mid-scope shrink. Its cost is one redundant dup/free
pair — exactly the pair the "Elision safety condition" above says a later pass
may remove, and exactly the direction that section's closing line picks.

### One cleanup region per handle, not one per scope

A single `catch_all` covering a scope would free handles not yet acquired when
the throw happened (`a = acquire(); b = mayThrow(); c = acquire();` — a throw at
`b` reaches the handler with `c` uninitialised). So each acquisition opens a
region over the REST of its scope; because ownership only grows, those regions
nest perfectly and every throw point sees an exact release list. A region is
only opened when the rest of the scope can actually throw, so non-throwing code
gets plain frees and no `try`.

The idiomatic hand-written QuickJS alternative — one handler per scope plus a
`JS_UNDEFINED` sentinel in every slot — is **deliberately not taken**: it
depends on the artifact's value encoding, which #4541 extracts at build time and
which this pass must not assume. It is a legitimate size optimisation later, not
a correctness prerequisite.

### Findings that changed the design

- **`qjs_dup` returns a NEW handle, not an in-place `+1`.** The shim boxes the
  duplicated `JSValue` into a fresh cell (`box(JS_DupValue(...))`) and
  `qjs_free_value` frees the reference AND the cell — so under this ABI a handle
  is a **linear resource**, count 0 or 1, never 2. The first cut modelled `dup`
  as an in-place increment on the same name (correct for the RAW C API, where
  `JS_DupValue` returns the same `JSValue`) and would have leaked one cell per
  dup. `dup` now names a fresh destination, which is correct for BOTH ABIs:
  against a raw-API build, bind source and destination to the same Wasm local
  and the two releases become the two decrements that API wants.
- **Nothing in the pinned ABI unwinds.** A QuickJS error comes back as a
  `JS_EXCEPTION` sentinel HANDLE, not a trap, so every shim row is
  `throws: false`. Exceptional-path coverage still happens and still happens
  where it should: the unwind edge is the `throw` OUR codegen emits after
  `qjs_is_exception`, and the sentinel handle is released by the surrounding
  cleanup region like any other acquisition.
- **`qjs_call` takes `const qjs_handle *argv`** — handles reached through
  memory, invisible to the pass. Safe only because the shim borrows and the
  caller's scope keeps them alive. A future wrapper that CONSUMED a handle
  reached through memory could not be expressed by this annotation and would
  make the pass wrong; recorded in `pinned-shim.ts` so it cannot be added
  quietly.

### Underspecified in the issue; decided here

- **The annotation needed four axes, not one.** `ownership: "borrows" |
  "consumes"` answers only the argument question. A destructor pass also needs
  RESULT ownership (owned vs borrowed — the argument axis cannot express it, and
  guessing leaks one way and underflows the other), THROWS (whether a cleanup
  region is needed at all), and RELEASES-CONTAINER-SLOTS (the second consumer
  the Elision section names — its rule is unimplementable without it). The field
  now accepts a record; the shorthand still works and is REFUSED on a
  handle-returning import rather than silently picking a result ownership. Only
  the two safety axes may be derived, and only toward the conservative value.
- **"Every declared engine import" needed a definition.** `{ address: "handle" }`
  carries two meanings that coincide on wasm32 and are not the same idea:
  #4554's "a pointer-width scalar whose ROLE is a handle" (used in
  `tests/issue-4539-c-link.test.ts` on a plain `int c_double(int)`) and #4542's
  "a reference the engine counts". Inferring engine-ness from the type role
  would break the first. So it is declared: `ExternCImportSpec.engine: true`
  makes `declareExternCImports` refuse a missing or incoherent annotation at
  declaration time; the pass refuses again at the point of use.
- **Returning an owned handle from a frame whose result ownership is not
  `owned`** is now a pass diagnostic. The issue did not name it; without the
  check the frame release hands the caller a freed handle.

### What is validated, and what is NOT

Validated here, engine-free (`tests/issue-4542-refcount-handle-scope.test.ts`,
41 tests; `tests/issue-4542-pinned-shim-ownership.test.ts`, 12 tests):

- a release lands on every exit edge — fall-through, `return`, `break`,
  `continue`, explicit `throw`, and the unwind path through nested regions;
- every path releases exactly once, checked by an INDEPENDENT balance verifier
  that shares no bookkeeping with the pass;
- a `consumes` import gets exactly one dup and no extra release; a `borrows`
  import gets no traffic of its own;
- no dup/free/`try` at all on typed-only paths;
- an unannotated engine import is a compile error at declaration AND at use;
- the negative half — the verifier is shown to CATCH a missing release, a double
  free, a release missing only on the exceptional path, a use-after-free, a
  loop that grows the held set, and a reference given away that we do not hold;
- the committed ABI table still matches `qjs_shim.c`, with negative controls
  proving the drift check is not vacuous.

**NOT validated — the artifact was unavailable in this container.** The heap
measurements and the differential run against Node live in
`tests/issue-4542-refcount-heap-stress.test.ts`, gated on
`.tmp/quickjs-artifact/libquickjs.wasm` (or `JS2WASM_QUICKJS_ARTIFACT_DIR`).
**That file has never been executed**; treat it as a specification of the
measurement. Its fixtures DO run through the pass and the verifier
unconditionally, so the program shapes are honest even where the engine is
missing.

The verifier does check one engine-free half of the flat-heap property: at a
loop's back edge the reference counts must equal those on entry
(`loop-drift`). A stationary loop cannot grow the heap through the handles this
pass manages — a necessary condition, not a substitute for the fixture, since it
says nothing about the engine's own accounting.

### Deliberately not done

- **Elision.** The recorded safety condition is mechanised as far as this slice
  should go: every redundant pair is emitted as an `ElisionCandidate` carrying
  `containerSlotReleasedInRegion`, derived from the annotation, so the follow-up
  starts from data rather than re-deriving the rule.
- **Wiring into `IrInstr`.** The handle IR is the contract with #4541; folding
  handle ops into `IrInstr` before that lowering exists would fix the wrong
  shape and force #4541 to redo it.
- **Moving instead of duplicating at `return`.** Safe in isolation (a terminator
  has no later throw point) and left out to keep one invariant rather than one
  invariant plus an exception. It is the cheapest elision win and is recorded as
  a candidate.
