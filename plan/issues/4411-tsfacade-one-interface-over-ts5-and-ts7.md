---
id: 4411
title: "TsFacade: one frontend interface over TS5 and TS7, so the implementation can be swapped underneath"
status: ready
sprint: current
created: 2026-08-14
updated: 2026-08-14
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: compiler
goal: performance
parent: 1029
---

## Problem

TypeScript is ~90 % of compile time and it gates CI. TS7 (`typescript@7.0.2`,
the Go port) ships an `unstable/*` programmatic API. The question is whether we
can wrap our use of the TS API behind one interface with TS5 and TS7
implementations, adopt TS7 now, and adapt the implementation later.

**Yes — and two of the three seams already exist.** What is missing is the AST
seam. This issue measures what that costs.

## Seams

| seam                | what crosses it                            | today                                     |
| ------------------- | ------------------------------------------- | ----------------------------------------- |
| module / lane       | which TS a compile loads, per lane          | `src/ts-api.ts` (#1029) — **exists**       |
| type queries        | the ~15 questions codegen may ask           | `TypeOracle` (#1930), 3 backends — **exists** |
| AST + kinds + factory | node shapes, `SyntaxKind`, `ts.factory`   | **missing** — `ts.*` is used directly      |

`TypeOracle` is the important one and it is already the right shape: it is a
_semantic_ interface (`typeFactOf`, `signatureOf`, `nullabilityOf`…), not a
mirror of `ts.TypeChecker`. A TS7 backend is a fourth implementation of the
same 15 methods. The facade this issue adds is the syntactic twin of that.

## Measured constraints

All numbers from `typescript@7.0.2` + `typescript@5.9.3` on this container.

### 1. `SyntaxKind` is renumbered, but the names align

- 386 kind names in TS7, 380 shared with TS5.
- Values diverge from kind 7 onward (a one-slot shift and further drift):
  `NumericLiteral` 9 → 8, `StringLiteral` 11 → 10, `FirstAssignment` 64 → 63.
- **All 33 `First*`/`Last*` marker kinds exist in TS7** with consistent
  numbering, so the ~20 range checks in `src/` (`kind >= FirstAssignment &&
  kind <= LastAssignment`, in `ir/select.ts`, `ir/from-ast.ts`,
  `checker/binder.ts`, `cjs-rewrite.ts`, …) port for free as long as they stay
  **symbolic**.
- No numeric-literal kind comparison exists in `src/` today (the `kind === 0`
  hits in `link/linker.ts` are Wasm import kinds, not `SyntaxKind`).
- Of the 16 TS5-only names, js2wasm uses exactly one: `EndOfFileToken`
  (3 sites), renamed `EndOfFile` in TS7.

⇒ The facade must expose kinds symbolically and forbid raw numbers; that is
already how the codebase is written (3,414 symbolic `SyntaxKind.*` references).

### 2. TS7 ships **no in-process parser**

`typescript7/unstable/ast` exports 409 symbols — `createScanner`, the `is*`
predicates, `forEachChild`, clone/visitor helpers — but **no parser**. Source
files are produced by the Go process and deserialized client-side via
`SourceFileCache`. Reaching an AST therefore requires a live `tsgo` subprocess
(`new API()` → `updateSnapshot()` → `Project` → `Program.getSourceFile()`).

⇒ This is the hard boundary behind the #1029 lane policy, and it stands: the
browser lane and the synchronous `runtime-eval` re-entry stay pinned to TS5
permanently. Node-lane only.

### 3. `ts.factory` maps almost exactly

99 `ts.factory.*` calls across 16 distinct functions; 18 of the 19 checked
exist in `typescript7/unstable/ast/factory` (370 exports). Only `createThis`
is absent — `createToken(SyntaxKind.ThisKeyword)`. `visitEachChild` /
`visitNode` / `visitNodes` exist in `unstable/ast/visitor`, covering
`array-reduce-fusion.ts`.

### 4. Performance — the earlier "TS7's checker is too slow" call was wrong

Same 5.4 KB input, 2,042 AST nodes under **both** parsers (identical count):

| step                                | TS5      | TS7        |
| ----------------------------------- | -------- | ---------- |
| parse only (`createSourceFile`)     | 8.7 ms   | n/a        |
| program + checker ready             | 1,825 ms | **154 ms** |
| one `getTypeAtLocation`, unbatched  | 0.051 ms | 0.052 ms   |
| same query, **batched** (500 nodes) | n/a      | **0.008 ms** |

Two corrections to what was previously recorded on #4218/#1029:

- TS7's IPC checker is **not** slower per query than TS5's in-process one; it
  is the same, and 6.5× faster when batched. `Checker.getTypeAtLocation`,
  `getSymbolAtLocation` and `getTypeAtPosition` all take **arrays**, so a
  compile's ~15 k queries are a handful of round trips, not 15 k. The earlier
  "≈1.8 s of IPC per compile" figure does not hold.
- The 12× win is **program construction**, which is exactly the 90 % the
  premise named.

⇒ TS7's checker is not a blocker for the Node lane. The in-house oracle work
(#4218) remains valuable — it is what makes the browser and eval lanes
checker-free — but it is no longer a _precondition_ for the TS7 swap.

## Design

```ts
interface TsFacade {
  readonly kinds: KindTable;              // symbolic only; never numeric
  readonly is: NodePredicates;            // isIdentifier, isCallExpression, …
  readonly factory: NodeFactory;          // the 16 constructors actually used
  readonly visitor: { visitEachChild; visitNode; visitNodes };
  parse(fileName: string, text: string): SourceFile;
  program(rootNames: string[], options: CompilerOptions): ProgramHandle;
  resolveModule(name: string, containingFile: string): Resolved | undefined;
  readConfig(path: string): ParsedConfig;
}
```

Two implementations, `Ts5Facade` and `Ts7Facade`, selected by
`ts-api.ts`'s existing lane policy (`isTs7Active()`).

**A compile is all-or-nothing per frontend.** A TS5 checker cannot answer
questions about tsgo AST nodes, so the facade choice is made once per compile
and never mixed.

## Staging

1. **Kinds + predicates + factory** — mechanical, no behavior change. Land
   against TS5 first so the facade is exercised before TS7 exists behind it.
   Adds the `EndOfFileToken`/`EndOfFile` and `createThis` shims.
2. **AST shape adapter** — the node-shape surface codegen touches. Node counts
   and `forEachChild` traversal match on the probe input; field-by-field parity
   is the real work and needs its own audit.
3. **`Ts7Oracle`** — a fourth `TypeOracle` backend over `Checker`, using the
   **batched** overloads. Validate with the existing differential lane
   (`oracleBackend: "differential"`), same instrument as #4408/#4410.
4. **Module resolution + config** — `API.parseConfigFile` replaces
   `ts.readConfigFile`/`parseJsonConfigFileContent`; `src/resolve.ts` and
   `src/checker/language-service.ts` are the remaining TS5-API consumers.

## Acceptance criteria

- [ ] `src/ts-facade/` with `TsFacade`, `Ts5Facade`, and the selector wired to
      `ts-api.ts`'s lane policy.
- [ ] A gate that fails on new direct `ts.SyntaxKind` numeric comparisons and
      on new direct `ts.factory` use outside the facade (same shape as the
      oracle ratchet).
- [ ] `Ts7Facade` behind `JS2WASM_TS7`, Node lane only; browser and
      runtime-eval provably still on TS5 (tests in
      `tests/issue-1029-ts7-lane-policy.test.ts` already pin the policy).
- [ ] A benchmark comparing end-to-end compile wall-clock TS5 vs TS7 on the
      playground corpus, published alongside the numbers above.

## Notes

Probe script used for the measurements: `.tmp/ts7-ast-probe.mts` (kind
alignment, factory coverage, parser absence, batched vs unbatched query cost).
It should move to `scripts/` as part of step 1 so the numbers are reproducible
in CI rather than quoted from a session.
