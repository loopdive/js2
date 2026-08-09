---
id: 3030
title: "Stable serializable IR contract (interchange v1): versioned canonical JSON + schema, verified types, external-consumer ready"
status: ready
sprint: current
created: 2026-07-04
updated: 2026-07-04
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [3029, 1924, 1926, 2134, 2949, 2952, 1852, 2956]
origin: "2026-07-04 user directive: make the IR standalone-suitable for other engines (e.g. SpiderMonkey deriving types statically AOT from our IR)"
---

# #3030 — the IR as a product: a contract other engines can consume

**Normative target picture:**
[`docs/architecture/target-architecture.md`](../../docs/architecture/target-architecture.md)
(the interchange boundary between L3 and L4). Sibling umbrella: #3029.

## Problem

The typed IR (`src/ir/`) is an internal data structure: it lives only in
memory, its invariants live in code comments, `IrType`'s leaf still embeds
module-relative backend data (`{kind:"val", val:{kind:"ref", typeIdx}}` —
the #1926 residue), and the verifier does not re-derive per-instruction
result types (#1924), so `resultType` is a claim, not a guarantee.

The user's directive: the IR should be consumable by **other engines** —
the concrete example being SpiderMonkey (or any JS engine / analysis tool /
out-of-tree backend) reading our compiler's output to derive types
**statically, ahead of time**, instead of warming up inline caches at
runtime. Our IR already contains exactly what such a consumer wants: typed
block-argument SSA, symbolic names, explicit `box`/`unbox`/`tag.test` at
every static↔dynamic boundary with `JsTag` partitions (#2949), ordered
effects (#2134), alloc-site provenance. What's missing is a **stable,
serializable, documented, versioned contract** — the difference between a
data structure and a product.

This also gives #3029 its cheapest backend-extension path: an out-of-tree
backend (MLIR etc.) consumes the serialized IR without touching this repo.

## Decisions (ratified here, Fable 2026-07-04)

- **D1 — Format: canonical JSON.** One JSON document per module, top-level
  `irVersion`, deterministic serialization (stable key order; object-shape
  fields are already name-sorted). Rationale: debuggable, diffable,
  schema-checkable, universally parseable — the right v1 for a contract
  whose first consumers are analysis tools. A binary encoding is an
  explicit **v2 non-goal** (revisit only if size measured as a problem;
  JSON gzips well and modules are per-file).
- **D2 — Versioning:** `IR_FORMAT_VERSION = "1.0"` exported from the
  contract module. Additive changes (new node kinds, new optional fields)
  bump minor; breaking changes bump major. All enum tables (`JsTag`,
  `IrBinop`/`IrUnop`, effect kinds, type kinds) are **append-only,
  frozen-order** (the #1852 linear-tag-enum discipline). A CI schema
  snapshot fails any PR that changes the serialized shape without a
  version bump.
- **D3 — Guarantees (what a consumer may rely on):**
  1. Typed **block-argument SSA**; the entry block's args are the function
     params; single definition, use-after-def, one terminator per block.
  2. **Symbolic names only** — no funcIdx/globalIdx/typeIdx anywhere
     (verifier-enforced today; D5 closes the IrType leak).
  3. Per-instruction `resultType` that the verifier **re-derives** from
     operand types per the T1 rule tables (#1924) — types a consumer can
     trust, not author claims.
  4. **Explicit dynamic boundaries**: a value is static-typed or `dynamic`;
     every crossing is a serialized `box`/`unbox`/`tag.test` node carrying
     its `JsTag` partition (#2949 R1–R6). This is the AOT-type-derivation
     payload: an engine reads exactly where dynamism enters and what
     partition proofs guard each unbox.
  5. **Ordered effects** (#2134) and alloc-site provenance (ADR-0013).
  6. Source positions per instruction (file/line/col).
  7. **Honest coverage manifest**: the module header lists every function
     with `carrier: "ir" | "legacy"` — consumers know exactly which bodies
     the contract covers. The contract ships at today's partial coverage
     and grows with #2855/#2950/#2949; it does NOT wait for 100%.
- **D4 — Exclusions (never serialized):** layout handles, `BackendLegality`
  sets, the Wasm `Instr` union, resolver/lowering state, anything below the
  L4 legalization line. Consumers must not see a WasmGC struct index or a
  linear memory offset.
- **D5 — Type story:** the serializable `IrType` must not carry
  module-relative indices. `val` leaves are the closed scalar set (i32
  (+boolean/symbol brands), i64 (+bigint brand), f32, f64, v128, i8, i16,
  funcref, externref, eqref, anyref); `ref`/`ref_null` leaves serialize as
  **symbolic type names** (`IrTypeRef`), resolved to indices only at
  lowering. Brands serialize explicitly.

## Slices

Tier ruling: contract freeze = **Fable**; implementation behind the frozen
contract = **Opus**.

| Slice                                              | Tier      | Size | What                                                                                                                                                                                                                                                                                                                                                                                                         | Depends on                                                    |
| -------------------------------------------------- | --------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| **T1 — Contract freeze**                           | **Fable** | M    | Normative `docs/ir/ir-contract.md`: node-kind inventory with per-instruction operand/result **type rule tables** (written once, consumed twice: by the doc and by T4's verifier rules), effect kinds, name-namespace ownership (func/global/type — same namespaces as `ctx.funcMap`/`globalMap`/`typeNames`), D1–D5 as normative text, the coverage manifest shape, and the versioning policy. Freezes v1.0. | #2949 slice 1–2 landed (they are — dynamic is in the lattice) |
| **T2 — Purge module-relative indices from IrType** | Opus      | M    | Execute the #1926 residue per D5: `ref`/`ref_null` **inside IrType** become symbolic (`IrTypeRef` name), with the resolver mapping name→typeIdx at the lowering boundary. Mechanical but wide (every `asVal` consumer); byte-identity gate on the 39-hash corpus + full CI.                                                                                                                                  | T1                                                            |
| **T3 — Serializer + deserializer + CLI**           | Opus      | M    | `src/ir/serialize.ts`: `serializeIrModule` / `deserializeIrModule`; `--emit-ir <file>` CLI flag (and `emitIr` compile option) writing the module JSON incl. coverage manifest. Round-trip property test: build → serialize → deserialize → **verify** → re-serialize **byte-identical**, over the playground corpus + equivalence suite shapes.                                                              | T1, T2                                                        |
| **T4 — Verifier as conformance checker**           | Opus      | M    | Implement T1's per-instruction type rules in `verify.ts` (#1924 — operand types re-derived, `resultType` checked, branch args type-checked not just arity). Runs on deserialized modules too (same function), making the verifier the consumer-side conformance tool. Hard-fail lane stays on.                                                                                                               | T1                                                            |
| **T5 — Schema + CI gate**                          | Opus      | S    | `docs/ir/ir-module.schema.json` (JSON Schema, generated or hand-maintained + validated in tests); CI snapshot check: serialized-shape change without `IR_FORMAT_VERSION` bump fails `quality`.                                                                                                                                                                                                               | T3                                                            |
| **T6 — Example external consumer**                 | Opus      | S    | `scripts/ir-type-summary.mjs`: reads a serialized module (JSON only — must not import compiler internals; that's the point) and emits a per-function report: param/return types, dynamic-boundary sites with JsTag partitions, effect summary. This is the SpiderMonkey-style AOT probe and the documentation-by-example for the contract.                                                                   | T3, T5                                                        |

Sequencing: T1 → T2 → T3 → {T4, T5} → T6. T4 can start from T1's tables in
parallel with T2/T3.

## Acceptance criteria

- [ ] `docs/ir/ir-contract.md` merged (T1): every serialized node kind has
      operand/result type rules; D1–D5 normative; versioning policy stated.
- [ ] `IrType` contains no module-relative index (T2); grep-gate in CI.
- [ ] `compile(..., {emitIr})` / `--emit-ir` produce schema-valid JSON;
      round-trip is byte-identical and verifier-clean on the corpus (T3).
- [ ] Verifier re-derives per-instruction types (T4, closes #1924) and
      accepts every serialized corpus module.
- [ ] Schema snapshot gate live (T5); `IR_FORMAT_VERSION` exported.
- [ ] `ir-type-summary.mjs` produces a correct report for a dynamic-boundary
      example **without importing any compiler module** (T6).

## Risks

- **Freezing too much too early.** v1 freezes the _shape and guarantees_,
  not the node inventory — kinds are append-only, and the coverage manifest
  makes partial coverage honest instead of a compatibility lie.
- **T2's blast radius**: IrType is touched by from-ast/propagate/select/
  lower/verify/passes. Pure-mechanical rule: name in, index out at the
  resolver boundary only; byte-identity is the oracle.
- **`resultType` trust gap until T4**: the contract doc must mark guarantee
  D3.3 as "effective from verifier ≥ T4" so no consumer builds on unverified
  types in the interim.
- **Drift between doc and code**: T5's schema snapshot + T4's shared rule
  tables are the anti-drift mechanisms; the doc alone would rot.

## Residual format/versioning decision memo (opus-owned — options only, 2026-07-12 fable-arch)

**D1 (canonical JSON) and D2 (versioning policy) are FROZEN on main** (T1
landed 2026-07-04; `IR_FORMAT_VERSION = "1.0"`). They are not re-litigated
by any dev or architect — reopening either is a **major-version** decision.
What remains genuinely open, for opus to ratify when the trigger arrives
(none blocks T2–T6):

1. **Binary encoding (the v2 non-goal's trigger).** Options: (a) stay
   JSON-only until a consumer measures size/parse cost as a real problem
   (status quo — zero work, gzip covers most of it); (b) pre-commit to a
   trigger criterion now (e.g. "serialized module > N MB or parse > N ms in
   a named consumer") so v2 isn't relitigated ad hoc; (c) CBOR/msgpack
   sidecar as a cheap middle path (same schema, mechanical transcode).
   Tradeoff axis: spec surface + second codepath vs. consumer performance
   that is currently hypothetical.
2. **Effects serialization.** v1.0 ships effects as a DERIVED per-kind
   published table (ratified at T1), not per-instruction fields. Options:
   (a) keep derived (smaller documents, no drift risk between field and
   table); (b) additive minor serializing per-instruction effect lists once
   a consumer needs instruction-granular effect overrides (e.g. a pure-call
   annotation the kind table can't express). Decide only when such a
   consumer exists.
3. **Schema depth (T5's open latitude).** T1's schema pins the 59-kind
   table + discriminating payloads for the key kinds. Options: (a) deepen
   to full per-kind payload conditionals (strongest gate, most maintenance;
   hand-maintained drift risk unless generated); (b) generate the schema
   from the node-kind tables (one source of truth — preferred direction if
   T5 finds the generator cheap); (c) keep the current depth and lean on
   the verifier as the semantic gate (contract §Conformance already says
   this). This is a T5 implementation choice, not a contract change.
4. **Version negotiation / min-reader policy.** The contract states writer
   versioning but not reader obligations. Options: (a) readers MUST reject
   a higher major and MAY accept any equal-major/higher-minor (additive
   guarantee makes this safe) — the conventional choice; (b) readers pin
   exact versions (safest, most brittle). Needs ratifying text in
   `docs/ir/ir-contract.md` §Versioning before the FIRST external consumer
   ships (T6 is the natural deadline).

## Progress log

### T1 landed — v1.0 frozen (fable-arch-slices, 2026-07-04)

Artifacts (all normative):

- `docs/ir/ir-contract.md` — D1–D5 as normative text; the seven D3
  guarantees (D3.3 explicitly marked "effective from verifier ≥ T4"); name
  namespaces; document layout; the full node inventory with per-kind
  operand/result type rules + effect classification (the tables T4
  implements); frozen enum tables; versioning policy; per-slice status.
- `docs/ir/ir-module.schema.json` — JSON Schema 2020-12. Precise shapes for
  module/coverage/function/block/IrType/Const/terminators; instructions
  pinned to the frozen 59-kind table + base shape, with conditionals for the
  key discriminating payloads (const/call/global.\*/box/unbox/tag.test/
  closure.new). The verifier is the semantic conformance gate (contract
  §Conformance); T5 may deepen the schema.
- `src/ir/contract.ts` — `IR_FORMAT_VERSION = "1.0"` (D2) + the
  coverage-manifest / document-header types (D3.7). Nothing imports it yet;
  T3 implements against it.
- `tests/backend-contract.test.ts` — smoke: version constant, schema
  parses, frozen tables (no `raw.wasm`, no indexed `ref` in the scalar set).

Additional ratifications made at freeze time (T1 decisions the D-text
implied but didn't pin):

- **The `raw.wasm` serializability predicate (D4):** a function whose body
  contains `raw.wasm` is manifest-listed `carrier: "legacy"`,
  `reason: "raw-wasm-bridge"`, body not serialized — because `raw.wasm`
  embeds backend `Instr` ops that D4 forbids.
- **Pre-T2 honesty rule (D5):** until T2 lands, functions whose types carry
  a module-relative `ref`/`ref_null` leaf are `carrier: "legacy"`
  (`reason: "module-relative-type"`) instead of leaking a typeIdx.
- **D1 details:** `i64` consts as decimal strings; f64 NaN/±Infinity/−0 as
  strings; `ref_extern` added to the D5 closed scalar set (exists in
  `ValType`, non-indexed, was missing from the issue's list).
- **Slot-type rule (D4):** serialized `IrSlotDef.type` restricted to the
  scalar set.
- **Effects (D3.5):** derived, not serialized in v1.0 — the per-kind table
  is published contract; serializing them is a possible additive minor.

Open: T2–T6 (Opus lanes). Issue stays in-progress; claim released on merge.
