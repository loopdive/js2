// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Existing API retained; the canonical enum and carrier table have one runtime-contract owner. */
export { JsTag, jsTagUnboxKind } from "../runtime/contracts/js-value-tags.js";

import { JsTag } from "../runtime/contracts/js-value-tags.js";

export function jsTagToStaticType(
  hint: JsTag | undefined,
): "null" | "undefined" | "boolean" | "number" | "string" | "object" | "function" | "unknown" {
  switch (hint) {
    case JsTag.Null:
      return "null";
    case JsTag.Undefined:
      return "undefined";
    case JsTag.Boolean:
      return "boolean";
    case JsTag.NumberI32:
    case JsTag.NumberF64:
      return "number";
    case JsTag.String:
      return "string";
    case JsTag.Object:
      return "object";
    case JsTag.Function:
      return "function";
    default:
      return "unknown";
  }
}
