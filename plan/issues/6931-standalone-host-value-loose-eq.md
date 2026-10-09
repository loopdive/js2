---
id: 6931
title: "Standalone: loose == on a host value passed into an `any` parameter traps `illegal cast` (IR path) or answers wrong (legacy path)"
status: ready
sprint: Backlog
created: 2026-10-09
updated: 2026-10-09
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: equality
goal: standalone-gap
related: [6921, 6920, 2081, 2175, 3673]
assignee: "ttraenkler/claude-session-c"
---

# #6931 — Standalone loose `==` on a host value in an `any` parameter

Documentation and reproducer custody only, as Session A asked in
[PR 6583 comment 6073943217](https://github.com/loopdive/js2/pull/6583#issuecomment-6073943217).
It does not assign an implementation scope: the lowering is A-owned.
Found during #6921, where removing dead-code deletion of `o == 1` exposed it
(see the "Implementation findings" section of
`plan/issues/6921-ir-middle-end-pass-correctness.md`).

## Inputs

- Canonical main `dbf5b4f74b37d67e525b2af36fd1fe49803b1348`, Node v22.22.0.
- Public `compile()` with `target: "standalone"` and `trackIrOutcomes: true`;
  instantiated with `buildImports` + `instantiateWasm` from `src/runtime.ts`.
- Oracle: Node running the same source, transpiled with `ts.transpileModule`.
- Raw receipts: `plan/log/6931-standalone-host-loose-eq/` (probe sources as
  `*.mts.txt`, outputs as `*.out.txt`). To rerun, copy a probe to
  `.tmp/<name>.mts` and run `npx tsx .tmp/<name>.mts`.

## Finding 1: IR path traps on host values

```ts
export function eqUsed(o: any): number { return o == 1 ? 1 : 0; }
```

`eqUsed` is `emitted` with an IR body on both targets. On `gc` every input
matches Node. On `standalone`:

| Argument from JS | Wasm | Node |
| --- | --- | --- |
| `1`, `5`, `null` | `1`, `0`, `0` (correct) | same |
| `"1"`, `"x"`, `{}`, `{valueOf:()=>1}`, `undefined`, `true` | `RuntimeError: illegal cast` | `1`, `0`, `0`, `1`, `0`, `1` |

`eqStr(o) { return o == "1" ? 1 : 0; }` (also IR-emitted) does not trap but
answers `0` for `"1"`, `{valueOf:()=>1}` and `true`, where Node answers `1`.

## Finding 2: native values are correct; legacy path is wrong on host values

`probe-native`: `eqUsed` not exported, called from Wasm with
source-created values. Here the selector sent every function except `ident` to
the legacy path (`unsupported`), so this is **not** IR coverage of native values.

- `eqUsed("1")`, `eqUsed(true)`, `eqUsed({ valueOf() { return 1; } })` → `1`;
  `eqUsed(undefined)` → `0`. All match Node.
- `exported(o) { return eqUsed(o); }` called from JS with `"1"` → `0` (Node
  `1`). No trap, but the answer is wrong.

So the boundary input is the trigger. A source-created value never hits this,
and no native IR coverage of loose `==` should be claimed from these probes.

## Lead (not verified)

From `probe-wat` (the IR-path WAT for `eqUsed`):

1. The parameter is `externref`. The IR lowering boxes both operands and calls
   `$__any_from_extern` then `$__any_eq`.
2. `$__any_from_extern` recognises only native carriers (the AnyValue struct,
   the native number box, i31, the native bool box). Every other value,
   including a JS string or object, becomes **tag 5** with the raw externref
   in field 4.
3. In `__any_eq`, tag 5 means "string". Its ToNumber step (`tag5ToNumber`,
   `src/codegen/any-helpers.ts` ~L1654) tests only for the native number box
   and i31, and otherwise calls the native string→number helper on field 4.
   That helper probably `ref.cast`s a foreign externref to the native string
   type, which traps.

To verify before fixing: name the instruction that traps, and decide what
standalone should do with a foreign value at an `any` boundary: reject it at
entry, or give it its own tag.

## Acceptance (for whoever is assigned)

- Standalone `eqUsed` / `eqStr` either match Node for each argument in the
  table above, or reject foreign boundary values with a deliberate, documented
  error. They never trap with `illegal cast` and never silently answer wrong.
- The legacy path's `exported("1")` gets the same decision.
- `gc` output for both probes stays byte-identical.
- Test through the public `compile()` API on both targets, with Node as oracle.
