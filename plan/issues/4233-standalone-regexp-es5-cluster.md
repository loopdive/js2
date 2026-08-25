---
id: 4233
title: "Standalone: the ES5 RegExp cluster — `env::RegExp_exec` leak, zero-arg `exec`/`test`, `RegExp(R)` identity, undefined pattern/flags"
status: done
completed: 2026-08-08
sprint: 78
created: 2026-08-08
updated: 2026-08-18
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: regexp, native-prototypes, constructor-semantics
goal: es5
related: [682, 1539, 1912, 1913, 2175, 3507, 3724, 4089, 4220, 4224]
# oracle-ratchet: one new getTypeAtLocation in regexp-standalone.ts asks a raw
# ts.Type identity question (is the pattern arg's type THE global RegExp type),
# which is deliberately above what ctx.oracle expresses (CLAUDE.md, #1930);
# consistent with the file's 16 pre-existing checker queries of the same shape.
oracle-ratchet-allow:
  - src/codegen/regexp-standalone.ts
# loc-budget (wave-3 PR aggregate vs main): static-pattern tracing, exec arity/shape and ctor-identity arms live in the regexp subsystem module itself
loc-budget-allow:
  - src/codegen/regexp-standalone.ts
---

# #4233 — the ES5 RegExp cluster in `--target standalone`

Wave 3 of the ES5-standalone-90 % program (`plan/goals/es5-standalone-90.md`).
62 ES5-tagged files touching RegExp were failing in the standalone lane; 7 of
them are `js2wasm:runtime-eval`-gated and out of scope. Four independent root
causes accounted for the bulk of the rest.

## Root cause 1 — `host_import_leak: env::RegExp_exec`

`tryExternClassMethodOnAny` (`src/codegen/expressions/calls-closures.ts`) binds
the FIRST extern class that declares a method name when the receiver is
`any`-typed. `RegExp` is the only extern class declaring `exec`, so the §22.2.6.2
reflective idiom the whole `15.10.6.2_A2_*` battery is written in —

```js
var o = new Object();
o.exec = RegExp.prototype.exec;
o.exec("message to investigate");   // must throw TypeError
```

— bound `env::RegExp_exec`, an import a standalone binary cannot satisfy, so the
module failed to instantiate and every assertion in the file was lost.

`test` already had this refusal (#3507); `exec` was simply left behind. Both now
fall through to the `native-proto.ts` closure, whose brand-recovery prologue
throws the catchable TypeError the tests want. The arity condition on the
refusal was also dropped from `=== 1` to `<= 1`, so the zero-arg form reaches
the same brand check.

## Root cause 2 — zero-arg `exec()` / `test()` refused at compile time

`re.exec()` is `re.exec(undefined)`, and §22.2.6.2 step 3 is
`Let S be ? ToString(string)` — so the subject is the six-character string
`"undefined"`, not the empty string and not a refusal. Both entry points
reported `standalone RegExp engine does not support RegExp.prototype.{exec,test}
arities other than one string argument` (a hard compile error, so the file did
not run at all).

Fixed with `undefinedSubjectOverride` in `regexp-standalone.ts`, which feeds the
literal through the existing pre-evaluated-subject seam (`inputOverride`) —
there is no argument AST node for the ordinary `compileExpression` lane.

## Root cause 3 — `RegExp(R)` returned a COPY, not `R`

§22.2.4.1 step 1: called **without `new`**, with `R` already a RegExp and
`flags` undefined, `RegExp(R)` returns `R` itself. The standalone constructor
had only the clone arm (which is what `new RegExp(R)` should do), and the clone
is observably different the moment anything is added to `R`:

```js
var __re = /x/i;
var __instance = RegExp(__re);
__re.indicator = 1;
__instance.indicator;   // 1 in a real engine; undefined here
```

The identity arm had to be placed **before** the `staticRegExpLiteralCopy` arm,
which otherwise shadows it for any regex-literal-bound receiver.

## Root cause 4 — `undefined` pattern / flags went through ToString

§22.2.3.1 steps 5 and 7 are `If pattern is undefined, let P be the empty String`
(same for flags) — *not* `ToString(undefined)`. The dynamic-constructor path
applied the runtime ToString unconditionally, so `new RegExp({}.p, {}.q)` asked
the engine for the pattern `undefined` with the five invalid flags `undefined`
and threw `SyntaxError: Invalid regular expression`.

Two spellings needed covering:

- **statically undefined** (absent, `undefined`, `void 0`, a never-written
  `var x;` with no initialiser — `staticConstStringValue` folds that last one to
  `undefined`, which is why the identity arm tests all three);
- **undefined only at RUNTIME** (`(function(){})()`, `{}.q`). Handled by
  `emitArgAsNativeString`'s new `undefinedIsEmptyString` option for the plain
  operands, and — when the pattern is a RegExp and only the flags are dynamic —
  by a runtime two-arm merge that reproduces the spec branch: undefined ⇒
  identity/clone, defined ⇒ recompile `R`'s **[[OriginalSource]]** (§22.2.3.1
  step 6) against `ToString(flags)`, never `ToString(R)`.

## Measured result

Sequentially re-verified with the `runTest262File` seam, `TEST262_TARGET=
standalone`, over the 62-file ES5 RegExp set:

| | baseline | after |
| --- | --- | --- |
| pass | 3 | 18 |
| fail | 54 | 40 |
| compile_error | 5 | 1 |

**+15 net, 0 regressions.** A wider 227-file sweep (every `es5id` file under
`built-ins/RegExp` + `language/literals/regexp`, excluding the pure
`S15.10.2.*` pattern-semantics battery) showed no test moving away from `pass`.

## Deliberately NOT fixed (leftovers)

- **Dynamic patterns (7 files)** — `new RegExp(<runtime string>)` where the
  pattern needs character classes, quantifiers, or 200 nested groups.
  `__regex_compile_dynamic_simple` only accepts the `^(?:a|b|c)$`
  alternation/literal subset. Notably `S15.10.4.1_A8_T2`-`T5` never MATCH
  anything — they only read `.global`/`.ignoreCase`/`.source` — so a
  parse-only-but-do-not-execute lane would flip them; the current code
  deliberately refuses rather than manufacturing an empty program (an
  uncatchable OOB trap at `.test()` time). Real fix: port `regex/parse.ts` to
  Wasm. XL.
- **`RegExp.prototype.hasOwnProperty('global'|'ignoreCase'|'multiline')`
  (3 files, `*_A8`)** — `resolveWasmType(RegExp)` is `externref`, so
  `compilePropertyIntrospection` delegates to the runtime `__hasOwnProperty`,
  which has no `$NativeProto` arm and answers false for every key. The
  `$NativeProto` struct already CARRIES the own-key set in its `memberCsv`
  field; nothing reads it at runtime. The matching `*_A9` files additionally
  need `delete RegExp.prototype.global` to take effect, which needs a real
  own-property model on `$NativeProto`, not a fold.
- **Brand check on wrapper / element-access / proto-assigned receivers
  (8 files: `exec`+`test` `A2_T4/T6/T8/T10`)** — `new String("[a-b]")` as a
  receiver returns `undefined` from the transferred call instead of throwing;
  `i["exec"](s)` (element access) does not route to the native closure at all;
  `Object.prototype.exec = …` then a primitive receiver; and the bare
  `exec("s")` form throws a non-`Error` value. The first belongs to the
  wrapper-exotics lane, the second is a general element-access-call gap — both
  outside this issue's files.
- `S15.10.6.2_A1_T20` — `/[a-f]d/.exec(x)` with a hoisted `var x` works inside a
  function body but returns `null` at MODULE scope, so the module-scope operand
  is not reaching the runtime ToString. Single file, distinct mechanism.
- `S15.10.5_A2_T2` (`RegExp.indicator` static read), `S15.10.6.2_A4_T7`
  (`Math.NaN` static read) — both are generic "builtin static property value
  read is not supported in --target standalone" compile errors, not RegExp bugs.
- `S15.10.6.2_A4_T11/T12` — `lastIndex` coercion ordering / null deref.

## Follow-up — the identity fold was over-wide (`call_with_regexp_match_falsy`)

The first cut of root cause 3 keyed `RegExp(R)`'s §22.2.4.1 step-1 identity arm
on the static RegExp **type** of the pattern operand. That is not the spec's
precondition. §22.2.3.1 step 4.b returns `pattern` itself only when BOTH

- **b.** `patternIsRegExp` — `IsRegExp(pattern)`, which **reads
  `pattern[Symbol.match]`** and, when that property exists, uses `ToBoolean` of
  it *instead of* the [[RegExpMatcher]] brand; and
- **b.iii.** `SameValue(newTarget, Get(pattern, "constructor"))`.

`built-ins/RegExp/call_with_regexp_match_falsy.js` sets
`regExpObj[Symbol.match] = false`, so `IsRegExp` is **false**, step 4.b does not
apply, and the spec CONSTRUCTS a new object. The type-only fold returned the
same object and flipped that file **pass→fail** on the standalone lane. It was
the ONLY genuine test262 regression in wave 3's reported set.

**Fix** — `regExpIdentityBrandIsProvable` in `src/codegen/regexp-standalone.ts`.
The standalone RegExp carrier is a fixed WasmGC struct with no slot for either
override, so neither precondition can be re-checked at runtime; the sound
lowering is to prove their **absence** statically and otherwise decline. The
scan is whole-file and memoised per `ts.SourceFile`, mirroring
`bindingHasWrites`: any well-known-symbol-keyed write (`X[Symbol.…] = …`), any
`.constructor` / `"constructor"` write, and any `Object.defineProperty` /
`defineProperties` / `setPrototypeOf` / `create` call disables the fold for the
file. Declining falls back to the pre-#4233 clone arm, which is what
§22.2.3.1's construct path does anyway. Applied to **both** identity spellings —
the static arm and the runtime two-arm merge's undefined branch.

Budget gates: no NEW grant needed — the growth (~90 LOC) sits inside the
existing `loc-budget-allow` for `src/codegen/regexp-standalone.ts` above, and
the fix adds **zero** `checker.*` queries, so the `oracle-ratchet-allow` entry is
likewise unchanged.

### Not wave-3 regressions (proved by A/B, recorded so they are not re-chased)

- **The 33 `built-ins/RegExp/regexp-modifiers/*` files** reported as
  pass→compile_error are an **environment artifact, not a code regression**.
  They pass on **both** `main` and this branch under CI's **Node 25**, and fail
  on **both** under **Node 22**, whose V8 predates ES2025 regexp modifiers. The
  rejection comes from `src/compiler/early-errors/node-checks.ts`, which
  validates every regex literal with the **host** `new RegExp(pattern, flags)` —
  a check that is byte-identical on main and on wave 3. Diffing a Node-22 run
  against the CI (Node-25) baseline manufactures 33 phantom regressions.
- **`interp/emitter: unsupported in Phase 1: regex`** is a **main-only** error
  string. Wave 3 *removed* that refusal (`src/interp/emitter.ts`, #4137 regex
  literals → `%RegExpCreate%`), so wave 3 fixes it rather than causing it.

## Permanent repro

Pinned by `tests/es5-standalone-regexp.test.ts` (ES5 RegExp semantics: dynamic
pattern tracing, exec arities/result shape, construction-time SyntaxError,
and the §22.2.3.1 step-4.b brand guard on the identity fold) over the
`test262/test/built-ins/RegExp/` battery.
