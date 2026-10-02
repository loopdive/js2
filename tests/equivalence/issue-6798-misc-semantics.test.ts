// #6798 — six probe-backed semantic divergences, one `it` per slice.
import { describe, expect, it, vi } from "vitest";
import { compile } from "../../src/index.js";
import { assertEquivalent, instantiateWithRuntime } from "./helpers.js";

// resolve-stage-catch: a switch the mocked `irClosureSignatureFromFunctionTypeNode`
// (called from `resolvePositionType`'s FunctionTypeNode arm) reads to simulate a
// real bug (`TypeError`) or a designed "not expressible" answer (`null`).
const inject = vi.hoisted(() => ({ mode: "off" as "off" | "type-error" | "null" }));

vi.mock("../../src/ir/select.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/ir/select.js")>();
  return {
    ...actual,
    irClosureSignatureFromFunctionTypeNode(...args: Parameters<typeof actual.irClosureSignatureFromFunctionTypeNode>) {
      if (inject.mode === "type-error") throw new TypeError("injected #6798 resolve-stage bug");
      if (inject.mode === "null") return null;
      return actual.irClosureSignatureFromFunctionTypeNode(...args);
    },
  };
});

describe("#6798 misc probe-backed semantic divergences", () => {
  it("resolve-stage-catch: an untyped throw in resolvePositionType is a hard error, a designed demote a warning", async () => {
    const src = `
      function apply(fn: () => number): number { return fn() + 1; }
      export function test(): number { return apply(() => 41); }
    `;
    try {
      inject.mode = "type-error";
      const bug = await compile(src, { fileName: "probe.ts" });
      expect(bug.success).toBe(false);
      const hard = bug.errors.filter(
        (e) => e.severity === "error" && /could not resolve types for apply/.test(e.message),
      );
      expect(hard.length).toBe(1);
      expect(hard[0]!.message).toContain("injected #6798 resolve-stage bug");

      inject.mode = "null";
      const demote = await compile(src, { fileName: "probe.ts" });
      expect(demote.success).toBe(true);
      const warned = demote.errors.filter((e) => /could not resolve types for apply/.test(e.message));
      expect(warned.map((e) => e.severity)).toEqual(["warning"]);
    } finally {
      inject.mode = "off";
    }
  });

  it("typeof-class: a class value read through any / unknown / a parameter is 'function'", async () => {
    await assertEquivalent(
      `
      class K { static s(): number { return 1; } }
      class Sub extends K {}
      function g(v: any): string { return typeof v; }
      export function test(): string {
        const x: any = class {};
        const u: unknown = K;
        const arr: any[] = [K, Sub, new K()];
        return [
          typeof (class {}), typeof x, g(x), g(K), g(Sub), typeof u, g(arr[0]), g(arr[1]), g(arr[2]),
          String(typeof x === "function"), String(typeof x === "object"), String(typeof arr[0] === "function"),
        ].join(",");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("typeof-tdz: typeof of a let/const in its TDZ throws a ReferenceError, also through a folded comparison", async () => {
    await assertEquivalent(
      `
      function probe(f: () => string): string {
        try { return "ok:" + f(); } catch (e) { return e instanceof ReferenceError ? "RE" : "other"; }
      }
      export function test(): string {
        const a = probe(() => { const t = typeof y; let y = 1; return t + y; });
        const b = probe(() => { const r = typeof z === "number"; const z = 1; return String(r) + z; });
        const c = probe(() => { let w = 1; return typeof w; });
        const d = probe(() => { const f = () => typeof q; const r1 = probe(f); let q = "s"; return r1 + "/" + f(); });
        const e = probe(() => { let out = ""; for (let i = 0; i < 2; i++) { let v = i; out += typeof v; } return out; });
        return [a, b, c, d, e].join("|");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("yield-star-return: the delegate's return value is the yield* expression's value in every position", async () => {
    await assertEquivalent(
      `
      function* inner() { yield 1; return "r"; }
      function* innerN() { yield 1; return 7; }
      function id(x: any): any { return x; }
      function* o1() { yield (yield* inner()); }
      function* o2() { const rv = yield* inner(); yield "o:" + rv; }
      function* o3() { return yield* inner(); }
      function* o4() { yield "o:" + (yield* inner()); }
      function* o5() { yield id(yield* inner()); }
      function* o6() { const rv: string = yield* inner(); yield rv.length; }
      function* o7() { let rv = ""; rv = yield* inner(); yield rv.length; }
      function* o8() { const n = yield* innerN(); yield n * 2; }
      export function test(): string {
        const g = o3(); g.next(); const r3 = g.next();
        return [
          [...o1()].join(","), [...o2()].join(","), String(r3.value) + "/" + r3.done, [...o4()].join(","),
          [...o5()].join(","), [...o6()].join(","), [...o7()].join(","), [...o8()].join(","),
        ].join("|");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("string-bool-union: a boolean/number && / || keeps its boolean tag when stringified or stored as any", async () => {
    await assertEquivalent(
      `
      function f(): number { return 5; }
      function g(b: boolean): string { return String(b && f()); }
      function cc(s: string, b: boolean): string { return s + (b && f()) + "|" + ((b || f()) + s); }
      function arith(b: boolean): number { return (b && f()) + 1; }
      function cnd(b: boolean): number { let c = 0; if (b && f()) c = 1; while (b && c < 3 && f()) c++; return c; }
      export function test(): string {
        const x: any = false && f();
        return [
          String(false && f()), String(true || f()), String(true && f()), String(false || f()),
          g(false), g(true), cc("a", false), cc("b", true), \`\${false && f()}\`, "" + (true || f()),
          String(x), typeof x, arith(false), arith(true), cnd(true), cnd(false),
        ].join(";");
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  // `type i32 = number` is an opt-in that changes semantics on purpose, so the
  // erased-type JS run is not the oracle: ToInt32 (`v | 0`) is. Every f64 → i32
  // destination (init, assignment, parameter, field, return, i32 division and
  // negation) must agree with `| 0` on BOTH lanes. Returns the failing index.
  it("i32-saturate: an i32-annotated destination converts with ToInt32 (wraps like | 0), both lanes", async () => {
    const src = `
      type i32 = number;
      function id(x: i32): i32 { return x; }
      function fromNum(x: number): i32 { const r: i32 = x; return r; }
      function assign(x: number): i32 { let r: i32 = 0; r = x; return r; }
      function div(a: i32, b: i32): i32 { return a / b; }
      function neg(a: i32): i32 { return -a; }
      function mul(a: i32, b: i32): i32 { return a * b; }
      class P { n: i32 = 0; set(v: number): i32 { this.n = v; return this.n; } }
      export function test(): number {
        const vals = [2147483648, NaN, 4294967297, -2147483649, Infinity, -Infinity, 1.9, -1.9, 3e10, -0];
        const out: number[] = [];
        for (const v of vals) {
          const w = v | 0;
          out.push(fromNum(v) === w ? 1 : 0, assign(v) === w ? 1 : 0, id(v) === w ? 1 : 0, new P().set(v) === w ? 1 : 0);
        }
        out.push(div(7, 0) === ((7 / 0) | 0) ? 1 : 0, div(-7, 2) === -3 ? 1 : 0);
        out.push(neg(-2147483648) === (2147483648 | 0) ? 1 : 0, mul(65536, 65536) === ((65536 * 65536) | 0) ? 1 : 0);
        for (let i = 0; i < out.length; i++) if (out[i] !== 1) return i;
        return -1;
      }
    `;
    for (const target of [undefined, "standalone"] as const) {
      const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      const instance = await instantiateWithRuntime(result);
      expect((instance.exports.test as () => number)(), target ?? "gc").toBe(-1);
    }
  });
});
