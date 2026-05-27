import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("RegExp.prototype.exec/test argument coercion (#1332)", () => {
  it("exec ToStrings a number argument", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const r = /\\d{2}/;
        const m: any = r.exec(1234 as any);
        return (m !== null && m[0] === "12") ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("test ToStrings a number argument", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const r = /5/;
        return r.test(12345 as any) ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("exec returns null when ToStringed numeric arg does not match", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const r = /z/;
        const m: any = r.exec(98765 as any);
        return m === null ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});

describe("RegExp.prototype method/getter dispatch via .call (#1332)", () => {
  it("exec invoked via .call on a RegExp receiver returns the match array", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const m: any = (RegExp.prototype.exec as any).call(/ab/, "xaby");
        return (m !== null && m[0] === "ab") ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("test invoked via .call on a RegExp receiver returns the boolean result", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        return (RegExp.prototype.test as any).call(/5/, "12345") ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("flags getter from the prototype descriptor, called on a RegExp, returns the flag string", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const d: any = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags");
        const g: any = d.get;
        return g.call(/a/gi) === "gi" ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("matchAll iterator inherits a RegExpStringIterator prototype with a next method", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        const it: any = ("aa" as any).matchAll(/a/g);
        const proto: any = Object.getPrototypeOf(it);
        return (typeof proto.next === "function") ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
