// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Host-free IsConstructor classifier used by standalone Reflect.construct (#3371). */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { buildBuiltinConstructorTestArm } from "./builtin-callable-brand.js";

const HELPER = "__reflect_is_constructor";

export function ensureReflectIsConstructor(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(HELPER);
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], HELPER);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(HELPER, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HELPER,
    typeIdx,
    locals: [{ name: "value", type: { kind: "anyref" } }],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  return funcIdx;
}

/** Fill after all function values have registered their nominal constructor wrappers. */
export function fillReflectIsConstructor(ctx: CodegenContext): void {
  const funcIdx = ctx.funcMap.get(HELPER);
  const fn = funcIdx === undefined ? undefined : definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  const candidates = [...ctx.constructibleClosureTypeIdxs].sort((a, b) => a - b);
  if (ctx.taCtorTypeIdx >= 0) candidates.push(ctx.taCtorTypeIdx);
  for (const typeIdx of candidates) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
    );
  }
  // (#4397) A Proxy's [[Construct]] presence is fixed by its target at
  // ProxyCreate time. Read the stored bit instead of accepting every $Proxy;
  // it remains meaningful after revocation (the later operation throws).
  const proxyTypeIdx = ctx.objectRuntimeTypes?.proxyTypeIdx;
  if (proxyTypeIdx !== undefined) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: proxyTypeIdx },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: 6 },
          { op: "return" },
        ],
      },
    );
  }
  // (#4120) A reified builtin CONSTRUCTOR (`Set`, `Array`, `TypeError`, …) is a
  // brand-marked `$Object` carrier, not a nominal closure wrapper, so no
  // `ref.test` above can see it. Without this arm `Reflect.construct(fn, [], Set)`
  // threw "newTarget is not a constructor" — test262's `isConstructor(Set)`
  // returned false where the spec says true.
  body.push(...buildBuiltinConstructorTestArm(ctx, 1, [{ op: "i32.const", value: 1 }, { op: "return" }]));
  // An actual caller-owned JS constructor remains the same admitted object;
  // the narrow adapter reports only its callable/constructible bits.
  const boundaryKindIdx = ctx.funcMap.get("__boundary_object_callable_kind");
  if (boundaryKindIdx !== undefined) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: boundaryKindIdx },
      { op: "i32.const", value: 2 },
      { op: "i32.and" },
      { op: "i32.eqz" },
      { op: "i32.eqz" },
      { op: "return" },
    );
  }
  body.push({ op: "i32.const", value: 0 });
  fn.body = body;
}
