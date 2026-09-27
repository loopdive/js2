// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster H) §10.4.4 — an `arguments` exotic object's `length` is an
 * ORDINARY data property, not the Array-exotic index-domain length that the
 * shared `$__vec_base` prefix carries.
 *
 * Two halves of one rule, both RED on the branch base under `--target
 * standalone`:
 *
 * 1. **The define half.** `Object.defineProperty(args, "length", {value: 6})`
 *    was routed through the vec overlay's ArraySetLength (§10.4.2.1) path,
 *    which GROWS the physical backing with `array.new_default`. The new tail
 *    then held wasm `null`, so `args[4]` read back as JS `null` (not
 *    `undefined`) and `4 in args` answered TRUE for a slot that is not an own
 *    property. The ASSIGNMENT half (`args.length = 6`) already recorded the
 *    value in the `$__arguments_vec` override fields and left the backing
 *    alone — the two disagreed on the same question.
 * 2. **The read half.** `__extern_length` — the array-like length every
 *    generic spec loop reads (`Array.prototype.concat`'s §23.1.3.1 walk,
 *    `Array.from`, the borrowed HOFs) — read the PHYSICAL field 0 and so
 *    answered 3 for an arguments object whose own `length` says 6. Measured on
 *    base: `[].concat(args)` after `args.length = 6` produced THREE elements
 *    where the spec wants six (three values + three holes).
 *
 * Together they are test262
 * `built-ins/Array/prototype/concat/Array.prototype.concat_{sloppy-arguments,
 * sloppy-arguments-with-dupes,strict-arguments}.js`, whose second assertion is
 * `[].concat(args) === [1, 2, 3, undefined, undefined, undefined]` after
 * `Object.defineProperty(args, "length", {value: 6})` — base answered
 * `[1, 2, 3, null, null, null]`.
 *
 * The negative direction is pinned too: an ordinary arguments object (no
 * explicit `length` write) must keep the physical answer, which is what makes
 * the override bit — and therefore every existing module's bytes — inert.
 *
 * Output is read back host-free through the module's own `__stdout_prepare` /
 * `__stdout_char` exports (#3469), and every probe value is untyped plain
 * JavaScript: the defect lives entirely on the dynamic path.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-arguments-ordinary-length.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // A leaked host import would make every assertion below meaningless.
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

describe("#6651 arguments `length` is an ordinary property (standalone)", () => {
  it("defineProperty(args, 'length', …) does not materialise index slots", async () => {
    // RED on base: `[4]=null in=true` — the ArraySetLength grow path filled the
    // new tail with wasm null and `__extern_has_idx` reported it present.
    const lines = await runLines(`
      var args = (function (x, y, z) { return arguments; })(1, 2, 3);
      Object.defineProperty(args, "length", { value: 6 });
      LOG("len=" + args.length + " [4]=" + args[4] + " in=" + (4 in args));
    `);
    expect(lines).toEqual(["len=6 [4]=undefined in=false"]);
  });

  it("the assignment half is unchanged — and now agrees with the define half", async () => {
    // GREEN on base for the read/`in` columns; kept as the agreement guard.
    const lines = await runLines(`
      var args = (function (x, y, z) { return arguments; })(1, 2, 3);
      args.length = 6;
      LOG("len=" + args.length + " [4]=" + args[4] + " in=" + (4 in args));
    `);
    expect(lines).toEqual(["len=6 [4]=undefined in=false"]);
  });

  it("concat spreads an arguments object to its OWN length, holes included", async () => {
    // RED on base: both lines answered length 3 (assignment) / six slots with
    // `null` (define). §23.1.3.1 reads Get(E, "length"), not a physical count.
    const lines = await runLines(`
      function make() { var a = (function (x, y, z) { return arguments; })(1, 2, 3); a[Symbol.isConcatSpreadable] = true; return a; }
      var byAssign = make(); byAssign.length = 6;
      var o1 = [].concat(byAssign);
      LOG("assign: len=" + o1.length + " [4]=" + o1[4] + " [0]=" + o1[0]);
      var byDefine = make(); Object.defineProperty(byDefine, "length", { value: 6 });
      var o2 = [].concat(byDefine);
      LOG("define: len=" + o2.length + " [4]=" + o2[4] + " [0]=" + o2[0]);
    `);
    expect(lines).toEqual(["assign: len=6 [4]=undefined [0]=1", "define: len=6 [4]=undefined [0]=1"]);
  });

  it("an untouched arguments object keeps the PHYSICAL length (the override stays inert)", async () => {
    // The negative direction. A fix that always consulted the override fields
    // would pass the three assertions above and break this one.
    const lines = await runLines(`
      var args = (function (x, y, z) { return arguments; })(1, 2, 3);
      args[Symbol.isConcatSpreadable] = true;
      LOG("len=" + args.length + " concat=" + [].concat(args).length);
    `);
    expect(lines).toEqual(["len=3 concat=3"]);
  });

  it("a non-numeric ordinary `length` converts through ToLength, not through the vec field", async () => {
    // §7.1.20: ToLength(ToNumber("unlikelyValue")) is 0, so the spec walk
    // spreads nothing — it must NOT fall back to the physical count of 3.
    const lines = await runLines(`
      var args = (function (x, y, z) { return arguments; })(1, 2, 3);
      args[Symbol.isConcatSpreadable] = true;
      args.length = "unlikelyValue";
      LOG("len=" + args.length + " concat=" + [].concat(args).length);
    `);
    expect(lines).toEqual(["len=unlikelyValue concat=0"]);
  });
});
