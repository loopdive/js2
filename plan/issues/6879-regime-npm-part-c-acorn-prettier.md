---
id: 6879
title: "S3-h part C: acorn and prettier on the native regime — a `for…in` key read that dereferences null, and a closure that fails Wasm validation"
status: ready
created: 2026-10-06
updated: 2026-10-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: npm-compat
goal: architecture
sprint: current
parent: 6749
related: [5385, 6749, 6875, 6876]
---

# #6879 — the last two npm-compat regime rows that are not react

Re-measured 2026-10-06 evening on main (after #6875, #6876, #6748):
**marked and lit now measure** on the regime lane. Two rows remain
(`--only <pkg> --perf-only --lane js-host-native`):

| package | regime diagnostic |
| --- | --- |
| acorn | `TypeError: Cannot access property on null or undefined at 438:67` — `tests/dogfood/.acorn/package/dist/acorn.js:438`: `for (var opt in defaultOptions) { options[opt] = opts && hasOwn(opts, opt) ? opts[opt] : defaultOptions[opt]; }` (`getOptions`): a `for…in` over a module-scope object literal, then computed reads with the loop key |
| prettier | `emitted WebAssembly failed validation — Compiling function #2012:"__closure_538" failed: type error in fallthru[0] (expected (ref null 38), got (ref 2))` |

Both compile and run on the host lane; prettier compiles on standalone (the
regime's extra boundary wiring is the difference), acorn is the same code
standalone runs in the dogfood harness.

## Plan

**acorn.** Reduce to `const defaults = { a: 1, b: 2 }; export function get(opts) { const o = {}; for (const k in defaults) o[k] = opts && hasOwn(opts, k) ? opts[k] : defaults[k]; return o.b; }` called from JS with `{ a: 5 }` and with `undefined`, under `semanticProviders: "native-first"`, `platform: "node"`. Candidate causes, in order of likelihood: (1) the `for…in` key arrives as a host string externref and the computed read `defaults[k]` on the regime does not treat it as a key (the receiver arm of #6875 covers strings as RECEIVER; the key side goes through `__str_equals` / `__str_to_number` and a boundary-string key may miss), (2) `hasOwn(opts, k)` on an admitted boundary object with a native-string key, (3) `opts && …` short-circuit typing. Fix at the emitter, focused test, byte identity for default gc / standalone / wasi.

**prettier.** `__closure_538` fails validation only on the regime: a closure body whose fallthrough value is a non-null `(ref 2)` where the signature wants `(ref null 38)` — a dispatcher/callee type mismatch of the #6710 family (`closureDispatchParamType`, `widenNonDefaultableTypes`), now on the RESULT side. Compile prettier's entry alone with `emitWat: true, emitWatOnlyFunctions: ["__closure_538"]` (the generator's `--inspect-wat` plumbing exists for cookie; reuse it), identify the source closure, reduce, and fix the result widening (the closure's declared result type after widening vs the value the body produces). Byte identity for default gc / standalone / wasi.

## Acceptance

- [ ] acorn and prettier `measured` on `jsHostNative` with the host lane's checksum.
- [ ] Focused tests for both reductions on the regime; the standalone result unchanged.
- [ ] `check:host-import-policy` 0 legacy / 0 unknown.
