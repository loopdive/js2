// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

it("forwards captured diagnostic rest arguments across modules", async () => {
  const result = await compileMulti(
    {
      "./debug.ts": `export function assertIsDefined<T>(value: T): asserts value is NonNullable<T> {
        if (value === undefined || value === null) throw new Error("missing");
      }
      export function checkDefined<T>(value: T | null | undefined): T { assertIsDefined(value); return value; }`,
      "./utilities.ts": `import * as Debug from "./debug.js";
      export type DiagnosticArguments = (string | number)[];
      export function formatStringFromArgs(text: string, args: DiagnosticArguments): string {
        return text.replace(/\\{(\\d+)\\}/g, (_match, index: string) => "" + Debug.checkDefined(args[+index]));
      }
      export function createDiagnosticForNode(node: number, message: string, ...args: DiagnosticArguments): string {
        return createDiagnosticInFile(0, node, message, ...args);
      }
      export function createDiagnosticInFile(file: number, node: number, message: string, ...args: DiagnosticArguments): string {
        if (file !== 7 || node !== 4) return "bad context";
        return formatStringFromArgs(message, args);
      }`,
      "./binder.ts": `import { createDiagnosticInFile, type DiagnosticArguments } from "./utilities.js";
      export function createBinder() {
        let file = 7;
        function createDiagnosticForNode(node: number, message: string, ...args: DiagnosticArguments): string {
          return createDiagnosticInFile(file, node, message, ...args);
        }
        return function run(): string { return createDiagnosticForNode(4, "Cannot redeclare '{0}'.", "x"); };
      }`,
      "./main.ts": `import { createBinder } from "./binder.js";
      import { createDiagnosticForNode } from "./utilities.js";
      export function unused(): string { return createDiagnosticForNode(4, "{0}", "control"); }
      export function run(): number { return createBinder()() === "Cannot redeclare 'x'." ? 1 : -1; }`,
    },
    "./main.ts",
    { target: "standalone", resolve: { consumerDrivenBarrels: true } },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  expect((instance.exports.run as () => number)()).toBe(1);
});
