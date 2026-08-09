---
id: 3507
title: "Standalone native RegExp values lose identity across function, object, and array carriers"
status: done
sprint: 73
created: 2026-07-20
updated: 2026-07-21
completed: 2026-07-20
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bug
area: standalone, regexp, codegen
goal: standalone-mode
language_feature: regexp
parent: 2161
related: [1474, 1539, 2175, 2961]
assignee: ttraenkler/fix_3507_standalone_regexp_carrier
origin: "2026-07-20 FYI standalone preliminary harvest at project 422608b2"
files:
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/regexp-standalone.ts
  - tests/issue-682.test.ts
  - tests/issue-3507.test.ts
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/expressions/calls-closures.ts
---

# #3507 — Standalone native RegExp carrier dispatch

Focused successor to blocked umbrella #2161. This issue is independent of
#2175's `RegExp.prototype` reflection work: the RegExp values here are already
created by the standalone native engine, but cease to be recognized after they
move through an ordinary value carrier.

## Problem

The preliminary FYI standalone harvest contains **592** failures whose sole
host-import leak is `env::RegExp_test`. Of those, **555** are generated property
escape / UnicodeSets tests in which a compile-time RegExp literal crosses a
`regExpUtils.js` helper parameter or object property before `.test`; another 12
cross an array and `for-of` binding.

Current-main revalidation at `6a2bb824` confirms the three representative rows
are official standalone `compile_error`s with `env::RegExp_test` in the
authoritative baseline. The same files reach RegExp execution in the in-process
runner, proving that the pattern parser and native VM are present; the
standalone import gate exposes the dispatch error.

Representative paths:

- `built-ins/RegExp/property-escapes/generated/Alphabetic.js`
- `built-ins/RegExp/unicodeSets/generated/string-literal-union-character.js`
- `built-ins/RegExp/CharacterClassEscapes/character-class-digit-class-escape-positive-cases.js`

## Root cause

`tryCompileStandaloneRegExpTest` accepts a statically `RegExp`-typed receiver,
but `loadStandaloneRegExpStruct` only recovers an `externref` receiver when its
_syntax_ is a literal/constructor or a never-reassigned local initialized by
one. Function parameters, object-property reads, array elements, and `for-of`
bindings erase that syntactic provenance even though the runtime value remains
the exact `$NativeRegExp` struct produced by this backend. The native arm then
refuses or falls through and the generic method path emits `env::RegExp_test`.

The fix must recover the backend struct by runtime identity/brand at the
`RegExp`-typed call boundary. It must not infer or rebuild a pattern from a
carrier, and it must not accept genuinely runtime-created pattern strings.

## Acceptance criteria

- A compile-time native RegExp survives a function argument, object-property
  read, array element, and `for-of` binding; `.test` dispatches to the native
  engine.
- The three representative Test262 files compile/run standalone with zero
  `env::RegExp_test` imports.
- Unicode property escapes and `u`/`v` matching retain their existing native
  semantics; direct literal/constructor controls remain unchanged.
- `new RegExp(runtimePattern)` and equivalent truly dynamic patterns remain a
  loud standalone unsupported error; no JS-host RegExp fallback is introduced.
- Exported/opaque host RegExp parameters do not silently become native values:
  runtime recovery succeeds only for this module's `$NativeRegExp` carrier.
- No Test262 source, harness, metadata, fixture, or FYI wrapper is rewritten.

## Validation plan

- Focused `tests/issue-3507.test.ts` carrier, semantics, import, and refusal
  controls.
- Exact representative files through the standalone Test262 path.
- Existing direct native RegExp and narrowed-refusal suites.
- Typecheck, Prettier, issue-ID/format, hard-error, stack-balance, and IR
  fallback gates.

## Implementation notes

The repair uses runtime identity at both type-erasure boundaries rather than
reconstructing regex source:

- Statically `RegExp`-typed externref receivers now pass through the existing
  catchable `$NativeRegExp` brand recovery used by reflective prototype calls.
  This admits function/array/property carriers created by the module while a
  foreign host RegExp still fails the brand check.
- An untyped `.test(value)` no longer first-matches the ambient RegExp extern
  class in standalone mode. The closed-method dispatcher has a dedicated
  `$NativeRegExp` arm and calls a native test helper only after `ref.test`
  succeeds; other receiver shapes continue to the existing object/user-method
  arms.
- The carrier helper reads `g`/`y` flags at runtime, starts from `lastIndex`, and
  updates it after success/failure. Direct statically-known RegExp lowering is
  unchanged.
- Dynamic constructor refusals return a typed `unreachable` placeholder after
  reporting. This prevents the generic speculative expression wrapper from
  rolling the diagnostic back when it sees a null result; no runtime-pattern or
  host fallback was added.

## Test results

- `tests/issue-3507.test.ts`: 8/8 pass, covering typed parameters, untyped
  helper/object properties, array/for-of carriers, `g` lastIndex behavior,
  dynamic-pattern refusal, and all three exact Test262 representatives.
- Exact representatives all clear the standalone compile/import gate and enter
  runtime without `env::RegExp_test`. The pre-existing Unicode-data-version
  assertion in `Alphabetic.js` remains a semantic runtime result, not a carrier
  or host-import failure.
- Focused `tests/issue-682.test.ts` direct/static and foreign-brand controls:
  7/7 pass.
- Focused `tests/issue-1474-standalone-regex-refuse.test.ts` dynamic constructor
  controls: 2/2 pass.
- `pnpm run typecheck`, Prettier, issue-ID/metadata, hard-error,
  stack-balance, and IR-fallback gates pass. IR unintended/module-level deltas
  remain zero; Test262 hard errors remain zero.
