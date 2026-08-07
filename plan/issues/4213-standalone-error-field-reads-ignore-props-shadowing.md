---
id: 4213
title: "standalone: err.message / err.name reads ignore an own write — the Error field fast paths predate #3130's $props-first rule"
status: ready
sprint: current
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, runtime, standalone
language_feature: objects, errors, property-descriptors
goal: standalone-gap
umbrella: 3977
related: [4210, 3130, 2101, 1104, 1536]
created: 2026-08-07
found-by: ttraenkler/W31
origin: "2026-08-07, split out of #4210 while implementing it. #4210 gives Error a working WRITE side; this is the READ side that does not honour it."
id-provenance: "Reserved by the tech lead on the upstream issue-assignments ledger. The open-PR scan the tool cannot do was run by hand at reservation time: ZERO open PRs on loopdive/js2, so this id is VERIFIED CLEAN, not merely unscanned."
---

# #4213 — `err.message` / `err.name` reads ignore an own write

## The defect

In `--target standalone`, after #4210, an own write to one of the three
**field-backed** Error keys lands in the bag and is visible to reflection, but
a *read* still answers the `$Error_struct` field:

```js
var e = new Error("orig");
e.message = "written";
e.message;                       // => "orig"      ← WRONG, should be "written"
e.hasOwnProperty("message");     // => true        ← correct (#4210)
```

Measured 2026-08-07 on `issue-4210-error-carrier-bag`:
`before=orig after=orig hasMessage=1 name=Error`.

The same applies to `err.name` and `err.stack`, and to
`Error.prototype.toString()`, which reads the fields directly:

```js
var e = new Error("ErrorMessage");
e.name = "ErrorName";
e.toString();                    // => "Error: ErrorMessage", want "ErrorName: ErrorMessage"
```

## This is a KNOWN, DELIBERATE, TEMPORARY inconsistency introduced by #4210

Stated plainly so nobody meets it cold: **after #4210, `hasOwnProperty("message")`
says the property is own while the read answers the stale struct field.** That
is a self-contradiction and it is on purpose, for the duration of this issue.

Why #4210 shipped with it rather than fixing it inline:

- The contradiction lives **entirely in already-failing territory**. The
  reachable population is 11 files (AST scan over each file's effective source
  for a write to `message`/`name`/`stack` on an Error-bound identifier), and
  **0 of them currently pass**, so the regression risk is 0 and the upside is
  ≤ 4 files (`built-ins/Error/prototype/toString/15.11.4.4-{8-1,8-2,9-1,10-1}`).
- It is a **read**-path defect spanning 2–3 independent surfaces, none of which
  #4210 touches. Fixing half of them would leave the same inconsistency with
  more code in the way.
- Before #4210 the two answers agreed — both wrong (write dropped,
  `hasOwnProperty` false, read stale). #4210 makes one of them right. That is a
  strict improvement per-answer and a temporary regression in *consistency*.

## Root cause

Two (possibly three) read surfaces predate #3130, which established that
`$Error_struct.$props` **shadows** the builtin field surface. #3130 taught only
`__extern_get`; the fast paths that bypass it never learned the rule.

| surface | site | today |
| --- | --- | --- |
| static `.message`/`.name`/`.stack` read | `src/codegen/property-access-dispatch.ts` `tryNativeErrorMemberRead` (~L1199, the `isErrorLhs` branch ~L1264 and the #2077 catch-binding branch ~L1284) | `ref.cast $Error_struct` + `struct.get <1|2|3>`, no `$props` consult |
| §20.5.3.4 `Error.prototype.toString` | `src/codegen/native-strings.ts` `ensureErrorToStringHelper` (~L223) | reads fields 2 and 1 directly |
| `__extern_get` | `registry/error-types.ts` `fillExternGetErrorProps` | **correct already** — `$props` first, then message/name/stack, then `constructor` |

The fast paths exist for a reason that has since expired. Their comment
(#1104 Phase 2) says "the host import is unavailable in standalone mode, so
without this fast path `error.message` traps at instantiation time". Since
#3130 `__extern_get` is a **defined native** in standalone, not a host import,
so the trap argument no longer holds — only the performance argument does
(one `struct.get` vs a string flatten + compares).

## Fix direction

Keep the fast path, but precede it with the `$props` consult, i.e. reproduce
`fillExternGetErrorProps` arm 1 for a single statically-known key. A shared
helper is worth it because there are 2–3 call sites and the nullish-miss rule
is subtle (under the #2106 undefined-singleton regime a miss is *nullish*, not
null — see `propsMiss()` in `error-types.ts`):

```
__error_field_read(externref err, i32 which) -> externref     // 1=message 2=name 3=stack
   bag = err.$props
   if (bag != null) { v = __extern_get(bag, KEY[which]); if (!nullish(v)) return v }
   return err.<which>
```

Two things to get right, both of which are why this was not folded into #4210:

- **Result typing.** The fast path returns `(ref null $AnyString)` under
  `nativeStrings`, not `externref`; the helper hands back `externref` and the
  call sites must coerce exactly once (#1797 is the ticket for what happens
  when that coercion misfires).
- **Late-import ordering.** `__extern_get` is resolved via `ensureLateImport` +
  `flushLateImportShifts` at the property-access call sites; a *minted* helper
  that bakes its funcIdx has to be created after that resolution, or reserved
  early like `error-props.ts` does.

## Not in scope

`delete err.message` — the bag entry goes, the read falls back to field 1, and
the message reappears. That is unchanged by #4210 (there was never a bag entry
to delete) and needs a tombstone on the field surface, not a shadowing consult.
Record it, do not fix it here.

## Acceptance

- `e.message = "written"; e.message === "written"` and
  `e.hasOwnProperty("message") === true` — the two answers agree.
- `e.name = "ErrorName"; e.toString() === "ErrorName: ErrorMessage"`.
- `e.name = ""; e.toString() === "ErrorMessage"` (§20.5.3.4 step 4).
- An Error with NO own write still reads `message`/`name`/`stack` from the
  struct fields — a PRECONDITION case green on both arms, so the probe is not
  vacuous.
- Measured on the 11-file reachable population plus a full control: fail→pass,
  pass→fail and signature-changed reported separately.
