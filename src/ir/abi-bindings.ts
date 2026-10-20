// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Compatibility path for the complete canonical portable binding-reference implementation. */
export {
  irModuleGlobalBindingId,
  irModuleTdzGlobalBindingId,
  parseIrModuleGlobalBindingId,
  arePairedIrModuleGlobalBindingIds,
  irModuleGlobalRef,
  irModuleTdzGlobalRef,
  irSourceGlobalRef,
  irImportGlobalRef,
  irPlannedImportGlobalRef,
  irRetainedImportGlobalRef,
  irRuntimeGlobalRef,
  irArgcGlobalRef,
  irSupportGlobalRef,
  irSourceTypeRef,
  irClassTypeRef,
  irRuntimeTypeRef,
  irFnctorLayoutTypeRef,
  sameIrTypeBinding,
  irGlobalBindingKey,
  sameIrGlobalBinding,
  irTypeBindingKey,
  irSupportTypeRef,
} from "./core/binding-references.js";
export type { IrModuleGlobalBindingIdentity } from "./core/binding-references.js";
