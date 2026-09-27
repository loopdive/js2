import { expect, it } from "vitest";
import { compile } from "../src/index.js";

const source = `
let calls = 0;
let evaluations = 0;
function fresh() { evaluations++; return [9]; }
export function freshIdentity() { return Object.getPrototypeOf(fresh()) === Array.prototype ? 1 : 0; }
export function literalIdentity() { return Object.getPrototypeOf([evaluations++]) === Array.prototype ? 1 : 0; }
export function evaluationCount() { return evaluations; }
const proxy = new Proxy({}, { getPrototypeOf() { calls++; throw new TypeError('observed'); } });
const direct = [1], inherited = [2], middle = [3];
const fixed = [4], ordinary = [5], a = [6], b = [7];
const old = {}, other = {};
const revoked = Proxy.revocable({}, {});
export function install() {
  Object.setPrototypeOf(direct, proxy);
  Object.setPrototypeOf(middle, proxy);
  Object.setPrototypeOf(inherited, middle);
  return 1;
}
export function directIdentity() { return Object.getPrototypeOf(direct) === proxy ? 1 : 0; }
export function middleIdentity() { return Object.getPrototypeOf(middle) === proxy ? 1 : 0; }
export function inheritedIdentity() { return Object.getPrototypeOf(inherited) === middle ? 1 : 0; }
export function observe() { Object.getPrototypeOf(proxy); }
export function count() { return calls; }
export function nullSetup() {
  Object.setPrototypeOf(ordinary, null);
  return Object.getPrototypeOf(ordinary) === null ? 1 : 0;
}
export function ordinarySetup() {
  Object.setPrototypeOf(ordinary, old);
  Object.setPrototypeOf(a, old);
  Object.setPrototypeOf(b, a);
  Object.setPrototypeOf(fixed, old);
  Object.preventExtensions(fixed);
  return Object.getPrototypeOf(ordinary) === old ? 1 : 0;
}
export function selfCycle() { Object.setPrototypeOf(a, a); }
export function indirectCycle() { Object.setPrototypeOf(a, b); }
export function cycleUnchanged() { return Object.getPrototypeOf(a) === old && Object.getPrototypeOf(b) === a ? 1 : 0; }
export function same() { Object.setPrototypeOf(fixed, old); return 1; }
export function different() { Object.setPrototypeOf(fixed, other); }
export function toNull() { Object.setPrototypeOf(fixed, null); }
export function toProxy() { Object.setPrototypeOf(fixed, proxy); }
export function fixedUnchanged() { return Object.getPrototypeOf(fixed) === old ? 1 : 0; }
export function installRevoked() {
  revoked.revoke();
  const arr = [8];
  Object.setPrototypeOf(arr, revoked.proxy);
  return Object.getPrototypeOf(arr) === revoked.proxy ? 1 : 0;
}
export function observeRevoked() { Object.getPrototypeOf(revoked.proxy); }
`;

it.each([false, 2] as const)("preserves vec cycle semantics with optimize=%s", async (optimize) => {
  const result = await compile(source, {
    target: "standalone",
    fileName: "vec-proxy-cycle.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    optimize,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const run = instance.exports as Record<string, Function>;
  expect.soft(run.freshIdentity(), "fresh default identity").toBe(1);
  expect.soft(run.evaluationCount(), "call receiver evaluated once").toBe(1);
  expect.soft(run.literalIdentity(), "literal default identity").toBe(1);
  expect.soft(run.evaluationCount(), "literal receiver evaluated once").toBe(2);
  expect(run.install()).toBe(1);
  expect.soft(run.count(), "installation must not invoke the trap").toBe(0);
  expect.soft(run.directIdentity(), "direct Proxy identity").toBe(1);
  expect.soft(run.middleIdentity(), "middle Proxy identity").toBe(1);
  expect.soft(run.inheritedIdentity(), "ordinary link identity").toBe(1);
  expect.soft(() => run.observe(), "explicit Proxy query still throws").toThrow();
  expect.soft(run.count(), "explicit Proxy query invokes trap once").toBe(1);
  expect.soft(run.nullSetup(), "ordinary null prototype").toBe(1);
  expect.soft(run.ordinarySetup(), "ordinary replacement prototype").toBe(1);
  expect.soft(run.fixedUnchanged(), "nonextensible initial prototype").toBe(1);
  expect.soft(() => run.selfCycle(), "direct cycle").toThrow();
  expect.soft(run.cycleUnchanged(), "direct cycle unchanged").toBe(1);
  expect.soft(() => run.indirectCycle(), "indirect cycle").toThrow();
  expect.soft(run.cycleUnchanged(), "indirect cycle unchanged").toBe(1);
  expect.soft(run.same(), "nonextensible same prototype").toBe(1);
  expect.soft(run.fixedUnchanged(), "nonextensible same prototype unchanged").toBe(1);
  for (const name of ["different", "toNull", "toProxy"]) {
    expect.soft(() => run[name](), name).toThrow();
    expect.soft(run.fixedUnchanged(), `${name} unchanged`).toBe(1);
  }
  expect.soft(run.count(), "nonextensible refusal does not consult Proxy").toBe(1);
  expect.soft(run.installRevoked(), "revoked Proxy identity").toBe(1);
  expect.soft(() => run.observeRevoked(), "explicit revoked query still throws").toThrow();
});

it("preserves the gc/native-first policy refusal without requiring a vec store", async () => {
  const result = await compile(
    "export function run() { const a = [1]; return Object.getPrototypeOf(a) === Array.prototype ? 1 : 0; }",
    {
      target: "gc",
      semanticProviders: "native-first",
      fileName: "vec-proxy-gc.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
    },
  );
  // The untouched base rejects this intrinsic's host import in this profile.
  // Preserve that policy refusal, not a new missing-vec-store compiler error.
  expect(result.success).toBe(false);
  expect(result.errors.map((error) => error.message)).toEqual([
    "Native-first semantic-provider policy rejected implicit or unclassified host imports: env::__get_builtin (unknown, owner #4401). Use the host-assisted compatibility profile for this source until its native provider is implemented.",
  ]);
});
