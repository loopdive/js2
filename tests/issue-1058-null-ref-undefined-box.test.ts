// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — a `T | undefined` struct reference uses `ref.null` for `undefined`.
// Boxing it into an untyped (externref) slot must produce JavaScript
// `undefined`, not `null`, or every later `=== undefined` check reads false.
// Witness: the TypeScript parser's
// `sourceFile.externalModuleIndicator = isFileProbablyExternalModule(sf)`,
// which stored `null` for plain scripts; `isExternalModule` then answered true
// and the binder trapped in `bindSourceFileAsExternalModule`.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// bits(v): 1 = undefined, 2 = null
const BITS = `function bits(v: unknown): number { return (v === undefined ? 1 : 0) + (v === null ? 2 : 0); }`;

describe("#1058 null reference standing for undefined", () => {
  it("stores and passes an absent `T | undefined` result as undefined", async () => {
    const ex = (await compileToWasm(`
      interface Node { kind: number }
      interface SF { statements: Node[]; ind?: Node | true; flags: number }
      function probably(sf: SF): Node | undefined { return sf.statements.length > 5 ? sf.statements[0] : undefined; }
      function firstOr(sf: SF): Node | undefined {
        for (const s of sf.statements) if (s.kind === 99) return s;
        return undefined;
      }
      function meta(sf: SF): Node | undefined { return sf.flags & 4 ? sf.statements[0] : undefined; }
      function probablyOr(sf: SF) { return firstOr(sf) || meta(sf); }
      ${BITS}
      export function direct(): number { const sf: SF = { statements: [], flags: 0 }; sf.ind = probably(sf); return bits(sf.ind); }
      export function viaOr(): number { const sf: SF = { statements: [], flags: 0 }; sf.ind = probablyOr(sf); return bits(sf.ind); }
      export function toUnknown(): number { const sf: SF = { statements: [], flags: 0 }; return bits(probably(sf)); }
    `)) as { direct(): number; viaOr(): number; toUnknown(): number };
    expect(ex.direct()).toBe(1);
    expect(ex.viaOr()).toBe(1);
    expect(ex.toUnknown()).toBe(1);
  });

  it("keeps the parser's module-indicator check false for scripts", async () => {
    const ex = (await compileToWasm(`
      interface Node { kind: number; flags: number }
      interface SourceFile extends Node { statements: Node[]; externalModuleIndicator?: Node | true }
      function forEach<T, U>(array: readonly T[] | undefined, callback: (element: T, index: number) => U | undefined): U | undefined {
        if (array !== undefined) {
          for (let i = 0; i < array.length; i++) {
            const result = callback(array[i], i);
            if (result) return result;
          }
        }
        return undefined;
      }
      function isIndicator(node: Node) { return node.kind === 95 ? node : undefined; }
      function walk(node: Node): Node | undefined { return node.kind === 102 ? node : undefined; }
      function metaIfNecessary(sf: SourceFile) { return sf.flags & 4 ? walk(sf) : undefined; }
      function isFileProbablyExternalModule(sf: SourceFile): Node | undefined {
        return forEach(sf.statements, isIndicator) || metaIfNecessary(sf);
      }
      function setIndicator(sf: SourceFile) { sf.externalModuleIndicator = isFileProbablyExternalModule(sf); }
      function isExternalModule(sf: SourceFile): boolean { return sf.externalModuleIndicator !== undefined; }
      ${BITS}
      function run(first: number): number {
        const sf: SourceFile = { kind: 308, flags: 0, statements: [{ kind: first, flags: 0 }] };
        setIndicator(sf);
        return bits(sf.externalModuleIndicator) + (isExternalModule(sf) ? 10 : 0);
      }
      export function script(): number { return run(1); }
      export function module(): number { return run(95); }
      export function rawCall(): number {
        const sf: SourceFile = { kind: 308, flags: 0, statements: [{ kind: 1, flags: 0 }] };
        return bits(isFileProbablyExternalModule(sf));
      }
    `)) as { script(): number; module(): number; rawCall(): number };
    expect(ex.script()).toBe(1);
    expect(ex.module()).toBe(10);
    expect(ex.rawCall()).toBe(1);
  });

  it("leaves a `T | null` result as null", async () => {
    const ex = (await compileToWasm(`
      interface Node { kind: number }
      interface SF { statements: Node[]; ind?: Node | null; flags: number }
      function find(sf: SF): Node | null { return sf.statements.length > 3 ? sf.statements[0] : null; }
      ${BITS}
      export function stored(): number { const sf: SF = { statements: [], flags: 0 }; sf.ind = find(sf); return bits(sf.ind); }
      export function passed(): number { const sf: SF = { statements: [], flags: 0 }; return bits(find(sf)); }
    `)) as { stored(): number; passed(): number };
    expect(ex.stored()).toBe(2);
    expect(ex.passed()).toBe(2);
  });
});
