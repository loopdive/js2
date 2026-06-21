---
id: 2192
title: "standalone: caught Error .message/.name read inline (=== literal, .length) returns null/empty; works only via a typed local"
status: done
assignee: ttraenkler/sdev-proxy3
created: 2026-06-18
completed: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime
language_feature: exceptions
goal: standalone-conformance
sprint: 63
related: [2077, 1104, 1536c]
---
# #2192 — standalone caught-Error `.message`/`.name` inline read returns null/empty

## Problem

Under `--target standalone`, reading a caught Error's `.message` (or `.name`)
**inline** — as the operand of `===`, `.length`, a method call, etc. — yields a
null/empty string, even though reading it **into a typed local first** works.
This is how test262 String/error tests assert (`assert.sameValue(e.message,
"...")` / `e.message === "..."`), so it silently fails a chunk of standalone
exception tests despite the value being present.

## Repro matrix (standalone, current upstream/main 4350f87d6)

```ts
try { throw new Error("hi"); } catch (e: any) { return e.message === "hi" ? 1 : 0; }      // → 0  (WRONG)
try { throw new Error("hi"); } catch (e: any) { const m = e.message; return m === "hi" ? 1 : 0; } // → 1  (correct)
try { throw new Error("hi"); } catch (e: any) { return ("" + e.message) === "hi" ? 1 : 0; }       // → 1  (correct)
try { throw new Error("hi"); } catch (e: any) { return e.message.length; }                 // → 0  (WRONG; should be 2)
try { throw new Error("hi"); } catch (e: any) { const m = e.message; return m.length; }    // → 2  (correct)
```

Also broken inline (likely same root): `e.name === "RangeError"`, `e.cause === X`.

## Key finding

A WAT dump shows the `$Error`-struct field-read guard (`ref.test $Error` +
`struct.get $Error_struct 1`) from #2077 (`property-access.ts` ~1900) does
**NOT** fire for ANY of these forms (`hasErrorStructRead=false`) — yet
`const m = e.message` still produces the correct string. So `e.message` is read
through a working path when its result flows into a typed-string slot (the
assignment coerces externref→`$AnyString`), but the **inline** consumers
(`===`, `.length`) receive the raw externref and either skip or misfire the
per-consumer externref→native-string coercion → they compare/measure a
null/non-string. Same coercion-flow class as #1797 (externref string result
must be coerced to `(ref null $AnyString)` once at the producer, not per
consumer).

`e instanceof Error` / `instanceof TypeError` already work (the catch struct IS
recoverable). Only the field-VALUE consumption inline is broken.

## Fix direction (to confirm)

Make the caught-Error `.message`/`.name`/`.stack`/`.cause` read produce a
`(ref null $AnyString)` (native-string) result at the property-read site in
standalone — independent of whether the static `$Error` guard fires — so every
downstream consumer (`===`, `.length`, concat, method dispatch) gets a native
string instead of a raw externref. Likely: (a) ensure the #2077 catch-binding
guard actually fires for the inline case (the `receiverIsCatchClauseBinding` /
`objType.flags` gate may not match when the receiver is the inner node of a
chained access), and/or (b) coerce the externref result to `$AnyString` at the
read site (matching the `resultType` the guard's `then` arm already returns) on
ALL paths, not only the assigned-to-typed-local path.

## Root cause (confirmed via WAT)

The property-access `$Error` guard DOES fire for the catch binding and returns
the message as a `(ref null $AnyString)`. But the `===` dispatch in
`binary-ops.ts` decides string-vs-`ref.eq` from the **TS type** of the operands:
`e.message` has TS type `any` (the `catch (e)` binding), so `isStringType(left)`
is false and the comparison fell to `ref.eq` (struct **identity** — two distinct
string structs are never `ref.eq`, so equal content compared false). The
`const m = e.message; m === "hi"` form worked only because the typed-`string`
local re-typed the operand so the dispatch saw `string === string`.

## Shipped (PR) — equality fix

`binary-ops.ts` `compileBinaryExpression` now recognises a caught-Error
`.message`/`.name`/`.stack` property read (AST: a `.message|name|stack` access
whose receiver is a `catch`-clause binding, standalone/wasi) as a **string
operand**, so `e.message === "lit"` / `!==` routes to `compileStringBinaryOp`
(`__str_equals`, content compare) instead of `ref.eq`. This is the dominant
test262 assertion shape (`assert.sameValue(e.message, "...")`).

## Follow-up slice 1 (2026-06-18, sdev-proxy3 — PR `issue-2192b-…`): string METHODS

DONE: `e.message.<method>()` / `e.name.<method>()` now dispatch through the
native-string method path for i32/boolean-returning methods (`charCodeAt`,
`indexOf`, `includes`, `startsWith`, `endsWith`, …) on a caught-Error string
field of an explicitly-thrown error.

**Mechanism:** `receiverIsCaughtErrorStringRead(ctx, recv)` (property-access.ts)
recognises a `<catchBinding>.message|name|stack` receiver; the string-method
dispatch in `calls.ts` (the `isStringType(receiverType)` gate) ORs it in, so the
call routes through `compileNativeStringMethodCall` — which compiles + flattens
the receiver to a `$AnyString` ref (already the read's result type in standalone
mode). No new host import; standalone/WASI-gated; `message`/`name`/`stack` only;
inner receiver must be a bare catch binding (plain `obj.message` unaffected).
9/9 `tests/issue-2192b-caught-error-string-methods.test.ts`; 27/27 with the
#2192/#2077 suites; no regression.

**Still deferred (intentionally NOT in this slice — broad blast radius):**
- `e.message.length` — the `.length` dispatch is entangled with the generic
  `any`-receiver length / `__extern_get` chain (earlier `.length` handlers
  intercept before the string-length site). Plain
  `const o:any={message:"abc"}; o.message.length` → 0 on base too: this is the
  GENERAL `any`-typed-`.length` gap, not Error-specific. Needs the `any`-receiver
  length dispatch to consult the codegen result type, not the static type alone.
- chained string-RETURNING methods (`e.message.slice(1).charCodeAt(0)`) — the
  intermediate `.slice()` result's type isn't carried to the next consumer.
- `e.cause` — not a `$Error_struct` field yet (own field gap).
- errors from a runtime TRAP (`null.x`) vs `new X()` — the trap-throw path does
  not populate the `$Error_struct` string fields like the explicit ctor does
  (separate construction gap).
These together are the "string type to ALL consumers" type-propagation work;
keeping them out preserves a bounded, low-risk slice.

## Acceptance criteria (this PR)

1. `e.message === "hi"` (inline) === `true`; `e.message !== "no"` === true. ✓
2. `e.name === "RangeError"` / `e.name === "TypeError"` (inline) correct. ✓
3. user `class C extends Error` subclass `.message === lit` inline correct. ✓
4. No regression: typed-local read, plain-object `.message === lit`, and the
   #2077 / #1536 exception suites (25 tests) all green. ✓
5. `tests/issue-2192.test.ts` 7/7 green.
6. (deferred) `e.message.length`, `e.cause` — follow-up slice.
