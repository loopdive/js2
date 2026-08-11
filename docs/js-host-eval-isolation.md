# Isolated JS-host eval

Dynamic `eval` and `new Function` can use another JavaScript realm while the
ahead-of-time compiled Wasm module remains in its original host. The runtime
accepts an explicit synchronous evaluator through `buildImports`:

```ts
const imports = buildImports(result.imports, undefined, result.stringPool, {
  dynamicCode: "evaluator",
  dynamicCodeEvaluator: evaluator,
});
const { instance } = await WebAssembly.instantiate(result.binary, imports);
imports.setInstance?.(instance);
```

The evaluator is synchronous because a normal Wasm import is synchronous. The
runtime also supports `dynamicCode: "deny"` for a fail-closed host and preserves
the existing `"compat"` behavior by default.

## Node.js eval Worker

Node can keep only the evaluator in a dedicated Worker. The AOT Wasm instance,
its memory, and the rest of the runtime stay in the calling thread. A small
`SharedArrayBuffer`/`Atomics` control channel makes the Worker request
synchronous; remote functions and objects are represented by synchronous
proxies backed by Worker handles.

Worker entry:

```ts
import { parentPort } from "node:worker_threads";
import { serveNodeEvalWorker } from "@loopdive/js2/runtime/node-eval-worker";

if (!parentPort) throw new Error("missing parentPort");
serveNodeEvalWorker(parentPort);
```

Host:

```ts
import { Worker } from "node:worker_threads";
import { compile } from "@loopdive/js2";
import { buildImports } from "@loopdive/js2/runtime";
import { connectNodeEvalWorker } from "@loopdive/js2/runtime/node-eval-worker";

const result = await compile(`
  export function run(source: any): any {
    let value: any = 40;
    eval(source);
    return value;
  }
`, { directEval: "reified-host" });
const worker = new Worker(new URL("./eval-worker.js", import.meta.url));
const evaluator = await connectNodeEvalWorker(worker, { timeoutMs: 1_000 });
const imports = buildImports(result.imports, undefined, result.stringPool, {
  dynamicCode: "evaluator",
  dynamicCodeEvaluator: evaluator,
});
const { instance } = await WebAssembly.instantiate(result.binary, imports);
imports.setInstance?.(instance);

console.log((instance.exports.run as Function)("value += 2")); // 42
await evaluator.terminate();
```

A deadline terminates the eval Worker, so infinite dynamic code cannot consume a
thread indefinitely. The calling Node thread is synchronously blocked until the
request completes or reaches that deadline; this preserves the Wasm import ABI.

## Browser iframe realm

A same-origin iframe provides a synchronous second realm without moving the AOT
module:

```ts
import { createRealmDynamicCodeEvaluator } from "@loopdive/js2/runtime/evaluator";

const evaluator = createRealmDynamicCodeEvaluator(iframe.contentWindow!);
```

Functions and objects can cross this boundary as ordinary cross-realm
references. The iframe has separate globals and intrinsic prototypes, but it is
not a security boundary: same-origin code can still reach `parent`, the DOM,
storage, and origin capabilities, and an infinite loop blocks the page thread.

An opaque-origin sandboxed iframe or browser Worker provides a stronger
boundary, but communication is asynchronous. Supporting either while the Wasm
module stays on the window thread requires suspending/resuming the Wasm call
(for example through a future stack-switching/async transform); the window
agent cannot use `Atomics.wait` to turn Worker messaging into a synchronous
import.

## Direct eval environments

The standalone interpreter already establishes the reusable direct-eval ABI:
the compiler materializes eval-visible bindings as mutable cells in activation,
lexical, and outer layers. Opt in to the JS-host route at compile time:

```ts
const result = await compile(source, { directEval: "reified-host" });
```

The AOT module and its WasmGC cells remain in the main host. The main-realm
import registers each cell under an opaque binding id; the Node evaluator's
scope proxy performs synchronous get/set callbacks through those ids. An
eval-created escaping closure therefore observes later AOT writes, and its own
writes immediately update the canonical AOT cell—even when eval subsequently
throws. Activation, lexical, and captured-outer layers retain their compiler
shadowing order.

This first direct-eval slice covers existing binding reads/writes and live
escaping closures. Full EvalDeclarationInstantiation remains follow-up work:
eval-created sloppy `var`/function persistence, caller `const`/TDZ attributes,
delete semantics, mapped arguments, and private names need the declaration
metadata/state-pool part of the standalone ABI. Arbitrary main-owned objects
also need the reverse membrane described below. Unsupported crossings fail
loudly instead of copying object identity.

## Boundary and security model

- A Node Worker is a separate realm, heap, and thread, but not an OS or
  capability sandbox. It still has Node capabilities unless the host restricts
  them.
- Values created by Node Worker eval remain in its handle table. Primitive
  arguments and Worker-owned proxies cross synchronously; arbitrary AOT-host
  objects need the planned reverse membrane before they can be passed in.
- Browser native eval requires Content Security Policy to allow
  `'unsafe-eval'` in the evaluator realm.
- Errors are reconstructed in the AOT host realm so compiled `try`/`catch` and
  constructor checks observe the expected standard error family.
