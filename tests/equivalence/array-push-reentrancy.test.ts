// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6787 — §13.3.6.1 evaluates the receiver and EVERY argument before an
// Array.prototype method runs; `push`/`unshift`/`splice`/`fill`/`copyWithin`
// read `length` inside the method. The native vec lowerings snapshotted
// `length` (and the backing array) first and compiled the arguments after, so
// an argument that mutated the same array was evaluated against stale state
// and its own writes were overwritten. Each row is diffed against native JS.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent, evaluateAsJs } from "./helpers.js";

const run = (body: string) => `export function test(): string {\n${body}\n}`;

describe("#6787 push — arguments are evaluated before `length` is read", () => {
  it("argument closure pushes onto the receiver", async () => {
    await assertEquivalent(
      run(`const a: number[] = [];
        const f = () => { a.push(1); return 2; };
        const n = a.push(f());
        return JSON.stringify(a) + n;`),
      [{ fn: "test", args: [] }],
    );
  });

  it("argument pops from the receiver — `b.push(b.pop()!)`", async () => {
    await assertEquivalent(
      run(`const b = [1];
        b.push(b.pop()!);
        return JSON.stringify(b);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("multi-arg push whose second argument pushes — `c.push(c.length, c.push(7))`", async () => {
    await assertEquivalent(
      run(`const c = [5];
        c.push(c.length, c.push(7));
        return JSON.stringify(c);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("multi-arg push where only the second argument mutates", async () => {
    await assertEquivalent(
      run(`const d: number[] = [0];
        const n = d.push(1, (d.push(9), 2));
        return JSON.stringify(d) + n;`),
      [{ fn: "test", args: [] }],
    );
  });

  it("push inside a getter argument", async () => {
    await assertEquivalent(
      run(`const a: number[] = [];
        const o = { get v(): number { a.push(1); return 2; } };
        a.push(o.v);
        return JSON.stringify(a);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("push from a valueOf on a boxed argument", async () => {
    await assertEquivalent(
      run(`const a: number[] = [];
        const o = { valueOf(): number { a.push(1); return 2; } };
        a.push(+o);
        return JSON.stringify(a);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("string[] receiver", async () => {
    await assertEquivalent(
      run(`const s: string[] = ["x"];
        const g = (): string => { s.push("a"); return "b"; };
        const n = s.push(g());
        return JSON.stringify(s) + n;`),
      [{ fn: "test", args: [] }],
    );
  });

  it("argument grows the receiver onto a new backing array", async () => {
    await assertEquivalent(
      run(`const a: number[] = [];
        const f = (): number => { for (let i = 0; i < 10; i++) a.push(i); return 99; };
        const n = a.push(f());
        return JSON.stringify(a) + n;`),
      [{ fn: "test", args: [] }],
    );
  });

  it("class-instance elements", async () => {
    await assertEquivalent(
      `class P { n: number; constructor(n: number) { this.n = n; } }
      export function test(): string {
        const a: P[] = [];
        a.push(new P(7));
        const mk = (): P => { a.push(new P(1)); return new P(2); };
        a.push(mk());
        let s = "";
        for (let i = 0; i < a.length; i++) s += a[i].n + ",";
        return s;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("IR-lowered single-argument push (helper mutates through a parameter)", async () => {
    await assertEquivalent(
      `function f(x: number[]): number { x.push(1); return 2; }
      export function test(): number {
        const a: number[] = [];
        const n = a.push(f(a));
        return n * 100 + a.length * 10 + a[0];
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("side-effect-free arguments are unaffected", async () => {
    await assertEquivalent(
      run(`const a = [5, 6, 7, 8];
        const i = 1;
        a.push(i, -2, 3);
        a.unshift(i, 0);
        a.splice(i, 1);
        a.splice(-1, 1, 9, 10);
        a.fill(0, -1);
        a.copyWithin(0, i, 3);
        return JSON.stringify(a);`),
      [{ fn: "test", args: [] }],
    );
  });
});

describe("#6787 the other in-place vec methods", () => {
  it("unshift — `u.unshift(u.shift()!)` and a mutating first argument", async () => {
    await assertEquivalent(
      run(`const u = [1, 2];
        u.unshift(u.shift()!);
        const v: number[] = [3];
        const h = (): number => { v.unshift(9); return 4; };
        const n = v.unshift(h(), 5);
        return JSON.stringify(u) + JSON.stringify(v) + n;`),
      [{ fn: "test", args: [] }],
    );
  });

  it("splice — mutating start argument and mutating inserted item", async () => {
    await assertEquivalent(
      run(`const s = [1, 2, 3];
        const r = s.splice((s.push(4), 1), 1);
        const t = [1, 2, 3];
        const r2 = t.splice(0, 1, (t.push(9), 7));
        return JSON.stringify(s) + JSON.stringify(r) + JSON.stringify(t) + JSON.stringify(r2);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("splice — spread items after a mutating start argument", async () => {
    await assertEquivalent(
      run(`const t = [1, 2];
        const src = [8, 9];
        const f = (): number => { t.push(3); return 1; };
        t.splice(f(), 0, ...src);
        return JSON.stringify(t);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("fill — mutating value and start arguments", async () => {
    await assertEquivalent(
      run(`const f = [0, 0];
        f.fill((f.push(0), 5));
        const g = [0, 0, 0, 0];
        g.fill(1, (g.pop(), 1));
        return JSON.stringify(f) + JSON.stringify(g);`),
      [{ fn: "test", args: [] }],
    );
  });

  it("copyWithin — mutating start and target arguments", async () => {
    await assertEquivalent(
      run(`const c = [1, 2, 3];
        c.copyWithin(0, (c.push(4), 3));
        const d = [1, 2, 3, 4, 5];
        d.copyWithin((d.pop(), d.pop(), 1), 0);
        return JSON.stringify(c) + JSON.stringify(d);`),
      [{ fn: "test", args: [] }],
    );
  });
});

describe("#6787 standalone lane", () => {
  it("push / unshift / splice / fill / copyWithin with re-entrant arguments", async () => {
    const source = `function enc(a: number[]): number {
        let n = a.length;
        for (let i = 0; i < a.length; i++) n = n * 10 + a[i];
        return n;
      }
      export function test(): number {
        const a: number[] = [];
        const f = (): number => { a.push(1); return 2; };
        a.push(f());
        const b = [1];
        b.push(b.pop()!);
        const c = [5];
        c.push(c.length, c.push(7));
        const u = [1, 2];
        u.unshift(u.shift()!);
        const s = [1, 2, 3];
        s.splice((s.push(4), 1), 1);
        const g = [0, 0];
        g.fill((g.push(0), 5));
        const w = [1, 2, 3];
        w.copyWithin(0, (w.push(4), 3));
        return enc(a) + enc(b) * 2 + enc(c) * 3 + enc(u) * 5 + enc(s) * 7 + enc(g) * 11 + enc(w) * 13;
      }`;
    const result = await compile(source, { fileName: "issue-6787.ts", target: "standalone" });
    expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, () => unknown>;
    exports.__module_init?.();
    expect(exports.test!()).toBe(evaluateAsJs(source).test!());
  }, 120_000);
});
