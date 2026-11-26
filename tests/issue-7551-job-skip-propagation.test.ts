// #7551 — no job in test262-sharded.yml may be skipped silently because an
// ancestor was skipped.
//
// GitHub skips a job whose `needs` did not all succeed unless its `if:` holds a
// status function (always(), !cancelled(), success(), failure()). It also
// propagates a skipped ancestor THROUGH an always() job into its dependants
// (the #3611 hazard, documented at `promote-baseline`). The #7551 routing
// changes which events run which jobs — `changes` does not run on schedule, the
// legacy matrix now runs on schedule — so a job that was fine per-merge could be
// skipped, green, on the daily run. That is exactly how the daily full-corpus
// IR measurement would have stopped running.
//
// This models every event: each job's `if:` is evaluated three-valued (true /
// false / unknown for inputs and job outputs), a job without a status function
// is skipped when a need may not have run, and any job that can run while one
// of its transitive ancestors may be skipped must carry a status function.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(join(process.cwd(), ".github/workflows/test262-sharded.yml"), "utf8");
const EVENTS = ["schedule", "workflow_dispatch", "push", "merge_group", "pull_request"] as const;
type Event = (typeof EVENTS)[number];

/**
 * Jobs whose ancestors are skipped only together with the job itself, through
 * a correlated condition the three-valued model cannot see. Each needs a reason.
 */
const CORRELATED: Record<string, string> = {
  "test262-standalone-linked":
    "dispatch-only and gated on inputs.standalone_linked, the same input that gates its only conditional ancestor (standalone-harness-provider); every other ancestor runs on dispatch",
};

interface Job {
  name: string;
  needs: string[];
  condition: string;
}

function parseJobs(text: string): Job[] {
  const body = text.slice(text.indexOf("\njobs:\n") + 7);
  const lines = body.split("\n");
  const jobs: Job[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^ {2}([a-z0-9-]+):$/.exec(lines[i]!);
    if (!header) continue;
    let end = i + 1;
    while (end < lines.length && !/^ {2}[a-z0-9-]+:$/.test(lines[end]!)) end++;
    const block = lines.slice(i + 1, end);
    const job: Job = { name: header[1]!, needs: [], condition: "" };
    for (let k = 0; k < block.length; k++) {
      const line = block[k]!;
      const needs = /^ {4}needs:\s*(.*)$/.exec(line);
      if (needs) {
        let value = needs[1]!.trim();
        if (value === "") value = (block[k + 1] ?? "").trim();
        job.needs = value.startsWith("[")
          ? value
              .replace(/[[\]]/g, "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [value];
      }
      const cond = /^ {4}if:\s*(.*)$/.exec(line);
      if (cond) {
        const head = cond[1]!.trim();
        if (head === "|" || head === ">-" || head === ">") {
          const parts: string[] = [];
          for (let m = k + 1; m < block.length && /^ {6,}\S/.test(block[m]!); m++) parts.push(block[m]!.trim());
          job.condition = parts.join(" ");
        } else job.condition = head.replace(/\s+#.*$/, "");
      }
    }
    jobs.push(job);
    i = end - 1;
  }
  return jobs;
}

const U = Symbol("unknown");
type Value = string | boolean | typeof U;
type RunState = "run" | "maybe" | "skipped";

const STATUS_FUNCTION = /\b(?:always|success|failure|cancelled)\(\)/;

function evaluate(condition: string, resolve: (id: string) => Value): Value {
  const tokens = condition.match(/'[^']*'|&&|\|\||==|!=|!|\(|\)|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*/g) ?? [];
  let pos = 0;
  const truth = (v: Value): boolean | typeof U => (v === U ? U : typeof v === "boolean" ? v : v !== "");
  const primary = (): Value => {
    const t = tokens[pos++];
    if (t === undefined) throw new Error(`unexpected end of: ${condition}`);
    if (t === "(") {
      const v = or();
      pos++; // ")"
      return v;
    }
    if (t === "!") {
      const v = truth(primary());
      return v === U ? U : !v;
    }
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === "true" || t === "false") return t === "true";
    if (t === "cancelled()") return false;
    if (t.endsWith("()")) return true; // always() / success() / failure() for the run we model
    return resolve(t);
  };
  const compare = (): Value => {
    const left = primary();
    const op = tokens[pos];
    if (op !== "==" && op !== "!=") return left;
    pos++;
    const right = primary();
    if (left === U || right === U) return U;
    return op === "==" ? left === right : left !== right;
  };
  const and = (): Value => {
    let v: Value = compare();
    while (tokens[pos] === "&&") {
      pos++;
      const r = compare();
      const a = truth(v);
      const b = truth(r);
      v = a === false || b === false ? false : a === U || b === U ? U : true;
    }
    return v;
  };
  const or = (): Value => {
    let v: Value = and();
    while (tokens[pos] === "||") {
      pos++;
      const r = and();
      const a = truth(v);
      const b = truth(r);
      v = a === true || b === true ? true : a === U || b === U ? U : false;
    }
    return v;
  };
  return or();
}

function runStates(jobs: Job[], event: Event): Map<string, RunState> {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const states = new Map<string, RunState>();
  const state = (name: string): RunState => {
    const known = states.get(name);
    if (known) return known;
    const job = byName.get(name)!;
    const needStates = job.needs.map(state);
    const resolve = (id: string): Value => {
      if (id === "github.event_name") return event;
      if (id === "github.actor") return "a-developer";
      if (id === "github.repository") return "loopdive/js2";
      const result = /^needs\.([a-z0-9-]+)\.result$/.exec(id);
      if (result) {
        const s = state(result[1]!);
        return s === "run" ? "success" : s === "skipped" ? "skipped" : U;
      }
      return U; // inputs, vars, job outputs, event payload
    };
    let s: RunState;
    const value = job.condition === "" ? true : evaluate(job.condition, resolve);
    const cond = value === U ? U : typeof value === "boolean" ? value : value !== "";
    if (cond === false) s = "skipped";
    else {
      s = cond === U ? "maybe" : "run";
      if (!STATUS_FUNCTION.test(job.condition)) {
        if (needStates.includes("skipped")) s = "skipped";
        else if (needStates.includes("maybe")) s = "maybe";
      }
    }
    states.set(name, s);
    return s;
  };
  for (const j of jobs) state(j.name);
  return states;
}

function ancestors(jobs: Job[], name: string, seen = new Set<string>()): Set<string> {
  const job = jobs.find((j) => j.name === name)!;
  for (const n of job.needs)
    if (!seen.has(n)) {
      seen.add(n);
      ancestors(jobs, n, seen);
    }
  return seen;
}

/** Jobs that can run in `event` while a transitive ancestor may be skipped, and have no status function. */
function violations(jobs: Job[], event: Event): string[] {
  const states = runStates(jobs, event);
  const out: string[] = [];
  for (const job of jobs) {
    if (states.get(job.name) === "skipped" || STATUS_FUNCTION.test(job.condition) || CORRELATED[job.name]) continue;
    const skippable = [...ancestors(jobs, job.name)].filter((a) => states.get(a) !== "run");
    if (skippable.length > 0) out.push(`${job.name} (may-skip ancestors: ${skippable.join(", ")})`);
  }
  return out;
}

describe("#7551 skip propagation in test262-sharded.yml", () => {
  const jobs = parseJobs(WORKFLOW);

  it("parses the real job graph (guards the model from passing vacuously)", () => {
    const names = jobs.map((j) => j.name);
    for (const n of [
      "changes",
      "compiler-path-measurement-plan",
      "test262-ir-measurement-shard",
      "merge-ir-measurement",
    ])
      expect(names).toContain(n);
    expect(jobs.find((j) => j.name === "merge-ir-measurement")!.needs).toEqual([
      "compiler-path-measurement-plan",
      "test262-ir-measurement-shard",
    ]);
  });

  for (const event of EVENTS) {
    it(`${event}: every job that can run has a status function when an ancestor may be skipped`, () => {
      expect(violations(jobs, event)).toEqual([]);
    });
  }

  it("the daily run reaches the full IR measurement and the legacy matrix", () => {
    const states = runStates(jobs, "schedule");
    expect(states.get("changes")).toBe("skipped");
    for (const job of ["test262-ir-measurement-shard", "merge-ir-measurement", "test262-shard", "merge-report"])
      expect(states.get(job), job).not.toBe("skipped");
  });

  it("the model has teeth: the pre-fix IR conditions are flagged on schedule", () => {
    const preFix = "needs.compiler-path-measurement-plan.outputs.run == 'true'";
    const broken = jobs.map((j) =>
      j.name === "test262-ir-measurement-shard" || j.name === "merge-ir-measurement" ? { ...j, condition: preFix } : j,
    );
    expect(violations(broken, "schedule").map((v) => v.split(" ")[0])).toEqual([
      "test262-ir-measurement-shard",
      "merge-ir-measurement",
    ]);
  });
});
