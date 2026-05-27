// ═══════════════════════════════════════════════════════
// async / await — Promises, Promise.all, await in a loop
// ═══════════════════════════════════════════════════════
//
// js2 compiles `async function` to a WasmGC state machine. `await`
// suspends the function and resumes on the host's microtask queue once
// the awaited value settles. Promises are normal WasmGC objects, not
// engine intrinsics — `Promise.all` is just another exported builtin.

// Simulate a network fetch with a setTimeout-based delay.
function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

async function fetchUser(id: number): Promise<number> {
  // Pretend each "request" takes ~30ms and returns id * 10.
  const v = await delay(30, id * 10);
  return v;
}

async function fetchAllSequential(ids: number[]): Promise<number> {
  // Demonstrates `await` inside a loop — runs requests one at a time.
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    total = total + (await fetchUser(ids[i]));
  }
  return total;
}

async function fetchAllParallel(ids: number[]): Promise<number> {
  // Promise.all fans out and waits for the slowest.
  const pending: Promise<number>[] = [];
  for (let i = 0; i < ids.length; i++) {
    pending.push(fetchUser(ids[i]));
  }
  const results = await Promise.all(pending);
  let total = 0;
  for (let i = 0; i < results.length; i++) {
    total = total + results[i];
  }
  return total;
}

export async function main(): Promise<void> {
  console.log("async/await demo");

  const ids = [1, 2, 3, 4, 5];

  const t0 = Date.now();
  const seq = await fetchAllSequential(ids);
  const t1 = Date.now();
  console.log("sequential sum = " + seq.toString() + " (took ~" + (t1 - t0).toString() + "ms)");

  const t2 = Date.now();
  const par = await fetchAllParallel(ids);
  const t3 = Date.now();
  console.log("parallel  sum = " + par.toString() + " (took ~" + (t3 - t2).toString() + "ms)");

  console.log("done");
}
