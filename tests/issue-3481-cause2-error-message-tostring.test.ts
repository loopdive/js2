// #3481 cause 2 — an Error-family constructor must run ORDINARY `ToString` on
// an object `message`, not throw.
//
// §20.5.1.1 step 3 (`Error`), §20.5.7.1 step 5a (`AggregateError`) and
// §20.5.10.1 step 6a (`SuppressedError`) are all `? ToString(message)`. A
// compiled object literal is a WasmGC struct, and a struct crosses to the host
// constructor OPAQUELY — so V8's own `new Error(msg)` ran ToString on something
// it cannot introspect and raised `TypeError: Cannot convert object to
// primitive value`. Every object message over-threw:
//
//     new Error({ toString() { return "msg" } })   // threw; spec: message "msg"
//     new Error({ a: 1 })                          // threw; spec: "[object Object]"
//
// The test262 signature is "Expected a Test262Error but got a TypeError" in the
// `message-tostring-abrupt.js` family, where the message object's coercion
// method is supposed to run and throw the harness's own error.
//
// This is the same bug class #1716 already fixed for `RegExp` / `Date` /
// `String` / `Number` — the Error family was simply never added. The fix lives
// entirely in `src/runtime.ts` (`_errorMessageToString` plus the extern-class
// message-argument arm), so no compiled module changes at all.
//
// Two shapes are pinned as KNOWN RESIDUALS rather than as correct behaviour,
// with the reason inline: an object message at MODULE scope, and a struct whose
// only coercion method is `valueOf`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string, options: Record<string, unknown> = {}): Promise<any> {
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    ...options,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

/** Compile `body` as the whole of an exported `f()` and call it. */
async function f(body: string, ret = "string", options: Record<string, unknown> = {}): Promise<any> {
  const exports = await run(`export function f(): ${ret} { ${body} }`, options);
  return exports.f();
}

const TO_STRING_OBJ = `{ toString() { return "msg"; } }`;

describe("#3481 cause 2 — object message is stringified, not rejected", () => {
  it("a toString METHOD supplies the message", async () => {
    expect(await f(`const e: any = new Error(${TO_STRING_OBJ} as any); return String(e.message);`)).toBe("msg");
  });

  it("a toString PROPERTY supplies the message", async () => {
    expect(
      await f(
        `const e: any = new Error({ toString: function () { return "msg"; } } as any); return String(e.message);`,
      ),
    ).toBe("msg");
  });

  it("an object with NO coercion method keeps its pre-existing throw", async () => {
    // KNOWN RESIDUAL, unchanged from base. The spec answer is "[object Object]"
    // (a real object inherits `Object.prototype.toString`), but once both
    // walkers have bottomed out this shape is indistinguishable from
    // `{toString: undefined, valueOf: undefined}` — which §7.1.1.1 step 6 says
    // MUST throw, and which two test262 rows assert. Answering "[object Object]"
    // here regressed both of them, so this slice claims only the shapes it can
    // answer without guessing.
    await expect(f(`const e: any = new Error({ a: 1 } as any); return String(e.message);`)).rejects.toThrow(TypeError);
  });

  it("an object whose toString/valueOf are explicitly undefined THROWS (§7.1.1.1 step 6)", async () => {
    // The exact shape `built-ins/Error/error-message-tostring-toprimitive.js`
    // and its NativeErrors twin assert. Both PASS on base and must keep passing.
    await expect(
      f(`const e: any = new Error({ toString: undefined, valueOf: undefined } as any); return String(e.message);`),
    ).rejects.toThrow(TypeError);
  });

  it("a @@toPrimitive returning a SYMBOL throws rather than yielding a message", async () => {
    // §7.1.17 step 3 — ToString(Symbol) is a TypeError. A native symbol reaches
    // the host boundary as a bare i32 id, so no `typeof === "symbol"` test can
    // see it; the slice refuses a NUMERIC primitive instead and falls back to
    // the throw. Guards
    // `built-ins/AggregateError/message-tostring-abrupt-symbol.js`, which this
    // rule was written to stop regressing.
    await expect(
      f(`const e: any = new Error({ [Symbol.toPrimitive]() { return Symbol(); } } as any); return String(e.message);`),
    ).rejects.toThrow(TypeError);
  });

  it("once @@toPrimitive has answered, toString/valueOf must NOT run", async () => {
    // §7.1.1 step 2 ends ToPrimitive. An earlier cut fell through to a SECOND
    // walker whenever the first walker's answer could not be stringified — and
    // because the two walkers dispatch different methods, `toString` then ran
    // and ITS error escaped. The row reported that as "Expected a TypeError but
    // got a undefined". This pins the ordering: the escaping error must be the
    // ToString TypeError, never the sibling method's.
    await expect(
      f(
        `const e: any = new Error({ [Symbol.toPrimitive]() { return Symbol(); }, toString() { throw new Error("toString ran"); }, valueOf() { throw new Error("valueOf ran"); } } as any); return String(e.message);`,
      ),
    ).rejects.toThrow("Cannot convert object to primitive value");
  });

  it("an @@toPrimitive PROPERTY wins over nothing else", async () => {
    expect(
      await f(
        `const e: any = new Error({ [Symbol.toPrimitive]: function () { return "tp"; } } as any); return String(e.message);`,
      ),
    ).toBe("tp");
  });

  it("an @@toPrimitive METHOD beats toString (§7.1.1 step 2)", async () => {
    expect(
      await f(
        `const e: any = new Error({ [Symbol.toPrimitive]() { return "tp"; }, toString() { return "no"; } } as any); return String(e.message);`,
      ),
    ).toBe("tp");
  });

  it("an explicitly-undefined @@toPrimitive slot is SKIPPED, not read as a method (§7.1.1 step 2b)", async () => {
    expect(
      await f(
        `const e: any = new Error({ [Symbol.toPrimitive]: undefined, toString() { return "ts"; } } as any); return String(e.message);`,
      ),
    ).toBe("ts");
  });

  // One case per intrinsic error name: the constructors are claimed by name in
  // codegen, so a name missing from the runtime's message-argument list would
  // over-throw on its own while its siblings passed.
  for (const [name, want] of [
    ["TypeError", "m1"],
    ["RangeError", "m2"],
    ["SyntaxError", "m3"],
    ["EvalError", "m4"],
    ["URIError", "m5"],
    ["ReferenceError", "m6"],
  ] as const) {
    it(`${name} stringifies an object message`, async () => {
      expect(
        await f(`const e: any = new ${name}({ toString() { return "${want}"; } } as any); return String(e.message);`),
      ).toBe(want);
    });
  }

  it("AggregateError stringifies an object message", async () => {
    expect(
      await f(
        `const e: any = new AggregateError([], { toString() { return "ag"; } } as any); return String(e.message);`,
      ),
    ).toBe("ag");
  });

  it("the constructed value is still a real, branded error", async () => {
    // The export marshals a boolean as an i32, so compare truthily rather than
    // against `true`.
    expect(
      await f(`const e: any = new TypeError(${TO_STRING_OBJ} as any); return e instanceof TypeError;`, "boolean"),
    ).toBeTruthy();
    expect(await f(`const e: any = new RangeError(${TO_STRING_OBJ} as any); return String(e.name);`)).toBe(
      "RangeError",
    );
  });
});

describe("#3481 cause 2 — abrupt completions propagate (the test262 assertion)", () => {
  // Transcribed from built-ins/AggregateError/message-tostring-abrupt.js, whose
  // three cases each select a DIFFERENT rung of §7.1.1 and assert that the
  // harness's own error — not a TypeError — escapes the constructor.
  const T262 = `class Test262Error extends Error {}`;
  const caught = (ctor: string, obj: string) =>
    `${T262}
export function f(): string {
  try { ${ctor}; return "NO-THROW"; }
  catch (e: any) { return e instanceof Test262Error ? "T262" : "OTHER:" + String(e && e.message ? e.message : e); }
}`.replace("$OBJ", obj);

  it("case1 — an @@toPrimitive method's throw wins over toString/valueOf", async () => {
    const src = caught(
      `new AggregateError([], { [Symbol.toPrimitive]() { throw new Test262Error("x"); }, toString() { throw "toString called"; }, valueOf() { throw "valueOf called"; } } as any)`,
      "",
    );
    expect((await run(src)).f()).toBe("T262");
  });

  it("case2 — with @@toPrimitive undefined, toString's throw wins over valueOf", async () => {
    const src = caught(
      `new AggregateError([], { [Symbol.toPrimitive]: undefined, toString() { throw new Test262Error("x"); }, valueOf() { throw "valueOf called"; } } as any)`,
      "",
    );
    expect((await run(src)).f()).toBe("T262");
  });

  it("case3 — with both undefined, valueOf's throw escapes", async () => {
    const src = caught(
      `new AggregateError([], { [Symbol.toPrimitive]: undefined, toString: undefined, valueOf() { throw new Test262Error("x"); } } as any)`,
      "",
    );
    expect((await run(src)).f()).toBe("T262");
  });

  it("the same propagation holds for the plain Error constructor", async () => {
    const src = caught(`new Error({ toString() { throw new Test262Error("x"); } } as any)`, "");
    expect((await run(src)).f()).toBe("T262");
  });

  it("a non-Error thrown value propagates unchanged too", async () => {
    // Guards the narrow catch in `_errorMessageToString`: only the walker's own
    // "Cannot convert object to primitive value" verdict may be absorbed. A
    // thrown STRING must not be turned into "[object Object]".
    expect(
      await f(
        `try { new Error({ toString() { throw "boom"; } } as any); return "NO-THROW"; } catch (e: any) { return String(e); }`,
      ),
    ).toBe("boom");
  });

  it("the coercion method runs exactly once", async () => {
    expect(await f(`let n = 0; new Error({ toString() { n++; return "x"; } } as any); return n;`, "number")).toBe(1);
  });
});

describe("#3481 cause 2 — regression guards: shapes that must NOT change", () => {
  it("a string message is untouched", async () => {
    expect(await f(`const e: any = new Error("hello"); return String(e.message);`)).toBe("hello");
  });

  it("a number message still stringifies to its digits", async () => {
    expect(await f(`const e: any = new Error(42 as any); return String(e.message);`)).toBe("42");
  });

  it("a boolean message still stringifies", async () => {
    expect(await f(`const e: any = new Error(true as any); return String(e.message);`)).toBe("true");
  });

  it("an absent message still leaves the message empty", async () => {
    expect(await f(`const e: any = new Error(); return String(e.message);`)).toBe("");
  });

  it("an explicitly-undefined message still leaves the message empty", async () => {
    expect(await f(`const e: any = new Error(undefined as any); return String(e.message);`)).toBe("");
  });

  it("a null message keeps its pre-existing answer", async () => {
    // §20.5.1.1 exempts only `undefined`, so the spec answer is "null". We
    // answer "" — a KNOWN RESIDUAL predating this slice (see the #4035 note in
    // `new-builtin-globals.ts`) and deliberately left alone, because `null` is
    // not a struct and never reached the over-throw. Pinned so a future fix
    // updates this expectation rather than flipping an untested path.
    expect(await f(`const e: any = new Error(null as any); return String(e.message);`)).toBe("");
  });

  it("a genuine HOST object message is unchanged (not a wasm struct)", async () => {
    expect(await f(`const e: any = new Error(new Object() as any); return String(e.message);`)).toBe("[object Object]");
  });

  it("an array message still joins rather than becoming [object Object]", async () => {
    expect(await f(`const e: any = new Error([1, 2] as any); return String(e.message);`)).toBe("1,2");
  });

  it("Error.prototype.toString rendering is unchanged", async () => {
    expect(await f(`const e: any = new Error("x"); return String(e);`)).toBe("Error: x");
  });

  it("AggregateError's ERRORS argument is NOT coerced to a primitive", async () => {
    // The fix is a single-INDEX coercion precisely so this cannot happen: the
    // iterable at index 0 must survive as a list. Joining `coercesArgsToPrimitive`
    // (which walks every argument) would have destroyed it.
    expect(await f(`const e: any = new AggregateError([1, 2], "m"); return e.errors.length;`, "number")).toBe(2);
    expect(await f(`const e: any = new AggregateError([1, 2], "m"); return String(e.message);`)).toBe("m");
  });

  it("the OPTIONS argument is NOT coerced — its toString never runs", async () => {
    // The other reason for the index restriction. An options bag is consumed
    // as an object (HasProperty "cause"); coercing it would both destroy it and
    // run user code the spec never calls. The bag's `toString` throws, so if it
    // were coerced this row would not return.
    //
    // (`options.cause` itself is a separate PRE-EXISTING gap — measured
    // identical on base and on this branch, `e.cause` is absent for both
    // `Error` and `AggregateError` — so it is deliberately not asserted here.)
    expect(
      await f(
        `const e: any = new AggregateError([], { toString() { return "m"; } } as any, { toString() { throw "options coerced"; } } as any); return String(e.message);`,
      ),
    ).toBe("m");
    expect(
      await f(
        `const e: any = new Error({ toString() { return "m"; } } as any, { toString() { throw "options coerced"; } } as any); return String(e.message);`,
      ),
    ).toBe("m");
  });

  it("a string message on AggregateError is untouched", async () => {
    expect(await f(`const e: any = new AggregateError([], "ag"); return String(e.message);`)).toBe("ag");
  });
});

describe("#3481 cause 2 — known residuals, pinned deliberately", () => {
  it("an object message at MODULE scope keeps its pre-existing throw", async () => {
    // `__module_init` is the wasm START function: it runs inside
    // `WebAssembly.instantiate`, BEFORE the host runtime is handed
    // `instance.exports`, so no walker can call the module's own `toString` and
    // both bottom out. That is the blocker documented in this issue's step-3
    // record and sized there as a non-slice, so the throw is UNCHANGED from
    // base — pinned, not endorsed.
    await expect(
      run(
        `const e: any = new Error({ toString() { return "ms"; } } as any);
         export function f(): string { return String(e.message); }`,
      ),
    ).rejects.toThrow(TypeError);
  });

  it("a valueOf-only object keeps its pre-existing throw", async () => {
    // A `valueOf` returning a NUMBER is refused on purpose: a native Symbol
    // crosses this boundary as a bare i32 id, so a numeric primitive cannot be
    // told apart from `@@toPrimitive` returning `Symbol()` — which must throw.
    // Refusing keeps base behaviour for both; accepting regressed the symbol
    // row. (V8 answers "[object Object]" here anyway, via the inherited
    // `Object.prototype.toString` that neither walker models.)
    await expect(
      f(`const e: any = new Error({ valueOf() { return 5; } } as any); return String(e.message);`),
    ).rejects.toThrow(TypeError);
  });
});
