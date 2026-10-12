// #6946 regression follow-up (2026-10-12) — standalone `Object.keys` on a
// function-constructor ("fnctor") instance leaked the carrier struct's internal
// fields (`$constructor`, `$__fnctorProto`, `$bag`, `$presence_N`) and missed
// the own expando held in `$bag`. #6938 made `resolveStructName` answer the
// reserved `__fnctor_<Name>` struct for an approved standalone fnctor instance
// type, which sent `Object.keys/values/entries` and the literal-key
// `Object.getOwnPropertyDescriptor` fold into their closed-struct field
// expansion. That carrier is an open object, so those consumers now decline it
// and take the runtime own-key route they used before #6938.
//
// Real JS source through the public `compile()`; expected values are node's,
// written as literals.
import { describe, expect, it } from "vitest";
import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { buildImports, compile, instantiateWasm } from "../src/index.ts";

type Lane = "gc" | "standalone";

async function runLane(src: string, lane: Lane): Promise<string> {
  const result = await compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone", hostBridge: "always" } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const v = (instance.exports.main as () => unknown)();
    return v !== null && typeof v === "object" ? (tryNativeExnRender(instance, v) ?? "[wasm-object]") : String(v);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  return String((instance.exports.main as () => unknown)());
}

// `T` keeps every own property in its expando bag; `U` has a constructor field.
const PRELUDE = `function T() { }
T.prototype.v = null;
T.prototype.set = function (x) { this.v = x; };
function U(a) { this.a = a; }
U.prototype.m = function () { return 1; };
`;

interface Row {
  body: string;
  expected: string;
  /** Lanes asserted. gc is omitted where it has an unrelated pre-existing gap. */
  lanes: readonly Lane[];
}

const BOTH = ["gc", "standalone"] as const;

const ROWS: Record<string, Row> = {
  objectKeysOwnExpando: {
    body: `var t = new T(); t.set(5); return Object.keys(t).join("|");`,
    expected: "v",
    lanes: BOTH,
  },
  // negative: no own write → no own keys (the inherited `v`/`set` are not own)
  objectKeysNoOwnWrite: {
    body: `var t = new T(); return Object.keys(t).length + ":" + Object.keys(t).join("|");`,
    expected: "0:",
    lanes: BOTH,
  },
  objectValuesOwnExpando: {
    body: `var t = new T(); t.set(5); return Object.values(t).join("|");`,
    expected: "5",
    lanes: ["standalone"], // gc answers "" (pre-existing, unrelated)
  },
  objectEntriesOwnExpando: {
    body: `var t = new T(); t.set(5); return JSON.stringify(Object.entries(t));`,
    expected: '[["v",5]]',
    lanes: ["standalone"], // gc answers "[]" (pre-existing, unrelated)
  },
  forInOwnExpando: {
    body: `var t = new T(); t.set(5); var s = ""; for (var k in t) s += k + ";"; return s;`,
    expected: "v;set;",
    lanes: BOTH,
  },
  getOwnPropertyNamesOwnExpando: {
    body: `var t = new T(); t.set(5); return Object.getOwnPropertyNames(t).join("|");`,
    expected: "v",
    lanes: BOTH,
  },
  getOwnPropertyNamesNoOwnWrite: {
    body: `var t = new T(); return String(Object.getOwnPropertyNames(t).length);`,
    expected: "0",
    lanes: BOTH,
  },
  getOwnPropertyDescriptorOwnExpando: {
    body: `var t = new T(); t.set(5); var d = Object.getOwnPropertyDescriptor(t, "v"); return d ? d.value + "," + d.enumerable : "undef";`,
    expected: "5,true",
    lanes: BOTH,
  },
  hasOwnPropertyOwnExpando: {
    body: `var t = new T(); t.set(5); return t.hasOwnProperty("v") + "," + Object.keys(t).join("|");`,
    expected: "true,v",
    lanes: BOTH,
  },
  jsonStringifyDirectWrite: {
    body: `var t = new T(); var a = JSON.stringify(t); t.v = 5; return a + "|" + JSON.stringify(t);`,
    expected: '{}|{"v":5}',
    lanes: BOTH,
  },
  ctorFieldPlusExpandoKeys: {
    body: `var u = new U(3); u.b = 4; return Object.keys(u).join("|") + "/" + JSON.stringify(u);`,
    expected: 'a|b/{"a":3,"b":4}',
    lanes: BOTH,
  },
  ctorFieldValuesEntries: {
    body: `var u = new U(3); return Object.keys(u).join("|") + "/" + Object.values(u).join("|") + "/" + JSON.stringify(Object.entries(u));`,
    expected: 'a/3/[["a",3]]',
    lanes: BOTH,
  },
  ctorFieldDescriptor: {
    body: `var u = new U(3); var d = Object.getOwnPropertyDescriptor(u, "a"); return (d ? d.value + "," + d.writable : "undef") + "," + Object.getOwnPropertyDescriptor(u, "m");`,
    expected: "3,true,undefined",
    lanes: BOTH,
  },
};

describe("#6946 follow-up: fnctor carrier internals never surface as own keys", () => {
  for (const [name, row] of Object.entries(ROWS)) {
    for (const lane of row.lanes) {
      it(`${lane}: ${name}`, async () => {
        const src = `${PRELUDE}export function main() { ${row.body} }`;
        expect(await runLane(src, lane)).toBe(row.expected);
      });
    }
  }
});
