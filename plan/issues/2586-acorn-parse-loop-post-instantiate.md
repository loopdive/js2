---
id: 2586
title: "compiled-acorn parse() infinite-loops in parseTopLevel after instantiation (4th dogfood blocker)"
status: blocked
assignee: sd-acorn
created: 2026-06-21
updated: 2026-06-22
priority: high
feasibility: hard
reasoning_effort: high
task_type: fix
area: codegen, runtime
language_feature: multi
goal: self-hosting-dogfood
sprint: Backlog
model: opus
depends_on: [1712, 2582, 1528, 56, 86]
blocked_on: "dynamic-construct bridge (#1528/#56/#86) — `new this(...)` in a lifted fnctor-static-method body needs compiled-fnctor-as-dynamic-constructor; see Resolution section"
depends_on: [1712, 2582]
related: [1712, 2582]
---

# #2586 — compiled-acorn `parse()` infinite-loops in `parseTopLevel` (4th blocker)

## Context

The **4th** independent compiled-acorn dogfood blocker, surfaced once #2582
(numeric-key module-init read) let acorn INSTANTIATE. With #1712 (tokenizer
identity loop) and #2582 both fixed/landed, compiled acorn now
`instantiated OK; parse=function` — but `parse("var x = 1;")` **infinite-loops**
in `parseTopLevel`.

## Symptom

`parseTopLevel` (acorn dist ~846):

```js
while (this.type !== types$1.eof) {
  var stmt = this.parseStatement(null, true, exports);
  node.body.push(stmt);
}
```

Host-bridge method-call counter (`DEBUG_2586`, budget 50000) for
`parse("var x = 1;")`:

```
parseStatement=2271, push=2271, parseExpressionStatement=2270, …
isContextual=9083 (≈4× per statement), isUsingKeyword=4542
```

So `parseStatement` runs 2271× — each COMPLETES and pushes a statement — but the
`this.type !== types$1.eof` guard never trips. The loop never reaches EOF for a
single-statement input.

This is the SAME loop SHAPE as the #1712 tokenizer-identity loop, but #1712's
two root causes (the `_safeSet` `__sset_` writeback gating + the `_wrapForHost`
proxy-vs-raw `_hostEqComparableValue` mismatch + the `replace` arg-drop) are all
FIXED and present on this branch (verified). So this is a NEW, distinct cause.

## Hypotheses (to bisect)

1. **A different identity mismatch on `this.type !== eof`** — now that keyword
   recognition works (#1712/#2582), the EOF comparison may still mismatch for a
   reason unrelated to the proxy/sidecar fixes (e.g. a fresh struct copy on a
   specific read path, or the comparison routing through a path that doesn't
   canonicalize).
2. **`this.pos` / scan-position not advancing through dynamic dispatch in THIS
   call shape** — if `nextToken`/`next` doesn't advance `this.pos` past the
   input, `this.type` is recomputed as the same non-eof token forever. (Prior
   #1712 N-probes showed `this.pos += n` works through a prototype method, but
   acorn's exact `finishToken`/`next` shape may differ.)
3. **`parseStatement` not consuming the token it parsed** — each iteration
   re-examines the same `var` token (the `isContextual` 4×/stmt count is
   consistent with re-scanning a stuck position).

## ROOT CAUSE — pinned to `new this(...)` in an fnctor static method (2026-06-21, sd-acorn)

Bisected far past the loop symptom. The loop is downstream of a **tokenizer
input loss**, which is downstream of a **`new this(...)` defect**:

1. `parseTopLevel`'s loop never reaches eof because `var` is tokenized as
   `name`, not `_var`. Traced via a `finishToken` host-bridge log: `readWord`
   calls `finishToken(name, "")` — the scanned **word is the EMPTY STRING**.
2. `readWord1()` returns `word + this.input.slice(chunkStart, this.pos)` = `""`
   ⇒ the identifier-scan `while (this.pos < this.input.length)` loop never ran
   ⇒ **`this.input` is empty (length 0)** in the compiled Parser.
3. `this.input = String(input)` (Parser ctor). So the parse INPUT never reached
   the instance. The chain is
   `exp.parse(src) → parse(src,opts) → Parser.parse(src,opts) → new this(opts,src)`.

The defect is **`new this(...)` inside an fnctor static method**, reproduced in
~8 lines (`.tmp/probe-static.ts`):

```ts
var Parser = function Parser(a, b) { this.a = a; this.b = b; };
Parser.simple   = function (x, y) { return y; };           // OK   (static, no `new this`)
Parser.makeIdent= function (x, y) { return new Parser(x, y); }; // OK (`new Parser`)
Parser.makeNew  = function (x, y) { return new this(x, y); };   // THROWS "is not a constructor"
```

- `staticSimple` ✓, `staticNewIdent` (`new Parser(x,y)`) ✓,
  **`staticNewThis` (`new this(x,y)`) → Wasm exception `"is not a constructor"`.**

### Why

`new this(...)` is handled by the #1679 path
(`src/codegen/expressions/new-super.ts:3473`), gated on
`expr.expression.kind === ts.SyntaxKind.ThisKeyword`. But by the time the static
method body reaches `compileNew`, **`this` has been REWRITTEN from `ThisKeyword`
to an `Identifier`** (confirmed: a raw AST scan shows `new this` as `ThisKeyword`,
but the codegen log inside `compileNew` reports `exprKind=Identifier
className=undefined enclosing=undefined`). So the #1679 ThisKeyword arm is never
taken, `className` is unresolved, the fnctor-name fallback misses, and the call
drops to the generic dynamic-`new` path which throws `"is not a constructor"`
(`emitThrowTypeError(…, "is not a constructor")`) because the runtime receiver is
a wrapped closure externref with no `[[Construct]]`.

### Deeper trace (2026-06-22) — it's the LIFTED-closure body, not the new-site

WAT confirms the precise mechanism. The static method `Parser.makeNew =
function(x,y){ return new this(x,y) }` is LIFTED into a closure (`__closure_2`),
and that closure's ENTIRE body is just:

```wat
(func $__closure_2          ;; makeNew lifted body
  global.get <"is not a constructor">
  call $__new_TypeError
  throw 0)
```

while the sibling `Parser.makeIdent = function(x,y){ return new Parser(x,y) }`
lifts to:

```wat
(func $__closure_3          ;; makeIdent lifted body
  local.get 1; local.get 2; call $__fnctor_Parser_new; extern.convert_any; return)
```

So `__fnctor_Parser_new` IS built and IS called by `new Parser` — but `new this`
in the lifted body compiles to a hard `throw "is not a constructor"`. Inside the
LIFTED closure, `this` is the `__current_this`/receiver externref (a dynamic
value), NOT a statically-known fnctor identifier — so `compileNew`'s static
identifier/`#1679`-ThisKeyword arms don't fire, `className` is undefined, and it
falls to the `if (!className)` dynamic arm which, for a bare `this`-receiver,
emits the not-a-constructor throw rather than a runtime construct.

(The earlier `[new2] text=Parser` log was the NEW-SITE compile of the same
expression in a different pass — the rewrite resolves `this`→`Parser` there —
but the LIFTED-body compile is the one whose `throw` lands in `__closure_2`. The
two compiles disagree: the new-site sees `Parser`, the lifted body sees the
dynamic `__current_this`.)

### Fix direction + the blocking dependency (VERIFIED)

There is a runtime `__construct(callee, argsArray)` host helper
(`runtime.ts:9275`) that performs `[[Construct]]` on a dynamic externref callee.
Routing `new this(...)` in a lifted body through it is the natural shape —
BUT `__construct` currently requires `typeof wrappedCallee === "function"`, and a
fnctor-closure struct wraps via `_wrapForHost` to a PROXY (typeof "object"), so
`isCtor=false` and it STILL throws "is not a constructor". There is no host-side
mapping from a runtime closure-struct externref back to its compiled
`__fnctor_<name>_new`.

**This is the SAME capability gap as #1528 / #56 / #86 — "compiled
fnctor/class as a dynamic constructor invokable from the host."** Those tasks
build exactly the missing bridge (a host-exported dynamic-construct entry that
maps a runtime closure/class value → its compiled ctor). #2586's `new this(...)`
in a lifted fnctor-static-method body is a consumer of that bridge: once a
runtime fnctor-closure externref can be constructed via the host (or the
lifted-body `new this` is lowered to a Wasm-side dynamic dispatch over known
fnctor `<name>_new` ctors keyed by the receiver), acorn's
`Parser.parse → new this(options, input)` works and the args forward in order.

**Recommendation:** #2586 is BLOCKED on the #1528/#56/#86 dynamic-construct
bridge (the Promise/Proxy lane is already building it). Sequence #2586 AFTER #86
lands — then either (a) extend the bridge to cover the lifted-`new this`
receiver, or (b) add a Wasm-side `__construct_fnctor` dispatcher that ref.tests
the receiver against each registered fnctor struct and calls the matching
`__fnctor_<name>_new` (the dual of the `__call_fn_method_N` dispatcher #1712
added — exports-independent, works at module-init too). Option (b) is
self-contained to codegen and avoids the host round-trip; preferred if the
bridge's host path can't be reused. NOT a quick point-fix either way — it is the
dynamic-construct capability, not a resolution tweak.

The rewrite happens in the static-method / closure-this lowering
(`src/codegen/closures.ts` — the `__current_this` / `__this`-param machinery,
~L2750/L3544). `fctx.enclosingClassName` is ALSO undefined for these `Fn.method
= function(){…}` static methods, so neither the type-symbol nor the enclosing-
context fallback resolves the fnctor.

### Acorn vs. the minimal probe — a caveat

The minimal probe THROWS `"is not a constructor"`; real acorn does NOT throw —
it LOOPS with empty `this.input`. So acorn's `new this(options, input)` does not
hit the throw arm (likely because the full Parser fnctor IS registered, so a
different sub-path runs), but it still mishandles the args — the `input` operand
is lost (empty `this.input`). Both are the same family: **`new this(...)` in an
fnctor static method does not correctly resolve `this`→ctor and/or forward its
arguments.** The fix must (a) recognise the rewritten-`this` callee as the
enclosing fnctor ctor, and (b) forward the args in order to `<Class>_new`.

### Suggested fix direction

- In `compileNew`, when the new-callee is a rewritten-`this` (or the resolved
  `className` is undefined) AND the enclosing function is a static method of a
  known fnctor, resolve the ctor from the fnctor context (carry the owning
  fnctor name onto `fctx` for `Fn.method = function(){…}` static methods, the
  way class methods set `enclosingClassName`), then route to the same
  `<Class>_new` machinery the #1679 ThisKeyword arm uses — with in-order arg
  forwarding so `new this(opts, input)` passes `(opts, input)` to the ctor.
- This is fnctor/closure-dispatch architecture-adjacent; given the
  `this`-rewrite interaction it may warrant an architect spec. The minimal repro
  (`staticNewThis`) is the regression-pin target.

## Investigation harness

- `/workspace/.claude/worktrees/issue-2582-numkey-objread/.tmp/run-acorn3.mjs`
  (compile + instantiate + `parse` under a method-call counter).
- `DEBUG_2586=1 DEBUG_2586_BUDGET=N` on `__extern_method_call` prints the top
  per-method call counts and throws to escape the tight Wasm loop.
- Re-use the #1712 `host_eq` watchdog + `finishToken`/`nextToken` label trace to
  see whether `this.type` ever becomes `eof` and whether `this.pos` advances.

## Acceptance

- Compiled acorn `parse("var x = 1;")` returns a Program AST (loop terminates).
- Then the #1710/#1712 differential-AST harness: structurally-equal AST vs
  node-acorn for the representative fixture (the #1712 acceptance).
- No test262 / equivalence regression.
- #1712 stays open until the full parse + AST-match acceptance is met; this
  issue is the next slice toward it.
