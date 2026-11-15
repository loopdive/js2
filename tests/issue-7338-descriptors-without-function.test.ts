// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7338 S3 (narrowed) + S4a — `Object` statics whose descriptor carries no
// function value: `get` / `set` spelled as `undefined`, a primitive or `null`
// (the native applier reads `undefined` as an empty half and throws for the
// rest), and a primitive descriptor, primitive map entry or nullish map, which
// throws the TypeError before anything is defined. A function value stays
// refused at select (S4b), and so does a descriptor the IR would hold as a
// closed struct.
import { afterAll, describe, expect, it, vi } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const previousShapeDiag = vi.hoisted(() => {
  const previous = process.env.JS2WASM_IR_SHAPE_DIAG;
  process.env.JS2WASM_IR_SHAPE_DIAG = "1";
  return previous;
});
afterAll(() => {
  if (previousShapeDiag === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_SHAPE_DIAG");
  else process.env.JS2WASM_IR_SHAPE_DIAG = previousShapeDiag;
});

type Verdict = "ok" | "threw" | "trap";

async function build(source: string, experimentalIR = true): Promise<CompileResult> {
  const result = await compile(source, {
    fileName: "issue-7338-s4a.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    experimentalIR,
    target: "standalone",
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function run(result: CompileResult): Promise<Verdict> {
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch (error) {
    return error instanceof WebAssembly.RuntimeError ? "trap" : "threw";
  }
}

function node(source: string): Verdict {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

function legacyUnits(result: CompileResult) {
  return (result.irOutcomes ?? []).filter((row) => !row.irBodyEmitted && row.kind !== "non-executable");
}

/** `r` is `'TE'` when `body` throws a TypeError. */
const typeError = (body: string) =>
  `var r; try { ${body}; r = 'no'; } catch (e) { r = e instanceof TypeError ? 'TE' : 'other'; } if (r !== 'TE') { throw 'x'; }`;

/** Each claims every unit and answers as node does. */
const CLAIMED: Record<string, string> = {
  "a boolean descriptor": typeError("Object.defineProperty({}, 'p', true)"),
  "a null descriptor": typeError("Object.defineProperty({}, 'p', null)"),
  "an undefined descriptor, nothing defined": `var obj = {}; ${typeError("Object.defineProperty(obj, 'p', undefined)")} if (Object.getOwnPropertyDescriptor(obj, 'p') !== undefined) { throw 'y'; }`,
  "a string descriptor": typeError("Object.defineProperty({}, 'p', 'abc')"),
  "a null map": typeError("Object.defineProperties({}, null)"),
  "a number map defines nothing": "var obj = {}; if (Object.defineProperties(obj, -12) !== obj) { throw 'x'; }",
  "a primitive entry throws before any define": `var obj = {}; ${typeError("Object.defineProperties(obj, { a: { value: 1 }, p: undefined })")} if (Object.getOwnPropertyDescriptor(obj, 'a') !== undefined) { throw 'y'; }`,
  "a null entry of create": typeError("Object.create({}, { p: null })"),
  "a null map of create": typeError("Object.create({}, null)"),
  "an undefined map of create is no map":
    "var o = Object.create({}, undefined); if (typeof o !== 'object') { throw 'x'; }",
  "an undefined setter":
    "var obj = {}; Object.defineProperty(obj, 'p', { set: undefined }); var d = Object.getOwnPropertyDescriptor(obj, 'p'); if (d.set !== undefined || d.hasOwnProperty('writable')) { throw 'x'; }",
  "a number getter": typeError("Object.defineProperty({}, 'p', { get: 12 })"),
  "a null getter": typeError("Object.defineProperty({}, 'p', { get: null })"),
  "a string setter": typeError("Object.defineProperty({}, 'p', { set: 'abc' })"),
  "a getter beside a value": typeError("Object.defineProperty({}, 'p', { get: undefined, value: 1 })"),
  "an undefined setter in a create map":
    "var o = Object.create({}, { p: { set: undefined } }); var d = Object.getOwnPropertyDescriptor(o, 'p'); if (d.set !== undefined || d.hasOwnProperty('value')) { throw 'x'; }",
  "an accessor redefining a non-configurable data property": `var obj = {}; Object.defineProperty(obj, 'p', { value: 1 }); ${typeError("Object.defineProperty(obj, 'p', { get: undefined })")}`,
};

/** Each stays refused at select with the stated detail, and answers as legacy does. */
const REFUSED: Record<string, { readonly source: string; readonly detail: string }> = {
  // A function value is S4b.
  "a function getter": {
    source:
      "var obj = {}; Object.defineProperty(obj, 'p', { get: function () { return 1; } }); if (obj.p !== 1) { throw 'x'; }",
    detail: "expr-object-static-descriptor",
  },
  "a getter named by a binding": {
    source:
      "function g() { return 1; } var obj = {}; Object.defineProperty(obj, 'p', { get: g }); if (obj.p !== 1) { throw 'x'; }",
    detail: "expr-object-static-descriptor",
  },
  // A descriptor the IR would hold as a closed struct is never handed to the applier raw.
  "a struct-typed descriptor": {
    source:
      "function t() { var d = { value: 3 }; var o = Object.defineProperty({}, 'p', d); return o.p; } if (t() !== 3) { throw 'x'; }",
    detail: "expr-object-static-descriptor",
  },
  // ToPropertyKey would run before the TypeError: a primitive descriptor throws only behind a literal key.
  "a primitive descriptor behind a computed key": {
    source: `var k = 'p'; ${typeError("Object.defineProperty({}, k, true)")}`,
    detail: "expr-object-static-descriptor",
  },
  // A string map has index keys, whose descriptors are its characters.
  "a string map": {
    source: typeError("Object.defineProperties({}, 'ab')"),
    detail: "expr-object-static-descriptor",
  },
};

describe("#7338 S3 + S4a — descriptors that carry no function value", () => {
  for (const [name, source] of Object.entries(CLAIMED)) {
    it(`claims whole and answers as node does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      expect(legacyUnits(ir), JSON.stringify(legacyUnits(ir))).toEqual([]);
      expect(node(source)).toBe("ok");
      expect(await run(ir)).toBe("ok");
    });
  }

  for (const [name, { source, detail }] of Object.entries(REFUSED)) {
    it(`refuses at select and answers as legacy does: ${name}`, async () => {
      const ir = await build(source);
      expect(ir.irPostClaimErrors ?? []).toEqual([]);
      const details = legacyUnits(ir).map((row) => `${row.stage}:${row.detail ?? ""}`);
      expect(
        details.some((d) => d.startsWith("select:") && d.includes(detail)),
        details.join("\n"),
      ).toBe(true);
      expect(await run(ir)).toBe(await run(await build(source, false)));
    });
  }
});
