// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { compile } from "../src/index.js";
import { compileMultiSource } from "../src/compiler.js";

async function createRealm(lexicals = false) {
  const provider = lexicals
    ? await readFile(new URL("../examples/v8x-js2wasm-spike/script-lexical-provider.ts", import.meta.url), "utf8")
    : "";
  const result = await compile(
    provider +
      `
    export function realm():any {return globalThis;}
    export function get(object:any,key:any,receiver:any):any {return Reflect.get(object,key,receiver);}
    export function observed():number {return (globalThis as any).published===42 ? 42 : -1;}
    export function observedNumber():number {return Number((globalThis as any).published);}
    export function saved():any {return (globalThis as any).saved;}
    export function installAccessor():void {
      let count=0;
      Object.defineProperty(globalThis,"published",{configurable:true,
        get(){return ++count;}, set(value:any){count=Number(value);}});
    }
    export function score():number {return Number((globalThis as any).score);}
    export function installThrowingAccessor():any {
      const reason={marker:42};
      Object.defineProperty(globalThis,"published",{configurable:true,get(){throw reason;}});
      return reason;
    }
    export function caught():any {return (globalThis as any).caught;}
    ${
      lexicals
        ? `
    let lastLexicalOperation=0;
    let lexicalWrites=0;
    export function tracedLexical(name:any,operation:number,value:any):any {
      lastLexicalOperation=operation;
      if(operation===6) lexicalWrites++;
      return scriptLexicalOperation(name,operation,value);
    }
    export function lexicalTrace():number {return lastLexicalOperation;}
    export function writeCount():number {return lexicalWrites;}
    export function caughtKind():number {
      const error:any=(globalThis as any).caught;
      return error===undefined?0:error.name==="TypeError"?2:error.name==="ReferenceError"?1:3;
    }
    export function retainedNumber():number {return Number(scriptLexicalOperation("retained",5,undefined));}
    export function hasRetained():boolean {return Boolean(scriptLexicalOperation("retained",9,undefined));}
    export function hasFirst():boolean {return Boolean(scriptLexicalOperation("first",9,undefined));}
    `
        : ""
    }
  `,
    { target: "standalone", standaloneAllocationOwnerExport: "owns" },
  );
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(result.binary), result.importObject);
}

async function runScript(owner: WebAssembly.Instance, source: string, sharedBindings = false, lexicals = false) {
  const result = await compile(source, {
    target: "standalone",
    scriptGoal: true,
    allowJs: true,
    fileName: "script.ts",
    hostBridge: "always",
    standaloneScriptVarBindings: sharedBindings,
    ...(lexicals ? { standaloneScriptLexicalImport: { module: "context", name: "tracedLexical" } } : {}),
    standaloneAllocationOwnerExport: "localOwns",
    standaloneGlobalThisImport: {
      module: "context",
      name: "realm",
      owns: "owns",
      get: "get",
      exceptionTag: "__exn_tag",
    },
    link: ["context"],
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  return new WebAssembly.Instance(new WebAssembly.Module(result.binary), { context: owner.exports });
}

it("executes explicit property writes in the shared realm without wrapping Script source", async () => {
  const realm = await createRealm();
  await runScript(realm, "globalThis.published=41;");
  expect((realm.exports.observed as Function)()).toBe(-1);
  await runScript(realm, "globalThis.published=42;");
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("keeps a dynamic lexical value in the owning Context without exposing a property", async () => {
  const realm = await createRealm(true);
  await runScript(realm, "let retained:any=41; retained+=1; globalThis.published=retained;", true, true);
  expect((realm.exports.observed as Function)()).toBe(42);
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  await runScript(realm, "globalThis.published=retained;", true, true);
  expect((realm.exports.observed as Function)()).toBe(42);
  await runScript(
    realm,
    'if(Object.prototype.hasOwnProperty.call(globalThis,"retained")) throw new Error("leaked lexical");',
    true,
    true,
  );
});

it("rejects a lexical redeclaration before user code and before creating earlier cells", async () => {
  const realm = await createRealm(true);
  await runScript(realm, "let retained:any=42;", true, true);
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  await expect(
    runScript(realm, "let first:any=1; let retained:any=0; globalThis.published=0;", true, true),
  ).rejects.toBeInstanceOf(WebAssembly.Exception);
  expect((realm.exports.hasFirst as Function)()).toBe(0);
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  expect((realm.exports.observed as Function)()).toBe(-1);
});

it("retains an uninitialized lexical after an abrupt initializer", async () => {
  const realm = await createRealm(true);
  await expect(
    runScript(realm, 'let retained:any=(()=>{throw new Error("abort");})();', true, true),
  ).rejects.toBeInstanceOf(WebAssembly.Exception);
  expect((realm.exports.hasRetained as Function)()).toBe(1);
  expect(() => (realm.exports.retainedNumber as Function)()).toThrow(WebAssembly.Exception);
  await expect(runScript(realm, "globalThis.published=retained;", true, true)).rejects.toBeInstanceOf(
    WebAssembly.Exception,
  );
});

it("keeps lexical cells isolated between Contexts", async () => {
  const first = await createRealm(true);
  const second = await createRealm(true);
  await runScript(first, "let retained:any=42;", true, true);
  await runScript(second, "let retained:any=41;", true, true);
  await runScript(first, "globalThis.published=retained;", true, true);
  await runScript(second, "globalThis.published=retained;", true, true);
  expect((first.exports.observedNumber as Function)()).toBe(42);
  expect((second.exports.observedNumber as Function)()).toBe(41);
});

it("writes an existing lexical from a later Script without creating a global property", async () => {
  const realm = await createRealm(true);
  await runScript(realm, "let retained:any=41;", true, true);
  await runScript(realm, "retained=42; globalThis.published=retained;", true, true);
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  expect((realm.exports.observed as Function)()).toBe(42);
  await runScript(
    realm,
    'globalThis.published=Object.prototype.hasOwnProperty.call(globalThis,"retained")?0:42;',
    true,
    true,
  );
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("writes an existing lexical from strict Script code and evaluates the RHS once", async () => {
  const realm = await createRealm(true);
  await runScript(realm, "let retained:any=41;", true, true);
  await runScript(
    realm,
    '"use strict"; globalThis.score=0; retained=(++globalThis.score,42); globalThis.published=retained;',
    true,
    true,
  );
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  expect((realm.exports.score as Function)()).toBe(1);
  expect((realm.exports.writeCount as Function)()).toBe(1);
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("checks const mutability in a later Script after evaluating the RHS", async () => {
  const realm = await createRealm(true);
  await runScript(realm, "const retained:any=41;", true, true);
  await runScript(
    realm,
    '"use strict"; globalThis.score=0; try {retained=(++globalThis.score,42);} catch(error){globalThis.caught=error;}',
    true,
    true,
  );
  expect((realm.exports.retainedNumber as Function)()).toBe(41);
  expect((realm.exports.score as Function)()).toBe(1);
  expect((realm.exports.caughtKind as Function)()).toBe(2);
});

it("preserves strict global misses and sloppy global writes when no lexical exists", async () => {
  const realm = await createRealm(true);
  await runScript(
    realm,
    '"use strict"; globalThis.score=0; try {missing=(++globalThis.score,42);} catch(error){globalThis.caught=error;}',
    true,
    true,
  );
  expect((realm.exports.score as Function)()).toBe(1);
  expect((realm.exports.caughtKind as Function)()).toBe(1);
  await runScript(realm, "missing=42; globalThis.published=missing;", true, true);
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("preserves a const cell after an attempted write", async () => {
  const realm = await createRealm(true);
  await runScript(
    realm,
    "const retained:any=42; try {retained=0;} catch(error) {globalThis.caught=error;}",
    true,
    true,
  );
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  expect((realm.exports.caught as Function)()).toBeDefined();
});

it("rejects a var declaration conflicting with a prior lexical before effects", async () => {
  const realm = await createRealm(true);
  await runScript(realm, "let retained:any=42;", true, true);
  await expect(runScript(realm, "var retained:any; globalThis.published=0;", true, true)).rejects.toBeInstanceOf(
    WebAssembly.Exception,
  );
  expect((realm.exports.retainedNumber as Function)()).toBe(42);
  expect((realm.exports.observed as Function)()).toBe(-1);
});

it("shares dynamic Script var values and preserves initializer-free redeclarations", async () => {
  const realm = await createRealm();
  await runScript(realm, "var published:any=41; published=42;", true);
  expect((realm.exports.observed as Function)()).toBe(42);
  await runScript(realm, "var published:any;", true);
  expect((realm.exports.observed as Function)()).toBe(42);
  await runScript(realm, "var published:any; published+=1;", true);
  expect((realm.exports.observedNumber as Function)()).toBe(43);
});

it("shares an untouched JavaScript var without a type annotation", async () => {
  const realm = await createRealm();
  await runScript(realm, "var published; published=41; published=42;", true);
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("reads shared var writes made by another Script through both identifier and property spellings", async () => {
  const realm = await createRealm();
  await runScript(realm, "var published:any=41;", true);
  await runScript(realm, 'globalThis.published="text";', true);
  await runScript(
    realm,
    'var published:any; if(published!=="text" || globalThis.published!==published) throw new Error("stale binding"); published=42;',
    true,
  );
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("reads current shared values in an escaping callback from an earlier Script", async () => {
  const realm = await createRealm();
  const earlier = await runScript(
    realm,
    "var published:any=41; function update(){published+=1;} globalThis.saved=update;",
    true,
  );
  await runScript(realm, "globalThis.published=42;", true);
  const callback = (realm.exports.saved as Function)();
  (earlier.exports.__call_fn_method_0 as Function)(undefined, callback);
  expect((realm.exports.observedNumber as Function)()).toBe(43);
});

it("preserves a shared write when Script evaluation completes abruptly", async () => {
  const realm = await createRealm();
  await expect(
    runScript(realm, 'var published:any=41; published=42; throw new Error("abort");', true),
  ).rejects.toBeInstanceOf(WebAssembly.Exception);
  expect((realm.exports.observed as Function)()).toBe(42);
});

it("keeps Context-owned var bindings isolated between two realms", async () => {
  const first = await createRealm();
  const second = await createRealm();
  await runScript(first, "var published:any=42;", true);
  await runScript(second, "var published:any=41;", true);
  expect((first.exports.observed as Function)()).toBe(42);
  expect((second.exports.observedNumber as Function)()).toBe(41);
});

it("does not collapse repeated reads of an existing global accessor", async () => {
  const realm = await createRealm();
  (realm.exports.installAccessor as Function)();
  await runScript(realm, "var published:any; globalThis.score=published+published;", true);
  expect((realm.exports.score as Function)()).toBe(3);
});

it("catches a shared getter exception with its original realm value", async () => {
  const realm = await createRealm();
  const reason = (realm.exports.installThrowingAccessor as Function)();
  await runScript(
    realm,
    "var published:any; try { globalThis.score=published; } catch(reason) { globalThis.caught=reason; }",
    true,
  );
  expect((realm.exports.caught as Function)()).toBe(reason);
});

it("refuses private typed-slot proofs rather than coercing a foreign value silently", async () => {
  const realm = await createRealm();
  const result = await compile("var published=42;", {
    target: "standalone",
    scriptGoal: true,
    standaloneScriptVarBindings: true,
    standaloneGlobalThisImport: {
      module: "context",
      name: "realm",
      owns: "owns",
      get: "get",
      exceptionTag: "__exn_tag",
    },
    link: ["context"],
  });
  expect(result.success).toBe(false);
  expect(result.errors.map((error) => error.message).join("\n")).toContain("private typed-slot proofs");
  expect((realm.exports.observed as Function)()).toBe(-1);
});

it("keeps the opt-in inactive for ordinary compilation", async () => {
  const source = "var published=41; published=42;";
  const ordinary = await compile(source, { target: "standalone" });
  const explicitOff = await compile(source, { target: "standalone", standaloneScriptVarBindings: false });
  expect(ordinary.success && explicitOff.success).toBe(true);
  expect(explicitOff.binary).toEqual(ordinary.binary);
});

it("refuses to treat a flattened module graph as independent Script evaluations", async () => {
  await expect(
    compileMultiSource({ "script.ts": "var published:any=42;" }, "script.ts", {
      target: "standalone",
      scriptGoal: true,
      standaloneScriptVarBindings: true,
      standaloneGlobalThisImport: {
        module: "context",
        name: "realm",
        owns: "owns",
        get: "get",
        exceptionTag: "__exn_tag",
      },
      link: ["context"],
    }),
  ).rejects.toThrow("flattened module graph");
});

// Expected failures are acceptance gaps, not passing conformance credit.
// Remove `.fails` when canonical persistent Script bindings are implemented.
it.fails("publishes Script var initialization and assignment to the shared global object", async () => {
  const realm = await createRealm();
  await runScript(realm, "var published=41; published=42;");
  expect((realm.exports.observed as Function)()).toBe(42);
});

it.fails("retains Script lexical bindings for a later independently compiled Script", async () => {
  const realm = await createRealm();
  await runScript(realm, "let retained=41;");
  await runScript(realm, "retained+=1; globalThis.published=retained;");
  expect((realm.exports.observed as Function)()).toBe(42);
});
