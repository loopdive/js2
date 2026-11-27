---
id: 7520
title: "Native core: an arrow function crossing to JS is constructible (`Reflect.construct` does not throw)"
status: ready
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [3214, 6979, 7521, 7516]
---

# #7520: arrow functions are constructible after crossing to JS

## Problem

Measured by lane S25 on main `1a726b3e` (2026-11-26), default JS target. The result is the same with
`experimentalIR` on and off:

```ts
export function install(target: EventTarget, sink: HTMLElement, value: number): void {
  target.addEventListener("tick", () => { sink.textContent = String(value); });
}
```

The listener that reaches the host runs correctly: it returns `undefined` and sets `sink.textContent`. But
`Reflect.construct(listener, [])` does not throw. An arrow function has no `[[Construct]]` (ECMA-262 §10.2.1,
OrdinaryFunctionCreate with `thisMode` lexical, without MakeConstructor), so it must throw `TypeError`.

## Where it was found

`tests/issue-3214-void-host-callback.test.ts` pinned `semanticProviders: "host-assisted"`, which #6979 S7 removed.
The file's own note says S7 retires that pin. Retiring it and asserting native semantics instead of the host lane's
`__make_callback` WAT shape leaves 5 of 30 cases red:

| case | bug |
|---|---|
| dispatches the IR callback twice (optimize = false, true) | this issue |
| keeps an ordinary closure allocation of the same wrapper callable from JS | #7516 (a returned `(): void => {}` crosses as `{}`) |
| a source function named `__make_callback` does not hijack the callback crossing; runs a callback component … with a source `__make_callback` | #7521 |

Lead decision (2026-11-26): issue-3214 stays unchanged on main for now. The rewrite below is this issue's acceptance
test and lands with the fixes (#7520 and #7521; the #7516 case needs its own decision, because the JS-host lane is
being sunset).

**Note for whoever lands it:** the rewrite also drops two non-semantic checks of the cross-source case: that
`installOther` is IR-claimed (on main only `installEntry` is) and that there are at least 2 `__ir_closure_*`
subtypes (on main there is 1). Decide in that PR whether those were deliberate #3214 guarantees that must be restored.

## Acceptance criteria

- `Reflect.construct(listener, [])` throws `TypeError` for an arrow listener crossing to JS, on the default target.
- The acceptance test below applies to main and its two "dispatches the IR callback twice" cases pass.

## Acceptance test (patch to `tests/issue-3214-void-host-callback.test.ts`, against main `1a726b3e`)

```diff
diff --git a/tests/issue-3214-void-host-callback.test.ts b/tests/issue-3214-void-host-callback.test.ts
index d6f6a19a..8e0b5629 100644
--- a/tests/issue-3214-void-host-callback.test.ts
+++ b/tests/issue-3214-void-host-callback.test.ts
@@ -27,25 +27,29 @@ async function compileHostCallback(
 }
 
 // The B2 host-bridge shape (`__make_callback` maker + generic closure bridge
-// exports) is the host-assisted lane's crossing; the #7091 platform lane passes
-// the packed closure as a marshalled carrier instead. S7 (#6979) retires the pin.
-const HOST_ASSISTED: CompileOptions = { semanticProviders: "host-assisted" };
-
-function watFunctionBody(wat: string, name: string): string {
-  const start = wat.indexOf(`  (func $${name}`);
-  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
-  const next = wat.indexOf("\n  (func $", start + 1);
-  return wat.slice(start, next < 0 ? wat.length : next);
+// exports) was the host-assisted lane's crossing; the #7091 platform lane passes
+// the packed closure as a marshalled carrier instead. As this file's note said,
+// S7 (#6979) retires the host-assisted pin: the cases below assert what the
+// native core does with each callback (the listener's runtime behaviour), not
+// the host lane's `__make_callback` wiring.
+
+/** Compile, instantiate and return the JS-facing (adapter-wrapped) exports. */
+async function instantiateCallbacks(result: CompileResult): Promise<Record<string, Function>> {
+  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
+  expect(WebAssembly.validate(result.binary)).toBe(true);
+  const imports = buildImports(result.imports, undefined, result.stringPool);
+  const { instance } = await WebAssembly.instantiate(result.binary, imports);
+  imports.setExports?.(instance.exports as Record<string, Function>);
+  return wrapCompiledExports(result, instance) as Record<string, Function>;
 }
 
-function wasmFunctionImportIndex(binary: Uint8Array, name: string): number {
-  let functionIndex = 0;
-  for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
-    if (entry.kind !== "function") continue;
-    if (entry.name === name) return functionIndex;
-    functionIndex++;
-  }
-  return -1;
+/** A minimal EventTarget that records each registered listener by type. */
+function recordingTarget(): { target: object; listeners: Map<string, Function> } {
+  const listeners = new Map<string, Function>();
+  return {
+    target: { addEventListener: (type: string, listener: Function) => listeners.set(type, listener) },
+    listeners,
+  };
 }
 
 describe("#3214 B2 — ambient void host callbacks", () => {
@@ -87,87 +91,48 @@ describe("#3214 B2 — ambient void host callbacks", () => {
   });
 
   it.each([false, true])("dispatches the IR callback twice (optimize=%s)", async (optimize) => {
-    const result = await compileHostCallback(HOST_CALLBACK_SOURCE, { ...HOST_ASSISTED, optimize });
-    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-    expect(WebAssembly.validate(result.binary)).toBe(true);
+    const result = await compileHostCallback(HOST_CALLBACK_SOURCE, { optimize });
     expect(result.irCompiledFuncs ?? []).toContain("install");
     expect(result.irPostClaimErrors ?? []).toEqual([]);
+    const exports = await instantiateCallbacks(result);
 
-    const installBody = watFunctionBody(result.wat, "install");
-    expect(installBody).toContain("i32.const -2");
-    const callbackMakerIndex = wasmFunctionImportIndex(result.binary, "__make_callback");
-    expect(callbackMakerIndex).toBeGreaterThanOrEqual(0);
-    expect(installBody).toContain(`call ${callbackMakerIndex}`);
-    expect(result.wat).toContain("(func $install__closure_0");
-    const voidWrapperType = result.wat
-      .split("\n")
-      .find((line) => /\$__fn_wrap_\d+_type \(func/.test(line) && !line.includes("(result "));
-    expect(voidWrapperType, "missing canonical zero-result closure type").toBeDefined();
-
-    const imports = buildImports(result.imports, undefined, result.stringPool);
-    const { instance } = await WebAssembly.instantiate(result.binary, imports);
-    imports.setExports?.(instance.exports as Record<string, Function>);
-
-    const bridgeExports = Object.keys(instance.exports);
-    expect(bridgeExports).toContain("__call_fn_0");
-    expect(bridgeExports).not.toEqual(
-      expect.arrayContaining([
-        "__call_fn_1",
-        "__call_fn_method_0",
-        "__closure_arity",
-        "__is_closure",
-        "__closure_has_rest",
-      ]),
-    );
-
-    const listeners: Function[] = [];
-    const target = {
-      addEventListener(_type: string, listener: Function): void {
-        listeners.push(listener);
-      },
-    };
+    const { target, listeners } = recordingTarget();
     const sink = { textContent: "" };
-    (instance.exports.install as (target: object, sink: object, value: number) => void)(target, sink, 42);
+    exports.install!(target, sink, 42);
 
-    expect(listeners).toHaveLength(1);
-    const listener = listeners[0]!;
+    expect([...listeners.keys()]).toEqual(["tick"]);
+    const listener = listeners.get("tick")!;
     expect(listener({ type: "tick" })).toBeUndefined();
     expect(sink.textContent).toBe("42");
     sink.textContent = "";
     expect(listener({ type: "tick" })).toBeUndefined();
     expect(sink.textContent).toBe("42");
+    // An arrow function is not a constructor (§10.2.1 [[Construct]] absent).
     expect(() => Reflect.construct(listener, [])).toThrow(TypeError);
   });
 
-  it("restores generic closure bridges when the same wrapper has an ordinary allocation", async () => {
-    const result = await compileHostCallback(
-      `
+  it("keeps an ordinary closure allocation of the same wrapper callable from JS", async () => {
+    const result = await compileHostCallback(`
       export function install(target: EventTarget, sink: HTMLElement): void {
         target.addEventListener("tick", () => { sink.textContent = "exact"; });
       }
       export function getOrdinary(): any {
         return (): void => {};
       }
-    `,
-      HOST_ASSISTED,
-    );
-
-    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-    expect(WebAssembly.validate(result.binary)).toBe(true);
+    `);
     expect(result.irCompiledFuncs ?? []).toContain("install");
     expect(result.irPostClaimErrors ?? []).toEqual([]);
+    const exports = await instantiateCallbacks(result);
 
-    const imports = buildImports(result.imports, undefined, result.stringPool);
-    const { instance } = await WebAssembly.instantiate(result.binary, imports);
-    imports.setExports?.(instance.exports as Record<string, Function>);
-    const bridgeExports = Object.keys(instance.exports);
-    expect(bridgeExports).toEqual(
-      expect.arrayContaining(["__call_fn_0", "__call_fn_1", "__call_fn_method_0", "__closure_arity", "__is_closure"]),
-    );
+    const ordinary = exports.getOrdinary!() as Function;
+    expect(typeof ordinary).toBe("function");
+    expect(ordinary()).toBeUndefined();
 
-    const ordinary = (instance.exports.getOrdinary as () => unknown)();
-    expect((instance.exports.__is_closure as (value: unknown) => number)(ordinary)).toBe(1);
-    expect((instance.exports.__call_fn_0 as (value: unknown) => unknown)(ordinary)).toBeNull();
+    const { target, listeners } = recordingTarget();
+    const sink = { textContent: "" };
+    exports.install!(target, sink);
+    expect(listeners.get("tick")!()).toBeUndefined();
+    expect(sink.textContent).toBe("exact");
   });
 
   it("keeps multiple certified callback sites distinct in source order", async () => {
@@ -344,25 +309,28 @@ describe("#3214 B2 — ambient void host callbacks", () => {
     expect(result.irPostClaimErrors ?? []).toEqual([]);
   });
 
-  it("demotes when __make_callback resolves to a defined function instead of the exact host import", async () => {
-    const result = await compileHostCallback(
-      `
+  it("a source function named __make_callback does not hijack the callback crossing", async () => {
+    const result = await compileHostCallback(`
       type i32 = number;
       function __make_callback(_id: i32, capture: object): object { return capture; }
       export function install(target: EventTarget, sink: HTMLElement): void {
         target.addEventListener("tick", () => { sink.textContent = "x"; });
       }
-    `,
-      HOST_ASSISTED,
-    );
-
-    expect(result.irCompiledFuncs ?? []).not.toContain("install");
+    `);
     expect(result.irPostClaimErrors ?? []).toEqual([]);
+    const exports = await instantiateCallbacks(result);
+
+    const { target, listeners } = recordingTarget();
+    const sink = { textContent: "" };
+    exports.install!(target, sink);
+    const listener = listeners.get("tick")!;
+    expect(typeof listener).toBe("function");
+    expect(listener()).toBeUndefined();
+    expect(sink.textContent).toBe("x");
   });
 
-  it("keeps a potentially final-demoted B2 call component out of the IR-first skip set", async () => {
-    const result = await compileHostCallback(
-      `
+  it("runs a callback component and an independent function with a source __make_callback", async () => {
+    const result = await compileHostCallback(`
       type i32 = number;
       function __make_callback(_id: i32, capture: object): object { return capture; }
       function install(n: number): number {
@@ -371,19 +339,23 @@ describe("#3214 B2 — ambient void host callbacks", () => {
       }
       export function caller(n: number): number { return install(n); }
       export function independent(n: number): number { return n + 1; }
-    `,
-      HOST_ASSISTED,
-    );
-
-    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-    expect(WebAssembly.validate(result.binary)).toBe(true);
-    expect(result.irCompiledFuncs ?? []).not.toContain("install");
-    expect(result.irCompiledFuncs ?? []).not.toContain("caller");
-    expect(result.irCompiledFuncs ?? []).toContain("independent");
+    `);
     expect(result.irPostClaimErrors ?? []).toEqual([]);
-    expect(result.irFirstSkipped ?? []).not.toContain("install");
-    expect(result.irFirstSkipped ?? []).not.toContain("caller");
-    expect(result.irFirstSkipped ?? []).toContain("independent");
+    expect(result.irCompiledFuncs ?? []).toContain("independent");
+
+    const { target, listeners } = recordingTarget();
+    const previous = (globalThis as { document?: unknown }).document;
+    (globalThis as { document?: unknown }).document = { body: target };
+    try {
+      const exports = await instantiateCallbacks(result);
+      expect(exports.caller!(5)).toBe(5);
+      expect(exports.independent!(5)).toBe(6);
+    } finally {
+      (globalThis as { document?: unknown }).document = previous;
+    }
+    const listener = listeners.get("tick")!;
+    expect(typeof listener).toBe("function");
+    expect(listener()).toBeUndefined();
   });
 
   it.each([
@@ -443,16 +415,22 @@ describe("#3214 B2 — ambient void host callbacks", () => {
         experimentalIR: true,
         trackFallbacks: true,
         skipSemanticDiagnostics: true,
-        ...HOST_ASSISTED,
       },
     );
 
-    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
-    expect(WebAssembly.validate(result.binary)).toBe(true);
-    expect(result.irCompiledFuncs ?? []).toEqual(expect.arrayContaining(["installOther", "installEntry"]));
+    expect(result.irCompiledFuncs ?? []).toContain("installEntry");
     expect(result.irPostClaimErrors ?? []).toEqual([]);
-    const subtypeNames = [...result.wat.matchAll(/\(type \$(__ir_closure_\d+)/g)].map((match) => match[1]);
-    expect(new Set(subtypeNames).size).toBeGreaterThanOrEqual(2);
+    const exports = await instantiateCallbacks(result);
+
+    // Each source's closure keeps its own captured body.
+    const { target, listeners } = recordingTarget();
+    const sink = { textContent: "" };
+    exports.installEntry!(target, sink);
+    exports.retainOther!(target, sink);
+    listeners.get("entry")!();
+    expect(sink.textContent).toBe("entry");
+    listeners.get("other")!();
+    expect(sink.textContent).toBe("other");
   });
 
   it("keeps B2 disabled and import-free in standalone", async () => {
```
