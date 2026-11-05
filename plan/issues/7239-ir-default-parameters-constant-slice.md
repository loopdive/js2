---
id: 7239
title: "IR: admit parameters with a compile-time-constant default (functions and class members)"
status: ready
sprint: current
created: 2026-11-05
updated: 2026-11-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [869, 1372, 7233, 2949]
assignee: "ttraenkler/c-lead"
---

# #7239: default parameters still force the legacy path

## Problem

`src/ir/select.ts` refuses every parameter that has an initializer with
`param-shape-rejected`, whether the parameter is an identifier or a binding
pattern. #1372 (done) admitted plain destructured parameters, but not
defaults.

On the stride-40 standalone ledger (main `6a89ad6534`):
- `select:param-shape-rejected` accounts for 22 units;
- after #7233, default/destructured parameters are the first refusal for 18
  class-member units.

Legacy already has two default mechanisms:
- **#869 constant defaults.** A numeric, boolean, `null` or `undefined`
  literal, or a folded constant. `extractConstantDefault` /
  `foldConstantNumericDefault` in `src/codegen/index.ts` resolve these so a
  missing argument takes the constant.
- **Runtime defaults.** `paramDefaultNeedsArgc`, `param-tdz.ts`, and
  `paramDefaultsReferenceArguments` handle these with an argument count and
  TDZ checks.

## Implementation Plan (C lead, 2026-11-05; implement on Opus)

1. **Measure and attribute first.**
   - Instrument a throwaway copy of the refusal at `select.ts` (~L2173 and
     L2199). Do not commit it.
   - Classify every stride unit refused for an initializer:
     - constant default (the #869 forms);
     - non-constant default (call, identifier, `this`, an earlier parameter);
     - rest parameter;
     - optional `?`;
     - default inside a binding pattern.
   - For the constant class, find where legacy supplies the constant: at the
     call site (the caller pushes the constant for a missing argument) or in
     the callee (sentinel test plus argc).
   - Write the answer down in this file before coding. The rest of the plan
     depends on it.
2. **Slice: constant defaults only**, on identifier parameters with a type
   the IR already resolves (number, boolean, string literal if legacy folds
   it).
   - **If the caller fills the constant:** the IR body can treat the
     parameter as an ordinary parameter. Admit it in the selector, keep the
     function's signature and ABI byte-identical to legacy, and make sure
     every IR call site that omits the argument emits the same constant.
     Route this through the existing call-lowering helper; do not write a
     second copy of the fold.
   - **If the callee tests a sentinel or argc:** emit the same test in the IR
     body through the existing `paramDefaultNeedsArgc` contract, or refuse
     and report back. Do not invent a new ABI.
   - The slice applies to plain functions, class methods, static methods and
     constructors alike. Each placement must pass its existing ABI-parity
     guard (#1370 for class methods).
3. **Stays on legacy:**
   - non-constant defaults (TDZ, `arguments`, earlier-parameter references);
   - rest parameters;
   - defaults inside binding patterns;
   - `async` and generator functions;
   - anything whose missing-argument value is `undefined` in a non-nullable
     slot.
4. **Do not touch** `dynamicUsesAreMoveOnly` (#2949; coordinate on #6583),
   or the getter-callable files of the Shepherd's in-flight repair:
   `class-bodies.ts`, `closures/method-trampolines.ts`,
   `program-abi-class-callable-planning.ts`, `method-receiver-this.ts`,
   `property-access-exact-shapes.ts`. If the #869 contract lives in one of
   those files, read it, but do not edit it.
5. **Never worse than legacy.** Every newly claimed unit must give the
   legacy-observable result on gc, standalone and wasi. Probe:
   - calls with and without the argument, an explicit `undefined`, and `null`;
   - `f.length`;
   - `.call`, `.apply` and spread calls;
   - a default overridden by `NaN` or `-0`;
   - methods called through subclasses and as values;
   - mixed IR and legacy callers of the same function.

## Step 1 findings (Opus, 2026-11-05) — slice NOT implemented, needs re-scoping

Measured on this branch's base (`bf60bb81a4`, includes #7233), stride 40,
standalone (`scripts/ir-claim-ledger.mts`): 1340 files, 1720 units — ir 38,
both 25, legacy 1620, neither 37; invariants 0; compileOk 1081;
`select:param-shape-rejected` = **22**. Every unit whose function has a
default / rest / `?` / pattern parameter was attributed by a throwaway probe
(test262 stride, `trackIrOutcomes`, matched to its declaration by line; not
committed).

**`select:param-shape-rejected` (22):**

| Class | Units | Where |
| --- | --- | --- |
| optional `?` | 8 | all compiler prelude: `__js2wasm_Iterator_zip` / `_zipKeyed` (`options?: any`), 4 files each |
| rest | 5 | prelude `__js2wasm_Iterator_concat(...items)` ×4; `rest-parameters-apply.js` |
| default on a binding pattern (`[a] = …`, `{p} = …`) | 6 | `function/dstr/dflt-*` ×3, Temporal `createOptionsObserver` ×2, one generator |
| non-constant default | 2 | `arguments-with-arguments-lex.js` (sync), `generators/dflt-params-ref-prior.js` |
| duplicate parameter name | 1 | `param-duplicated-strict-1.js` |
| **constant default on an identifier (#869 forms)** | **0** | — |

**Class members with such a parameter** (first refusal
`class-member-unsupported`, 41 units): 39 are patterns (outer default or
default inside the pattern; about half in generator/async-generator methods).
The only two constant defaults are `x = 39` in an async-generator method
(stays legacy by rule 3) and `x = null` in a static method, where the slot is
externref — `extractConstantDefault` returns nothing for ref slots, so legacy
treats it as an expression default (rule 3: not this slice).

No unit refused for any *other* reason carries an identifier constant
default either, so lifting every other blocker would still not reach one. The
playground population has no parameter refusals at all. A regex over all of
test262 finds ~200 files with an identifier numeric/boolean default, most in
async, generator, or expression-position functions.

**Where legacy supplies the constant: both sides.** Probe of
`function f(x: number = 5)` called as `f()` and `f(2)` (standalone WAT):
- caller: pushes `f64.const 5` for the missing argument **and** publishes
  `__argc` (`i32.const 0; global.set $__argc`) — also on the full call
  (`i32.const 1`), via `maybeSetArgcForKnownCall`;
- callee (`function-body.ts`, `cacheParamDefaultArgc` +
  `emitParamDefaultArgMissingCheck` + `emitF64ParamSentinelCheck`): reads and
  clears `__argc` at entry, then `(argc != -1 && argc <= i) || bits(x) ==
  sNaN-sentinel` → `x = 5`. The callee test is required because first-class
  and dynamic callers (`.call`, method values, trampolines) cannot inline the
  constant.

So an IR body for such a function must emit the callee test. That needs a new
IR instruction that reads and clears `__argc` (the existing
`dyn.arguments_length` wrapper also consumes `__extras_argv`, which legacy's
default prologue does not), a host-free helper beside
`src/codegen/ir-arguments-length.ts`, and its verify/lowering arms. That is the
existing `paramDefaultNeedsArgc` contract, not a new ABI, and it is
standalone/wasi-only (gc has no IR argc protocol and stays legacy).

**Decision: stopped before coding.** The constant slice is buildable without a
new ABI or a forbidden file, but it reaches **0** units on the stride ledger,
so the first acceptance criterion (IR units rise, `param-shape-rejected`
falls) cannot be met by it. Options for the lead:
1. **Optional `?` on a dynamic (`any`) slot** — 8 units/stride, all prelude.
   A missing argument is already `undefined` from every caller (the IR's
   `importedMissingArgument` pads `__get_undefined`), so no callee prologue is
   needed if the body treats the parameter as an ordinary dynamic one. Check
   the prelude's IR claimability past this refusal first.
2. **Rest parameters** — 5 units/stride (4 prelude).
3. **Defaults on binding patterns** — the largest class (6 function + 39
   class-member units), but it overlaps the generator lanes and needs the
   pattern-default machinery.
4. Keep this constant slice only if typed-corpus value justifies an IR
   argc-read instruction with no ledger gain.

## Re-scope probe: optional `?` and rest (Opus, 2026-11-05) — no stride gain, not built

Coordinator re-scoped this issue to option 1 (`?` on a dynamic slot), then
option 2 (rest). Probe-first: a throwaway `select.ts` (identifier-parameter
`?` and `...` refusals bypassed under an env flag, never committed) over the
same stride-40 standalone ledger:

| | IR | both | legacy | neither | compileOk | `param-shape-rejected` | `body-shape-rejected` | `param-type-not-resolvable` | invariants |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base `bf60bb81a4` | 38 | 25 | 1620 | 37 | 1081 | 22 | 1106 | 45 | 0 |
| probe (`?` + rest admitted) | 38 | 25 | 1620 | 37 | 1081 | 9 | 1118 | 46 | 0 |

Every unblocked unit hits another selector refusal at once, so IR units do
not move:
- `__js2wasm_Iterator_zip` / `_zipKeyed` (8 units, `options?: any`) →
  `body-shape-rejected`, detail `vardecl-typenode:AnyKeyword`
  (`let paddingOption: any = undefined`). Behind that the bodies also use
  `try/catch` inside loops, `Object.keys`, `for…of` over `any`, and method
  calls on `any` carriers, so admitting `: any` locals alone is unlikely to be
  enough.
- `__js2wasm_Iterator_concat` (4 units, `...items: any[]`) →
  `body-shape-rejected`, same `vardecl-typenode:AnyKeyword` first.
- `rest-parameters-apply.js` `af(...a)` → `param-type-not-resolvable`
  (`param-dynamic-carrier-diverges-from-legacy`).

So neither slice is built. Legacy's caller fill for `?` and its rest-array
construction were not investigated further, because the probe already shows
no gain. The next lever for these 13 units is the prelude-body shape
(`: any` local annotations first), not parameter admission.

## Acceptance criteria

- **Ledger A/B** (stride 40, standalone) in the PR body: IR units rise;
  `param-shape-rejected` falls; 0 invariants; `compileOk` is not lower.
- **Typed corpus:** byte-identical on gc, standalone and wasi, or every
  changed binary is explained and correct.
- **test262 A/B** on the route-changed files plus a sample: no test that
  passes on base fails on head (standalone).
- **Test:** `tests/equivalence/issue-7239-ir-default-parameters.test.ts` asserts,
  for each placement, the IR route (`trackIrOutcomes`) and the node/base
  result on 3 lanes.
