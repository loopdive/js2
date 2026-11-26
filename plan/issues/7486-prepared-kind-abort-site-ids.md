---
id: 7486
title: "Prepared: name each run-time kind abort (`js.value.unsupported`) by a site id, so a trap maps to its reason"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
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

### Mechanism (chosen: a program-wide site id in an exported global, diagnostic builds only)

- **Site ids.** Each kind-abort site gets a program-wide id (0, 1, 2, …),
  minted when the site is built. The `AbortBodies` record keeps the ids, and
  its retry truncates them exactly as it truncates `allocations`.
- **Diagnostic build only.** Only where that record exists (the test262
  Prepared entry, which the census uses), the site calls a second intrinsic,
  `js.value.unsupported_at(i32)`. Its helper stores the id in an exported
  mutable global `__js_value_unsupported_site` and traps.
- **Every other build is unchanged**: the nullary `js.value.unsupported`, no
  param, no global, no export.
- **The census keys on the global** (`!= -1`), never on frame names. A copy of
  a site made by the middle end (`inlineSmall`, a `monomorphize` clone) or by
  Binaryen `-O` carries the same id, and so the same reason.

Options compared:

| option | cost | verdict |
|---|---|---|
| (a) i32 id + `global.set` + `unreachable`, exported global, program-wide id, gated by the intrinsic the legalization picks | One vocabulary row and one resource row beside their siblings. The global copies `native-promises.ts`; the export copies `publishNativeStringOutput`. No backend option. | **chosen** |
| (a1) per-function ordinals, keyed by the caller frame (round 0) | Breaks after legalization: see Review round 1, point 1. | rejected |
| (a2) gate by a new `PreparedIrBackendOptions` flag | The flag has to travel through `compiler.ts` (2,198 lines), `program-physical-plan.ts` (1,510) and `program-consumer.ts`, all over the 1,500 ceiling, plus the consumer's option validation. The IR intrinsic gates with no plumbing: the backend selects resources by demand, as it does for every other intrinsic. | rejected |
| (b) one named abort function per site or per reason | Needs per-use binding of one intrinsic to N resources (`nativeIntrinsicAbiBindings`), a new mechanism with one user. | rejected |
| (c1) caller frame only | Ambiguous: module-init holds many sites. | rejected |
| (c2) decode the `i32.const` from the binary at the frame's offset | The census would parse Wasm bytes. | rejected |

### Wasm shape

Plain build, every compile but the test262 Prepared entry: byte-identical
to today.

```wat
(func $__js_value_unsupported (result (ref $AnyString)) unreachable)
call $__js_value_unsupported
```

Diagnostic build (the test262 Prepared entry, `unlowerableBodies: "abort"`):

```wat
(global $__js_value_unsupported_site (export "__js_value_unsupported_site") (mut i32) (i32.const -1))
(func $__js_value_unsupported_at (param i32) (result (ref $AnyString))
  local.get 0
  global.set $__js_value_unsupported_site
  unreachable)
i32.const 17           ;; the site's program-wide id
call $__js_value_unsupported_at
```

The nullary helper is not demanded in a diagnostic build, so it is not
declared there.

### Target structure: what changes, where, and what it reuses

No new module. Every change sits beside the sibling it mirrors.

1. **The intrinsic, beside `js.value.unsupported`.** One row in each
   exhaustive table:
   - `core/intrinsic-vocabulary.ts`: the id.
   - `core/intrinsics.ts`:
     - the definition, with a new `I32_TO_STRING_INTRINSIC_SIGNATURE` next to
       the nullary one;
     - `RUN_TIME_ABORT_INTRINSICS`, the set of both ids.
   - `runtime/contracts/intrinsics.ts`: `DYNAMIC_VALUE_RUNTIME_FEATURES`.
   - `runtime/contracts/manifest.ts`: `DYNAMIC_VALUE_RUNTIME_PROVIDER_IDS`.
   - `runtime/dynamic-value-callables.ts`: `SYMBOLS`,
     `__js_value_unsupported_at`.
   - `backend/wasmgc/program/native-primitive-boundary-abi.ts`: one
     `canonicalRow`.
   - **`analysis/effects.ts:536`**: the keep rule reads
     `RUN_TIME_ABORT_INTRINSICS` in place. One predicate, and it keeps
     operands live: see Hazards.
2. **`backend/wasmgc/resources/native-dynamic-values.ts`**:
   - `selectNativeDynamicValues`: `unsupportedAt`.
   - `ROWS`: `["unsupportedAt", "unsupported-at", "__js_value_unsupported_at", { params: [I32], results: ["any-string"] }]`.
   - `declareNativeDynamicValueResources`: under `unsupportedAt`, one global
     row (`role: ["values", "unsupported-site"]`, i32, mutable), in the shape
     of `native-promises.ts:114`.
   - The fill step: init the global to `-1`, and fill the helper with the
     body above.
   - New `publishNativeDynamicValues(tx, pack)`: `tx.defineExport` of the
     global, in the shape of `publishNativeStringOutput`.
3. **`backend/wasmgc/program/native-string-values.ts`**:
   - `publishNativeStringValueOutput` calls `publishNativeDynamicValues` next
     to `publishNativeStringOutput`.
   - New `nativePublishedExportNames(plan)`: the stdout pair, plus the site
     export when `plan.dynamicValues?.unsupportedAt`.
4. **`ir/program-physical-plan.ts:1386`**:
   - The inline stdout literal becomes `nativePublishedExportNames(native.plan)`
     in place, net 0 lines.
   - In a diagnostic build, a source export of that name is a planning gap,
     not an emission crash. No test262 file exports it.
5. **`ir/program/dynamic-value-chains.ts` `chainBuilders(fn, …, site)`**:
   - `abortText(instr, reason, r)` asks `site(reason)`:
     - `undefined` (no record): the nullary intrinsic into `r`, as today;
     - an id: `i32(id, k)` and then `js.value.unsupported_at` with `[k]`.
   - `abort(instr, reason, r)`: `abortText` into a fresh value, then `carried`.
   - `i32(value, r)`: the const that `selectorCall` already spells inline;
     `selectorCall` uses it too.
   - **Duplicate removed**: `conversionBuilders`' local `unsupported` is
     deleted.
6. **The sites pass reasons.** Same table as round 0. The wording follows
   the refusal wording beside each site; the implementer pins the exact text
   from a run.

| site (file: function) | reason |
|---|---|
| dynamic-member-access.ts: `memberAccess`, refused-kind arm | `${operation} of ${article(kind)} needs ${missing(kind)}`, one formatter shared with the compile-time `gap` beside it |
| dynamic-member-access.ts: `dynamicMemberRead` `object` arm (`js.object.has` miss) | "member read '${name}' of an object without it: only Object.prototype's own, which the realm lacks, answers" |
| dynamic-value-chains.ts: `conversionBuilders` `builtinOnly` | "ToPrimitive of an object whose method is a built-in, in a program that creates no function value" |
| dynamic-value-chains.ts: `toStringArm` / `primitiveOf`, `source === undefined` | "ToString of a function: its source text, which the closure does not carry" (for `+`: "`+` of a function: …") |
| dynamic-function-operations.ts: `dynamicCurrentThis` | "sloppy `this` that is not an object: needs the global object or a wrapper" |
| dynamic-function-operations.ts: `dynamicConstruct` `builtin` / `link` | "`new` on a built-in function the realm holds" / "`new` whose callee's 'prototype' is ${article(kind)}, not an ordinary object" |
| dynamic-object-statics.ts: `defineAll`, `getOwnPropertyDescriptor`, `create` | "Object.${name} of a string: needs the String object's own properties" / "Object.create with ${article(kind)} prototype" |
| dynamic-error-constructors.ts: `functionChainAnswer` | "a function's [[Prototype]] walk for %Error%" |
| dynamic-prototype-methods.ts: `ownProperty` | "Object.prototype.${method} on a string: needs its own length and index properties" |

7. **`ir/program/dynamic-value-legalization.ts`**:
   - `legalizeDynamicValues(fn, allocations, program, site = NO_SITE)` passes
     `(reason) => site(fn, reason)` to `chainBuilders`.
   - Test callers omit the new parameter and keep the plain form, so their
     return type and call sites are unchanged.
8. **`ir/source-dynamic-contracts.ts`**:
   - `RefusalOwners` (already the abort-bodies seam) gains
     `abortSite(fn, reason): number | undefined`.
   - `legalizeSourceDynamicValues` passes it.
9. **`ir/program-source-units.ts` `lowerUnitOnce`**: the owners object gets
   `abortSite: (fn, reason) => abortBodies?.site(fn, reason)`, beside
   `aborted`.
10. **`ir/abort-bodies.ts`**:
    - `AbortBodies` gains `#sites: AbortSiteRow[]`, where
      `AbortSiteRow = { unit, name, site, detail }`.
      - `name` is the function the site was legalized in.
      - `name` and `detail` have the same shape as `AbortBodyRow`, so the
        census renderer reads either.
    - `site(fn, reason)` returns `#sites.length` and pushes the row.
    - `lower` marks `#sites.length` beside `allocations.size` and truncates
      both on retry. Ids stay dense and deterministic: inventory order, then
      legalization order.
    - `sites()` returns the rows by id.
11. **`test262/test262-prepared-entry.ts`**:
    - `ResultRecord.abortSites`, filled from the same `AbortBodies` as
      `abortBodies`.
    - A sibling accessor `requiredPreparedAbortSites`.
    - `requiredPreparedAbortBodies` and its ~25 references are untouched.
12. **Census** (stacks on PR #7436, branch `claude/census-trap-frames`, head
    `00c971be`):
    - `scripts/lib/wasm-exn-render.mjs`: new `abortSiteOf(instance, rows)`
      reads `instance?.exports.__js_value_unsupported_site?.value` and
      returns the row with that id when it is `>= 0`.
    - `wasmErrorSite(err, abortBodies, abortSite)` returns it as `aborted`,
      ahead of the frame-name match. `renderHostError` takes the same third
      argument, so there is one lookup.
    - `prepared-census.mts`:
      - `measureFile` hoists `instance`;
      - `trapOf` passes `abortSiteOf(instance, requiredPreparedAbortSites(result))`;
      - the row gains `siteFrame` (the first frame that is not the helper),
        for the contradiction check below.

### Why JS-environment (gc) output and plain Prepared output stay byte-identical

1. Only the builders in `ir/program/dynamic-value-chains.ts` emit either
   intrinsic. They are reached only from `legalizeDynamicValues`, whose only
   production caller is `legalizeSourceDynamicValues`
   (`source-dynamic-contracts.ts`), part of the Prepared producer
   (`prepareIrProgramSources`). The ordinary pipeline never builds them.
2. `legalizeSourceDynamicValues` returns early unless
   `nativeDynamicLane(policy)` holds. `dynamicLane` returns `"native"` only
   for `backend === "wasmgc" && target === "standalone"`.
3. Both providers declare `supportedTargets: ["standalone"]`
   (`dynamic-value-callables.ts`).
4. Without an `AbortBodies` record, `site` answers `undefined` and the
   builder emits today's nullary intrinsic. So every Prepared compile other
   than the test262 Prepared entry is unchanged, including the public
   `prepared-program-required` front door.
5. **The CI Prepared lane is the one build that changes.** It compiles
   through the test262 Prepared entry (`TEST262_COMPILER_PATH=ir`, front door
   `prepared-program-required`, default `unlowerableBodies: "abort"`), so its
   bytes change for every program with a kind-abort site: the
   `js.value.unsupported_at` helper, the `__js_value_unsupported_site`
   global and its export replace the nullary helper. Its verdicts do not
   change: the site still traps with `unreachable` where it trapped before,
   and the global is read only by the census.

### Tests

1. **Smallest program, through the strict Prepared entry**:
   `function g(v){ return v.trim(); } g({ trim: function(){ return 1; } }); g(" a ");`
   - It traps.
   - The exported global reads the id of the string arm's site.
   - `requiredPreparedAbortSites(result)[id]` is
     `{ name: "g", detail: "member read 'trim' of a string needs String.prototype's properties" }`.
   - `abortsAtRunTime` gains an optional expected reason, asserted through
     `abortSiteOf`, the census's own lookup.
2. **An inlined copy.**
   - A ≤10-instruction single-block callee with a straight-line abort
     (`dynamicConstruct`'s `builtin` arm, dynamic-function-operations.ts:126)
     is called from module-init.
   - The trap's frame is the caller, but the global still names the callee's
     site and reason. This pins the round-1 blocker.
   - Also a `monomorphize` clone: the same id reaches its row.
3. **Retry.** A unit where one function gets an abort body and another holds
   a site: ids are dense from 0, and no row is left over from the refused
   attempt.
4. **Byte identity.**
   - `node scripts/equivalence-gate.mjs` (gc).
   - gc and ordinary standalone bytes of a program with a dynamic member read
     against a base build. Take the base copy at the first edit (CLAUDE.md
     `.tmp/base.ts`).
   - A Prepared compile without the record (the public front door) of a
     program WITH a site is byte-identical to today.
5. **DCE.** Two sites, the second taken: the module validates and the global
   reads the second id.

### Acceptance criteria

- **The gated build** is `scripts/ir-census/prepared-census.mts --harness real`
  through `src/test262/test262-prepared-entry.ts` with its default
  `unlowerableBodies: "abort"`. That is the only build with the export.
  Re-run on main + this change.
- All 61 rows with a trap in the kind-abort helper carry `abort.detail` from
  a site row (global `!= -1`).
- `prepared-analyze.mjs` clusters them by reason, and the census log's row 5
  is replaced by those clusters.
- **Frame contradictions: 0.** A contradiction is a site row whose
  `siteFrame` is neither the recorded function nor a copy of it made by the
  middle end (`inlineSmall` into a caller, a `monomorphize` clone). The run
  lists every copy case with the WAT line that shows the inlined call or the
  clone.
- No test262 verdict changes.
- gc output and plain Prepared output are byte-identical.
- **Code quality**:
  - One abort builder (`abortText` / `abort`); the `unsupported` duplicate is
    gone.
  - The diagnostic form is a parameter of that builder, not a second arm.
  - The keep rule reads one set.
  - Member-access refusal text is formatted once, for the gap and the abort.
  - `selectorCall` and the abort share the i32 const.
  - The global, the export, the intrinsic row and the resource row follow
    their siblings' shape.
  - One record (`AbortBodies`) with a sibling accessor.
  - No new module, no `loc-budget-allow` or `func-budget-allow`.
  - An adversarial review finds no duplicate or misplaced arm.

### Hazards

1. **Dead-code elimination of a pure intrinsic.** Both ids stay in
   `isSideEffecting` (`effects.ts:536`, now through
   `RUN_TIME_ABORT_INTRINSICS`). That list keeps the instruction and its
   operands live (see the `super_init` and `dyn.member_set` notes there), so
   the i32 const survives. Test 5 proves it.
2. **GVN and constant folding.** Distinct ids are distinct operands, so two
   sites are never merged. Identical copies (after inlining) share an id and
   a reason, so a merge is harmless.
3. **Effects ordering.** The facet stays pure. Two aborts on one
   straight-line path could swap which one fires; no builder emits two on
   one path. Test 5 asserts the id of the arm taken.
4. **Retry.** `AbortBodies.lower` truncates `#sites` with `allocations`.
   Test 3.
5. **Units outside the record.** Native async families and certified
   Promise delays bypass `AbortBodies` (`lowerSourceUnit`), so they keep the
   nullary form, and a trap there stays unattributed. The acceptance run
   counts any such row.
6. **Out of scope.** The dispatcher's built-in arm (`closure-method-body.ts`)
   is a raw `unreachable` in the dispatcher's own frame, so it is not among
   the 61.
7. **Budgets.**
   - `program-physical-plan.ts` (1,510) only replaces a line in place.
   - No other touched file is near the 1,500 ceiling:
     - `effects.ts` 663;
     - `manifest.ts` 723;
     - `native-string-values.ts` 881;
     - `dynamic-value-chains.ts` 476, which absorbs the deleted duplicate.
   - Run the gates with `LOC_GATE_BASE` set to the upstream tip.

### Review round 1

1. **BLOCKER: the (caller frame, ordinal) key breaks after legalization.**
   Verified:
   - `optimizePreparedIrProgramIr` (`program-middleend-ir.ts`) runs
     `inlineSmall`, then `monomorphize`, after legalization and after
     `AbortBodies.report`.
   - `inlineSmall` takes single-block callees of ≤10 top-level instructions
     (`MAX_CALLEE_INSTRS`), so a straight-line abort can move.
   - `monomorphize` renames clones (`plan.cloneName`).

   Answer: program-wide ids, truncated on retry beside `allocations` (step
   10). The census keys on the global (`!= -1`), not on frames (step 12), so
   a copy made by the middle end or by Binaryen carries its id and its
   reason. Tests 2 and 3 pin it.
2. **BLOCKER: the exported global is user-visible ABI.** Answer: the param,
   the global and the export exist only in the diagnostic build.
   - **The switch is the `AbortBodies` record**, which only the test262
     Prepared entry creates, and which the census uses. It needs no new
     option: the legalization picks `js.value.unsupported_at` only when the
     record mints an id, and the backend declares resources by demand.
   - **The compile-time site rows are not gated separately.** They are
     recorded whenever the record exists, which is the only place anything
     can read them.
   - **Why not a backend flag (a2):** it would grow three files that are over
     the ceiling.
   - Every other build is byte-identical, including the public front door.
     Test 4.
3. **The publish function's name.** Fixed: `publishNativeStringValueOutput`.
4. **The rename touches ~25 references.** Fixed: a sibling accessor,
   `requiredPreparedAbortSites`; `requiredPreparedAbortBodies` is untouched.
5. **Extend #7436's `wasmErrorSite`.** Fixed: `abortSiteOf` and a third
   argument on `wasmErrorSite` and `renderHostError` in
   `scripts/lib/wasm-exn-render.mjs`. No second lookup.
6. **Acceptance.** Added: 0 frame contradictions, and the gated build named
   (test262 Prepared entry, default `unlowerableBodies: "abort"`).
7. **Kept, not regressed:**
   - gc byte identity, now extended to every build without the record;
   - the duplicate removal;
   - the shared refusal formatter and the shared i32 const;
   - the DCE note on `effects.ts:536`.

## Implementation notes (2026-11-26)

Built as planned, with these differences, each found while implementing:

1. **The presentation joins the new export.** `prepareIrProgramPresentation`
   (`src/compiler/ir-program-presentation.ts`) refuses every physical
   export that no source declaration or startup joins
   (`unjoined-physical-export`), so the site global failed every diagnostic
   compile. The plan missed this seam. Fixed without a budget grant:
   `nativePublishedExportNames(setup)` (`native-string-values.ts`) takes the
   physical plan's `nativeStrings` setup and is the one list both seams read:
   the planner's collision check (`program-physical-plan.ts`, in place) and
   the presentation's joined set (`checkAbiExports`, seeded in place). The
   stdout pair is on the same list, so a stdout export would now join too.
   Both files stay at or under their base size (1,510 → 1,509; 1,543 →
   1,543): the duplicate checks there read `set.size === set.add(name).size`.
2. **`program-consumer.ts` publishes whenever a native pack exists**
   (`if (nativePack)`, was `nativePack?.output`), in place, so the dynamic
   values' export is published without stdout.
3. **`renderHostError` keeps two parameters.** No caller would pass the site
   (the worker lanes do not read the global), so a third parameter would be
   dead. The census reads the site through `wasmErrorSite`, the one lookup.
4. **`article`** moved from `dynamic-member-access.ts` to
   `dynamic-value-kinds.ts`, since `new` and `Object.create` reasons name a
   kind too. `ownProperty` takes the method name instead of a Boolean, so
   its reason names the method.
5. **`RUN_TIME_ABORT_INTRINSICS`** is forwarded by the historical facade
   `src/ir/intrinsics.ts`, which forwards every catalog export
   (`tests/issue-3518-semantic-verification-ownership.test.ts`).
6. **Test 2's `monomorphize` half.** No Prepared program reaches a clone:
   source lowering normalizes direct-call tuples before the pass (the reason
   `tests/issue-3520-monomorph-program-abi.test.ts` injects its clones by
   mock). Verified on the probe programs: none produced a clone. The inline
   half uses a concrete program that `inlineSmall` does inline
   (`function d(){ return Object.getOwnPropertyDescriptor("ab", "length"); } var r = d();`:
   the trap's frame is `<module-init>`, the row names `d`). The clone half
   runs `monomorphize` on a module whose callee is the abort site and checks
   the clone keeps the id operand and the intrinsic.

7. **Two existing tests change with the design.**
   `tests/issue-7354-d1-dynamic-carrier.test.ts` pins the selection's shape,
   which gains `unsupportedAt`. `tests/issue-7354-u-abort-bodies.test.ts`
   asserted that a program without an unlowerable function has the same
   bytes with and without the policy; its program had a run-time abort site
   (`typeof f` makes `f` a function value, whose ToString is a site), which
   now names its id under the policy, so the test now uses a program with no
   site and says so in its title.

### Acceptance run (2026-11-26, this branch on `claude/census-trap-frames` 00c971be)

`npx tsx scripts/ir-census/prepared-census.mts --files <the 61> --out .tmp/kind61.jsonl --harness real --jobs 3`
(the 61 = rows of `fails-trap.jsonl` with `trapFrame` `__js_value_unsupported`):

- 61 of 61 trap at `__js_value_unsupported_at` and carry a site row (global ≠ -1).
- Frame contradictions: **0**. In every row `siteFrame` is the recorded
  function itself, so no copy case occurs among the 61.
- Verdicts: 61 `fail` before and after.

| reason | files |
|---|---:|
| member read '‹key›' of a string needs String.prototype's properties (trim 11, replace 3, search 3, lastIndexOf 3, indexOf 3, substring 3, slice 3, charCodeAt 2, charAt 2, concat 2, split, match, toLocaleLowerCase, toUpperCase, toLocaleUpperCase, toLowerCase, localeCompare) | 42 |
| member read '‹key›' of a function needs Function.prototype's properties (bind 5, call 2, caller 2, constructor, apply) | 11 |
| new with a 'prototype' that is a function, not an ordinary object | 3 |
| member read 'length' of a string needs its own length and index properties | 3 |
| Object.defineProperties of a string: needs the String object's own properties | 1 |
| member read 'toString' of an object without it: Object.prototype's own, which the realm lacks | 1 |

`prepared-analyze.mjs` now prints a "run-time trap" table that clusters
traps by their abort (site or body) reason. The census log's row 5 lives on
the branch that carries `plan/log/es5-prepared-census-2026-11-26.md`; the
table above is its replacement.

### Byte identity (2026-11-26)

Base = this branch's fork point (00c971be), captured before the first edit;
`.tmp/bytes.mts` compiles five programs (two harnessed test262 files, incl.
`String/prototype/trim/15.5.4.20-2-44.js`, and three small ones with dynamic
member reads, one with a kind abort) under five modes. Identical sha256 for
gc, standalone, the public front door, and the test262 entry with
`unlowerableBodies: "refuse"` (a Prepared compile of a program WITH a site
and no record). Only the test262 entry's default (record) build changes:
`trim44` 82,519 → 82,680 bytes, `small` 24,767 → 24,812.

