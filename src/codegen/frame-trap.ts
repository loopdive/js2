/**
 * Env-gated body-write trap (#4134).
 *
 * `JS2WASM_FRAME_TRAP=<name>` makes the named function's `FunctionContext`
 * report — with a stack — the moment an instruction referencing a local
 * outside the context's own frame is appended to its body.
 *
 * Why this exists rather than a plain `Proxy` on `fctx.body`: `fctx.body` is
 * REASSIGNED many times during compilation (the `savedBodies` swap, arm
 * building, generator body splicing). A proxy installed on the array stops
 * observing writes after the first swap. This installs an accessor on the
 * CONTEXT instead, so every array ever assigned to `body` is wrapped.
 *
 * Inert unless the env var is set.
 */

import type { FunctionContext } from "./context/types.js";
import type { Instr } from "../ir/types.js";

const WRAPPED = Symbol("js2.frameTrapWrapped");

function localIndexOf(instr: Instr): number | undefined {
  const op = (instr as { op?: string }).op;
  if (op !== "local.get" && op !== "local.set" && op !== "local.tee") return undefined;
  return (instr as unknown as { index?: number }).index;
}

/**
 * Install the trap on `fctx` when `JS2WASM_FRAME_TRAP` names `label`.
 * Returns immediately (and leaves `fctx` untouched) otherwise.
 */
export function installFrameTrap(fctx: FunctionContext, label: string): void {
  const want = process.env.JS2WASM_FRAME_TRAP;
  if (!want || want !== label) return;

  const wrap = (arr: Instr[]): Instr[] => {
    if (!Array.isArray(arr)) return arr;
    if ((arr as unknown as Record<symbol, boolean>)[WRAPPED]) return arr;
    const proxy = new Proxy(arr, {
      set(target, prop, value, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          const idx = localIndexOf(value as Instr);
          const frame = fctx.params.length + fctx.locals.length;
          if (idx !== undefined && idx >= frame) {
            const stack = new Error("frame-trap").stack ?? "";
            process.stderr.write(
              `[js2:frame-trap] ${label}: ${(value as { op: string }).op} ${idx} ` +
                `>= frame ${frame} (${fctx.params.length} params + ${fctx.locals.length} locals)\n` +
                stack
                  .split("\n")
                  .slice(1, 12)
                  .map((l) => `    ${l.trim()}\n`)
                  .join(""),
            );
          }
        }
        return Reflect.set(target, prop, value, receiver);
      },
    });
    Object.defineProperty(arr, WRAPPED, { value: true, enumerable: false });
    return proxy as Instr[];
  };

  let current = wrap(fctx.body);
  Object.defineProperty(fctx, "body", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (v: Instr[]) => {
      current = wrap(v);
    },
  });
}
