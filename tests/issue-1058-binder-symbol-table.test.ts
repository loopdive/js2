// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

it.each(
  (["gc", "standalone"] as const).flatMap((target) =>
    [false, true].map((useConstructor) => ({ target, constructor: useConstructor })),
  ),
)(
  "initializes a captured binder symbol table in $target (constructor=$constructor)",
  async ({ target, constructor: useConstructor }) => {
    const result = await compile(
      `interface Symbol { flags: number; }
    interface Source { kind: number; locals?: Map<string, Symbol>; }
    function Symbol(this: Symbol, flags: number): void { this.flags = flags; }
    const allocator = { getSymbolConstructor: () => Symbol as any };
    function createBinder() {
      var container: Source;
      var classifiable: Set<string>;
      var Symbol: new (flags: number) => Symbol;
      var symbolCount = 0;
      function createSymbol(): Symbol { symbolCount++; return ${useConstructor ? "new Symbol(2)" : "{ flags: 2 }"}; }
      function declareSymbol(table: Map<string, Symbol>, name: string): void {
        let symbol = table.get(name);
        classifiable.add(name);
        if (!symbol) table.set(name, symbol = createSymbol());
        symbol.flags |= 4;
      }
      function bindBlock(): void {
        if (!container.locals) container.locals = new Map<string, Symbol>();
        declareSymbol(container.locals, "x");
      }
      return function bind(source: Source): number {
        container = source;
        classifiable = new Set<string>();
        Symbol = allocator.getSymbolConstructor();
        symbolCount = 0;
        bindBlock();
        container = undefined!;
        return symbolCount;
      };
    }
    export function run(): number {
      const source: Source = { kind: 308 };
      const bind = createBinder();
      if (bind(source) !== 1) return -1;
      if (source.locals!.size !== 1) return -2;
      if (source.locals!.get("x")!.flags !== 6) return -3;
      if (bind(source) !== 0) return -4;
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
  },
);
