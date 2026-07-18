// #2956 — the linear backend consumes the IR front-end (default-on since L4).
//
// Selector-claimed numeric/control-flow top-level functions build IR once
// through the SHARED front-end by default
// (planIrCompilation → from-ast → verify → linear legality) and lower via
// `LinearEmitter` into the linear module's pre-assigned slots. Everything
// else demotes (bucketed) to the linear direct path. `JS2WASM_LINEAR_IR=0`
// keeps a byte-identical direct-backend escape hatch.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import type { LinearRefCellLowering } from "../src/ir/backend/handles.js";
import type { Instr } from "../src/ir/types.js";

const FLAG = "JS2WASM_LINEAR_IR";
const savedFlag = process.env[FLAG];
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
});

async function compileLinear(src: string, flag?: boolean): Promise<Uint8Array> {
  if (flag === true) process.env[FLAG] = "1";
  else if (flag === false) process.env[FLAG] = "0";
  else delete process.env[FLAG];
  const r = await compile(src, { target: "linear" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) throw new Error("compile failed");
  return r.binary;
}

async function run(binary: Uint8Array): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

async function exportedFunctions(binary: Uint8Array): Promise<Record<string, unknown>> {
  const { instance } = await WebAssembly.instantiate(binary, {});
  return instance.exports as unknown as Record<string, unknown>;
}

function callNumber(exports: Record<string, unknown>, name: string): number {
  const fn = exports[name];
  if (typeof fn !== "function") throw new Error(`missing export ${name}`);
  return (fn as () => number)();
}

const NUMERIC_SRC = `export function add(a: number, b: number): number { return a + b; }
export function fib(n: number): number {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
export function loopSum(n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) { s = s + i; }
  return s;
}
export function test(): number { return add(fib(10), loopSum(5)); }`;

const VEC_SRC = `export function vecValue(): number {
  const values = [1.25, 2.5, 4.75];
  return values[1] + values.length;
}
export function vecAlias(): number {
  const values = [7, 11];
  const alias = values;
  return alias === values ? alias[0] + values[1] + alias.length : -1;
}
export function vecBounds(): number {
  const values = [3, 5];
  return values[99];
}
export function test(): number { return vecValue() + vecAlias() + vecBounds(); }`;

describe("#2956 L1: linear backend consumes IR for claimed numeric functions", () => {
  it("flag ON: claimed functions compile via IR (incl. self-recursion) and run correctly", async () => {
    const binary = await compileLinear(NUMERIC_SRC, true);
    const report = getLastLinearIrReport();
    expect(report).toBeDefined();
    // add / fib / loopSum / test are all numeric+control-flow: the whole
    // module compiles through the IR overlay (fib exercises the annotation
    // pre-seed for self-recursion; test exercises cross-function calls).
    expect([...(report?.compiled ?? [])].sort()).toEqual(["add", "fib", "loopSum", "test"]);
    expect(report?.rejected ?? []).toEqual([]);
    // fib(10)=55, loopSum(5)=10 → 65. Value parity with the direct path.
    expect(await run(binary)).toBe(65);
  });

  it("the explicit flag-off escape hatch keeps direct-path value parity", async () => {
    const off1 = await compileLinear(NUMERIC_SRC, false);
    const on = await compileLinear(NUMERIC_SRC, true);
    const off2 = await compileLinear(NUMERIC_SRC, false);
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(sha(off1)).toBe(sha(off2));
    // And the direct path still produces the same VALUE (65) as the IR path.
    expect(await run(off1)).toBe(65);
    expect(await run(on)).toBe(65);
  });

  it("value parity: IR-lowered and direct-path modules agree on results", async () => {
    const src = `export function collatzSteps(n: number): number {
      let steps = 0;
      let x = n;
      while (x !== 1) {
        if (x % 2 === 0) { x = x / 2; } else { x = 3 * x + 1; }
        steps = steps + 1;
      }
      return steps;
    }
    export function test(): number { return collatzSteps(27); }`;
    const on = await compileLinear(src, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("collatzSteps");
    const off = await compileLinear(src, false);
    const vOn = await run(on);
    const vOff = await run(off);
    expect(vOn).toBe(vOff);
    expect(vOn).toBe(111); // collatz(27) takes 111 steps
  });

  it("mutual recursion resolves through the annotation pre-seed", async () => {
    const src = `export function even(n: number): boolean { return n === 0 ? true : odd(n - 1); }
    export function odd(n: number): boolean { return n === 0 ? false : even(n - 1); }
    export function test(): number { return even(10) && odd(7) ? 1 : 2; }`;
    const binary = await compileLinear(src, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("even");
    expect(report?.compiled).toContain("odd");
    expect(await run(binary)).toBe(1);
  });
});

describe("#2956 L2: selector-claimed vec construction", () => {
  it("flag ON lowers fixed number vecs with value, alias, and bounds parity", async () => {
    const directBinary = await compileLinear(VEC_SRC, false);
    const irBinary = await compileLinear(VEC_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual(["test", "vecAlias", "vecBounds", "vecValue"]);

    const direct = await exportedFunctions(directBinary);
    const ir = await exportedFunctions(irBinary);
    for (const name of ["vecValue", "vecAlias", "vecBounds", "test"]) {
      expect(callNumber(ir, name), `${name} IR value`).toBe(callNumber(direct, name));
    }
    expect(callNumber(ir, "vecValue")).toBe(5.5);
    expect(callNumber(ir, "vecAlias")).toBe(20);
    // The selector path reuses the direct runtime's bounds sentinel.
    expect(callNumber(ir, "vecBounds")).toBe(0);
  });

  it("the default-on vec module is byte-identical to explicit flag-on", async () => {
    const unset = await compileLinear(VEC_SRC);
    const explicit = await compileLinear(VEC_SRC, true);
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(sha(unset)).toBe(sha(explicit));
  });

  it("unsupported hintless-empty construction stays on the direct fallback", async () => {
    const source = `export function emptyVec(): number {
      const values = [];
      return values.length;
    }
    export function test(): number { return emptyVec(); }`;
    const binary = await compileLinear(source, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled ?? []).not.toContain("emptyVec");
    expect(report?.rejected.some((rejection) => rejection.func === "emptyVec")).toBe(true);
    expect(await run(binary)).toBe(0);
  });
});

const VEC_MUT_SRC = `export function setInBounds(): number {
  const a = [1, 2, 3];
  a[1] = 9;
  return a[1] + a.length;
}
export function setGrow(): number {
  const a = [1];
  a[4] = 7;
  return a.length * 100 + a[4] + a[2];
}
export function pushStmt(): number {
  const a = [1, 2];
  a.push(5);
  return a[2] + a.length;
}
export function pushExpr(): number {
  const a = [1];
  const n = a.push(8);
  return n * 10 + a[1];
}
export function test(): number {
  return setInBounds() + setGrow() + pushStmt() + pushExpr();
}`;

describe("#2956 L2: selector-claimed vec MUTATION (element store + push)", () => {
  it("flag ON lowers element store and push with direct-path value parity", async () => {
    const directBinary = await compileLinear(VEC_MUT_SRC, false);
    const irBinary = await compileLinear(VEC_MUT_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual(["pushExpr", "pushStmt", "setGrow", "setInBounds", "test"]);

    const direct = await exportedFunctions(directBinary);
    const ir = await exportedFunctions(irBinary);
    // Direct-path parity where the direct path is spec-correct. push in
    // EXPRESSION position is now folded in: #3332 fixed the direct path so it
    // returns the new length (matching the overlay), so pushExpr joins the loud
    // parity loop.
    for (const name of ["setInBounds", "setGrow", "pushStmt", "pushExpr"]) {
      expect(callNumber(ir, name), `${name} IR value`).toBe(callNumber(direct, name));
    }
    // Absolute expectations (spec semantics):
    expect(callNumber(ir, "setInBounds")).toBe(12); // 9 + length 3
    // a[4]=7 grows: length 5 -> 500, a[4]=7, hole a[2] reads the direct
    // runtime's 0 sentinel -> 507.
    expect(callNumber(ir, "setGrow")).toBe(507);
    expect(callNumber(ir, "pushStmt")).toBe(8); // 5 + new length 3
    // push in EXPRESSION position returns the new length: both the overlay and
    // (post-#3332) the direct path yield n=2 -> 2*10 + a[1](8) = 28.
    expect(callNumber(ir, "pushExpr")).toBe(28);
    expect(callNumber(ir, "test")).toBe(12 + 507 + 8 + 28);
  });

  it("the default-on mutation module is byte-identical to explicit flag-on", async () => {
    const unset = await compileLinear(VEC_MUT_SRC);
    const explicit = await compileLinear(VEC_MUT_SRC, true);
    const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
    expect(sha(unset)).toBe(sha(explicit));
  });

  it("multi-arg push stays on the direct fallback (single plain arg only)", async () => {
    const source = `export function multiPush(): number {
      const a = [1];
      a.push(2, 3);
      return a.length;
    }
    export function test(): number { return multiPush(); }`;
    const binary = await compileLinear(source, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled ?? []).not.toContain("multiPush");
    expect(report?.rejected.some((rejection) => rejection.func === "multiPush")).toBe(true);
    // The demoted function rides the DIRECT path. Post-#3332 the direct path
    // appends every argument, so multi-arg push is now spec-correct there too:
    // length is 3.
    expect(await run(binary)).toBe(3);
  });
});

const AGGREGATE_READ_SRC = `export function readPoint(): number {
  const point = { x: 2, y: 3 };
  return point.x + point.y;
}
export function nested(): number {
  const inner = { value: 3 };
  const outer = { bonus: 4, inner };
  return outer.inner.value + outer.bonus;
}
export function boolField(): number {
  const value = { ok: true, n: 4 };
  return value.ok ? value.n : 0;
}
export function test(): number { return readPoint() + nested() + boolField(); }`;

const AGGREGATE_MUTATION_SRC = `export function mutate(): number {
  const point = { x: 2, y: 3 };
  point.x = 4;
  return point.x + point.y;
}
export function alias(): number {
  const point = { x: 2 };
  const same = point;
  same.x = 8;
  return point.x + same.x;
}
export function test(): number { return mutate() + alias(); }`;

describe("#2956 L2: selector-claimed linear-memory aggregates + ref-cells", () => {
  it("lowers object allocation and nested reads with direct-path value parity", async () => {
    const directBinary = await compileLinear(AGGREGATE_READ_SRC, false);
    const irBinary = await compileLinear(AGGREGATE_READ_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual(["boolField", "nested", "readPoint", "test"]);
    expect(report?.helpers.length).toBe(4);

    const direct = await exportedFunctions(directBinary);
    const ir = await exportedFunctions(irBinary);
    for (const name of ["readPoint", "nested", "boolField", "test"]) {
      expect(callNumber(ir, name), `${name} IR value`).toBe(callNumber(direct, name));
    }
    expect(callNumber(ir, "test")).toBe(16);
  });

  it("preserves mutation and strict aliasing through i32 arena pointers", async () => {
    const binary = await compileLinear(AGGREGATE_MUTATION_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual(["alias", "mutate", "test"]);
    const exports = await exportedFunctions(binary);
    expect(callNumber(exports, "mutate")).toBe(7);
    expect(callNumber(exports, "alias")).toBe(16);
    expect(callNumber(exports, "test")).toBe(23);
  });

  it("the default-on aggregate module is byte-identical to explicit flag-on", async () => {
    const unset = await compileLinear(AGGREGATE_READ_SRC);
    const explicit = await compileLinear(AGGREGATE_READ_SRC, true);
    const sha = (binary: Uint8Array): string => createHash("sha256").update(binary).digest("hex");
    expect(sha(unset)).toBe(sha(explicit));
  });

  it("emits primitive ref-cell allocation and field access through linear-memory handles", () => {
    const layout: LinearRefCellLowering = {
      typeIdx: 0,
      fieldIdx: 0,
      linearMemory: {
        newFuncIdx: 77,
        value: { offset: 8, type: { kind: "f64" } },
      },
    };
    const emitter = new LinearEmitter();
    const out: Instr[] = [];
    emitter.emitRefCellNew(layout, out);
    emitter.emitRefCellGet(layout, out);
    emitter.emitRefCellSet(layout, out);
    expect(out).toEqual([
      { op: "call", funcIdx: 77 },
      { op: "f64.load", align: 3, offset: 8 },
      { op: "f64.store", align: 3, offset: 8 },
    ]);
  });
});

const STRING_CORE_SRC = `export function greet(name: string): string {
  return "hi " + name;
}
export function unicode(): number {
  const value = "Grüße " + "🌍";
  return value === "Grüße 🌍" ? value.length : -1;
}
export function relation(): number {
  return "alpha" < "beta" && "same" !== "other" ? 1 : 0;
}
export function sliced(): number {
  return "abcdef".slice(1, 4).length;
}
export function objectString(): number {
  const wrapped = { text: "hi" };
  return wrapped.text === "hi" ? wrapped.text.length : 0;
}
export function test(): number {
  return greet("x").length + unicode() + relation() + sliced() + objectString();
}`;

const STRING_CHAR_CODE_SRC = `export function ascii(): number { return "ABC".charCodeAt(1); }
export function omitted(): number { return "A".charCodeAt(); }
export function bmp(): number { return "Aé".charCodeAt(1); }
export function astralHigh(): number { return "😀".charCodeAt(0); }
export function astralLow(): number { return "😀".charCodeAt(1); }
export function negative(): number { return "A".charCodeAt(-1); }
export function missing(): number { return "A".charCodeAt(4); }`;

describe("#2956 L3: selector-claimed linear strings", () => {
  it("lowers the core i32-pointer string surface with direct-path parity", async () => {
    const directBinary = await compileLinear(STRING_CORE_SRC, false);
    const irBinary = await compileLinear(STRING_CORE_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual([
      "greet",
      "objectString",
      "relation",
      "sliced",
      "test",
      "unicode",
    ]);

    const direct = await exportedFunctions(directBinary);
    const ir = await exportedFunctions(irBinary);
    for (const name of ["unicode", "relation", "sliced", "objectString", "test"]) {
      expect(callNumber(ir, name), `${name} IR value`).toBe(callNumber(direct, name));
    }
    expect(callNumber(ir, "unicode")).toBe(8); // UTF-16 code units: 🌍 counts as two.
    expect(callNumber(ir, "relation")).toBe(1);
    expect(callNumber(ir, "sliced")).toBe(3);
    expect(callNumber(ir, "objectString")).toBe(2);
    expect(callNumber(ir, "test")).toBe(18);
  });

  it("adds flag-gated UTF-16 charCodeAt capability, including surrogate halves and NaN bounds", async () => {
    const binary = await compileLinear(STRING_CHAR_CODE_SRC, true);
    const report = getLastLinearIrReport();
    expect(report?.rejected ?? []).toEqual([]);
    expect([...(report?.compiled ?? [])].sort()).toEqual([
      "ascii",
      "astralHigh",
      "astralLow",
      "bmp",
      "missing",
      "negative",
      "omitted",
    ]);

    const exports = await exportedFunctions(binary);
    expect(callNumber(exports, "ascii")).toBe("B".charCodeAt(0));
    expect(callNumber(exports, "omitted")).toBe("A".charCodeAt());
    expect(callNumber(exports, "bmp")).toBe("é".charCodeAt(0));
    expect(callNumber(exports, "astralHigh")).toBe("😀".charCodeAt(0));
    expect(callNumber(exports, "astralLow")).toBe("😀".charCodeAt(1));
    expect(callNumber(exports, "negative")).toBeNaN();
    expect(callNumber(exports, "missing")).toBeNaN();
  });

  it("keeps unsupported prototype methods on the direct fallback", async () => {
    const source = `export function find(value: string): number { return value.indexOf("x"); }
      export function test(): number { return find("ax"); }`;
    const binary = await compileLinear(source, true);
    const report = getLastLinearIrReport();
    expect(report?.compiled ?? []).not.toContain("find");
    expect(report?.rejected.some((rejection) => rejection.func === "find" && rejection.reason === "build")).toBe(true);
    expect(await run(binary)).toBe(1);
  });

  it("the default-on string module is byte-identical to explicit flag-on", async () => {
    const unset = await compileLinear(STRING_CORE_SRC);
    const explicit = await compileLinear(STRING_CORE_SRC, true);
    const sha = (binary: Uint8Array): string => createHash("sha256").update(binary).digest("hex");
    expect(sha(unset)).toBe(sha(explicit));
  });
});

describe("#2956 L4: default-on overlay + unified fallback ratchet", () => {
  it("uses the IR overlay when the environment flag is unset", async () => {
    const defaultBinary = await compileLinear(NUMERIC_SRC);
    const report = getLastLinearIrReport();
    expect([...(report?.compiled ?? [])].sort()).toEqual(["add", "fib", "loopSum", "test"]);

    const explicitBinary = await compileLinear(NUMERIC_SRC, true);
    const sha = (binary: Uint8Array): string => createHash("sha256").update(binary).digest("hex");
    expect(sha(defaultBinary)).toBe(sha(explicitBinary));
    expect(await run(defaultBinary)).toBe(65);
  });

  it("reports selector-rejected functions while compiling them on the direct path", async () => {
    const binary = await compileLinear(`
      export function withDefault(value: number = 1): number { return value + 1; }
    `);
    const report = getLastLinearIrReport();
    expect(report?.compiled ?? []).not.toContain("withDefault");
    expect(report?.rejected).toContainEqual({
      func: "withDefault",
      reason: "select:param-shape-rejected",
      detail: undefined,
    });

    const exports = await exportedFunctions(binary);
    expect((exports.withDefault as (value: number) => number)(4)).toBe(5);
  });
});
