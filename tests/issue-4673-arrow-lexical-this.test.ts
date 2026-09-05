// #4673 — standalone arrow closures must retain the receiver from their
// enclosing function.  `this` is not an identifier, so the ordinary free-name
// capture scan cannot discover this lexical dependency.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTIONS = {
  allowJs: true,
  deferTopLevelInit: true,
  fileName: "issue-4673.ts",
  hostBridge: "always",
  skipSemanticDiagnostics: true,
  target: "standalone",
} as const;

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, OPTIONS as never);
  expect(
    result.success,
    result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as { test(): number }).test();
}

describe("#4673 — standalone arrow lexical this capture", () => {
  it("captures the ambient receiver of an ordinary function", async () => {
    expect(
      await runStandalone(`
        function makeArrow() {
          return () => this;
        }
        export function test(): number {
          const receiver = {};
          const arrow = makeArrow.call(receiver);
          return arrow() === receiver ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("keeps a constructor receiver across direct, call, and apply invocation", async () => {
    expect(
      await runStandalone(`
        function F() {
          this.arrow = () => this;
        }
        export function test(): number {
          const f = new F();
          const other = {};
          return (f.arrow() === f ? 1 : 0) +
            (f.arrow.call(other) === f ? 2 : 0) +
            (f.arrow.apply(other) === f ? 4 : 0);
        }
      `),
    ).toBe(7);
  });

  it("keeps a class-method receiver after the arrow is returned", async () => {
    expect(
      await runStandalone(`
        class Box {
          value: number;
          constructor() { this.value = 23; }
          makeArrow() {
            const callback = () => this;
            return callback;
          }
        }
        export function test(): number {
          const box = new Box();
          const callback = box.makeArrow();
          const other = { value: 99 };
          return (callback() === box ? 1 : 0) +
            (callback.call(other) === box ? 2 : 0) +
            (callback().value === 23 ? 4 : 0);
        }
      `),
    ).toBe(7);
  });

  it("leaves ordinary function expressions with their own receiver", async () => {
    expect(
      await runStandalone(`
        function F() {
          this.method = function () { return this; };
        }
        export function test(): number {
          const f = new F();
          const other = {};
          return f.method.call(other) === other ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
