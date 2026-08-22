---
id: 4612
title: "acorn tokenizer post-claim withdrawal: abi-signature-parity IR=182 vs legacy=151 on the runtime-dynamic lane"
status: in-progress
sprint: current
created: 2026-08-21
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3518
related: [2949, 3520, 4730]
origin: "#2949 census re-measurement (PR #4730): main acquired this withdrawal on its own between fd679233f (2026-07-30, 0 withdrawals) and fec977606 — byte-identical before and after #4730's selector change"
# id 4612 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs 4732/4733 introduce no issue files
# with ids near 4612.
#
# The fix adds ONE selector option (its doc comment carries the #4155
# invariant-break rationale) and its one production call site. Both files are
# the barrel/driver for their subsystem, but the option must be declared in
# `IrSelectionOptions` and passed from the single `planIrCompilation` call —
# there is no subsystem module either half could move to.
loc-budget-allow:
  - src/ir/select.ts
  - src/codegen/index.ts
# One line: the option is passed at the single `planIrCompilation` call site,
# which lives inside `planIrOverlay`. Nothing to split out.
func-budget-allow:
  - src/codegen/index.ts::planIrOverlay
---

# #4612 — `tokenizer` withdraws post-claim on ABI signature parity

## Problem

The #2949 runtime-dynamic acorn driver (npm-compat `--only acorn --lane
standalone-dynamic`, inline form) shows **1 post-claim withdrawal** on
current main that did not exist on the 2026-07-30 baseline: `tokenizer`
withdraws with `abi-signature-parity` — the IR path derives a signature
of **182** entries where the legacy path derives **151**. The prior bar
for this driver was **zero** post-claim withdrawals; main broke that bar
on its own somewhere after `fd679233f`.

A post-claim withdrawal is worse than a pre-claim decline: the selector
accepted the function, work was done, and the claim was retracted at the
parity check — the exact failure mode the #4520 differential gate exists
to catch at the carrier level.

## Acceptance criteria

- [x] Bisect or otherwise identify which landed change moved the IR-side
      (or legacy-side) signature count for `tokenizer` (182 vs 151 — the
      31-entry delta likely names the family).
- [x] Either restore parity (fix the divergent side) or, if the IR side is
      CORRECT and legacy under-counts, record that verdict with evidence
      and adjust the parity rule's expectation — never silence the check.
- [x] Driver back to zero post-claim withdrawals, emitted count not
      reduced (currently 31/42).
- [x] `check:ir-fallbacks` / `check:ir-only` unchanged.

## Findings (2026-08-22)

### First: 182 and 151 are TYPE INDICES, not entry counts

The premise that "the 31-entry delta likely names the family" does not hold.
`182` and `151` are indices into `ctx.mod.types`, printed verbatim by the
parity guard's message (`IR=${wasmFunc.typeIdx}, legacy=${existing.typeIdx}`).
Their difference is an artifact of interning order and carries no meaning at
all. There is no 31-entry family to enumerate.

The real divergence is one slot, dumped with `JS2WASM_DEBUG_ABI_PARITY=1` on
the reconstructed driver:

| side | signature | type name |
| --- | --- | --- |
| IR (182) | `(externref, externref) -> externref` | `$__closure_prop_get_type` (an unrelated same-shape type it happened to intern onto) |
| legacy (151) | `(externref, externref) -> (ref null 62)` | `tokenizer_type`; type 62 is `$__fnctor_Parser` |

Only the RESULT differs. Both parameters already agree.

### The driver, reconstructed

`.tmp/driver-4612.mjs` mirrors `scripts/generate-npm-compat-report.mjs`
(`perfAcornStandaloneDynamic` → `compileStandaloneLane({inlineDriver:true})`)
and reduces it to the compile/outcome census: pinned acorn@8.16.0 dist +
the runtime-dynamic benchmark driver, compiled as ONE standalone unit with
`deferTopLevelInit` and `trackIrOutcomes`. Replayed on `fd679233f` it reports
`20/43 emitted, 0 withdrawals`, matching the #2949 record, so it is the same
measurement. (`--no-optimize` for speed; `optimize` runs after codegen and
cannot move an IR outcome. Denominator 43 vs the notes' 42 — same off-by-one
the #2949 notes already flag.)

### Bisect verdict

`git bisect --first-parent fd679233f..main`, 1311 candidate commits, 11 steps,
one measurement per step ("does `tokenizer` withdraw with
`abi-signature-parity`"):

```
fd679233f GOOD  20/43 emitted · 0 withdrawals   (tokenizer: select/body-shape-rejected)
760c5eb1a GOOD  32/43 emitted · 0 withdrawals   (tokenizer: EMITTED)
269c26a80 BAD   31/43 emitted · 1 withdrawal    ← first bad commit
3d1de92f0 BAD   31/43 emitted · 1 withdrawal    (main, 2026-08-22)
```

**`269c26a80` = PR #4116, issue #4155** — *"unbox fnctor instance types by
default — acorn −8.1%"*. Its whole diff is two files; the load-bearing line
flips `fnctorTypedInstancesEnabled()` from opt-in to ON:

```diff
-  return process.env.JS2WASM_FNCTOR_TYPED_INSTANCES === "1";
+  return process.env.JS2WASM_FNCTOR_TYPED_INSTANCES !== "0";
```

Confirmed independently of the bisect by the flag's own opt-out on current
main: `JS2WASM_FNCTOR_TYPED_INSTANCES=0` returns the driver to
**32/43 emitted, 0 withdrawals** with `tokenizer` claimed again.

Note `tokenizer` was **emitted** immediately before that commit, not merely
declining — so #4155 cost a claim, it did not expose a latent one.

### Root cause — #4155 broke the #2949 slice-3b carrier invariant

`resolvePositionType`'s dynamic arm (`src/codegen/index.ts`) states the
contract for an UNANNOTATED position the IR resolves as `dynamic`:

> Lowering: `lowerIrTypeToValType`'s dynamic arm → `resolveDynamic()` = legacy
> `resolveWasmType`'s any/unknown carrier … **so the claimed function's Wasm
> signature equals what legacy gives the same declaration.**

That last clause is what #4155 falsified. Legacy does not resolve an
unannotated position through the any/unknown carrier at all — it resolves the
CHECKER type, and #4155 added an arm that refines an approved-standalone
fnctor INSTANCE type to that fnctor's reserved `$__fnctor_<Name>` struct
(`resolveFnctorInstanceType`). The IR reads the propagated lattice, never the
checker, so for

```js
Parser.tokenizer = function tokenizer (input, options) { return new this(options, input) };
function tokenizer(input, options) { return Parser.tokenizer(input, options) }   // ← the unit
```

the checker answers `Parser`, legacy emits `(ref null $__fnctor_Parser)`, and
the lattice answers `dynamic`. Divergence is guaranteed, and the claim could
only ever die at the parity guard.

### Verdict: the LEGACY side is correct; the IR cannot express the ABI yet

Legacy is both more precise *and* already baked into every caller's emitted
call — that refinement is the entire −8.1 % acorn win #4155 measured. So the
parity expectation is not adjusted and the check is not touched: the IR is the
divergent side.

Nor can the IR simply adopt the refined type today. `coerceReturnValue`
(`src/ir/from-ast.ts`) has arms for `callable`, `dynamic`, `f64` and
`externref` declared results — there is **no** arm converting the dynamic
carrier into a struct ref (that needs `any.convert_extern` + a guarded
`ref.cast`, which the IR has no primitive for). Teaching the IR to express the
fnctor-instance ABI is #2949/#3520 work.

### Fix — decline before the claim, from the same artifact the guard reads

`legacyPositionCarriesFnctorInstance` (`src/codegen/fnctor-typed-instances.ts`)
reads the ALREADY-REGISTERED legacy signature — `ctx.funcMap` →
`ctx.mod.types` — and reports whether the position's slot is one of
`ctx.fnctorReservedTypeIdx`'s reserved structs. That is the *same artifact*
the post-claim parity guard compares against, so the pre-claim question and
the post-claim check cannot drift. The selector's two `dynamic` arms
(`resolveParamType`, `resolveReturnType` in `src/ir/select.ts`) consult it
through the new `dynamicCarrierDivergesFromLegacy` option and decline instead
of claiming — the exact move `resolveImplicitParamType` already makes on the
parameter side, whose own doc says it exists so the selector does not "widen
the parameter to `dynamic` and withdraw later on type parity".

Answers `false` whenever the legacy slot is not registered yet (IR-first
ordering, bare selector callers) and off-standalone: unknown ⇒ no divergence ⇒
status-quo selection.

### Driver census, before → after

| | `fd679233f` | main `3d1de92f0` | this branch |
| --- | --- | --- | --- |
| emitted | 20/43 | 31/43 | **31/43** |
| **post-claim withdrawals** | 0 | **1** | **0** |
| `abi-signature-parity` (resolve) | 0 | 1 | **0** |
| `return-type-not-resolvable` (select) | 0 | 0 | 3 |
| `body-shape-rejected` (select) | 13 | 9 | 8 |
| `constructor-resolution-unsupported` (select) | 1 | 1 | 0 |
| `logical-value-unsupported` (select) | 1 | 1 | 1 |

Emitted set is byte-identical (no claim lost, none gained). Three units move
between PRE-claim buckets — all three return a fnctor instance and all three
were already declining, except `tokenizer`:

| unit | main | this branch |
| --- | --- | --- |
| `tokenizer` (returns `Parser`) | **resolve / `abi-signature-parity`** | select / `return-type-not-resolvable` |
| `binop` (returns `TokenType`) | select / `constructor-resolution-unsupported` | select / `return-type-not-resolvable` |
| `kw` (returns `TokenType`) | select / `body-shape-rejected` | select / `return-type-not-resolvable` |

The return-type gate is evaluated before the body-shape gate, which is why
`kw` reports the earlier reason now. No unit changed emitted-ness.

### Gates

| gate | result |
| --- | --- |
| `check:ir-fallbacks` | OK — no unintended/post-claim/module-level increases |
| `check:ir-only` | READY — 38 IR bodies, 0 legacy bodies, 0 invariants |
| `check:linear-ir` | OK — compiled=8 (baseline 8), buckets unchanged |
| `typecheck` | clean |
| `biome lint` (changed files) | clean |

### Tests

`tests/issue-4612-fnctor-instance-return-parity.test.ts` — 4 tests. The
fixture is acorn's shape reduced: a `var F = function F(){}` fnctor with a
`new this(...)` static (always `reconstruct`, so `F` is escape-gate approved
and gets a reserved struct) plus the delegating top-level wrapper. Compiled as
`.mjs` on purpose — TypeScript applies its JS expando/`prototype` assignment
inference (what makes the checker answer `Parser` for `new this(...)`) only to
JavaScript files; the same fixture named `.ts` does not reproduce.

It pins: the SELECT-stage decline (not a `resolve`-stage withdrawal), that no
unit withdraws on ABI parity, that the non-fnctor sibling `countOf` keeps its
claim, that the gate stays silent on the JS-host lane, and that the retained
legacy body is still value-correct. The first test FAILS on the parent commit
with `stage: "resolve", code: "abi-signature-parity"`.
