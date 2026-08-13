// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface FnctorIoHooks {
  rawInstance(value: object): object;
  rawClosureTarget(target: Function): object | undefined;
  canBeWeakKey(value: unknown): boolean;
  instanceConstructor(instance: object): object | undefined;
  expectedPrototype(target: object, exports: Record<string, Function> | undefined): unknown;
  instancePrototype(instance: object, exports: Record<string, Function> | undefined): unknown;
  parentPrototype(value: unknown, exports: Record<string, Function> | undefined): unknown;
}

/** Resolve logical instanceof for Wasm closure constructors and their opaque struct instances. */
export function fnctorInstanceofResult(
  value: unknown,
  target: Function,
  exports: Record<string, Function> | undefined,
  hooks: FnctorIoHooks,
): number | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const instance = hooks.rawInstance(value);
  const closureTarget = hooks.rawClosureTarget(target);
  if (!closureTarget || !hooks.canBeWeakKey(instance)) return undefined;
  const instanceCtor = hooks.instanceConstructor(instance);
  if (!instanceCtor) return undefined;
  if (instanceCtor === closureTarget) return 1;

  const expected = hooks.expectedPrototype(closureTarget, exports);
  let current = hooks.instancePrototype(instance, exports);
  let guard = 0;
  while (current != null && guard++ < 32) {
    if (current === expected) return 1;
    current = hooks.parentPrototype(current, exports);
  }
  return 0;
}

export function fnctorOrNative(value: unknown, target: Function, logical: number | undefined): number {
  return logical ?? (value instanceof target ? 1 : 0);
}
