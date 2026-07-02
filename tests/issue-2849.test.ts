// (#2849) A `{}` object populated via dynamic-key writes (`o[k]=v`, e.g. a
// for-in copy loop) keeps its values in the dynamic `$Object` sidecar. A
// STATIC-named write `o.prop = <const>` anywhere in the function — even an
// UNREACHED branch — used to widen `prop` into a real WasmGC struct field
// (default 0) via the reachability-blind `collectEmptyObjectWidening` pre-pass.
// Every read `o.prop` then lowered to `struct.get` of the empty field → 0,
// while the for-in values sat untouched in the sidecar. The `#2584`
// `objectHashConsumerVars` poison (keep such objects on `$Object`) already fixed
// this for standalone but was `ctx.standalone`-gated; #2849 extends it to host
// (the "live-mirror Proxy" the gate assumed does NOT bridge the for-in-write →
// struct-read divergence).
//
// This is the acorn `getOptions` ecmaVersion-normalisation shape:
//   var o = {}; for (var k in defaults) o[k] = opts[k];
//   if (o.ecmaVersion === "latest") …            // static-named guard write
//   else if (o.ecmaVersion == null) …
//   else if (o.ecmaVersion >= 2015) o.ecmaVersion -= 2009;   // 2022 → 13
//
// (#2937 REVERT) The host extension of the poison was REVERTED in #2937: extending
// it to host kept acorn's poisoned `{}` vars on `$Object`, but the poisoned value
// ESCAPES into struct-typed slots (return / `this.options` field) the poison never
// re-types, so compiled-acorn null-dereferenced on EVERY host-mode input — strictly
// worse than this narrow `getOptions` quirk. So the HOST for-in-copy-WITH-GUARD arms
// below now reopen the pre-#2849 host bug (`o.ecmaVersion` reads back the widened
// struct default, not the sidecar value) and are marked `it.fails` — a HONEST
// known-fail pinned to reopened #2849, whose real cure is the escape-discipline
// substrate slice #2944. When #2944 lands, `it.fails` flips red, forcing these arms
// back to plain `it`. Standalone is UNCHANGED (its poison was never reverted) and
// the host NO-GUARD + STATIC-ONLY arms still pass (the guard is what triggers the
// widen→sidecar divergence).
const HOST_KNOWN_FAIL_2849 = new Set(["== null guard", '=== "latest" guard', "numeric-only guard"]);

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Host-mode harness (buildImports + setExports — the canonical host runtime
// glue; without setExports a struct-sidecar read returns undefined, which is the
// harness false-negative that masked this bug during triage).
async function runHost(source: string, arg: number, fn = "run"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](arg);
}

// Standalone harness — compiles with `--target standalone` and instantiates
// with EMPTY imports (a leaked host import fails instantiation). #2849 is a
// HOST-mode bug: the `objectHashConsumerVars` poison was already applied for
// standalone (this fix only extends it to host), so standalone codegen is
// byte-identical before/after (verified via sha256 in the issue). Standalone
// also has a SEPARATE, pre-existing `$Object` dynamic-read-back gap for the
// for-in-copy pattern (`o[k]=src[k]` then `o.prop` reads back 0/undefined —
// filed separately), so we do NOT assert the normalised numeric here; we assert
// standalone stays PURE (no host-import leak) and does not trap.
async function compileStandalonePureRuns(source: string, arg: number, fn = "run"): Promise<void> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  // Must not trap (invalid Wasm / null-deref) — result value is out of scope here.
  (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](arg);
}

const FORIN_COPY = `// @ts-nocheck
var defaults = { ecmaVersion: null, sourceType: 0 };
export function run(ev) {
  var opts = { ecmaVersion: ev, sourceType: 1 };
  var o = {};
  for (var k in defaults) { o[k] = opts[k]; }
  __GUARD__
  return o.ecmaVersion;
}`;

const variants: Record<string, string> = {
  "no-guard": `if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }`,
  "== null guard": `if (o.ecmaVersion == null) { o.ecmaVersion = 11; } else if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }`,
  '=== "latest" guard': `if (o.ecmaVersion === "latest") { o.ecmaVersion = 1e8; } else if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }`,
  "numeric-only guard": `if (o.ecmaVersion > 5000) { o.ecmaVersion = 1; } else if (o.ecmaVersion >= 2015) { o.ecmaVersion -= 2009; }`,
};

describe("#2849 dynamic-object static-write field-vs-sidecar coherence", () => {
  for (const [name, guard] of Object.entries(variants)) {
    const src = FORIN_COPY.replace("__GUARD__", guard);
    // (#2937) The guard-bearing host arms reopen the #2849 host bug after the
    // revert — mark them known-fail (blocked on substrate #2944). The no-guard
    // host arm still normalises correctly (no string/null guard → no divergence).
    const hostIt = HOST_KNOWN_FAIL_2849.has(name) ? it.fails : it;
    hostIt(`host: for-in copy + [${name}] normalises 2022 → 13`, async () => {
      expect(await runHost(src, 2022)).toBe(13);
    });
    it(`standalone: for-in copy + [${name}] stays pure and does not trap`, async () => {
      await compileStandalonePureRuns(src, 2022);
    });
  }

  // The minimal proof: an UNREACHED static-named write must NOT shadow the
  // sidecar value the for-in loop wrote.
  const DEAD_BRANCH = `// @ts-nocheck
var defaults = { ecmaVersion: null, sourceType: 0 };
export function run(ev) {
  var opts = { ecmaVersion: ev, sourceType: 1 };
  var o = {};
  for (var k in defaults) { o[k] = opts[k]; }
  if (ev < 0) { o.ecmaVersion = 999; }   // never taken for ev = 2022
  return o.ecmaVersion;
}`;
  // (#2937) Known-fail after the revert (reopened #2849, blocked on #2944): the
  // unreached static write again shadows the sidecar in host mode.
  it.fails("host: unreached static write does not shadow the sidecar (reads 2022)", async () => {
    expect(await runHost(DEAD_BRANCH, 2022)).toBe(2022);
  });
  it("standalone: unreached static write compiles pure and does not trap", async () => {
    await compileStandalonePureRuns(DEAD_BRANCH, 2022);
  });

  // Guardrail: a `{}` var with ONLY static-named access keeps the struct fast
  // path and stays correct (this class is NOT poisoned, so its codegen is
  // byte-identical to pre-fix — see the sha256 neutrality check in the issue).
  const STATIC_ONLY = `// @ts-nocheck
export function run(x) {
  var o = {};
  o.v = x;
  if (o.v >= 2015) { o.v -= 2009; }
  return o.v;
}`;
  it("host: static-only-access object unchanged (2022 → 13)", async () => {
    expect(await runHost(STATIC_ONLY, 2022)).toBe(13);
  });
});
