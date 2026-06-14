---
id: 2077
title: "standalone: caught Error's .message traps null deref; .name returns '[object Object]' (catch-bound value isn't the $Error struct)"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-13
completed: 2026-06-13
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: exceptions
goal: host-independence
related: [1104, 1536, 2072]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2077 — $Error struct field reads on a non-$Error catch binding

## Problem

```ts
try { throw new Error("msg1"); } catch (e: any) { const m: string = e.message; return m; }
// standalone: RuntimeError: dereferencing a null pointer   node: "msg1"
```

`e.name` on a TypeError yields "[object Object]" (node: "TypeError").
`e instanceof TypeError/Error` works — only the field reads break.

## Root cause

`src/codegen/property-access.ts:1448-1457` — standalone reads `$Error`
struct fields 1/2 for message/name, but the catch-bound value isn't that
struct after the throw/catch roundtrip → null field. Residual of #1104
(done); #1536 (backlog, $Error redesign) is the structural home.

## Fix direction

Preserve the `$Error` struct identity through the exception tag payload
(or re-cast with a guarded ref.test before the field read); the
"[object Object]" half also intersects #2072's `$__any_to_string` shape
mismatch.

## Acceptance criteria

- Both repros match Node standalone; instanceof behavior unchanged
- throw/rethrow of non-Error values unaffected

## Dupe check

#1104 (done — regressed/residual), #1536 (backlog redesign), #1597. Filed
as the concrete standalone residual.

## Root-cause analysis (2026-06-12) — TWO independent bugs

Deep investigation (standalone target, nativeStrings) found this is **two**
stacked bugs. Fixing only the first does not make the repro pass.

### Bug 1 (FIXED here) — the field-read fast path is statically gated

`property-access.ts` only emitted the standalone `$Error` `struct.get`
fast path when the receiver's **static** TS type was a builtin Error
(`isErrorLhs`). A `catch (e)` binding is typed `any`, so the gate never
fired and `e.message`/`e.name` fell through to the generic `__extern_get`
host path — which returns null in standalone mode (no host). This is why
the direct case (`const e = new Error("m"); e.message`) worked but the
caught case (`catch (e: any) { e.message }`) returned null.

**Fix:** when the receiver is a `catch`-clause binding (see the scope fix
below) and we're in `ctx.wasi || ctx.standalone`, emit a runtime
`ref.test $Error`–guarded read (mirrors the standalone instanceof guard in
`identifiers.ts`): if the value IS an `$Error` struct, `ref.cast` +
`struct.get` the field + coerce to the native string ref; else produce a
null string. The emitted WAT matches the working direct-`Error` path (same
struct type index, same `extern→$AnyString` coercion).

### "Bug 2" was a MISDIAGNOSIS — resolution (2026-06-13, sdev)

The WIP author's "exception-payload string-identity corruption" theory is
**disproven**. Direct in-wasm probes of the caught message show its content is
fully intact: `charCodeAt(0)` correct, `length` correct, `m + m` works, and
`caughtMessage === freshError.message` → **true**. The string is NOT corrupted.

The probe that looked like corruption — `e.message === "msg1"` → 0 — is the
general **`any === stringLiteral` content-comparison gap**: when `e:any`, the
static type of `e.message` is `any`, so strict `===` emits `ref.eq` (reference
equality on the native-string struct refs) instead of `call __str_equals`
(content compare). This is **not** error-specific and **not** in #2077's
documented repros or acceptance criteria — it's the #2081 / #2059
any-operand-equality family. (Before Bug 1 that comparison was also `0`
(`null === literal`), so Bug 1 does not regress it; it makes the underlying
value correct.) Assigning to a typed `const m: string` first — exactly what
the issue's repro does — and comparing `m === "msg1"` works (→ 1).

Both **documented repros now pass** with the (scoped) Bug 1 fix:
`catch(e:any){const m:string=e.message; return m}` → "msg1"; TypeError `.name`
→ "TypeError". instanceof unchanged; non-Error throws + rethrow unaffected.

### Bug 1 scope fix (the real second half — a REGRESSION the first attempt introduced)

The first Bug-1 attempt gated the `$Error`-guarded read on **any**
`any`/`unknown` receiver (`isErrorLikeRuntimeLhs`). That **over-fired**: a plain
`const o: any = { message: "x" }` then read `o.message` through the Error-struct
guard, and the non-Error `else` arm returned a **null string**, so
`o.message.length` trapped (null deref) on ordinary objects — a real regression
vs. baseline (where plain-object `any.message` read correctly via the generic
path). This is the "null→wrong-string / trap" the original handoff feared.

**Fix (this PR):** scope the guard to a `catch`-clause binding only
(`receiverIsCatchClauseBinding` — the receiver identifier's symbol resolves to a
`VariableDeclaration` whose parent is a `CatchClause`). A caught binding is the
realistic source of an `any` value that could be the `$Error` struct in
standalone; a general `any` object keeps reading its own fields via the working
generic path. Verified: plain-object `any.message`/`any.name` reads restored
(length 5 / equality 1 / length 3); caught-Error reads still correct;
non-Error throws + rethrow correct.

### Out of scope (pre-existing, NOT introduced here)

- `new Error()` with **no message arg** leaves the message field null →
  `.message.length` traps. Reproduces **directly** (no throw/catch) on baseline
  — a separate `$Error`-construction default-empty-string gap. File separately.
- `any === stringLiteral` content comparison — belongs to #2081 / #2059.

### Status

`status: done` — the documented repros pass, the over-broad-guard regression is
fixed (catch-binding scope), and the error/exception + try-catch suites
(#1104 ph1-3, #1536, #1597, error-reporting, scope-and-error-handling,
try-catch-throw/finally, wrapper-constructors) are green. `tests/issue-2077.test.ts`
(11 cases) covers the repros + the plain-object regression guards. tsc +
prettier + biome clean.
