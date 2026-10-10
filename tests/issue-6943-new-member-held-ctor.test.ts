// #6943 — `new T.Node(k)` where `T.Node = function (k) {…}` (Octane splay's
// node constructor) compiled to `undefined`: no construct arm admitted a
// member callee holding an ordinary user function, and the terminal refusal's
// diagnostic was swallowed by the speculative rollback (clean `success: true`,
// `errors: []`). Real JS source through the public `compile()` on the gc host
// lane and the standalone lane, compared with node.
import { describe, expect, it } from "vitest";
import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { buildImports, compile, instantiateWasm } from "../src/index.ts";

type Lane = "gc" | "standalone";

function runNode(src: string): string {
  // Module code is strict; mirror it for the reference run.
  const main = new Function(`"use strict";\n${src.replace(/^export /gm, "")}\nreturn main;`)() as () => unknown;
  try {
    return String(main());
  } catch (e) {
    return `throw:${(e as Error).constructor.name}`;
  }
}

async function compileLane(src: string, lane: Lane) {
  return compile(src, {
    fileName: "case.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    // `hostBridge: "always"` exports the native-string renderer the harness reads results with.
    ...(lane === "standalone" ? { target: "standalone", hostBridge: "always" } : {}),
  });
}

async function runLane(src: string, lane: Lane): Promise<string> {
  const result = await compileLane(src, lane);
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  let main: () => unknown;
  let render = (v: unknown): string => String(v);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    main = instance.exports.main as () => unknown;
    render = (v) =>
      v !== null && typeof v === "object" ? (tryNativeExnRender(instance, v) ?? "[wasm-object]") : String(v);
  } else {
    const imports = buildImports(result.imports, {}, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setInstance?.(instance);
    main = instance.exports.main as () => unknown;
  }
  try {
    return render(main());
  } catch (e) {
    return `throw:${String(e)}`;
  }
}

const CASES: Record<string, string> = {
  // .tmp/sp6.js — function receiver (the splay shape)
  functionReceiver: `function T() { }
T.Node = function (k) { this.key = k; };
export function main() { var n = new T.Node(0.5); return n.key + "," + (n.key == 0.5); }`,
  // .tmp/sp5.js — object receiver
  objectReceiver: `var T = {};
T.Node = function (k) { this.key = k; };
export function main() { var n = new T.Node(0.5); return n.key + "," + (n.key == 0.5); }`,
  // .tmp/sp4.js — aliased identifier
  aliasedIdentifier: `function T() { }
T.Node = function (k) { this.key = k; };
var N = T.Node;
export function main() { var n = new N(0.5); return n.key + "," + (n.key == 0.5); }`,
  // .tmp/sp8.js — `new` inside a helper + element-access callee
  helperAndElementAccess: `var T = {};
T.Node = function (k) { this.key = k; };
function mk() { return new T.Node(0.5); }
export function main() { var n = mk(); var m = new T["Node"](0.25); return n.key + "," + m.key; }`,
  // object-literal property initializer + instanceof
  objectLiteralProperty: `var o = { F: function (k) { this.k = k; } };
export function main() { var x = new o.F(3); return x.k + "," + (x instanceof o.F); }`,
  // the member ctor's prototype reached through a binding (same identity)
  prototypeIdentity: `function T() {} T.Node = function (k) { this.key = k; };
export function main() { var p = T.Node.prototype; p.get = function () { return this.key; }; var n = new T.Node(7); return (Object.getPrototypeOf(n) === p) + "," + n.get(); }`,
};

// §13.3.5.1 step 5: IsConstructor(constructor) is false → TypeError. These
// member values are NOT admitted by the new arm and keep the throwing path.
const NEGATIVE: Record<string, string> = {
  arrowMember: `function T() {} T.Node = () => {};
export function main() { try { new T.Node(); } catch (e) { return e instanceof TypeError ? "TE" : "other"; } return "noerr"; }`,
  generatorMember: `var o = {}; o.m = function* () {};
export function main() { try { new o.m(); } catch (e) { return e instanceof TypeError ? "TE" : "other"; } return "noerr"; }`,
  methodMember: `var o = { m() {} };
export function main() { try { new o.m(); } catch (e) { return e instanceof TypeError ? "TE" : "other"; } return "noerr"; }`,
  builtinStatic: `export function main() { try { new Math.abs(); } catch (e) { return e instanceof TypeError ? "TE" : "other"; } return "noerr"; }`,
};

describe("#6943 new <obj>.<prop>(…) with a member-held user function", () => {
  for (const lane of ["gc", "standalone"] as const) {
    for (const [name, src] of Object.entries(CASES)) {
      it(`${lane}: ${name} matches node`, async () => {
        expect(await runLane(src, lane)).toBe(runNode(src));
      });
    }
    for (const [name, src] of Object.entries(NEGATIVE)) {
      it(`${lane}: ${name} still throws TypeError`, async () => {
        expect(runNode(src)).toBe("TE");
        expect(await runLane(src, lane)).toBe("TE");
      });
    }
  }

  it("the admitted site emits no refusal diagnostic", async () => {
    for (const lane of ["gc", "standalone"] as const) {
      const result = await compileLane(CASES.functionReceiver!, lane);
      expect(result.errors.filter((e) => /Unsupported new expression/.test(e.message))).toEqual([]);
    }
  });

  it("a refused `new` is no longer silent: the terminal refusal survives the speculative rollback", async () => {
    // test262 language/statements/function/S13.2.2_A15_T3.js shape: a var
    // assigned a function AFTER its declaration, constructed at top level,
    // still reaches the terminal refusal on the host lane (a separate gap —
    // gc answers "undefined" where node answers "object"); this pins that the
    // refusal is now reported instead of vanishing.
    const src = `var __FACTORY, __obj;
__FACTORY = function () { this.prop = 1; var obj = {}; obj.prop = "A"; obj.slot = this; return obj; };
__obj = new __FACTORY();
export function main() { return typeof __obj; }`;
    const result = await compileLane(src, "gc");
    const refusals = result.errors.filter((e) => /Unsupported new expression/.test(e.message));
    expect(refusals.length).toBeGreaterThan(0);
    // Non-fatal by design (see the terminal `reportError` in new-super.ts):
    // a compile failure there regressed passing test262 rows.
    expect(result.success).toBe(true);
  });
});
