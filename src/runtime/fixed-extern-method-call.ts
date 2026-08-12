// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export function fixedExternMethodCallArity(name: string): 0 | 1 | 2 | 3 | 4 | undefined {
  const match = /^__extern_method_call_([0-4])$/.exec(name);
  return match ? (Number(match[1]) as 0 | 1 | 2 | 3 | 4) : undefined;
}

/**
 * Pack fixed import arguments in JS and delegate to the canonical dispatcher.
 *
 * The reusable pack removes a per-call allocation. A synchronous callback can
 * re-enter the same import, so nested calls use a fresh pack until the outer
 * dispatch completes. Clearing retained values keeps object lifetimes equal to
 * the allocating path.
 */
export function makeFixedExternMethodCall(arity: 0 | 1 | 2 | 3 | 4, call: Function): Function {
  if (arity === 0) {
    const args: unknown[] = [];
    return (obj: unknown, method: string): unknown => call(obj, method, args);
  }

  const reusableArgs = new Array<unknown>(arity);
  let active = false;
  const invokeReusable = (obj: unknown, method: string): unknown => {
    active = true;
    try {
      return call(obj, method, reusableArgs);
    } finally {
      for (let index = 0; index < arity; index++) reusableArgs[index] = undefined;
      active = false;
    }
  };
  if (arity === 1)
    return (obj: unknown, method: string, a: unknown): unknown => {
      if (active) return call(obj, method, [a]);
      reusableArgs[0] = a;
      return invokeReusable(obj, method);
    };
  if (arity === 2)
    return (obj: unknown, method: string, a: unknown, b: unknown): unknown => {
      if (active) return call(obj, method, [a, b]);
      reusableArgs[0] = a;
      reusableArgs[1] = b;
      return invokeReusable(obj, method);
    };
  if (arity === 3)
    return (obj: unknown, method: string, a: unknown, b: unknown, c: unknown): unknown => {
      if (active) return call(obj, method, [a, b, c]);
      reusableArgs[0] = a;
      reusableArgs[1] = b;
      reusableArgs[2] = c;
      return invokeReusable(obj, method);
    };
  return (obj: unknown, method: string, a: unknown, b: unknown, c: unknown, d: unknown): unknown => {
    if (active) return call(obj, method, [a, b, c, d]);
    reusableArgs[0] = a;
    reusableArgs[1] = b;
    reusableArgs[2] = c;
    reusableArgs[3] = d;
    return invokeReusable(obj, method);
  };
}
