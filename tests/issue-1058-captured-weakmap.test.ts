// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1058 native WeakMap in debug-style closures", () => {
  it.each(
    (["gc", "standalone"] as const).flatMap((target) =>
      (["run", "runOptionalState", "runOptional"] as const).map((entry) => ({ target, entry })),
    ),
  )("preserves $entry in $target", async ({ target, entry }) => {
    const result = await compile(
      `
      interface Node { kind: number; }
      function install(node: Node): void {
        const cache = new WeakMap<Node, string>();
        Object.defineProperties(node, {
          text: {
            get(this: Node) {
              let text = cache.get(this);
              if (text === undefined) {
                text = "node";
                cache.set(this, text);
              }
              return text;
            }
          }
        });
      }
      const globalCache = new WeakMap<Node, number>();
      export function runOptionalState(): number {
        const first = { kind: 1 };
        const second = { kind: 2 };
        const outer = new WeakMap<Node, WeakMap<Node, readonly Node[] | undefined>>();
        const state = { calls: 0 };
        function key(): Node { state.calls++; return first; }
        if (outer.get(second)?.get(key()) !== undefined || state.calls !== 0) return -1;
        const inner = new WeakMap<Node, readonly Node[] | undefined>();
        const children = [first, second];
        inner.set(first, children);
        outer.set(second, inner);
        const found = outer.get(second)?.get(key());
        if (found !== children || found.length !== 2 || state.calls !== 1) return -2;
        if (outer.get(second)?.has(first) !== true) return -3;
        if (outer.get(second)?.delete(first) !== true) return -4;
        if (outer.get(second)?.has(first) !== false) return -5;
        return 1;
      }
      export function runOptional(): number {
        const first = { kind: 1 };
        const second = { kind: 2 };
        const outer = new WeakMap<Node, WeakMap<Node, readonly Node[] | undefined>>();
        let keyCalls = 0;
        function key(): Node { keyCalls++; return first; }
        if (outer.get(second)?.get(key()) !== undefined) return -1;
        if (keyCalls !== 0) return -200 - keyCalls;
        const inner = new WeakMap<Node, readonly Node[] | undefined>();
        const children = [first, second];
        inner.set(first, children);
        outer.set(second, inner);
        const found = outer.get(second)?.get(key());
        if (found !== children || found.length !== 2 || keyCalls !== 1) return -3;
        if (outer.get(second)?.has(first) !== true) return -4;
        if (outer.get(second)?.delete(first) !== true) return -5;
        if (outer.get(second)?.has(first) !== false) return -6;
        return 1;
      }
      export function run(): number {
        const first = { kind: 1 };
        const second = { kind: 1 };
        install(first);
        globalCache.set(first, 7);
        if (globalCache.has(second)) return -1;
        const text = (first as any).text;
        if (text !== (first as any).text) return -2;
        return text.length * 10 + globalCache.get(first)!;
      }
    `,
      { target },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = result.importObject ?? {};
    const instance = await WebAssembly.instantiate(module, imports);
    (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance?.(instance);
    expect((instance.exports[entry] as () => number)()).toBe(entry === "run" ? 47 : 1);
  });
});
