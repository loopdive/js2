---
id: 3188
title: "UMBRELLA: ES module-code semantics (~174 fails) — namespace objects, cross-module TDZ, module early errors + wrapTest export collision"
status: in-progress
created: 2026-07-12
priority: medium
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: ES2015
language_feature: modules
goal: core-semantics
sprint: current
horizon: l
related: [1089, 2971, 1512, 34, 1696]
origin: "2026-07-12 Fable codebase audit (plan/log/2026-07-12-fable-codebase-audit.md, §F5)"
---

# #3188 — UMBRELLA: ES module-code semantics

## Problem

`language/module-code` has **174 non-pass** on the default lane (baseline
2026-07-12) and is the last whole-ES-surface with **no live tracking**: only
ancient #34 (multi-memory module linker), #2971 (TLA sibling-module
evaluation) and #1512 (dynamic-import early errors) graze it; dynamic import
itself is #1089 (ready, ~330 more `language/expressions/dynamic-import`
fails). Static-module semantics have no umbrella.

Error-shape census:

```
 26+26  returned N / ConformanceError                 ← semantics wrong
 17     expected SyntaxError, no diagnostic            ← module early errors unenforced
 14     [object WebAssembly.Exception]
 10     Cannot access property on null/undefined
  9+2   assert.throws(ReferenceError, …)               ← cross-module / indirect-binding TDZ
  6     Duplicate identifier 'test' / Duplicate export name 'test'   ← RUNNER artifact
  5     Reflect.has called on non-object               ← module namespace object
  4     No dependency provided for extern class "C"
```

## Slices (file children as picked up)

1. **[S, ready-first] Runner artifact — ✅ DONE (2026-07-12, dev-find-wasm)**.
   The 6 `Duplicate export name 'test'` records were NOT a test's own `test`
   export (none exist) — they are the `top-level-await/syntax/*-await-expr-obj-literal.js`
   tests whose `await { function() {} }` operand misparses. The runner compiles
   the top-level-await body SYNCHRONOUSLY (wrapTest TLA path emits it at module
   top level, not inside `async`), so TS treats `await` as an identifier and the
   trailing `{ … }` as a *block statement*, which swallows the wrapper's
   `export function test()` during error recovery. Fix: `parenthesizeAwaitBraceOperand`
   rewrites `await { … }` → `await ({ … })` in the TLA path (a no-op in a real
   async context), so the `{ … }` parses as the await operand in every position
   (top-level statement, `typeof`/`void`, for-header, `export var/let x = await {…}`).
   Measured: TLA-syntax dir 205→211 compileOK / 6→0 CE, zero regressions.
   Tests: `tests/issue-3188.test.ts`.
2. **Module early errors (17)** — duplicate exports, undefined export names,
   `import`/`export` position errors: enforce at compile time via the TS
   checker diagnostics or a targeted static-semantics pass (same pattern as
   the #3026 negative-test lineage).
3. **Module namespace object semantics** — @@toStringTag, [[Has]]/Reflect.has
   on the namespace, non-extensibility, binding views (`ns.localN` shapes —
   19 in the dynamic-import bucket share this substrate with #1089).
4. **Cross-module TDZ / indirect bindings** — `assert.throws(ReferenceError)`
   on access-before-evaluation; live-binding reads after mutation.

## Notes

- Slices 3-4 share their substrate with #1089 (dynamic import returns the
  same namespace object) — coordinate; whoever lands first builds the
  namespace-object representation.
- test262 module tests declare `flags: [module]`; verify the runner compiles
  those as module code (not wrapped script) before attributing semantic fails.

## 2026-09-20 — bounded module-namespace `@@toStringTag` slice

### Measured antecedent and fresh-baseline boundary

The post-#4759 Node 25 standalone receipt at candidate
`2f6c0f4f57db129c772a476345c28d85010cd175` leaves these four exact ES2015
originals non-passing after their self-import namespace binding is correctly
linked:

- `language/module-code/namespace/Symbol.toStringTag.js`
- `language/module-code/namespace/internals/get-sym-found.js`
- `language/module-code/namespace/internals/has-property-sym-found.js`
- `language/module-code/namespace/internals/get-own-property-sym.js`

All four source files have no runtime exports: their namespace import therefore
uses the deliberate empty-export path in `namespaceFunctionExports`. The
current `emitNamespaceObject` materializes a cached plain `$Object`, but its
only own-property writes are the loop over string-named exports. An empty
namespace consequently has no own `Symbol.toStringTag`, matching the measured
`undefined` value, failed `in`/`Reflect.has`, and missing descriptor.

This is source evidence for a narrow codegen/runtime-visible object seed, not
for an IR, runner, module-linking, or general namespace-exotic repair. A fresh
four-path original baseline on the pinned current source revision is still
required before any claimed gain; the earlier receipt is historical
attribution only.

### Narrow plan

1. In `src/codegen/module-namespace-value.ts`, provision the existing
   plain-object descriptor machinery and well-known-symbol boxing alongside
   the namespace object's other helpers, before the single late-import flush.
   The native object runtime is only provisioned under the existing
   `semanticProviders === "native-first"` policy; host GC uses the existing
   `__defineProperty_value` late import instead. Re-resolve every captured
   helper index after provisioning; do not retain a stale function index across
   a flush.
2. While initializing a successfully materialized module namespace object,
   define the genuine `Symbol.toStringTag` key (well-known symbol id `4`) with
   value `"Module"` through `__defineProperty_value`. Its shared descriptor
   ABI flags are `0xB8`: `hasValue` plus writable/enumerable/configurable
   presence bits, with all three attribute values clear. This gives both host
   and native stores an explicit data value and non-writable,
   non-enumerable/non-configurable attributes. Do not use a string key named
   `"toStringTag"`, a source-name special case, or `Object.freeze`.
3. Preserve the existing cached-object identity and the ordinary string-export
   seed loop. This slice does not change namespace-import admission, export
   sorting, live binding behavior, or ordinary-object symbol properties.

`src/codegen/builtin-static-globals.ts` already uses the same genuine-symbol
seed pattern for namespace tags. Its JSON variant has a configurable tag, so
it is precedent for provisioning only, not for the module descriptor flags.

### Validation and exclusions

The focused test must cover the four originals above plus a linked empty
namespace with all of the following observations: value `"Module"`; descriptor
attributes all false; `in`, `Reflect.has`, and `hasOwnProperty` success; a
fresh `Symbol("Symbol.toStringTag")` miss; repeated namespace reads retaining
identity; and an admitted string-named `"toStringTag"` export coexisting with
the symbol property. An admitted function export must still call and retain
its cached closure identity after the tag seed, exercising late helper shifts.
A normal plain object must retain its missing tag. Every standalone focused
module must have zero `WebAssembly.Module.imports` before instantiation.

A separate TypeScript runtime-namespace projection control must materialize a
bounded computed function surface and prove that its exported callable is
present and callable in both lanes. It is intentionally separate from the
immutable six-case ESM A/B fixture: runtime namespace projections are not
module namespace exotic objects. It does not claim semantic
`Symbol.toStringTag` descriptor absence, because this materializer currently
does not expose its namespace object as a first-class source value.

The eventual run must retain actual original-harness metadata and distinguish
runner startup failures from semantic rows. No test is a fresh baseline result
until that run is terminal.

### 2026-09-20 host-mode correction receipt

The first identical focused fixture revision
`771031e15a83792d271f1e8ea75eb0f370e76992311ced9cf67fb7dcf6a6a856`
was measured at `de232b80e43dc82c2fafc331cc10d658f26a8897` after removing
invalid TypeScript annotations from virtual `.js` inputs. The clean baseline
was 0/6 semantic passes (empty 56/63, string-export 1/7, function-export 3/15
for both GC and standalone). The candidate was 3/6 standalone passes and 3 GC
compile errors: eager `ensureObjectRuntime` attempted native string helper
provisioning in the host-assisted GC lane (`__str_trimStart` lacks
`string.len`). This is a candidate-only regression, not an unrelated fixture
failure. The next source correction keeps native runtime provisioning
native-first-only and registers the host descriptor import through the shared
late-import ABI; it also replaces the incorrectly implicit flag word `0` with
explicit `0xB8`. No post-correction runtime pass is claimed here.

### 2026-09-20 runtime-namespace false-arm admission receipt

The first separate runtime-namespace control failed 2/2 with a Wasm exception
on both providers. It did **not** exercise the false arm: the source had no
finite computed assignment inside the `namespace RuntimeNs` module block, and
`runtimeNamespaceFunctionSurface` therefore returns `undefined` before
`emitNamespaceObject(..., false)` is reachable. The preserved failure is not a
candidate loss.

The corrected version added the established finite write
`RuntimeNs[key] = inspect` and ran byte-identically on the pinned baseline and
candidate. Both still fail 2/2: GC throws `Reflect.get called on non-object`
through `__fn_tramp_inspect_cached`, while standalone traps. The matching
receipts are
`/private/tmp/js2-3188-runtime-namespace-false-arm-baseline-de232-20260920.log`
and
`/private/tmp/js2-3188-runtime-namespace-false-arm-candidate-de232-20260920.log`.
That is an independently measured method-`this` bridge residual, not a
candidate delta or a reason to expand this tag slice. The replacement positive
control keeps the finite computed write/key but calls an inspector that does
not read `this`; it validates bounded runtime-namespace projection admission
only and makes no descriptor-absence claim.

### 2026-09-20 corrected tag receipts

At source base `de232b80e43dc82c2fafc331cc10d658f26a8897`, the repaired focused
ESM fixture is 6/6 across GC and standalone; the standalone modules each have
zero actual `WebAssembly.Module.imports`. Its candidate receipt is
`/private/tmp/js2-3188-focused6-candidate-correction-de232-20260920.log`.

The maintained isolated Test262 runner then used the frozen four-path manifest
SHA-256 `760ad28e23bcc9c7cfb67b4984216e849fd246260215089956c77c397ac9a5d2`
against byte-identical corpus inputs in a pristine baseline and this candidate.
After separately building and canary-verifying a local QuickJS adapter in each
worktree from immutable artifact `073742801ba7`, the baseline is 4 semantic
fails and the candidate is 4 passes, zero non-passes:

- baseline: `/private/tmp/js2-3188-original4-baseline-provider-de232-20260920.log`
- candidate: `/private/tmp/js2-3188-original4-candidate-provider-de232-20260920.log`

The earlier missing-provider baseline receipt remains a setup-only record and
is not part of this comparison. These are four confirmed original F-to-P rows,
not a refreshed namespace or full-Test262 rate.

The replacement bounded runtime-namespace projection fixture, with the same
finite computed write/key on both pinned worktrees, is 2/2 on the baseline and
2/2 on the candidate:

- baseline: `/private/tmp/js2-3188-runtime-namespace-projection-baseline-de232-20260920.log`
- candidate: `/private/tmp/js2-3188-runtime-namespace-projection-candidate-de232-20260920.log`

It proves only callable-preservation through the admitted runtime projection;
it does not establish runtime-namespace `Symbol.toStringTag` descriptor
semantics. The candidate's full focused file is also 8/8:
`/private/tmp/js2-3188-focused8-candidate-de232-20260920.log`.

Out of scope: mutable `var`/`let` exports and live bindings; namespace
`[[GetOwnProperty]]` for export keys; delete/set/define/freeze behavior;
`Reflect.ownKeys` export ordering; dynamic-import namespace identity; and all
IR, context-layout, or runner changes. Those remain the larger #3188 slice 3
and #1089 work, not a reason to weaken this focused acceptance.

### Budget assessment

Against `de232b80e43dc82c2fafc331cc10d658f26a8897`, this source slice changes
`src/codegen/module-namespace-value.ts` from 720 to 766 lines and
`emitNamespaceObject` from 168 to 207 lines. Both remain below the
change-scoped 1,500-file and 300-function ceilings, so neither
`loc-budget-allow` nor `func-budget-allow` is justified; shared budget
baselines remain untouched.

## Acceptance criteria (umbrella)

1. ✅ Slice 1 landed (6 `top-level-await/syntax/*-obj-literal` records flip
   compile_error→pass; the misparse no longer swallows the wrapper's `test`
   export). Umbrella stays `ready` for slices 2-4.
2. Children filed for slices 2-4 with measured test lists.
3. `language/module-code` non-pass < 100 (from 174) as children land.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F5.
