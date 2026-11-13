// #6882 (S3-l of #5385) — the half of #6748 the measured rows did not need.
//
// A native-regime module in a JavaScript environment owns BOTH the JS value
// boundary (`__boundary_object_*`, for host objects this instance admitted) and
// the wasm peer terminals (`__js2wasm_link_*`, for structs a linked provider
// minted). Several arms still picked ONE of them with `boundary ?? peer`,
// written when the two were mutually exclusive, so a provider value read from
// the consumer was answered by the boundary alone — which never owns it:
//
//   - `typeof NS.Clock` (a provider class) answered "object";
//   - `Object.keys` / `for…in` over a provider object answered nothing.
//
// And one question had no peer terminal at all, on either lane: `key in
// <provider value>` answered false under plain standalone too, and since the
// `for…in` loop re-checks each key with `__extern_has` (#2066), enumeration
// dropped every key even where `Object.keys` worked. The provider now exports
// `__js2wasm_link_has`, and every site asks peer, then boundary, then (for a
// regime provider) its reverse hop.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compile, compileProject, instantiateLinkedProject } from "../src/index.js";

const PROVIDER = `
class Clock {
  constructor(h) { this._h = h; }
  get hour() { return this._h; }
}
function twice(x) { return x * 2; }
const bag = { a: 1, b: 2 };
export const NS = { Clock, twice, bag };
export function probe() { return 0; }
`;

// Every probe returns a number: strings would cross the export boundary as
// native strings, which is not the question here.
const CONSUMER = `import { NS } from "peer6882";
export function hasPresent() { return ("a" in NS.bag) ? 1 : 0; }
export function hasAbsent() { return ("z" in NS.bag) ? 1 : 0; }
export function hasOnNamespace() { return ("twice" in NS) ? 1 : 0; }
export function hasOnInstance() { const c = new NS.Clock(3); return ("_h" in c ? 1 : 0) + ("hour" in c ? 10 : 0) + ("nope" in c ? 100 : 0); }
export function keys() { const k = Object.keys(NS.bag); return k.length * 100 + (k[0] === "a" ? 10 : 0) + (k[1] === "b" ? 1 : 0); }
export function forIn() { let s = ""; let n = 0; for (const k in NS.bag) { s += k; n++; } return n * 10 + (s === "ab" ? 1 : 0); }
export function callValue() { const f = NS.twice; return f(21); }
export function callApply() { return NS.twice.apply(null, [5]); }
export function callCall() { return NS.twice.call(null, 6); }
export function typeofFunction() { return typeof NS.twice === "function" ? 1 : 0; }
export function typeofClass() { return typeof NS.Clock === "function" ? 1 : 0; }
export function typeofObject() { return typeof NS.bag === "object" ? 1 : 0; }
export function typeofLocal() { const f = NS.twice; return typeof f === "function" ? 1 : 0; }
`;

const EXPECTED = {
  hasPresent: 1,
  hasAbsent: 0,
  hasOnNamespace: 1,
  hasOnInstance: 11,
  keys: 211,
  forIn: 21,
  callValue: 42,
  callApply: 10,
  callCall: 12,
  typeofFunction: 1,
  typeofClass: 1,
  typeofObject: 1,
  typeofLocal: 1,
};

async function runLinked(options: Record<string, unknown>): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6882-"));
  const packageRoot = join(root, "node_modules", "peer6882");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "peer6882", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "main.js");
  writeFileSync(entry, CONSUMER);
  const result = await compileProject(entry, {
    ...options,
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
  } as never);
  expect(result.success).toBe(true);
  // Load-bearing: a `bundled` plan inlines the provider, and nothing crosses.
  expect(result.linkPlan?.mode).toBe("separate");
  const { instance } = await instantiateLinkedProject(result);
  const exports = instance.exports as unknown as Record<string, () => unknown>;
  const answers: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      answers[name] = exports[name]!();
    } catch (error) {
      answers[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return answers;
}

describe('#6882 — typeof a Symbol is never "object" in a module with a callable-kind terminal', () => {
  // The `__typeof_object` finalize appended its `$Symbol` exclusion AFTER the
  // boundary/peer callable-kind arm, which returns unconditionally — so in any
  // regime module that registered `__boundary_object_callable_kind` (a dynamic
  // call of an unknown value is enough) a Symbol answered "object". The
  // Temporal polyfill's IsObject (`"object"==typeof e`) then accepted a
  // Symbol-valued `options` argument instead of throwing the TypeError (ten
  // `PlainTime/**/options-{wrong-type,invalid}.js` rows).
  it("answers the IsObject reduction correctly on the regime", { timeout: 120_000 }, async () => {
    const source = `function callIt(f) { return f(1); }
function isObj(v) { return ("object" == typeof v && v !== null) || "function" == typeof v ? 1 : 0; }
export function run() { return isObj(Symbol()) * 100 + callIt((x) => 10); }
`;
    const result = await compile(source, {
      semanticProviders: "native-first",
      hostBridge: "always",
      allowJs: true,
      fileName: "probe.js",
    } as never);
    expect(result.success).toBe(true);
    const imports = result.importObject as WebAssembly.Imports & {
      __setInstance?: (instance: WebAssembly.Instance) => void;
    };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    // Base: 110 — `isObj(Symbol())` answered 1.
    expect((instance.exports as { run: () => number }).run()).toBe(10);
  });
});

describe("#6882 — a consumer reads a linked provider's values through the peer terminals", () => {
  it("native regime in a JS environment: in, for…in, Object.keys, calls and typeof", { timeout: 300_000 }, async () => {
    // Base: hasPresent/hasOnNamespace 0, hasOnInstance 0, keys 0, forIn 0,
    // typeofClass 0 ("object").
    expect(await runLinked({ semanticProviders: "native-first", hostBridge: "always" })).toEqual(EXPECTED);
  });

  it("plain standalone: the same answers (the `in` terminal is new on both lanes)", { timeout: 300_000 }, async () => {
    // Base: hasPresent/hasOnNamespace/hasOnInstance 0 and forIn 0 — the
    // for…in loop's per-key `__extern_has` re-check dropped every key.
    expect(await runLinked({ target: "standalone" })).toEqual(EXPECTED);
  });
});
