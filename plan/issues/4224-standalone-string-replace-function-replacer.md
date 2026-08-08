---
id: 4224
title: "standalone String.prototype.replace: function replacers and non-string replacement values"
status: in-progress
sprint: current
created: 2026-08-08
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

`built-ins/String/prototype/replace`, compile_error/fail → pass:

| test | was | now |
| --- | --- | --- |
| `S15.5.4.11_A1_T8` | compile_error | pass |
| `S15.5.4.11_A1_T14` | compile_error | pass |
| `S15.5.4.11_A4_T1` | compile_error | pass |
| `S15.5.4.11_A4_T2` | compile_error | pass |
| `S15.5.4.11_A4_T3` | compile_error | pass |
| `S15.5.4.11_A4_T4` | compile_error | pass |
| `S15.5.4.11_A12` | compile_error | pass |
| `15.5.4.11-1` | compile_error | pass |
