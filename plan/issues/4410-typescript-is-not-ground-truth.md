---
id: 4410
title: "TypeScript is not ground truth: 366 oracle queries where the checker is weaker or plainly wrong"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-14
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: research
area: checker
goal: correctness
parent: 4218
depends_on: [4408]
---

## Problem

The differential oracle answers from the TS5 checker and records where the
in-house backend disagrees. That design silently assumes the checker is right.
It frequently is not — TypeScript is unsound by construction in several places
a JS compiler cares about, and in this codebase it is additionally answering
about the **wrong program**.

After re-classifying the 908 reported conflicts structurally (#4408), **366**
land in a bucket the ledger had no name for: the **in-house backend claims a
fact the checker declines to give**. Adjudicated against ECMAScript, that
bucket splits three ways.

Reproduce the adjudication probes with
`npx tsx scripts/audit-oracle-adjudication.mts` — each prints what ECMAScript
requires next to both backends' answers.

## A. The checker is WRONG; the in-house backend is right

### A1 — a local binding resolved to a lib.d.ts global

`built-ins/Array/fromAsync/mapfn-async-throws-close-async-iterator.js` is
1,199 bytes and contains `let closed = false;` at offset 613.

| query                   | checker                       | in-house  |
| ----------------------- | ----------------------------- | --------- |
| `variableDeclarationOf` | `VariableDeclaration@2318733` | `@613`    |
| `declarationsOf`        | `[VariableDeclaration@2318733]` | `[@613]` |

Offset 2,318,733 is inside the DOM lib (`Window.closed`). The file's own `let`
is the binding; resolving it to a lib global is a plain resolution error, and
acting on it would type a local `let` as the DOM's `closed`.

### A2 — a shadowed `eval` / `arguments`

`language/expressions/assignment/dstr/obj-id-init-simple-no-strict.js` opens
with `var eval, arguments;` (legal in sloppy mode, which the test declares).

| query                | checker                          | in-house                |
| -------------------- | -------------------------------- | ----------------------- |
| `valueDeclarationOf(eval)` | lib's `declare function eval` | the file's `var eval` |

Same in `array-elem-init-simple-no-strict.js` (`var argument, eval;`). The
local `var` shadows the global; the in-house answer is the correct one.

### A3 — a `let` with no initializer

`built-ins/Array/prototype/every/resizable-buffer-grow-mid-iteration.js`:
`let resizeAfter; let resizeTo;`

| query                   | checker     | in-house |
| ----------------------- | ----------- | -------- |
| `variableDeclarationOf(resizeTo)` | `undefined` | the `let` |

Reproduced minimally (`let resizeTo; resizeTo = 4; function use(){return resizeTo}`).
Nothing dynamic is involved; the checker simply does not answer.

### A4 — the checker is bound to a program that does not contain the code

The annexB direct-eval family (`annexB/language/eval-code/direct/global-*-eval-global-existing-fn-update.js`)
reports `valueDeclarationOf(f)`: checker `undefined`, in-house
`FunctionDeclaration`. Parsing the outer file shows **no identifier `f` and no
node at the reported position** — `f` exists only inside the string passed to
`eval`. The compiler re-enters on the eval'd source, and the queries are about
_that_ program's nodes.

The checker's `undefined` is therefore not sound abstention; it is a
`ts.Program`-scoping artifact. The in-house binder, which binds whatever AST it
is handed, answers correctly. **This generalises**: any re-entrant compile
(runtime-eval, `new Function`) is invisible to a checker built for the outer
program, and the in-house backend is structurally better placed.

## B. The question is under-specified, and both answers are defensible

### B1 — shorthand property assignments

`{ calendar }`, `{ join, getContent, isDir }` (Temporal tests, hono):

| query            | checker                        | in-house              |
| ---------------- | ------------------------------ | --------------------- |
| `declarationsOf` | `ShorthandPropertyAssignment`  | the `VariableDeclaration` |

A shorthand property has **two** symbols in TypeScript; `getSymbolAtLocation`
yields the property symbol and `getShorthandAssignmentValueSymbol` yields the
value symbol. Neither is wrong. `TypeOracle.declarationsOf` does not say which
one it wants — an **oracle contract gap**, not a backend bug. For a compiler
asking "what value flows here", the in-house answer is the useful one.

### B2 — annexB B.3.3 block-level function declarations

`annexB/language/global-code/if-decl-*-global-existing-fn-*.js`: `f` resolves
to two different `FunctionDeclaration`s (e.g. `@1719` vs `@1567`). Under
B.3.3.2 the block-level declaration's value is copied into the var-scoped
binding at evaluation, so which declaration a use site "binds to" depends on
program point. The oracle has no way to express that; both answers are
defensible for different points.

## C. The in-house backend is genuinely wrong

Tracked separately in **#4409** (`with`-scoped lexical resolution;
`declaredNameOf` inventing `ArrayConstructor`).

## Why this matters for retiring the checker

The retirement argument had been "reach conflict parity with the checker".
That is the wrong goal in two directions:

1. **Parity with an unsound oracle is not the target.** A2/A3/A4 are cases
   where matching the checker would make the compiler _worse_.
2. **The real gate is soundness, not agreement.** An oracle answer is
   acceptable when it is either correct or an abstention. Agreement with TS is
   evidence, not the definition.

Restated gate for #4218:

- genuine both-claim-different-facts == 0 (currently **88**, #4408), **and**
- every `checker-weaker` row adjudicated into A (in-house right — keep), B
  (contract gap — specify the query), or C (in-house wrong — fix), **and**
- zero standalone-mode test262 regressions under `JS2WASM_ORACLE_BACKEND=inhouse`
  — **currently −37** (1891 → 1854 pass over 3,137 tests in the divergence
  areas, 2026-08-14). 39 of the 42 regressions are the `with`-scope class
  (#4409, 27) and annexB B.3.3 block-function hoisting (12, i.e. B2 below);
  3 are undiagnosed. Five tests improve. So the gate is **not met**, and B2 is
  not merely an "under-specified question" — it costs conformance.

## Acceptance criteria

- [ ] `TypeOracle.declarationsOf` documents whether it means the property
      symbol or the value symbol for shorthand assignments, and both backends
      implement the documented meaning (B1).
- [ ] The oracle documents that answers about re-entrant (eval'd) programs are
      out of the checker backend's reach (A4), so the differential does not
      re-report them as in-house defects.
- [ ] A2/A3 are captured as tests asserting the **in-house** answer, marking
      the checker backend as the deviant one.
- [ ] `docs/` records that TS5 checker answers are evidence, not ground truth,
      with these examples.

## Evidence

Re-classification of the 908 rows, harvested from the 237 conflicting files of
the 2,137-input corpus (playground + stratified test262 + npm packages):
136 same-meaning, 318 in-house-weaker, 366 checker-weaker, 88 genuine. The
88 sit entirely in four binding-resolution queries — `declarationsOf` (44),
`valueDeclarationOf` (24), `typeFactOf` (14), `variableDeclarationOf` (6);
`signatureOf`, which produced 374 of the original 908, has none.
