// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Retain the public compiler path while the shared contract owns every declaration.
export {
  BUILTIN_TYPE_TAGS,
  BUILTIN_PARENTS_HOST_CONSTRUCTIBLE,
  NATIVE_COLLECTION_BUILTINS,
  isBuiltinTypeName,
  isBuiltinSubtype,
  getBuiltinParent,
  isHostConstructibleBuiltin,
  isNativeCollectionBuiltin,
} from "../shared/contracts/js-builtin-tags.js";
export type { BuiltinTypeName } from "../shared/contracts/js-builtin-tags.js";
