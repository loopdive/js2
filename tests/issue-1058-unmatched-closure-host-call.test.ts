// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — a generic helper erases its callback's `T` to externref, so a
// callback compiled with its own ABI (a nominal `Node` parameter, a `void`
// result, captured state) matches no arm of the helper's funcref ladder.
// The live closure must still run instead of ending in TypeError.
// Witness: the TypeScript binder's `forEach(nodes, bind)`.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1058 callback with its own ABI through a generic helper", () => {
  it("calls void, number and captured callbacks through forEach", async () => {
    const ex = (await compileToWasm(`
      interface Node { kind: number; children?: Node[] }
      function forEach<T, U>(array: readonly T[] | undefined, callback: (element: T, index: number) => U | undefined): U | undefined {
        if (array !== undefined) {
          for (let i = 0; i < array.length; i++) {
            const result = callback(array[i], i);
            if (result) return result;
          }
        }
        return undefined;
      }
      function kids(): Node[] { return [{ kind: 10 }, { kind: 100 }]; }
      let g = 0;
      function topVoid(n: Node): void { g += n.kind; }
      export function topLevelVoid(): number { g = 0; forEach(kids(), topVoid); return g; }
      export function arrow(): number { let t = 0; forEach(kids(), (n: Node) => { t += n.kind; }); return t; }
      export function nestedNumber(): number {
        let t = 0;
        function b(n: Node): number | undefined { t += n.kind; return undefined; }
        forEach(kids(), b);
        return t;
      }
      function makeBinder(): (n: Node) => number {
        let total = 0;
        return root;
        function root(n: Node): number { total = 0; bind(n); return total; }
        function bind(n: Node): void { total += n.kind; bindEach(n.children); }
        function bindEach(nodes: Node[] | undefined, bindFunction: (n: Node) => void = bind): void {
          if (nodes === undefined) return;
          forEach(nodes, bindFunction);
        }
      }
      export function binder(): number { return makeBinder()({ kind: 1, children: kids() }); }
      export function stopsOnTruthy(): number {
        const found = forEach(kids(), (n: Node) => (n.kind > 50 ? n : undefined));
        return found ? found.kind : -1;
      }
    `)) as Record<"topLevelVoid" | "arrow" | "nestedNumber" | "binder" | "stopsOnTruthy", () => number>;
    expect(ex.topLevelVoid()).toBe(110);
    expect(ex.arrow()).toBe(110);
    expect(ex.nestedNumber()).toBe(110);
    expect(ex.binder()).toBe(111);
    expect(ex.stopsOnTruthy()).toBe(100);
  });
});
