---
id: 1345
title: "spec gap: Reflect.* invariant checks mirror internal-method bugs (46 test262 fails as of 2026-05-28)"
status: blocked
created: 2026-05-08
updated: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: reflection
goal: spec-completeness
sprint: Backlog
parent: 1328
blocked_on: [1130, 1596]
reverified: 2026-05-28
related: [1334, 1640, 1513, 1629, 1630, 1631, 1596, 1130]
---
# #1345 — Reflect: invariant checks mirror internal-method bugs

## Problem

`built-ins/Reflect`: **70 / 153 pass (45.8%) — 83 fails (77 assertion_fail, 2 runtime_error,
2 type_error, 1 null_deref, 1 wasm_compile)**.

Spec §28.1 (Reflect): each Reflect.X is a thin wrapper over the [[InternalMethod]] X. Therefore:
1. Reflect.defineProperty mirrors [[DefineOwnProperty]] → blocked on #1334.
2. Reflect.getOwnPropertyDescriptor mirrors [[GetOwnProperty]] → returns full descriptor including
   attribute flags.
3. Reflect.has mirrors [[HasProperty]] → walks prototype chain.
4. Reflect.ownKeys mirrors [[OwnPropertyKeys]] → returns string + Symbol keys in spec-defined order.
5. Reflect.set / Reflect.get pass receiver explicitly.

The 77 assertion_fail failures are mostly cascade effects of #1334 (descriptor-attribute fidelity).

## Acceptance criteria

1. `built-ins/Reflect/defineProperty/symbol-key.js` passes (after #1334).
2. `built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js` passes.
3. `built-ins/Reflect/getOwnPropertyDescriptor/return-undefined-for-non-existent-key.js` passes.
4. Pass-rate for `built-ins/Reflect` rises from 46% to ≥80% (after #1334 lands).

## Files to modify

- `src/runtime.ts` — `__reflect_*` host bridges
- `src/codegen/registry/reflect.ts`

## Implementation Plan

### Root cause

Most failures cascade from #1334 (Object.defineProperty descriptor attributes). Once that issue
lands, Reflect.defineProperty and Reflect.getOwnPropertyDescriptor automatically improve.

The remaining gap is Reflect.ownKeys order: spec requires:
1. Integer-indexed keys in ascending numeric order.
2. Other string keys in property-creation order.
3. Symbol keys in property-creation order.

Our `__reflect_ownkeys` host bridge calls JS `Reflect.ownKeys` directly which is correct, but
typed-struct objects don't expose Symbol keys at all (they have no Symbol-keyed slot).

### Approach

1. Block on #1334.
2. For typed objects: extend the attribute-table from #1334 to include Symbol keys (currently
   the table is keyed by string only).
3. After #1334: re-run test262 and verify Reflect tests improve.

### Edge cases

- Reflect.set with receiver = primitive → must invoke setter with the primitive as `this` (no
  TypeError unlike strict-mode regular set).
- Reflect.defineProperty returns `false` on failure (spec mode); Object.defineProperty would throw.

### Test262 sample

- `test262/test/built-ins/Reflect/defineProperty/define-symbol-properties.js` (renamed from `symbol-key.js` upstream)
- `test262/test/built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js`

## Re-verification (2026-05-28)

**Pass rate**: `built-ins/Reflect` 107 / 153 pass (**69.9 %**), 46 fails. Up from
70 / 153 (45.8 %) in the original audit — gain attributable to #1334 (descriptor
attribute fidelity), #1629a/b (Object.defineProperty + getOwnPropertyDescriptor),
#1630 (Object.assign struct writeback), #1631 (Object.create descriptor map),
#1596 (Function apply/call) which have all landed since the original report.

**Acceptance check** (using current upstream test262 names where renamed):
- `defineProperty/define-symbol-properties.js` (was `symbol-key.js`): **FAIL** —
  blocked on Symbol-keyed attribute slots in the descriptor table (out-of-scope
  here; tracked under the descriptor model owned by #1631/#1640 follow-ups).
- `ownKeys/return-on-corresponding-order-large-index.js`: **FAIL** — large-index
  string-key ordering inside `__reflect_ownkeys` (host `Reflect.ownKeys` returns
  the host's enumeration order; differs from spec for wasm-backed objects with
  out-of-range numeric-looking string keys). Tracked under #1130 (Array
  accessor/order) family.
- `getOwnPropertyDescriptor/undefined-own-property.js` (replaces removed
  `return-undefined-for-non-existent-key.js`): **PASS**.

**Acceptance criterion #4** (≥80 % pass) — NOT yet met. Currently 69.9 %; the
remaining gap to 80 % requires lifting #1130 (Array accessor getters,
ESCALATED-NEEDS-SPEC) and #1596 follow-ups (#1596 main slice merged via #175;
residual `Reflect.apply` argument-list edge cases still cascade). No
Reflect-layer code fix in `src/runtime.ts:5875-6043` (`__reflect_*` bridges)
moves the needle — every bridge already delegates correctly to host
`Reflect.X`.

**Failure breakdown by Reflect method** (46 fails as of 2026-05-28 baseline
`test262-current.jsonl`):

| Method | Fails | Root cause |
|--------|-------|------------|
| set | 9 | descriptor `[[Writable]]` / accessor setter dispatch — cascade #1334 + Proxy gap |
| ownKeys | 7 | ordering for large-index string keys (#1130 family) + Symbol-key slots |
| defineProperty | 5 | Symbol-keyed defineProperty + abrupt-completion via Proxy |
| getOwnPropertyDescriptor | 4 | Symbol-keyed readback + accessor descriptor shape |
| preventExtensions / get / deleteProperty / construct / apply | 3 each | Proxy traps + accessor invocation cascade |
| has | 2 | Proxy traps |
| isExtensible / setPrototypeOf / getPrototypeOf / prop-desc | 1 each | Proxy traps + Reflect prop-desc shape |

**Why no localized fix lands here.** Every Reflect bridge in `src/runtime.ts`
already calls the host `Reflect.X` after `_wrapForHost`-wrapping wasm structs.
The failures are upstream of the bridge: they exercise host MOP operations
(`[[DefineOwnProperty]]`, `[[OwnPropertyKeys]]`, `[[Set]]`) on objects whose
descriptors/property keys our codegen+runtime layer doesn't yet model fully.
Those are the open issues listed above.

**Status decision.** Marking `blocked` (matching sibling #1640's lifecycle).
Will close when (a) #1130 lands and (b) the residual `defineProperty/symbol-key`
+ `ownKeys/large-index` cases are picked up under their respective parent
issues. Until then there is nothing to implement here.
