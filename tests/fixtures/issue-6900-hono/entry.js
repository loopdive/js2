import { Ctx, createPool, defaultMatch, each, pick, registered } from "./lib.js";

export function syncRows() {
  const rows = [];
  rows.push(
    defaultMatch(
      [
        { type: "a", q: 0.5 },
        { type: "b", q: 1 },
      ],
      { supports: ["a"], default: "z" },
    ),
  );
  const c = new Ctx();
  rows.push(typeof c.read(), typeof c.pub, c.init, c.status(201).read());
  rows.push(pick({ fetch: (x) => "custom:" + x }));
  // Control: no `fetch` — the right operand is the right answer on both trees.
  rows.push(pick({}));
  return rows.join(",");
}

each`table`("inline", async ({ a, b }) => {
  const r = await Promise.all([a, b]);
  return "each:" + r.length;
});
// Control: the same body bound to a const was already driven before the fix.
const bound = async ({ a, b }) => {
  const r = await Promise.all([a, b]);
  return "bound:" + r.length;
};
each`table`("bound", bound);

export function asyncRows() {
  const pool = createPool({ concurrency: 1 });
  const jobs = [1, 2, 3].map((i) => pool.run(() => Promise.resolve(i)));
  const tests = registered.map((t) => t());
  return Promise.all([Promise.all(jobs), Promise.all(tests)]).then(
    ([done, names]) => done.join("") + "," + names.join(","),
  );
}
