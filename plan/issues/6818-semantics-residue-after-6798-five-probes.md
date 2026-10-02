---
id: 6818
title: "codegen: five probe-backed divergences left over from #6798 — `{ k: class {} }` stores null, host module-level `let` TDZ read is not a ReferenceError, any-typed `yield*` loses a non-numeric return, a `boolean | number` slot stringifies as 1, standalone `String(false && f())` through `any`"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: n/a
goal: core-semantics
related: [6798, 6806, 6817]
requested_by: ttraenkler/claude-review
origin: "measured by the #6798 implementation (2026-10-02) on its parent and left out of its six-slice scope; not re-measured by the filer"
---
# #6818 — residue list from #6798

Each row is one probe the #6798 implementation measured and did not fix.
Re-verify each on current main with `.tmp/probe.mts` before dispatch; fix
them as one PR or split by area.

| # | probe | wasm | JS |
|---|---|---|---|
| 1 | `const o = { k: class {} }; typeof o.k` | `"object"` (the property holds `null`) | `"function"` |
| 2 | module-level `console.log(x); let x = 1;` wrapped in try/catch, host lane | no throw, reads `undefined`/0 | `ReferenceError` (TDZ) — #6798 fixed `typeof x` in the TDZ only |
| 3 | `function* inner() { return "s"; } function* outer(): any { const r = yield* inner(); return r; }` | numeric 0 / `undefined` | `"s"` — the `yield*` completion value is dropped when the slot is `any` |
| 4 | `let v: boolean \| number = true; String(v)` | `"1"` | `"true"` — #6798 fixed the `boolean` and `number` slots; the union slot still formats as a number |
| 5 | standalone: `function f(): any { return 2; } String(false && f())` | `""` / `"0"` | `"false"` |

## Correction

1. Class expressions as object-literal property values: the literal lowering
   must emit the class constructor closure (the same value `const K = class {}`
   produces), not the placeholder it emits for an unsupported initializer.
2. Module-level `let`/`const` reads before initialisation on the host lane need
   the TDZ check the function-scope path has (`__tdz_check` or the sentinel
   compare the #6798 `typeof` arm uses), not only inside `typeof`.
3. `yield*` into an `any` slot: carry the delegate's return value through the
   boxed channel instead of the numeric fast path.
4. Union `boolean | number` slots: the #6798 ToString tag must be chosen at
   runtime (the slot's tag word), not from the static type.
5. Standalone `&&` with a boolean left operand in a boxed context must keep
   the boolean's identity (`false`), not coerce through the numeric path.

## Acceptance

- All five probes match JS on the lane named in the table; rows added to
  `tests/issue-6798-*.test.ts`.
