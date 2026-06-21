---
id: 2160
title: "Standalone String/Number method & coercion conformance residual (~635 tests)"
status: ready
sprint: 63
created: 2026-06-15
updated: 2026-06-21
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: string-number
goal: standalone-mode
parent: 1470
depends_on: [1917, 2104]
---

# Standalone String/Number method & coercion conformance residual

## Problem

Wasm-native string methods and standalone number formatting landed in #1470,
#1335, #1105 (all `done`, sprints 58–61). The host-vs-standalone baseline
diff (sha `31fa7e099`, 2026-06-15) shows **635 tests pass in host mode but
fail standalone**, attributed to String/Number method and coercion residuals.

## Evidence

- Gap categories: `built-ins/String` (643), `built-ins/Number` (159),
  plus String/Number coercion in `language/expressions`.
- Partly overlaps the coercion engine (#1917) and value-rep boxing
  (#2072/#2104) work — `__new_String`/`__new_Number` wrapper boxing leaks.

## Acceptance criteria

- Standalone pass count for `built-ins/String` + `built-ins/Number` rises
  toward host parity.
- No `__new_String`/`__new_Number` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1470. Sequenced after the coercion engine (#1917) and
value-rep P1 (#2104). Part of sprint-62 standalone catch-up (rank 4 by gap
impact).

---

## Progress (2026-06-16, dev3) — `Number.parseInt`/`Number.parseFloat` slice

**Status stays `ready`** — this is one independent slice of the 635-test
bucket, landable now (not gated on #1917/#2104).

Re-measured against `origin/main` @ `5634b13ec`: the common String/Number
methods + coercion already pass standalone (padStart/padEnd/repeat/trim/
includes/startsWith/endsWith/at/codePointAt/replaceAll; toFixed/toPrecision/
toExponential/toString(radix); Number.isInteger/isNaN/isFinite/isSafeInteger;
bare parseInt/parseFloat; `+str`/`str*num`/`str+num` coercion; template
literals; String(num); `-0`/NaN/1e21 formatting). Many were closed by the
value-rep P0/P1 work that just landed.

**One concrete independent bug fixed (this PR):** `Number.parseInt` /
`Number.parseFloat` (the §21.1.2.12-13 namespaced aliases — same functions as
the globals) failed to compile in standalone with a `__get_builtin` codegen
error, while the bare `parseInt`/`parseFloat` worked. Root cause: the parse
import-collector (`src/codegen/declarations.ts`) only recognized the *bare
identifier* call form, so the `Number.`-prefixed property-access form never
registered the native WasmGC scanner; the call-site routing
(`calls.ts`, which reads `funcMap.get("parseInt"/"parseFloat")`) then fell
through to the dynamic-shape `__get_builtin` refusal. Fix: detect the
`Number.parseInt`/`Number.parseFloat` call shape in the collector and add the
same helper to `parseNeeded`. Regression test:
`tests/issue-2160-number-parse.test.ts` (8 cases × host/standalone).

**Still open (the bulk of the 635):** the remaining residuals are the
**wrapper objects** `new String(...)` / `new Number(...)` (standalone null-deref
/ wrong `valueOf` — gated on value-rep boxing #2072/#2104, and noted in the
acceptance criteria's `__new_String`/`__new_Number` leak) plus the harder
String/Number coercion edges that overlap the coercion engine (#1917). Those
remain the value-rep / #1917 territory called out in the original notes.

---

## Slice (2026-06-21, dev-agent) — `Number.prototype.toLocaleString()` standalone

One more independent primitive-level slice of the 635-bucket (no wrapper
objects, no value-rep gate). `(n).toLocaleString()` with **no arguments**
compiled in host mode but hit a hard `compile_error` standalone/WASI:
`'__extern_toLocaleString' (dynamic-shape …)` — the host import has no native
fallback, so every numeric `toLocaleString()` was a standalone CE.

**Spec (§21.1.3.4):** with no ECMA-402 (Intl) implementation, the result of
`Number.prototype.toLocaleString()` equals `ToString(value)` base 10 — the
implementation-defined locale formatting reduces to plain ToString.

**Fix (no new coercion site beyond reusing the existing engine helper):** in
the number-method collector (`src/codegen/declarations.ts`) and the call-site
router (`src/codegen/expressions/calls.ts`), add a `toLocaleString` arm gated on
`(ctx.standalone || ctx.wasi)` + 0 args that routes to the **existing**
`number_toString` lowering (identical to the 0-arg `.toString()` arm), unwrapping
the native-string externref once for native-strings mode. **Host (gc) mode is
intentionally excluded** — it keeps the `__extern_toLocaleString` import so real
Intl grouping is preserved (`(1234).toLocaleString() === "1,234"`). A call WITH a
locale argument also falls through to the host path (real Intl out of scope).

The coercion-sites drift gate (#2108) counts the two new `number_toString`
references (declarations 17→18, calls 18→19) — these reuse the sealed engine
vocabulary, not a hand-rolled matrix, so the baseline was refreshed
(`scripts/coercion-sites-baseline.json`).

**Validation.** `tests/issue-2160-number-tolocalestring-standalone.test.ts`
(8/8): standalone compiles + no `__extern_toLocaleString` leak; exact char
content for int/negative/fractional/zero/variable receivers; host-mode
no-regression guard (host still imports `__extern_toLocaleString`). Existing
`tests/issue-2160-number-parse.test.ts` (16/16) + native-strings (91) green.
tsc + prettier + format:check + coercion-sites gates clean. Standalone-only;
host untouched.

**Still open (unchanged):** wrapper objects `new String`/`new Number`
construction still leaks `__new_String`/`__new_Number` (no native wrapper-object
representation — gated on value-rep #2072/#2104); `str.replace(fn)` standalone
(RegExp engine limitation). Those stay value-rep / RegExp territory.
