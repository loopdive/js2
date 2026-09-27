// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(["gc", "standalone"] as const)("preserves an unset captured binder worklist in %s", async (target) => {
  const result = await compile(
    `interface Tag { kind: number; }
    function createBinder() {
      var pending: Tag[];
      function flush(): number {
        if (pending === undefined) return 7;
        let count = 0;
        for (const tag of pending) count += tag.kind;
        return count;
      }
      return function bind(fill: boolean): number {
        if (fill) pending = [{ kind: 11 }];
        const count = flush();
        pending = undefined!;
        return count;
      };
    }
    export function runNullControl(): number {
      let value: Tag[] | null;
      value = null;
      if (value === undefined || value !== null) return -1;
      value = [{ kind: 2 }];
      if (value === undefined || value === null) return -2;
      return 1;
    }
    export function run(): number {
      const bind = createBinder();
      if (bind(false) !== 7) return -1;
      if (bind(true) !== 11) return -2;
      if (bind(false) !== 7) return -3;
      return 1;
    }`,
    { target },
  );
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
  const imports = result.importObject ?? {};
  const instance = await WebAssembly.instantiate(module, imports);
  (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
  expect((instance.exports.run as () => number)()).toBe(1);
  expect((instance.exports.runNullControl as () => number)()).toBe(1);
});
