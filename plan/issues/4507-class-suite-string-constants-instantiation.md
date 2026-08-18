---
id: 4507
title: "tests: class-family suites instantiate without `string_constants` — 84 tests dead at instantiation"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
assignee: ttraenkler/opus-4507h
priority: medium
horizon: s
feasibility: easy
task_type: chore
area: tests
related: [4494, 4469]
origin: "2026-08-15 IR-migration session — surfaced while investigating #4494 (IR claim/preparability parity) and independently by the #4469 agent: the class-family dev suites were red on clean main for days, with no CI signal."
---

## Problem

Thirteen class-family test files instantiate their compiled modules with a
hand-rolled import object that omits the `string_constants` namespace:

```ts
const { instance } = await WebAssembly.instantiate(result.binary, { env: {} });
```

Any module that declares imported string-constant globals — which a class
declaration does, via its field/method name pool — then dies at **instantiation**:

```
TypeError: WebAssembly.instantiate(): Import #0 module="string_constants":
module is not an object or function
```

The failure happens **before any assertion runs**, so every test in the affected
files was dead weight: it could neither pass nor detect a regression. Measured on
clean `main` (`b7da49d1`), **84 tests across 13 files** were failing this way.

This is the same defect #4029 fixed for `tests/multi-file.test.ts` (a module with
**zero function imports** can still declare string-constant globals, so the
`importObject` short-circuit had to require both `imports` and `stringPool` to be
empty). These 13 files never adopted the `result.importObject` convenience path
(#1667) at all.

### Why it stayed invisible

These are dev-suite files, not part of a required CI gate. They are now
**partially** covered by the changed-files issue-tests lane, which made them
land-mines: the next person to touch any of these files would inherit a wall of
pre-existing red that has nothing to do with their change.

## Fix

Route every affected site through the compiler's own import object (#1667),
which is the canonical documented pattern in `src/index.ts`:

```ts
const imports = result.importObject ?? { env: {} };
const { instance } = await WebAssembly.instantiate(result.binary, imports);
(imports as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
```

The `__setInstance` call is part of the contract (#1712): without it the host
runtime's `getExports()` stays undefined, silently disabling closure wrapping
and `__sget_*` struct-field reads. `tests/class-expressions.test.ts` (plural —
already correct) was the in-repo reference.

**Assertions were not touched.** The change is purely the instantiation line.
`tests/class-expression.test.ts` (singular) had 8 identical inline instantiation
blocks carrying `console_log_number` / `console_log_bool` stubs; those were
folded into one local `instantiate()` helper that keeps the stubs as a
*fallback* overlay (the real host `env` is spread last, so it wins wherever it
provides a binding).

**No `src/` changes at all** — this is a harness fix, not a codegen fix.

## Test Results

Measured on `main` @ `b7da49d1` (before) and on this branch (after). Counts are
`pass / fail`.

### Group A — files named in the #4494 / #4469 evidence

| File                                    | Before  | After  |
| --------------------------------------- | ------- | ------ |
| `tests/classes.test.ts`                 | 0 / 7   | 7 / 0  |
| `tests/class-methods.test.ts`           | 0 / 17  | 17 / 0 |
| `tests/class-method-calls.test.ts`      | 2 / 3   | 5 / 0  |
| `tests/class-method-struct-new.test.ts` | 0 / 4   | 4 / 0  |
| `tests/abstract-classes.test.ts`        | 0 / 6   | 6 / 0  |
| `tests/class-expression.test.ts`        | 0 / 8   | 8 / 0  |
| **Group A total**                       | **2 / 45** | **47 / 0** |

The 45 matches the "~45 class-family tests" in the original evidence exactly.

### Group B — same defect, found by sweeping the rest of the class family

The evidence said "and possibly others". It was right: seven more files carry
the byte-identical helper and were equally dead.

| File                                | Before | After |
| ----------------------------------- | ------ | ----- |
| `tests/static-members.test.ts`      | 0 / 8  | 8 / 0 |
| `tests/inheritance.test.ts`         | 0 / 7  | 7 / 0 |
| `tests/instanceof.test.ts`          | 0 / 7  | 7 / 0 |
| `tests/class-elements-619.test.ts`  | 0 / 6  | 6 / 0 |
| `tests/getters-setters.test.ts`     | 0 / 6  | 6 / 0 |
| `tests/null-deref-class.test.ts`    | 0 / 4  | 4 / 0 |
| `tests/constructor-arity.test.ts`   | 0 / 1  | 1 / 0 |
| **Group B total**                   | **0 / 39** | **39 / 0** |

### Grand total

**2 / 84 → 86 / 0.** All 13 files green.

## Genuine pre-existing codegen failures: NONE

The task anticipated that some of the 84 would survive the harness fix as real
codegen bugs — in particular that some might be the static-vs-instance ABI-key
split another lane is working on. **They did not.** Every one of the 84 failures
was purely the instantiation artifact; once the import object was supplied, all
84 passed on the first run with their original assertions intact.

So there is **no follow-up codegen evidence to hand off** from this issue. That
is a genuine (and slightly surprising) finding, not an omission: the class
family's runtime behaviour on these paths is correct on current `main`, and the
suites had simply been blind to it.

## Residual risk / follow-up

The bare `{ env: {} }` pattern still exists in roughly two dozen **non**-class
test files (e.g. `tests/drop-validation.test.ts`,
`tests/export-declarations.test.ts`, `tests/tail-call-optimization.test.ts`,
`tests/react-fiber-test.test.ts`). Those were **out of scope here** and were not
measured — a module only trips this when it declares string-constant globals, so
some of them are fine and some are probably dead the same way. A follow-up sweep
should measure them before converting; do not assume the count.

The durable fix for the class is a lint rule or a shared test helper that makes
`WebAssembly.instantiate(result.binary, <hand-rolled literal>)` hard to write,
rather than fixing files one family at a time.

## Validation

- 13 converted suites: 86 passed / 0 failed (two runs, Group A and Group B).
- `npm run typecheck` — exit 0.
- `npm run lint` — exit 0.
- `git diff --name-only -- src/ scripts/ .github/` — empty. No compiler change,
  so `check:ir-fallbacks` and every conformance gate are untouched by
  construction.
