// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface FnctorIoHooks {
  rawInstance(value: object): object;
  rawClosureTarget(target: Function): object | undefined;
  canBeWeakKey(value: unknown): boolean;
  instanceConstructor(instance: object): object | undefined;
  expectedPrototype(target: object, exports: Record<string, Function> | undefined): unknown;
  instancePrototype(instance: object, exports: Record<string, Function> | undefined): unknown;
  parentPrototype(value: unknown, exports: Record<string, Function> | undefined): unknown;
  /**
   * (#4771) [[Prototype]] of an instance the runtime tracks but that carries no
   * recorded fnctor constructor — `Object.create(o)`, or any struct whose proto
   * was installed after the fact. Answers `undefined` for anything host-owned,
   * so the chain walk below never reaches for a host `getPrototypeOf` (which a
   * Proxy trap could observe, or throw from) on a shape it cannot decide.
   */
  recordedPrototype(instance: object, exports: Record<string, Function> | undefined): unknown;
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
  if (instanceCtor === closureTarget) return 1;

  // (#4771) OrdinaryHasInstance §7.3.20 step 7 is a PROTOTYPE-CHAIN walk, not a
  // constructor-identity test, so an instance with no recorded fnctor ctor is
  // still decidable whenever the runtime knows its [[Prototype]]:
  // `Object.create(new f())` reaches `f.prototype` one link further up. The
  // previous early return declined those outright, which sent `o2 instanceof f`
  // to the native fallback — where a WasmGC closure is opaque and the answer is
  // always `false`. A MISS still declines (`undefined`), so every shape the walk
  // cannot decide keeps its former answer.
  let current: unknown;
  if (instanceCtor) {
    current = hooks.instancePrototype(instance, exports);
  } else {
    current = hooks.recordedPrototype(instance, exports);
    if (current == null) return undefined;
  }

  const expected = hooks.expectedPrototype(closureTarget, exports);
  let guard = 0;
  while (current != null && guard++ < 32) {
    if (current === expected) return 1;
    current = hooks.parentPrototype(current, exports);
  }
  return instanceCtor ? 0 : undefined;
}

export function fnctorOrNative(value: unknown, target: Function, logical: number | undefined): number {
  return logical ?? (value instanceof target ? 1 : 0);
}
