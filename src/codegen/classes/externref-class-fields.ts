// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6844) Instance field initializers of an EXTERNREF-BACKED class — a user
 * subclass of a host builtin such as `class ConfigError extends Error`.
 *
 * Such an instance is the host object `__new_<Parent>` returned, not a WasmGC
 * struct, so the struct-field loop in the constructor has nowhere to store a
 * field and skipped every initializer (#1366a). The skip was silent and the
 * commonest shape it ate is the idiomatic error subclass:
 *
 * ```js
 * class ConfigError extends Error { name = "ConfigError"; }
 * new ConfigError("x").name   // "Error" — node: "ConfigError"
 * ```
 *
 * prettier's `InvalidDocError`, `ConfigError`, `UndefinedParserError` and
 * `ArgExpansionBailout` are all this shape. Its upstream suite identifies the
 * thrown error by `error instanceof C || error.name === C.name`; the second
 * test never matched, and #6798 (a class object's `typeof` became the correct
 * "function", so the matcher stopped falling through to its lenient default)
 * turned the silent mismatch into 32 failing doc-builders rows.
 *
 * §15.7.14 ClassDefinitionEvaluation / §7.3.33 DefineField: each field is
 * defined on the receiver with CreateDataPropertyOrThrow — a DEFINE, not a
 * `Set`, so an inherited setter or a non-writable inherited `name` is not
 * consulted. `__defineProperty_value` with all four attribute bits is exactly
 * that operation.
 *
 * Scope, deliberate:
 * - JS-host lane only. Standalone/WASI represent these instances as
 *   `$Error_struct`/native carriers whose own-field backing is a separate
 *   design (#2101a/#2101b); the standalone constructor stays byte-identical.
 * - Statically named fields only (identifier, string or numeric literal).
 *   Private (`#x`) and computed-key fields keep today's behaviour.
 * - A field WITHOUT an initializer is skipped: in a TypeScript source it is
 *   usually a type-only declaration, and defining `undefined` there would
 *   shadow the inherited `message`/`name`.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { hasStaticModifier } from "../ast-modifiers.js";
import type * as Shared from "../shared.js";

/**
 * The codegen entry points this leaf needs, INJECTED by the caller: a value
 * import of `shared.js` would pull this module into the codegen import SCC
 * (the import-cycles ratchet).
 */
export interface ExternrefFieldOps {
  readonly compileExpression: typeof Shared.compileExpression;
  readonly coerceType: typeof Shared.coerceType;
  readonly ensureLateImport: typeof Shared.ensureLateImport;
  readonly flushLateImportShifts: typeof Shared.flushLateImportShifts;
  /** Push the property key `key` as an externref string. */
  readonly pushStringKey: (key: string) => void;
}

/** Writable | enumerable | configurable, each with its "specified" bit, plus "has value" (bit 7). */
const DATA_FIELD_FLAGS = (1 << 7) | 1 | (1 << 3) | (1 << 1) | (1 << 4) | (1 << 2) | (1 << 5);

function staticFieldKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  return undefined;
}

function isDefinableField(member: ts.ClassElement): member is ts.PropertyDeclaration & { initializer: ts.Expression } {
  if (!ts.isPropertyDeclaration(member) || !member.initializer || hasStaticModifier(member)) return false;
  return !(ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Ambient | ts.ModifierFlags.Accessor));
}

/**
 * Emit `DefineField(self, key, initializer)` for every own instance field of
 * `decl`, in declaration order. `selfLocal` holds the host instance externref.
 */
export function emitExternrefBackedFieldInitializers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassLikeDeclaration,
  selfLocal: number,
  ops: ExternrefFieldOps,
): void {
  if (ctx.standalone || ctx.wasi) return;
  const { compileExpression, coerceType, ensureLateImport, flushLateImportShifts } = ops;
  for (const member of decl.members) {
    if (!isDefinableField(member)) continue;
    const key = staticFieldKey(member.name);
    if (key === undefined) continue;
    const signature = [{ kind: "externref" as const }, { kind: "externref" as const }, { kind: "externref" as const }];
    ensureLateImport(ctx, "__defineProperty_value", [...signature, { kind: "f64" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "local.get", index: selfLocal });
    ops.pushStringKey(key);
    const valueType = compileExpression(ctx, fctx, member.initializer, { kind: "externref" });
    if (valueType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });
    flushLateImportShifts(ctx, fctx);
    // Re-read after the value compiled: it may have added late imports.
    const defineIdx = ctx.funcMap.get("__defineProperty_value");
    if (defineIdx === undefined) {
      fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "drop" });
      continue;
    }
    fctx.body.push({ op: "f64.const", value: DATA_FIELD_FLAGS });
    fctx.body.push({ op: "call", funcIdx: defineIdx });
    fctx.body.push({ op: "drop" });
  }
}
