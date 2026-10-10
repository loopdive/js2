// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { buildImports, compile, instantiateWasm } from "../src/index.js";

// #6940 — the for-statement BODY buffer was detached (unreachable from every
// fixupModuleGlobalIndices root) while the INCREMENTOR compiled. When the
// incrementor minted a module-global-shifting import (`M = M.nextBody` → the
// first `nextBody` host property-key string constant), the body's already
// emitted `global.get $__hole` (hole-aware f64 → externref boxing) kept its
// pre-shift index and read whatever global sat there — `__argc` (i32) in Octane
// box2d → invalid Wasm, an externref global here → valid by luck but wrong.
// Mirror of the #1690 cond/incr fix: `bodyInstrs` joins `ctx.liveBodies` for
// that window (and for the do-while condition window).

const B2R4 = `// b2r4.js — node: run() === 8
var holes = [1, , 3];               // arms ctx.usesArrayHoles (hole-aware f64 -> externref boxing)
var junk = { a: 1 }; delete junk.a; // arms ctx.moduleUsesDelete (delete-aware dynamic member get)
function Ctl() { this.list = null; }
Ctl.prototype.Step = function () {
  var total = 0;
  for (var M = this.list; M; M = M.nextBody) {       // incrementor: first \`nextBody\` read in the module
    var L = M.body;
    for (var z = L.first; z; z = z.GetNext()) {
      var D = z.Area();
      total += D;                                    // hole-aware box of \`total\` → \`global.get $__hole\`
    }
  }
  return total;
};
export function run() {
  var c = new Ctl();
  var z2 = { Area: function () { return 3; }, GetNext: function () { return null; } };
  var z1 = { Area: function () { return 2; }, GetNext: function () { return z2; } };
  c.list = { body: { first: z1 }, nextBody: null };
  return c.Step() + holes.length;
}
`;

// do-while twin: the body boxes through `$__hole`, the CONDITION holds the
// module's first `nextBody` read.
const DO_WHILE = `var holes = [1, , 3];
var junk = { a: 1 }; delete junk.a;
function Ctl() { this.list = null; }
Ctl.prototype.Step = function () {
  var total = 0;
  var M = this.list;
  do {
    var L = M.body;
    for (var z = L.first; z; z = z.GetNext()) {
      var D = z.Area();
      total += D;
    }
  } while ((M = M.nextBody));
  return total;
};
export function run() {
  var c = new Ctl();
  var z2 = { Area: function () { return 3; }, GetNext: function () { return null; } };
  var z1 = { Area: function () { return 2; }, GetNext: function () { return z2; } };
  c.list = { body: { first: z1 }, nextBody: null };
  return c.Step() + holes.length;
}
`;

type Lane = "gc" | "standalone";

async function build(src: string, lane: Lane) {
  const r = await compile(src, {
    fileName: "repro.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    validate: false,
    emitWat: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  return r;
}

async function runIt(src: string, lane: Lane): Promise<unknown> {
  const r = await build(src, lane);
  const mod = await WebAssembly.compile(r.binary);
  if (lane === "standalone") {
    const inst = await WebAssembly.instantiate(mod, {});
    return (inst.exports as { run: () => unknown }).run();
  }
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return (instance.exports as { run: () => unknown }).run();
}

/**
 * Every hole-sentinel arm (`i64.const HOLE_F64_BITS; i64.eq; if; then`) must
 * read the `$__hole` global. Validation alone is luck-dependent: it only fails
 * when the global at the stale index has an incompatible type.
 */
function holeArmIndices(wat: string): { holeIdx: number; armReads: number[] } {
  const lines = wat.split("\n");
  const importedGlobals = lines.filter((l) => /^\s*\(import .*\(global /.test(l)).length;
  const definedGlobals = lines.filter((l) => /^ {2}\(global /.test(l));
  const holePos = definedGlobals.findIndex((l) => l.startsWith("  (global $__hole "));
  expect(holePos).toBeGreaterThanOrEqual(0);
  const armReads: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "i64.const 9218868440963334174") continue;
    // i64.eq, (if (result …), (then, global.get N
    const m = /^global\.get (\d+)$/.exec(lines[i + 4]?.trim() ?? "");
    if (lines[i + 1]?.trim() === "i64.eq" && m) armReads.push(Number(m[1]));
  }
  return { holeIdx: importedGlobals + holePos, armReads };
}

describe("#6940 for/do-while body buffer reachable across the incrementor/condition window", () => {
  for (const [name, src] of [
    ["for (b2r4)", B2R4],
    ["do-while", DO_WHILE],
  ] as const) {
    it(`[gc] ${name}: every hole arm reads $__hole`, async () => {
      const r = await build(src, "gc");
      const { holeIdx, armReads } = holeArmIndices(r.wat!);
      expect(armReads.length).toBeGreaterThan(0);
      expect(
        armReads.every((i) => i === holeIdx),
        `hole=${holeIdx} arms=${armReads.join(",")}`,
      ).toBe(true);
    });

    it(`[gc] ${name}: valid and run() === 8`, async () => {
      expect(await runIt(src, "gc")).toBe(8);
    });

    it(`[standalone] ${name}: valid and run() === 8 (negative control)`, async () => {
      expect(await runIt(src, "standalone")).toBe(8);
    });
  }
});
