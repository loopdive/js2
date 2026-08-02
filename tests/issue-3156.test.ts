// #3156 — IR lowering for string `.substring(...)` / `.charCodeAt(...)`
// (the top post-claim divergence class from the #3153 census, on the #3143
// IR-first-flip selector-precision track).
//
// Before this slice, the STATIC selector claimed functions containing these
// calls but `STRING_METHOD_TABLE` had no entry — `lowerStringMethodCall`
// returned null and the function demoted POST-CLAIM ("method call
// .substring(...) on string not in slice 4"). Under IR-first that demote
// becomes a hard compile error, so the class had to become genuinely
// lowerable. These tests assert BOTH halves:
//   1. value equivalence against the legacy path (`experimentalIR: false`)
//      and against the JS oracle, in host AND standalone modes;
//   2. the claim actually LOWERS — `irPostClaimErrors` stays empty (the
//      load-bearing #3143 assertion: no silent post-claim demote).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunOutcome {
  legacy: unknown;
  ir: unknown;
  irPostClaimErrors: { kind: string; func: string; message: string }[];
}

async function dualRun(source: string, standalone: boolean): Promise<RunOutcome> {
  const base: Record<string, unknown> = standalone ? { target: "standalone" } : {};
  const legacy = await compile(source, { ...base, experimentalIR: false });
  if (!legacy.success) {
    throw new Error(`legacy compile failed:\n${legacy.errors.map((e) => e.message).join("\n")}`);
  }
  const ir = await compile(source, { ...base });
  if (!ir.success) {
    throw new Error(`ir compile failed:\n${ir.errors.map((e) => e.message).join("\n")}`);
  }
  const mk = (r: typeof legacy) => (standalone ? {} : buildImports(r.imports, undefined, r.stringPool));
  const [{ instance: lInst }, { instance: rInst }] = await Promise.all([
    WebAssembly.instantiate(legacy.binary, mk(legacy) as WebAssembly.Imports),
    WebAssembly.instantiate(ir.binary, mk(ir) as WebAssembly.Imports),
  ]);
  const lFn = lInst.exports.test as () => unknown;
  const rFn = rInst.exports.test as () => unknown;
  return {
    legacy: lFn(),
    ir: rFn(),
    irPostClaimErrors: ir.irPostClaimErrors ?? [],
  };
}

const CASES: { name: string; source: string; expected: number }[] = [
  {
    name: "substring(start, end)",
    source: `export function test(): number {
      const s = "hello world";
      return s.substring(6, 11) === "world" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring(start) — end defaults to length (#1248)",
    source: `export function test(): number {
      const s = "hello world";
      return s.substring(6) === "world" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring() — both default (whole string)",
    source: `export function test(): number {
      const s = "abc";
      return s.substring() === "abc" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring swaps start > end (§22.1.3.24)",
    source: `export function test(): number {
      const s = "hello world";
      return s.substring(11, 6) === "world" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring clamps negative start",
    source: `export function test(): number {
      const s = "abc";
      return s.substring(-1) === "abc" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring clamps end > length",
    source: `export function test(): number {
      const s = "abc";
      return s.substring(1, 99) === "bc" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring with fractional args (ToInteger truncation)",
    source: `export function test(): number {
      const s = "hello world";
      return s.substring(6.9, 11.2) === "world" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "substring on concat result (non-flat receiver)",
    source: `export function test(): number {
      const a = "hello ";
      const b = "world";
      const s = a + b;
      return s.substring(6, 11) === "world" ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt in range",
    source: `export function test(): number {
      const s = "abc";
      return s.charCodeAt(1) === 98 ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt() — position defaults to 0",
    source: `export function test(): number {
      const s = "abc";
      return s.charCodeAt() === 97 ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt out of range → NaN (§22.1.3.3, #2003 no trap)",
    source: `export function test(): number {
      const s = "abc";
      const x = s.charCodeAt(5);
      return x !== x ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt negative index → NaN",
    source: `export function test(): number {
      const s = "abc";
      const x = s.charCodeAt(-1);
      return x !== x ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt fractional index truncates toward zero",
    source: `export function test(): number {
      const s = "abc";
      return s.charCodeAt(1.7) === 98 ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt(-0.5) → position 0 (truncation, not floor)",
    source: `export function test(): number {
      const s = "abc";
      return s.charCodeAt(-0.5) === 97 ? 1 : 0;
    }`,
    expected: 1,
  },
  {
    name: "charCodeAt result feeds arithmetic",
    source: `export function test(): number {
      const s = "AZ";
      return s.charCodeAt(1) - s.charCodeAt(0);
    }`,
    expected: 25,
  },
  {
    name: "charCodeAt loop sum (canonical scan shape)",
    source: `export function test(): number {
      const s = "abc";
      let sum = 0;
      for (let i = 0; i < 3; i++) {
        sum += s.charCodeAt(i);
      }
      return sum;
    }`,
    expected: 97 + 98 + 99,
  },
  {
    name: "substring + charCodeAt composed",
    source: `export function test(): number {
      const s = "hello world";
      const w = s.substring(6);
      return w.charCodeAt(0) === 119 ? 1 : 0;
    }`,
    expected: 1,
  },
];

describe("#3156 IR string substring/charCodeAt — host mode", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const r = await dualRun(c.source, false);
      expect(r.legacy).toBe(c.expected);
      expect(r.ir).toBe(c.expected);
      // The #3143 selector-precision assertion: the claim LOWERED — no
      // silent post-claim demote back to legacy.
      expect(r.irPostClaimErrors).toEqual([]);
    });
  }

  it("routes substring through the wasm:js-string builtin instead of an env host call", async () => {
    const r = await compile(
      `export function test(s: string): string {
        return s.substring(1, 3);
      }`,
      { emitWat: true, optimize: 0 },
    );

    expect(r.success).toBe(true);
    const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
    expect(moduleImports).toContainEqual(
      expect.objectContaining({ module: "wasm:js-string", name: "substring", kind: "function" }),
    );
    expect(moduleImports.some((imp) => imp.module === "env" && imp.name === "string_substring")).toBe(false);
    expect(r.wat).toContain("(func $__jsstr_substring");
  });
});

describe("#3156 IR string substring/charCodeAt — standalone (native strings)", () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const r = await dualRun(c.source, true);
      expect(r.legacy).toBe(c.expected);
      expect(r.ir).toBe(c.expected);
      expect(r.irPostClaimErrors).toEqual([]);
    });
  }
});
