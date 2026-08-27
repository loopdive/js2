import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    fileName: "issue-4761-control.ts",
  });
  expect(result.success, result.success ? undefined : JSON.stringify(result.errors)).toBe(true);
  if (!result.success) throw new Error("standalone control did not compile");
  const module = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(module);
  expect(imports).toHaveLength(0);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports.test as () => unknown)();
}

describe("issue #4761 standalone controls", () => {
  it("copies the dynamic Array.from carrier in a TypedArray constructor", async () => {
    await expect(
      runStandalone(`
        export function test(): number {
          const TA: any = Uint8Array;
          const arr: any = Array.from({ length: 4 }, function() { return "7"; });
          const view: any = new TA(arr);
          return view.length * 100 + view[0];
        }
      `),
    ).resolves.toBe(407);
  });

  it("keeps an ordinary dynamic object's own byteOffset in the view dispatch arm", async () => {
    await expect(
      runStandalone(`
        export function test(): number {
          const TA: any = Uint8Array;
          const buffer: any = new ArrayBuffer(16);
          const view: any = new TA(buffer, 8, 1);
          const object: any = { byteOffset: 7 };
          return object.byteOffset + view.byteOffset;
        }
      `),
    ).resolves.toBe(15);
  });

  it("reports zero byteOffset for detached dynamic views, including empty views", async () => {
    await expect(
      runStandalone(`
        export function test(): number {
          const TA: any = Uint8Array;
          const buffer: any = new ArrayBuffer(16);
          const view: any = new TA(buffer, 8, 1);
          const empty: any = new TA(buffer, 8, 0);
          const before = view.byteOffset;
          const emptyBefore = empty.byteOffset;
          buffer.__detached__ = true;
          return before * 1000 + emptyBefore * 100 + view.byteOffset * 10 + empty.byteOffset;
        }
      `),
    ).resolves.toBe(8800);
  });

  it("reports zero byteOffset for a detached statically typed view", async () => {
    await expect(
      runStandalone(`
        export function test(): number {
          const buffer: ArrayBuffer = new ArrayBuffer(16);
          const view: Uint8Array = new Uint8Array(buffer, 8, 1);
          const before = view.byteOffset;
          (buffer as any).__detached__ = true;
          return before * 10 + view.byteOffset;
        }
      `),
    ).resolves.toBe(80);
  });

  it("closes an iterator when a for-of assignment setter throws", async () => {
    await expect(
      runStandalone(`
        class Test262Error {
          name: string = "Test262Error";
        }
        export function test(): number {
          let setterCalls = 0;
          let nextCalls = 0;
          let closeCalls = 0;
          const target = {
            set attr(_: any) {
              setterCalls++;
              throw new Test262Error();
            },
          };
          const iterable: any = {};
          iterable[Symbol.iterator] = function() {
            return {
              next: function() {
                nextCalls++;
                return { done: false, value: 0 };
              },
              return: function() {
                closeCalls++;
              },
            };
          };
          try {
            for (target.attr of iterable) {
              return -1;
            }
            return -2;
          } catch (error) {
            return (error.name === "Test262Error" ? 1000 : 0) +
              setterCalls * 100 + nextCalls * 10 + closeCalls;
          }
        }
      `),
    ).resolves.toBe(1111);
  });
});
