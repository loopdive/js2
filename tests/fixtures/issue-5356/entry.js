import {
  deadBranch,
  neverCalled,
  numberCounter,
  takenBranch,
  counterInLoop,
  twoSiblings,
  asyncNested,
  switchClause,
  loopBlock,
  shadowDead,
  shadowTaken,
  arrDstr,
  objDstr,
  printDocToString,
} from "./lib.js";

export function runDeadBranch() {
  return deadBranch();
}
export function runNeverCalled() {
  return neverCalled();
}
export function runNumberCounter() {
  return numberCounter();
}
export function runTakenBranch() {
  return takenBranch();
}
export function runCounterInLoop() {
  return counterInLoop();
}
export function runTwoSiblings() {
  return twoSiblings();
}
export function runAsyncNested() {
  return asyncNested();
}
export function runSwitchClause() {
  return switchClause(2);
}
export function runLoopBlock() {
  return loopBlock();
}
export function runShadowDead() {
  return shadowDead();
}
export function runShadowTaken() {
  return shadowTaken();
}
export function runArrDstr() {
  return arrDstr([4, 6]);
}
export function runObjDstr() {
  return objDstr({ n: 4 });
}
export function runPrintString() {
  return printDocToString("hi");
}
export function runPrintArray() {
  return printDocToString(["a", "b"]);
}
export function runPrintLine() {
  return printDocToString(["   ", { type: "line" }, "P", { type: "line" }]);
}
