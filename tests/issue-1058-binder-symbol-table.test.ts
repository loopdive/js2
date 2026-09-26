// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1058 — four shapes from the TypeScript binder that each made it bind no
// symbols or report no redeclarations:
//   1. `let x: T` compared to `undefined` after `x = undefined!` folded to false,
//      so `for (const d of jsDocImports)` ran over null.
//   2. `forEachChildTable[node.kind]` with an enum-typed key skipped the static
//      numeric-key switch and missed every entry.
//   3. A module-level function expression called another module's same-name
//      function (parser.ts's private `visitNodes` vs visitorPublic's export).
//   4. `Map.get` handed back the host view of a stored struct, which the typed
//      read turned into null, so `symbolTable.get(name)` never found a symbol.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";

type Built = { success: boolean; errors?: { message: string }[]; binary: Uint8Array };
type HostImports = WebAssembly.Imports & {
  setInstance?(instance: WebAssembly.Instance): void;
  __setInstance?(instance: WebAssembly.Instance): void;
};

// The compiler's own import object, wired the way a host embeds it: both
// instance hooks, so struct reads from the host side can decode fields.
async function instantiate(result: Built): Promise<Record<string, Function>> {
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const imports = (result as unknown as { importObject: HostImports }).importObject;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.__setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

async function compileToWasm(source: string): Promise<Record<string, Function>> {
  return instantiate((await compile(source, { target: "gc" })) as unknown as Built);
}

describe("#1058 TypeScript binder shapes", () => {
  it("compares an undefined-holding typed variable to undefined", async () => {
    const ex = (await compileToWasm(`
      interface Tag { k: number }
      let arr: Tag[];
      let tags: Tag[] = [];
      function reset(): void { tags = undefined!; }
      export function uninit(): number { return arr === undefined ? 1 : 0; }
      export function assigned(): number { reset(); return tags === undefined ? 1 : 0; }
      export function inClosure(): number {
        let xs: Tag[];
        function r(): void { xs = undefined!; }
        function check(): number { if (xs === undefined) return 1; let n = 0; for (const t of xs) n += t.k; return n + 10; }
        r();
        return check();
      }
      export function looseNull(): number { reset(); return tags == null ? 1 : 0; }
      export function stillSet(): number { tags = [{ k: 3 }]; return tags === undefined ? 1 : 0; }
    `)) as Record<string, () => number>;
    expect(ex.uninit!()).toBe(1);
    expect(ex.assigned!()).toBe(1);
    expect(ex.inClosure!()).toBe(1);
    expect(ex.looseNull!()).toBe(1);
    expect(ex.stillSet!()).toBe(0);
  });

  it("looks a table entry up by a numeric enum key", async () => {
    const ex = (await compileToWasm(`
      const enum K { A = 244, B = 262 }
      type F = (x: number) => number;
      interface N { kind: K }
      const table: { [K.A]: F; [K.B]: F } = {
        [K.A]: function fa(x: number): number { return x + 1; },
        [K.B]: function fb(x: number): number { return x + 2; },
      };
      export function enumKey(k: number): number { const fn = (table as Record<K, F>)[k as K]; return fn === undefined ? -1 : fn(1); }
      export function structKey(k: number): number { const n: N = { kind: k as K }; const fn = (table as Record<K, F>)[n.kind]; return fn === undefined ? -1 : fn(1); }
      export function numKey(k: number): number { const fn = (table as Record<number, F>)[k]; return fn === undefined ? -1 : fn(1); }
    `)) as Record<string, (k: number) => number>;
    expect(ex.enumKey!(244)).toBe(2);
    expect(ex.enumKey!(262)).toBe(3);
    expect(ex.enumKey!(1)).toBe(-1);
    expect(ex.structKey!(262)).toBe(3);
    expect(ex.structKey!(1)).toBe(-1);
    // A missing key is `undefined`, not `null`, on the plain numeric path too.
    expect(ex.numKey!(244)).toBe(2);
    expect(ex.numKey!(1)).toBe(-1);
  });

  it("returns the stored struct from Map.get", async () => {
    const ex = (await compileToWasm(`
      interface Sym { flags: number; escapedName: string; declarations?: number[] }
      type SymbolTable = Map<string, Sym>;
      function SymbolObj(this: Sym, flags: number, name: string) { this.flags = flags; this.escapedName = name; this.declarations = undefined; }
      let Symbol: new (flags: number, name: string) => Sym;
      function createSymbol(flags: number, name: string): Sym { return new Symbol(flags, name); }
      function declare(table: SymbolTable, name: string, includes: number, excludes: number): number {
        let symbol: Sym | undefined = table.get(name);
        if (!symbol) table.set(name, symbol = createSymbol(0, name));
        else if (symbol.flags & excludes) return 100;
        symbol.flags |= includes;
        return symbol.flags;
      }
      export function literal(): number { const t = new Map<string, Sym>(); t.set("x", { flags: 5, escapedName: "x" }); const s = t.get("x"); return s ? s.flags : -1; }
      export function identity(): number { Symbol = SymbolObj as any; const s0 = createSymbol(5, "x"); const t: SymbolTable = new Map(); t.set("x", s0); return t.get("x") === s0 ? 1 : 0; }
      export function redeclare(): number { Symbol = SymbolObj as any; const t: SymbolTable = new Map(); return declare(t, "x", 2, 2) * 1000 + declare(t, "x", 2, 2); }
    `)) as Record<string, () => number>;
    expect(ex.literal!()).toBe(5);
    expect(ex.identity!()).toBe(1);
    expect(ex.redeclare!()).toBe(2100);
  });

  it("passes an array spread as a generic function's rest parameter", async () => {
    // TypeScript's `addRelatedInfo<T extends Diagnostic>(d: T, ...rel)` called
    // as `addRelatedInfo(diag, ...relatedInformation)` in declareSymbol.
    const ex = await compileToWasm(`
      interface Rel { a: number }
      interface Diag { b: number }
      function count<T extends Diag>(d: T, ...rel: Rel[]): number { return rel.length * 10 + d.b; }
      function keep<T extends Diag>(d: T, ...rel: Rel[]): T { return rel.length ? d : d; }
      function mk(a: number): Rel { return { a }; }
      export function spreadEmpty(): number { const r: Rel[] = []; return count({ b: 1 }, ...r); }
      export function spreadOne(): number { const r: Rel[] = []; r.push(mk(4)); return count({ b: 1 }, ...r); }
      export function literal(): number { return count({ b: 1 }, mk(5), mk(6)); }
      export function result(): number { const r: Rel[] = []; const d: Diag = { b: 7 }; return keep(d, ...r).b; }
    `);
    expect(ex.spreadEmpty!()).toBe(1);
    expect(ex.spreadOne!()).toBe(11);
    expect(ex.literal!()).toBe(21);
    expect(ex.result!()).toBe(7);
  });

  it("calls the module's own function when another module declares the same name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-1058-same-name-"));
    writeFileSync(
      join(dir, "a.ts"),
      `function helper(n: number): number { return n + 1; }
const table: Record<number, (n: number) => number> = {
  [5]: function viaTable(n: number): number { return helper(n); },
};
export function callA(kind: number, n: number): number { const fn = table[kind]; return fn === undefined ? -1 : fn(n); }
`,
    );
    writeFileSync(
      join(dir, "b.ts"),
      `export function helper(n: number): number { return n * 100; }
export function callB(n: number): number { return helper(n); }
`,
    );
    writeFileSync(
      join(dir, "entry.ts"),
      `import { callA } from "./a.js";
import { callB } from "./b.js";
export function run(): number { return callA(5, 2) * 1000 + callB(2); }
`,
    );
    const ex = await instantiate((await compileProject(join(dir, "entry.ts"), { target: "gc" })) as unknown as Built);
    expect(ex.run!()).toBe(3200);
  });
});
