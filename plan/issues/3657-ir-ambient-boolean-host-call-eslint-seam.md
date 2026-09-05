---
horizon: m
id: 3657
title: "IR: ambient boolean host call rejected in ESLint Linter class method"
status: ready
created: 2026-07-26
updated: 2026-07-26
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir, host-interop
language_feature: ambient-functions
goal: npm-library-support
sprint: current
es_edition: ES2015
related: [1371, 2693, 2781, 3325, 3518, 3653]
---

# #3657 — IR ambient host call with a boolean result

## Problem

The real-`espree`/real-`esquery` host-delegation seam in
`tests/issue-2693-host-delegated-select.test.ts` contains:

```ts
declare function __host_is_statement(code: string): boolean;

class Linter {
  verify(code: string): string {
    if (__host_is_statement(code)) {
      // rule logic
    }
    return "";
  }
}
```

When the test is allowed to execute (its path-vacuity defect is #3653), current
`origin/main` fails before Wasm:

```text
Codegen error: IR path failed for Linter_verify:
ir/from-ast: call to unknown function "__host_is_statement"
in Linter_verify [IR-FALLBACK]
```

The simpler #2693 demo still passes with ambient imports returning numbers and
strings. #3325 also proves runtime dependency wiring for ambient functions.
This issue is the IR call-graph/lowering gap before that runtime path.

## Scope

- Recognize a referenced ambient `declare function` as a typed external/host
  call when lowering a class method.
- Preserve its declared parameter and boolean result types.
- Record the host capability in the prepared import manifest before lowering.
- Keep unknown undeclared functions fatal; this is not a general
  string-whitelist escape hatch.

## Acceptance criteria

- A reduced class-method fixture calling
  `declare function predicate(s: string): boolean` compiles and validates.
- Injected host predicates returning true and false both produce the expected
  Wasm-visible branch result.
- Missing dependencies retain the documented #3325 behavior; this issue does
  not silently invent a predicate result.
- `tests/issue-2693-host-delegated-select.test.ts`, after #3653, loads real
  `espree`/`esquery`, compiles, instantiates, and passes its four runtime cases.
- Numeric/string ambient-call fixtures from #2693 and #3325 remain green.

## Implementation (2026-07-26)

- Added one checker-backed resolver for exact, fixed-arity primitive calls from
  top-level class members to same-file user `declare function` stubs. Symbol
  identity, rather than callee text, distinguishes the ambient declaration from
  shadows, imports, lib globals, and unknown functions.
- Recorded each certified call as an exact AST-node lowering plan. The class
  member IR builder reuses the existing typed direct-call lowering only for
  those planned nodes.
- Added a final-context preflight that proves declaration collection produced
  the matching `env` function import with the planned parameter/result ABI
  before the class member is lowered.
- Converted the real espree/esquery seam from `it.fails` to an ordinary Node
  JS-host test and routed its four host functions through `buildImports`.

## Verification (2026-07-26)

- `tests/issue-3657.test.ts` proves genuine `Gate_check` IR emission, validates
  the module/import manifest, exercises true and false predicate results, and
  pins the #3325 missing-dependency no-op behavior.
- The real espree/esquery test compiles, instantiates, and passes all four
  semicolon-rule cases. After the ambient calls clear this issue's prior
  unknown-call invariant, its mixed string/number message assembly takes the
  existing #2781 safe legacy demotion; that fallback is not a compile blocker.
- The numeric/string #2693 demo and all six #3325 ambient dependency tests
  remain green.
- `pnpm run typecheck` and `pnpm run check:ir-fallbacks` pass.

## Implementation Plan

### Verdict — ALREADY LANDED. No implementation work remains (re-measured 2026-08-26)

Re-verified against the current tree (`main` fast-forwarded today, HEAD
`0e65e238`). Every acceptance criterion is met **on disk**, not merely claimed by
the `## Implementation (2026-07-26)` section above. This section therefore
records the shipped design and the measurements, rather than proposing a change.

**The `## Problem` repro no longer reproduces.** Compiling the issue's exact
fixture (`declare function __host_is_statement(code: string): boolean` called
from `Linter.verify(code: string): string`) with `experimentalIR: true`:

| Signal              | Issue's reported failure                        | Measured 2026-08-26                     |
| ------------------- | ----------------------------------------------- | --------------------------------------- |
| compile             | `Codegen error: IR path failed for Linter_verify` | `success: true`                       |
| `WebAssembly.validate` | n/a (no binary)                              | `true`                                  |
| `irCompiledFuncs`   | — (`[IR-FALLBACK]` to legacy)                   | `["verify", "Linter_verify"]`           |
| `irPostClaimErrors` | —                                               | `[]`                                    |
| `env` imports       | `call to unknown function "__host_is_statement"` | `["__host_is_statement"]`               |
| IR-fallback warning | `ir/from-ast: call to unknown function …`        | none                                    |

The class member is genuinely IR-lowered; this is not a silent legacy demotion.

**Acceptance criteria, each measured:**

| # | Criterion                                                        | Evidence |
| - | ---------------------------------------------------------------- | -------- |
| 1 | reduced class-method `predicate(s: string): boolean` fixture compiles + validates | `tests/issue-3657.test.ts:25-38` — asserts `success`, `WebAssembly.validate`, `irCompiledFuncs ∋ "Gate_check"`, `irPostClaimErrors == []`, `env.predicate` present |
| 2 | true and false host predicates both branch correctly             | `tests/issue-3657.test.ts:49-55` — `check("yes") === 17`, `check("no") === -4` |
| 3 | missing dependency retains #3325 behavior, no invented result     | `tests/issue-3657.test.ts:57-60` — `instantiateGate({})` ⇒ `-4` |
| 4 | real espree/esquery seam compiles, instantiates, passes           | `tests/issue-2693-host-delegated-select.test.ts` — 2/2 pass; `it.fails` is gone, now `it.skipIf(ESLINT_LINTER === null)` (#3653, `status: done`) |
| 5 | numeric/string #2693 and #3325 fixtures stay green                | 11/11 pass across `issue-2693-host-delegated-select`, `issue-2693-linter-verify-demo`, `issue-3325`, `issue-3657` |

`pnpm run check:ir-fallbacks` ⇒ `IR fallback gate: OK`, **`Unintended: (none)`**.
`scripts/ir-fallback-baseline.json` now carries `"unintended": {}` — the
`external-call` bucket this issue fed is fully retired, along with the rest of
the #1371/#2855 unintended set.

### Shipped design (for the record — exact files and lines)

Four seams, in pipeline order:

1. **Certification** — `src/ir/host-extern.ts:46-107`
   `makeIrAmbientClassCallResolver(checker)` returns an
   `IrAmbientClassCallCertification` (`:16-22`) or `undefined`. Two independent
   gates, both fail-closed:
   - *Syntax/owner gate* (`:49-70`): rejects optional-chain, type arguments,
     non-identifier callees, spread args; walks to the nearest function-like
     ancestor and requires a **method / get / set / constructor whose parent is a
     `ClassDeclaration` whose parent is the `SourceFile`** — i.e. a top-level
     class member only.
   - *Declaration gate* (`:72-101`): `checker.getResolvedSignature(call)` must
     land on a **bodyless `FunctionDeclaration` in the same source file**, at
     source-file scope, carrying `declare`, with no generator/type parameters,
     exact arity, and every parameter a plain identifier with no
     `?`/rest/initializer. `isFixedPrimitiveAmbientType` (`:28-34`) confines both
     parameters and result to `boolean | number | string`. Finally
     `checker.getSymbolAtLocation(call.expression)?.declarations` must **include
     that declaration** — symbol identity, not callee spelling, so a local shadow,
     an import, or a lib global cannot pass. The whole body is `try/catch →
     undefined` (`:48,103-105`), so a checker throw degrades to "not certified".

   The module is deliberately a **leaf** (`:5-11`) — it imports only the `ts`
   facade and `checker/type-mapper`, because `scripts/check-ir-fallbacks.ts`
   builds its own program and importing codegen would perturb ESM init order.

2. **Selector opt-in** — `src/ir/select.ts:605-606`
   `ambientClassCalls?: IrAmbientClassCallResolver` on the selector options,
   omitted by host-free and bare-selector callers so nothing widens accidentally.

3. **Planning** — `src/codegen/ir-imported-call-planning.ts:341-427`
   For each retained class member, walks the member body (`:377-416`, stopping at
   nested function-likes at `:379`), and for every certified call records an
   `IrImportedCallLoweringPlan` (`src/ir/ast-lowering-plans.ts:19-32`) with
   `source: "ambient-host"` and `target: irImportFuncRef("env", targetName)`
   (`:399-408`). Param/return `IrType`s come from `resolvePositionType` over the
   **declaration's own** type nodes (`:384-391`), so the declared ABI is
   preserved rather than re-inferred at the call site. An overlap with an existing
   source-unit imported-call plan is a hard `IrInvariantError` (`:392-398`). Any
   planning failure rolls back the whole member — it is dropped from
   `retainedClassMembers` and **all** its ambient plans are deleted (`:418-424`),
   so a member is never half-planned.

   `requireValidImportedCallTarget` (`ast-lowering-plans.ts:34-46`) enforces the
   union invariant: an `ambient-host` plan must be backed by an `env` import
   (`:39-42`), while a `module-import` plan must be backed by an exact unit.

4. **Final-context preflight** — `ir-imported-call-planning.ts:114-146`
   `prepareIrAmbientClassCallLowering` runs after declaration collection and
   proves, per plan, that the certified function actually materialized as the
   exact `env` import. `hasPreparedAmbientHostImport` (`:84-112`) maps each IR
   type through `ambientHostValType` (`:68-74`) and then compares against the
   **real emitted import**: index inside `ctx.numImportFuncs`, matching
   module+name, and a func type whose params/results match arity and kind. On
   mismatch the member is removed from `selection.classMembers` and a
   `late-preparation-unsupported` failure is recorded (`:136-144`) — a safe
   demotion to legacy, never a miscompile.

   Wiring: `src/codegen/index.ts:2681-2682` constructs the resolver, `:2826`
   feeds the selector, `:3113` feeds planning.

**Measured ABI** (`emitText` on a fixture with both a boolean and a number
ambient):

```wat
(type $type6 (func (param externref) (result i32)))   ;; declare …: boolean
(type $type7 (func (param externref) (result f64)))   ;; declare …: number
(import "env" "predicate" (func $predicate_import (type 0)))

(func $Gate_check (type 6)
  local.get 1
  call 0            ;; env.predicate -> i32
  (if (then f64.const 17 return) (else f64.const -4 return))
  unreachable)
```

`string → externref`, `number → f64`, `boolean → i32`.

### Dual-mode rule (CLAUDE.md "JS host optional") — how it is satisfied

The rule is *"don't add new host imports without a standalone fallback."*
**This change adds no compiler-introduced host import at all**, so the rule is
satisfied by construction, not by a fallback:

- The `env.<name>` import is **user-declared**. It exists because the program
  author wrote `declare function`; it is registered by the pre-existing
  `collectExternDeclarations` (`src/codegen/index.ts:4901` et al.), not minted by
  this seam. This work only changes **which front-end lowers the call** — IR
  instead of legacy — for a call whose import already existed on both paths.
- Measured on `target: "standalone"`: the same fixture compiles (`success: true`)
  and still emits `env.predicate`. An ambient declaration is an *embedder-supplied
  capability*, and standalone expresses it as a plain `env` import the embedder
  fills — there is no JS-runtime-specific marshaling to replace.
- The IR resolver itself is gated on `jsHostExterns` (`index.ts:2640,2681`), so
  standalone/WASI route the member through the legacy front-end. That is a
  **lowering-path** difference with identical observable semantics, not a missing
  capability. Measured: `target: "standalone"` ⇒ `irCompiledFuncs: ["check"]`
  (member on legacy), module still correct.
- Consequence for anyone extending this: widening the resolver past
  `boolean | number | string` **would** cross into marshaling that differs by
  mode, and at that point a standalone story becomes required. The
  `isFixedPrimitiveAmbientType` gate is what keeps the current change mode-neutral.

### Edge cases — how each is handled

| Edge case | Handling |
| --------- | -------- |
| **Ambient declared inside a class method** (nested `declare`) | Not admitted. The declaration gate requires `ts.isSourceFile(declaration.parent)` (`host-extern.ts:82`) — the stub must be at source-file scope. A method-local declaration is not certified and falls to legacy. |
| **Call nested inside a closure within the method** | Not admitted. The plan walk returns at any nested function-like (`ir-imported-call-planning.ts:379`), so only calls directly in the member body are planned. Capture/closure ABI is never involved. |
| **Callee is a shadow / import / lib global with the same spelling** | Rejected by symbol identity (`host-extern.ts:100-101`), not by name comparison. This is the load-bearing check — a text match would admit `parseInt`-style lib globals. |
| **Return-type resolution failure** | `resolvePositionType` throwing is caught at `ir-imported-call-planning.ts:409-412`, classified via `classifyIrFailure(error, "resolve")`, and rolls the **entire member** back (`:418-424`). No partially-typed plan survives. |
| **Declared type is not a fixed primitive** (`void`, union, object, `any`, inferred) | `isFixedPrimitiveAmbientType` (`host-extern.ts:28-34`) requires a literal `boolean`/`number`/`string` keyword **type node**. An omitted return type node also fails, so nothing is silently inferred. |
| **Overloads / optional / rest / default params / generics** | All rejected explicitly (`host-extern.ts:84-94`): `declaration.body` present, `asteriskToken`, `typeParameters`, arity mismatch, `questionToken`, `dotDotDotToken`, `initializer`. `needsArgc: false` and an empty `optionalParams` map (`ir-imported-call-planning.ts:406-407`) are therefore sound. |
| **Truthiness coercion** | None is emitted, and none is needed. The boolean result arrives as **i32**, which `if` consumes directly (see WAT above). The JS→Wasm boundary applies the standard JS API `ToInt32` to the host's return value, so `true → 1`, `false → 0`. Note the contract this implies: a host that violates its own `: boolean` declaration by returning a truthy **non-numeric** value (e.g. `"yes"`) yields `ToInt32("yes") === 0` and reads as **false** — JS truthiness is *not* applied. That is the declared-ABI contract, not a defect, but it is the one place host and JS semantics visibly differ. |
| **Missing host dependency** (#3325) | Untouched by this seam. `buildImports` supplies the documented no-op stub; the predicate reads false and the module still instantiates. Pinned by `tests/issue-3657.test.ts:57-60`. |
| **Import manifest drift between planning and emission** | Caught by the `hasPreparedAmbientHostImport` preflight (`:84-112`), which re-reads `ctx.mod.imports`/`ctx.mod.types` rather than trusting the plan. Mismatch ⇒ safe demotion. |
| **Ambient + source-unit plan collision on one call node** | Hard `IrInvariantError` (`:392-398`) — deliberately fatal, since it would mean two authorities claim the same node. |

### Test plan

**Existing coverage is sufficient; all of it currently passes.**

| File | Covers |
| ---- | ------ |
| `tests/issue-3657.test.ts` (61 lines) | genuine `Gate_check` IR emission, module validation, `env.predicate` in the manifest, true/false branch results, #3325 missing-dep no-op |
| `tests/issue-2693-host-delegated-select.test.ts` | real espree + esquery dual host-delegation seam, 4 semicolon-rule cases |
| `tests/issue-2693-linter-verify-demo.test.ts` | numeric/string ambient `Linter.verify` milestone |
| `tests/issue-3325.test.ts` (6 tests) | ambient dependency wiring: numeric arg, string arg, once-per-call-site, missing dep, declared-but-unused, non-function dep |

Command used (28s, 11/11 pass):

```bash
npx vitest run tests/issue-2693-host-delegated-select.test.ts \
  tests/issue-2693-linter-verify-demo.test.ts \
  tests/issue-3325.test.ts tests/issue-3657.test.ts
```

Plus `pnpm run check:ir-fallbacks` ⇒ OK, `Unintended: (none)`.

**One gap worth closing if this issue is reopened** — the landed fixture returns
`number`. The issue's own `## Problem` shape returns **`string`**, which exercises
the #2781 mixed string/number demotion noted in `## Verification`. Add to
`tests/issue-3657.test.ts` a third case pinning the `Linter.verify(code): string`
shape, asserting `irCompiledFuncs ∋ "Linter_verify"` and both branch strings, so
the exact reported repro is regression-pinned rather than only its numeric
cousin. Verified today that this shape does IR-lower — the test would pass as
written.

### Residual observations (out of scope — do NOT bundle into #3657)

- **Top-level functions are not covered.** The same ambient boolean call from a
  plain `export function` is *not* IR-claimed (`irCompiledFuncs: []`), because the
  owner gate at `host-extern.ts:60-70` admits class members only. Correctness is
  unaffected — it compiles, validates, and emits `env.predicate` via legacy. The
  issue's `## Scope` says "when lowering a class method", so this is by design;
  file a separate issue if the IR path should widen.
- **Do not promote `external-call` to strict.** Even though its baseline bucket is
  now zero, `src/codegen/index.ts:2043-2062` documents that corpus-zero is
  **necessary but not sufficient** (#3341): the 13-file playground corpus does not
  prove unreachability on real code, and `external-call` still names a legitimate
  non-claimable construct. `STRICT_IR_REASONS` stays empty.
- **Housekeeping.** Frontmatter is still `status: ready` with `sprint: current`,
  so the auto-synced TaskList will keep offering this as live work and a dev will
  re-implement what already exists. It should be flipped to `status: done` with a
  `completed:` date. Not changed here — this pass was scoped to writing the plan.
