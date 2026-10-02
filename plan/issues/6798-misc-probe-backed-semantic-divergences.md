---
id: 6798
title: "codegen: probe-backed semantic divergences — `typeof (class {})` → 'object', `typeof y` before `let y` → 'number', `yield*` return value → null, `String(false && f())` → '0', `type i32` saturates while `|0` wraps, resolve-stage catch cannot tell demote from bug"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: multi
goal: core-semantics
related: [6420, 4529, 2035, 1691, 4044, 1236, 2715]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — MEDIUM cluster"
---

# #6798 — six smaller divergences, each reproduced on the JS-host lane (2026-09-30)

Each row is an independent slice; claim them as `6798:<slug>` slices.

| slice | source | wasm | JS | where to look |
|---|---|---|---|---|
| `typeof-class` | `typeof (class {})` | `"object"` | `"function"` | host-lane `typeof` on a class value; #6420 fixed the standalone lane only |
| `typeof-tdz` | `(() => { const t = typeof y; let y = 1; return t })()` | `"number"` | throws `ReferenceError` | TDZ check exists for plain reads (verified) but `typeof` takes the static-type shortcut |
| `yield-star-return` | `function* inner() { yield 1; return "r" } function* outer() { const rv = yield* inner(); yield "o:" + rv }` | `"o:null"` | `"o:r"` | `generators-native.ts` delegation result; related #2035/#1691 |
| `string-bool-union` | `String(false && f())`, `String(true \|\| f())` | `"0"`, `"1"` | `"false"`, `"true"` | a `boolean \| number` union carried as f64 loses the tag at the ToString site |
| `i32-saturate` | `type i32 = number; fromNum(2147483648)` / `NaN` / `i32 / 0` / `% 0` / `-(-2^31)` | `2147483647` / `0` / `2147483647` / `0` / wraps | `\|0` semantics: `-2147483648` / `0` / … | `src/codegen/type-coercion.ts:1057, 1062, 1143, 1176` use `i32.trunc_sat_f64_s`; opt-in feature but silent and inconsistent with the verified ToInt32 behaviour of `\|0`; #4044 notes the sanitizer that would catch this is not required |
| `resolve-stage-catch` | any throw inside the IR resolve stage | warning `type-resolution-unsupported` | — | `src/codegen/index.ts:3357-3391` catches every throw and labels it `unsupported`; designed sites throw bare `Error` (`resolvePositionType`, `:1274/1330/1395/1409/1411`), so a `TypeError` from a real bug is indistinguishable; build/verify/lower stages already use `classifyIrFailure` correctly |

## Correction per slice

- `typeof-class`: port #6420's class-value tag check to the host lane.
- `typeof-tdz`: `typeof <identifier>` on a `let`/`const` binding in its TDZ
  must go through the same TDZ guard as a plain read (the guard is there;
  route the `typeof` operand through it).
- `yield-star-return`: propagate the delegate's `{done: true, value}` value as
  the `yield*` expression result.
- `string-bool-union`: carry the boolean tag (box, or a 2-bit tagged f64
  convention already used elsewhere) through `&&`/`||` when the static type
  is a boolean/number union; at minimum, make ToString of a union operand go
  through the any-box path.
- `i32-saturate`: document the choice in `docs/` **and** make it consistent:
  either `type i32` means ToInt32 (wrap, matches `|0`) or the compiler
  refuses out-of-range literals and traps at runtime. Pick wrap (cheaper to
  reason about, matches the standalone typed-array stores per #2715).
- `resolve-stage-catch`: throw `IrUnsupportedError` at the designed sites,
  classify everything else as `unexpected-internal-throw` (already an
  invariant class in `src/ir/outcomes.ts:96-120`).

## Acceptance

- Each row's wasm column equals the JS column; one regression test per slice
  under `tests/equivalence/`.
- `resolve-stage-catch`: a test injects a `TypeError` into `resolvePositionType`
  and asserts a hard compile error, not a warning.
