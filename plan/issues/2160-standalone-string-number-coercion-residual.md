---
id: 2160
title: "Standalone String/Number method & coercion conformance residual (~635 tests)"
status: ready
sprint: 63
created: 2026-06-15
updated: 2026-06-15
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

## Slice (2026-06-21, dev-agent) — `Number.prototype.toLocaleString` for standalone

**Status stays `ready`** — one more independent slice of the 635-bucket,
unblocked (no wrapper substrate / #1917 dependency).

**Bug:** `(n).toLocaleString()` on a number receiver CE'd in standalone / WASI
with `'__extern_toLocaleString' (dynamic-shape object)`. The generic
`toLocaleString` fallback (`src/codegen/expressions/calls.ts`) unconditionally
routes the receiver to the host `__extern_toLocaleString` import; a bare number
is not an extern object, so the standalone codegen refuses it. (Host mode worked
via real Intl, returning grouped output like `"1,234"`.)

**Fix (no-JS-host only):** §21.1.3.4 — there is no Intl in standalone/WASI, and
the no-Intl default is implementation-defined. For a number receiver in
no-JS-host targets, delegate `toLocaleString` to the base-10
`Number.prototype.toString` (the existing native `number_toString`), mirroring
the `toLocaleString → toString` delegation already used elsewhere. The
import-collector (`src/codegen/declarations.ts`) pre-registers `number_toString`
for the `toLocaleString` call shape (gated on `standalone || wasi`) so the call
lowers without a late module-function shift; the call-site (calls.ts) emits the
native call and unwraps to a native string. Locale/options args are ignored.
**JS-host mode is untouched** — it keeps the Intl-backed `__extern_toLocaleString`
(grouping preserved), so no host regression.

**Scope guards:** number receiver only; non-number receivers (Array/TypedArray/
Date/object) keep the host `__extern_toLocaleString` fallback unchanged.

**Validation.** `tests/issue-2160-number-tolocalestring.test.ts` (11/11):
integer/single-digit/fractional/negative number toLocaleString + string
concat across host & standalone, plus a standalone no-`__extern_toLocaleString`-leak
assertion. tsc + prettier clean.

**Follow-ups noted (not in this slice):** the `new String`/`new Number` wrapper
method-dispatch + `.length` + indexing residual is BLOCKED on a native wrapper
constructor — `new String`/`new Number`/`new Boolean` always emit the host
`__new_String`/`__new_Number` imports (new-super.ts), and `__unbox_string` is
host-only, so there is no native wrapper struct / primitive slot to read. That
slice needs the value-rep #2072/#2104/#1910-S2 native wrapper representation
first (senior-dev/value-rep). Separately, `String.raw` emits an invalid
standalone binary (distinct slice).
