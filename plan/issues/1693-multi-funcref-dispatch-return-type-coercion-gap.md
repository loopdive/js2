---
id: 1693
title: "multi-funcref-dispatch (#1131) missing return-type coercion — emits invalid Wasm on full-module axios/utils.js (mis-presented as `&&` fallthru bug)"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, closure-dispatch
language_feature: closures, type-coercion
goal: npm-library-support
sprint: Backlog
parent: 1571
related: [191, 1131, 1571, 1690, 1558]
note: "Carved out of task #191 (the `&&` fallthru widening proposal) after dev-1655 investigation showed the minimal `&&` snippet validates and only the full-module compile fails. The `&&` lowering at logical-ops.ts:55-92 is correct; the bug is in the closure-dispatch trampoline. RESOLVED on main: a72cb9002 added the missing 4th-case coercion at calls.ts:7945-7969 (multi-funcref dispatch ladder); 75bc8bbfd narrowed it to numeric-primitive pairs only ({i32,f64,i64}) after the catch-all broke 8 equivalence tests on ref/ref_null/externref combinations. tests/issue-1693.test.ts covers 3 scenarios (single-candidate, multi-candidate diverging kinds, full axios/lib/utils.js) and passes."
---
# #1693 — multi-funcref-dispatch trampoline misses return-type coercion (full-module axios/utils.js)

> Carved from task #191. The localized fix proposed there ("widen i32 short-
> circuit branch to f64/externref") is wrong — the `&&` lowering unifies
> result types correctly in isolation, and the minimal `isBuffer` snippet
> compiled with `compile()` **passes** Wasm validation. The bug surfaces only
> at full-module scale through `compileProject(axios/lib/utils.js)`. dev-1655
> ESCALATED to architect (see task #191 description for the worktree + repro
> artifacts).

## Problem

`compileProject("node_modules/axios/lib/utils.js", { allowJs: true })`
succeeds; `WebAssembly.compile(r.binary)` fails:

```
Compiling function #71:"isBuffer" failed:
  type error in fallthru[0] (expected i32, got f64) @+12399
```

`isBuffer` source (`axios/lib/utils.js:31-43`):

```js
function isBuffer(val) {
  return (
    val !== null &&
    !isUndefined(val) &&
    val.constructor !== null &&
    !isUndefined(val.constructor) &&
    isFunction(val.constructor.isBuffer) &&
    val.constructor.isBuffer(val)
  );
}
```

The minimal extracted snippet (only `isBuffer`, `isUndefined`, `isFunction`)
compiles + validates fine. Adding the rest of `axios/lib/utils.js` (the
~30 other 1-arg arrow predicates: `isObject`, `isPlainObject`, `isFormData`,
`isURLSearchParams`, …) reproduces the validation failure. This is the
same fingerprint as **#1690 acorn `isInAstralSet`** — a codegen interaction
that emerges only once the module accumulates enough sibling closure
signatures.

Reproducers (worktree `/workspace/.claude/worktrees/issue-fallthru-and-or`,
job dir `/home/node/.claude/jobs/8d9a5e7c/`):

| Probe | File | Result |
|-------|------|--------|
| Minimal `isBuffer` + `isUndefined` + `isFunction` only | `repro-mini.mjs` | VALIDATE: OK |
| Full `axios/lib/utils.js` | `repro-axios-utils.mjs` | VALIDATE FAIL `fallthru[0] expected i32, got f64 @+12399` |
| `wasm2wat` of failing module | `axios-utils.wat`, `isBuffer.wat` | shows multi-funcref dispatch chain inside the 3rd `&&` clause |

The proposed `&&` widen-to-f64/externref fix from task #191 would alter
EVERY `&&`/`||` in the codebase — high regression risk per #618 and
PR #794. It is the wrong tool for this bug.

## Root cause

**Location**: `src/codegen/expressions/calls.ts:7442-7497`, the
**multi-funcref-type dispatch** path introduced by #1131 ("the closure may
have a different return type than declared, e.g. () => string passed as
() => void").

### What this site does

When the callee is a callable-typed identifier/parameter and several
sibling closure types with the same arity but **different return types**
have been registered in `ctx.closureInfoByTypeIdx`, the codegen emits a
chained `ref.test (ref $funcType_N)` dispatch. Each branch's `then` body
casts the funcref to the candidate type and invokes `call_ref`. The whole
chain is wrapped in `(if (result <expectedReturn>))` where `expectedReturn
= matchedClosureInfo.returnType` from the TypeScript declared signature
(here: `boolean` → wasm `i32`).

The dispatch is **inside the THEN branch of the 3rd `&&` clause**
(`isFunction(val.constructor.isBuffer)`), so the surrounding `(if (result
i32))` from `compileLogicalAnd` reads the dispatch's result.

### The bug — calls.ts:7479-7483

After `call_ref` returns the candidate's actual return type, this code
runs:

```ts
// Coerce return to expected type
if (expectedReturn === null && fc.returnType !== null) {
  fcCallBody.push({ op: "drop" } as Instr);          // void site, value-returning candidate
} else if (expectedReturn !== null && fc.returnType === null) {
  fcCallBody.push(...defaultValueInstrs(expectedReturn));  // value site, void candidate
}
// ELSE-MISSING: expectedReturn !== null AND fc.returnType !== null
//               AND expectedReturn.kind !== fc.returnType.kind
//               → NO COERCION emitted; if-block declared `(result i32)`
//                 but call_ref produces `f64` / `externref` → invalid Wasm.
```

The else-branch covers two of four mismatch cases:
1. expectedReturn=null, fc.returnType≠null: `drop` ✓
2. expectedReturn≠null, fc.returnType=null: push default ✓
3. **expectedReturn≠null, fc.returnType≠null, kinds differ: MISSING** ✗
4. expectedReturn≠null, fc.returnType≠null, kinds equal: no-op ✓

Cluster #3 is the exact bug. The candidate scan at lines 7292-7311 admits
**every arity-matching closure regardless of return type** — so when an
i32-expected dispatch sees an f64-returning sibling candidate, the
`call_ref` pushes f64 into a slot the if-block typed as i32.

### Why minimal-snippet passes, full-module fails

`getOrCreateFuncRefWrapperTypes` always returns a single matched wrapper
(the declared signature). The candidate-list scan at calls.ts:7292-7311
walks `ctx.closureInfoByTypeIdx` to *find sibling closure types*:

```ts
for (const [, info] of ctx.closureInfoByTypeIdx) {
  if (info.paramTypes.length !== sigParamCount) continue;
  if (seenFuncTypeIdx.has(info.funcTypeIdx)) continue;
  // paramsMatch check, then push to funcCandidates
}
```

- **Minimal snippet**: only 1 or 2 1-arg arrow closures (`isUndefined`,
  `isFunction`) live in `closureInfoByTypeIdx`. Both return i32 (from
  `typeof === '…'`). `funcCandidates.length <= 1` → branch at calls.ts:7406
  fires (single-call, NO if-chain) → valid Wasm.
- **Full axios/utils.js**: ~30 1-arg arrow predicates compiled, return
  types diverge (i32 from `typeof === 'x'`, f64 from arithmetic-returning
  helpers, externref from string-building helpers). `funcCandidates.length
  > 1` → branch at calls.ts:7442 fires → emits the if-chain → some arm has
  uncoerced f64/externref → invalid Wasm.

The dispatch chain in `isBuffer.wat:380-453` confirms this exactly: five
`ref.test (ref N)` arms with mixed `drop + i32.const 0` (i.e. f64-returning
arm with after-the-fact normalization) interspersed with raw `call_ref N`
arms that ARE the bug — the latter were arms whose return type ALREADY
matched and didn't need coercion, but they happen to be reached only when
earlier arms fail, which leaves the wrong-typed branch active.

Actually, examining the WAT more carefully: each arm DOES emit its
ad-hoc compensation (`drop; i32.const 0` for f64 candidates), but it
emits whatever `defaultValueInstrs(expectedReturn)` would produce IF the
mismatch happened to flow through the `expectedReturn !== null && fc.returnType === null` branch. The problem is the existing site does NOT route f64→i32 / externref→i32 / i32→f64 / ref→externref / etc. through a real `coerceType` call. The bug is that the third mismatch cluster is silently emitted with no coercion at all in many cases.

Validator-level signature: `type error in fallthru[0] (expected i32, got f64)`. The "fallthru[0]" is the if-block's implicit result, not the `&&` join.

## #618 / PR #794 safety considerations

Any fix that emits *additional* instructions inside `fcCallBody` must:

1. **Not perturb stack arity** for the arms that ARE correctly typed
   today (kind-equal case, void-vs-value cases). The current `drop` and
   `defaultValueInstrs` paths are stable — don't refactor them away.
2. **Not run on the default JS-host single-call path** (calls.ts:7406-7441).
   That path is `funcCandidates.length <= 1` and validates fine today.
3. **Not change the if-block's declared result type** — that would
   ripple into the surrounding `&&` / return-statement contexts and could
   re-trigger the #618 regime (where a similar widening attempt at
   `addImport` caused −3,931 test262 fails by altering caller stack
   shape).

The fix is **strictly additive instructions inside `fcCallBody` after
`call_ref`** — it adds compensation for the missing mismatch cluster and
leaves the rest untouched.

## Proposed fix

### Option A (preferred — minimal, surgical)

In `src/codegen/expressions/calls.ts` at lines 7478-7483, replace:

```ts
// Coerce return to expected type
if (expectedReturn === null && fc.returnType !== null) {
  fcCallBody.push({ op: "drop" } as Instr);
} else if (expectedReturn !== null && fc.returnType === null) {
  fcCallBody.push(...defaultValueInstrs(expectedReturn));
}
```

with the complete four-case logic. The third mismatch cluster
(`expectedReturn !== null && fc.returnType !== null && fc.returnType.kind
!== expectedReturn.kind`) routes through `coerceType` against a side
buffer so the coercion instructions land at the end of `fcCallBody`:

```ts
// Coerce return to expected type — handles all four cases:
//   (a) void site, value candidate         → drop
//   (b) value site, void candidate         → push default
//   (c) value site, value candidate, kinds differ → coerceType
//   (d) kinds equal                        → no-op
// Cluster (c) was missing prior to this fix and caused invalid Wasm
// when a sibling 1-arg arrow with a different return kind was in
// scope (e.g. axios/lib/utils.js `isBuffer` in the multi-funcref
// dispatch path; #1571 / #1693 / #191).
if (expectedReturn === null && fc.returnType !== null) {
  fcCallBody.push({ op: "drop" } as Instr);
} else if (expectedReturn !== null && fc.returnType === null) {
  fcCallBody.push(...defaultValueInstrs(expectedReturn));
} else if (
  expectedReturn !== null &&
  fc.returnType !== null &&
  !valTypesMatch(fc.returnType, expectedReturn)
) {
  // Render coerceType into a side buffer so its instructions are
  // appended to fcCallBody. coerceType writes to fctx.body, so we
  // temporarily swap the body pointer.
  const coerceBuf: Instr[] = [];
  const savedBody = fctx.body;
  fctx.body = coerceBuf;
  coerceType(ctx, fctx, fc.returnType, expectedReturn);
  fctx.body = savedBody;
  fcCallBody.push(...coerceBuf);
}
```

`coerceType` and `valTypesMatch` are already imported in this file (see
existing imports). `defaultValueInstrs` is too. No new imports needed.

**Why coerceType, not hand-rolled instructions**: `coerceType` already
handles every kind transition the compiler emits anywhere else (i32↔f64
via `f64.convert_i32_s` / `i32.trunc_sat_f64_s`, ref/ref_null→externref
via `extern.convert_any`, externref→f64 via `__unbox_number`, etc.). A
hand-rolled patch would miss the externref/ref directions that surface
once more axios entries (axios.cjs `AxiosHeaders_set`) are added to the
test suite. Using `coerceType` is the same play that worked for
ESLint #1558.

### Option B (defensive — narrow candidate list)

Restrict the alt-candidate scan at calls.ts:7292-7311 to candidates whose
`returnType.kind === sigRetWasm.kind` (after the void/value cases handled
by the existing `tryAltFuncType` calls). The dispatch then handles only
return-type-compatible candidates, and any remaining mismatch can throw
TypeError at runtime in the `funcDispatch` tail (which already throws
TypeError for unmatched funcref types via `typeErrorThrowInstrs`).

Trade-off vs A:
- **Pro**: smaller blast radius — doesn't change instructions inside
  dispatch arms, only filters the candidate set.
- **Con**: rejects legitimate calls where the candidate's return type
  IS spec-correctly coercible (e.g. a `() => number` arrow flowing
  through a `() => any` slot). #1131 explicitly broadened the dispatch
  to handle these. Option B regresses #1131's coverage.

Recommend Option A. Option B is the fallback if Option A produces
unexpected regressions.

## #618 hazard checklist (must be verified before merge)

A scoped run of the following before pushing the PR:

1. `pnpm test -- tests/equivalence.test.ts` — full equivalence suite (the
   #618 corruption pattern was caught here).
2. `pnpm test -- tests/issue-191.test.ts` / `tests/issue-1693.test.ts` —
   acceptance tests below.
3. **Default JS-host `Math.abs` + string-concat snippet must still
   validate.** The exact #618 / PR #608 regression shape. Either reuse
   `tests/issue-1677.test.ts` (which has this guard) or add one.
4. **Single-candidate path must be untouched.** Add a test that
   exercises `funcCandidates.length === 1` and confirms the
   `call_ref`+cleanup sequence is byte-identical (or at minimum, the
   single-call branch at calls.ts:7406-7441 is unmodified — diff check
   in PR review).
5. **Merge-group test262 shards must hold.** This is the authoritative
   gate. Local equivalence is necessary but not sufficient.

## Acceptance criteria

1. `compileProject("node_modules/axios/lib/utils.js", { allowJs: true })`
   followed by `WebAssembly.compile(r.binary)` succeeds (no validator
   error).
2. `tests/issue-1693.test.ts` covering:
   - Minimal repro (must continue to pass — guard against regressing
     the single-call branch).
   - Full `axios/lib/utils.js` repro (currently fails — must pass after
     fix).
   - Synthetic minimal-multi-candidate repro: 3+ same-arity arrow
     predicates with i32/f64/externref return types, called through a
     callable-typed parameter. This is what makes the dispatch chain
     fire without needing the whole axios module.
   - `--target wasi` variant of the multi-candidate repro (verify
     standalone path is unaffected).
3. Default-mode `Math.abs` + string-concat snippet still validates
   (#618 guard — reuse or copy from `tests/issue-1677.test.ts`).
4. `axios-tier1.test.ts` rung 1d (`lib/utils.js` validates) flips from
   skip/fail → pass.
5. No regression on the default JS-host CI test262 shard count.
6. The shared `axios.cjs` (entry 3) — `AxiosHeaders_set` —
   `any.convert_extern[0] expected externref, found global.get of type
   (ref null N)` — is a **different** bug (#1571 NEW issue 2,
   extern-boxing of WasmGC struct values) and is **out of scope** for
   this issue.

## Out of scope (carve to follow-ups)

- `axios.cjs AxiosHeaders_set` — #1571 NEW issue 2 (extern boxing on
  WasmGC struct → externref direction).
- `compileProject` hang on `lib/core/Axios.js` graph — #1571 NEW issue 1.
- The `&&` widening proposal from task #191 — **abandoned**; this
  issue supersedes it. The `&&` lowering at `logical-ops.ts:55-92` is
  correct and should not be touched.

## Why this is hard (feasibility: medium, not easy)

The patch surface is small (~10 lines), but four things make it
non-trivial:

1. **The bug is invisible to the disassembler tail.** `wasm2wat` of the
   failing module produces clean text — the validator catches the
   inconsistency at byte-level type-check before disassembly, so naive
   "diff the WAT" debugging misses it (dev-1655 documented this).
   Implementer must drive a real `WebAssembly.compile()` round-trip in
   the test suite.

2. **`coerceType` writes to `fctx.body`, not a passed-in buffer.** The
   correct pattern is the save-swap-restore dance used throughout
   `compileLogicalAnd` (logical-ops.ts:66-72). Naive "call coerceType
   then push" leaks the coerce instructions into the outer body.

3. **Cluster (c) covers MANY direction pairs** (f64↔i32, i32→externref,
   f64→externref, externref→i32 via `__unbox_number`, ref→externref via
   `extern.convert_any`, etc.). Using `coerceType` is the only way to
   cover all of them in one patch; hand-rolling will miss the externref
   directions that axios.cjs (entry 3) exercises.

4. **#618 regression sensitivity.** This site is in a hot path. The
   reviewer must verify that the single-candidate branch (calls.ts:7406)
   is byte-identical before/after.

## Investigation artifacts

In job dir `/home/node/.claude/jobs/8d9a5e7c/` (dev-1655):

- `repro-mini.mjs` — minimal snippet (PASSES Wasm validate).
- `repro-axios-utils.mjs` — full axios/lib/utils.js (FAILS Wasm validate).
- `dump-wat.mjs` — disassembles a binary to WAT for inspection.
- `axios-utils.wat` — full module WAT (shows surrounding context).
- `isBuffer.wat` — extracted `isBuffer` function only (the failing one);
  lines 380-453 contain the multi-funcref dispatch chain documented above.

Worktree: `/workspace/.claude/worktrees/issue-fallthru-and-or` on branch
`issue-fallthru-and-or` from origin/main `8476ab23a`. No src/ changes
landed; branch is investigation-only.

## Files to modify

- `src/codegen/expressions/calls.ts` — lines 7478-7483 (the
  return-type coercion block inside `fcCallBody` construction in the
  multi-funcref dispatch path).

## Tests to add

- `tests/issue-1693.test.ts` — at minimum 4 cases (minimal pass, full
  axios fail-now-pass, synthetic multi-candidate, --target wasi
  variant). The #618 default-GC guard can reuse the existing one in
  `tests/issue-1677.test.ts` rather than duplicating.

## Architect notes (the WHY)

This is **not** an `&&` / `||` lowering bug. The `compileLogicalAnd` at
`logical-ops.ts:55-92` (a) computes a unified `resultType` from `leftType`
and `rType`, (b) coerces BOTH branches to it, and (c) emits a single
`(if (result resultType))` — that logic is spec-correct and contains no
known gap.

The bug is in a **separate codegen path** (the closure-dispatch
trampoline at calls.ts:7442) that runs INSIDE the THEN branch of the 3rd
`&&` clause. The trampoline emits an inner if-chain that *itself* fails
the wasm result-type discipline because one of the dispatch arms was
authored without all four mismatch cases covered.

The reason this looks like an "&&" bug is purely positional: the
fallthru error message references the OUTERMOST enclosing if-block (the
`&&`'s join), even though the actual type mismatch is born inside the
dispatch chain three levels deep. This is also why the localized
`&&`-widening proposal from task #191 would not fix the bug — it would
just widen the outer block's declared type, which would then ripple into
the trampoline's own typing assumptions and likely produce a different
validator error.

The fix is in the cold-path return-type coercion of #1131's
multi-funcref dispatch. It is **medium feasibility** (not easy) because
of the four cluster-coverage / #618-sensitivity / disassembler-blind /
externref-direction concerns enumerated above, but it is bounded:
~10 line change in one function in one file, with a clear test plan.
