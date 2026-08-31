// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Shared structural role ordinals for compiler-authored callable bindings.
 * This leaf intentionally has no codegen dependencies so provider planning can
 * consume the provider ordinal without re-entering the general planner.
 */
export const PROGRAM_ABI_CALLABLE_ROLE = Object.freeze({
  body: 0,
  functionValueTrampoline: 1,
  classMethodAdapter: 3,
  classHostConstructor: 4,
  moduleInit: 5,
  retainedModuleFunction: 6,
  typedThisTwin: 7,
  vecHostBridge: 8,
  closureHostBridge: 9,
  dateCivilSupport: 10,
  dataStructHostBridge: 11,
  callableProvider: 12,
  classConstructorNew: 13,
  structFieldAccessor: 14,
  closureArgcDispatcher: 15,
  asyncFrameMachinery: 16,
  vecFromExternMaterializer: 17,
  stdlibMathHelper: 18,
  fnctorConstructor: 19,
  moduleImportAlias: 20,
  moduleExportAlias: 21,
} as const);

/** True iff every callable role has a distinct structural ordinal. */
export function programAbiCallableRoleOrdinalsAreDistinct(): boolean {
  const ordinals = Object.values(PROGRAM_ABI_CALLABLE_ROLE);
  return new Set(ordinals).size === ordinals.length;
}
