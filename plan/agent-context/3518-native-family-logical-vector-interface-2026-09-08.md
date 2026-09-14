Freeze these names for the **next dispatch only**; current A/B scopes remain unchanged.

### Lowerer field

In `AstToIrOptions`:

```ts
readonly logicalVectorTypes?: ReadonlyMap<
  ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression,
  Extract<IrType, { kind: "vec" }>
>;
```

Use existing `IrType`; no new vector identity or physical-type interface.

The map is **per lowered function**, keyed by original AST object identity—not names, spans or structural unit-ID strings.

Required keys:

- Vector parameter declarations: both `ids` parameters.
- Vector variable declarations: `pending`, `results`, and main’s `ids`.
- Vector-producing expressions: the two array literals and parallel’s `await Promise.all(pending)`.
- Every vector-valued identifier **read**, including receivers of `.length`, indexing and `.push`, and vector call arguments.
- Any admitted parenthesized vector expression, alongside its inner expression.

Do **not** index declaration-name identifiers, type nodes, property names, numeric indexed results, `.length`/`.push` results, or the `Promise.all(...)` call itself. That call returns the Promise carrier; its **await expression** yields the vector.

Values describe each position accurately:

- Declaration entries describe the declared/accepted binding contract.
- Expression entries describe the actual expression result.
- Consequently, annotated `pending` can have a nullable declaration contract while its literal and immutable identifier reads remain non-null.
- Parameters and the awaited result retain their nullable contracts.

All values must be layout-free. This dispatch admits only the required `f64` and certified Promise-carrier `externref` elements.

### Validation responsibilities

**A’s producer:** checker-bound identity, exact ambient Promise certification, element types, declaration/use correspondence, ownership and complete per-function map construction. No type assertion alone supplies evidence.

**B’s lowerer:** validate keys belong to the current function, excluding nested executable scopes; check parameter entries against overrides; check initializer-to-declaration assignability; check expression entries against actual builder types. Never overwrite an actual type to match the map.

When the map is present, every encountered vector operation requires its applicable entries. Missing or contradictory entries fail explicitly—no physical-resolver fallback. Absence preserves the historical path. An empty map cannot admit a function containing vector parameters or operations.

The map remains frontend-local and never enters typed input, allocation snapshots or codec output.

### Full-family option

On `IrProgramSourceInput`:

```ts
readonly asyncFamilyProjection?: "disabled" | "standalone-native";
```

Absent means `"disabled"`.

`"standalone-native"` requires:

- `promiseDelayProjection === "standalone-native"`;
- source policy `backend === "wasmgc"` and `target === "standalone"`;
- every requested runtime projection has that same backend/target;
- successful source-bound full-family closure and A’s certified delay/support-node validation.

`prepareIrProgramSources` validates source selection; `prepareWholeIrProgram` additionally validates runtime projections before source preparation. Neither option implies the other, and neither is inferred from fast/default settings.

B owns the lowerer field and consumption checks; A owns the source option and producer. Freeze that interface before their next implementation dispatch.
