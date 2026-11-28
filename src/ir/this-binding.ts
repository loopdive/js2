// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 S3c, #7354 C2, #7609) The `this` from-ast lowers (ResolveThisBinding, §9.4.4). A function that reads its own
 * `this` binds the receiver its caller installed, once at entry (OrdinaryCallBindThis, `bindEntryThis`); a class
 * method's is its `__self` parameter, which the integration loop binds. (#7609) At script level, in strict and sloppy
 * code alike, it is the global Environment Record's [[GlobalThisValue]], the realm's global object, where the resolver
 * provides it (`globalObjectThis`): each read is its own `dyn.global_object`, as a chunked module-init lowers later
 * statements in another function. Any other `this` refuses.
 */
import { ts } from "../ts-api.js";
import type { IrFunctionBuilder } from "./builder.js";
import type { IrFromAstResolver } from "./from-ast.js";
import { irDynamic, type IrType, type IrValueId } from "./nodes.js";
import { demoteToLegacy } from "./outcomes.js";

interface LocalThis {
  readonly kind: "local";
  readonly value: IrValueId;
  readonly type: IrType;
}

/** OrdinaryCallBindThis: `this` bound once at entry through `dyn.current_this`, read with `strict`'s rule. */
export function bindEntryThis(
  scope: { set(name: "this", binding: LocalThis): unknown },
  builder: IrFunctionBuilder,
  strict: boolean,
): void {
  scope.set("this", { kind: "local", value: builder.emitDynCurrentThis(strict), type: irDynamic() });
}

/** Whether `node` is a `this` of script code: outside every function and class. */
export function isScriptThis(node: ts.Node): boolean {
  if (node.kind !== ts.SyntaxKind.ThisKeyword) return false;
  for (let parent = node.parent; !ts.isSourceFile(parent); parent = parent.parent)
    if (ts.isFunctionLike(parent) || ts.isClassLike(parent)) return false;
  return true;
}

/** The value of the `this` expression `expr`, from the binding `scope` holds or the script's global object. */
export function lowerThis(
  expr: ts.Expression,
  cx: {
    readonly scope: ReadonlyMap<string, { readonly kind: string }>;
    readonly builder: IrFunctionBuilder;
    readonly resolver?: Pick<IrFromAstResolver, "globalObjectThis">;
    readonly funcName: string;
  },
): IrValueId {
  const bound = cx.scope.get("this");
  if (bound === undefined) {
    if (cx.resolver?.globalObjectThis?.(expr) === true) return cx.builder.emitDynGlobalObject();
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: 'this' reference outside an instance method body (${cx.funcName})`,
    );
  }
  if (bound.kind !== "local")
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: unexpected 'this' binding kind ${bound.kind} in ${cx.funcName}`,
    );
  return (bound as LocalThis).value;
}
