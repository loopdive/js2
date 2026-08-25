---
id: 4541
title: "JSValue as the linear lane's boxed tier: representation, build-time tag fast paths, string story, cross-heap cycle policy"
status: ready
sprint: Backlog
created: 2026-08-17
updated: 2026-08-17
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
depends_on: [4540]
related: [1852, 4236, 4245]
# id 4541 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-17 (gh CLI offline in this container; pr_scan=degraded). Equivalent
# open-PR scan via the GitHub MCP at reservation time: the sole open PR was
# 4638 (hooks-only; adds no issue file), so the id space was clear.
---

# #4541 — `JSValue` as the linear lane's boxed tier

Slice 3 of #4538. Lands the core of
[ADR-0020](../../docs/adr/0020-linear-dynamic-tier-quickjs-jsvalue.md).

## This lands behind the `BackendEmitter` trait — not in direct `codegen-linear`

**Load-bearing constraint, not a style preference.** The boxed tier is a
backend lowering of an IR-level concept, so it belongs behind the emitter seam:
**#1713 — "IR backend-trait: audit WasmGC bias in lower.ts + define
BackendEmitter seam"** and **#1714 — "Lower one IR node kind through the
BackendEmitter trait to BOTH WasmGC and linear"** are both `done`, and
**#1852 — "Make dynamic-value representation explicitly per-backend…"** already
specifies this work as its slice G4 (`emitBox` / `emitUnbox` / `emitTagLoad` /
`emitTagTest` implemented in `LinearEmitter`).

Writing it as a direct AST→Wasm path in `src/codegen-linear/` because it is
urgent would grow exactly the legacy front-end the IR migration is retiring —
the "wrong answer" `docs/architecture/codegen-axes.md` names explicitly. ADR-0020
supersedes #1852's *representation* for this target; it does **not** supersede
#1852's *mechanism*, and the two must not be conflated.

## Scope

Give the linear lane a dynamic value representation, which it currently lacks
entirely (`layout.ts` is a static fat-slot model over planned records).

**Terminology (ADR-0020 Decision 1, corrected in place 2026-08-19).**
Throughout this issue, "dynamic residue" / "dynamic position" means
**eval-reachable**: reachable by code not known at compile time (`eval`, `with`,
`new Function`), per the #4543 rule. It does **not** mean merely
statically-untyped. A program with no `eval` links no engine however dynamically
typed it is — that is what makes ADR-0020's pay-for-what-you-use requirement
achievable. Read every "dynamic" below with that meaning.

**Open question this slice must settle, not inherit.** ADR-0020 supersedes
#1852's native value+tag scheme (16-byte `[tag][val]` cell) for this target.
Under the eval-reachable rule, untainted-but-dynamic values still need a native
representation and that scheme was retired. Decide explicitly: does it return
for the untainted case, or is the claim that without `eval` little genuinely
dynamic remains? Building to the old wording silently answers this the
expensive way.

1. **Representation.** An eval-reachable value is an opaque `JSValue` handle
   (an `i32` from codegen's perspective). All manipulation goes through the
   engine's C API. Internal layouts — NaN-box configuration, shapes, atoms —
   are never open-coded; they are not a stable ABI and vary by build flags.
2. **Immediate fast paths via build-time tag extraction.** The pinned
   artifact's shim already exports its tag constants and float64 encoding
   (`scripts/quickjs-artifact/extract-abi.mjs`). Number box/unbox lowers to
   inline sequences *learned from the pinned build*, never hardcoded. Anything
   refcounted stays API-mediated.
3. **Typed code is untouched.** Unboxed `i32`/`f64` and planned record layouts
   stay exactly as they are. Boxing happens at the assignment into a dynamic
   position, and a typed region unboxes **once** at its entry — at compile
   time, not per operation.

## Two open questions this slice must decide (not defer)

- **Strings.** Adopt `JSString` in the boxed tier, or convert at the boundary?
  Strings are immutable, so copying is semantics-preserving — which makes this
  a measurement, not a semantics argument. Decide it with an A/B on a
  string-heavy fixture and record the number.
- **Cross-heap cycles.** The engine's cycle collector cannot see edges that
  close through native memory. #4236's design review found this *mostly*
  solvable for this lane; this slice must state the residual leak class
  precisely, implement the weak-wrapper mitigation, and record what remains
  accepted rather than leaving it as a footnote.

## A context is already a region — bound the leak class with scope, not analysis

The engine gives us grouped deallocation natively: **a `JSContext` /
`JSRuntime` is a region**, and `JS_FreeRuntime` releases everything in it at
once. For a *scoped* use — evaluate a snippet, extract a value, discard — a
per-eval context makes the whole group's teardown O(1) and requires **no
lifetime analysis at all**, only that the result is copied or upgraded out
first.

That matters directly for the leak class above: **a cross-heap cycle that
cannot be collected is still reclaimed when its context is torn down.** So the
residual leak this slice must document is bounded by context lifetime, not by
process lifetime — state it that way, because "leaks forever" and "leaks until
this eval scope ends" are different severities and only the second is
acceptable.

Two limits decide how far the idea scales down, and both should be recorded so
a later reader does not try to push it further:

- **The allocator hook cannot segregate by purpose.** `JSMallocFunctions`
  (see #4540) sees one undifferentiated stream: transient object allocations
  interleaved with interned atoms, shapes and bytecode that have *runtime*
  lifetime. So a region rewind cannot be nested *inside* a live runtime — it
  would take the atom table with it. Grouping is available at context/runtime
  granularity, not below.
- **Rewinding under live engine references is a use-after-free inside the
  engine** — worse than one in our own code, because it corrupts a component we
  do not debug. A rewind point must be provable; at context granularity the
  proof is trivial (tear down, having extracted the result), which is exactly
  why that is the granularity to use.

Long-lived shared state within one runtime stays refcounted. This is a
complement to the mechanism, not a replacement for it.

## Amendments this slice must record

- **#1852 §1** fixes the linear lane's dynamic residue as a parallel
  value+tag scheme (16-byte `[tag][val]` cell, parallel `$v`/`$t` locals). For
  this target, ADR-0020 supersedes it. Update that normative table in the same
  PR — two contradictory normative representations in the repo is exactly how a
  later reader implements the wrong one.
- **#4245** (cross-heap eval membrane) exists because eval'd code and compiled
  code live in different heaps. Once compiled dynamic values *are* engine
  values, same-heap access needs no membrane. State explicitly which part of
  #4245 this subsumes **for the linear lane**, so the two are not built twice.
  The WasmGC lane's membrane need is unaffected.

## The extracted ABI is a version lock — stamp it, or it miscompiles silently

Inline fast paths make the emitted binary **coupled to one engine build**.
`scripts/quickjs-artifact/extract-abi.mjs` reads the encoding out of the
artifact you linked (`qjs_abi_tag_*`, `tagOffset`, `payloadOffset`,
`float64TagAddend`, `nanBoxing`, `jsValueSize`), which is what keeps the
constants honest — but nothing yet enforces that the artifact you *link* is the
artifact you *extracted from*. Link a different build and every inline tag test
and number unbox is quietly wrong: no crash, no diagnostic, just wrong values.
That is the worst failure shape available here, and it is the exact hazard the
extraction design exists to prevent — left unenforced, extraction only moves the
hardcoding one step away.

The mechanism already exists: the shim exports `qjs_abi_version`. What is
missing is the policy. This slice owns closing that, and it is why #4236's
still-unowned "version pin + upgrade policy" box lands here.

## Acceptance criteria

- [ ] A program with a genuine **eval-reachable** residue (values reachable
      from `eval` / `with` / `new Function`) compiles and runs under
      `--target linear`, linked.
- [ ] A program that is heterogeneously typed but contains **no** `eval`,
      `with` or `new Function` links **no engine at all** — asserted on the
      emitted module's imports, not by inspection. This is the criterion that
      makes the eval-reachable rule real rather than stated.
- [ ] The ABI stamp the module was compiled against is **embedded in the
      module** and **checked against the linked artifact** at link or
      instantiate time. A mismatch fails loudly, naming both versions; it must
      never degrade to a warning or a silent continue.
- [ ] A negative test links a module against an artifact reporting a different
      `qjs_abi_version` and asserts the failure fires — proving the check can
      see the bug class it exists to catch.
- [ ] Typed numeric kernels emit an **unchanged** instruction count — the
      typed-mainline-unboxed invariant from #1852 §3, asserted on this PR.
- [ ] Number box/unbox uses extracted tag constants; a test fails if the
      constants are hardcoded rather than read from the pinned build.
- [ ] The string decision is recorded **with the measurement that decided it**.
- [ ] Box / unbox / tag-test are emitted through `BackendEmitter` primitives
      implemented in `LinearEmitter` — **not** via a direct `codegen-linear`
      path. A `pushRaw`-style inline emission of these ops fails review.
- [ ] The residual cycle-leak class is documented and covered by a test that
      demonstrates the mitigation working on the solvable cases.
- [ ] The documented leak class states its **bound** — reclaimed at context
      teardown, not process exit — and a test tears down a context holding an
      uncollectable cross-heap cycle and asserts the memory is returned.

## Validation

- Differential execution against Node for a dynamic-residue fixture set.
- Instruction-count snapshot on two `playground/examples/` numeric files.
- `pnpm run check:linear-ir`; emit-identity proof for typed-only programs.

## Non-goals

- **Which objects become engine objects** — that frontier analysis is #4543.
  This slice provides the representation; #4543 decides who gets it.
- Refcount-discipline emission (#4542), though this slice must not make that
  harder: every API call introduced here is a site #4542 will have to cover.
