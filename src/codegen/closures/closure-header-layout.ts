// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Compatibility facade; canonical layout, documentation and predicates live below.
export {
  CLOSURE_FUNC_FIELD_IDX,
  CLOSURE_ARITY_FIELD_IDX,
  CLOSURE_BAG_FIELD_IDX,
  CLOSURE_CAPTURE_FIELD_BASE,
  INSTANCE_BAG_FIELD,
  closureArityField,
  closureBagField,
  closureBagInitInstr,
  hasClosureHeaderPrefix,
  isCanonicalClosureHeader,
  closureSubtypeFieldCount,
} from "../../runtime/wasmgc/values/closure-layouts.js";
