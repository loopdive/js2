---
id: 3724
title: "Standalone `re.test(x)`/`re.exec(x)` refused any argument not PROVABLY a string — in front of a ToString that was already running"
loc-budget-allow:
  # The argument-coercion path (ToString ahead of the match) is emitted by the
  # standalone RegExp lowering itself, so the ~74 net lines land in this file.
  - src/codegen/regexp-standalone.ts
status: done
sprint: 77
created: 2026-07-28
updated: 2026-07-30
completed: 2026-07-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp
goal: standalone-gap
related: [1539, 3725, 1712, 682]
---

# #3724 — the standalone RegExp argument gate was refusing work the lane already did

## Problem

`re.test(x)` / `re.exec(x)` under `--target standalone` refused unless the
checker could PROVE `x` was a string:

```
Codegen error: standalone RegExp engine does not support
RegExp.prototype.test argument coercion (#1539 Phase 2a).
```

That reads like a missing engine feature. It is not. `re.test(x)` never
required a string — §22.2.6.16 calls `ToString(x)` first, so `re.test(12)`
tests against `"12"`.

And the standalone lane **already implemented that**: `emitRegexSearchCall`
routes every subject through the runtime `__extern_toString` before flattening
it. `isStringLikeArg` was a conservative guard standing in front of a
conversion that was already happening.

## Impact — one guard, ~60 sites

Acorn is plain JavaScript, so run through a TypeScript checker most of its
values are `any`; its tokenizer is built on regexes. **Roughly 60 `.test`/
`.exec` call sites in the compiled-Acorn standalone module hit this single
guard.**

Worse, those refusals were **invisible**: #3725 showed the speculative rollback
erases a `reportError(...); return null` refusal and substitutes a value, so
the build reported `success: true` with zero errors while ~60 regex calls had
been quietly replaced. The compiled-Acorn standalone acceptance test (#1712)
was green on top of that.

## Fix

Replace the "must be provably a string" gate with "can this be coerced to one",
which is what the emitted code already assumes. Verified by construction for
values originating **in-module** (the supported standalone case), each matching
the spec's ToString:

| `any` holding | ToString            | regex sees                      |
| ------------- | ------------------- | ------------------------------- |
| `12`          | `"12"`              | matches `/^1/`                  |
| `undefined`   | `"undefined"`       | matches `/^undefined$/`         |
| `null`        | `"null"`            | matches `/^null$/`              |
| `{}`          | `"[object Object]"` | matches `/^\[object Object\]$/` |
| a string      | itself              | matches                         |

`exec` captures are real, not just a boolean: `/(b+)/.exec(v)` on an
`any`-typed `"abbbc"` yields `"bbb"`, and `/0(5)/.exec(v)` on the number `4056`
yields `"5"` — i.e. the match ran against the stringified form.

**Symbol stays refused.** `ToString(symbol)` throws a TypeError (§7.1.17) and
this lane cannot raise one, so silently stringifying it would be wrong rather
than merely unsupported. A union is admitted only if no constituent is
symbol-like.

## Result

`#1539` refusals during a full compiled-Acorn standalone build: **~60 → 0**
(measured by instrumenting the refusal reporter and compiling acorn through
`tests/issue-1712-standalone.test.ts`).

Because the count is now zero, the remaining `#1539` refusals were also marked
`sticky` (#3725): they now fail the build honestly instead of being erased and
papered over. That closes the RegExp half of #3725's audit — it cost nothing
precisely because there was nothing left to swallow.

## Not in scope (pre-existing, separate)

Passing a **JS** string into a standalone module across the host boundary does
not work and never did: a standalone string is a WasmGC `$AnyString`, so even a
`(s: string)` parameter throws `type incompatibility when transforming from/to
JS`. That is the standalone ABI, not this gate — confirmed by control
experiment, since an `any`-typed parameter fed from JS coerces to the wrong
thing while the identical in-module value is correct.

## Acceptance criteria

- [x] `re.test`/`re.exec` accept an `any`-typed subject in standalone and match
      against its ToString.
- [x] Captures are correct on a coerced subject.
- [x] A symbol argument is still refused.
- [x] `#1539` refusal count in compiled Acorn is 0.
- [x] Pinned by `tests/issue-3724-standalone-regexp-tostring-arg.test.ts` (10 cases).
