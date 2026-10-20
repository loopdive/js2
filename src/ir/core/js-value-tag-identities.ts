// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Opaque ECMAScript partition identities for the JS dialect and pure analyses. */
import { JsTag } from "../../shared/contracts/js-value-tags.js";
import { asTagId, type TagId } from "./tag-domain.js";

type JsTagName = "Null" | "Undefined" | "NumberI32" | "NumberF64" | "Boolean" | "String" | "Object" | "Function";

export const JS_TAG_IDS: Readonly<Record<JsTagName, TagId>> = {
  Null: asTagId(JsTag.Null),
  Undefined: asTagId(JsTag.Undefined),
  NumberI32: asTagId(JsTag.NumberI32),
  NumberF64: asTagId(JsTag.NumberF64),
  Boolean: asTagId(JsTag.Boolean),
  String: asTagId(JsTag.String),
  Object: asTagId(JsTag.Object),
  Function: asTagId(JsTag.Function),
};
