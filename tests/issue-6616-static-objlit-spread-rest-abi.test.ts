// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6616 (#5383 S29) — the known-callee argument ABI for a call whose callee is a
// STATIC method reached through a class object, or an OBJECT-LITERAL method.
//
// WHY THIS REDUCTION EXISTS. The dispatched bucket was the four
// `Cannot read properties of undefined (reading 'apply'/'equals')` rows of the
// S28 four-family sample — `subclassing-ignored.js`, 45 files corpus-wide. The
// chain is test262's own harness:
//
//     checkSubclassingIgnoredStatic(...args) { this.checkStaticInvalidReceiver(...args); }
//     checkStaticInvalidReceiver(construct, method, methodArgs) {
//       const result = construct[method].apply(value, methodArgs);
//
// `TemporalHelpers` is an OBJECT LITERAL, so `this.checkStaticInvalidReceiver(...args)`
// is an object-literal method reached with a spread argument — and that arm
// never flattened the spread. `construct` therefore arrived as the whole rest
// ARRAY in formal 0, `method` arrived `undefined`, `construct[method]` was
// `undefined`, and the closed-method dispatcher's nullish-receiver guard threw
// the message the bucket is named after.
//
// THE MECHANISM, both halves. Four arms were missing what the class-INSTANCE
// arm has had all along:
//
//   (a) spread flattening. Each argument NODE was bound to one formal, so the
//       spread SOURCE landed whole in the first formal. With an inline array
//       literal the carrier is a tuple struct rather than a vec and the module
//       did not even VALIDATE.
//   (b) the hidden REST vec, for a static method only. `static f(...args)` saw
//       `args === null`, so the first read of it was a null-deref TRAP — with
//       no spread at the call site at all.
//
// (b) is load-bearing for (a) and is why they ship together: the flattened path
// actually READS the rest formal, so fixing (a) alone turned a wrong value into
// an UNCATCHABLE trap for `static fwd(...args) { return K.m2(...args); }`
// (measured: `.tmp/s29/cases-h.mjs`, base `"null/undefined"` → spread-only
// branch `TRAP dereferencing a null pointer`).
//
// EVERY EXPECTATION BELOW WAS MEASURED ON BOTH TREES by file-copy revert of
// `src/codegen/expressions/call-receiver-method.ts` and
// `src/codegen/expressions/call-namespace-static.ts` (`.tmp/s29base/` vs the
// branch files). The base answers are recorded inline on each `it`.
//
// Host-free: `hostBridge: "off"` plus an EMPTY import object, so a leaked host
// import fails the test instead of being papered over. The linked probe answers
// through the same string-readback channel, one char code at a time — a
// standalone module's string is a WasmGC array the host cannot decode.
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
 * object, and read back the string the module built.
 *
 * ONE MODULE PER CASE is deliberate, not tidiness: module CONTENT changes
 * answers here. The same `H.m2(...xs)` that compiles clean alone fails wasm
 * validation when several other object literals with methods share the module
 * (measured on the branch tree, `.tmp/s29/cases-f.mjs` vs `cases-g.mjs`) — that
 * interference is a separate residual, and a shared-prelude probe would have
 * attributed it to this issue.
 */
async function runStandaloneString(prelude: string, expression: string): Promise<string> {
  const source = `${prelude}
    let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, SINGLE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

/** Build a provider package + a consumer that links it, and read one string back. */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-6616-"));
  const packageRoot = join(root, "node_modules", "ns6616");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6616", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6616";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6616")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]:
        `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\nlet __s = "";\n` +
        `export function prepare() { try { __s = "" + (${consumerExpression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
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
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

const MARK = `function mark(v) { if (v === undefined) return "undef"; if (v === null) return "null"; return "" + v; }`;

describe("#6616 — spread + rest ABI for static and object-literal callees, standalone", () => {
  it("flattens a spread into an OBJECT-LITERAL method (the harness's own forwarding idiom)", async () => {
    // TEETH. Base tree: "1,2/undef" — the whole array landed in `a` and `b`
    // took its default. This is the exact shape of
    // `TemporalHelpers.checkSubclassingIgnoredStatic`.
    const prelude = `${MARK}
      const H = {
        m2(a, b) { return mark(a) + "/" + mark(b); },
        fwd(...args) { return this.m2(...args); },
      };`;
    await expect(runStandaloneString(prelude, `H.fwd(1, 2)`)).resolves.toBe("1/2");
  });

  it("flattens a spread whose source is an inline ARRAY LITERAL (a tuple struct, not a vec)", async () => {
    // TEETH. Base tree: "[object Object]/undef/undef" — an inline array literal
    // lowers to a TUPLE STRUCT rather than a vec, and the struct was handed to
    // the first formal. In a module carrying several such literals the same
    // mis-binding is worse than a wrong value: it fails wasm VALIDATION outright
    // (`call[0] expected type (ref null 51), found ref.as_non_null of type
    // (ref 125)`, measured on the base tree in `.tmp/s29/cases-f.mjs`), so the
    // module never instantiates.
    const prelude = `${MARK}
      const H = { m3(a, b, c) { return mark(a) + "/" + mark(b) + "/" + mark(c); } };`;
    await expect(runStandaloneString(prelude, `H.m3(...[1, 2, 3])`)).resolves.toBe("1/2/3");
  });

  it("flattens a spread into a STATIC method reached through its class object", async () => {
    // TEETH. Base tree: "1,2/undef".
    const prelude = `${MARK}
      class K { static s2(a, b) { return mark(a) + "/" + mark(b); } }
      const xs = [1, 2];`;
    await expect(runStandaloneString(prelude, `K.s2(...xs)`)).resolves.toBe("1/2");
  });

  it("materialises the hidden REST vec for a static method — no spread at the call site", async () => {
    // TEETH, and the half that had to ship with the other: base tree answers
    // "NULL" for the identity probe and TRAPS ("dereferencing a null pointer")
    // on `args.length`. A trap is uncatchable, so this is the arm that makes
    // the spread fix safe rather than merely correct.
    const prelude = `class K { static f(...args) { return args === null ? "NULL" : "len" + args.length; } }`;
    await expect(runStandaloneString(prelude, `K.f(1, 2)`)).resolves.toBe("len2");
  });

  it("composes: a static rest formal forwarded by spread into another static method", async () => {
    // TEETH. Base tree: "null/undef" — and with ONLY the spread half of the fix
    // it was a TRAP. Pins that the two halves stay together.
    const prelude = `${MARK}
      class K {
        static m2(a, b) { return mark(a) + "/" + mark(b); }
        static fwd(...args) { return K.m2(...args); }
      }`;
    await expect(runStandaloneString(prelude, `K.fwd(1, 2)`)).resolves.toBe("1/2");
  });

  it("CONTROL: the arms that were already right are still right", async () => {
    // All three measured identical on base and branch — and their ARTIFACTS are
    // byte-identical on both lanes (`.tmp/s29/bytes-base.txt` vs `-new.txt`).
    const prelude = `${MARK}
      class K { m2(a, b) { return mark(a) + "/" + mark(b); } }
      const H = { f(...args) { return "len" + args.length; } };
      function plain2(a, b) { return mark(a) + "/" + mark(b); }
      const xs = [1, 2];`;
    await expect(runStandaloneString(prelude, `new K().m2(...xs)`)).resolves.toBe("1/2");
    await expect(runStandaloneString(prelude, `plain2(...xs)`)).resolves.toBe("1/2");
    await expect(runStandaloneString(prelude, `H.f(1, 2)`)).resolves.toBe("len2");
  });

  it("CONTROL: a positional call to the same callees is unchanged", async () => {
    // The regression this change could plausibly cause is at the ORDINARY call
    // site, which must not notice. Byte-identical on both lanes.
    const prelude = `${MARK}
      const H = { m2(a, b) { return mark(a) + "/" + mark(b); } };
      class K { static s2(a, b) { return mark(a) + "/" + mark(b); } }`;
    await expect(runStandaloneString(prelude, `H.m2(1, 2)`)).resolves.toBe("1/2");
    await expect(runStandaloneString(prelude, `K.s2(1, 2)`)).resolves.toBe("1/2");
    // A MISSING argument still gets its default, not a flattened nothing.
    await expect(runStandaloneString(prelude, `H.m2(1)`)).resolves.toBe("1/undef");
  });

  it("LINKED: an object-literal method in the CONSUMER spreads into a provider static", async () => {
    // The cross-link spelling the test262 harness actually runs: the forwarding
    // object literal is consumer-side, the class it hands on is the provider's.
    // TEETH. Base tree: "!Cannot read properties of undefined (reading 'apply')"
    // — the exact bucket this slice was dispatched on.
    const provider = `
      export class PD {
        constructor(y) { this.y = y === undefined ? 0 : y; }
        static from(x) { return new PD(x); }
      }
      export const NS = Object.freeze({ __proto__: null, PD: PD });`;
    const consumer = `(function () {
      const H = {
        check(construct, method, args) { return construct[method].apply(undefined, args).y; },
        fwd(...args) { return H.check(...args); },
      };
      try { return H.fwd(NS.PD, "from", [7]); } catch (e) { return "!" + (e && e.message ? e.message : e); }
    })()`;
    await expect(runLinkedString(provider, consumer)).resolves.toBe("7");
  });
});
