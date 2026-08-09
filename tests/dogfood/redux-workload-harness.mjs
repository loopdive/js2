// Redux npm-compat workload (#3996 follow-up).
//
// The package-entry harness proves only that the published ESM bundle compiles
// and validates. This companion workload consumes createStore,
// combineReducers, subscribe, and bindActionCreators, then compares one
// primitive summary against the same installed package in native Node.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createNpmWorkloadHarness, isCli, runWorkloadHarnessCli } from "./npm-workload-harness.mjs";
import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";

const DRIVER_SOURCE = `
import { bindActionCreators, combineReducers, createStore } from "./package/dist/redux.mjs";

function counter(state = 0, action) {
  return action.type === "increment" ? state + action.amount : state;
}

function flag(state = false, action) {
  return action.type === "toggle" ? !state : state;
}

export function runCase() {
  const store = createStore(combineReducers({ counter, flag }));
  let observed = -1;
  const unsubscribe = store.subscribe(function listener() {
    observed = store.getState().counter;
  });
  const actions = bindActionCreators(
    {
      increment(amount) { return { type: "increment", amount }; },
      toggle() { return { type: "toggle" }; },
    },
    store.dispatch,
  );
  actions.increment(2);
  actions.increment(5);
  actions.toggle();
  unsubscribe();
  actions.increment(1);
  const state = store.getState();
  return state.counter * 10 + (state.flag ? 1 : 0) + observed * 100;
}
`;

async function nativeOracle(setup) {
  const redux = await import(pathToFileURL(setup.entryModulePath).href);
  function counter(state = 0, action) {
    return action.type === "increment" ? state + action.amount : state;
  }
  function flag(state = false, action) {
    return action.type === "toggle" ? !state : state;
  }
  const store = redux.createStore(redux.combineReducers({ counter, flag }));
  let observed = -1;
  const unsubscribe = store.subscribe(() => {
    observed = store.getState().counter;
  });
  const actions = redux.bindActionCreators(
    {
      increment(amount) {
        return { type: "increment", amount };
      },
      toggle() {
        return { type: "toggle" };
      },
    },
    store.dispatch,
  );
  actions.increment(2);
  actions.increment(5);
  actions.toggle();
  unsubscribe();
  actions.increment(1);
  const state = store.getState();
  return state.counter * 10 + (state.flag ? 1 : 0) + observed * 100;
}

export const runHarness = createNpmWorkloadHarness({
  name: "redux",
  issue: 3996,
  reportName: "redux-workload",
  setup: () => setupNpmCompatCatalogPackage("redux"),
  driverPath: (setup) => join(setup.root, ".js2-redux-workload.mjs"),
  driverSource: DRIVER_SOURCE,
  oracle: nativeOracle,
  timeoutMs: Number(process.env.DOGFOOD_REDUX_WORKLOAD_TIMEOUT_MS ?? 180_000),
});

if (isCli(import.meta.url, process.argv[1])) runWorkloadHarnessCli(runHarness);
