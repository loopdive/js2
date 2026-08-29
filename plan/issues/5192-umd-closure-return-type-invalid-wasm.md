---
id: 5192
title: "UMD/ES5 lane emits invalid Wasm: __closure_35 returns i32 where the type declares externref"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: closures
goal: core-semantics
related: [4628, 5191]
---

# #5192 — closure return-type mismatch on the ES5/UMD polyfill bundle

## Problem

`@js-temporal/polyfill@0.5.1`'s **UMD** bundle (`dist/index.umd.js`,
Babel-transpiled to ES5, self-contained — jsbi is bundled in) compiles with
**zero errors** and then emits a binary the Wasm validator rejects:

```
WebAssembly.compile(): Compiling function #470:"__closure_35" failed:
  type error in return[0] (expected externref, got i32) @+332400
```

A synthesized closure body returns an `i32` where the closure's declared
function type says `externref`. That is a codegen defect, not a source
problem: the compile gate reported nothing, so the only signal is the
validator.

## Measured

`origin/main` @ `279ce9a4f2`, 2026-08-29, via
`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs --no-whole`
(the harness's UMD lane; compile options are the test262 runner's):

| | |
| --- | --- |
| source | 242 KB, `dist/index.umd.js`, no link step needed |
| compile | success, **0 errors / 0 warnings**, 90,724 ms |
| binary | 1,644,531 bytes |
| `WebAssembly.compile()` | **FAILS** — the message above |

The sibling **ESM** lane (jsbi linked in by the harness, 157,541 B) compiles
in ~21 s and **does** validate, so this is specific to the ES5-transpiled
shape, not to the polyfill's logic.

Note the two lanes fail at different gates and for different reasons — the ESM
lane validates and then throws during module init, which is
[#5191](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5191-builtin-derived-ctor-property-miss-throws).
Neither issue subsumes the other.

## Why it is filed separately from #4628

[#4628](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4628-temporal-runtime-object-spike)
step 3 builds the `Temporal` global from the **ESM** lane. The UMD lane is not
on that critical path; it is a second, independent shape that happens to
exercise the ES5 downlevel output of a large real-world library, and its
failure is a generic closure-emission bug worth fixing on its own merits.

## Reproduce

```bash
node --import tsx tests/dogfood/temporal-polyfill-harness.mjs --no-whole
# then read tests/dogfood/report/temporal-polyfill-surface.json → lanes.umd.validation
```

`--no-instantiate` skips the third gate if only the validator answer is wanted.

## Acceptance criteria

1. The UMD lane's binary passes `WebAssembly.compile()`.
2. A reduced repro of the offending closure shape is added under `tests/` so
   the class of defect is pinned, not just this one bundle.
3. No regression in the ESM lane's compile/validate result.

## Notes

The failing function is a compiler-synthesized `__closure_N`, so start from the
closure lifting / return-type computation rather than from user-visible
lowering. `@+332400` is a byte offset into the emitted binary — dump the WAT
(`emitWat: true`) and read the function at that offset for the exact shape.
The ~91 s compile makes bisecting the 242 KB source by top-level-statement
prefix expensive but viable (the same technique that located #5191 in nine
compiles).
