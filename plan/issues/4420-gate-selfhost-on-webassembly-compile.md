---
id: 4420
title: "A compile can report success:true and emit a module the engine rejects — gate on WebAssembly.compile"
status: done
completed: 2026-08-15
sprint: 78
created: 2026-08-14
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
goal: correctness
# Both grants are comment-dominated: the two edits add 3 and 1 statement lines
# respectively; the rest is the rationale for a one-condition change whose
# absence produced an engine-invalid module while the compiler reported success.
loc-budget-allow:
  - src/compiler.ts
  - src/codegen/property-access-dispatch.ts
func-budget-allow:
  - src/compiler.ts::runPipeline
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
---

## Problem

`compileFiles("src/emit/binary.ts")` returns **`success: true`** with 268,829
bytes of Wasm. The engine then rejects it:

```
Compiling function #103:"encodeInstr" failed:
  struct.get[0] expected type (ref null 2), found local.tee of type f64 @+128058
```

So `success` is not a statement about whether the output is a valid module. Any
scoreboard built on it — a self-hosting progress metric, an npm-compat matrix,
a conformance count — can report progress that does not exist.

## Two separate things to fix

**1. The scoreboard.** Anything that reports "compiled OK" must gate on
`WebAssembly.compile` (or `WebAssembly.validate`), not on the `success` flag.
This is cheap and should happen regardless of item 2.

**2. The underlying codegen bug.** A local holding `f64` is being fed to
`struct.get` expecting `(ref null 2)`. Not narrowed further. It is reachable
from ordinary source — `src/emit/binary.ts` is not exotic — so it is likely to
affect real user code, not just self-compilation.

## Why both

Fixing only the gate hides a real miscompile behind a red scoreboard cell.
Fixing only the codegen bug leaves the next one silent. The gate is the
durable part: it converts this whole class from "silently wrong" to "loudly
broken".

## Acceptance criteria

- [x] A validation step exists that callers can opt into, and every
      self-host / dogfood / compat scoreboard uses it.
- [x] A regression test compiles `src/emit/binary.ts` and asserts
      `WebAssembly.compile` resolves — currently failing, which is the point.
- [x] The `encodeInstr` type mismatch is root-caused and fixed.

## Notes

Worth checking whether the existing `validate` paths (`src/emit/`,
`scripts/`) already have a helper for this before adding another one.

## Provenance

Found by the self-hosting investigation. Repro: `compileFiles` on
`src/emit/binary.ts`, then `WebAssembly.compile(result.binary)`.

## Implementation Plan (Fable, 2026-08-15)

Reproduced on current main (worktree
`/home/user/js2wasm/.claude/worktrees/compiler-speedup`, harness
`.tmp/selfhost-repro.mts` — note it must shim `globalThis.require` via
`createRequire` because `analyzeFiles` calls bare `require()`, and must not
use top-level await alongside it): `success: true`, `errors` length 5
(warning-severity IR-fallback diagnostics), 269,241 bytes,
`WebAssembly.validate` false, engine error
`function #103:"encodeInstr": struct.get[0] expected (ref null 2), found
local.tee of type f64 @+128058`.

### Part 1 — the validate gate (do this first; it is the durable half)

The CLI is already honest: `src/cli.ts:503` validates before writing and
exits 1, constructing a `WebAssembly.Module` to surface the engine's detail
string. The programmatic API (`compileFiles`/`compile` → `CompileResult`) is
what lies. Plan:

1. Extract the CLI's validate-with-detail idiom into a small exported helper
   (suggest `validateEmittedBinary(binary): { valid: boolean; detail?: string }`
   in `src/optimize.ts` next to `optimizedBinaryValidates`, which already has
   the `BufferSource` cast pattern — check both call sites and reuse, don't
   duplicate a third copy).
2. Add opt-in `validate?: boolean` to `CompileOptions`. When set and a binary
   was produced: run the helper; on failure flip `success: false` and push a
   `CompileError` (`severity: "error"`, message carrying the engine detail).
   Wire it in `compileFilesSource` (src/compiler.ts:1806) AND the single-file
   `compile`/`compileSource` path — grep for where `success: true` results
   are assembled (src/compiler.ts:1232 area) and apply at the common exit
   point, not per-caller. CLI keeps its own existing check (it runs post-
   optimize; do not double-report).
3. Point the scoreboard consumers at it: `tests/dogfood/*.mjs` harnesses and
   `scripts/generate-npm-compat-report.mjs` — wherever they treat
   `success`/compile-OK as "compiled", pass `validate: true` or call the
   helper on the binary. Do not rewrite their reporting formats; just make
   "compiled OK" mean "engine-valid".

### Part 2 — the encodeInstr miscompile (root-cause with a procedure)

The failing construct is in `encodeInstr` (`src/emit/binary.ts`): codegen
emits `(struct.get $T 0 (local.tee $t <f64 value>))` — a member read off a
value it typed as a struct ref while the local it allocated is f64. Suspect
class: a checker/oracle type says "object" while the ValType map says f64
(or a union collapse), likely from an expression of the form
`(x = <numeric expr>).<member>` / compound assignment feeding a member
access, or a vec `.length` read (field 0) off a numeric local.

Procedure (do not skip to guessing):

1. Localize: compile `src/emit/binary.ts` with the WAT emitter (CLI `--wat`
   or the analyze-wat script path) and find in `encodeInstr`'s body the
   `struct.get` whose operand is a `local.tee` of an f64 local. The WAT names
   give you the source construct.
2. Minimize into a standalone repro file in `.tmp/` (extract the construct
   with only the types it needs) and confirm it still emits invalid Wasm via
   the Part-1 helper. THEN reduce to the smallest program that flips
   valid/invalid.
3. Fix at the type-decision site, not by casting at the emission site —
   follow where the ValType for that local was chosen (likely
   `src/codegen/expressions/*` assignment/member paths; check `ctx.oracle`
   usage rules in CLAUDE.md — do NOT reach for raw `checker.*`, the
   oracle-ratchet gate blocks it).
4. Regression tests: (a) the minimized construct as a normal
   `tests/issue-4420*.test.ts` equivalence-style test (compile + validate +
   run, assert correct value); (b) the AC test — compile
   `src/emit/binary.ts` via `compileFiles` with `validate: true` and assert
   `success === true` and `WebAssembly.compile` resolves. Both must pass at
   PR time, so Part 2's fix lands in the same PR as Part 1.
   ⚠ Test (b) compiles a real compiler source file inside vitest — check its
   runtime cost; if it exceeds ~60 s in the suite, scope it to the file-level
   test timeout and note the cost in the test header.

### Out of scope (stays with the parent lane)

The full `src/**/*.ts` self-compile sweep/scoreboard — run separately by the
planner after this lands; results recorded here.

### Acceptance criteria (restated, unchanged from above)

The three checkboxes in this issue; the regression test is (b) in Part 2.

## Results (2026-08-15)

### Root cause of the `encodeInstr` miscompile

**Construct** — `src/emit/binary.ts:1008`, inside `case "if":` of `encodeInstr`:

```ts
const hasElse = instr.else && instr.else.length > 0;
```

**Why the read went dynamic.** `Instr` (`src/ir/types.ts:343`) is not a plain
union — it is an **intersection**, `(…~200 variants…) & { sourcePos?: SourcePos }`.
An intersection carries `ts.TypeFlags.Intersection`, not `Object`, so
`ensureStructForType` returns at its first guard and the narrowed `if`-variant
never becomes a WasmGC struct. `resolveWasmType` therefore answers `externref`
for the receiver and the read is serviced by the dynamic property dispatch in
`finalizeStructAndDynamicMemberGet` (`src/codegen/property-access-dispatch.ts`).
Confirmed by instrumentation: `objType = { op: "if"; blockType: BlockType;
then: Instr[]; else?: Instr[] } & { sourcePos?: SourcePos }`, `objWasm =
externref`.

**The faulty type decision.** In that dispatch, the Phase-3 (#1269)
consumer-side specialization narrows the dispatch RESULT to a primitive when
every struct in the module carrying a field of the same NAME agrees on its
kind. Its guard read:

```ts
let resultWasm = accessWasm.kind === "f64" || accessWasm.kind === "i32" ? accessWasm : { kind: "externref" };
if (resultWasm.kind === "externref" && !preserveDynamicResultCarrier) { …vote… }
```

`resultWasm` is set to `externref` for **every** non-f64/i32 `accessWasm`, so
the vote was also eligible for reads whose static type is a concrete
`ref`/`ref_null`. Here `accessWasm` for `instr.else` is
`{kind:"ref_null", typeIdx: 2}` — `$__vec_externref`, i.e. `Instr[]`. The only
struct in the whole module carrying a field named `else` is the `OP` opcode
table (`$__anon_5`, ~150 all-f64 fields, `else: 0x05`). A single-candidate,
unanimous vote therefore collapsed the read of an **array** to **f64**, while
the enclosing `.length` still emitted the typed `struct.get $__vec_externref 0`:

```wat
call 16                 ;; dispatch result
local.tee 295           ;; $__sd_res_293, declared f64
struct.get 2 0          ;; .length off a $__vec_externref
```

→ `Compiling function #103:"encodeInstr" failed: struct.get[0] expected type
(ref null 2), found local.tee of type f64 @+128058`.

The vote is a NAME-keyed heuristic; a concrete `ref`/`ref_null` access type is
a statement about the value's representation and may not be overruled by it.

### Fix

`src/codegen/property-access-dispatch.ts`, in `finalizeStructAndDynamicMemberGet`
— the Phase-3 vote is now admissible only when the access is statically dynamic:

```ts
if (resultWasm.kind === "externref" && accessWasm.kind === "externref" && !preserveDynamicResultCarrier) {
```

That is the condition the surrounding #1269 comment always described
("when `accessWasm` is externref (TS `any`-typed receiver)"); the guard tested
the wrong variable. Reads with a concrete access type keep the honest externref
dispatch result and are re-narrowed by the caller's own coercion. No cast at the
emission site, no raw `checker.*` call (`check:oracle-ratchet` reports
`getTypeAtLocation +0, ctx.checker +0`).

### Part 1 — the validate gate as implemented

- **`validateEmittedBinary(binary): { valid, detail? }`** — new export in
  `src/optimize.ts`, re-exported from `src/index.ts`. It owns the
  validate-then-reconstruct-a-`Module`-to-recover-the-engine-detail idiom
  (including the TS 5.7+ `BufferSource` cast). Returns `valid: true` when no
  `WebAssembly` global exists, preserving the pre-existing optimizer behavior.
- **`CompileOptions.validate?: boolean`** (`src/index.ts`) — opt-in. When set
  and a binary was produced, an engine rejection flips `success` to `false` and
  pushes a source-anchored **error**-severity `CompileError` carrying the engine
  detail. The binary is still returned so the caller can dump or diff it.
- **Wired at the single common exit**: the tail of `runPipeline`
  (`src/compiler.ts`), which every driver funnels through — `compileSourceSync`,
  `compileSource`, `compileMultiSource` and `compileFilesSource` all return its
  result. Not per-caller, so no driver can be gated while another is not. It
  runs before the async wasm-opt pass, which validates its own output already
  (#1941), so the gate answers for what CODEGEN produced.
- **No duplication and no double-reporting**: `optimizedBinaryValidates`
  (#1941) now delegates to the helper; the CLI's refuse-to-publish check
  (#3338, `src/cli.ts`) calls it instead of its inline copy and keeps its own
  post-optimize placement, so the CLI does not pass `validate: true`.

### Consumers updated

- `tests/helpers/compile-project-probe.ts` — the shared probe behind the
  package-entry dogfood harness (and thus the npm-compat `compile`/`validation`
  fields) held a **third** copy of the idiom; it now calls the helper.
- `scripts/generate-npm-compat-report.mjs` — `correctnessVerdict(...,
  { compiles: report?.compile?.success !== false })` treated `success` as
  "compiled". It now also requires `report?.validation?.validates !== false`.
- **Audited, no change needed**: every `tests/dogfood/*.mjs` harness that
  compiles already runs `WebAssembly.compile`/`validate`/`instantiate` on the
  result (verified mechanically over all of them), and their reports already
  carry `compile.success` and `validation.validates` as separate axes. Passing
  `validate: true` there would have merged two axes their reporting formats
  deliberately keep apart.

### Measured outcome

| Probe | Before | After |
| --- | --- | --- |
| `compileFiles("src/emit/binary.ts")` | `success: true`, 269,241 B, **`WebAssembly.validate: false`** | `success: true`, 269,259 B, **`WebAssembly.validate: true`** |
| minimized construct (13 lines) | `success: true`, **invalid** — same engine message | `success: true`, **valid**, `main()` returns the correct `54` |

`npx tsx .tmp/selfhost-repro.mts src/emit/binary.ts` → `success: true` and
`WebAssembly.validate: true`. (The 5 remaining diagnostics are pre-existing
warning-severity IR-fallback / `rootDir` notes, unrelated.)

### Tests

`tests/issue-4420-emitted-binary-validation.test.ts` (5 tests, all pass):

1. minimized construct emits a module the engine accepts;
2. minimized construct computes the right answer through the dynamic read (54);
3. `validateEmittedBinary` returns `valid: false` **with** an engine detail for
   rejected bytes;
4. `validate: true` accepts a valid module and does not perturb the emitted bytes;
5. **AC** — `compileFiles("src/emit/binary.ts", { validate: true })` reports
   success and `WebAssembly.compile` resolves.

Cost note on (5): **~13.9 s**. It runs OUT OF PROCESS via the new
`tests/helpers/compile-files-validate-probe.ts` (spawned with
`--max-old-space-size=2048`, same pattern as `compile-project-probe.ts`): the
vitest fork pool caps a worker at 512 MB and this graph exhausts that heap, which
surfaces as a worker crash rather than a verdict. The probe also passes
`emitWat: false` — the full-module WAT is a ~2 MB string nothing here reads.

Regression sweep: `issue-1269`, `issue-2938`, `issue-2785`, `issue-2674`,
`issue-2664`, `issue-1712-dynamic-dispatch`, `issue-1712-capture-closure-dispatch`,
`issue-3037`, `issue-3053-u0`, `issue-3431-mg-matrix` → **105 passed, 6 failed**,
and the *identical* 6 fail on the pre-fix codegen (A/B'd by swapping the single
changed file), so they are pre-existing, not caused here. `pnpm run typecheck`
exit 0; biome `--diagnostic-level=error` clean; prettier clean.
`check:oracle-ratchet`, `check:pushraw`, `check:coercion-sites`,
`check:any-box-sites` all green. `check:loc-budget` / `check:func-budget` growth
is granted in this file's frontmatter (comment-dominated).

### Open finding — a SIBLING invalid-module bug, NOT fixed here

`compileFiles("src/boundary-policy.ts")` still returns `success: true` with
60,352 bytes that the engine rejects, **after** this fix:

```
Compiling function #47:"__cb_0" failed:
  struct.new[1] expected type (ref null 26), found if of type f64 @+28816
```

Re-verified against the fixed compiler, so it is a different defect in the same
family (a value the checker types as a struct ref lowered as f64), not a second
symptom of the Phase-3 vote. WAT localization points at a generated callback
wrapper `$__cb_0` building a `$__tuple_0 (struct (field $_0 externref) (field
$_1 (ref null $StructTypeDef)))`, whose second element is a bounds-guarded array
read lowered as `(if (result f64) … (else NaN))` — i.e. the element type was
decided f64 while the tuple slot is a struct ref. Left for a follow-up issue per
the parent lane's instruction; recorded here so the repro is not lost:
`npx tsx .tmp/selfhost-repro.mts src/boundary-policy.ts`.
