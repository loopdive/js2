// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Static `with` statement lowering (#1387).
 *
 * This slice implements the Tier-1, closed-shape path for object literals:
 * the `with` target is compiled once into a local, the literal's own key set
 * is treated as closed, and bare identifier references that statically satisfy
 * Object Environment Record HasBinding are rewritten to direct struct
 * get/set. Unproven targets keep the #1387 diagnostic gate.
 */
import { ts, forEachChild } from "../ts-api.js";
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import { planIrWithTarget, selectWithEnvironmentClosures } from "../ir/with-environment.js";
import { reportError } from "./context/errors.js";
import { pushBody, popBody } from "./context/bodies.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureComputedPropertyFields, compileObjectLiteralForStruct } from "./literals.js";
import { ensureStructForType, resolveWasmType } from "./index.js";
import { resolveStructName } from "./property-access.js";
import { emitDynGet } from "./dyn-read.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { emitThrowTypeError } from "./expressions/helpers.js";
import { compileExpression, compileStatement, coerceType, valTypesMatch } from "./shared.js";

const OBJECT_PROTOTYPE_KEYS = new Set([
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
]);

/**
 * (#2663 Slice 4) The HasBinding gate import for the dynamic `with` object
 * environment record. HOST mode uses `__with_has_binding`, which applies the
 * full ECMAScript §9.1.1.2.1 predicate: value-independent HasProperty filtered
 * by the receiver's @@unscopables blocklist (a `with`-routed name shadows the
 * outer binding only when HasBinding is true). Under `--target standalone`
 * there is no JS host, and the dynamic-`with` path already emits `__extern_has`
 * — which the #1472 standalone gate REFUSES (dynamic `with` is host-only). We
 * keep that exact name in standalone so the refusal is byte-identical to Slices
 * 1-3; `__with_has_binding` is NOT `__extern_*`-prefixed and so would NOT be
 * refused, which must never leak into a no-JS-host build.
 */
function withHasBindingImport(ctx: CodegenContext): string {
  return ctx.standalone ? "__extern_has" : "__with_has_binding";
}

/**
 * (#4231 RC-B) The result type of `delete name` resolved through a `with` scope.
 *
 * §13.5.1.2 evaluates to a BOOLEAN. The i32 carrying it must say so: an untagged
 * `{kind:"i32"}` flowing into an externref consumer is boxed as a NUMBER
 * (`f64.convert_i32_s` + `__box_number`), so `del = delete p3` inside a `with`
 * yielded `1` and `del === true` was false. A plain `delete o.p` never hit this
 * because its consumer is boolean-typed and no boxing happens.
 */
const DELETE_RESULT: ValType = { kind: "i32", boolean: true };

/** A static (#1387 Tier-1) `with` scope entry. */
export type StaticWithScope = Extract<NonNullable<FunctionContext["withScopes"]>[number], { kind: "static" }>;

export interface WithBinding {
  scope: StaticWithScope;
  field: FieldDef;
  fieldIdx: number;
}

type WithTargetIntegrity = "plain" | "sealed" | "frozen";

interface WithTargetProof {
  ok: true;
  expr: ts.ObjectLiteralExpression;
  keys: Set<string>;
  integrity: WithTargetIntegrity;
}

/** A dynamic (#2663 Tier-2) `with` scope: arbitrary externref target resolved at
 *  runtime via HasBinding + Get. */
export type DynamicWithScope = Extract<NonNullable<FunctionContext["withScopes"]>[number], { kind: "dynamic" }>;

/** Result of resolving a bare identifier against the `with` scope stack. */
export type WithResolution =
  | { kind: "static"; binding: WithBinding }
  | { kind: "dynamic"; scope: DynamicWithScope }
  | null;

export function findWithBinding(fctx: FunctionContext, name: string): WithBinding | null {
  const res = resolveWithBinding(fctx, name);
  return res?.kind === "static" ? res.binding : null;
}

/**
 * (#2663 Slice 1) Resolve a bare identifier against the `with` scope stack,
 * innermost-first, across a MIXED static/dynamic stack.
 *
 * - A `static` scope hit returns the proven struct field binding (Tier-1
 *   zero-overhead path) — short-circuits the walk.
 * - A `dynamic` scope hit returns the scope for a runtime HasBinding-gated
 *   select (the absent case falls through to the next-outer scope / lexical at
 *   runtime, but statically we resolve to the innermost non-shadowing dynamic
 *   scope and let codegen emit the gate + fallback).
 * - `blockedNames` (body-declared lexical/inner-function names) shadow a scope
 *   for that name — skip it.
 */
export function resolveWithBinding(fctx: FunctionContext, name: string): WithResolution {
  const scopes = fctx.withScopes;
  if (!scopes || scopes.length === 0) return null;

  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (scope.blockedNames.has(name)) continue;
    if (scope.kind === "dynamic") {
      // Runtime HasBinding decides presence; resolve to this dynamic scope and
      // let codegen emit the gated select (present ⇒ object, absent ⇒ outer).
      return { kind: "dynamic", scope };
    }
    // static scope
    const fieldIdx = scope.fields.findIndex((f) => f.name === name);
    if (fieldIdx >= 0) {
      return { kind: "static", binding: { scope, field: scope.fields[fieldIdx]!, fieldIdx } };
    }
    if (OBJECT_PROTOTYPE_KEYS.has(name)) {
      return null;
    }
  }
  return null;
}

export function emitWithBindingGet(fctx: FunctionContext, binding: WithBinding): ValType {
  fctx.body.push({ op: "local.get", index: binding.scope.localIdx });
  fctx.body.push({ op: "struct.get", typeIdx: binding.scope.structTypeIdx, fieldIdx: binding.fieldIdx });
  return binding.field.type;
}

export function compileWithBindingAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  binding: WithBinding,
  rhs: ts.Expression,
): ValType | null {
  if (!binding.field.mutable) {
    reportError(
      ctx,
      rhs,
      `#1387: cannot assign through with binding "${binding.field.name}" because the field is immutable`,
    );
    return null;
  }

  const resultType = compileExpression(ctx, fctx, rhs, binding.field.type);
  if (!resultType) return null;
  if (!valTypesMatch(resultType, binding.field.type)) {
    coerceType(ctx, fctx, resultType, binding.field.type);
  }

  const tmp = allocTempLocal(fctx, binding.field.type);
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: binding.scope.localIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "struct.set", typeIdx: binding.scope.structTypeIdx, fieldIdx: binding.fieldIdx });
  fctx.body.push({ op: "local.get", index: tmp });
  releaseTempLocal(fctx, tmp);
  return binding.field.type;
}

export function compileWithStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WithStatement): void {
  const closureSelection = selectWithEnvironmentClosures(stmt.statement);
  if (!closureSelection.ok) {
    reportWithStatementDiagnostic(ctx, stmt, closureSelection.reason);
    return;
  }
  const proof = proveObjectLiteralWithTarget(fctx, stmt.expression);
  // (#2663 Slice 1) Tier-1 (static closed-shape) is the zero-overhead fast path.
  // Ordinary synchronous function expressions may capture the receiver through
  // the #4206 environment contract. The selector above refuses every other
  // nested function/class boundary before either target tier is considered.
  if (proof.ok) {
    const targetType = compileClosedObjectLiteralTarget(ctx, fctx, proof.expr);
    finalizeStaticWithScope(ctx, fctx, stmt, targetType, proof.keys, proof.integrity, /* guardInheritedKeys */ true);
    return;
  }

  // (#3025 W1) Tier-1 over a closed-struct-TYPED target — a bare variable whose
  // static TS type `resolveStructName`s to a closed WasmGC struct (the dominant
  // `var o = { ... }; with (o) { ... }` test262 pattern). Compile it into a
  // struct-typed local and route field reads/writes to direct struct get/set,
  // exactly as the object-literal path does. The Tier-2 dynamic path cannot see
  // a struct's fields (a GC struct wrapped as an opaque externref is invisible to
  // host `in`/get reflection), so without this every own-field read misses and
  // resolves to a bare global → ReferenceError. Conservative gates (all →
  // fall through to Tier-2, never a compile error): see `proveStructTypedWithTarget`.
  const structProof = proveStructTypedWithTarget(ctx, stmt);
  if (structProof) {
    const targetType = compileExpression(ctx, fctx, stmt.expression, undefined);
    if (targetType && (targetType.kind === "ref" || targetType.kind === "ref_null")) {
      finalizeStaticWithScope(ctx, fctx, stmt, targetType, new Set(), "plain", /* guardInheritedKeys */ false);
      return;
    }
    // The proof said struct-typed but lowering did not yield a struct ref. The
    // target is a side-effect-free identifier, so dropping it and re-routing to
    // the dynamic path below re-evaluates it harmlessly (no double side effect).
    if (targetType) fctx.body.push({ op: "drop" });
  }

  // Any non-proven target — `with(fn())`, host objects, `any`-typed, etc. —
  // falls to the Tier-2 dynamic-scope path (runtime HasBinding + Get) rather than
  // a compile-time rejection.
  compileDynamicWithStatement(ctx, fctx, stmt);
}

/**
 * (#1387 / #3025 W1) Shared tail for both Tier-1 static paths (object literal and
 * closed-struct-typed variable). The target has already been compiled and its
 * struct ref is on top of the stack (`targetType`). Sinks it into a fresh local,
 * derives the struct field set, validates `requiredKeys`, and pushes a `static`
 * `WithScope` so bare-identifier reads/writes inside the body route to direct
 * struct get/set.
 *
 * `guardInheritedKeys` (object-literal path only): report a diagnostic when the
 * body references an inherited `Object.prototype` key that is not an own field —
 * the struct-typed path pre-clears this in its proof (falling through to Tier-2
 * instead) so it passes `false`.
 */
function finalizeStaticWithScope(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.WithStatement,
  targetType: ValType | null,
  requiredKeys: Set<string>,
  integrity: WithTargetIntegrity,
  guardInheritedKeys: boolean,
): void {
  if (!targetType || (targetType.kind !== "ref" && targetType.kind !== "ref_null")) {
    if (targetType) fctx.body.push({ op: "drop" });
    // Degenerate: proof said closed shape but lowering didn't yield a struct.
    reportWithStatementDiagnostic(ctx, stmt, "target did not lower to a WasmGC struct with a closed shape");
    return;
  }

  const structTypeIdx = targetType.typeIdx;
  const captureName = `__with_scope_${fctx.locals.length}`;
  const localIdx = allocLocal(fctx, captureName, targetType);
  fctx.body.push({ op: "local.set", index: localIdx });

  const typeName = ctx.typeIdxToStructName.get(structTypeIdx);
  const fields = typeName ? ctx.structFields.get(typeName) : undefined;
  if (!fields) {
    reportWithStatementDiagnostic(ctx, stmt, "compiled target struct fields are unavailable");
    return;
  }

  const targetKeys = new Set(fields.map((f) => f.name));
  for (const key of requiredKeys) {
    if (!targetKeys.has(key)) {
      reportWithStatementDiagnostic(ctx, stmt, `compiled target struct is missing literal key "${key}"`);
      return;
    }
  }

  // (#4231 RC-A) Only LEXICAL body declarations shadow the object environment
  // record — the same rule the Tier-2 path has always applied
  // (`collectBodyLexicalNames`, see its doc comment). A `var` inside `with`
  // hoists to the FUNCTION environment, but §14.11.2's object environment is
  // consulted FIRST, so the object wins whenever it owns the name:
  // `with ({value:'mv'}) { var value = 'v'; }` must write the OBJECT and leave
  // the hoisted `value` undefined. Tier-1 used the full declared set and so
  // routed every such name to the local instead.
  const blockedNames = collectBodyLexicalNames(stmt.statement);
  if (guardInheritedKeys) {
    // The inherited-Object.prototype-key diagnostic keeps the BROADER declared
    // set on purpose: it decides whether to hard-error, and widening what it
    // considers unshadowed would turn bodies that compile today (`var toString
    // = …`) into compile errors. Narrowing name RESOLUTION is the fix; widening
    // a refusal is not part of it.
    const declaredNames = collectBodyDeclaredNames(stmt.statement);
    const referencedNames = collectBodyReferencedNames(stmt.statement);
    for (const name of referencedNames) {
      if (!declaredNames.has(name) && !requiredKeys.has(name) && OBJECT_PROTOTYPE_KEYS.has(name)) {
        reportWithStatementDiagnostic(
          ctx,
          stmt,
          `body references inherited Object.prototype key "${name}", which this static slice cannot route as an own field`,
        );
        return;
      }
    }
  }
  const scopeFields = integrity === "frozen" ? fields.map((field) => ({ ...field, mutable: false })) : fields;
  const scope = { kind: "static" as const, captureName, localIdx, structTypeIdx, fields: scopeFields, blockedNames };
  (fctx.withScopes ??= []).push(scope);
  try {
    compileStatement(ctx, fctx, stmt.statement);
  } finally {
    fctx.withScopes?.pop();
  }
}

/**
 * (#3025 W1) Prove a NON-literal `with` target whose static TS type resolves to a
 * closed WasmGC struct is safe to route through the zero-overhead Tier-1 static
 * path. Returns the resolved struct type name on success, or `null` to fall
 * through to the Tier-2 dynamic path. Every rejection is a fall-through, NEVER a
 * compile error — a wrong static claim is a soundness bug; a fall-through is only
 * a coverage/perf loss (Tier-2 is the semantic backstop).
 *
 * Conservative gates:
 *   (0) only a bare identifier target (`with (o)`) — side-effect-free, so a
 *       post-compile fall-through cannot double-evaluate a side effect, and it is
 *       the overwhelming test262 pattern. Call/member targets defer to Tier-2.
 *   (c) `any` / `unknown` / `null` / `undefined` / `void` / union / intersection
 *       types — the runtime shape is not a single provable struct.
 *   The type must `resolveStructName` to a struct with a known, non-empty field
 *       set (a closed shape).
 *   (a)/(b) a body-referenced name that is NOT a struct field but which the
 *       object actually carries — an inherited `Object.prototype` key, or an own
 *       member the struct lowering dropped (method/accessor) — the static scope
 *       can't see it, so defer to Tier-2 (which consults own+proto via HasBinding).
 */
function proveStructTypedWithTarget(ctx: CodegenContext, stmt: ts.WithStatement): { typeName: string } | null {
  // Gate (0): bare identifier only (unwrap parentheses).
  let ident: ts.Expression = stmt.expression;
  while (ts.isParenthesizedExpression(ident)) ident = ident.expression;
  if (!ts.isIdentifier(ident)) return null;
  // `undefined` is an identifier syntactically but never a struct target.
  if (ident.text === "undefined") return null;

  // Resolve the identifier's type via its SYMBOL's declaration, not its use
  // site. Inside a `with` body the TS checker widens every identifier to `any`
  // (dynamic scope it cannot model), so the use-site type of a nested `with (b)`
  // target is `any` and would reject it. The declaration type is immune to that
  // widening and is exactly the struct the WasmGC local carries. This is
  // name/binding resolution — explicitly OUT of the oracle's scope (#1930 D3) —
  // so it uses a local `checker` alias rather than the ratcheted checker field.
  const { checker } = ctx;
  const symbol = checker.getSymbolAtLocation(ident);
  const decl = symbol?.valueDeclaration;
  if (!symbol || !decl) return null;
  const tsType = checker.getTypeOfSymbolAtLocation(symbol, decl);
  // Gate (c): non-single-object shapes.
  if (
    tsType.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
  ) {
    return null;
  }
  if ((tsType as ts.Type).isUnionOrIntersection?.()) return null;

  // Resolve to a closed struct WITHOUT forcing registration. A variable that the
  // compiler already lowered to a WasmGC struct resolves here; a variable that
  // was demoted to an externref-backed dynamic `$Object` (e.g. because the
  // program mutates it with a computed/Symbol-keyed write such as
  // `env[Symbol.unscopables] = …`) resolves to `undefined` and MUST stay on the
  // Tier-2 dynamic path, whose host reflection honours @@unscopables and the full
  // Object Environment Record semantics. Force-registering a struct for such a
  // demoted object would wrongly route it through the static path (regressing the
  // #2663 @@unscopables gates).
  const typeName = resolveStructName(ctx, tsType);
  if (!typeName) return null;
  const fields = ctx.structFields.get(typeName);
  if (!fields || fields.length === 0) return null;
  const fieldNames = new Set(fields.map((f) => f.name));

  // A `@@unscopables` member means name-resolution depends on the runtime
  // blocklist (§9.1.1.2.1) — only the dynamic HasBinding gate applies it. The
  // literal case surfaces as a struct field; the runtime case
  // (`o[Symbol.unscopables] = …`) surfaces as a dynamic-key element write below.
  if (fieldNames.has("@@unscopables")) return null;

  // Gate (b): a computed/Symbol-keyed element WRITE to the target variable
  // anywhere in scope (`env[Symbol.unscopables] = …`, `o[k] = v`) can add an own
  // property the static struct view does not model — including a runtime
  // @@unscopables blocklist. The struct scope cannot see it, so defer to Tier-2.
  if (targetReceivesDynamicElementWrite(ident)) return null;

  // W1's IR-owned target plan is also the static-projection disqualifier: a
  // bare `delete name` needs runtime HasBinding/DeleteBinding and one canonical
  // open object identity for the later direct readback.
  // `fieldNames` is this target's own key set: it keeps a write to an OUTER
  // binding from disqualifying the static projection (see planIrWithTarget).
  if (planIrWithTarget(stmt, fieldNames).representation === "open-object") return null;

  // Gates (a)/(b): a body-referenced name the static struct scope cannot route
  // but the object actually binds ⇒ defer to Tier-2.
  const blockedNames = collectBodyDeclaredNames(stmt.statement);
  const referencedNames = collectBodyReferencedNames(stmt.statement);
  for (const name of referencedNames) {
    if (blockedNames.has(name) || fieldNames.has(name)) continue;
    if (OBJECT_PROTOTYPE_KEYS.has(name)) return null; // inherited Object.prototype key (gate a)
    if (checker.getPropertyOfType(tsType, name)) return null; // own member dropped by lowering (gate b)
  }
  return { typeName };
}

/**
 * (#2663 Slice 1) Tier-2 dynamic `with` lowering. The target is an arbitrary
 * value (variable / call / non-closed literal). ECMA-262 §14.11.7: evaluate the
 * target, `GetValue`, `ToObject` (throws TypeError on null/undefined), and run
 * the body with an Object Environment Record on the scope chain. Bare-identifier
 * reads inside the body are resolved at runtime via `emitDynamicWithGet`
 * (HasBinding gate + Get, falling back to the outer lowering when absent).
 *
 * Ordinary synchronous function expressions may retain this scope entry via
 * the #4206 environment capture contract. Other nested function/class forms
 * are refused by the shared selector before dynamic lowering begins.
 */
function compileDynamicWithStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WithStatement): void {
  // §14.11.7 step 1-3: evaluate the target and coerce to a uniform externref
  // receiver (struct ref / boxed any / host object all normalize to externref).
  //
  // (#4206) Compile with NO expected type, then convert the reference by hand.
  // Asking for `externref` here routes a nominal struct through the #2358
  // ToPrimitive-boundary arm, which REIFIES a literal carrying `valueOf` /
  // `toString` — i.e. field-COPIES it into a fresh `$Object`. An object
  // environment record over a copy still reads and writes plausibly inside the
  // body, so the loss is silent: `for (p in o) with (o) { p1 = "x1" }` left
  // `o.p1` untouched while the body's own read of `p1` answered `"x1"`. §14.11.7
  // binds ToObject(target) — the same object — so the live reference is the only
  // correct receiver, and `__extern_get`/`__extern_set` already carry
  // closed-struct arms for it.
  const targetType = compileExpression(ctx, fctx, stmt.expression);
  if (!targetType) {
    reportWithStatementDiagnostic(ctx, stmt, "dynamic with target did not compile");
    return;
  }
  if (targetType.kind === "ref" || targetType.kind === "ref_null") {
    fctx.body.push({ op: "extern.convert_any" });
  } else if (targetType.kind !== "externref") {
    coerceType(ctx, fctx, targetType, { kind: "externref" });
  }
  const captureName = `__with_dyn_${fctx.locals.length}`;
  const localIdx = allocLocal(fctx, captureName, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: localIdx });

  // §14.11.7: ToObject(undefined|null) throws TypeError. A JS `undefined`/`null`
  // is a NON-null externref wrapping the host sentinel, so `ref.is_null` alone is
  // insufficient — use `__extern_is_undefined` (host) which matches `v == null`.
  // Guard: if (__extern_is_undefined(recv)) throw TypeError.
  const isUndefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  if (isUndefIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "call", funcIdx: isUndefIdx });
    // (#4231 RC-C) `__extern_is_undefined` recognises the host `undefined`/`null`
    // SENTINEL, but a literal `with (null)` lowers to a genuine wasm
    // `ref.null.extern`, which is not that sentinel and slipped through — so
    // `with (null)` ran its body instead of throwing (12.10-2-5). OR in the
    // structural null test; `with (undefined)` already threw via the sentinel arm.
    fctx.body.push({ op: "local.get", index: localIdx });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.or" });
    const savedGuard = pushBody(fctx);
    emitThrowTypeError(ctx, fctx, "Cannot convert undefined or null to object");
    const throwArm = fctx.body;
    popBody(fctx, savedGuard);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwArm });
  }

  // Only body-declared LEXICAL names (let/const/class/catch) + inner-function
  // names genuinely shadow the object environment. `var`/function-scope names do
  // NOT — a `var` inside `with` hoists to the function env, but the object env is
  // consulted FIRST at runtime, so a `var foo` must still pass the HasBinding
  // gate (object wins if it owns `foo`; else the hoisted var). Using the lexical
  // set (not the full declared set) is what makes `with({foo:..}){ var foo=.. }`
  // write the OBJECT, while keeping the empty-object canary correct (gate misses
  // ⇒ falls to the hoisted var). (#2663 Slice 2 var-precedence refinement.)
  const blockedNames = collectBodyLexicalNames(stmt.statement);

  (fctx.withScopes ??= []).push({ kind: "dynamic", captureName, localIdx, blockedNames });
  try {
    compileStatement(ctx, fctx, stmt.statement);
  } finally {
    fctx.withScopes?.pop();
  }
}

/**
 * (#2663 Slice 1) Emit the HasBinding-gated READ select for a bare identifier
 * that resolved to a dynamic `with` scope (§9.1.1.2.1 HasBinding +
 * §9.1.1.2.5 GetBindingValue):
 *
 *   if (HasBinding(recv, name)) result = Get(recv, name) else result = <outer>
 *
 * Both arms normalize to `externref` (the `Get` half yields externref; the outer
 * fallback is coerced). `emitFallback` emits the name's normal (non-with)
 * lowering into the current body and returns its ValType (or null on error).
 *
 * Slice 1 treats HasProperty as HasBinding (no `@@unscopables` — Slice 4). The
 * gate uses the value-INDEPENDENT host `__extern_has` (NOT `__dyn_has`'s
 * non-null proxy): a property present with value `undefined` MUST still shadow
 * the outer binding (§7.3.12).
 */
export function emitDynamicWithGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
  emitFallback: () => ValType | null,
  // (#2663 Slice 3) Optional PRE-CAPTURED HasBinding i32 local (from
  // `emitCaptureWithHasBinding`). When supplied the gate branches on it instead
  // of re-calling the host predicate — required for read-modify-write
  // (`x += v`, `x++`), where §13.15.2/§13.4 resolve the Reference ONCE and both
  // the Get and the Put must use that same resolution even if the read's own
  // getter mutates the with-object mid-evaluation.
  hasLocalIdx?: number,
): ValType {
  // HasBinding gate: __extern_has(recv, "name") -> i32 (own+proto, value-indep).
  addStringConstantGlobal(ctx, name);
  const hasIdx =
    hasLocalIdx !== undefined
      ? -1
      : ensureLateImport(
          ctx,
          withHasBindingImport(ctx),
          [{ kind: "externref" }, { kind: "externref" }],
          [{ kind: "i32" }],
        );
  flushLateImportShifts(ctx, fctx);

  // THEN arm: Get(recv, name) -> externref (via the #2580 substrate emitDynGet).
  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  emitDynGet(ctx, fctx, name);
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  // ELSE arm: the name's normal (outer) lowering, normalized to externref.
  const savedElse = pushBody(fctx);
  const fbType = emitFallback();
  if (fbType && fbType.kind !== "externref") {
    coerceType(ctx, fctx, fbType, { kind: "externref" });
  }
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  if (hasIdx === undefined) {
    // Could not register the gate — fall back to the plain outer lowering
    // (already captured in elseArm); splice it inline so we don't lose it.
    fctx.body.push(...elseArm);
    return { kind: "externref" };
  }

  if (hasLocalIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: hasLocalIdx });
  } else {
    fctx.body.push({ op: "local.get", index: scope.localIdx });
    // Build the key externref + __extern_has call as the condition.
    for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
    fctx.body.push({ op: "call", funcIdx: hasIdx });
  }
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } as ValType },
    then: thenArm,
    else: elseArm,
  });
  return { kind: "externref" };
}

/**
 * (#2061 fix / #2663 Slice 2, moved here in Slice 3) Capture
 * `HasBinding(scope, name)` into an i32 temp for EVERY candidate dynamic-`with`
 * scope on the cascade chain, BEFORE the value that will be written is
 * evaluated (§13.15.2 — the LHS Reference is resolved before the RHS). Returns
 * a Map keyed by the dynamic scope object → its captured i32 local index, which
 * `emitDynamicWithIdentifierWrite` / `emitDynamicWithCascadeRead` then branch on
 * instead of recomputing HasBinding. Walks innermost-first, truncating the
 * matched scope each step (same cascade shape as the read/write themselves).
 *
 * (Computing HasBinding AFTER the RHS — as the original Slice 2 did — let an RHS
 * that adds the property to the with-object change the binding decision and
 * mis-route the write: regressed test262 `S11.13.1_A6_T3`.)
 */
export function captureDynamicWithHasBindings(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): Map<object, number> {
  const out = new Map<object, number>();
  let scopes = fctx.withScopes;
  const saved = fctx.withScopes;
  try {
    // Walk the cascade: resolve, capture, truncate the matched scope, repeat.
    while (scopes && scopes.length > 0) {
      const res = resolveWithBinding(fctx, name);
      if (res?.kind !== "dynamic") break; // static hit / lexical → no more gates
      out.set(res.scope, emitCaptureWithHasBinding(ctx, fctx, res.scope, name));
      const matchedIdx = scopes.lastIndexOf(res.scope);
      scopes = scopes.slice(0, matchedIdx);
      fctx.withScopes = scopes;
    }
  } finally {
    fctx.withScopes = saved;
  }
  return out;
}

/**
 * (#2663 Slice 3) Cascading READ of a bare identifier through the `with` scope
 * stack, gated on PRE-CAPTURED HasBinding i32s (`captureDynamicWithHasBindings`)
 * rather than freshly computed ones, and normalised to `externref`.
 *
 * This is the Get half of a read-modify-write (`x += v`, `x++`, `x--`) through a
 * `with`: §13.15.2 / §13.4 resolve the Reference ONCE, then GetValue and
 * PutValue both operate on THAT reference. Recomputing HasBinding at the write
 * would let a getter that deletes the property (the shape of the whole
 * `S11.13.2_A5.*` / `S11.4.4_A5_*` / `S11.3.1_A5_*` family) re-route the write
 * to the outer binding.
 *
 * Innermost-first, exactly mirroring `emitDynamicWithIdentifierWrite`:
 *  - dynamic scope with a captured gate ⇒ `if (has) Get(recv,name) else <outer>`
 *  - static (Tier-1 closed-shape) scope ⇒ `struct.get`, coerced to externref
 *  - no with scope binds the name ⇒ the plain lexical read, coerced to externref
 */
export function emitDynamicWithCascadeRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
  captures: Map<object, number>,
): ValType {
  const res = resolveWithBinding(fctx, id.text);
  if (res?.kind === "dynamic") {
    const scopes = fctx.withScopes!;
    const matchedIdx = scopes.lastIndexOf(res.scope);
    const outer = (): ValType => {
      const saved = fctx.withScopes;
      fctx.withScopes = scopes.slice(0, matchedIdx);
      try {
        return emitDynamicWithCascadeRead(ctx, fctx, id, captures);
      } finally {
        fctx.withScopes = saved;
      }
    };
    const hasLocal = captures.get(res.scope);
    // A missing capture means the gate could not be registered — treat the name
    // as unbound on this object and cascade outward (same policy as the write).
    if (hasLocal === undefined) return outer();
    return emitDynamicWithGet(ctx, fctx, res.scope, id.text, outer, hasLocal);
  }
  if (res?.kind === "static") {
    const fieldType = emitWithBindingGet(fctx, res.binding);
    if (fieldType.kind !== "externref") coerceType(ctx, fctx, fieldType, { kind: "externref" });
    return { kind: "externref" };
  }
  // No `with` scope binds the name here — the plain lexical read.
  const lexical = compileExpression(ctx, fctx, id, { kind: "externref" });
  if (!lexical) return { kind: "externref" };
  if (lexical.kind !== "externref") coerceType(ctx, fctx, lexical, { kind: "externref" });
  return { kind: "externref" };
}

/**
 * (#2663 Slice 2) Emit the HasBinding-gated WRITE for `name = <value in
 * rhsLocalIdx>` where `name` resolved to a dynamic `with` scope (§9.1.1.2.4
 * SetMutableBinding), STATEMENT form (leaves nothing on the stack):
 *
 *   if (HasBinding(recv, name)) __extern_set(recv, name, rhsVal) else <fallback>
 *
 * The RHS is pre-evaluated ONCE by the caller into the externref temp
 * `rhsLocalIdx` (§13.15.2). `with` is sloppy-only, so the write uses
 * `__extern_set` (silent-on-failure, not the strict variant).
 * `emitFallbackWrite()` emits the next-outer write (another dynamic-with gate,
 * or the lexical write) using the same temp; it must leave nothing on the stack.
 */
/**
 * (#2663 Slice 2 / #2061 fix) Emit `__extern_has(recv, name) -> i32` into a fresh
 * i32 local, returning its index. §13.15.2: for a plain `=` assignment the LHS
 * Reference is resolved (→ HasBinding) BEFORE the RHS is evaluated. So the caller
 * captures each candidate dynamic-with scope's HasBinding with this helper BEFORE
 * compiling the RHS; the gated write then branches on the captured i32.
 *
 * (Computing HasBinding AFTER the RHS — as the original Slice 2 did — let an RHS
 * that adds the property to the with-object change the binding decision and
 * mis-route the write: regressed test262 `S11.13.1_A6_T3` — "PutValue uses the
 * initially-created Reference even if a more local binding is available".)
 */
export function emitCaptureWithHasBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
): number {
  addStringConstantGlobal(ctx, name);
  const hasIdx = ensureLateImport(
    ctx,
    withHasBindingImport(ctx),
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const hasLocal = allocLocal(fctx, `__with_has_${fctx.locals.length}`, { kind: "i32" });
  if (hasIdx === undefined) {
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: hasLocal });
    return hasLocal;
  }
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: hasIdx });
  fctx.body.push({ op: "local.set", index: hasLocal });
  return hasLocal;
}

/**
 * (#2663 Slice 2) Emit the WRITE for `name = <value in rhsLocalIdx>` gated on a
 * PRE-CAPTURED HasBinding i32 (`hasLocalIdx`, from `emitCaptureWithHasBinding`,
 * evaluated BEFORE the RHS per §13.15.2). Statement form (leaves nothing on the
 * stack): `if (hasLocal) __extern_set(recv,name,rhs) else <fallback>`. `with` is
 * sloppy-only ⇒ `__extern_set` (silent-on-failure).
 */
export function emitDynamicWithSet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
  rhsLocalIdx: number,
  hasLocalIdx: number,
  emitFallbackWrite: () => void,
): void {
  addStringConstantGlobal(ctx, name);
  const setIdx = ensureLateImport(
    ctx,
    "__extern_set",
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [],
  );
  flushLateImportShifts(ctx, fctx);

  // ELSE arm: the next-outer write (cascade), using the pre-computed RHS.
  const savedElse = pushBody(fctx);
  emitFallbackWrite();
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  if (setIdx === undefined) {
    // Setter unavailable — perform the fallback write only.
    fctx.body.push(...elseArm);
    return;
  }

  // THEN arm: __extern_set(recv, "name", rhsVal) → writes the object binding.
  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "local.get", index: rhsLocalIdx });
  fctx.body.push({ op: "call", funcIdx: setIdx });
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  // Branch on the PRE-CAPTURED HasBinding (resolved before the RHS, §13.15.2).
  fctx.body.push({ op: "local.get", index: hasLocalIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenArm,
    else: elseArm,
  });
}

/**
 * (#2663 Slice 3) Emit `delete name` where `name` resolved to a dynamic `with`
 * scope, leaving an i32 result on the stack (§13.5.1.2 / §8.5.2 DeleteBinding):
 *
 *   if (HasBinding(recv, name)) result = __delete_property(recv, name)
 *   else result = <outer delete>   // a bare variable is not deletable ⇒ 0,
 *                                  // unless an outer with also binds it (cascade)
 *
 * `emitOuterDelete()` emits the next-outer `delete name` result as i32 (another
 * dynamic-with gate, or the plain "variables not deletable" `i32.const 0`).
 */
export function emitDynamicWithDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  scope: DynamicWithScope,
  name: string,
  emitOuterDelete: () => void,
): ValType {
  addStringConstantGlobal(ctx, name);
  const hasIdx = ensureLateImport(
    ctx,
    withHasBindingImport(ctx),
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  const delIdx = ensureLateImport(
    ctx,
    "__delete_property",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);

  // ELSE arm: the next-outer delete (cascade) → i32.
  const savedElse = pushBody(fctx);
  emitOuterDelete();
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  if (hasIdx === undefined || delIdx === undefined) {
    fctx.body.push(...elseArm);
    return DELETE_RESULT;
  }

  // THEN arm: __delete_property(recv, name) → i32 (configurability-aware result).
  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: delIdx });
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  fctx.body.push({ op: "local.get", index: scope.localIdx });
  for (const instr of stringConstantExternrefInstrs(ctx, name)) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: hasIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: thenArm,
    else: elseArm,
  });
  return DELETE_RESULT;
}

function compileClosedObjectLiteralTarget(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression,
): ValType | null {
  const tsType = ctx.checker.getTypeAtLocation(expr);
  let typeName = resolveStructName(ctx, tsType);
  if (!typeName) {
    ensureStructForType(ctx, tsType);
    typeName = resolveStructName(ctx, tsType);
  }
  if (!typeName) {
    typeName = registerClosedLiteralStruct(ctx, expr);
  }
  ensureComputedPropertyFields(ctx, fctx, expr, tsType);
  return compileObjectLiteralForStruct(ctx, fctx, expr, typeName);
}

function registerClosedLiteralStruct(ctx: CodegenContext, expr: ts.ObjectLiteralExpression): string {
  const typeName = `__with_anon_${ctx.anonTypeCounter++}`;
  const fields: FieldDef[] = [];
  for (const prop of expr.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      fields.push({
        name: prop.name.text,
        type: resolveWasmType(ctx, ctx.checker.getTypeAtLocation(prop.name)),
        mutable: true,
      });
    } else if (ts.isPropertyAssignment(prop)) {
      const name = staticPropertyName(prop.name);
      if (name === undefined) continue;
      fields.push({
        name,
        type: resolveWasmType(ctx, ctx.checker.getTypeAtLocation(prop.initializer)),
        mutable: true,
      });
    }
  }
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: typeName, fields });
  ctx.structMap.set(typeName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, typeName);
  ctx.structFields.set(typeName, fields);
  return typeName;
}

function reportWithStatementDiagnostic(ctx: CodegenContext, stmt: ts.WithStatement, reason: string): void {
  reportError(
    ctx,
    stmt,
    `#1387: with statement requires a proven closed object-literal shape before codegen; ${reason}. ECMA-262 14.11.2 creates an Object Environment Record, 9.1.1.2.1 checks HasProperty plus @@unscopables, and 7.3.11 includes inherited properties. Dynamic fallback is deferred to #1472.`,
  );
}

function proveObjectLiteralWithTarget(
  fctx: FunctionContext,
  expr: ts.Expression,
): WithTargetProof | { ok: false; reason: string } {
  if (!ts.isObjectLiteralExpression(expr)) {
    const builtinIntegrity = unwrapBuiltinObjectIntegrityCall(fctx, expr);
    if (builtinIntegrity) {
      const proof = proveObjectLiteralWithTarget(fctx, builtinIntegrity.expr);
      if (!proof.ok) return proof;
      return { ...proof, integrity: builtinIntegrity.integrity };
    }
    return { ok: false, reason: `target ${ts.SyntaxKind[expr.kind]} is not a closed object literal` };
  }

  const keys = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      return { ok: false, reason: "object literal contains a spread, so the complete key set is not local" };
    }
    if (ts.isGetAccessorDeclaration(prop) || ts.isSetAccessorDeclaration(prop)) {
      return { ok: false, reason: "object literal contains accessors, which require dynamic property semantics" };
    }
    if (ts.isMethodDeclaration(prop)) {
      return { ok: false, reason: "object literal contains a method; method-value routing is deferred" };
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) {
      return { ok: false, reason: "object literal property kind is not in the static slice" };
    }

    const name = ts.isShorthandPropertyAssignment(prop) ? prop.name.text : staticPropertyName(prop.name);
    if (name === undefined) {
      return { ok: false, reason: "object literal contains a dynamic computed property key" };
    }
    if (keys.has(name)) {
      return {
        ok: false,
        reason: `object literal contains duplicate key "${name}", which this static slice does not fold`,
      };
    }
    if (name === "@@unscopables") {
      return { ok: false, reason: "static @@unscopables filtering is deferred for this slice" };
    }
    if (name === "__proto__") {
      return { ok: false, reason: "object literal may alter the prototype through __proto__" };
    }
    keys.add(name);
  }
  return { ok: true, expr, keys, integrity: "plain" };
}

function unwrapBuiltinObjectIntegrityCall(
  fctx: FunctionContext,
  expr: ts.Expression,
): { expr: ts.Expression; integrity: Exclude<WithTargetIntegrity, "plain"> } | null {
  if (!ts.isCallExpression(expr) || expr.arguments.length !== 1) return null;
  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== "Object") return null;
  if (fctx.localMap.has("Object")) return null;
  if (callee.name.text === "freeze") return { expr: expr.arguments[0]!, integrity: "frozen" };
  if (callee.name.text === "seal") return { expr: expr.arguments[0]!, integrity: "sealed" };
  return null;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const expr = name.expression;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (ts.isNumericLiteral(expr)) return String(Number(expr.text));
    if (
      ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === "Symbol" &&
      expr.name.text === "unscopables"
    ) {
      return "@@unscopables";
    }
  }
  return undefined;
}

/**
 * (#3025 W1) True if the identifier `ident` is, anywhere in its enclosing
 * function/module scope, the object of an element-access WRITE with a
 * computed/non-literal key (`env[Symbol.unscopables] = …`, `o[k] = v`, `o[k]++`).
 * Such a write can add an own property the static closed-struct view does not
 * model (notably a runtime @@unscopables blocklist), so the `with` target must
 * stay on the Tier-2 dynamic path. Element-access READS and string/numeric
 * literal-keyed writes (which map to known fields) do not count.
 */
function targetReceivesDynamicElementWrite(ident: ts.Identifier): boolean {
  const name = ident.text;
  // Walk up to the nearest enclosing function-like body / source file.
  let scope: ts.Node = ident;
  while (scope.parent && !ts.isSourceFile(scope) && !isFunctionOrClassBoundary(scope)) {
    scope = scope.parent;
  }
  let found = false;
  const isDynamicKey = (arg: ts.Expression | undefined): boolean =>
    !!arg && !ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg);
  const isWritePosition = (ea: ts.ElementAccessExpression): boolean => {
    const p = ea.parent;
    if (!p) return false;
    if (ts.isBinaryExpression(p) && p.left === ea) {
      const op = p.operatorToken.kind;
      return (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.FirstCompoundAssignment && op <= ts.SyntaxKind.LastCompoundAssignment)
      );
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isDeleteExpression(p)) return true;
    return false;
  };
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (ts.isElementAccessExpression(node)) {
      let obj: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(obj)) obj = obj.expression;
      if (ts.isIdentifier(obj) && obj.text === name && isDynamicKey(node.argumentExpression) && isWritePosition(node)) {
        found = true;
        return;
      }
    }
    forEachChild(node, walk);
  };
  walk(scope);
  return found;
}

function collectBodyDeclaredNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
      return;
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

/** True if a VariableDeclaration is `let`/`const` (block-scoped), not `var`. */
function isLexicalVarDecl(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  if (list && ts.isVariableDeclarationList(list)) {
    // NodeFlags.Let (0x1) | NodeFlags.Const (0x2) — `var` has neither.
    return (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
  }
  return false;
}

/**
 * (#2663 Slice 2 var-precedence) Names that GENUINELY shadow a dynamic `with`
 * object binding: lexical declarations (`let`/`const`/class/catch) and
 * inner-function declarations. `var`-declared (function-scoped) names are
 * deliberately EXCLUDED — per §, a `var` inside `with` hoists to the function
 * environment but the object environment is consulted FIRST at runtime, so a
 * `var foo` name must still pass through the HasBinding gate (object wins if the
 * with-object owns `foo`; otherwise it resolves to the hoisted var). Used as the
 * dynamic scope's `blockedNames` so the gate is not bypassed for `var` names.
 */
function collectBodyLexicalNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isVariableDeclaration(node)) {
      if (isLexicalVarDecl(node)) collectBindingNames(node.name, names);
      return; // `var` declarations are NOT blocked (object env consulted first)
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (node.name) names.add(node.name.text);
      return;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      collectBindingNames(node.variableDeclaration.name, names);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

function collectBodyReferencedNames(stmt: ts.Statement): Set<string> {
  const names = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (node !== stmt && isFunctionOrClassBoundary(node)) return;
    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      names.add(node.text);
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return names;
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    collectBindingNames(element.name, out);
  }
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) return false;
  if (ts.isBindingElement(parent) && parent.name === node) return false;
  if (ts.isParameter(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;
  return true;
}

function isFunctionOrClassBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}
