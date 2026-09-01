---
id: 5257
slug: generator-boolean-return-boxed-as-number
status: ready
sprint: Backlog
priority: medium
horizon: s
goal: core-semantics
feasibility: medium
created: 2026-09-01
requested_by: ttraenkler/fable-ir-takeover
---

# A generator returning a boolean yields `{done: true, value: 1}`, not `true`

## Problem

`function* g(n) { yield 1; return n > 2; }` — draining past the last yield
yields `{done: true, value: 1}` instead of `{done: true, value: true}`. The
boolean-branded i32 return value is boxed through `__box_number` at the
`gen.setReturn` seam, so the host observes the number `1`.

Measured 2026-09-01 during #3526 F1-S3 (its checkpoint's follow-up 2, filed
here with an allocated id): **identical on the IR path and the legacy path**
(`IR_FIRST=1` and `=0` both answer `1`), so this is a whole-compiler
conformance gap at the generator return boundary, not an IR-path defect.

## Where

- IR seam: `irGeneratorSetReturnNeedsBoxing` (`src/ir/generator-support.ts`)
  classifies any f64/i32 value as number-boxable; the branded-boolean i32 is
  not distinguished, and the provider is the number boxer (post-F1-S3, the
  manifest's `generatorNumberBox` selection).
- Legacy takes the same shape through its own `__gen_set_return` path.

## Fix direction

Box a boolean-branded i32 through `__box_boolean` (the `boolean.box`
capability row and `js.boolean.box` intrinsic exist since F1-S2) on BOTH
paths in one change, keeping IR/legacy parity. The fix widens the generator
boxing policy or adds a branded arm at the seam — mirror F1-S3's
manifest-authority shape rather than reintroducing a presence choice.

## Acceptance criteria

1. `return <boolean>` from a generator surfaces `true`/`false` host-side on
   the host and native-strings lanes; IR and legacy agree.
2. The `BOOL_RETURN_GEN` fixture in
   `tests/issue-3526-generator-boxprovider.test.ts` (added by F1-S3 pinning
   the CURRENT `1` behavior) is updated alongside — the F1-S3 checkpoint
   explicitly flags it.
3. test262 net non-negative; the affected generator-return rows flip
   fail→pass or stay unchanged.
