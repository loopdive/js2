---
id: 4224
title: "standalone String.prototype.replace: function replacers and non-string replacement values"
status: done
sprint: 78
created: 2026-08-08
completed: 2026-08-08
priority: high
horizon: m
feasibility: medium
task_type: feature
area: codegen
goal: standalone-gap
related: [1474, 1539, 1913, 3567, 4016]
loc-budget-allow:
  # The dispatch site for `replace` lives here and nowhere else: the new arm is
  # a ~15-line branch that must run BEFORE `tryRefuseHostFreeRegExpReplacer`,
  # plus `export` keywords on four field constants and three helpers the new
  # satellite modules consume. The walk itself is in `regex-replace-fn.ts` and
  # the replacement-value decision in `string-proto-replace.ts`, so the god-file
  # takes only the routing.
  - src/codegen/regexp-standalone.ts
  # +9 lines: the STRING-lane dispatch is a 6-line delegation to
  # `string-search-value.ts` (which owns the search-value decision) plus its
  # comment. The `replace`/`replaceAll` arms it guards live here and nowhere
  # else, so the guard has to sit in front of them.
  - src/codegen/string-ops.ts
func-budget-allow:
  # Same +9 lines seen per-function. Splitting this 1200-line dispatcher is
  # #3399 work, not a rider on a correctness fix; the new logic is already
  # extracted into two satellite modules.
  - src/codegen/string-ops.ts::compileNativeStringMethodCall
origin: "2026-08-08 — ES5-standalone-90 WP3, from the `built-ins/String/prototype/replace` failure bucket"
---

# #4224 — standalone `String.prototype.replace`: function replacers and non-string replacements

## Problem

In `--target standalone`, every `String.prototype.replace` form except
"static RegExp + statically-string replacement" was refused at compile time:

```
Codegen error: standalone RegExp engine does not support replace with a
function (or non-string) replacer (#1913 follow-up) (#1539 Phase 2a).
```

That message conflated two different questions, exactly as #4016 found for the
SEARCH value:

1. **Non-callable, non-string replacement** (`void 0`, `1`, `null`). §22.2.6.11
   step 2 says *"If `IsCallable(replaceValue)` is false, set `replaceValue` to
   `ToString(replaceValue)`"*. No new machinery is needed — the `$`-substitution
   engine `__regex_get_substitution` (#1913) already consumes an arbitrary
   `$AnyString`. The argument only ever needed routing through the same runtime
   `ToString` the `+`-concat engine uses.
2. **Callable replacement**. This genuinely needs new machinery, because the
   match walk lives inside the closed runtime helper `__regex_replace`, which
   cannot call back out to a user closure.

Worse, the string-search arm (`"abc".replace("b", …)`) had **no** gate at all on
its replacement value: it compiled the argument straight into a
`ref $AnyString` slot. A function replacer produced `RuntimeError: illegal cast`
and a numeric one produced a module that failed `WebAssembly.compile`
("call[0] expected type (ref null 3), found f64.const"). Both were silent —
green compile, broken binary.

## Fix

Three pieces:

- **`src/codegen/string-proto-replace.ts`** (new) — owns the §22.2.6.11 step-2
  decision: `isPlainToStringReplacement` (provably non-callable ⇒ ToString path)
  and `isCallableReplacement` (provably a function ⇒ call-per-match path). A
  value that is neither (`any`/`unknown`) lands in **neither** arm and keeps the
  existing refusal — guessing would be a wrong answer, not a missing feature.
- **`src/codegen/regex-replace-fn.ts`** (new) — re-emits the §22.2.6.11 walk at
  the CALL SITE for a callable replacer, so the closure's `call_ref` is in
  scope. Mirrors `__regex_replace`'s loop instruction-for-instruction
  (`__regex_search` / `__str_substring` / `__str_concat`), so empty-match
  advance and the global/non-global split are shared by construction.
- **`regexp-standalone.ts`** — routes to the new arm before the refusal, and
  emits the non-callable replacement through the spec `ToString`.

Two details that were easy to get wrong and are covered by tests:

- **Under-arity replacers.** test262 writes its replacers as
  `function () { return arguments[2] + arguments[1]; }` — zero declared
  parameters. A `call_ref` marshals exactly `paramTypes.length` formals, so the
  arguments would simply vanish. The overflow rides the `__extras_argv` /
  `__argc` globals an ordinary indirect call already uses (#1053/#1511).
- **Unmatched captures are `undefined`, not `null`.** `ref.null.extern` is the
  JS `null` value on this boundary; the module's undefined singleton is the
  right sentinel, or `"null"` shows up in the output text.

The closure is staged into a DETACHED instruction buffer so an unresolvable
replacer can still decline without having written a half-built expression into
`fctx.body` behind the caller's fall-through refusal (#1919 speculative-miss
shape).

## Scope / what stays refused

- A **runtime-only** RegExp value: the capture count fixes the closure's
  argument count at compile time, so a non-static pattern keeps the refusal.
- **WASI**: no native RegExp lowering on this path; the refusal is unchanged
  and is still asserted by `tests/issue-1539-standalone-regex-replace.test.ts`.
- A replacement whose callability cannot be proven (`any`/`unknown`).

## Acceptance criteria

- [x] `"abc12 def34".replace(/([a-z]+)([0-9]+)/, fn)` works host-free, with the
      spec argument list `« matched, …captures, position, string »`.
- [x] A zero-declared-param replacer reading `arguments` sees every argument.
- [x] A non-callable replacement (`void 0`, `1`, `null`) is `ToString`-ed.
- [x] `$`-substitution in a string replacement is unaffected.
- [x] WASI still refuses; the refusal cites a real source line.

## Measured test262 flips (standalone lane)

A/B measured by running each whole directory through `runTest262File(…, "standalone")`
with only the four changed `src/codegen` files swapped between `origin/main` and this
branch. **+19 pass, 0 regressions.**

| directory | base pass | after pass |
| --- | --- | --- |
| `built-ins/String/prototype/replace` (55 files) | 23 | 37 |
| `built-ins/String/prototype/replaceAll` (45 files) | 10 | 15 |

Newly passing:

- **RegExp + function replacer** — `S15.5.4.11_A4_T1..T4` (all four read
  `arguments` from a zero-param replacer), `S15.5.4.11_A12`, `15.5.4.11-1`.
- **Non-callable replacement ToString** — `S15.5.4.11_A1_T7`, `_T8`, `_T14`,
  `replaceValue-evaluation-order`.
- **String search lane** — `S15.5.4.11_A1_T4`,
  `cstm-replace-on-{bigint,boolean,number}-primitive`,
  `cstm-replaceall-on-{bigint,boolean,number}-primitive`,
  `replaceValue-call-abrupt`, `replaceValue-call-skip-no-match`.

## Still failing (out of scope, unchanged)

| test | why |
| --- | --- |
| `S15.5.4.11_A1_T1`, `_T2` | transferred `String.prototype.replace` on a `Boolean`/`Object` receiver — needs the reflective/native-proto arm (`native-proto.ts`), not the replacement gate |
| `S15.5.4.11_A1_T5`, `_T6` | `Function("…")` replacer — runtime-eval gated |
| `S15.5.4.11_A1_T9` | `new String(obj)` where `obj.toString` is `undefined` and `valueOf` returns `undefined` — a wrapper-coercion bug, not a replace bug |
| `S15.5.4.11_A1_T10` | replacer returns an uninitialised `var`; the value reaches ToString as `ref.null.extern` and stringifies to `"null"` instead of `"undefined"` — an undefined-representation issue in closure returns |
| `S15.5.4.11_A1_T11`, `_T12`, `_T13` | object search value with a THROWING `toString`; needs observable coercion ordering, and an object search value deliberately keeps the refusal (see the asymmetry note above) |
| `cstm-replace-*`, `length`, `name`, `tostring-this-throws-*` | `@@replace` protocol dispatch / function-property reflection / runtime-eval — unrelated lanes |
