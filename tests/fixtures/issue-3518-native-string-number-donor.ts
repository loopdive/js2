// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

// Complete original module, not generated expectations from the new builders.
// Byte-identical at 5118637e0e9b34291465230428447e511958faa1 and the worker base.
// Keeping the source here makes receipts independent of shallow CI Git history.
export const SCANNER_DONOR_SHA256 = "8111e30ecf474d9da7a9728741b38a4a2166ddf24f68ed1cbe2974d33c99b12d";
const compressed = [
  "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",
  "tyE4z/rIopcBM68yFWpyV53qKWbKNBCGlXCu23GNy+DCQW+czaboO+zOV9Q0/OJutpgP8XfXYe748LouTWqHF7vNkv6x7/50l+4t",
  "N5M57FxMe35z5368WG7NDSoZkZ6t9U79p/K3uHxuL8VxtKijqztoIQlWWyKSlS1K8VRmr+KKLbhRMeY4vY1y2K6sp7vpeSxeZump",
  "KqpOdtTU3+YlRmqA9QeZP1AoPQPaVSxfehjUmbnPa5O8S/+TuSErnK46jFA+HOHJLGsxxw8wxxNQyBewEG9AIX9UDTpnDcsHnrOO",
  "UGct5zpSLfTm1hTuLvJk4DVYY2ZdKTIPbxcTJ5J/38U/Nw4vDlpcmLWEqo7/322J7dLKXJ2a2a9lboe/Eh3l16KCWE9X9VX48AGs",
  "Z6tbqwtrWwvKCwpgKGuRORo/QRcoYKJ0uku7kHFlLLEcikFp1+SRos5mjjnLtKzZZObySEuKf30yTwmVFmfoWBjeKTZYg+Lzn8IW",
  "6z6mYFQeqvqwq69twVPofbu53pJfnSfIvcroDEC/yDVzXbh2EHwhLDkydB6jK9DyiCingIW++541NTg1MRQ6S5Ncp+YUm6SEAXqX",
  "0Zx0ur/Hw2SxYjz+y1mE4czz5KYu3nVoQZHCNGAhC97zgIHL2WQqY4uzlrGcdYgtWjzSe6XbW994tPn4yZae/LYiJvHP3Sc43XL8",
  "a0g3Z0t5YcRMG+16atAvTiZGRM+mcegzx1cswOjpm2WWL+eVny09++OVNncjxfmr1PgZTutOh/gA/QScdWENGlZ7VV9t5tRefNLK",
  "J66bN1GZJpOZW+eAr5ZVsJTIzLQKZ5flvcEuo+HQsy+c9V6ugMvUXk6DKZruOSWmSDkFvvrShpyWFz/++38kdu61PnQXVfSE+fpz",
  "UfeKu1Ol9C13yyizMC0wi5/VledT2QVir8xvJoHyFeaBqp+VQaDTAdN+bxKEE51Qq9rqL5m/8w/g7H1p8cmDwttN/meh5D613NfL",
  "ewDL3durmuXetzINS+5dmZrVCr/8KbiH1elygd4AFRuzWHeAUvHzE3Qt/xqW07LgOpZTM/dalqlXf7VUv3/V9ayF15uphClmr2kK",
  "ReX+oF7Tmhq8Ti5ZljndnlN/i2ly1QgvGLGDf20NGkOHjNoiQsF23js2C/GK1NW/tSgKIHv3UGieStc9XdsyEQp46ZL6GUIk3zuh",
  "Q5jc4ZBZ2VuWQlRE3ks4aAzWRAgp9YjZRV1aTsNXWi57PcohU3BNimsWlJddm+TP4sITSq9Rmd4vMX1QOoWFF6WcpsUXpjq9LJEy",
  "cCchmGldfJHKGVKNC1VOq+K7Qu5E1LxgFbTORh3EwUhLTmeJwIQ6qk/dYdbqaM6lUv6Iy2VhjSXOrJKhL3y9ym24sHazVCer12Zh",
  "D0WqWek1TP7krssn932gx11GXEoMw7F5XOPallrEQu/7vd3aih2ax+axglzhY0DkSuE1NjaXzF1jl49JwVDEvNlYLgBHRmjGlYUX",
  "al/0vMwBtf/mtJWQyLqiWhRcmHJISZWOx85iBDB6/XnCCXiIulGN8MlWQi/JdZPk+5jPfDGZuZEzdW87XA2DRshYQgMHO5hO3VuR",
  "emv/ZhrrZmIuMn/mYX/S/8YPhZYqNVuJdSlvmng4aYsHf7biqNf86MHMVhABstmljVmRl8uIyExyLBGvyOOzW/GGEdB3NYhb/EUE",
  "wcl/8gBbVdn5XjbGwDwRNVcMllei/j+q+y6mghGYdaikYkVzKbnMiwlhwHZeHaeyhlVZAxk4roQembxKyN7zw3IIZZBPVYjJys/H",
  "MduVfRD7qpIiu5lW1uHbt/KT8ZatJBjV+erUv678pJAX+bRiMY02D/k7x9IwO52Ioxmn1MjDcxB8qATNQX+XWA4UIKeiNBsw3EpF",
  "l2Y8+UVd4KiayL/gMexFPZmrpnYIgTZ+ghNasE8fHzwoTY/XyAUkNRPs+LGAkYnqIsrVyOZHzM+npgEyshnNOADMmEfKGBrsOZgj",
  "MuSOzRRCLc4X0eSJ9gLGAFM6UQJIgLZA/J4fvNyHKKBsThK8ToncMMUanrGOjf06nk1Y4FgiX2OLNF+u1fCUWg0FKo2weBneyxM+",
  "ThC3gJR5nkecXt4HE0Fd0+gWOmC6blsJMhVdwQx+mFZMTS757/+BX06IGPqN0TH0N0YLDN3HX0/o10v89bkhPspCCJnLLEw+eNPx",
  "rch0O5eOZwa30uoixyLSdIWprzojzw/4sCZxYtbBdBr4JgLNJEQfO4ezKeNm16LAdNxMAC1W4jAjnhwJZ6DFE72KkBkCFWKazTbv",
  "PKUzCnnaT57z0ySdAg0cwv8sk4sJeF/Avps5IgsXTxLqS8gHlV2Pffy8WHjyx2fTCszvnzqZBdR9lSpT9peCTo4xeT8zpG1JyNl9",
  "As7m4GZZ0ZbBnHU6HGMWokqtYMweKGC0bQEzE6AyWMdsKwTtEjiyGD+mwMcS9BgnJX8ySLKtBErF4WFFMLI0lTlMGTE6b7KBtj/R",
  "JA9clgcti5FWx3sSWDYHK5sDleVByvIAZTlwMhVyRbmJOOQBkWTJhLQWxZM9KAaT5UHJCoBkcfFg7+CNyHqkzNrBlxzc9WBZwFku",
  "3OzRgnCzLNhs857AZhmo2eNiqFkO0OzJXYBmYjrXHz3Wm5xGF5zhkI63m6nrWE4Eq2urndX2Kr8KYnIXTMMdT4sGA07l2PfEDeyA",
  "d0OmSG7oNx3d7+iXlO7p4PjrweHBHkVNETZc4jSQvOhPkpuEwo6kFrK6pt909dWm0YlL2qIkPvmPzWOek9V37QciYguTPo9mZmDD",
  "FbvFxKceGPi1fr9rCMA1mDalAMdZWl1b5Un4GpgmmhKBPIiDyfpr3eYOT/Y4dE10HFAK75kTjlkIK5gREZV4kX04nsO1FS29J+U+",
  "2VIzp+VC/coumyowrJatTFRaCORXZpwQdud3O6lBjM1gQFlMHPuGhhPGw8pL61F3hAj7kASXHc47Zb7zgYh1YYiO/KeP6a2YZ6vI",
  "sYpxfR7piCpMzAoCr9RmPl9vKQhkWV/q8vkd+9Kt0xfcSwrk8VP3KcsqtfZ31ohdal883hMjyvKw3A5oJ1WvBnmQOmmqygm9qGPa",
  "zQY5qF7C/JCKur7AvPCJhdwKZZX53OVVLwyQqOlozw2GKMe9FdrdF/rwMnNTx9FS4V5ZyKlS7UpRHB9Z65J0AaiMnXfXbYTjwPGu",
  "aFdcjx1Kqm0/c+iGiyfAW+bZ7e47uA6bv75dUMzYCzOGu9guEILoad8hawMmcM7bGKRiNN5Wj6GCR+ed2+/yt1V5hgOld59ih+Kk",
  "YNrw6zB/UpaXUQts2zzff/XB8sk2Lje/iZQ1uIubNDd6shkXODCrZq5Iqqc2vOLQrLMvK52ZeokrMzMZ+SjdYtK1NB3V7Zg6j2pF",
  "opTFnKRAsvnRsPcws4r3oWge0gDYupOxwB6qCH0ooFotZBf7fN6pW/PEjTdkFo9QOxypjBGyANniyOi5szATKVb3JMyLBltcHtZd",
  "z4XWdLmu3INGVV/oxnb+hjS40CMo7i2syD+tyMfDmGcnmlEGOruPrWTkwv7xnhq5UIaaFd3gNh3hYdBvoAO6j/+5hIbvubfC+4Pv",
  "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",
  "DQEA",
].join("");
export function scannerDonorSource(): string {
  const source = gunzipSync(Buffer.from(compressed, "base64")).toString("utf8");
  if (createHash("sha256").update(source).digest("hex") !== SCANNER_DONOR_SHA256)
    throw new Error("stale complete scanner donor");
  return source;
}

export const scannerCases = [
  ["large-number", "3000000000", 3e9],
  ["negative-zero", "-0", -0],
  ["nan", "garbage", NaN],
  ["positive-infinity", "Infinity", Infinity],
  ["negative-infinity", "-Infinity", -Infinity],
  ["empty", "", 0],
  ["whitespace", "\t\u00a0\u2000 42 \u2028\ufeff", 42],
  ["fraction", "0.3", 0.3],
  ["exponent", "-125e-2", -1.25],
  ["hex", "0x2a", 42],
  ["octal", "0o52", 42],
  ["binary", "0b101010", 42],
  ["signed-hex", "+0x2a", NaN],
  ["negative-hex", "-0x2a", NaN],
  ["signed-octal", "+0o52", NaN],
  ["signed-binary", "-0b101010", NaN],
  ["power-boundary", "1e308", 1e308],
  ["power-overflow", "1e309", Infinity],
  ["power-tail", "1e-320", 1e-320],
  ["smallest-subnormal", "5e-324", Number.MIN_VALUE],
] as const;

// Original measured debt denominator retained. The two missing-exponent rows
// now require semantic acceptance; the precision row remains an explicit debt
// observation, not a claim that this scanner is a correctly rounded strtod.
export const scannerSemanticDebtCases = [
  ["missing-exponent", "1e", NaN],
  ["missing-positive-exponent", "1e+", NaN],
  ["precision", "12345678901234567e-100", Number("12345678901234567e-100")],
] as const;

export const scannerExponentRepairCases = [
  ["missing-negative-exponent", "1e-", NaN],
  ["missing-uppercase-exponent", "1E", NaN],
  ["missing-uppercase-positive-exponent", "1E+", NaN],
  ["missing-uppercase-negative-exponent", "1E-", NaN],
  ["trimmed-missing-exponent", " \t1e\u00a0", NaN],
  ["trimmed-missing-positive-exponent", " \t1e+\u00a0", NaN],
  ["trailing-dot", "1.", 1],
  ["dot-zero-exponent", "1.e0", 1],
  ["zero-exponent", "1e0", 1],
  ["positive-zero-exponent", "1e+0", 1],
  ["negative-zero-exponent", "1e-0", 1],
  ["two-zero-exponent", "1e00", 1],
  ["negative-zero-exponent-value", "-0e0", -0],
  ["hex-exponent-digit", "0x1e", 30],
  ["empty-whitespace", " \t\u00a0", 0],
  ["valid-uppercase-exponent", "1E+0", 1],
] as const;

import { createEmptyModule } from "../../src/ir/types.js";
import type { Instr } from "../../src/wasm/model/instructions.js";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
  requireCompletedNativeStringNumber,
} from "../../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../../src/backend/wasmgc/resources/native-values.js";
import { emitBinary } from "../../src/emit/binary.js";
import { emitWat } from "../../src/emit/wat.js";

export function numberReceipt(value: number): string {
  return Number.isNaN(value) ? "NaN" : Object.is(value, -0) ? "-0" : String(value);
}

/** Actual canonical resource execution. The passed program must come from the
 * real source producer or its authenticated prepared codec, never a raw carrier. */
export function executeScannerResourceFixture(program: PreparedIrProgram) {
  const plan = deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string");
  const mod = createEmptyModule(),
    tx = new PhysicalModuleReservations(mod);
  const cases = [...scannerCases, ...scannerSemanticDebtCases, ...scannerExponentRepairCases];
  const recipes = cases.flatMap(([name, text, expected]) =>
    (["wtf16", "utf8-guaranteed"] as const).flatMap((encoding) =>
      (["flat", "offset"] as const).map((view) => ({
        name,
        text,
        expected,
        encoding,
        view,
        exportName: name + "__" + encoding + "__" + view,
      })),
    ),
  );
  const literals = [
    { value: "", encoding: "wtf16" as const },
    ...recipes.map(({ text, encoding, view }) => ({ value: view === "offset" ? "xx" + text + "yy" : text, encoding })),
    { value: "xx3000000000yy", encoding: "wtf16" as const },
    { value: " ", encoding: "wtf16" as const },
    { value: "42", encoding: "wtf16" as const },
    { value: "\u00a0\u200042", encoding: "utf8-guaranteed" as const },
  ];
  const strings = reserveNativeStringLiteralResources(tx, { key: "execution:strings", utf8Storage: true, literals });
  const flatten = reserveNativeStringFlattenResources(tx, "execution:flatten", strings);
  const scanner = reserveNativeStringNumberResources(tx, plan, flatten);
  const dependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, plan, dependencies);
  const scalar = { params: [], results: [{ kind: "f64" as const }] };
  const functions = recipes.map(({ exportName }) => tx.reserveFunction("execution:" + exportName, exportName, scalar));
  const offset = tx.reserveFunction("execution:offset", "offset", scalar);
  const rope = tx.reserveGlobal(
    "execution:rope",
    "rope",
    { kind: "ref", typeIdx: strings.layout.consStrTypeIdx },
    false,
  );
  const ropeValue = tx.reserveFunction("execution:rope-value", "ropeValue", scalar);
  const memo = tx.reserveFunction("execution:memo", "memo", { params: [], results: [{ kind: "i32" }] });
  const utf8 = tx.reserveFunction("execution:utf8", "utf8", scalar);
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  fillNativeStringNumberResources(tx, scanner);
  requireCompletedNativeStringNumber(tx, scanner, plan, strings);
  fillNativeValueResources(tx, values, dependencies);
  const literal = (index: number): Instr[] => {
    const binding = strings.literals[index]!;
    return binding.kind === "global"
      ? [{ op: "global.get", index: tx.physicalIndex(binding.global) }]
      : [{ op: "call", funcIdx: binding.function.handle }];
  };
  const unbox: Instr[] = [{ op: "extern.convert_any" }, { op: "call", funcIdx: values.functions.unboxNumber.handle }];
  const layout = strings.layout;
  functions.forEach((token, i) => {
    const recipe = recipes[i]!;
    let input = literal(i + 1);
    if (recipe.view === "offset") {
      input =
        recipe.encoding === "wtf16"
          ? [
              { op: "i32.const", value: recipe.text.length },
              { op: "i32.const", value: 2 },
              ...input,
              { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
              { op: "struct.new", typeIdx: layout.nativeStrTypeIdx },
            ]
          : [
              { op: "i32.const", value: recipe.text.length },
              { op: "i32.const", value: new TextEncoder().encode(recipe.text).length },
              { op: "i32.const", value: 2 },
              ...input,
              { op: "struct.get", typeIdx: layout.utf8StrTypeIdx, fieldIdx: 3 },
              { op: "struct.new", typeIdx: layout.utf8StrTypeIdx },
            ];
    }
    tx.fillFunction(token, { locals: [], body: [...input, ...unbox] });
  });
  const extra = 1 + recipes.length;
  tx.fillFunction(offset, {
    locals: [],
    body: [
      { op: "i32.const", value: 10 },
      { op: "i32.const", value: 2 },
      ...literal(extra),
      { op: "struct.get", typeIdx: layout.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "struct.new", typeIdx: layout.nativeStrTypeIdx },
      ...unbox,
    ],
  });
  // Forty NONEMPTY pending right children: a left-leaning rope forces the
  // actual capacity16 worklist grow/copy path rather than the x+"" shortcut.
  let ropeInit: Instr[] = literal(extra + 2);
  for (let depth = 1; depth <= 40; depth++)
    ropeInit = [
      { op: "i32.const", value: 2 + depth },
      ...ropeInit,
      ...literal(extra + 1),
      { op: "struct.new", typeIdx: layout.consStrTypeIdx },
    ];
  tx.fillGlobal(rope, ropeInit);
  const getRope: Instr = { op: "global.get", index: tx.physicalIndex(rope) };
  tx.fillFunction(ropeValue, { locals: [], body: [getRope, ...unbox] });
  tx.fillFunction(memo, {
    locals: [],
    body: [
      getRope,
      { op: "call", funcIdx: flatten.flatten.handle },
      getRope,
      { op: "call", funcIdx: flatten.flatten.handle },
      { op: "ref.eq" },
    ],
  });
  tx.fillFunction(utf8, { locals: [], body: [...literal(extra + 3), ...unbox] });
  for (const token of [...functions, offset, ropeValue, memo, utf8])
    tx.defineExport("export:" + token.object.name, token.object.name, token);
  const census = tx.seal();
  const binary = emitBinary(mod),
    wat = emitWat(mod);
  const compiled = new WebAssembly.Module(binary as BufferSource);
  const imports = WebAssembly.Module.imports(compiled),
    exports = WebAssembly.Module.exports(compiled);
  if (imports.length) throw Error("scanner execution has imports");
  // Both instances receive this exact binary; no second emission or byte-length surrogate.
  const observations = [];
  for (let instance = 0; instance < 2; instance++) {
    const x = new WebAssembly.Instance(compiled, {}).exports as Record<string, () => number>;
    const rows = recipes.map(({ name, text, expected, encoding, view, exportName }) => {
      const values = [x[exportName]!(), x[exportName]!()];
      return {
        name,
        text,
        encoding,
        view,
        exportName,
        offset: view === "offset" ? 2 : 0,
        expected: numberReceipt(expected),
        values: values.map(numberReceipt),
        semanticOK: values.every((v) => Object.is(v, expected)),
      };
    });
    const extras = ["offset", "ropeValue", "memo", "utf8"].map((name) => ({ name, values: [x[name]!(), x[name]!()] }));
    observations.push({ rows, extras });
  }
  return {
    programOwners: plan.owners,
    strings: plan.strings,
    bytes: Buffer.from(binary).toString("base64"),
    instantiatedBytes: Buffer.from(binary).toString("base64"),
    wat,
    imports,
    exports,
    census,
    resources: {
      types: mod.types,
      globals: mod.globals.map((g) => ({ name: g.name, type: g.type, mutable: g.mutable })),
      functions: mod.functions.map((f) => ({ name: f.name, typeIdx: f.typeIdx })),
      utf8Decoder: flatten.utf8Decoder?.object.name,
      pendingRightChildren: 40,
      recipeCount: recipes.length,
    },
    observations,
    preservationAssessed: false,
    wholeProgramExecutionAssessed: false,
  };
}
