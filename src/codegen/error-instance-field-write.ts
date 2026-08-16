// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4485, family A) The WRITE mirror of the standalone `$Error_struct`
 * `.message` / `.name` / `.stack` read arm.
 *
 * ## The defect
 *
 * In `--target standalone` a `.name` / `.message` / `.stack` READ on a
 * statically-Error receiver is a hard `struct.get` of `$Error_struct` field
 * 2 / 1 / 3 (property-access-dispatch.ts, #1536/#2077) — it never consults an
 * own-property store. The matching WRITE had no arm at all, so `err.name = "X"`
 * fell through to the generic member-set, which put the value somewhere the
 * read does not look. Measured on this branch's base with the real
 * `runTest262File` (`--target standalone`):
 *
 * | probe                                        | base      | spec   |
 * | -------------------------------------------- | --------- | ------ |
 * | `e = new Error("m"); e.name = "N"; e.name`    | `"Error"` | `"N"`  |
 * | `… e.toString()`                              | `"Error: m"` | `"N: m"` |
 *
 * The write was not dropped in a way anything could observe as an error: it
 * "succeeded", and the next read silently answered the constructor's value.
 * Four test262 rows depend on it
 * (`built-ins/Error/prototype/toString/15.11.4.4-{8-1,8-2,9-1,10-1}.js`), all of
 * which set an own `name` and then assert on `toString()`.
 *
 * ## The arm
 *
 * Fires on exactly the receivers the READ arm claims, so the two can never
 * disagree about where the value lives:
 *
 *   - a receiver whose declared type is one of the eight builtin Error names
 *     (`isWasiErrorName` + `isBuiltinSubtype(_, "Error")`), or
 *   - a user class whose transitive builtin parent is an Error
 *     (`ctx.classBuiltinParentMap`) — its instance IS the parent's
 *     `$Error_struct`.
 *
 * and only under `semanticProviders === "native-first"` (standalone/WASI), the
 * same gate the read arm carries. In JS-host mode the errors are real host
 * objects, never `$Error_struct`s, so this declines and host codegen is
 * byte-identical.
 *
 * **Absent-not-wrong**: a `catch (e)` binding is typed `any`, so this arm
 * DECLINES on it and the write keeps its existing generic lowering. The read
 * arm serves such a binding with a runtime `ref.test`-guarded read; writing
 * would need the mirrored guard plus a fall-through store, which is a bigger
 * slice than the own-`name` composition rows need. Declining leaves that case
 * exactly as it is today rather than casting a possibly-non-Error receiver.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isBuiltinSubtype, isBuiltinTypeName } from "./builtin-tags.js";
import { getOrRegisterErrorStructType, isWasiErrorName } from "./registry/error-types.js";
import { coerceType } from "./type-coercion.js";
import { compileExpression } from "./shared.js";

/**
 * `$Error_struct` field index for the three spec-visible Error properties.
 *
 * A `Map`, NOT an object literal — deliberately. As a plain object,
 * `TABLE[propName]` inherits from `Object.prototype`, so a write to
 * `.toString` / `.valueOf` / `.constructor` looks up a FUNCTION instead of
 * `undefined`, the `=== undefined` decline never fires, and the arm emits
 * `struct.set` with a function where the field index belongs. Measured, not
 * hypothesised: with the object-literal form,
 * `Error.prototype.toString = Object.prototype.toString`
 * (test262 `built-ins/Error/prototype/S15.11.4_A2.js`, `.../Error/tostring-{1,2}.js`)
 * turned into `Codegen error: struct field index out of range — function
 * toString() { [native code] } (valid: [0, 6))`, taking a passing row with it.
 * Same class of bug as the `hasOwnProperty`-not-`in` note on `CALENDAR_SETTERS`
 * (#1638).
 */
const ERROR_STRUCT_FIELD_IDX: ReadonlyMap<string, number> = new Map([
  ["message", 1],
  ["name", 2],
]);
// `stack` (field 3) is deliberately NOT here even though the READ arm serves
// it. It is non-standard, and the error-stack proposal makes it an ACCESSOR on
// `Error.prototype` whose setter throws a TypeError on a non-string — so a
// silent data write is the wrong answer, not merely an incomplete one.
// Measured: including it turned `err.stack = null`
// (test262 `.../Error/prototype/stack/setter-via-assignment.js`, failing either
// way) from a missing-TypeError into a runtime `illegal cast` trap, because the
// receiver there is `new Ctor('msg')` off a dynamic constructor and is not a
// `$Error_struct` at runtime. A trap is strictly worse than a wrong value.

/**
 * Does `receiver` statically denote a value backed by an `$Error_struct`?
 *
 * Deliberately the STATIC question only — see the module note on why the
 * `any`-typed `catch` binding is not claimed here.
 */
function receiverIsErrorStruct(ctx: CodegenContext, receiver: ts.Expression): boolean {
  // `<Ctor>.prototype` is typed as the INSTANCE type (`Error`) by the checker,
  // but at runtime it is the prototype OBJECT, never an `$Error_struct` — so a
  // `struct.set` there is an illegal cast, not a write. Measured: without this
  // guard `Error.prototype.stack = …`
  // (test262 `.../Error/prototype/stack/setter-{receiver-is-prototype,via-assignment}.js`)
  // turned a wrong-but-quiet answer into a runtime trap. Decline and let the
  // existing lowering keep its behaviour (absent-not-wrong).
  if (ts.isPropertyAccessExpression(receiver) && !ts.isPrivateIdentifier(receiver.name)) {
    if (receiver.name.text === "prototype") return false;
  }
  const declaredName = ctx.oracle.declaredNameOf(receiver);
  if (declaredName === undefined) return false;
  if (isBuiltinTypeName(declaredName)) {
    return isWasiErrorName(declaredName) && isBuiltinSubtype(declaredName, "Error");
  }
  const builtinParent = ctx.classBuiltinParentMap.get(declaredName);
  return builtinParent !== undefined && (builtinParent === "Error" || isWasiErrorName(builtinParent));
}

/**
 * Try to lower `<errorInstance>.{message,name,stack} = value` as a direct
 * `struct.set` on the backing `$Error_struct`.
 *
 * Returns the assignment expression's ValType (the RHS, per §13.15.2) when the
 * arm fires, or `undefined` to decline — callers must fall through unchanged.
 */
export function tryEmitErrorInstanceFieldWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): ValType | undefined {
  if (ctx.targetProfile.semanticProviders !== "native-first") return undefined;
  if (ts.isPrivateIdentifier(target.name)) return undefined;
  const fieldIdx = ERROR_STRUCT_FIELD_IDX.get(target.name.text);
  if (fieldIdx === undefined) return undefined;
  if (!receiverIsErrorStruct(ctx, target.expression)) return undefined;

  const errStructIdx = getOrRegisterErrorStructType(ctx);
  const externRef: ValType = { kind: "externref" };

  // Receiver first (evaluation order: reference before value, §13.15.2).
  const recvResult = compileExpression(ctx, fctx, target.expression, externRef);
  if (!recvResult) return undefined;
  if (recvResult.kind !== "externref") coerceType(ctx, fctx, recvResult, externRef);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: errStructIdx });

  // Value, boxed to the field's externref representation (the same one the
  // constructor stores, so the READ arm's `ref.test $AnyString` still holds).
  const valueResult = compileExpression(ctx, fctx, value, externRef);
  if (!valueResult) return undefined;
  if (valueResult.kind !== "externref") coerceType(ctx, fctx, valueResult, externRef);

  // Stash the boxed RHS: `struct.set` consumes it, but the assignment
  // EXPRESSION evaluates to it (`x = (e.name = "N")`).
  const boxed = allocLocal(fctx, `__errfield_${fctx.locals.length}`, externRef);
  fctx.body.push({ op: "local.tee", index: boxed });
  fctx.body.push({ op: "struct.set", typeIdx: errStructIdx, fieldIdx });
  fctx.body.push({ op: "local.get", index: boxed });
  return externRef;
}
