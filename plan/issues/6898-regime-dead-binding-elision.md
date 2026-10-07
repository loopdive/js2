---
id: 6898
title: "S3-k: the native regime runs the #3418 dead-binding elision in a JS environment"
status: in-progress
assignee: ttraenkler/opus-6880
created: 2026-10-07
updated: 2026-10-07
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bug
area: compiler
language_feature: es5
goal: architecture
sprint: current
parent: 5385
related: [3418, 6880, 6750, 6708]
# 2026-10-07: +4 comment lines at the Step 1a gate explaining why it keys on the
# implementation (nativeRegime), not the environment; no code growth.
loc-budget-allow:
  - src/compiler.ts
---

# #6898 — the regime elides dead top-level bindings, like standalone does

## Problem

The #3418 pre-parse dead-binding elision (`src/compiler.ts`, Step 1a) runs
only for `targetProfile.environment` `none` or `wasi`. The native regime in a
JavaScript environment (`semanticProviders: "native-first"`) has environment
`javascript`, so it never ran. Every test262 row is prefixed with the harness
shim `var $262 = { …, evalScript: function (s) { … eval(s) … } }`; standalone
drops it when the test never mentions `$262`, the regime kept it. Its direct
`eval` linked `js2wasm:runtime-eval` and put the whole module into runtime-eval
mode: eval-visible script globals widened to externref, every top-level function
declaration a live binding. That mode, not the semantics the rows test, is what
the regime got wrong in #6880:

- group 1 (`.call`/`.apply`/`.bind` dropped the receiver of a live binding),
- group 3 (`filter` walked a copy of the externref-widened array),
- group 4 (array index keys through the dynamic `__extern_get`/`__extern_set`),
- groups 6 and 7 (`with` / chunked init / thrown objects in the same mode).

**Experiment (2026-10-07, in-process lane, refusal eval provider).** Re-keying
the gate to also run for `targetProfile.nativeRegime`, the 43 issue rows of
#6880 groups 1, 3 and 4–9 (16 + 4 + 23) all passed on the regime. Without
it, 22 of the 23 group 4–9 rows fail, and group 1/3's rows needed the two
per-group fixes (PR #6560, PR #6573) to pass.

## Change

`src/compiler.ts` ≈ L1823: `… || targetProfile.nativeRegime`.

This is the spelling plan v2's design rule asks for (#5385 "Implementation
Plan v2"): environment-shaped gates key on `hostFreeEnvironment(ctx)`, regime-
shaped ones on `ctx.standalone` ≡ `targetProfile.nativeRegime`. Which top-level
bindings are dead is a property of the ECMAScript implementation that lowers the
module, not of whether a JS embedder exists, so the elision is a regime question.
The original `none`/`wasi` terms stay so standalone and WASI are unchanged by
construction; `standaloneScriptVarBindings` (a later Script can still observe a
context-owned binding) keeps its veto.

## Acceptance

- [ ] A focused test: an unused harness-style shim with a direct `eval` is
      elided under native-first (no `js2wasm:runtime-eval` import); a shim the
      program uses, and a live direct `eval`, keep it.
- [ ] Default gc / standalone / wasi byte-identical (sha256 on probes).
- [ ] The 321-row regime sample (before-state 227 per the handoff) does not drop.
- [ ] `language/function-code/|built-ins/Array/prototype/filter/|language/statements/with/|language/statements/try/`
      on the regime: no pass → fail row.
- [ ] `pnpm run check:host-import-policy` 0 legacy / 0 unknown.

## Progress

### Measurement (2026-10-07, branch base `534620a636`)

Lane: in-process `scripts/run-test262-paths.mts` with the refusal eval
provider, `TEST262_SEMANTIC_PROVIDERS=native-first`, run in 4 parallel shards
(the sharded `pnpm run test:262` lane hits its 10 s compile timeout on most
rows at load 180–400). One after-shard hung for two hours inside a row, so
I re-ran that shard with `--isolate` (each row in its own process; 135 s
limit).

| set | rows | before | after |
| --- | ---: | ---: | ---: |
| (a) 321-row sample (`Object/keys`, `Array/prototype/map`, `class/accessor*`) | 321 | 285 | 275 |
| (b) `function-code`, `Array/prototype/filter`, `statements/with`, `statements/try` | 841 | 762 | 774 |
| total | 1162 | 1047 | 1061 (+32 / −18) |

**fail → pass (32):** 22 in `filter/`, 6 in `map/`, 3 in `statements/with/`,
1 in `statements/try/`. Group 1's rows are already on main (PR #6560), so
`function-code/` adds nothing new here.

**pass → fail (18). Every one of them also fails on `--target standalone`**
(checked row by row, same lane, `--isolate`). With the shim gone, the regime
compiles the same module that standalone compiles, so it now has standalone's
existing failures in these shapes, which the runtime-eval-mode path happened
to get right:

- `map/15.4.4.19-3-{8,14,28,29}`: these **hang** (more than 135 s) on both
  lanes. They are array-likes whose `length` is huge or not finite, and the
  native `map` loop walks the whole length. This is the row that stalled the
  in-process shard.
- `map/15.4.4.19-8-b-{2,5,7,10,13}`, `-8-c-i-{1,3,5,7,17}`, `-8-c-ii-11`,
  `create-non-array-invalid-len`: native `map` over a mutated array, an
  accessor-holding array or an array-like; the last one fails with
  `requested new array is too large` in `__objvec_push`.
- `filter/15.4.4.20-9-c-iii-2`: a void callback counts as truthy
  (`array-prototype-borrow.ts` `toTruthy`, "void → always truthy").
- `filter/15.4.4.20-9-c-ii-11`: `arguments[2]` inside a 2-formal callback is
  `undefined` once any function in the module carries an own property
  (`function assert(){}; assert._x = function(){}`). That is the closure
  ABI, `closures.ts`.

`check:host-import-policy`: 0 legacy / 0 unknown (33 probes, 426 imports).

**Byte identity.** I compiled four probes for gc, standalone, wasi and the
regime: a script with an unused direct-eval binding, the assembled
`10.4.3-1-69-s` harness, an externref `filter`/`reduceRight`/`map` module,
and a reassigned-function script. The sha256 for gc, standalone and wasi is
identical before and after. The regime's output changed only for the two
probes that carry an unused binding.
