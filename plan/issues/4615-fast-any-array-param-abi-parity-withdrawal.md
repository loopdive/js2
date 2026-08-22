---
id: 4615
title: "fast-mode `any[]` param: the IR resolves a different vec/result ABI than legacy → abi-signature-parity withdrawal (was a silently-shipped ABI divergence pre-#3536)"
status: ready
sprint: current
created: 2026-08-22
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 2949
related: [2949, 3536, 4612, 4613, 2379, 1852]
origin: "#4613 re-grounding of the 5 rotted #2949 suite assertions: the slice-3b `any[]` fast-mode zero-demotion assertion rotted because #3536 extended the typeIdx-parity guard to top-level FunctionDeclarations and it now catches a PRE-EXISTING IR-vs-legacy fast-mode `any[]` signature divergence"
# id 4615 reserved via claim-issue.mjs --allocate --allow-unscanned --by
# ttraenkler/opus-4613 on 2026-08-22 (gh CLI offline in this container;
# pr_scan=degraded — the tool said so explicitly). MCP open-PR scan at
# reservation: the 9 open PRs (4742/4740/4738/4737/4735/4731/4728/4726/4723)
# introduce no issue file with an id near 4615.
---

# #4615 — fast-mode `any[]` param diverges from legacy's ABI, so the IR claim is withdrawn

## Problem

```ts
export function count(xs: any[]): number {
  return xs.length;
}
```

Compiled with `{ fast: true }` on current main (`3d1de92f0`), the selector
claims `count`, the IR builds a body, and the parity guard then **withdraws
the claim**:

```
irPostClaimErrors: [
  { kind: "build", func: "count",
    message: "function typeIdx parity mismatch: IR=41, legacy=40 — keeping legacy body" }
]
irCompiledFuncs: []
emitted header:  (func $count (param (ref null 39)) (result f64)   ← legacy's
```

Host mode is fine: the IR claims, keeps the body, and its header is
byte-identical to legacy's (`(param (ref null 2)) (result f64)`), zero
post-claim demotions.

So today's outcome is **safe but wasteful**: no miscompilation (the legacy
body and the legacy ABI are what ship), but no fast/standalone `any[]`
function is ever IR-compiled, and every one of them pays a claim-then-withdraw
cycle — the exact shape #4612 flags on the acorn tokenizer, and a
`abi-signature-parity` entry on the #1923 post-claim ledger.

## This is NOT a new defect — the guard is new, the divergence is old

Measured directly (not inherited from an artifact), at `a017055f4`
(2026-07-23, the last commit before #3536):

| lane        | header                                              | post-claim |
| ----------- | --------------------------------------------------- | ---------- |
| IR fast     | `(func $count (param (ref null 2)) (result f64)`     | `[]`       |
| legacy fast | `(func $count (param (ref null 36)) (result i32)`    | `[]`       |
| IR host     | `(func $count (param (ref null 2)) (result f64)`     | `[]`       |
| legacy host | `(func $count (param (ref null 2)) (result f64)`     | `[]`       |

Pre-#3536 the IR **shipped** a fast-mode signature that disagreed with legacy
on both the vec type and the result type, and reported zero demotions while
doing it. `git bisect` over `c97b8511e..HEAD` (14 steps, probe =
`irPostClaimErrors.length === 0`) names the first "bad" commit:

```
7ecb4ee3a532559938616f34acc91a6ed502c806
fix(#3536): standalone declared-fn object-literal arguments cross the call boundary intact
```

which extended the patch-time typeIdx-parity guard from
class-member/module-init units to **top-level FunctionDeclarations**, with a
*soft* `abi-signature-parity` withdrawal (warning channel, legacy body kept)
rather than the hard invariant the other unit kinds get. The guard is doing
exactly its job here; it simply made a long-standing divergence visible.

The #2949 slice-3b implementation notes already recorded the divergence in
prose — "the fast-mode any[] IR-vs-legacy header divergence — legacy narrows
to a different vec type + i32 result — is PRE-EXISTING on main, probe-verified
side-by-side, untouched here" — but at the time it cost nothing, so the
slice-3b suite asserted `irPostClaimErrors == []` for the fast lane and that
assertion has been red on main ever since #3536.

## Root cause (hypothesis, needs confirming in the fix)

`resolvePositionType`'s ArrayTypeNode arm carries the slice-3b
`dynamic → externref` element arm, which is the **host** element shape. Legacy
`resolveWasmType` narrows `any[]` differently in fast mode (a concrete vec
type) and lowers `.length` to `i32` there rather than `f64`. The IR arm is
mode-blind where legacy's is mode-split — the same class of defect slice 3b
fixed for scalar `any` (`ref_null $AnyValue` in fast, `externref` in host),
just never applied to the `any[]` **element/vec** representation. Element rep
is #2379/#1852 territory, which is why 3b deliberately left it alone.

## Acceptance criteria

- [ ] `export function count(xs: any[]): number { return xs.length; }` compiles
      with `{ fast: true }` with **zero** `irPostClaimErrors` and `count` in
      `irCompiledFuncs`.
- [ ] The emitted `func $count` header is byte-identical to the
      `experimentalIR: false` fast-mode header (same vec typeIdx, same result
      type) — the parity guard becomes a no-op rather than a withdrawal.
- [ ] Host mode stays byte-identical to today (no regression on the lane that
      already agrees).
- [ ] `tests/issue-2949-slice3b-any-dynamic.test.ts` — the `any[]` case
      currently PINS the withdrawal (with a pointer to this issue). Tighten it
      to zero demotions as part of the fix; the pin is written so it fails when
      the divergence is repaired, which is the signal to tighten it.
- [ ] `prove-emit-identity` corpus unchanged, or the drift explained.

## Reproduction

```bash
node --import tsx -e '
import { compile } from "./src/index.js";
const src = `export function count(xs: any[]): number { return xs.length; }`;
for (const opts of [{ fast: true }, { fast: true, experimentalIR: false }]) {
  const r = await compile(src, { fileName: "t.ts", wat: true, ...opts });
  console.log(JSON.stringify(opts), (r.irPostClaimErrors ?? []).map((e) => e.message),
    (r.wat ?? "").split("\n").find((l) => l.includes("(func $count ")));
}'
```
