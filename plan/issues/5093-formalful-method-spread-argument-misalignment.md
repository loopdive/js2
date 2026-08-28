---
id: 5093
title: "A spread call into a method WITH formals misaligns arguments, and one shape emits invalid Wasm"
status: ready
sprint: current
created: 2026-08-27
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
language_feature: spread
related: [4782, 4527, 2202, 2151]
# (2026-08-27) Id reserved with `claim-issue.mjs --allocate --allow-unscanned`
# — no `gh` in this container, so the tool's open-PR scan degrades
# unconditionally. The scan was run directly against the REST API instead: the
# 18 open PRs on loopdive/js2 (#5063, #5073, #5077, #5081-#5090, #5092-#5096)
# add or modify issue files {1719, 3518, 3521, 3522, 3525, 4260, 4406, 4779,
# 4780, 4782, 4784, 4785, 4786, 4787, 5091}. 5093 collides with none of them.
---

# #5093 — spread into a method that HAS formals

## Problem

[#4782](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4782-issue-4527-mixed-spread-arguments-red-on-main)
fixed the **zero-formal** arm of a spread call (`emitSetExtrasArgv`). The other
arm — `methodParamCount > 0`, which routes to `compileSpreadCallArgs` in
`src/codegen/expressions/extern.ts` from `compileReceiverMethodCall`
(`src/codegen/expressions/call-receiver-method.ts`, the `handledSpreadNn` gate)
— is separately broken, in four distinguishable ways.

Every row below was measured on `origin/main` @ `14dfc8c105` **and** on
`655b3ab2ef`, the commit that introduced the #4527 mixed-spread row, with
identical results. This is **older than the #4782 regression** and was never
collateral from it.

| shape | correct | actual |
| --- | --- | --- |
| `class C { method(a) { return arguments.length + arguments[0] + … + arguments[3] } }` called `C.prototype.method(42, ...[1], ...tail,)` | `52` | **`null`** |
| same, but the body reads only `arguments.length` | `4` | **`1`** — the spread contributes nothing to the count on this arm |
| `class C { method(a, b) { return a + b } }`, same call | `43` (`a=42`, `b=1`) | **`44`** — `b` binds `2`, so the inline `...[1]` element is skipped: an off-by-one in the flatten into formals |
| `class C { method(a) { return a } }` called `C.prototype.method(...[7, 8])` | `7` | **invalid Wasm** — `WebAssembly.instantiate(): Compiling function "t" failed: not enough arguments on the stack for local.set` |

The last row is the serious one: the compiler emits a module that does not
validate, so the failure is a hard instantiate error, not a wrong value.

Receiver shape matters, and not in the direction one would guess:

| receiver | mixed spread, body reads `arguments` |
| --- | --- |
| `C.prototype.method` | `null` |
| `new C().method` | `null` |
| plain `function f(a) {…}` | `null` |
| object literal `{ method(a) {…} }` | **correct (52)** |

A spread of a **local** array alone (`C.prototype.method(...tail)`) binds the
formal correctly; the inline-literal spread (`...[7, 8]`) is what tips it into
the invalid-module case. Both the zero-formal arm (#4782) and this one accept
the same source, so which of the two runs is decided purely by the callee's
formal count — a caller-invisible property.

## Why it is not covered

Same structural gap as
[#4775](https://js2wasm.loopdive.com/dashboard/issue.html?slug=4775-numeric-return-twin-suite-red-on-main)
and #4782: the spread/`arguments` suites live under `tests/`, not
`tests/equivalence/`, so no required check runs them, and none of them asserts a
formal-ful callee with a mixed spread. While validating #4782 the neighbouring
suites showed **43 pre-existing failures on clean main** (dynamic-new spread,
generator × arguments in standalone, `spread-rest`, native-generator spread) —
this issue is a slice of that surface, not the whole of it.

## Acceptance criteria

- `C.prototype.method(...[7, 8])` into `method(a)` produces a module that
  validates. No shape of a spread call may emit invalid Wasm.
- A formal-ful callee sees the same `arguments` contents as the zero-formal one
  for the same call: `52` and `4` for the rows above.
- Formals bind by position after the spread is flattened: `method(a, b)` gets
  `a=42`, `b=1`.
- Regression tests cover all four receiver shapes above (the object-literal one
  is already correct — pin it so a fix does not trade one for another), in both
  host and standalone lanes.
- Do NOT re-pin an observed-wrong value (#4743/#4747 precedent) — node is the
  oracle for each row.

## Reproduction

```js
// tests use compileMulti + buildImports/wrapExports; see tests/issue-4782.test.ts
class C {
  method(a) {
    return arguments.length + arguments[0] + arguments[1] + arguments[2] + arguments[3];
  }
}
export function t() {
  const tail = [2, 3];
  return C.prototype.method(42, ...[1], ...tail,); // 52; compiles to null
}
```

```js
class C { method(a) { return a; } }
export function t() {
  return C.prototype.method(...[7, 8]); // 7; module fails to validate
}
```

## Provenance

Found while fixing #4782 (PR #5096), by probing the near-miss variants of the
fixed shape. Not fixed there: it is a different lowering arm, and #4782's fix is
byte-identical for every shape that reaches this one.
