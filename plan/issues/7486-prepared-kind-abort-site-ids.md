---
id: 7486
title: "Prepared: name each run-time kind abort (`js.value.unsupported`) by a site id, so a trap maps to its reason"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
depends_on: []
related: [7354]
---

# #7486 — Prepared: site ids for the run-time kind abort

## Problem

The ES5 Prepared census on main `6694a8b8`
(`plan/log/es5-prepared-census-2026-11-26.md`, "The 777 run-time failures, by
cause") has 777 files that compile and then trap with Wasm `unreachable`.

- **716** trap inside an abort body (#7354 U). The trap frame names the
  function, and `requiredPreparedAbortBodies(result)` names the refusal.
- **61** trap in the shared helper `__js_value_unsupported`, which is the
  run-time kind abort `js.value.unsupported` (#7354 C2). Example: a dynamic
  member read whose receiver turns out at run time to be a kind the realm
  cannot answer. The helper takes no argument and no record names the
  reason, so these 61 cannot be clustered.

Where the 61 are (census rows `.tmp/ir-census/fails-trap.jsonl`, worktree
`claude-es5-census-1119`, session scratch):

| directory | files |
|---|---:|
| built-ins/String/prototype | 42 |
| built-ins/Function/prototype | 8 |
| language/statements/function | 3 |
| language/types/string | 2 |
| six other single files | 6 |

Example: `built-ins/String/prototype/trim/15.5.4.20-2-44.js`. The likely
reason is the string arm of `memberAccess`: "member read 'trim' of a string
needs String.prototype's properties". This issue makes the census say so
instead of guessing.

## Implementation Plan

### Mechanism (chosen: a site id stored in an exported global)

The helper takes an i32 site id, stores it in a mutable global and then
traps. The global is exported, and after the trap the census reads it from
the instance. The id is the site's ordinal **within its calling function**,
and the trap's second stack frame names that function. So the row key is
(caller name, ordinal).

Options compared:

| option | cost | verdict |
|---|---|---|
| (a) i32 id + `global.set` + `unreachable`, exported global | One param on the one helper, one global, one export. Each piece already has a sibling: a resource global (`native-promises.ts`, `space: "global"`) and a resource export (`native-string-output.ts` `publishNativeStringOutput`). | **chosen** |
| (b) one named abort function per site or per reason | The manifest binds an intrinsic to one canonical provider resource (`nativeIntrinsicAbiBindings`, `native-primitive-boundary-abi.ts`), and `ROWS` is a fixed table. Per-use binding would be a new mechanism with one user. It also adds a function to the module per reason. | rejected |
| (c1) no run-time change, attribute by the caller frame only | Ambiguous: module-init holds many sites with different reasons (every dynamic member read has its own). | rejected |
| (c2) i32 id with no global; the census decodes the `i32.const` before the `call` at the caller frame's byte offset | The census would parse Wasm bytes, and any change to where operands are placed would break it. | rejected |
| (a') program-wide ids instead of per-function ordinals | Needs a registry threaded through the producer, and a truncate step in `AbortBodies.lower`'s retry beside `allocations.truncate`. The ids would also depend on whether the abort policy is on. A per-function counter is a pure function of the IR being legalized. | rejected |

### Wasm shape after the change

```wat
(global $__js_value_unsupported_site (export "__js_value_unsupported_site") (mut i32) (i32.const -1))
(func $__js_value_unsupported (param i32) (result (ref $AnyString))
  local.get 0
  global.set $__js_value_unsupported_site
  unreachable)
;; a site in $g, today: call $__js_value_unsupported
i32.const 0            ;; the site's ordinal in $g
call $__js_value_unsupported
```

The global, the export and the param exist only when
`selection.unsupported` holds (`selectNativeDynamicValues`). So a Prepared
program with no kind abort is byte-identical to today's output.

### Target structure: what changes, where, and what it reuses

No new module. Every change sits beside the sibling it mirrors.

1. **`src/ir/core/intrinsics.ts`**: rename `NULLARY_TO_STRING_INTRINSIC_SIGNATURE`
   (its only user is `js.value.unsupported`) to
   `I32_TO_STRING_INTRINSIC_SIGNATURE` and change it in place
   (`params: [I32_TYPE]`).
   - Unchanged: the id in `intrinsic-vocabulary.ts`,
     `runtime/contracts/intrinsics.ts`, `manifest.ts` and
     `dynamic-value-callables.ts` (`SYMBOLS`). The provider reads its
     signature from `INTRINSIC_DEFINITIONS`, and `canonicalRow` binds by
     feature.
2. **`src/backend/wasmgc/resources/native-dynamic-values.ts`**:
   - `ROWS` `unsupported`: `params: [I32]`.
   - `declareNativeDynamicValueResources`: under `selection.unsupported`,
     add one global row (`role: ["values", "unsupported-site"]`,
     `space: "global"`, i32, mutable), in the shape of
     `native-promises.ts:114`.
   - `NativeDynamicValueReservations.unsupportedSite`.
   - `fillNativeDynamicValueResources`: give the global its `-1` init, and
     fill the helper with the body above.
   - New `publishNativeDynamicValues(tx, pack)`: calls
     `tx.defineExport(..., UNSUPPORTED_SITE_EXPORT, pack.unsupportedSite)`,
     in the shape of `publishNativeStringOutput`.
3. **`src/backend/wasmgc/program/native-string-values.ts`**:
   - `publishNativeStringValues` calls `publishNativeDynamicValues` next to
     `publishNativeStringOutput`.
   - New `nativePublishedExportNames(plan)`: returns the stdout pair plus the
     site export when `plan.dynamicValues?.unsupported`.
4. **`src/ir/program-physical-plan.ts:1386`**: the inline
   `["__stdout_prepare", "__stdout_char"]` literal becomes
   `nativePublishedExportNames(native.plan)`, in place. A source export with
   the same name then stays a planning gap, not an emission crash. Net 0
   lines: the file is at 1,510, over the 1,500 ceiling, so it must not grow.
5. **`src/ir/program/dynamic-value-chains.ts` `chainBuilders`**:
   - Add a `sites: string[]` counter beside `valueCount`.
   - `abortText(instr, reason, r)`: `i32.const <sites.push(reason) - 1>`,
     then the intrinsic into the string `r`.
   - `abort(instr, reason, r)`: `abortText` into a fresh value, then
     `carried`.
   - `i32(value, r)`: the const that `selectorCall` already spells inline;
     `selectorCall` uses it too.
   - Expose `abortSites: () => sites`.
   - **Removes a duplicate**: `conversionBuilders`' local `unsupported` (a
     second spelling of the intrinsic) is deleted. `toStringArm` uses
     `abortText`, and `primitiveOf` uses `abort`.
6. **The sites pass reasons.** Each call below gains its reason text. The
   wording follows the refusal wording beside each site; the implementer
   pins the exact text from a run.

| site (file: function) | reason |
|---|---|
| dynamic-member-access.ts: `memberAccess`, refused-kind arm | `${operation} of ${article(kind)} needs ${missing(kind)}`, e.g. "member read 'trim' of a string needs String.prototype's properties". One formatter, shared with the compile-time `gap` beside it (today built inline). |
| dynamic-member-access.ts: `dynamicMemberRead` `object` arm (`js.object.has` miss) | "member read '${name}' of an object without it: only Object.prototype's own, which the realm lacks, answers" |
| dynamic-value-chains.ts: `conversionBuilders` `builtinOnly` | "ToPrimitive of an object whose method is a built-in, in a program that creates no function value" |
| dynamic-value-chains.ts: `toStringArm` / `primitiveOf`, `source === undefined` | "ToString of a function: its source text, which the closure does not carry" (for `+`: "`+` of a function: …") |
| dynamic-function-operations.ts: `dynamicCurrentThis` | "sloppy `this` that is not an object: needs the global object or a wrapper" |
| dynamic-function-operations.ts: `dynamicConstruct` `builtin` / `link` | "`new` on a built-in function the realm holds" / "`new` whose callee's 'prototype' is ${article(kind)}, not an ordinary object" |
| dynamic-object-statics.ts: `defineAll`, `getOwnPropertyDescriptor`, `create` | "Object.${name} of a string: needs the String object's own properties" / "Object.create with ${article(kind)} prototype" |
| dynamic-error-constructors.ts: `functionChainAnswer` | "a function's [[Prototype]] walk for %Error%" (wording from the doc comment there) |
| dynamic-prototype-methods.ts: `ownProperty` | "Object.prototype.${method} on a string: needs its own length and index properties" |

   - `MemberAccessBuilders.abort` and the `Abort` type take the reason, so
     the `object` arm passes its own.

7. **`src/ir/program/dynamic-value-legalization.ts` `legalizeDynamicValues`**:
   - Returns `{ fn, abortSites }`. An unchanged function has `[]`.
   - The 7 test call sites read `.fn`: x-dynamic-throw ×5, t-truthiness-null,
     d1-dynamic-carrier.
8. **`src/ir/source-dynamic-contracts.ts`**:
   - `RefusalOwners` (already the abort-bodies seam) gains
     `abortSites(fn, reasons)`.
   - `legalizeSourceDynamicValues` calls it per legalized function with
     sites.
9. **`src/ir/program-source-units.ts` `lowerUnitOnce`**: the owners object
   gets `abortSites: (fn, reasons) => abortBodies?.recordSites(fn, reasons)`,
   beside `aborted`.
10. **`src/ir/abort-bodies.ts`** (the one record of what a trap stands for):
    - `AbortBodyRow` becomes
      `AbortRow = { kind: "body", unit, name, line, column, code, detail } | { kind: "site", unit, name, site, detail }`.
    - `recordSites` keeps the reasons in a private `WeakMap<IrFunction, …>`
      keyed by the legalized function object.
    - `report(functions, …)` adds the site rows of the accepted functions in
      lowering order, module-init included. It runs only on the accepted
      lowering, so a refused attempt of `lower` leaves no row.
    - `rows()` returns body rows in source order, then site rows.
11. **`src/test262/test262-prepared-entry.ts`**:
    - Rename `ResultRecord.abortBodies` to `aborts`, and
      `requiredPreparedAbortBodies` to `requiredPreparedAborts`: one
      accessor, the same road.
    - Its 10 readers in `tests/` and the census are renamed. The
      `abortBodies` test helper (`tests/helpers/prepared-node-agreement.ts`)
      filters `kind === "body"`.
12. **Census** (`scripts/ir-census/prepared-census.mts` `trapOf`, which lands
    with PR #7436, branch `claude/census-trap-frames`; this step stacks on
    it):
    - `measureFile` hoists `instance` so `trapOf` can read it.
    - For a frame of `__js_value_unsupported`, read
      `instance.exports.__js_value_unsupported_site.value` and the second
      frame, then find the `site` row with that name and site.
    - Emit `abort: { code: "js.value.unsupported", detail }` exactly as for a
      body, so `prepared-analyze.mjs` clusters both without change.

### Why JS-environment (gc) output stays byte-identical

From code, three facts:

1. Only the builders in `src/ir/program/dynamic-value-chains.ts` emit
   `js.value.unsupported`. They are reached only from
   `legalizeDynamicValues`, whose only production caller is
   `legalizeSourceDynamicValues` (`source-dynamic-contracts.ts`), part of the
   Prepared producer (`prepareIrProgramSources`). The ordinary pipeline
   (legacy and the selector IR) never builds it.
2. `legalizeSourceDynamicValues` returns early unless `nativeDynamicLane(policy)`
   holds. `dynamicLane` returns `"native"` only for
   `backend === "wasmgc" && target === "standalone"`.
3. The provider (`dynamic-value-callables.ts`) declares
   `supportedTargets: ["standalone"]`.

So the gc and ordinary-standalone outputs cannot change. Among Prepared
standalone outputs, only programs with a site change.

### Tests

1. **Smallest program, through the strict Prepared entry** (`compile` from
   `test262-prepared-entry.ts`, `preparedOptions()`):
   `function g(v){ return v.trim(); } g({ trim: function(){ return 1; } }); g(" a ");`
   - The program compiles: the object arm answers, so there is no
     compile-time refusal.
   - It traps in `__js_value_unsupported`.
   - The exported global reads `0`, and the second frame is `g`.
   - `requiredPreparedAborts` holds
     `{ kind: "site", name: "g", site: 0, detail: "member read 'trim' of a string needs String.prototype's properties" }`.
   - Extend `abortsAtRunTime` to take an optional expected reason and assert
     it through the same lookup the census uses.
2. **Two sites in one function**, the second taken: the global reads `1`. The
   DCE hazard: the module validates and the id survives.
3. **Retry**: a unit where one function gets an abort body and another holds
   a site. The site row is reported once, with ordinal 0.
4. **Byte identity**:
   - `node scripts/equivalence-gate.mjs` (gc).
   - A test that compiles a program with a dynamic member read for gc and for
     ordinary standalone, and compares the bytes against a base build. Take
     the base copy at the first edit, per CLAUDE.md's `.tmp/base.ts` rule.
   - A Prepared standalone program with no site is byte-identical before and
     after.
5. **Update the pinned row**:
   `tests/issue-3526-string-boundary-const.test.ts` lists
   `native.js.value.unsupported` among the empty-param providers; it now has
   one param.

### Acceptance criteria

- Every one of the 61 census rows with `trapFrame: "__js_value_unsupported"`
  carries an `abort.detail` from a site row. Re-run on main + this change.
- `prepared-analyze.mjs` clusters them by reason, and the census log's row 5
  is replaced by those clusters.
- No test262 verdict changes: a trap stays a trap.
- JS-environment (gc) and ordinary standalone output are byte-identical.
  Prepared output changes only in programs with a kind abort.
- **Code quality**:
  - One abort builder: the `unsupported` duplicate is gone.
  - One record type and one accessor for body and site aborts.
  - Member-access refusal text is formatted once, for the gap and the abort.
  - `selectorCall` and the abort share the i32 const.
  - The resource global and the export follow their existing siblings' shape.
  - No new module, no `loc-budget-allow` or `func-budget-allow`.
  - An adversarial review (CLAUDE.md) finds no duplicate or misplaced arm.

### Hazards

1. **Dead-code elimination of a pure intrinsic.** `abort`'s comment says the
   intrinsic is pure, so an unused result would be dropped. It survives
   because `isSideEffecting` (`src/ir/analysis/effects.ts` ~533) keeps
   `js.value.unsupported`. Being in that list also keeps its operands live
   (see the `super_init` and `dyn.member_set` notes there), so the new i32
   const survives. Test 2 proves it.
2. **Effects ordering.** The effect facet stays pure, so a scheduler may
   reorder two aborts on one straight-line path, and the global would then
   name the other one. No builder emits two on one path: each sits in its own
   `if` arm. Test 2 asserts the id of the arm taken.
3. **Retry in `AbortBodies.lower`.** Sites are keyed by the legalized
   function object and reported only from the accepted lowering. Test 3.
4. **Units without the policy.** Native async families and certified Promise
   delays bypass `AbortBodies` (`lowerSourceUnit`), so they record no sites.
   Their traps stay unattributed. The acceptance run counts any such row.
5. **The dispatcher's built-in arm** (`closure-method-body.ts`) is a raw
   `unreachable`. Its trap frame is the dispatcher, not the helper, so it is
   not among the 61 and is out of scope.
6. **Budgets.**
   - `program-physical-plan.ts` is over the ceiling, so step 4 must be net 0
     lines.
   - `dynamic-value-chains.ts` (476 lines) has to absorb the deleted duplicate.
   - `memberAccess` and `conversionBuilders` grow by a few lines, far below
     300.
   - Run the gates with `LOC_GATE_BASE` set to the upstream tip.
