// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5269 — ES2015 standalone residual pass over the Function / Error / Symbol /
// String / JSON / Number built-ins (wave 2 of #5156 / #5152).
//
// ── Why these cases are shaped the way they are ───────────────────────────
// Every case is a SCRIPT (no `export`) that signals failure by throwing, so
// completing `__module_init` IS the pass — the same harness #4207 uses, and for
// the same reason: a top-level `export` makes TypeScript call the source a
// module, module code is strict throughout, and strictness changes `this`
// binding for several of the receivers under test.
//
// `standalone` is the lane this issue is about, and it additionally asserts the
// module imports NOTHING from `env`: every body here must be Wasm-native, and
// the test262 runner does NOT apply that check to the original-harness variant
// (#5272), so a host-import leak would otherwise be invisible here too. The
// `host` lane runs the cases whose lowering is SHARED between the two (the JSON
// dispatch gates, the object-literal host-path decision, the `.call`/`.apply`
// arm), because a change there can regress host mode with no standalone row
// noticing.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "standalone" | "host";

async function runLane(body: string, lane: Lane): Promise<string | null> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "issue-5269.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : { hostBridge: "always" as const }),
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (lane === "standalone") {
    expect(
      WebAssembly.Module.imports(module)
        .filter((i) => i.module === "env")
        .map((i) => i.name),
      "standalone module must not import from env",
    ).toEqual([]);
  }
  // The host lane needs the FULL runtime import surface — the same builder the
  // test262 runner uses, not a hand-written subset (a missing name surfaces as
  // a LinkError that reads like a codegen failure).
  const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports & {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  // `WebAssembly.instantiate(Module, …)` resolves to the Instance itself — the
  // `{ module, instance }` shape is the BYTES overload only.
  const instance = (await WebAssembly.instantiate(module, imports)) as unknown as WebAssembly.Instance;
  imports.setInstance?.(instance);
  try {
    (instance.exports as Record<string, () => void>).__module_init?.();
    return null;
  } catch (error) {
    return String((error as { message?: unknown })?.message ?? error);
  }
}

/**
 * `expr` must stringify to `want`, else throw with what it actually was.
 * Never wrap a value that may be `undefined`/`null` in `String(...)` on the
 * standalone lane — the null externref carrier traps inside `__str_concat`;
 * use `typeof` or a comparison expression instead.
 */
const check = (expr: string, want: string) =>
  `var __r = ${expr}; if (String(__r) !== ${JSON.stringify(want)}) { throw new Error("got " + String(__r)); }`;

function standaloneOnly(name: string, body: string): void {
  it(`${name} — standalone`, async () => {
    expect(await runLane(body, "standalone")).toBeNull();
  });
}

function bothLanes(name: string, body: string): void {
  standaloneOnly(name, body);
  it(`${name} — host`, async () => {
    expect(await runLane(body, "host")).toBeNull();
  });
}

describe("#5269 Step G — JSON residue", () => {
  // G-4. §25.5.2 step 11: a Symbol value has no serialisation, so the result is
  // the JS value `undefined` — NOT the string "null" the codec used to render.
  bothLanes(
    "G-4 JSON.stringify(symbol) is undefined",
    `var sym = Symbol("d");
     var r = JSON.stringify(sym);
     if (r !== undefined) { throw new Error("expected undefined"); }`,
  );

  // G-1. Zero arguments is a legal call: ToString(undefined) is "undefined",
  // which the ECMA-404 grammar rejects — a catchable SyntaxError, not the
  // compile-time `__get_builtin` refusal it used to be.
  bothLanes(
    "G-1 JSON.parse() throws a catchable SyntaxError",
    `var caught = "none";\ntry { JSON.parse(); } catch (e) { caught = e.constructor.name; }\n${check("caught", "SyntaxError")}`,
  );

  // G-1. §25.5.1 step 1 ToString(text) runs for EVERY text, so a non-string
  // primitive parses as its string form instead of hitting the refusal.
  bothLanes("G-1 JSON.parse coerces a null text", check("JSON.parse(null)", "null"));

  // G-2. A Proxy value is walked through its traps instead of rendering as the
  // literal `null`. Standalone-only: the host lane hands the same source to a
  // real JS Proxy, whose invariant checks reject this handler's synthetic
  // descriptor — that is the host engine's behaviour, not this lowering's.
  standaloneOnly(
    "G-2 JSON.stringify walks a Proxy of an object through ownKeys/get",
    `var p = new Proxy({}, {
       getOwnPropertyDescriptor: function () { return { value: 1, writable: true, enumerable: true, configurable: true }; },
       get: function () { return 1; },
       ownKeys: function () { return ["a", "b"]; }
     });
     ${check("JSON.stringify(p)", '{"a":1,"b":1}')}
     ${check("JSON.stringify({ l1: p })", '{"l1":{"a":1,"b":1}}')}`,
  );

  // G-2. A revoked proxy is a TypeError, not the literal "null".
  bothLanes(
    "G-2 JSON.stringify of a revoked proxy throws a TypeError",
    `var h = Proxy.revocable({}, {});
     h.revoke();
     var caught = "none";
     try { JSON.stringify(h.proxy); } catch (e) { caught = e.constructor.name; }
     ${check("caught", "TypeError")}`,
  );

  // G-3. §25.5.2 step 4: a non-callable, non-array replacer is IGNORED — it is
  // not an error, and it must not suppress the value.
  bothLanes(
    "G-3 a non-array object replacer is ignored",
    `${check("JSON.stringify({ key: [1] }, {})", '{"key":[1]}')}
     ${check('JSON.stringify({ key: [1] }, "")', '{"key":[1]}')}`,
  );

  // G-3. An array replacer that is NOT a literal is classified at RUNTIME and
  // filters the key set (statically only a call signature or an array literal
  // was recognised, so this shape used to refuse).
  bothLanes(
    "G-3 a dynamic array replacer filters keys",
    `var replacer = ["b"];\n${check("JSON.stringify({ a: 1, b: 2 }, replacer)", '{"b":2}')}`,
  );

  // G-5 (IsArray recursing through a proxy-of-proxy in the InternalizeJSON walk)
  // is covered by `built-ins/JSON/parse/revived-proxy.js`, which this change
  // flips. It has no self-contained fixture here: a trapless Proxy over a CLOSED
  // typed-vec target does not forward its reads at all (measured — `p["0"]` and
  // `p["length"]` both answer `undefined` through `__extern_get`), which is a
  // Proxy-carrier gap outside this issue, and it would make such a fixture
  // assert the gap rather than the recursion.
});
