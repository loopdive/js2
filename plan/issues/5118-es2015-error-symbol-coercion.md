---
id: 5118
title: "ES2015 standalone Error ToString(Symbol) must throw TypeError"
status: done
sprint: current
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: error-symbol-coercion
es_edition: es2015
goal: standalone-mode
pr: 5131
assignee: "ttraenkler/codex/5118-es2015-error-symbol-coercion"
files:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls.ts
  - tests/issue-5118-es2015-error-symbol-coercion.test.ts
  - plan/issues/5118-es2015-error-symbol-coercion.md
loc-budget-allow:
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/array-object-proto.ts::emitErrorProtoToStringBody
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
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

The existing `$Error_struct` renderer is intentionally limited to native Error
instances. It cannot implement the failing prototype row: that row invokes
`Error.prototype.toString` with an ordinary object receiver, whose `name` and
`message` properties (including accessors and inherited properties) must be
looked up dynamically. The standalone reflective prototype route is owned by
`src/codegen/array-object-proto.ts`; before this fix it emitted only the
catchable refusal body. A shared Error/NativeError body must perform
the §20.5.3.4 Type(V)-is-Object receiver check (with null/undefined rejected
separately), then `Get(name)`/ToString(name), then `Get(message)`/ToString(message),
rejecting a native `$Symbol` carrier at each ToString step. The existing
general-purpose `__any_to_string` and native
`__error_to_string` helpers remain unchanged, so ordinary object/string/date
coercion outside this body is not widened.

## Evidence before implementation

- Host mode is already correct because `env::__new_Error` and the native-error
  imports resolve to JavaScript constructors; all three host rows pass.
- Standalone Symbol values are lowered as branded i32 ids and boxed to an
  interned `$Symbol` carrier when crossing the `externref` message boundary;
  the carrier's nominal type is available as `ctx.symbolTypeIdx`.
- `emitThrowTypeError` builds the in-module TypeError and exception payload in
  standalone, preserving the required constructor identity. The constructor
  guard evaluates every supplied argument in source order before emitting the
  final TypeError, so a later abrupt argument completion wins over the first
  message's ToString failure. The prototype body keeps name access/coercion
  before message access/coercion and applies the same strict Symbol check to
  dynamic carriers.
- No host import or raw checker query is needed. The constructor guard can
  statically recognize a Symbol expression and evaluate/drop it before
  throwing; the Error stringifier can dynamically `ref.test` the native
  `$Symbol` carrier after name evaluation. Dynamic constructor bodies ensure
  that carrier before minting their guard only when the oracle message fact
  can carry Symbol (`symbol`, `any`, `unknown`, `unresolvable`, or a union
  containing one), so ordinary string messages do not gain the carrier cost.

### Related unclassified rows

The three same-seam `ToPrimitive` siblings are not classified as ES2015 in
`test262-file-editions.json`, so they remain regression evidence rather than
part of the authoritative cohort or exact-row test list. A fresh candidate
run with the pinned QuickJS artifact and one worker reports host `pass` for
all three but standalone `fail` for all three:

- `built-ins/Error/error-message-tostring-toprimitive.js`
- `built-ins/Error/prototype/toString/tostring-message-throws-toprimitive.js`
- `built-ins/NativeErrors/nativeerror-tostring-message-throws-toprimitive.js`

Their residual is the separate object `ToPrimitive`/method-coercion path; this
bounded Symbol-only change intentionally does not widen into that helper. The
follow-up should own those rows if that path is made strict, with a separate
baseline and regression cohort.

## Bounded implementation plan

1. Add a standalone-only Symbol message guard to the shared Error-family
   constructor lowering in `new-builtin-globals.ts`. Evaluate every supplied
   argument exactly once in source order, preserve its side effects and abrupt
   completion priority, then emit a real TypeError with the canonical
   Symbol-to-string message. Keep host mode and all non-Symbol message values
   on their current path; both `new` and call-without-`new` use this emitter.
   Evaluate/drop later arguments after a dynamic first message and ensure the
   native Symbol carrier before baking that dynamic guard, including when the
   Error callee compiles before its caller.
2. Implement the standalone reflective Error/NativeError
   `Error.prototype.toString` body in `array-object-proto.ts`. Enforce the
   §20.5.3.4 Type(V)-is-Object receiver check (including number, string,
   boolean, null/undefined, and Symbol receivers), ordered name-before-message
   property access and coercion, strict dynamic `$Symbol` rejection,
   empty-name/message cases, inherited NativeError behavior, and ordinary
   object/function/array messages. The narrow `calls.ts` syntax resolver maps
   `Error.prototype.toString` and NativeError prototype spellings to this
   existing glue and promotes only the direct object-literal receivers whose
   properties need dynamic `[[Get]]`; it does not alter other prototype
   families. Leave the generic and `$Error_struct` string helpers unchanged.
3. Add `tests/issue-5118-es2015-error-symbol-coercion.test.ts`. Mandatory
   compiler controls always run without Test262; exact host/standalone corpus
   rows are under a worktree-independent `describe.skipIf` corpus guard. Use
   Vitest timeouts above the runner's 120s per-row budget. Controls cover
   side-effect and throw priority, positive string/undefined messages, exact
   TypeError identity, primitive receiver rejection, ordered getters,
   empty/inherited/NativeError cases, ordinary object messages, and zero
   standalone host imports. Include callee-before-caller dynamic-carrier and
   dynamic-first-message/later-abrupt controls for both constructor spellings,
   plus a compact host bundle covering the changed host argument path.
4. Run fresh exact A/B and repeat/determinism using
   `JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`
   with at most two workers. Run focused/related tests, no-corpus shape,
   type/lint/format, budgets/ratchets, issue collision checks, and full
   pre-push. Record all final evidence and the handoff here.

## Acceptance

- The exact three rows are pass in both host and standalone lanes.
- The standalone implementations throw a real `TypeError` for Symbol message
  coercion, with correct identity, and have zero host imports.
- Error/NativeError constructor argument evaluation and the shared
  Error.prototype.toString name-before-message access/coercion order remain
  observable and correct, including primitive receiver TypeError and
  empty-name/message handling.
- Positive string and undefined-message behavior remains correct; unrelated
  object/string/date behavior is unchanged.
- Mandatory no-corpus compiler controls run and pass even when `test262/test`
  is absent; corpus rows skip only when their exact files are unavailable.
- Focused and related tests, type/lint/format, budgets/ratchets, collision
  checks, and full pre-push are clean.

## Handoff

The canonical tracker is this markdown issue, `plan/issues/5118-es2015-error-symbol-coercion.md`;
no GitHub issue was created. The implementation was synchronized with
`upstream/main` and validated at code head
`695893a6b7e519118644f0430de00e5c3b2f879d` on branch
`codex/5118-es2015-error-symbol-coercion`.

Final evidence on that head:

- focused Vitest: **23/23 passed**;
- exact Test262 host cohort: **3/3 passed**;
- exact Test262 standalone cohort: **3/3 passed**;
- standalone controls emitted zero host imports;
- TypeScript 7, lint, Prettier, oracle/coercion ratchets, LOC budget, and
  function budget passed;
- the repository pre-push hook completed and the exact head was confirmed on
  `ttraenkler/js2` without rewriting published history;
- `git diff --check` passed, `upstream/main` is an ancestor, and the worktree
  was clean after the push.

The later handoff/PR-link commits are documentation-only and do not change the
validated code. The single non-draft upstream PR is
<https://github.com/loopdive/js2/pull/5131>. It was opened from the
`ttraenkler/js2` branch, targets `loopdive/js2:main`, uses the repository PR
template with the CLA checked, and was audited as mergeable with no comments,
reviews, or unresolved review threads at creation.
