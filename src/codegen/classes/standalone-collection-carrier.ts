// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6754) Own-field storage for a standalone `class X extends
 * <Map|Set|WeakMap|WeakSet>`: the *collection carrier*.
 *
 * A standalone native-collection subclass is externref-backed (#3972): `super()`
 * returns the branded `$Map` that `__new_<Parent>@N` builds, and every
 * inherited-method/brand path reads that value through `ref.test $Map`. Until
 * this module an own field had nowhere to live — a declared field was refused
 * (#2620) and a constructor-only `this.n = 5` silently read back `NaN`.
 *
 * The carrier keeps that representation and gives it room: the class's
 * registered struct becomes `$Map`'s exact field prefix, then `__tag`, then the
 * own fields, declared as a WasmGC subtype of `$Map`. `super(...)` still runs
 * the parent constructor (iterable seeding unchanged) and the result is copied
 * into a fresh carrier by `__<X>_collection_carrier`, so the instance is BOTH a
 * `$Map` for every builtin path and a `$X` struct for the ordinary
 * struct-field read/write/call paths. The brand field is copied, not assumed,
 * so Set/WeakMap/WeakSet carriers keep their kind.
 *
 * Bounded scope, refused at compile time rather than mis-run:
 *   - a declared accessor (an externref-backed accessor install is a separate
 *     gap);
 *   - a subclass OF a carrier: the multi-level externref chain sends its
 *     `super()` straight to the builtin, which would skip the carrier
 *     constructor and the parent's own constructor body.
 *
 * Standalone/WASI only. The JS-host lane keeps the host `externClass` path.
 */
import { ts } from "../../ts-api.js";
import type { FieldDef, Instr, StructTypeDef, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { isNativeCollectionBuiltin } from "../builtin-tags.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { rollbackSpeculative, snapshotSpeculative } from "../context/speculative.js";
import type { InnerResult } from "../shared.js";
import { addFuncType } from "../registry/types.js";
import { sealNominalStructParent } from "../struct-hierarchy-layout.js";
import { UNDEF_F64_BITS } from "../value-tags.js";

const carrierClasses = new WeakMap<CodegenContext, Set<string>>();

// map-runtime.ts / set-runtime.ts sit in the codegen import SCC; this module
// stays outside it, so their entry points are passed in by the (SCC) callers.
/** `tryCompileNativeMapMethodCall` / `tryCompileNativeSetMethodCall`. */
export type NativeCollectionMethodCall = (
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
) => InnerResult | undefined;

/** Hidden slots a class struct carries that are not own fields. */
const NON_OWN_FIELD_NAMES: ReadonlySet<string> = new Set(["__tag", "__shape_brand", "__proto__"]);

/** True when `className` was laid out as a `$Map`-subtype collection carrier. */
export function isCollectionCarrierClass(ctx: CodegenContext, className: string): boolean {
  return carrierClasses.get(ctx)?.has(className) === true;
}

/**
 * The runtime `$Map` struct is published as `structMap.get("Map")` once any
 * declaration resolves a `Map`-typed value. A builtin heritage that resolved to
 * no compiled user class must not adopt it as a nominal parent: doing so registered the
 * subclass as a `$Map` subtype WITHOUT `$Map`'s fields (the tailwindcss
 * "no longer an exact mutable-field prefix" CE), and only when an earlier
 * declaration happened to touch `Map`.
 */
export function isRuntimeCollectionStructHeritage(
  ctx: CodegenContext,
  parentStructTypeIdx: number | undefined,
  parentClassName: string,
): boolean {
  return (
    parentStructTypeIdx !== undefined && parentStructTypeIdx === ctx.mapTypeIdx && !ctx.classSet.has(parentClassName)
  );
}

/** Whether the class body can give its instances own fields (declared or `this.x = …` in the constructor). */
function mayDeclareOwnFields(decl: ts.ClassDeclaration | ts.ClassExpression): boolean {
  return decl.members.some(
    (member) =>
      (ts.isPropertyDeclaration(member) &&
        !(ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)) ||
      (ts.isConstructorDeclaration(member) &&
        (member.body?.statements ?? []).some(
          (stmt) =>
            ts.isExpressionStatement(stmt) &&
            ts.isBinaryExpression(stmt.expression) &&
            stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(stmt.expression.left) &&
            stmt.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword,
        )),
  );
}

/**
 * Heritage-time step for a class whose `extends` names `parentClassName`:
 * returns the compile-time refusal for a native-collection subclass shape that
 * is not representable, or `undefined`. When the class may become a carrier it
 * also registers the `$Map` types now — a WasmGC supertype must precede its
 * subtype, and the class struct slot is reserved right after this step.
 */
export function prepareCollectionSubclassHeritage(
  ctx: CodegenContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  className: string,
  parentClassName: string,
  parentIsUserClass: boolean,
  ensureMapRuntimeTypes: (ctx: CodegenContext) => void,
): string | undefined {
  if (!ctx.nativeStrings) return undefined;
  const standalone = ctx.standalone || ctx.wasi;
  if (parentIsUserClass) {
    return standalone && isCollectionCarrierClass(ctx, parentClassName)
      ? `Codegen error: 'class ${className} extends ${parentClassName}' is not yet supported in --target standalone ` +
          `(#6754): '${parentClassName}' stores instance fields on its native collection, and a subclass's ` +
          `super() would bypass that storage. Extend the builtin directly or recompile without --target standalone.`
      : undefined;
  }
  if (!isNativeCollectionBuiltin(parentClassName)) return undefined;
  const declaresAccessor = decl.members.some((m) => ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m));
  const declaresField = decl.members.some((m) => ts.isPropertyDeclaration(m));
  if (!declaresAccessor && (standalone || !declaresField)) {
    if (standalone && mayDeclareOwnFields(decl)) ensureMapRuntimeTypes(ctx);
    return undefined;
  }
  return (
    `Codegen error: 'class ${className} extends ${parentClassName}' with a declared ` +
    `${standalone ? "accessor" : "property or accessor"} is not yet supported in --target standalone (#2620/#3972/#6754). ` +
    `Construction, inherited methods and instance fields are native — but an accessor on a ` +
    `native-collection subclass is not implemented, and would trap at runtime rather than fail here. ` +
    `Drop the accessor, use ${parentClassName} directly, or recompile without --target standalone.`
  );
}

/**
 * Lay out an externref-backed direct `<collection>` subclass that has own
 * fields as a carrier: `$Map` prefix, `__tag`, own fields, subtype of `$Map`.
 * Mutates `fields` in place (it is the array the struct registry shares) and
 * `structDef`. No-op for every other class.
 */
export function applyCollectionCarrierLayout(
  ctx: CodegenContext,
  className: string,
  structTypeIdx: number,
  structDef: StructTypeDef,
  fields: FieldDef[],
): void {
  if (!(ctx.standalone || ctx.wasi) || !ctx.nativeStrings) return;
  if (!ctx.classExternrefBackedSet.has(className)) return;
  const builtinParent = ctx.classBuiltinParentMap.get(className);
  if (builtinParent === undefined || !isNativeCollectionBuiltin(builtinParent)) return;
  // Direct heritage only — a multi-level chain already has a nominal parent.
  if (ctx.classParentMap.get(className) !== builtinParent || structDef.superTypeIdx !== undefined) return;
  if (!fields.some((field) => !NON_OWN_FIELD_NAMES.has(field.name))) return;
  // The heritage step registered `$Map` ahead of this struct; a supertype that
  // would FOLLOW its subtype in the type section is unrepresentable.
  if (ctx.mapTypeIdx < 0 || ctx.mapTypeIdx > structTypeIdx) return;
  const mapDef = ctx.mod.types[ctx.mapTypeIdx] as StructTypeDef;
  // Exact copies: the class layout's ref→ref_null widening already ran, and
  // a mutable supertype field must be repeated with the identical type.
  const prefix = mapDef.fields.map((field) => ({ ...field, type: { ...field.type } as ValType }));
  fields.unshift(...prefix);
  structDef.superTypeIdx = ctx.mapTypeIdx;
  mapDef.superTypeIdx ??= -1;
  // The carrier constructor bakes this field list into one `struct.new`.
  sealNominalStructParent(ctx, structTypeIdx);
  let set = carrierClasses.get(ctx);
  if (!set) carrierClasses.set(ctx, (set = new Set()));
  set.add(className);
}

function ownFieldDefault(ctx: CodegenContext, className: string, field: FieldDef): Instr[] {
  if (field.name === "__tag") return [{ op: "i32.const", value: ctx.classTagMap.get(className) ?? 0 }];
  switch (field.type.kind) {
    case "f64":
      return field.undefinedDefault
        ? [{ op: "i64.const", value: UNDEF_F64_BITS }, { op: "f64.reinterpret_i64" }]
        : [{ op: "f64.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "externref":
      return [{ op: "ref.null.extern" }];
    case "ref":
    case "ref_null":
      return [{ op: "ref.null", typeIdx: field.type.typeIdx }];
    case "eqref":
      return [{ op: "ref.null.eq" }];
    default:
      return [{ op: "i32.const", value: 0 }];
  }
}

/** `__<X>_collection_carrier(parent: externref) -> externref`, registered once. */
function ensureCarrierConstructor(ctx: CodegenContext, className: string): number | undefined {
  const key = `__${className}_collection_carrier`;
  const existing = ctx.funcMap.get(key);
  if (existing !== undefined) return existing;
  const structTypeIdx = ctx.structMap.get(className);
  const fields = ctx.structFields.get(className);
  const mapDef = ctx.mod.types[ctx.mapTypeIdx];
  if (structTypeIdx === undefined || !fields || mapDef?.kind !== "struct") return undefined;

  const prefixLength = mapDef.fields.length;
  const ownFields = fields.slice(prefixLength);
  // Each own-field default is staged in a local and pushed by `local.get`: the
  // constructor-default repair (`fixupStructNewArgCounts`) treats a trailing
  // run of constants before a class `struct.new` as an incomplete default list
  // and would pad it with a second copy of the fields.
  const locals: { name: string; type: ValType }[] = [
    { name: "parent", type: { kind: "ref", typeIdx: ctx.mapTypeIdx } },
    ...ownFields.map((field) => ({ name: `own_${field.name}`, type: field.type })),
  ];
  const body: Instr[] = [];
  ownFields.forEach((field, i) => {
    body.push(...ownFieldDefault(ctx, className, field), { op: "local.set", index: 2 + i });
  });
  body.push(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.mapTypeIdx },
    { op: "local.set", index: 1 },
  );
  for (let fieldIdx = 0; fieldIdx < prefixLength; fieldIdx++) {
    body.push({ op: "local.get", index: 1 }, { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx });
  }
  ownFields.forEach((_, i) => body.push({ op: "local.get", index: 2 + i }));
  body.push({ op: "struct.new", typeIdx: structTypeIdx }, { op: "extern.convert_any" });

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], `${key}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(key, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: key,
    typeIdx,
    locals,
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * After a `super(...)` pushed the parent's `$Map` (as externref), replace it
 * with the class's carrier. Emits nothing for a non-carrier class.
 */
export function emitCollectionCarrierWrap(ctx: CodegenContext, fctx: FunctionContext, className: string): void {
  if (!isCollectionCarrierClass(ctx, className)) return;
  const funcIdx = ensureCarrierConstructor(ctx, className);
  if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
}

/**
 * The receiver operand a field initializer stores through: the struct itself
 * for an ordinary class, the externref `this` cast to the carrier struct for a
 * carrier class.
 */
export function classFieldInitReceiver(
  ctx: CodegenContext,
  className: string,
  selfLocal: number,
  structTypeIdx: number,
): Instr[] {
  const self: Instr = { op: "local.get", index: selfLocal };
  if (!isCollectionCarrierClass(ctx, className)) return [self];
  return [self, { op: "any.convert_extern" }, { op: "ref.cast", typeIdx: structTypeIdx }];
}

/**
 * `super.<m>(…)` inside a standalone native-collection subclass (carrier or
 * not). The parent has no compiled `Map_<m>`, and the host bridge is refused
 * standalone, so this used to fall into the speculative default and silently
 * answer `undefined` — tailwindcss's `super.get(r)` cache lookup always missed.
 * Per spec the call is `%Map.prototype%.<m>` on `this`, bypassing any override:
 * exactly the native helper the builtin call site uses, given `this` as the
 * receiver. `undefined` (nothing emitted) when the method has no native arm.
 */
export function compileCollectionSuperMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  className: string,
  native: { readonly map: NativeCollectionMethodCall; readonly set: NativeCollectionMethodCall },
): InnerResult | undefined {
  if (!(ctx.standalone || ctx.wasi) || !ctx.classExternrefBackedSet.has(className)) return undefined;
  const parent = ctx.classBuiltinParentMap.get(className);
  const callee = expr.expression;
  if (parent === undefined || !isNativeCollectionBuiltin(parent) || !ts.isPropertyAccessExpression(callee)) {
    return undefined;
  }
  if (!ts.isIdentifier(callee.name) || fctx.localMap.get("this") === undefined) return undefined;
  // `this.<m>(…args)` spelled over the same nodes, so only the receiver differs.
  const receiver = ts.factory.createThis();
  const access = ts.factory.createPropertyAccessExpression(receiver, callee.name);
  const call = ts.factory.createCallExpression(access, expr.typeArguments, expr.arguments);
  ts.setTextRange(receiver, callee.expression);
  ts.setTextRange(access, callee);
  ts.setTextRange(call, expr);
  Object.assign(receiver, { parent: access });
  Object.assign(access, { parent: call });
  Object.assign(call, { parent: expr.parent });
  const snap = snapshotSpeculative(ctx, fctx);
  const isSet = parent === "Set" || parent === "WeakSet";
  const result = (isSet ? native.set : native.map)(ctx, fctx, access, call);
  if (result === undefined) rollbackSpeculative(ctx, fctx, snap);
  return result;
}
