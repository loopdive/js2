# Target architecture: the layered compiler & the backend contract

> The **end-state module architecture** this compiler is migrating toward,
> ratified 2026-07-04 (architect, Fable). Umbrella issues: **#3029** (clean
> architecture / backend extensibility) and **#3030** (stable serializable IR
> contract for external consumers). Companion to
> [`codegen-axes.md`](codegen-axes.md) (the two-axes doctrine — still
> authoritative for "which axis is my change on"),
> [`compiler-quality-review-2026-06.md`](compiler-quality-review-2026-06.md)
> (the evidence), and
> [`hybrid-soundness-ir-roadmap.md`](hybrid-soundness-ir-roadmap.md) (the
> soundness invariant). This doc does not replace them; it gives the _target
> picture_ they all point at, plus the rules that make the tree reviewable
> and the contract a new backend implements.

## Non-negotiables carried forward

1. **Two orthogonal axes** (codegen-axes.md): WasmGC vs linear is a backend
   _choice_ — both stay; direct-AST vs IR front-end is a _migration_ — the
   direct front-ends are deprecation-tracked remainders (#2855/#2950).
2. **Hybrid invariant** (hybrid-soundness-ir-roadmap.md): SAFE lowering by
   default; FAST lowering only behind a discharged proof.
3. **Dual mode**: no new host import without a standalone fallback.
4. **Fail-loud**: no silent fallthrough, no lossy fixup (#1858 family).

## The layer stack (dependency direction is strictly downward)

```
 L1  frontend      parse (TS reuse) · check · ES early errors · single
                   pipeline driver (#1927) · TypeOracle facade (#1930)
 L2  ir-build      from-ast · propagate (type lattice) · select (capability
                   predicate, #2135)
 L3  ir-mid        backend-NEUTRAL typed SSA (block args, symbolic refs,
                   explicit effects #2134, explicit dynamic boundaries #2949)
                   + passes + verifier between every pass
 ════════════════  IR INTERCHANGE BOUNDARY — serializable, versioned (#3030)
 L4  legalize      per-backend: legality declaration + declared type-
                   converter + BackendEmitter intents (#1851/#1852/#2953)
 L5  backend       gc/ · linear/ · bytecode/ · (mlir/…): layouts, module
                   assembly, backend-specific runtime glue
 L6  emit + link   Wasm binary encoding · object files · linker
 L7  runtime/host  runtime.ts host imports (allowlisted) · WASI shims
```

Rules the stack implies:

- A layer may import **only from layers below it** (and its own layer).
  `src/ir/nodes.ts` is a pure leaf. Nothing in `src/ir/` may import from
  `src/codegen/` (today `integration.ts` imports 8 codegen modules — that
  inversion is the #3029-S3/S4 extraction). Nothing above L4 may name a
  Wasm op, a `typeIdx`, or a `funcIdx`.
- Everything **above** the interchange boundary is backend-agnostic and
  serializable; everything **below** it is per-backend and never serializes
  (layout handles, legality sets, the `Instr` union, lowering state).
- The verifier is the boundary's conformance checker: what it enforces is
  exactly what an external consumer may rely on (#1924 closes the
  instruction-level type-rule gap).

## The backend contract (what a NEW backend implements)

> **Frozen as code (#3029-S1/S4, 2026-07-04):**
> [`src/ir/backend/contract.ts`](../../src/ir/backend/contract.ts) declares
> the five interfaces (ModuleAssembler invariants A1–A7 inline);
> [`src/ir/backend/README.md`](../../src/ir/backend/README.md) is the
> ownership/rules README; `src/ir/backend/contract-conformance.ts` is the
> tsc-enforced conformance skeleton.

A backend — WasmGC, linear, bytecode, or a future MLIR/Cranelift lowering —
is **five declared parts**, all consulted through interfaces, none through
imports of another backend's internals:

| #   | Interface                  | Contract                                                                                                                                                                           | Today                                                                                         | Gap                                                                                               |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | **TypeConverter**          | `convertType(t: IrType): readonly Slot[]` — IR type → backend value slots (1 slot on GC; the linear dynamic residue is a value+tag pair, #1852 §1)                                 | `lowerIrTypeToValType` free function, GC-shaped                                               | promote onto the trait (#1851 L3)                                                                 |
| 2   | **BackendLegality**        | `legalOps` / `loweredOps` sets per IrInstr kind; "lowering finished" = _only legal ops remain_, verifier-checked                                                                   | `src/ir/backend/legality.ts` exists                                                           | wire as the post-lower predicate (#1851 L4/L5)                                                    |
| 3   | **BackendEmitter\<Sink\>** | instruction-level _intents_ (`emitVecGet`, `emitBox`, `emitClosureNew`, …); caller owns operand order; emitter pushes terminal ops onto an opaque `Sink`                           | `src/ir/backend/emitter.ts`, sink hardwired to `Instr[]`; 74 `pushRaw` bypasses in `lower.ts` | generalize `Sink` (bytecode already strains it; MLIR needs a builder sink); close pushRaw (#2953) |
| 4   | **LayoutResolver**         | layout-handle factory (vec/object/closure/refcell/union/dynamic) + string/boxing helpers; memoization lives here                                                                   | `IrLowerResolver` built in `integration.ts`, hardwired to the WasmGC `CodegenContext`         | extract the context-facing surface into a backend-neutral interface (#2956 item 1, #3029-S3)      |
| 5   | **ModuleAssembler**        | module-level ownership: function slots, import/export registration, type registration, globals, data, start — with **name-based identity** (no absolute-index baking, #1916/#2710) | implicit in WasmGC `ctx.mod` mutation and `generateLinearModule`                              | declare it (#3029-S4/S5); this is where the late-import index-shift regime (#2043) goes to die    |

**Two ways to add a backend:**

- **In-tree**: implement the five interfaces. An MLIR backend's `Sink` is an
  MLIR builder; its ModuleAssembler produces an `mlir::ModuleOp`; legality
  declares which IrInstr kinds map to dialect ops vs need legalization
  rewrites. The IR's block-argument SSA maps 1:1 onto MLIR regions/block
  arguments — no Φ translation needed (this is why block args were chosen;
  see compiler-design-lessons.md §2).
- **Out-of-tree**: consume the **serialized IR** (#3030) — no TypeScript
  required, no in-repo code. This is the recommended path for MLIR-class
  experiments and for engines (e.g. SpiderMonkey) deriving types
  ahead-of-time from our verified type annotations.

## Target directory layout (migration map)

Neutral naming resolves the #1860 asymmetry ("codegen/" reads as the unmarked
default); the moves are mechanical `git mv` waves once the interfaces exist.

| Today                                                                                                                   | Target                                                                                                                          | Vehicle           |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `src/checker/`, `src/compiler/`, `src/compiler.ts`, `src/ts-api.ts`, `src/shape-inference.ts`, `src/import-resolver.ts` | `src/frontend/` (one pipeline driver, #1927; TypeOracle, #1930)                                                                 | #3029-S6          |
| `src/ir/`                                                                                                               | `src/ir/` (unchanged home; `nodes.ts`/`verify.ts`/`effects.ts` become the #3030 contract surface)                               | #3030             |
| `src/ir/backend/`                                                                                                       | `src/backend/contract/` (the five interfaces + conformance tests)                                                               | #3029-S1/S6       |
| `src/codegen/`                                                                                                          | WasmGC lowering knowledge → `src/backend/gc/`; its _front-end_ role is deleted per-kind (ratchet #2855, flip #2950) — not moved | #2855/#2950/#2953 |
| `src/codegen-linear/`                                                                                                   | `src/backend/linear/`, consuming IR via the contract                                                                            | #2956             |
| `src/ir/backend/bytecode-*.ts`                                                                                          | `src/backend/bytecode/`                                                                                                         | #3029-S6          |
| `src/emit/`, `src/link/`                                                                                                | unchanged (already clean layers)                                                                                                | —                 |
| `src/runtime*.ts`                                                                                                       | `src/runtime/` (decomposed per #1934; versioned ABI #1932)                                                                      | existing issues   |

**What is NOT proposed:** no rewrite, no big-bang rename before the
interfaces exist, no third front-end, no in-repo MLIR backend commitment
(feasibility memo first, #3029-S9).

### Module boundaries for incremental IR work (2026-10-07)

Generic IR contracts, JavaScript semantics, analyses and verification belong in
cohesive generic modules. Backend-specific representation, physical indices,
layout and provider wiring belong behind the declared target boundary. WasmGC
and linear memory consume shared semantics through explicit contracts. C and
LLVM are examples of future consumers, not supported targets or authorization
to add speculative interfaces.

Keep one authoritative implementation of each shared algorithm. Separate
inlining, dead-code elimination and other passes into focused modules with
explicit inputs, outputs, effects, prerequisites, invalidation and verification.
Target legalization stays with the target. Use cohesive subfolders rather than
expanding central switches or duplicating helpers. Callback/plugin escape
hatches and TypeScript frontend imports in detached replay do not establish a
valid dependency boundary.

Extract incrementally under issue-owned file and function scopes. Declare
readers, writers, owners and dependency direction before moving code; preserve
observable behavior, currentness checks and error types. These review questions
supplement the migration map; they do not claim new CI enforcement:

- Is the responsibility generic semantics/analysis or target representation?
- Which existing module is authoritative, and does this create duplication?
- Do imports preserve dependency direction, cycle limits and source-free replay?
- Are pass effects, invalidation and owner transitions explicit and verified?
- Do malformed inputs fail closed without refreshing authority from mutations?
- Do native and artifact controls cover both backends at the same frozen epoch?
- Are performance claims supported by measurements retaining failures?

Legacy remains until full tested equality. Architectural tidiness alone is not
parity evidence or a reason to retire routes, rename whole trees, or change proof
schemas. See the dated [Session A handoff](../../plan/log/ir-coordination-session-a.md)
for current local ownership and measured limitations.

## "Reviewable", concretely (rules + enforcement)

Every rule has a CI mechanism, following the project's ratchet pattern —
rules without enforcement decay.

| Rule           | Statement                                                                                                                                              | Enforcement                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| **R-SIZE**     | New files ≤ 1,500 lines; existing over-limit files are a frozen baseline that may only shrink                                                          | `scripts/file-size-baseline.json` ratchet (like `ir-fallback-baseline.json`), in `quality` |
| **R-DEP**      | Layer imports point downward only; `ir/nodes.ts` stays a value-import-free leaf; `src/ir/` never imports `src/codegen/` (after #3029-S3)               | import-graph check script in `quality` (like `check:issue-ids`)                            |
| **R-DISPATCH** | No new dispatch chain > 20 arms; use table-driven registries (the #742 pattern: `Map<key, handler>` where a handler returns `undefined` = not-my-case) | lint heuristic + review checklist                                                          |
| **R-ESCAPE**   | Every trait bypass carries `// pushraw-ok(#issue)`; count is ratcheted                                                                                 | #2953's count check                                                                        |
| **R-OWN**      | Every `src/` subdir has a README stating its responsibility + what it may/may not depend on                                                            | #1859; R-DEP script reads the README's declared deps                                       |
| **R-LOUD**     | Every dispatcher/encoder has a throwing/`never` default arm                                                                                            | #1858 family (#1937/#1939 done-or-tracked)                                                 |

The size threshold is deliberately generous (the field's "understood in
isolation" bar is 1–2k); the point is the _ratchet_, not the number.

## The IR interchange contract (summary — #3030 is normative)

> **Frozen (#3030-T1, 2026-07-04):** [`docs/ir/ir-contract.md`](../ir/ir-contract.md)
> (normative D1–D5 + node inventory + type rules) +
> [`docs/ir/ir-module.schema.json`](../ir/ir-module.schema.json) +
> `IR_FORMAT_VERSION` in `src/ir/contract.ts`.

What an external consumer (other engine, out-of-tree backend, analysis tool)
may rely on, once #3030 lands:

- **Format**: canonical JSON, one document per module, `irVersion` field,
  deterministic serialization; published JSON Schema. Binary encoding is an
  explicit v2 non-goal.
- **Guarantees**: typed block-argument SSA; **symbolic names only** (no
  func/global/type indices); per-instruction `resultType` that the verifier
  _re-derives_ (not trusts — #1924); explicit `box`/`unbox`/`tag.test` at
  every static↔dynamic boundary with `JsTag` partitions (#2949); ordered
  effect annotations (#2134); alloc-site provenance; source positions.
- **Honest coverage**: a module-level manifest of which functions are
  IR-carried vs legacy-compiled, so consumers know exactly what they can
  analyze. Coverage grows with #2855/#2950/#2949 — the contract does not
  wait for 100%.
- **Exclusions**: layout handles, legality sets, the Wasm `Instr` union,
  anything below L4.

## Sequencing (see the issues for slice detail)

```
#3029-S1 backend contract v1 (Fable)     #3030-T1 IR contract freeze (Fable)
        │                                        │
   S2/S3 pushRaw + LayoutResolver (Opus)    T2 purge typeIdx from IrType (Opus)
        │                                        │
   S4 ModuleAssembler design (Fable)        T3 serializer + round-trip (Opus)
        │                                        │
   S5 assembler impls (Opus)                T4 verifier type rules #1924 (Opus)
        │                                        │
   S6 directory re-layout (Opus) ←──────── T5 schema gate (Opus)
   S7 CI ratchets (Opus, early, parallel)   T6 example consumer (Opus)
```

The two Fable slices per track are the **cut-lines** (interface freezes);
everything else is mechanical movement behind frozen interfaces and is
Opus-executable with byte-identity / equivalence gates.

## See also

- #3029 / #3030 — the umbrella issues (slice detail, acceptance criteria).
- [`codegen-axes.md`](codegen-axes.md) — which axis is my change on.
- [`compiler-quality-review-2026-06.md`](compiler-quality-review-2026-06.md)
  — the June 2026 evidence base (#1916–#1950).
- [`compiler-design-lessons.md`](compiler-design-lessons.md) — the field's
  patterns (R1 verifier discipline, R4 legalization, R5 value rep).
- #1851/#1852 (ratified legalization + value-rep specs), #2953 (pushRaw),
  #2956 (linear-consumes-IR), #2949 (IrType.dynamic), #2950 (IR-first flip),
  #2855 (fallback ratchet), #742 (calls decomposition), #1916 (symbolic
  function refs), #1930 (TypeOracle), #1927 (one pipeline driver).
