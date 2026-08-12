// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Synchronous eval-only Node Worker transport; the AOT Wasm stays in its host. */

import { MessageChannel, type MessagePort, type Worker, receiveMessageOnPort } from "node:worker_threads";
import type { DynamicCodeBinding, DynamicCodeEvaluationContext, DynamicCodeEvaluator } from "./runtime.js";

const PROTOCOL = "js2wasm:node-eval-worker:v1";
const REMOTE_VALUE = Symbol("js2wasm.remote-eval-value");
const SCOPE_PARAM = "__js2wasm_eval_scope__";
const SOURCE_PARAM = "__js2wasm_eval_source__";

type Primitive = undefined | null | boolean | number | string | bigint;
type WireSymbol = { wire: "symbol"; key: string; global: boolean };
type WireHandle = { wire: "handle"; id: number; callable: boolean };
type WireValue = Primitive | WireSymbol | WireHandle;
type WireBinding = { id: number; name: string };

type SerializedError = { name: string; message: string; stack?: string };
type Request =
  | {
      id: number;
      op: "eval";
      source: string;
      direct: boolean;
      strict: boolean;
      bindings?: WireBinding[];
    }
  | { id: number; op: "function"; parameters: string; body: string }
  | { id: number; op: "get"; handle: number; key: WireValue }
  | { id: number; op: "set"; handle: number; key: WireValue; value: WireValue }
  | {
      id: number;
      op: "apply";
      handle: number;
      thisArg: WireValue;
      args: WireValue[];
    }
  | { id: number; op: "construct"; handle: number; args: WireValue[] }
  | { id: number; op: "has"; handle: number; key: WireValue }
  | { id: number; op: "delete"; handle: number; key: WireValue };
type Response =
  | { channel: "worker"; id: number; ok: true; value: WireValue }
  | { channel: "worker"; id: number; ok: false; error: SerializedError };
type HostRequest =
  | { channel: "host"; id: number; op: "binding-get"; binding: number }
  | {
      channel: "host";
      id: number;
      op: "binding-set";
      binding: number;
      value: WireValue;
    };
type HostRequestBody =
  | { op: "binding-get"; binding: number }
  | { op: "binding-set"; binding: number; value: WireValue };
type HostResponse =
  | { channel: "host-response"; id: number; ok: true; value: WireValue }
  | { channel: "host-response"; id: number; ok: false; error: SerializedError };

type ConnectMessage = {
  protocol: typeof PROTOCOL;
  type: "connect";
  port: MessagePort;
  signal: SharedArrayBuffer;
  hostSignal: SharedArrayBuffer;
};

export interface NodeEvalWorkerOptions {
  /** Synchronous request deadline. A timeout terminates the Worker. Default: 30 seconds. */
  timeoutMs?: number;
  /** Worker connection deadline. Default: 30 seconds. */
  initializationTimeoutMs?: number;
}

export interface NodeEvalWorkerEvaluator extends DynamicCodeEvaluator {
  terminate(): Promise<void>;
}

function serializeError(value: unknown): SerializedError {
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: value.message,
      stack: value.stack,
    };
  }
  return {
    name: "Error",
    message: typeof value === "string" ? value : String(value),
  };
}

function restoreError(record: SerializedError): Error {
  const constructors: Record<string, new (message?: string) => Error> = {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
  };
  const Ctor = constructors[record.name] ?? Error;
  const error = new Ctor(record.message);
  error.name = record.name;
  if (record.stack) error.stack = record.stack;
  return error;
}

function encodeSymbol(value: symbol): WireSymbol {
  const globalKey = Symbol.keyFor(value);
  if (globalKey !== undefined) return { wire: "symbol", key: globalKey, global: true };
  for (const key of Object.getOwnPropertyNames(Symbol) as Array<keyof SymbolConstructor>) {
    if (typeof Symbol[key] === "symbol" && Symbol[key] === value) {
      return { wire: "symbol", key: String(key), global: false };
    }
  }
  throw new TypeError("non-global symbols cannot cross the eval Worker boundary");
}

function decodeSymbol(value: WireSymbol): symbol {
  if (value.global) return Symbol.for(value.key);
  const candidate = Symbol[value.key as keyof SymbolConstructor];
  if (typeof candidate !== "symbol") throw new TypeError(`unknown well-known Symbol.${value.key}`);
  return candidate;
}

function isWireHandle(value: WireValue): value is WireHandle {
  return typeof value === "object" && value !== null && "wire" in value && value.wire === "handle";
}

function isWireSymbol(value: WireValue): value is WireSymbol {
  return typeof value === "object" && value !== null && "wire" in value && value.wire === "symbol";
}

/**
 * Connect an eval-only Node Worker and return a synchronous evaluator suitable
 * for `buildImports(..., { dynamicCode: "evaluator" })`.
 *
 * Calls block the current Node thread with `Atomics.wait` because Wasm imports
 * are synchronous. The Worker can be hard-terminated at the deadline. Remote
 * functions and objects stay in the Worker and are represented by synchronous
 * proxies in the AOT module's host realm.
 */
export async function connectNodeEvalWorker(
  worker: Worker,
  options: NodeEvalWorkerOptions = {},
): Promise<NodeEvalWorkerEvaluator> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const initializationTimeoutMs = options.initializationTimeoutMs ?? 30_000;
  const { port1, port2 } = new MessageChannel();
  const signalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const signal = new Int32Array(signalBuffer);
  const hostSignalBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const hostSignal = new Int32Array(hostSignalBuffer);
  const connect: ConnectMessage = {
    protocol: PROTOCOL,
    type: "connect",
    port: port2,
    signal: signalBuffer,
    hostSignal: hostSignalBuffer,
  };

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      port1.off("message", onReady);
      worker.off("error", onError);
      port1.close();
      void worker.terminate();
      const error = new Error(`eval Worker initialization timed out after ${initializationTimeoutMs}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, initializationTimeoutMs);
    const onReady = (message: unknown): void => {
      if ((message as { protocol?: string; type?: string })?.protocol !== PROTOCOL) return;
      if ((message as { type?: string }).type !== "ready") return;
      port1.off("message", onReady);
      worker.off("error", onError);
      clearTimeout(timer);
      resolve();
    };
    const onError = (error: Error): void => {
      port1.off("message", onReady);
      clearTimeout(timer);
      reject(error);
    };
    port1.on("message", onReady);
    worker.once("error", onError);
    worker.postMessage(connect, [port2]);
  });

  let nextId = 1;
  let closedError: Error | undefined;
  const proxyByHandle = new Map<number, object>();
  const handleByProxy = new WeakMap<object, WireHandle>();
  const bindingById = new Map<number, DynamicCodeBinding>();
  const idByBinding = new WeakMap<DynamicCodeBinding, number>();
  let nextBindingId = 1;

  const closeWith = (error: Error): void => {
    if (closedError) return;
    closedError = error;
    port1.close();
    void worker.terminate();
  };
  worker.on("error", (error) => closeWith(error));
  worker.on("exit", (code) => {
    if (!closedError) closeWith(new Error(`eval Worker exited with code ${code}`));
  });

  const encode = (value: unknown): WireValue => {
    if (typeof value === "symbol") return encodeSymbol(value);
    if ((typeof value === "object" && value !== null) || typeof value === "function") {
      const handle = handleByProxy.get(value as object);
      if (handle) return handle;
      throw new TypeError(
        "objects from the AOT host cannot cross into the eval Worker yet; pass primitives or Worker-owned proxies",
      );
    }
    return value as Primitive;
  };

  const decode = (value: WireValue): unknown => {
    if (isWireSymbol(value)) return decodeSymbol(value);
    if (!isWireHandle(value)) return value;
    const existing = proxyByHandle.get(value.id);
    if (existing) return existing;
    const target = value.callable ? function remoteEvalFunction(): void {} : Object.create(null);
    const proxy = new Proxy(target, {
      get(_target, key) {
        if (key === REMOTE_VALUE) return value;
        return request({
          op: "get",
          handle: value.id,
          key: encode(key),
        } as Omit<Request, "id">);
      },
      set(_target, key, nextValue) {
        return request({
          op: "set",
          handle: value.id,
          key: encode(key),
          value: encode(nextValue),
        } as Omit<Request, "id">) as boolean;
      },
      has(_target, key) {
        return request({
          op: "has",
          handle: value.id,
          key: encode(key),
        } as Omit<Request, "id">) as boolean;
      },
      deleteProperty(_target, key) {
        return request({
          op: "delete",
          handle: value.id,
          key: encode(key),
        } as Omit<Request, "id">) as boolean;
      },
      apply(_target, thisArg, args) {
        return request({
          op: "apply",
          handle: value.id,
          thisArg: encode(thisArg),
          args: args.map(encode),
        } as Omit<Request, "id">);
      },
      construct(_target, args) {
        return request({
          op: "construct",
          handle: value.id,
          args: args.map(encode),
        } as Omit<Request, "id">) as object;
      },
    });
    proxyByHandle.set(value.id, proxy);
    handleByProxy.set(proxy, value);
    return proxy;
  };

  function request(body: Omit<Request, "id">): unknown {
    if (closedError) throw closedError;
    const id = nextId++;
    const message = { ...body, id } as Request;
    port1.postMessage(message);
    const deadline = Date.now() + timeoutMs;
    let observedSignal = Atomics.load(signal, 0);
    let response: Response | undefined;

    while (!response) {
      for (let packet = receiveMessageOnPort(port1)?.message as Response | HostRequest | undefined; packet; ) {
        if (packet.channel === "host") {
          let hostResponse: HostResponse;
          try {
            const binding = bindingById.get(packet.binding);
            if (!binding) throw new ReferenceError(`unknown AOT eval binding ${packet.binding}`);
            let value: unknown;
            if (packet.op === "binding-get") value = binding.get();
            else binding.set(decode(packet.value));
            hostResponse = {
              channel: "host-response",
              id: packet.id,
              ok: true,
              value: encode(value),
            };
          } catch (error) {
            hostResponse = {
              channel: "host-response",
              id: packet.id,
              ok: false,
              error: serializeError(error),
            };
          }
          port1.postMessage(hostResponse);
          Atomics.add(hostSignal, 0, 1);
          Atomics.notify(hostSignal, 0);
        } else if (packet.channel === "worker" && packet.id === id) {
          response = packet;
        } else {
          const error = new Error("eval Worker response protocol desynchronized");
          closeWith(error);
          throw error;
        }
        packet = receiveMessageOnPort(port1)?.message as Response | HostRequest | undefined;
      }
      if (response) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = new Error(`eval Worker request timed out after ${timeoutMs}ms`);
        error.name = "TimeoutError";
        closeWith(error);
        throw error;
      }
      Atomics.wait(signal, 0, observedSignal, Math.min(remaining, 50));
      observedSignal = Atomics.load(signal, 0);
    }
    if (!response.ok) throw restoreError(response.error);
    return decode(response.value);
  }

  return {
    evaluate(source: string, context: DynamicCodeEvaluationContext) {
      const bindings = context.bindings?.map((binding) => {
        let id = idByBinding.get(binding);
        if (id === undefined) {
          id = nextBindingId++;
          idByBinding.set(binding, id);
          bindingById.set(id, binding);
        }
        return { id, name: binding.name };
      });
      return request({
        op: "eval",
        source,
        direct: context.direct,
        strict: context.strict === true,
        bindings,
      } as Omit<Request, "id">);
    },
    createFunction(parameters, body) {
      return request({ op: "function", parameters, body } as Omit<Request, "id">) as Function;
    },
    async terminate() {
      if (!closedError) {
        closedError = new Error("eval Worker terminated");
        port1.close();
      }
      await worker.terminate();
    },
  };
}

/** Start the eval-only server inside a Node Worker. */
export function serveNodeEvalWorker(parent: Worker | MessagePort): void {
  parent.on("message", (message: unknown) => {
    const connect = message as Partial<ConnectMessage>;
    if (
      connect.protocol !== PROTOCOL ||
      connect.type !== "connect" ||
      !connect.port ||
      !connect.signal ||
      !connect.hostSignal
    )
      return;
    const port = connect.port;
    const signal = new Int32Array(connect.signal);
    const hostSignal = new Int32Array(connect.hostSignal);
    const handles = new Map<number, unknown>();
    const ids = new WeakMap<object, number>();
    let nextHandle = 1;
    let nextHostRequestId = 1;

    const encode = (value: unknown): WireValue => {
      if (typeof value === "symbol") return encodeSymbol(value);
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        const object = value as object;
        let id = ids.get(object);
        if (id === undefined) {
          id = nextHandle++;
          ids.set(object, id);
          handles.set(id, value);
        }
        return { wire: "handle", id, callable: typeof value === "function" };
      }
      return value as Primitive;
    };
    const decode = (value: WireValue): unknown => {
      if (isWireSymbol(value)) return decodeSymbol(value);
      if (isWireHandle(value)) {
        if (!handles.has(value.id)) throw new ReferenceError(`unknown eval Worker handle ${value.id}`);
        return handles.get(value.id);
      }
      return value;
    };
    const handle = (id: number): any => {
      if (!handles.has(id)) throw new ReferenceError(`unknown eval Worker handle ${id}`);
      return handles.get(id);
    };

    const hostRequest = (body: HostRequestBody): unknown => {
      const id = nextHostRequestId++;
      const observedSignal = Atomics.load(hostSignal, 0);
      port.postMessage({ channel: "host", id, ...body } as HostRequest);
      Atomics.add(signal, 0, 1);
      Atomics.notify(signal, 0);
      for (;;) {
        const packet = receiveMessageOnPort(port)?.message as HostResponse | undefined;
        if (packet) {
          if (packet.channel !== "host-response" || packet.id !== id) {
            throw new Error("eval host callback protocol desynchronized");
          }
          if (!packet.ok) throw restoreError(packet.error);
          return decode(packet.value);
        }
        Atomics.wait(hostSignal, 0, observedSignal);
      }
    };

    const createBindingScope = (bindings: readonly WireBinding[]): Record<PropertyKey, unknown> => {
      const byName = new Map<string, number>();
      for (const binding of bindings) byName.set(binding.name, binding.id);
      return new Proxy(Object.create(null) as Record<PropertyKey, unknown>, {
        has(_target, key) {
          if (key === "eval" || key === SCOPE_PARAM || key === SOURCE_PARAM) return false;
          return typeof key === "string" && (byName.has(key) || Reflect.has(globalThis, key));
        },
        get(_target, key) {
          if (key === Symbol.unscopables) return undefined;
          const binding = typeof key === "string" ? byName.get(key) : undefined;
          return binding === undefined
            ? Reflect.get(globalThis as Record<PropertyKey, unknown>, key)
            : hostRequest({ op: "binding-get", binding });
        },
        set(_target, key, value) {
          const binding = typeof key === "string" ? byName.get(key) : undefined;
          if (binding === undefined) Reflect.set(globalThis as Record<PropertyKey, unknown>, key, value);
          else hostRequest({ op: "binding-set", binding, value: encode(value) });
          return true;
        },
        deleteProperty(_target, key) {
          if (typeof key === "string" && byName.has(key)) return false;
          return Reflect.deleteProperty(globalThis as Record<PropertyKey, unknown>, key);
        },
      });
    };

    const scopedEval = new Function(
      SCOPE_PARAM,
      SOURCE_PARAM,
      `with (${SCOPE_PARAM}) { return eval(${SOURCE_PARAM}); }`,
    ) as (scope: Record<PropertyKey, unknown>, source: string) => unknown;

    port.on("message", (request: Request) => {
      let response: Response;
      try {
        let value: unknown;
        switch (request.op) {
          case "eval":
            if (request.direct && request.bindings !== undefined) {
              const source = request.strict ? `"use strict";\n${request.source}` : request.source;
              value = Reflect.apply(scopedEval, undefined, [createBindingScope(request.bindings), source]);
            } else {
              // biome-ignore lint/style/noCommaOperator: explicit indirect eval in the isolated Worker realm
              // biome-ignore lint/security/noGlobalEval: this Worker is the selected dynamic-code evaluator
              value = (0, eval)(request.source);
            }
            break;
          case "function":
            value = new Function(request.parameters, request.body);
            break;
          case "get":
            value = Reflect.get(handle(request.handle), decode(request.key) as PropertyKey);
            break;
          case "set":
            value = Reflect.set(handle(request.handle), decode(request.key) as PropertyKey, decode(request.value));
            break;
          case "apply":
            value = Reflect.apply(handle(request.handle), decode(request.thisArg), request.args.map(decode));
            break;
          case "construct":
            value = Reflect.construct(handle(request.handle), request.args.map(decode));
            break;
          case "has":
            value = Reflect.has(handle(request.handle), decode(request.key) as PropertyKey);
            break;
          case "delete":
            value = Reflect.deleteProperty(handle(request.handle), decode(request.key) as PropertyKey);
            break;
        }
        response = {
          channel: "worker",
          id: request.id,
          ok: true,
          value: encode(value),
        };
      } catch (error) {
        response = {
          channel: "worker",
          id: request.id,
          ok: false,
          error: serializeError(error),
        };
      }
      port.postMessage(response);
      Atomics.add(signal, 0, 1);
      Atomics.notify(signal, 0);
    });
    port.start();
    port.postMessage({ protocol: PROTOCOL, type: "ready" });
  });
}
