// Shapes reduced from hono@4.12.16 dist (helper/accepts, context, client,
// utils/concurrent). Kept as a separate module so every value crosses an
// untyped module boundary, exactly as in the upstream suite.

// helper/accepts/accepts.js — `.sort(cmp)` on an untyped receiver (#6900).
export var defaultMatch = (accepts, config) => {
  const { supports, default: defaultSupport } = config;
  const accept = accepts.sort((a, b) => b.q - a.q).find((x) => supports.includes(x.type));
  return accept ? accept.type : defaultSupport;
};

// context.js — fields declared without an initializer (#6901).
export var Ctx = class {
  #status;
  pub;
  init = 1;
  status = (status) => {
    this.#status = status;
    return this;
  };
  read() {
    return this.#status;
  }
};

// client/client.js — `(opt?.fetch || fetch)(…)` (#6902).
function fallback(x) {
  return "fallback:" + x;
}
export const pick = (opt) => (opt?.fetch || fallback)("u");

// utils/concurrent.js — a self-recursive async arrow (#6860).
export var createPool = ({ concurrency }) => {
  const pool = new Set();
  const run = async (fn, promise, resolve) => {
    if (pool.size >= concurrency) {
      promise ||= new Promise((r) => (resolve = r));
      setTimeout(() => run(fn, promise, resolve));
      return promise;
    }
    const marker = {};
    pool.add(marker);
    const result = await fn();
    pool.delete(marker);
    if (resolve) {
      resolve(result);
      return promise;
    }
    return result;
  };
  return { run };
};

// The upstream shim's `test.each` — a tagged-template call-of-call (#6860).
export const registered = [];
export function each(_cases) {
  return function (_name, body) {
    registered.push(() => body({ a: 1, b: 2 }));
  };
}
