---
id: 5258
slug: ir-symbol-boundary-blocked-on-brand-production
status: backlog
sprint: Backlog
priority: low
horizon: m
goal: backend-agnostic-ir
feasibility: hard
created: 2026-09-01
requested_by: ttraenkler/fable-ir-takeover
---

# F1 symbol boundary (js.symbol.box) is blocked on brand production — record the measured state

## Finding (census 2026-09-01, #3526 next-slice probes, origin/main @ 41265d89)

A mechanical F1-S-style "symbol boundary" slice exists in shape (~5 files,
~9 sites: `js.symbol.box` intrinsic + `symbol.box` → `env.__box_symbol`
capability row + a two-armed host/native policy on the F1-S3 template, since
`__box_symbol` has a native definition under no-JS-host mode, #2866,
`src/codegen/expressions/late-imports.ts:476`). But the from-ast arm's type
fact is **never produced on the IR path**:

- `src/checker/type-mapper.ts:100-102` (#2792) deliberately maps
  ESSymbol/UniqueESSymbol to UNBRANDED `{kind: "i32"}` — broad branding
  regressed the `Object.values` symbols canary because other legacy box
  sites still pick `__box_number` from an unbranded i32.
- All 17 producers of `symbol: true` on the i32 brand live in
  `src/codegen/` (legacy), zero in `src/ir/`.
- Consequence: every IR symbol boundary crossing exits safely today via the
  `operand-coercion-unsupported` throw (`from-ast.ts:~7240`) or the
  `return-type-legacy-coupling` demote (`:~9563`).
- The IR boxed-any has no Symbol tag at all (`src/ir/js-tag.ts:44-53` —
  JsTag stops at Function(7); no BigInt either).

## Unblock options

(i) **Brand-at-site**: reconstruct the symbol brand at the coercion site
from the oracle type fact (the legacy `annexb-escape-call.ts:99` pattern) —
keeps the slice mechanical; the claimed population is exactly the current
demote/throw exits. (ii) Wait on the #2610 symbol-as-any value-rep pass,
which owns global branding. Either way the JsTag gap caps how far symbol
values can travel as dynamics.

## Acceptance criteria (for whoever picks this up)

1. A measured decision between (i) and (ii) recorded here, with the
   `Object.values` symbols canary named as the regression control.
2. If (i): an F1-S plan section in
   `plan/issues/3526-ir-r6-semantic-runtime-contract.md` following the
   F1-S2/S3 shape, byte-neutrality obligations included.
3. No presence-chosen provider is introduced (manifest authority only).
