// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export interface BoundaryCallbackAdapterContext {
  readonly getExports: () => Record<string, Function> | undefined;
  readonly isAdmitted: (value: unknown, exports: Record<string, Function>) => boolean;
  readonly toHostValue: (value: unknown, exports: Record<string, Function>) => any;
  readonly fromHostValue: (value: unknown, exports: Record<string, Function>) => any;
}

/** Bind invocation of one caller-owned JS callback admitted by this instance. */
export function createBoundaryCallbackAdapter(arity: number, context: BoundaryCallbackAdapterContext): Function {
  return (callable: any, thisArg: any, ...args: any[]): any => {
    const exports = context.getExports();
    if (!exports || !context.isAdmitted(callable, exports) || typeof callable !== "function") {
      throw new TypeError("value is not an admitted JavaScript boundary callback");
    }
    const hostArgs = args.slice(0, arity).map((value) => context.toHostValue(value, exports));
    const result = Reflect.apply(callable, context.toHostValue(thisArg, exports), hostArgs);
    return context.fromHostValue(result, exports);
  };
}
