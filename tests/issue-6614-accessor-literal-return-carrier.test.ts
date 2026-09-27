// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6614 (#5383 S27) — an object literal carrying a `get`/`set` accessor is
// NULL-DROPPED when it crosses a function's RETURN slot, under
// `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. Such a literal is built by
// `compileObjectLiteralWithAccessors` as a HOST object (`__new_plain_object` +
// `__defineProperty_accessor`, an externref), never as a WasmGC struct. The
// checker types the enclosing function's return as the anonymous shape the
// accessor's return type implies, so the RECEIVING binding is laid out as
// `(ref null $__anon_N)`. The store guard (`ref.test $__anon_N` on a host
// object) always fails, `ref.null` is written, and the first read is a
// `struct.get` on null:
//
//     const M = { mk(pv) { return { get g() { return pv; } }; } };
//     const r = M.mk(5);
//     r.g          // TypeError "Cannot access property on null or undefined"
//
// `declarations.ts::functionReturnsHostObjectLiteralCarrier` already closes
// this for ONE spelling — a SOURCE-FILE-LEVEL `function mk() { … }` — because
// it is reached only from the two `ts.FunctionDeclaration` registration sites.
// Every other spelling of the same function fell through, which is why
// `TemporalHelpers.toPrimitiveObserver` (an object-literal METHOD) handed out
// an observer whose `calls` array stayed EMPTY and whose getter never ran.
//
// THE SPELLING TRAP, and why the cases are written the way they are: the
// working spelling is the one a hand-written reduction reaches for first. A
// witness written as a top-level `function mk()` passes on BOTH trees and
// asserts nothing. Each case below therefore pins a spelling that the existing
// arm does not reach.
//
// Every expectation was measured on BOTH trees by file-copy revert of
// `src/codegen/index.ts` (`.tmp/s27base/`, which un-wires the new pre-pass);
// the base-tree answer is recorded inline on each one.
//
// Host-free: `hostBridge: "off"` plus an EMPTY import object, so a leaked host
// import fails the test instead of being papered over.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

const SINGLE = {
  ...STANDALONE,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `prelude` + `expression` standalone, instantiate with an EMPTY import
 * object, and read the string it produced back one char code at a time. The
 * base tree throws a catchable JS `TypeError` here rather than a wasm trap, so
 * the module's own `catch` reports it as `"!<message>"`.
 */
async function runStandaloneString(prelude: string, expression: string): Promise<string> {
  const source = `${prelude}
    let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, SINGLE);
  if (!result.success) return `!compile ${result.errors?.[0]?.message ?? ""}`;
  let instance: WebAssembly.Instance;
  try {
    const module = await WebAssembly.compile(result.binary as Uint8Array);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    instance = await WebAssembly.instantiate(module, {});
  } catch (error) {
    return `!invalid ${String((error as Error)?.message ?? error).slice(0, 80)}`;
  }
  const exports = instance.exports as {
    prepare: () => number;
    at: (i: number) => number;
    __module_init?: () => void;
  };
  try {
    exports.__module_init?.();
  } catch (error) {
    return `!init ${String((error as Error)?.message ?? error).slice(0, 60)}`;
  }
  let length: number;
  try {
    length = exports.prepare();
  } catch (error) {
    return `!trap ${String((error as Error)?.message ?? error).slice(0, 60)}`;
  }
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

/** The harness shape itself, spelled exactly as `temporalHelpers.js` spells it. */
const OBSERVER = `
  const H = {
    toPrimitiveObserver(calls, primitiveValue, propertyName) {
      return {
        get valueOf() {
          calls.push("get " + propertyName + ".valueOf");
          return function () { calls.push("call " + propertyName + ".valueOf"); return primitiveValue; };
        },
        get toString() {
          calls.push("get " + propertyName + ".toString");
          return function () { calls.push("call " + propertyName + ".toString"); return primitiveValue.toString(); };
        },
      };
    },
  };`;

describe("#6614 accessor-literal return carrier, standalone — single module", () => {
  it("carries the accessor object out of every function spelling the existing arm does not reach", async () => {
    // TEETH. Base tree, measured: every one of these answered
    // "!Cannot access property on null or undefined".
    const G = `{ get g() { return 5; } }`;
    expect(await runStandaloneString(`const M = { mk() { return ${G}; } }; const r = M.mk();`, `r.g`)).toBe("5");
    expect(await runStandaloneString(`const mk = function () { return ${G}; }; const r = mk();`, `r.g`)).toBe("5");
    expect(await runStandaloneString(`const mk = () => (${G}); const r = mk();`, `r.g`)).toBe("5");
    expect(
      await runStandaloneString(`function o() { function mk() { return ${G}; } return mk(); } const r = o();`, `r.g`),
    ).toBe("5");
    expect(await runStandaloneString(`class C { mk() { return ${G}; } } const r = new C().mk();`, `r.g`)).toBe("5");
    expect(await runStandaloneString(`const r = (function () { return ${G}; })();`, `r.g`)).toBe("5");
    // Through a LOCAL binding inside the carrier — the `hostDeclarations` hop.
    expect(
      await runStandaloneString(`const M = { mk() { const o = ${G}; return o; } }; const r = M.mk();`, `r.g`),
    ).toBe("5");
  });

  it("observes the getter exactly once, in spec order, for the real harness shape", async () => {
    // TEETH, and the reason this `it` is separate: a fix that merely stops the
    // null-drop could still hand back an object whose accessor is a DATA
    // property — right value, no side effect, which is precisely what
    // `checkStringOptionWrongType`'s `assert.compareArray(actual, expected,
    // "order of operations")` catches. Base tree, measured: `"=>0"` — the
    // observer's `calls` array EMPTY and `+obs` answering 0, which is the exact symptom
    // the Temporal families reported.
    expect(
      await runStandaloneString(
        `${OBSERVER} const calls = []; const obs = H.toPrimitiveObserver(calls, 2, "p");`,
        `(function () { const n = +obs; return calls.join("|") + "=>" + n; })()`,
      ),
    ).toBe("get p.valueOf|call p.valueOf=>2");
    // ToString reaches the OTHER accessor, and only that one.
    expect(
      await runStandaloneString(
        `${OBSERVER} const calls = []; const obs = H.toPrimitiveObserver(calls, 7, "q");`,
        `(function () { const s = \`\${obs}\`; return calls.join("|") + "=>" + s; })()`,
      ),
    ).toBe("get q.toString|call q.toString=>7");
    // Exactly once: reading twice must log twice, not zero times and not four.
    expect(
      await runStandaloneString(
        `${OBSERVER} const calls = []; const obs = H.toPrimitiveObserver(calls, 3, "r");`,
        `(function () { const n = +obs + +obs; return calls.length + ":" + n; })()`,
      ),
    ).toBe("4:6");
  });

  it("leaves every spelling that already worked exactly as it was", async () => {
    // CONTROLS. All of these answered correctly on the base tree too — a
    // widening that fires where it is not needed costs the closed-struct
    // representation, which is a performance and a typed-consumer hazard.
    const G = `{ get g() { return 5; } }`;
    expect(await runStandaloneString(`function mk() { return ${G}; } const r = mk();`, `r.g`)).toBe("5");
    expect(await runStandaloneString(`const r = ${G};`, `r.g`)).toBe("5");
    // A carrier with no accessor keeps its struct and its value.
    expect(await runStandaloneString(`const M = { mk(v) { return { g: v }; } }; const r = M.mk(5);`, `r.g`)).toBe("5");
    expect(
      await runStandaloneString(`const M = { mk(v) { return { m() { return v; } }; } }; const r = M.mk(5);`, `r.m()`),
    ).toBe("5");
    expect(
      await runStandaloneString(`const M = { mk(v) { return function () { return v; }; } }; const r = M.mk(5);`, `r()`),
    ).toBe("5");
    // A typed consumer of an ordinary struct return must still see a struct:
    // two fields read back, not an externref the arithmetic would NaN out.
    expect(
      await runStandaloneString(
        `const M = { mk(a, b) { return { a: a, b: b }; } }; const r = M.mk(2, 3);`,
        `r.a * 10 + r.b`,
      ),
    ).toBe("23");
  });
});

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6614-"));
  const packageRoot = join(root, "node_modules", "ns6614");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6614", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6614";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6614")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

// The provider consumes a CONSUMER-built observer through the #6600 reverse
// channel — `sum` reads `o.valueOf` back across the link and calls it. That is
// the arrangement the Temporal families actually run: the harness object is
// built in the test module, the polyfill reads it.
const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    sum: (o) => o.g + 100,
    sumData: (o) => o.d + 100,
    sumTop: (o) => o.g + 100,
    tag: "prov",
  });`;

// Numbers, because a standalone module's string is a WasmGC array the host
// cannot decode — every comparison happens INSIDE the module. The base tree
// answers -1 on the armed exports (the null-drop is a catchable TypeError).
const CONSUMER = `
  const M = { mk(v) { return { get valueOf() { hit = hit + 1; return function () { return v; }; } }; } };
  const P = { mk(v) { return { get g() { return v; } }; } };
  const D = { mk(v) { return { d: v }; } };
  const topAcc = { get g() { return 5; } };
  let hit = 0;
  // CONTROL: the provider's own surface is untouched by this change.
  export function tagLen() { return NS.tag.length; }
  // TEETH. The carrier is CONSUMER-local but compiled in a module that also
  // links a provider — the widening must survive a linked build, where the rec
  // group and the type indices are not the single-module ones.
  // Base tree, measured: 0 and 0 — the null-drop answers 0 with the getter
  // never run, so it does not even reach the catch arm.
  export function localObserver() { try { return +M.mk(7); } catch (e) { return -1; } }
  export function localObserverHits() { try { hit = 0; const n = +M.mk(7); return hit * 100 + n; } catch (e) { return -1; } }
  // TEETH across the LINK: the provider reads the consumer-built accessor back
  // through the reverse channel. Base tree, measured: -1 for reverseRead (the
  // consumer-side null-drop threw) and 100 for reverseTop (no null-drop there —
  // the reverse GET simply does not dispatch the accessor).
  export function reverseRead() { try { return NS.sum(P.mk(5)); } catch (e) { return -1; } }
  export function reverseData() { try { return NS.sumData(D.mk(5)); } catch (e) { return -1; } }
  export function reverseTop() { try { return NS.sumTop(topAcc); } catch (e) { return -1; } }`;

describe("#6614 accessor-literal return carrier, standalone — linked pair", () => {
  it("carries a consumer-built observer through a LINKED build and back across the reverse channel", async () => {
    const exports = await linkedPair(PROVIDER, CONSUMER);
    // The CONTROL runs FIRST, deliberately: an expectation placed after a
    // failing one is never reached on the base tree, so its "base tree: …" note
    // would be inference rather than a measurement (the #6612 discipline
    // point). Measured on base: 4 — this does not move.
    expect(exports.tagLen!()).toBe(4);
    // TEETH. Measured on base: 0 and 0.
    expect(exports.localObserver!()).toBe(7);
    expect(exports.localObserverHits!()).toBe(107);
    // CONTROL for the reverse channel itself: a DATA property of a
    // consumer-built object reads back across the link correctly, on both
    // trees. Measured: 105.
    expect(exports.reverseData!()).toBe(105);
    // PINNED RESIDUAL, and deliberately asserted rather than omitted. The
    // reverse peer GET does NOT dispatch an ACCESSOR: the provider reads
    // `o.g` and receives undefined, so both of these answer 100 (0 + 100).
    // They answer 100 on the BASE tree too — `reverseTop` reads a TOP-LEVEL
    // accessor literal, a spelling that already worked locally before this
    // change, which is what proves the residual is the reverse channel and not
    // the return slot this issue fixes. Written down in #6614 §Residuals with
    // its own reduction. When that defect is fixed these two become 105 and
    // this expectation must be updated, which is the point of pinning it.
    expect(exports.reverseTop!()).toBe(100);
    expect(exports.reverseRead!()).toBe(100);
  });
});
