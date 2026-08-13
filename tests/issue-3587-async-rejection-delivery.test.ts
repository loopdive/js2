// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3587 — host-declined async shapes silently swallowed awaited rejections.
//
// Any async function whose shape the host-drive engine declined
// (`asyncFnNeedsHostDrive` → `planLinearAwaits`) fell back to the legacy
// synchronous pass-through, which CANNOT deliver rejections: execution
// continued straight past a rejected await, `catch` blocks never ran, `.catch`
// handlers never ran, and the rejection leaked as an unhandledRejection. The
// cruelest instance: wrapping an await in try/catch — the construct that
// signals "I care about this rejection" — was itself what declined the
// function onto the lane that could not deliver rejections.
//
// The fix (a) claims try/catch-across-await on the host settle backend via the
// #2906 3c CFG machine (catch regions as states + routed dispatcher — the
// machinery was already backend-agnostic, only gated off), with `catch_all`
// parity for synchronous host JS exceptions, and (b) makes the residual
// declined-but-rejection-observing population REFUSE LOUDLY (source-located
// compile error) instead of silently mis-executing.
//
// Every test here asserts the OBSERVABLE VALUE (a test asserting only
// "compiles" cannot catch a silent re-lane onto a wrong-semantics fallback).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = await compile(src);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  const exports = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if (imports.setExports) imports.setExports(exports as Record<string, Function>);
  return exports;
}

/** Run `test()` while trapping unhandledRejection leaks; returns [settled, leaks]. */
async function runTest(
  exports: Record<string, (...a: unknown[]) => unknown>,
): Promise<{ value: unknown; leaked: unknown[] }> {
  const leaked: unknown[] = [];
  const onUnhandled = (r: unknown) => leaked.push(r);
  process.on("unhandledRejection", onUnhandled);
  try {
    const value = await (exports.test as () => Promise<unknown>)();
    await new Promise((r) => setTimeout(r, 10)); // drain microtasks for leak detection
    return { value, leaked };
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("#3587 — awaited rejections must reach their handlers (host gc lane)", () => {
  it("probe a5b: try/catch across await delivers the rejection to catch", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          await Promise.reject(7);
          return -1; // must not reach
        } catch (e) {
          return e as number;
        }
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(7); // was -1 (silently continued past the rejected await)
    expect(leaked).toEqual([]);
  });

  it("probe a5c: all four rejection shapes observed in one body (node: 9531)", async () => {
    const exports = await instantiate(`
      async function rejector(): Promise<number> {
        await Promise.reject(3);
        return -1;
      }
      export async function test(): Promise<number> {
        let acc = 0;
        const p: Promise<number> = Promise.reject(1);
        try {
          await p;
          acc += 1000000;
        } catch (e) {
          acc += 9000;
        }
        try {
          await rejector();
          acc += 2000000;
        } catch (e) {
          acc += 500;
        }
        try {
          await Promise.reject(5).catch((e: number) => { acc += 30; return 0; });
          acc += 1;
        } catch (e) {
          acc += 4000000;
        }
        await new Promise<number>((_res, rej) => rej(9)).catch((e: number) => { acc += 0; });
        return acc;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(9531); // was 3000001 + a leaked unhandledRejection
    expect(leaked).toEqual([]);
  });

  it("control (engine-claimed shape): two-callback .then rejection path still correct", async () => {
    const exports = await instantiate(`
      async function f(): Promise<number> {
        await Promise.reject(7);
        return -1;
      }
      export async function test(): Promise<number> {
        let out = 0;
        await f().then(
          (_v: number) => { out = 100; },
          (e: number) => { out = e; },
        );
        return out;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(7);
    expect(leaked).toEqual([]);
  });

  it("await inside the catch block (catch chain suspends + resumes)", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          await Promise.reject(20);
          return -1;
        } catch (e) {
          const x = await Promise.resolve(5);
          return (e as number) + (x as number);
        }
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(25);
    expect(leaked).toEqual([]);
  });

  it("rethrow after a rejected await rejects the result promise with the reason", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          await Promise.reject(33);
          return -1;
        } catch (e) {
          throw e;
        }
      }
    `);
    await expect((exports.test as () => Promise<number>)()).rejects.toBe(33);
  });

  it("try/catch/finally: catch observes the rejection AND finally runs", async () => {
    const exports = await instantiate(`
      let fin = 0;
      export async function test(): Promise<number> {
        let out = 0;
        try {
          await Promise.reject(2);
          out = -1;
        } catch (e) {
          out = 100 + (e as number);
        } finally {
          fin = 40;
        }
        return out + fin;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(142);
    expect(leaked).toEqual([]);
  });

  it("nested try/catch: the inner catch handles, the outer stays untouched", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          try {
            await Promise.reject(7);
            return -1;
          } catch (e) {
            return e as number;
          }
        } catch (e2) {
          return -2;
        }
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(7);
    expect(leaked).toEqual([]);
  });

  it("catch_all parity: a synchronous HOST JS exception in the try region is caught", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          JSON.parse("{bad");
          await Promise.resolve(1);
          return -1;
        } catch (e) {
          return 91;
        }
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(91); // legacy caught this via catch_all; the machine must too
    expect(leaked).toEqual([]);
  });

  it(".catch() on the awaited operand inside try runs the handler", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        let acc = 0;
        try {
          const v = await Promise.reject(5).catch((e: number) => e + 200);
          acc = v as number;
        } catch (e) {
          acc = -1;
        }
        return acc;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(205);
    expect(leaked).toEqual([]);
  });

  it("sibling try/catch groups: first rejects into its catch, second fulfills", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        let acc = 0;
        try {
          await Promise.reject(5);
          acc += 1000;
        } catch (e) {
          acc += (e as number) + 1;
        }
        try {
          const v = await Promise.resolve(9);
          acc += v as number;
        } catch (e) {
          acc += 2000;
        }
        return acc;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(15);
    expect(leaked).toEqual([]);
  });

  it("an UNhandled awaited rejection surfaces loudly (result promise rejects)", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        const a = await Promise.resolve(1);
        await Promise.reject(3);
        return -1;
      }
    `);
    await expect((exports.test as () => Promise<number>)()).rejects.toBe(3);
  });

  it("async ARROW with try/catch-await is claimed too (closure activation path)", async () => {
    const exports = await instantiate(`
      const f = async (): Promise<number> => {
        try {
          await Promise.reject(11);
          return -1;
        } catch (e) {
          return e as number;
        }
      };
      export async function test(): Promise<number> {
        let out = 0;
        await f().then((v: number) => { out = v; }, (e: number) => { out = -2; });
        return out;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(11);
    expect(leaked).toEqual([]);
  });

  it("delivers an awaited value into an existing local assigned inside try", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        let value: number;
        const pending: Promise<number> = Promise.resolve(25);
        try {
          value = await pending;
        } catch (error) {
          return error as number;
        }
        return value;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(25);
    expect(leaked).toEqual([]);
  });

  it("keeps the declared type when await assigns an existing numeric parameter", async () => {
    const exports = await instantiate(`
      async function replace(value: number, pending: Promise<number>): Promise<number> {
        try {
          value = await pending;
        } catch (error) {
          return -1;
        }
        return value;
      }
      export async function test(): Promise<number> {
        return await replace(2, Promise.resolve(25));
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(25);
    expect(leaked).toEqual([]);
  });

  it("spills destructured body locals across a conditional await", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        const { value } = { value: 17 };
        try {
          if (value > 0) await Promise.resolve(1);
        } catch (error) {
          return -1;
        }
        return value;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(17);
    expect(leaked).toEqual([]);
  });

  it("keeps nested same-name catch bindings in their lexical scopes", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          try {
            await Promise.reject(-1);
          } catch (e) {
            throw e;
          }
        } catch (e) {
          return e as number;
        }
        return -2;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(-1);
    expect(leaked).toEqual([]);
  });

  it("drives sequential and conditional awaits in one declaration before try/catch", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        const firstPending: Promise<number> = Promise.resolve(7);
        const secondPending: Promise<number> = Promise.resolve(11);
        let first = await firstPending,
          second = first > 0 ? await secondPending : 13;
        let third: number;
        try {
          third = await Promise.resolve(17);
        } catch (error) {
          return -1;
        }
        return first * 100 + second * 10 + third;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(827);
    expect(leaked).toEqual([]);
  });

  it("keeps the non-await arm of a conditional initializer on a direct CFG branch", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        const firstPending: Promise<number> = Promise.resolve(7);
        const unusedPending: Promise<number> = Promise.resolve(99);
        let first = await firstPending,
          second = first < 0 ? await unusedPending : 13;
        try {
          await Promise.resolve(1);
        } catch (error) {
          return -1;
        }
        return first * 10 + second;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(83);
    expect(leaked).toEqual([]);
  });

  it("persists an ordinary for-of iterator across awaits in its try/catch body", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        const rows = [{ value: 2 }, { value: 3 }];
        let sum = 0;
        for (const { value } of rows) {
          const pending: Promise<number> = Promise.resolve(value);
          try {
            const settled = await pending;
            sum += settled;
          } catch (error) {
            sum = -100;
          }
        }
        return sum;
      }
    `);
    const { value, leaked } = await runTest(exports);
    expect(value).toBe(5);
    expect(leaked).toEqual([]);
  });

  it("LOUD REFUSAL: a still-declined rejection-observing shape is a compile error, not a silent miscompile", async () => {
    // while-with-await INSIDE try/catch: outside both the linear plan and the
    // bounded 3c shape → engine still declines. The sync fallback would run
    // the loop with garbage awaited values and skip the catch on rejection —
    // that path must be unreachable now.
    const result = await compile(`
      export async function test(): Promise<number> {
        let i = 0;
        try {
          while (i < 3) {
            await Promise.reject(1);
            i++;
          }
        } catch (e) {
          return e as number;
        }
        return i;
      }
    `);
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.message.includes("#3587"))).toBe(true);
  });

  it("no refusal for non-suspending awaits in try (statically-resolved cannot reject)", async () => {
    const exports = await instantiate(`
      export async function test(): Promise<number> {
        try {
          const v = await Promise.resolve(6);
          return v as number;
        } catch (e) {
          return -1;
        }
      }
    `);
    const { value } = await runTest(exports);
    expect(value).toBe(6);
  });
});
