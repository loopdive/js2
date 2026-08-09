const jsString = {
  concat: (a, b) => a + b,
  length: (s) => s.length,
  equals: (a, b) => (a === b ? 1 : 0),
  substring: (s, start, end) => s.substring(start, end),
  charCodeAt: (s, i) => s.charCodeAt(i),
};

const reflectApply = Reflect.apply;
const instanceExportsGetter = Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports")?.get;
const dataStructHostBridgeToken = String.fromCharCode(0) + "js2_data_struct_host_bridge_token";

function brandedInstanceExports(value) {
  if (!instanceExportsGetter) return undefined;
  try {
    return reflectApply(instanceExportsGetter, value, []);
  } catch {
    return undefined;
  }
}

function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

function hexCodeUnits(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    out += s.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return out;
}

export function buildStringConstants(stringPool = []) {
  const constants = Object.create(null);
  for (const s of stringPool) {
    if (hasLoneSurrogate(s)) continue;
    if (!(s in constants)) {
      constants[s] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}

export function buildStringConstants16(stringPool = []) {
  const constants = Object.create(null);
  for (const s of stringPool) {
    if (!hasLoneSurrogate(s)) continue;
    const key = hexCodeUnits(s);
    if (!(key in constants)) {
      constants[key] = new WebAssembly.Global({ value: "externref", mutable: false }, s);
    }
  }
  return constants;
}

function resolveImport(intent, deps, callbackState) {
  switch (intent?.type) {
    case "declared_global":
      return () => deps?.[intent.name];
    case "extern_class":
      if (intent.action === "new") {
        const ctor = deps?.globalThis?.[intent.className] ?? globalThis[intent.className];
        return (...args) => new ctor(...args);
      }
      if (intent.action === "method") {
        return (self, ...args) => self[intent.member](...args);
      }
      if (intent.action === "get") {
        return (self) => self[intent.member];
      }
      if (intent.action === "set") {
        return (self, value) => {
          self[intent.member] = value;
        };
      }
      return () => undefined;
    case "builtin":
      if (intent.name === "number_toString") return (v) => String(v);
      if (intent.name === "number_toFixed") return (v, digits) => Number(v).toFixed(digits);
      if (intent.name === "__get_undefined") return () => undefined;
      if (intent.name?.startsWith("__concat_")) return (...parts) => parts.join("");
      return () => undefined;
    case "extern_get":
      return (obj, key) => obj?.[key];
    case "callback_maker":
      return (id, cap) => (...args) => callbackState.getExports()?.[`__cb_${id}`]?.(cap, ...args);
    case "box":
      if (intent.targetType === "boolean") return (v) => Boolean(v);
      return (v) => v;
    case "console_log":
      return (v) => console.log(v);
    case "date_now":
      return () => Date.now();
    default:
      return () => undefined;
  }
}

export function buildImports(manifest, deps = {}, stringPool = []) {
  let wasmExports;
  const callbackState = { getExports: () => wasmExports };
  const env = {};
  for (const imp of manifest ?? []) {
    if (imp.module !== "env" || imp.kind !== "func") continue;
    env[imp.name] = resolveImport(imp.intent, deps, callbackState);
  }
  return {
    env,
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(stringPool),
    string_constants16: buildStringConstants16(stringPool),
    setExports(exports) {
      wasmExports = exports;
    },
    setInstance(instance) {
      const exports = brandedInstanceExports(instance);
      if (exports === undefined) {
        throw new TypeError("setInstance: expected a genuine WebAssembly.Instance");
      }
      wasmExports = exports;
    },
  };
}

export async function instantiateWasm(binary, env, stringConstants = {}, stringConstants16 = {}) {
  const preserveDataStructAssociation = stringConstants[dataStructHostBridgeToken] !== undefined;
  if (typeof WebAssembly.instantiate === "function" && !preserveDataStructAssociation) {
    try {
      const { instance } = await WebAssembly.instantiate(
        binary,
        { env, string_constants: stringConstants, string_constants16: stringConstants16 },
        {
          builtins: ["js-string"],
          importedStringConstants: "string_constants",
        },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through.
    }
  }
  const { instance } = await WebAssembly.instantiate(binary, {
    env,
    "wasm:js-string": jsString,
    string_constants: stringConstants,
    string_constants16: stringConstants16,
  });
  return { instance, nativeBuiltins: false };
}

export async function instantiateWasmStreaming(source, env, stringConstants = {}, stringConstants16 = {}) {
  const response =
    source instanceof Response ? source : source instanceof Promise ? await source : await fetch(source);
  const fallback = response.clone();
  const preserveDataStructAssociation = stringConstants[dataStructHostBridgeToken] !== undefined;
  if (typeof WebAssembly.instantiateStreaming === "function" && !preserveDataStructAssociation) {
    try {
      const { instance } = await WebAssembly.instantiateStreaming(
        response,
        { env, string_constants: stringConstants, string_constants16: stringConstants16 },
        { builtins: ["js-string"], importedStringConstants: "string_constants" },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through.
    }
  }
  return instantiateWasm(new Uint8Array(await fallback.arrayBuffer()), env, stringConstants, stringConstants16);
}

let binaryenModulePromise = null;

function addBinaryenFeature(features, featureFlags, name) {
  const flag = featureFlags?.[name];
  return typeof flag === "number" ? features | flag : features;
}

async function loadBinaryen() {
  if (binaryenModulePromise) return binaryenModulePromise;
  binaryenModulePromise = (async () => {
    const browserLike = typeof window !== "undefined" || typeof globalThis.WorkerGlobalScope !== "undefined";
    const globalObject = globalThis;
    const hadProcess = "process" in globalObject;
    const hadOwnProcess = Object.prototype.hasOwnProperty.call(globalObject, "process");
    const previousProcess = globalObject.process;

    if (browserLike && hadProcess) {
      try {
        globalObject.process = undefined;
      } catch {
        // Some runtimes expose a non-writable process global.
      }
    }

    try {
      const mod = await import(new URL("./binaryen.js", import.meta.url).href);
      return mod.default ?? mod;
    } catch {
      return null;
    } finally {
      if (browserLike) {
        if (hadProcess && hadOwnProcess) {
          globalObject.process = previousProcess;
        } else if (!hadOwnProcess) {
          try {
            delete globalObject.process;
          } catch {
            globalObject.process = undefined;
          }
        }
      }
    }
  })();
  return binaryenModulePromise;
}

export async function optimizeWasm(binary, options = {}) {
  const binaryen = await loadBinaryen();
  if (!binaryen?.readBinary) {
    return {
      binary,
      optimized: false,
      warning: "wasm-opt is unavailable in this browser benchmark runtime.",
    };
  }

  const featureFlags = binaryen.Features ?? binaryen.features;
  if (!featureFlags) {
    return {
      binary,
      optimized: false,
      warning: "wasm-opt feature flags are unavailable in this browser benchmark runtime.",
    };
  }

  let mod;
  try {
    mod = binaryen.readBinary(binary);
  } catch (error) {
    return {
      binary,
      optimized: false,
      warning: "wasm-opt could not read benchmark module: " + (error?.message || String(error)),
    };
  }

  const previousOptimizeLevel =
    typeof binaryen.getOptimizeLevel === "function" ? binaryen.getOptimizeLevel() : undefined;
  const previousShrinkLevel = typeof binaryen.getShrinkLevel === "function" ? binaryen.getShrinkLevel() : undefined;

  try {
    let features = 0;
    for (const name of ["GC", "ReferenceTypes", "ExceptionHandling", "BulkMemory", "MutableGlobals"]) {
      features = addBinaryenFeature(features, featureFlags, name);
    }
    if (typeof mod.setFeatures === "function") mod.setFeatures(features);

    const requestedLevel = Number.isFinite(options.level) ? Math.trunc(options.level) : 4;
    const level = Math.max(1, Math.min(4, requestedLevel));
    if (typeof binaryen.setOptimizeLevel === "function") {
      binaryen.setOptimizeLevel(level >= 4 ? 3 : level);
    }
    if (typeof binaryen.setShrinkLevel === "function") {
      binaryen.setShrinkLevel(level >= 4 ? 1 : 0);
    }

    const optimizePasses = level >= 4 ? 3 : 1;
    for (let pass = 0; pass < optimizePasses; pass++) {
      mod.optimize();
    }

    return {
      binary: new Uint8Array(mod.emitBinary()),
      optimized: true,
    };
  } catch (error) {
    return {
      binary,
      optimized: false,
      warning: "wasm-opt failed for benchmark module: " + (error?.message || String(error)),
    };
  } finally {
    if (typeof binaryen.setOptimizeLevel === "function" && previousOptimizeLevel !== undefined) {
      binaryen.setOptimizeLevel(previousOptimizeLevel);
    }
    if (typeof binaryen.setShrinkLevel === "function" && previousShrinkLevel !== undefined) {
      binaryen.setShrinkLevel(previousShrinkLevel);
    }
    mod?.dispose?.();
  }
}
