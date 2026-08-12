import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
export function irRead(receiver) {
  return receiver.value;
}

export function getterProof() {
  var receiver = {};
  Object.defineProperty(receiver, "value", {
    get: function (unusedA, unusedB) {
      return arguments.length === 0 && unusedA === undefined && unusedB === undefined ? 42 : -1;
    }
  });
  return irRead(receiver);
}

export function setterProof() {
  var receiver = {};
  var seen = 0;
  var argc = 0;
  Object.defineProperty(receiver, "value", {
    set: function (value, unused) {
      seen = value;
      argc = arguments.length;
    }
  });
  receiver.value = 37;
  return seen === 37 && argc === 1 ? 1 : 0;
}

export function exactArityControl() {
  var receiver = {};
  var seen = 0;
  Object.defineProperty(receiver, "value", {
    get: function () { return seen; },
    set: function (value) { seen = value; }
  });
  receiver.value = 19;
  return receiver.value;
}
`;

describe("#4392 standalone property accessor under-application", () => {
  it("pads omitted accessor formals while preserving the real arguments.length", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-4392-accessor-underapplication.js",
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irCompiledFuncs ?? [], JSON.stringify(result.irOutcomes, null, 2)).toContain("irRead");

    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
    const exports = instance.exports as Record<string, () => number>;
    expect(exports.getterProof!()).toBe(42);
    expect(exports.setterProof!()).toBe(1);
    expect(exports.exactArityControl!()).toBe(19);
  });
});
