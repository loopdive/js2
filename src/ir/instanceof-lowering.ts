// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrFunctionBuilder } from "./builder.js";
import { asVal, irVal, type IrType, type IrValueId } from "./nodes.js";
import { irRuntimeFuncRef } from "./callable-bindings.js";
import { JS_TAG_IDS } from "./js-tag-domain.js";
import { IrUnsupportedError } from "./outcomes.js";

/** Native wrapper-brand membership, separate from the dynamic operator. */
export function lowerWrapperInstanceOf(
  lhs: IrValueId,
  funcName: string,
  builder: IrFunctionBuilder,
  owner: string,
  describeType: (type: IrType) => string,
): IrValueId {
  const lt = builder.typeOf(lhs);
  const resultType = irVal({ kind: "i32" });
  if (lt.kind === "dynamic") {
    const isObject = builder.emitTagTest(lhs, JS_TAG_IDS.Object);
    let whenObject!: IrValueId;
    const thenBody = builder.collectBodyInstrs(() => {
      const payload = builder.emitUnbox(lhs, JS_TAG_IDS.Object);
      const result = builder.emitCall(irRuntimeFuncRef(funcName), [payload], resultType);
      if (result === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: ${funcName} produced no result in ${owner}`);
      }
      whenObject = result;
    });
    let whenNotObject!: IrValueId;
    const elseBody = builder.collectBodyInstrs(() => {
      whenNotObject = builder.emitConst({ kind: "i32", value: 0 }, resultType);
    });
    return builder.emitIfElse({
      cond: isObject,
      then: thenBody,
      thenValue: whenObject,
      else: elseBody,
      elseValue: whenNotObject,
      resultType,
    });
  }
  const lv = asVal(lt);
  if (lt.kind === "string" || lt.kind === "object" || lt.kind === "closure" || lt.kind === "class") {
    const result = builder.emitCall(irRuntimeFuncRef(funcName), [lhs], resultType);
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (result === null) throw new Error(`ir/from-ast: ${funcName} produced no result in ${owner}`);
    return result;
  }
  if (lv?.kind === "anyref" || lv?.kind === "eqref" || lv?.kind === "ref" || lv?.kind === "ref_null") {
    const result = builder.emitCall(irRuntimeFuncRef(funcName), [lhs], resultType);
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (result === null) throw new Error(`ir/from-ast: ${funcName} produced no result in ${owner}`);
    return result;
  }
  if (lv?.kind === "f64" || lv?.kind === "i32" || lv?.kind === "i64") {
    return builder.emitConst({ kind: "i32", value: 0 }, resultType);
  }
  throw new IrUnsupportedError(
    "operand-coercion-unsupported",
    "build",
    `ir/from-ast: wrapper instanceof cannot normalize ${describeType(lt)} to anyref (${owner})`,
  );
}
