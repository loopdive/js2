// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5393: one fresh process observes one source and lane; this is not compiler validation.
import vm from "node:vm";
import { posix } from "node:path";
import { types as utilTypes } from "node:util";
import ts from "typescript";
import { formatConsoleArguments } from "./audit-javascript-soundness.mjs";
import { exceptionPayload } from "./lib/wasm-exn-render.mjs";

type Specimen = {
  id: string;
  source?: string;
  files?: Record<string, string>;
  entry?: string;
  sourceHash: string;
  async?: boolean;
  completionMarker?: string;
};
type Request = { specimen: Specimen; lane: string; timeoutMs: number; maxOutput: number };
type Thrown = { comparable: boolean; identity?: unknown; rendered?: string };

function thrownObservation(error: unknown, instance?: WebAssembly.Instance): Thrown {
  let value: any = error;
  const nativeException = typeof WebAssembly.Exception === "function" && error instanceof WebAssembly.Exception;
  if (nativeException) {
    value = exceptionPayload(error, instance);
    if (value === undefined) return { comparable: false, rendered: "unresolved native exception payload" };
  }
  if (value === null) return { comparable: true, identity: { type: "null" } };
  const type = typeof value;
  if (["undefined", "string", "boolean", "number", "bigint"].includes(type)) {
    return {
      comparable: true,
      identity: { type, value: type === "number" && Object.is(value, -0) ? "-0" : String(value) },
    };
  }
  // Do not invoke arbitrary user getters/toString while observing an object
  // throw: that would itself add side effects to the audited program.
  if (!utilTypes.isNativeError(value)) return { comparable: false, rendered: "opaque thrown object" };
  // Even native Error instances can have an accessor named `name`. Read data
  // descriptors only so observing an exception cannot execute user code.
  let current = value;
  for (let depth = 0; current && depth < 8; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "name");
    if (descriptor) {
      return "value" in descriptor && typeof descriptor.value === "string"
        ? { comparable: true, identity: { type: "error", name: descriptor.value } }
        : { comparable: false, rendered: "error name requires accessor evaluation" };
    }
    current = Object.getPrototypeOf(current);
  }
  return { comparable: false, rendered: "unresolved error name" };
}

function asyncOrDynamic(sources: string[]) {
  let asynchronous = false,
    dynamicImport = false;
  for (const source of sources) {
    const ast = ts.createSourceFile("audit.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = (node: ts.Node): void => {
      if (
        ts.isAwaitExpression(node) ||
        node.kind === ts.SyntaxKind.AsyncKeyword ||
        (ts.isIdentifier(node) && ["Promise", "setTimeout", "setInterval", "queueMicrotask"].includes(node.text))
      )
        asynchronous = true;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImport = true;
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { asynchronous, dynamicImport };
}

function createCapture(marker: string, maxOutput: number) {
  let stdout = "",
    stderr = "",
    syncComplete = false,
    overflow = false;
  let lastPartial = 0;
  const write = (channel: "stdout" | "stderr", args: unknown[]): void => {
    if (args.length === 1 && args[0] === marker) {
      syncComplete = true;
      return;
    }
    const line = formatConsoleArguments(args);
    if (stdout.length + stderr.length + line.length > maxOutput) {
      overflow = true;
      return;
    }
    if (channel === "stdout") stdout += line;
    else stderr += line;
    if (Date.now() - lastPartial >= 100) {
      lastPartial = Date.now();
      process.send?.({ type: "partial", observation: { stdout, stderr } });
    }
  };
  const consoleProxy = {
    log: (...args: unknown[]) => write("stdout", args),
    info: (...args: unknown[]) => write("stdout", args),
    debug: (...args: unknown[]) => write("stdout", args),
    warn: (...args: unknown[]) => write("stderr", args),
    error: (...args: unknown[]) => write("stderr", args),
  };
  const readStandalone = (instance: WebAssembly.Instance): boolean => {
    const ex = instance.exports as Record<string, any>;
    if (typeof ex.__stdout_prepare !== "function" || typeof ex.__stdout_char !== "function") return false;
    const length = ex.__stdout_prepare();
    if (!Number.isInteger(length) || length < 0 || length > maxOutput) {
      overflow = true;
      return false;
    }
    let output = "";
    for (let i = 0; i < length; i++) output += String.fromCharCode(ex.__stdout_char(i));
    const sentinel = marker + "\n";
    syncComplete = output.includes(sentinel);
    // Remove only our full sentinel line. Preserve every other code unit.
    stdout = output.split(sentinel).join("");
    return true;
  };
  return { consoleProxy, readStandalone, snapshot: () => ({ stdout, stderr, syncComplete, overflow }) };
}

async function runNode(
  specimen: Specimen,
  source: string,
  files: Record<string, string> | undefined,
  consoleProxy: object,
) {
  const context = vm.createContext({
    console: consoleProxy,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  });
  if (!files) {
    new vm.Script(source, { filename: `${specimen.id}.js` }).runInContext(context, { displayErrors: false });
    return;
  }
  const normalized = new Map(Object.entries(files).map(([name, value]) => [posix.resolve("/", name), value]));
  const modules = new Map<string, vm.SourceTextModule>();
  const moduleFor = (name: string): vm.SourceTextModule => {
    const found = modules.get(name);
    if (found) return found;
    const text = normalized.get(name);
    if (text === undefined) throw new Error(`Audit module loader cannot resolve ${name}`);
    const module = new vm.SourceTextModule(text, { context, identifier: name });
    modules.set(name, module);
    return module;
  };
  const entry = moduleFor(posix.resolve("/", specimen.entry!));
  await entry.link((specifier, referencingModule) => {
    if (!specifier.startsWith(".")) throw new Error(`Audit module loader cannot resolve package ${specifier}`);
    const name = posix.resolve(posix.dirname(referencingModule.identifier), specifier);
    return moduleFor(normalized.has(name) ? name : name + ".js");
  });
  await entry.evaluate();
}

async function runWasm(specimen: Specimen, source: string, files: Record<string, string> | undefined, lane: string) {
  const options = {
    fileName: `${specimen.id}.js`,
    allowJs: true,
    deferTopLevelInit: true,
    emitWat: false,
    hostBridge: "always" as const,
    ...(lane.startsWith("standalone") ? { target: "standalone" as const } : {}),
    ...(lane.endsWith("-O") ? { optimize: 2 as const } : {}),
  };
  let result: Awaited<ReturnType<(typeof import("../src/index.js"))["compile"]>>;
  try {
    const { compile, compileMulti } = await import("../src/index.js");
    result = files ? await compileMulti(files, specimen.entry!, options) : await compile(source, options);
  } catch (error) {
    return { options, status: "compiler_exception", reason: String(error) };
  }
  const metadata = { options, diagnostics: result.errors, binaryBytes: result.binary.length };
  if (!result.success) return { ...metadata, status: "compile_error" };
  if (!WebAssembly.validate(result.binary)) return { ...metadata, status: "invalid_wasm" };
  const { createHash } = await import("node:crypto");
  const wasmHash = createHash("sha256").update(result.binary).digest("hex");
  try {
    // Production runtime import assembly, including callback/export wiring.
    const imports = lane.startsWith("standalone") ? {} : result.importObject!;
    const module = await WebAssembly.compile(result.binary);
    const importDescriptors = WebAssembly.Module.imports(module);
    if (lane.startsWith("standalone") && importDescriptors.length) {
      return {
        ...metadata,
        wasmHash,
        importDescriptors,
        status: "observation_error",
        reason: "Standalone requires imports the host-free audit cannot supply",
      };
    }
    const instance = await WebAssembly.instantiate(module, imports);
    (imports as any).__setInstance?.(instance);
    return { ...metadata, wasmHash, importDescriptors, instance };
  } catch (error) {
    return {
      ...metadata,
      wasmHash,
      status:
        error instanceof WebAssembly.CompileError
          ? "invalid_wasm"
          : error instanceof WebAssembly.LinkError
            ? "link_error"
            : "observation_error",
      stage: "instantiate_and_wire",
      reason: String(error),
    };
  }
}

async function observe({ specimen, lane, timeoutMs, maxOutput }: Request) {
  const originalSources = specimen.files ? Object.values(specimen.files) : [specimen.source!];
  const detected = asyncOrDynamic(originalSources);
  if (detected.dynamicImport)
    return {
      status: "inconclusive",
      reason: "Dynamic module loading is outside this runner's observation contract",
      stdout: "",
      stderr: "",
    };
  const asynchronous = specimen.async === true || !!specimen.completionMarker || detected.asynchronous;
  const marker = `__JS2WASM_AUDIT_COMPLETE_${specimen.sourceHash}__`;
  const suffix = `\n;console.log(${JSON.stringify(marker)});\n`;
  const source = (specimen.source ?? "") + suffix;
  const files = specimen.files
    ? { ...specimen.files, [specimen.entry!]: specimen.files[specimen.entry!] + suffix }
    : undefined;
  const capture = createCapture(marker, maxOutput);
  const originalConsole = globalThis.console;
  let instance: WebAssembly.Instance | undefined;
  let metadata: any = {},
    abrupt: Thrown | undefined;
  const onRejection = (error: unknown) => {
    abrupt = thrownObservation(error, instance);
  };
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onRejection);
  // Runtime imports call the actual console; use the same formatter as Node's VM.
  globalThis.console = { ...originalConsole, ...capture.consoleProxy };
  const start = Date.now();
  try {
    try {
      if (lane === "node") await runNode(specimen, source, files, capture.consoleProxy);
      else {
        let built: Awaited<ReturnType<typeof runWasm>>;
        try {
          built = await runWasm(specimen, source, files, lane);
        } catch (error) {
          return {
            ...capture.snapshot(),
            status: "observation_error",
            stage: "build_and_setup",
            reason: String(error),
          };
        }
        const { instance: compiled, ...details } = built;
        metadata = details;
        if (built.status) return { ...metadata, ...capture.snapshot(), status: built.status };
        instance = compiled;
        const init = instance!.exports.__module_init;
        if (typeof init === "function") init();
      }
    } catch (error) {
      abrupt = thrownObservation(error, instance);
    }
    const refresh = () => {
      if (lane.startsWith("standalone") && instance) return capture.readStandalone(instance);
      return true;
    };
    if (!refresh())
      return {
        ...metadata,
        ...capture.snapshot(),
        status: "observation_error",
        reason: "Standalone stdout cannot be read",
      };
    if (asynchronous && specimen.completionMarker && !abrupt) {
      const deadline = start + Math.max(100, timeoutMs - 1500);
      while (Date.now() < deadline) {
        const drain = instance?.exports.__drain_microtasks;
        if (typeof drain === "function") {
          try {
            drain();
          } catch (error) {
            abrupt = thrownObservation(error, instance);
          }
        }
        await new Promise((done) => setTimeout(done, 0));
        refresh();
        const { stdout, stderr } = capture.snapshot();
        if (
          abrupt ||
          stdout.split("\n").includes(specimen.completionMarker) ||
          stderr.split("\n").includes(specimen.completionMarker)
        )
          break;
      }
    } else await new Promise((done) => setTimeout(done, 0));
    refresh();
    const snapshot = capture.snapshot();
    if (snapshot.overflow)
      return {
        ...metadata,
        ...snapshot,
        status: "observation_error",
        reason: "Program output exceeded observation bound",
      };
    if (asynchronous && !specimen.completionMarker)
      return {
        ...metadata,
        ...snapshot,
        status: "inconclusive",
        reason: "Async activity has no explicit completion marker",
      };
    if (abrupt) return { ...metadata, ...snapshot, status: "abrupt", thrown: abrupt };
    if (
      !snapshot.syncComplete ||
      (asynchronous &&
        ![snapshot.stdout, snapshot.stderr].some((text) => text.split("\n").includes(specimen.completionMarker!)))
    ) {
      return {
        ...metadata,
        ...snapshot,
        status: "inconclusive",
        reason: "Required completion marker was not observed",
      };
    }
    return { ...metadata, ...snapshot, status: "normal" };
  } finally {
    globalThis.console = originalConsole;
    process.removeListener("unhandledRejection", onRejection);
    process.removeListener("uncaughtException", onRejection);
  }
}

process.once("message", async (request: Request) => {
  let observation;
  try {
    observation = await observe(request);
  } catch (error) {
    observation = { status: "worker_error", reason: String(error), stdout: "", stderr: "" };
  }
  process.send!({ type: "observation", observation }, () => process.exit(0));
});
