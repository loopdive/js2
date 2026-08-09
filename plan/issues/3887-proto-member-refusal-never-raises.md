---
id: 3887
slug: proto-member-refusal-never-raises
title: "Standalone: body-less prototype members answer null instead of raising TypeError, across brands"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: error-semantics
goal: standalone-mode
sprint: current
es_edition: n/a
related: [3468, 3877, 3885]
---

# #3887 — Refused prototype members answer `null` instead of throwing

## Problem

`emitProtoMemberBodyRefusal` is the shared "this member has no native body yet"
path. It is documented and intended to emit a **catchable TypeError**
(`"<Brand>.prototype.<member> is not yet implemented in --target standalone"`).

Under `--target standalone` it does not raise. The call returns **`null`**.

This is **not** String-specific. It reproduces on `ArrayBuffer` and `DataView`,
whose glue (`makeGlueWithGetters`, `src/codegen/array-object-proto.ts` ~1618)
routes **every** member to the refusal.

## Measured (2026-07-31, both lanes, instrument proven on the lane)

`7` = threw and was caught · `1` = returned a value · `-1` = returned
null/undefined. Probe `.tmp/refusal-scope3.mts`.

```
case                              host   standalone
DETECTOR CONTROL (must be 7)      7      7      <- instrument proven ON standalone
String/toUpperCase (refusal)      1      -1
String/slice       (refusal)      1      -1
String/concat      (refusal)      1      -1
ArrayBuffer/slice  (refusal)      7      -1     <- host THROWS, standalone nulls
DataView/getInt8   (refusal)      7      -1     <- host THROWS, standalone nulls
String/charAt      (has body)     1       1
```

`ArrayBuffer.prototype.slice` and `DataView.prototype.getInt8` on an
incompatible receiver **throw on host** and return `null` on standalone. The
detector control proves a raised TypeError _would_ be observed on that lane, so
the refusal is **not raising one**.

## "TypeError never raised" — NOT "swallowed". Falsified TWICE.

Do not re-open the exception-swallow theory. It has been run down and killed
twice:

1. **#3468** (`status: done`, completed 2026-07-24) — its title records the
   correction verbatim: _"root cause is function-object own-property gap, NOT a
   catch_all swallow"_, and its notes state there is **zero try/catch in the
   standalone WAT; nothing is being caught**.
2. **Directly measured here.** A hand-written `throw new TypeError(...)` — both
   inline and from a callee — is caught correctly in standalone (`7`), and
   `e instanceof TypeError` holds. Throws propagate fine.

Nothing is caught because nothing is raised. The fix is at the site where the
TypeError should be **generated**, not where it might be lost.

This is also **not** residue of #3468: that issue's own mechanism no longer
reproduces on current `main` — `f.m = function(){}` then
`typeof f.m === "function"` returns correctly in standalone.

## Why this is also a measurement-integrity bug

A refusal that degrades to a silent wrong value is worse than the missing
feature it stands for. Refused members should produce **loud, classifiable**
errors; instead they answer quietly wrong, so an unknown number of standalone
conformance rows may be **mis-attributed** — scored against the wrong cause, or
scored `pass` because a `null` came back and no assertion fired.

## Fix location — UNKNOWN. Two attributions tried, both measured and REVERTED.

The obvious site is `emitProtoMemberBodyRefusal`
(`src/codegen/array-object-proto.ts` ~692), and there is a genuinely suspicious
thing in it: it calls `emitThrowTypeError(...)` and then `return null`, while
`createNativeProtoMember` (`native-proto.ts` ~537) does

```ts
const committedResult = glue.emitMemberBody(ctx, closureFctx, member, kind);
if (committedResult === null) return null; // discards the wrapper it just built
```

so a `null` return would throw away the wrapper **including the TypeError
instructions just emitted into its body**. Its sibling
`emitArrayProtoMemberBody` does the same thing correctly
(`emitThrowTypeError` then `return { kind: "externref" }`).

**That reasoning is sound and the change still does nothing.** Returning
`{ kind: "externref" }` instead of `null` produced **byte-identical** census
output — all `-1`s unchanged. Reverted rather than shipped, per the same rule
that retired the `substring`-only bail-out in #3877: an edit with no measured
effect is unproven, however good its story.

**A previous revision of this issue claimed the refusal is never reached. That
claim was WRONG and is retracted — the probe behind it was invalid.** It grepped
the emitted **WAT text** for the refusal's message string and found zero
occurrences. The message lives in the **string pool**, not in WAT instructions,
so zero was guaranteed regardless of the truth. Recorded rather than deleted
because a wrong attribution inside a filed issue is exactly what sends the next
investigator to the wrong function.

**The refusal IS reached, and it DOES emit a throw.** Dumping the wrapper
verbatim (`.tmp/dump-wrapper.mts`):

```wat
(func $__proto_method_-1073741804_toUpperCase (type 111)
  global.get 70
  extern.convert_any
  call 69
  throw 0            ;; <- the refusal's TypeError, present and correct
)
```

Six lines, and the entire body is `emitThrowTypeError`. `charAt` by contrast is
34 lines of real implementation, whose null-receiver ROC arm emits the _same_
`throw 0` shape.

**So the throw is generated and still does not surface at the call site.** That
is the real open question, and it is narrower than when this issue was filed.

**The revert still stands, on sound evidence.** Changing the refusal's
`return null` to `return { kind: "externref" }` produced byte-identical output —
now explained: `createNativeProtoMember` was never bailing, because the wrapper
demonstrably exists. The revert was correct; the _reason_ first given for it was
not.

**Dispatch is not the differentiator either.** The per-method call helpers are
structurally identical between a failing and a working member:

```wat
(func $__call_m_m_0 …)   ;; toUpperCase — FAILS
  local.get 0 / any.convert_extern / local.set 1
  local.get 0 / global.get 76 / extern.convert_any / call 120 / call 171

(func $__call_m_m_1 …)   ;; charAt — WORKS
  … same shape, plus the extra arg: call 120 / local.tee / call 121 / call 171
```

Both do member-lookup (`call 120`) then invoke (`call 171`). Same shape,
opposite outcomes.

## Where the next investigator should start

The throw exists in the wrapper; the dispatcher shape is identical between the
working and failing arms; the failing call returns `null` rather than raising.
So the loss is **between the invoke (`call 171`) and the caller** — either the
closure is not actually invoked for a refusal-bodied member, or the exception
does not propagate across that boundary.

**Do not re-derive this by reading source.** This codepath has now produced
**two** confident mechanism attributions from source reading — the
`substring`-only bail-out (#3877) and the refusal return type (above) — and both
compiled to byte-identical output. Use a **marker bisect** instead: put a unique
sentinel constant in each candidate emitter, compile, dump the wrapper and the
dispatcher, and see which sentinel survives to WAT. Attribution by marking
cannot be wrong; attribution by reading has been wrong twice here.

## Acceptance criteria

- Refusal-routed members **throw a catchable TypeError** on standalone where
  host throws (probe returns `7`, not `-1`), for `String`, `ArrayBuffer` and
  `DataView` at minimum.
- The detector control still returns `7` on both lanes.
- Members that HAVE bodies are unaffected: `charAt` / `substring` still return
  `1` on both lanes.
- **Kill-switch seen to fail**: revert the emitter change and confirm the `-1`s
  return. A test not watched failing is not evidence.
- `tests/issue-3887.test.ts` covers refusal behaviour on at least two brands,
  both lanes, and carries a control that must hold under any spec version.

## Landing risk — READ BEFORE PUSHING

Making refusals throw **will change standalone test262 results, and not only
upward**. Rows currently scored `pass` _because_ a `null` came back and no
assertion fired will begin failing loudly. That is correct behaviour and may
still trip the **standalone-floor gate in `merge_group`** (the #3871 shape,
which burned three parks before anyone measured it).

Therefore: **measure the flip count** (pass→fail, fail→pass, net) by running the
standalone lane before and after — #3468's notes say floor impact is _mixed_ and
not computable in advance, so it must be run, not estimated — and state the
numbers and whether a justified re-baseline is needed **in the PR description**.
A floor movement explained in advance is a review conversation; the same
movement discovered in `merge_group` is a park.

## Related

- **#3888** — null-receiver method call returns normally instead of raising
  TypeError. Same "TypeError never raised" family, separate defect.
- **#3877** — the assigned-`String.prototype`-method matrix that surfaced this.
- **#3885** — the instrument-control rule that made the measurement trustworthy.
