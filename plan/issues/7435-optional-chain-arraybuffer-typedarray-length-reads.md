---
id: 7435
title: "Optional-chain ArrayBuffer/TypedArray ?.byteLength gives NaN (all lanes); Uint8Array ?.length gives 0 on wasi"
status: ready
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7401, 7395]
---

# #7435: optional-chain length reads on ArrayBuffer / TypedArray

## Problem

Found by review RV7338 of PR #7338 (#7401). Re-measured on main `89e47482`
and on #7336's head `4f7b1a8d2f`, with the same answers on both:

| repro (`export function main(): number { … }`) | standalone | wasi | gc | node |
| --- | ---: | ---: | ---: | ---: |
| `const b: ArrayBuffer \| undefined = new ArrayBuffer(8); return b?.byteLength ?? -1;` | NaN | NaN | NaN | 8 |
| `const a: Float64Array \| undefined = new Float64Array(2); return a?.byteLength ?? -1;` | NaN | NaN | NaN | 16 |
| `const a: Uint8Array \| undefined = new Uint8Array(3); return a?.length ?? -1;` | 3 | **0** | 3 | 3 |

- `?.maxByteLength` behaves like `?.byteLength` (reported by the reviewer).
- The plain reads are correct (`b.byteLength`, `a.length`), so the bug is in
  the optional arm only.
- #7401's fix does not reach these: they are not extern-class getters.

## Not this issue

Optional **method** calls (`m?.get`, `m?.has`, `d?.getTime()`) are fixed by
#7336 (#7395). On `4f7b1a8d2f` they give 7 / 1 / 5, matching node; main gives
NaN / 0 / NaN.

## Direction

Find the arm that the non-optional `byteLength` / `length` read takes for
ArrayBuffer and TypedArray carriers, and give `compileOptionalPropertyAccess`
the same dispatch after the null short-circuit. The wasi `length` row
suggests the optional arm reads a different carrier field there.

## Acceptance

- The three rows above, plus `?.maxByteLength`, give node's answer on gc,
  standalone and wasi.
- A test pins them.
- Byte identity on a sample: only the affected programs change.
