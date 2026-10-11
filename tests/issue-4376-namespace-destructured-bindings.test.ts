// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("Deno module namespace destructured exports", () => {
  for (const declaration of [
    "const { value: answer } = { value: 42 };",
    "const [answer] = [42];",
    "let { nested: { value: answer } } = { nested: { value: 41 } };",
  ]) {
    it(`materializes ${declaration}`, async () => {
      const mutable = declaration.startsWith("let");
      const result = await compileMulti(
        {
          "./values.ts": `${declaration}\nexport {answer};\nexport function update(){${mutable ? "answer = 42;" : ""}}`,
          "./entry.ts": `import * as ns from './values.ts';
          import {answer, update} from './values.ts';
          export function run():number {
            const captured:any = ns;
            update();
            return captured.answer === answer && captured.answer === 42 ? 42 : 0;
          }`,
        },
        "./entry.ts",
        { target: "standalone", skipSemanticDiagnostics: true, deferTopLevelInit: true },
      );
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const imports = result.importObject ?? {};
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), imports);
      (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
      (instance.exports.__module_init as () => void)();
      expect((instance.exports.run as () => number)()).toBe(42);
    });
  }
});
