// #7551 — no job in test262-sharded.yml may be skipped silently because an
// ancestor was skipped.
//
// GitHub skips a job whose `needs` did not all succeed unless its `if:` holds a
// status function (always(), !cancelled(), success(), failure()). It also
// propagates a skipped ancestor THROUGH an always() job into its dependants
// (the #3611 hazard, documented at `promote-baseline`). The #7551 routing
// changes which events run which jobs — `changes` does not run on schedule, the
// legacy matrix now runs on schedule — so a job that was fine per-merge could be
// skipped, green, on the weekly run. That is exactly how the weekly full-corpus
// IR measurement would have stopped running.
//
// This models every event: each job's `if:` is evaluated three-valued (true /
// false / unknown for inputs and job outputs), a job without a status function
// is skipped when a need may not have run, and any job that can run while one
// of its transitive ancestors may be skipped must carry a status function.
//
// #7558 reuses the same model for the six REQUIRED contexts across every
// workflow that produces one: on a pull request each must still publish a
// check run (only cla-check and the cheap gate really run), and in the merge
// queue none of them may be skipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), ".github/workflows", file), "utf8");
const WORKFLOW = read("test262-sharded.yml");
const EVENTS = ["schedule", "workflow_dispatch", "push", "merge_group", "pull_request"] as const;
type Event = (typeof EVENTS)[number] | "pull_request_target";

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
  /** The check-run name: the job's `name:`, else its id. */
  display: string;
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
    const job: Job = { name: header[1]!, display: header[1]!, needs: [], condition: "" };
    for (let k = 0; k < block.length; k++) {
      const line = block[k]!;
      const display = /^ {4}name:\s*(.*)$/.exec(line);
      if (display) job.display = display[1]!.trim().replace(/^"(.*)"$/, "$1");
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
/** "failed": the job ran and failed — forced by a scenario, never derived. */
type RunState = "run" | "maybe" | "skipped" | "failed";

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

function runStates(jobs: Job[], event: Event, failed: ReadonlySet<string> = new Set()): Map<string, RunState> {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const states = new Map<string, RunState>();
  const state = (name: string): RunState => {
    const known = states.get(name);
    if (known) return known;
    if (failed.has(name)) {
      states.set(name, "failed");
      return "failed";
    }
    const job = byName.get(name)!;
    const needStates = job.needs.map(state);
    const resolve = (id: string): Value => {
      if (id === "github.event_name") return event;
      if (id === "github.actor") return "a-developer";
      if (id === "github.repository") return "loopdive/js2";
      const result = /^needs\.([a-z0-9-]+)\.result$/.exec(id);
      if (result) {
        const s = state(result[1]!);
        return s === "run" ? "success" : s === "skipped" ? "skipped" : s === "failed" ? "failure" : U;
      }
      // A skipped or failed job's outputs are empty strings.
      const output = /^needs\.([a-z0-9-]+)\.outputs\./.exec(id);
      if (output && ["skipped", "failed"].includes(state(output[1]!))) return "";
      return U; // inputs, vars, job outputs, event payload
    };
    let s: RunState;
    const value = job.condition === "" ? true : evaluate(job.condition, resolve);
    const cond = value === U ? U : typeof value === "boolean" ? value : value !== "";
    if (cond === false) s = "skipped";
    else {
      s = cond === U ? "maybe" : "run";
      if (!STATUS_FUNCTION.test(job.condition)) {
        if (needStates.includes("skipped") || needStates.includes("failed")) s = "skipped";
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

  it("the weekly run reaches the full IR measurement and the legacy matrix", () => {
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
/** Top-level trigger keys of a workflow, each with whether it carries a `paths:` filter. */
function triggers(text: string): Map<string, { paths: boolean }> {
  const lines = text.slice(text.indexOf("\non:\n") + 5, text.indexOf("\njobs:\n")).split("\n");
  const out = new Map<string, { paths: boolean }>();
  let current: string | undefined;
  for (const line of lines) {
    const key = /^ {2}([a-z_]+):/.exec(line);
    if (key) out.set((current = key[1]!), { paths: false });
    else if (current && /^ {4}paths:/.test(line)) out.get(current)!.paths = true;
    else if (/^\S/.test(line)) break; // the next top-level key ends `on:`
  }
  return out;
}

// The ruleset's six contexts (docs/ci-policy.md §7) and every workflow that may publish each.
const PRODUCERS: Record<string, string[]> = {
  "cheap gate (main-ancestor + lint)": ["test262-sharded.yml", "test262-pr-stub.yml"],
  "merge shard reports": ["test262-sharded.yml", "test262-pr-stub.yml"],
  "check for test262 regressions": ["test262-sharded.yml", "test262-pr-stub.yml"],
  quality: ["ci.yml"],
  "equivalence-gate": ["ci.yml"],
  "cla-check": ["cla-check.yml"],
};

interface Production {
  file: string;
  state: RunState;
  pathFiltered: boolean;
}

/** How each producer of `context` behaves on `event` (absent: the workflow does not trigger). */
function productions(
  event: "pull_request" | "merge_group",
  context: string,
  mutate = (_file: string, jobs: Job[]) => jobs,
): Production[] {
  const out: Production[] = [];
  for (const file of PRODUCERS[context]!) {
    const text = read(file);
    const on = triggers(text);
    const trigger = event === "pull_request" && !on.has(event) ? "pull_request_target" : event;
    if (!on.has(trigger)) continue;
    const jobs = mutate(file, parseJobs(text));
    const job = jobs.find((j) => j.display === context);
    if (!job) continue;
    out.push({
      file,
      state: runStates(jobs, trigger).get(job.name)!,
      pathFiltered: on.get(trigger)!.paths,
    });
  }
  return out;
}

describe("#7558 required contexts: slim pull request, full merge queue", () => {
  it("parses the six contexts and their producers (guards the model from passing vacuously)", () => {
    for (const context of Object.keys(PRODUCERS))
      expect(productions("merge_group", context).length, context).toBeGreaterThan(0);
    expect(triggers(read("test262-sharded.yml")).get("pull_request")).toEqual({
      paths: true,
    });
    expect(triggers(read("test262-pr-stub.yml")).get("pull_request")).toEqual({
      paths: false,
    });
  });

  for (const context of Object.keys(PRODUCERS)) {
    it(`pull_request: "${context}" always publishes a check run`, () => {
      // A path-filtered workflow publishes nothing when its paths miss, so at
      // least one producer must trigger on every pull request.
      expect(productions("pull_request", context).some((p) => !p.pathFiltered)).toBe(true);
    });
    it(`merge_group: "${context}" is never skipped`, () => {
      const prods = productions("merge_group", context);
      expect(prods.length).toBeGreaterThan(0);
      for (const p of prods) expect(p.state, p.file).not.toBe("skipped");
    });
  }

  it("merge_group: no single failed upstream job turns a required context into a skip", () => {
    // A skipped required check satisfies the ruleset, so a context whose
    // upstream failed or was cancelled must RUN and fail, never skip.
    for (const [context, files] of Object.entries(PRODUCERS))
      for (const file of files) {
        const text = read(file);
        if (!triggers(text).has("merge_group")) continue;
        const jobs = parseJobs(text);
        const job = jobs.find((j) => j.display === context);
        if (!job) continue;
        for (const failedJob of ancestors(jobs, job.name))
          expect(
            runStates(jobs, "merge_group", new Set([failedJob])).get(job.name),
            `${context} (${file}) after ${failedJob} failed`,
          ).not.toBe("skipped");
      }
  });

  it("the failure model has teeth: the pre-#7558 equivalence-gate condition is caught", () => {
    const jobs = parseJobs(read("ci.yml")).map((j) =>
      j.name === "equivalence-gate" ? { ...j, condition: "always() && needs.changes.outputs.code == 'true'" } : j,
    );
    expect(runStates(jobs, "merge_group", new Set(["changes"])).get("equivalence-gate")).toBe("skipped");
  });

  it("pull_request: quality and equivalence-gate are skipped; the quick test and cla-check run", () => {
    expect(productions("pull_request", "quality").map((p) => p.state)).toEqual(["skipped"]);
    expect(productions("pull_request", "equivalence-gate").map((p) => p.state)).toEqual(["skipped"]);
    const cheap = productions("pull_request", "cheap gate (main-ancestor + lint)");
    expect(cheap.find((p) => p.file === "test262-sharded.yml")!.state).toBe("run");
    expect(productions("pull_request", "cla-check").map((p) => p.state)).toEqual(["run"]);
  });

  it("pull_request: nothing else in ci.yml runs", () => {
    const states = runStates(parseJobs(read("ci.yml")), "pull_request");
    expect([...states].filter(([, s]) => s !== "skipped")).toEqual([]);
  });

  it("the model has teeth: a PR-only quality condition is flagged in the merge queue", () => {
    const prOnly = (file: string, jobs: Job[]) =>
      file === "ci.yml"
        ? jobs.map((j) => (j.name === "quality" ? { ...j, condition: "github.event_name == 'pull_request'" } : j))
        : jobs;
    expect(productions("merge_group", "quality", prOnly).map((p) => p.state)).toEqual(["skipped"]);
  });
});
