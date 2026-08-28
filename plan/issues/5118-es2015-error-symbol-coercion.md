---
id: 5118
title: "ES2015 standalone Error ToString(Symbol) must throw TypeError"
status: in-progress
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: error-symbol-coercion
es_edition: es2015
goal: standalone-mode
assignee: "ttraenkler/codex/5118-es2015-error-symbol-coercion"
files:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/native-strings.ts
  - tests/issue-5118-es2015-error-symbol-coercion.test.ts
  - plan/issues/5118-es2015-error-symbol-coercion.md
loc-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/native-strings.ts
---

# #5118 — ES2015 standalone Error `ToString(Symbol)` must throw TypeError

## Exact cohort and baseline (2026-08-28)

The owned cohort is exactly these three ES2015 Test262 rows:

- `test/built-ins/Error/error-message-tostring-symbol.js`
- `test/built-ins/Error/prototype/toString/tostring-message-throws-symbol.js`
- `test/built-ins/NativeErrors/nativeerror-tostring-message-throws-symbol.js`

The authoritative standalone snapshot is
`/private/tmp/js2-baseline-standalone-current-20260828.jsonl`, SHA256
`260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`.
The matching host snapshot is
`/private/tmp/js2-baseline-host-current-20260828.jsonl`, SHA256
`a395f2a88d289a8e0fd78ccd76e090215ef3a85f1960aa8fe96f7d3a0445bd49`.
Both contain 48,735 rows at oracle version 13. The three host rows are
`pass` (3/3); the three standalone rows are `fail` (0/3), all
`assertion_fail`, `reached_test: true`, with no compile errors, compile
timeouts, or skips in this cohort.

Exact baseline row evidence:

| row | host | standalone | standalone evidence |
| --- | --- | --- | --- |
| `built-ins/Error/error-message-tostring-symbol.js` | pass | fail | `If _message_ is a Symbol, Error must throw TypeError`; no exception was thrown |
| `built-ins/Error/prototype/toString/tostring-message-throws-symbol.js` | pass | fail | `If message field is a symbol, Error.prototype.toString must throw a TypeError`; no exception was thrown |
| `built-ins/NativeErrors/nativeerror-tostring-message-throws-symbol.js` | pass | fail | `If _message_ is a Symbol, EvalError should throw a TypeError`; no exception was thrown |

The source checkout is based directly on freshly fetched `upstream/main` at
`fefcf1348e979651142128098b629cf7328b2517`; its Test262 gitlink is pinned to
`b363f29d3c43c626dc852744ad64a0b48a003693`.

## Specification and root cause

ECMAScript [§20.5.1.1 Error](https://tc39.es/ecma262/#sec-error-constructor)
step 3.1 performs `? ToString(message)` whenever `message` is not undefined.
The NativeError constructors use the same message algorithm in
§20.5.6.1.1. [§20.5.3.4 Error.prototype.toString](https://tc39.es/ecma262/#sec-error-prototype-tostring)
gets `name` first, then gets and `ToString`s `message`; a Symbol message must
therefore throw a TypeError after the name access/coercion has completed.

In standalone/native-first codegen, `new Error(message)` and each NativeError
constructor are handled by `tryCompileBuiltinGlobalNew` in
`src/codegen/expressions/new-builtin-globals.ts`. The first argument is coerced
to `externref` and sent through `__any_to_string`, but that dispatcher has no
Symbol-carrier arm. A native Symbol is a `$Symbol` carrier (`symbol-native.ts`)
and consequently falls into the object/non-string fallback instead of throwing.
The native `$Error_struct` constructor in `registry/error-types.ts` stores the
already-coerced message, so the narrow fix belongs at the shared Error-family
call site and covers Error plus NativeError constructors without changing the
struct layout.

The native `__error_to_string` helper in `src/codegen/native-strings.ts` reads
the `$Error_struct` name and message fields. Its message arm recognizes native
strings and treats every other value as empty; a Symbol carrier therefore
returns the name instead of throwing. The same helper is shared by native
Error rendering, so adding a Symbol-only TypeError arm there covers
`Error.prototype.toString` while leaving ordinary object/string/date paths
unchanged. The helper must retain its existing name-before-message sequence.

## Evidence before implementation

- Host mode is already correct because `env::__new_Error` and the native-error
  imports resolve to JavaScript constructors; all three host rows pass.
- Standalone Symbol values are lowered as branded i32 ids and boxed to an
  interned `$Symbol` carrier when crossing the `externref` message boundary;
  the carrier's nominal type is available as `ctx.symbolTypeIdx`.
- `emitThrowTypeError` builds the in-module TypeError and exception payload in
  standalone, preserving the required constructor identity. Existing
  `emitSymbolOperandCoercionThrow` demonstrates the repository's side-effect
  ordering rule: evaluate the Symbol operand before emitting the throw.
- No host import or raw checker query is needed. The constructor guard can
  statically recognize a Symbol expression and evaluate/drop it before
  throwing; the Error stringifier can dynamically `ref.test` the native
  `$Symbol` carrier after name evaluation.

## Bounded implementation plan

1. Add a standalone-only Symbol message guard to the shared Error-family
   constructor lowering. Evaluate the argument exactly once, preserve its
   side effects, then emit a real TypeError with the canonical Symbol-to-string
   message. Keep host mode and all non-Symbol message values on their current
   path; cover both `new` and call-without-`new` through the shared emitter.
2. Extend the native `$Error_struct` `__error_to_string` message arm with a
   `$Symbol` carrier check that throws a TypeError before the non-string-empty
   fallback. Keep name retrieval/coercion before that check and retain existing
   native string, undefined, object, and date behavior.
3. Add `tests/issue-5118-es2015-error-symbol-coercion.test.ts`. Mandatory
   compiler controls always run without Test262; exact host/standalone corpus
   rows are under a worktree-independent `describe.skipIf` corpus guard. Use
   Vitest timeouts above the runner's 120s per-row budget. Controls cover
   side-effect and throw priority, positive string/undefined messages, exact
   TypeError identity, and zero standalone host imports.
4. Run fresh exact A/B and repeat/determinism using
   `JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`
   with at most two workers. Run focused/related tests, no-corpus shape,
   type/lint/format, budgets/ratchets, issue collision checks, and full
   pre-push. Record all final evidence and the handoff here.

## Acceptance

- The exact three rows are pass in both host and standalone lanes.
- The standalone implementations throw a real `TypeError` for Symbol message
  coercion, with correct identity, and have zero host imports.
- Error/NativeError constructor argument evaluation and Error.prototype.toString
  name-before-message access/coercion order remain observable and correct.
- Positive string and undefined-message behavior remains correct; unrelated
  object/string/date behavior is unchanged.
- Mandatory no-corpus compiler controls run and pass even when `test262/test`
  is absent; corpus rows skip only when their exact files are unavailable.
- Focused and related tests, type/lint/format, budgets/ratchets, collision
  checks, and full pre-push are clean.

## Handoff

The canonical issue is #5118, already reserved by the root agent. No GitHub
issue is to be allocated or created from this lane. The delivery branch is
`codex/5118-es2015-error-symbol-coercion` in
`/private/tmp/js2-es2015-error-symbol-coercion-20260828`; root owns review and
the single non-draft PR against `loopdive/js2:main` after this branch is pushed.
