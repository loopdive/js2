// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4624) `Object.getOwnPropertyDescriptor(obj, name)` through a DYNAMIC
// receiver answered `undefined` for the `%Function%` intrinsic under
// `--target standalone`.
//
// ## The three-shape table this file pins
//
// Measured by me on this branch's base (campaign HEAD 9d9291db7) with the real
// `runTest262File` standalone lane, then re-measured after the fix:
//
// | shape                                                    | base      | after   |
// | -------------------------------------------------------- | --------- | ------- |
// | `gOPD(Function, "prototype")`, LITERAL receiver           | object    | object  |
// | `gOPD(o, "a")` through a parameter, plain object          | object    | object  |
// | `gOPD(obj, name)` through a parameter, `obj = Function`   | undefined | object  |
//
// Row 3 is the defect. A bare `Function` read is the one builtin that does NOT
// mint the #3006 `$Object` ctor carrier — it is an `intrinsic-value` boundary
// site and arrives as the `$RuntimeEvalInterpretedCallback` marker (#4491 T7-B).
// #4491 taught `__hasOwnProperty` / `__object_hasOwn` / `__delete_property`
// about that marker but not `__getOwnPropertyDescriptor`, so PRESENCE said
// "own" while the DESCRIPTOR said "absent" — and `propertyHelper.js`'s
// deprecated verifiers read the descriptor directly (`.writable` line 411,
// `.configurable` line 457).
//
// ## Why these are honest passes and not vacuous ones
//
// Until #4519 that read was `!undefined`, which satisfies both asserts, so
// `built-ins/Function/prototype/S15.3.3.1_A1.js` and `_A3.js` PASSED for no
// reason. #4519's member-get guard makes the same read throw; both rows then
// failed honestly on this file's base (measured — `fail` on both, own runs),
// and pass here because the descriptor now exists. The row pins below are what
// keep that distinction: a probe alone cannot tell a real pass from a vacuous
// one, only the real upstream harness can.
//
// ## Why the probes go through `instantiateTest262Module`
//
// The marker only exists in a provider-LINKED module, and a bare
// `compile(...)` + `WebAssembly.instantiate(binary, {})` cannot link it (the
// module declares `js2wasm:runtime-eval`). `instantiateTest262Module` is the
// same seam every test262 lane uses (#4162) — the identical harness
// `tests/issue-4442.test.ts` uses for this exact carrier family.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * (#4003 CI-load mitigation, same hook as `tests/issue-4485.test.ts`.) A
 * test262 row costs a full compile; yielding two macrotasks between tests lets
 * vitest's queued `onTaskUpdate` reporter RPCs drain instead of timing out
 * under parallel-agent load.
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

/** Compile `body` as a standalone module and run it with the provider linked. */
async function runLinked(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4624.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    { target: "standalone", providerLabel: "issue-4624" },
  );
  return (instance.exports as { test(): number }).test();
}

/**
 * The DYNAMIC descriptor read: an untyped parameter receiver, which is the only
 * kind `propertyHelper.js` ever has. Written as a helper so no probe can
 * accidentally pin the compile-time literal-receiver fold instead.
 */
const RD = `function rd(o, n) { return Object.getOwnPropertyDescriptor(o, n); }`;

async function row(rel: string): Promise<string> {
  const abs = join(__dirname, "..", "test262", "test", rel);
  const cat = rel.split("/").slice(0, -1).join("/");
  const r = await runTest262File(abs, cat, 20000, "standalone");
  return r.status;
}

describe("#4624 — the three-shape gOPD table", () => {
  it("row 3: a DYNAMIC receiver holding %Function% answers the §20.2.2 `prototype` descriptor", async () => {
    // THE flip. Distinct return codes rather than a boolean so a failure says
    // WHICH half broke: 0 = still undefined (the base answer), 2/3/4 = a wrong
    // attribute, 5 = a descriptor whose `value` is not the object the direct
    // read yields — which would be worse than no descriptor at all, and is
    // exactly what `verifyNotWritable` cross-checks.
    expect(
      await runLinked(`${RD}
        var d = rd(Function, "prototype");
        if (d === undefined) return 0;
        if (d.writable !== false) return 2;
        if (d.enumerable !== false) return 3;
        if (d.configurable !== false) return 4;
        if (d.value !== Function.prototype) return 5;
        return 1;`),
    ).toBe(1);
  });

  it("row 1: the LITERAL receiver keeps its answer (control — passed on base)", async () => {
    expect(
      await runLinked(`
        var d = Object.getOwnPropertyDescriptor(Function, "prototype");
        if (d === undefined) return 0;
        return d.writable === false && d.enumerable === false && d.configurable === false &&
               d.value === Function.prototype ? 1 : 2;`),
    ).toBe(1);
  });

  it("row 2: a DYNAMIC receiver holding a plain object is untouched (control)", async () => {
    // The new arm sits in front of the `$Object` walk; this is the assertion
    // that it never shadows an ordinary receiver.
    expect(
      await runLinked(`${RD}
        var d = rd({ a: 1 }, "a");
        if (d === undefined) return 0;
        return d.value === 1 && d.writable === true && d.enumerable === true && d.configurable === true ? 1 : 2;`),
    ).toBe(1);
  });
});

describe("#4624 — the rest of the %Function% own surface, through a dynamic receiver", () => {
  it("`length` is {value: 1, w:false, e:false, c:true} (§20.2.2 / §17)", async () => {
    expect(
      await runLinked(`${RD}
        var d = rd(Function, "length");
        if (d === undefined) return 0;
        return d.value === 1 && d.writable === false && d.enumerable === false && d.configurable === true ? 1 : 2;`),
    ).toBe(1);
  });

  it('`name` is {value: "Function", w:false, e:false, c:true}', async () => {
    expect(
      await runLinked(`${RD}
        var d = rd(Function, "name");
        if (d === undefined) return 0;
        return d.value === "Function" && d.writable === false && d.enumerable === false && d.configurable === true
          ? 1
          : 2;`),
    ).toBe(1);
  });

  it("presence and the descriptor now AGREE on all three keys", async () => {
    // The defect class this fixes is two surfaces contradicting each other, so
    // the pin compares them against EACH OTHER rather than each against a
    // constant. On base this returned 0 (presence true, descriptor undefined).
    expect(
      await runLinked(`
        function ho(a, b) { return Object.prototype.hasOwnProperty.call(a, b); }
        ${RD}
        var p = Function.prototype;
        var ks = ["prototype", "length", "name"];
        for (var i = 0; i < ks.length; i++) {
          if (ho(Function, ks[i]) !== (rd(Function, ks[i]) !== undefined)) return 0;
        }
        return 1;`),
    ).toBe(1);
  });

  it("a key %Function% does not own still answers undefined (absent-not-wrong)", async () => {
    expect(
      await runLinked(`${RD}
        var p = Function.prototype;
        return rd(Function, "zzz") === undefined ? 1 : 0;`),
    ).toBe(1);
  });

  it("a NON-string key falls through instead of being fabricated", async () => {
    // The arm's outer guard requires `ref.test $AnyString` on the key; without
    // it a numeric key would `ref.cast` and trap inside a helper that must not
    // throw.
    expect(
      await runLinked(`${RD}
        var p = Function.prototype;
        return rd(Function, 0) === undefined ? 1 : 0;`),
    ).toBe(1);
  });
});

describe.skipIf(!TEST262)("#4624 — the two acceptance rows, real upstream propertyHelper", () => {
  it("built-ins/Function/prototype/S15.3.3.1_A1.js passes (verifyNotWritable)", async () => {
    expect(await row("built-ins/Function/prototype/S15.3.3.1_A1.js")).toBe("pass");
  });

  it("built-ins/Function/prototype/S15.3.3.1_A3.js passes (verifyNotConfigurable)", async () => {
    expect(await row("built-ins/Function/prototype/S15.3.3.1_A3.js")).toBe("pass");
  });

  it("built-ins/Function/length/S15.3.5.1_A3_T1.js stays passing (nearest unmoved neighbour)", async () => {
    // From the same 248-file deprecated-verifier set; `pass -> pass` on my own
    // A/B, i.e. a control for "the arm only claims the %Function% marker".
    expect(await row("built-ins/Function/length/S15.3.5.1_A3_T1.js")).toBe("pass");
  });

  it("built-ins/Function/prototype/call/S15.3.4.4_A10.js stays passing (a builtin-FUNCTION receiver)", async () => {
    // `verifyNotWritable(Function.prototype.call, "length", …)` — same verifier
    // family, a receiver the new arm must NOT claim (it is a #2896 builtin
    // closure, not the `%Function%` marker). Also `pass -> pass` on my A/B.
    //
    // The obvious neighbour `built-ins/Function/prototype/S15.3.5.2_A1_T2.js`
    // is deliberately NOT used: it runs `Function(void 0, "")`, which the CI
    // `quality` tier's REFUSAL provider throws on by design, so it fails under
    // `JS2WASM_EVAL_ENGINE=interpreter` on BOTH arms (measured) for a reason
    // that has nothing to do with descriptors.
    expect(await row("built-ins/Function/prototype/call/S15.3.4.4_A10.js")).toBe("pass");
  });
});

describe("#4624 — measured residuals (each fails today, on purpose)", () => {
  it.fails("a module that never MENTIONS `Function.prototype` still gets no `prototype` descriptor", async () => {
    // The arm's value for `prototype` is the identity-stable `$NativeProto`
    // singleton, and it is only materializable once the `Function` proto GLUE
    // is registered — which happens when the module mentions
    // `Function.prototype` syntactically. Registering that glue at FINALIZE
    // (where this arm runs) is out of regime, so the arm DECLINES instead of
    // fabricating a value: `length`/`name` still answer, `prototype` keeps the
    // base `undefined`. Every propertyHelper-using test262 row has
    // `Function.prototype.call.bind(...)` in the harness, which is why the
    // acceptance rows are unaffected.
    expect(
      await runLinked(`${RD}
        return rd(Function, "prototype") === undefined ? 0 : 1;`),
    ).toBe(1);
  });

  it.fails("`Object.getOwnPropertyNames(Function)` still omits the three own keys", async () => {
    // #4491 T7-B widened presence/delete but not own-name ENUMERATION, and this
    // issue widened the descriptor but not enumeration either. Owner: the
    // %Function% marker surface (#4491 family) — closing it needs an
    // own-names arm on the marker, not a descriptor one.
    expect(
      await runLinked(`
        var p = Function.prototype;
        var ns = Object.getOwnPropertyNames(Function);
        for (var i = 0; i < ns.length; i++) { if (ns[i] === "prototype") return 1; }
        return 0;`),
    ).toBe(1);
  });

  it.fails("`delete Function.length` still does not remove it, despite the descriptor saying c:true", async () => {
    // #4491's stated residual, now visible through a second surface: the marker
    // has no store to record a tombstone in, so `delete` refuses. Closing it
    // needs the cross-module marker-slot ABI change #4491 priced and declined.
    expect(
      await runLinked(`
        function ho(a, b) { return Object.prototype.hasOwnProperty.call(a, b); }
        function del(o, n) { return delete o[n]; }
        var p = Function.prototype;
        del(Function, "length");
        return ho(Function, "length") ? 0 : 1;`),
    ).toBe(1);
  });
});
