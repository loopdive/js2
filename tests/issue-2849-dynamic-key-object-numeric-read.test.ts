// #2849 — a dynamic-object numeric property reads back 0 when the object is
// BOTH populated by a computed/dynamic-key write (`for (k in d) o[k] = opts[k]`)
// AND widened to a closed WasmGC struct by a sibling STATIC dot-write
// (`o.ecmaVersion = <number>`).
//
// Root cause: the non-literal computed-key write lowers to the dynamic
// `__extern_set` SIDECAR (the key can't be resolved to a struct field), but the
// static dot-write triggered `collectEmptyObjectWidening` to give `o` a closed
// struct, so the dot-read `o.ecmaVersion` lowered to an unguarded `struct.get`
// that MISSED the sidecar value and returned the field default (0). The demotion
// guard that keeps such objects open (`markObjectHashConsumers`) was
// standalone-gated, and the host "live-mirror Proxy" does NOT cover a
// dynamic-key write — so host mode mis-read.
//
// Fix (declarations.ts): a NON-LITERAL computed-key write suppresses empty-object
// widening in ALL modes, so the receiver stays a `$Object` and both the dynamic
// write and the dot reads route through the same (guarded / sidecar)
// representation. This mirrors compiled acorn's `getOptions` ecmaVersion
// normalisation (`2022 -> 13`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, target?: "standalone"): Promise<(ev: number) => number> {
  const result: any = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return instance.exports.run as (ev: number) => number;
}

// The acorn-shaped normalisation body: an equality guard (`=== "latest"` /
// `== null`) reads the property, its then-body reassigns a NUMBER, and the
// numeric `>= 2015` branch does the actual normalisation.
const ACORN_SHAPE = `// @ts-nocheck
var d = { ecmaVersion: null, sourceType: 0 };
export function run(ev) {
  var opts = { ecmaVersion: ev, sourceType: 1 };
  var o = {};
  for (var k in d) { o[k] = opts[k]; }
  if (o.ecmaVersion === "latest") { o.ecmaVersion = 1e8; }
  else if (o.ecmaVersion == null) { o.ecmaVersion = 11; }
  else if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }
  return o.ecmaVersion;
}`;

describe("#2849 — dynamic-key object numeric property read", () => {
  it("host mode: acorn-shape normalisation run(2022) === 13", async () => {
    const fn = await run(ACORN_SHAPE);
    expect(fn(2022)).toBe(13);
  });

  // NOTE: standalone (`--target standalone`) does NOT yet return 13 here — it
  // reads the `$Object` property back as an externref/object, an INDEPENDENT
  // pre-existing gap in the standalone dynamic-`$Object` numeric substrate
  // (verified identical on `main`, unaffected by this fix). #2849 scope is the
  // host/edge.js differential; the standalone numeric-substrate work is tracked
  // separately (the `$Object` dynamic-reader value-rep line).

  it("equality guard (not taken) does not corrupt the dynamic-written value", async () => {
    // Both `=== "latest"` and `== null` independently triggered the bug: the
    // guard + then-body reassignment widened `o` to a struct while the for-in
    // wrote the sidecar. With the fix, the untaken guard leaves 2022 intact.
    const strGuard = await run(`// @ts-nocheck
var d = { ecmaVersion: 0 };
export function run(ev) { var opts = { ecmaVersion: ev }; var o = {};
  for (var k in d) { o[k] = opts[k]; }
  if (o.ecmaVersion === "latest") { o.ecmaVersion = 1e8; }
  return o.ecmaVersion; }`);
    expect(strGuard(2022)).toBe(2022);

    const nullGuard = await run(`// @ts-nocheck
var d = { ecmaVersion: 0 };
export function run(ev) { var opts = { ecmaVersion: ev }; var o = {};
  for (var k in d) { o[k] = opts[k]; }
  if (o.ecmaVersion == null) { o.ecmaVersion = 11; }
  return o.ecmaVersion; }`);
    expect(nullGuard(2022)).toBe(2022);
  });

  it("literal-key computed writes keep the struct fast path (still correct)", async () => {
    // A string-LITERAL computed key resolves to a field and lowers to
    // `struct.set`, so it is NOT demoted — and must remain correct.
    const fn = await run(`// @ts-nocheck
export function run(ev) { var o = {}; o.ecmaVersion = 0; o["ecmaVersion"] = ev; return o.ecmaVersion; }`);
    expect(fn(2022)).toBe(2022);
  });

  it("pure numeric normalisation (no equality guard) still works", async () => {
    const fn = await run(`// @ts-nocheck
var d = { ecmaVersion: 0 };
export function run(ev) { var opts = { ecmaVersion: ev }; var o = {};
  for (var k in d) { o[k] = opts[k]; }
  if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }
  return o.ecmaVersion; }`);
    expect(fn(2022)).toBe(13);
  });
});
