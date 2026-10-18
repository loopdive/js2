---
id: 7051
title: "codegen: traps, invalid Wasm and a lost export-boundary unwrap in the #7014 traps/CE slice"
status: done
sprint: Backlog
assignee: "ttraenkler/wave15-traps-ce"
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: multiple
goal: core-semantics
related: [7014, 7040, 7041, 7056, 4429, 4616, 4625, 5126, 3061, 5247, 4157]
requested_by: ttraenkler/wave15-traps-ce
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/dataview-native.ts
func-budget-allow:
  - src/codegen/literals.ts::compileObjectLiteralForStruct
---

# #7051 — codegen regressions in the #7014 traps/CE slice

Part of the [#7014](7014-issue-tests-detector-red-since-july.md) backlog. Each
row was bisected on upstream main's first-parent history (a `src/` snapshot
per candidate, the issue test's own source as the probe), then into the
culprit PR's branch where the merge was large.

## Root causes and fixes

| Tests | Culprit | Root cause | Fix |
| --- | --- | --- | --- |
| `issue-4429` (2 tests, standalone) | 725e33c3e2 (#4753) | `({ x: 7, toString() { return "v" + this.x; } }) + ""` — the new §13.15.3 object-addition arm coerced the struct operand to `externref`, which materialises a `$Object` COPY (#2358); the runtime cascade then called the method with the copy as `this`, while the literal's method trampoline expects its own struct in `__current_this` → "dereferencing a null pointer". | `admitsObjectAddition` declines an object-literal struct whose `valueOf`/`toString` closure field READS `this` (a `this`-free one keeps the full cascade — its Symbol TypeError and evaluation order, `addition/order-of-evaluation.js`), and `emitAnyAdd` reduces a toString-only struct through the typed string-hint dispatch (its default-hint answer by §7.1.1, since `valueOf` is `Object.prototype.valueOf`). Both keep `this` bound to the struct. |
| `issue-4616` (2 tests, host; the same shape emitted invalid Wasm in standalone) | 778d1ee11d (#4839) | `options = { …defaults, ...options }` with `options?: Opts`: #4839 widened optional params to `externref`, so the binding holds whatever the caller built (`f({ keepPrototype: true })` is its own `__anon` struct); the spread `ref.cast` to `Opts` trapped "illegal cast". | `src/codegen/object-spread-extern-source.ts`: a LAST-position spread of an externref-stored binding takes the existing runtime CopyDataProperties route. |
| `issue-4625` "the bracket shapes that already worked still work" | — | `a["join"]("-")` reaches the join lowering with its ELEMENT-access callee; `isLocalizedJoin` read `.name.text` and crashed the compile. | `isLocalizedJoin` also reads a string-literal `argumentExpression`. |
| `issue-5126` "rejects non-number argument before claim" | never passed (now caught by output validation) | `Math.imul(text as never, y)`: `__toUint32`'s index was captured BEFORE the argument compiled; coercing a string argument registered a late import and the stale index called the wrong function (invalid Wasm). Same latent hazard in `Math.clz32`. | Re-read `__toUint32` after each argument. |
| `issue-3061` "ArrayBuffer.prototype.slice result has correct byteLength" (host) | 514b55dfa2 (#4397) | The detached-buffer throw was built before the receiver compiled; held outside `fctx.body` it missed the late-import shift, so its `__new_TypeError` call named an f64 function (invalid Wasm). | Build it at its use site, flushed against `fctx`. |
| `issue-5247` (2 tests, host) | c4008d7cab (#5715) + 651034e4fd | Moving `ensureExnTag` into `registry/physical-imports.ts` dropped its call to `ensureExportThrowRethrowImport`, which 651034e4fd then deleted as dead — so no module registered `env.__rethrow_host_exception` and no export wrapper was minted: an uncaught `throw new RangeError("x")` reached the host as a bare `WebAssembly.Exception`. | Restored the helper; `ensureExnTag` calls it through a registration hook (`registerExnTagFirstUseHook`) so the physical-import module stays free of the codegen import graph. |
| `string-derived-length-fast-path` "applies immutable derived-result proofs to host strings" (host strings) | 11bbf2a791 (inside #4922) | `isDynamicPropertyKeyExpression` sent EVERY non-constant arithmetic index (`csv[i % 2]`) to the runtime property-key lane, for exactness above i32. On the host lane that is a JS-boundary `__extern_get_idx` call for a plain element read (and, without wired exports, `undefined` → "illegal cast" in `length`). | A range-proven index (`staticIntegerRange` within [0, 2³¹−1], e.g. `i % 2` / `i + 1` over a counted loop) keeps the dense element path; unproven arithmetic (`k - 2` near 2³²) still takes the runtime lane. |
| `issue-4157` (4 tests: `JS2WASM_SMI_FASTPATH` on, `JS2WASM_FUSED_TONUMBER` off) | 776aac3cb6 (#5213) | The §7.1.4 Symbol-throw arm spliced into the ToNumber slow chain hard-codes local 2 — the fused helper's `$prim`. The INLINE slow chain (Slice B without Slice A) runs in the caller's frame, so any caller with fewer locals failed "references out-of-range local(s) 2". | The inline chain allocates its own scratch local (declining on a detached body shim); the fused helper keeps local 2. |

## Measured

Per test file, upstream main 0727e2985b, one file at a time; "red" counts only
tests not already in the July `issue-tests` baseline.

| File | before | after |
| --- | --- | --- |
| issue-4429-string-hint-toprimitive-this | 2 red | 0 |
| issue-4616-nullish-spread-source | 2 red | 0 |
| issue-4625 | 1 red | 0 |
| issue-5126-ir-math-imul | 1 red | 0 |
| issue-3061-host-buffer-bytelength | 1 red | 0 |
| issue-5247-export-throw-boundary | 2 red | 0 |
| issue-4157-tonumber-fast-paths | 4 red | 0 |
| string-derived-length-fast-path | 1 red | 0 |

Related suites re-run with the fix vs base, identical results (no new
failures): issue-1806*, issue-1917*, issue-2058, issue-2358*, issue-2679,
issue-2873, issue-3051, issue-305x, issue-4491*, issue-4492*, issue-4564,
issue-4655. Scoped standalone test262 (base vs fix): see the PR.

## Not covered

The `+` arm still traps for a `this`-reading method reached through an
`any`-typed receiver (`function g(o: any) { return "" + o; } g(a)`) — that
predates 725e33c3e2 (the materialised `$Object` copy vs. the struct-bound
trampoline, #2358) and is not a regression.

## Regression proof

`tests/issue-4429-string-hint-toprimitive-this.test.ts`,
`tests/issue-4616-nullish-spread-source.test.ts`, `tests/issue-4625.test.ts`,
`tests/issue-5126-ir-math-imul.test.ts`,
`tests/issue-3061-host-buffer-bytelength.test.ts`,
`tests/issue-5247-export-throw-boundary.test.ts`,
`tests/issue-4157-tonumber-fast-paths.test.ts`,
`tests/string-derived-length-fast-path.test.ts` — and the test262 row
`test262/test/language/expressions/addition/order-of-evaluation.js`, which
pins that the narrowed `+` decline keeps the §13.15.3 cascade for `this`-free
methods.
