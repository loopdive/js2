// ═══════════════════════════════════════════════════════
// Algorithms — fibonacci, binary search, quicksort
// ═══════════════════════════════════════════════════════
//
// Classic algorithms that exercise integer math, recursion, Maps, and
// in-place array mutation. Everything compiles to WasmGC — the loops
// stay as Wasm loops, `Map` becomes a real `Map`, and recursion uses
// `call` (or `return_call` in tail position).

// ── Fibonacci ──────────────────────────────────────────

// Iterative — O(n) time, O(1) space.
function fibIter(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

// Memoized recursion — O(n) time after first call.
const fibCache = new Map<number, number>();

function fibMemo(n: number): number {
  if (n < 2) return n;
  const hit = fibCache.get(n);
  if (hit !== undefined) return hit;
  const v = fibMemo(n - 1) + fibMemo(n - 2);
  fibCache.set(n, v);
  return v;
}

// ── Binary search ─────────────────────────────────────

// Returns the index of `target` in a sorted array, or -1 if absent.
function binarySearch(arr: number[], target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1; // i32 shift — same as Math.floor((lo+hi)/2) for non-negative
    const v = arr[mid];
    if (v === target) return mid;
    if (v < target) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

// ── Quicksort ─────────────────────────────────────────

// In-place Lomuto partition. Sorts `arr` between indices `lo` and `hi` inclusive.
function quicksort(arr: number[], lo: number, hi: number): void {
  if (lo >= hi) return;
  const pivot = arr[hi];
  let i = lo - 1;
  for (let j = lo; j < hi; j++) {
    if (arr[j] <= pivot) {
      i++;
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
  }
  const tmp = arr[i + 1];
  arr[i + 1] = arr[hi];
  arr[hi] = tmp;
  const p = i + 1;
  quicksort(arr, lo, p - 1);
  quicksort(arr, p + 1, hi);
}

// ── Helpers ───────────────────────────────────────────

function joinNums(arr: number[]): string {
  let s = "";
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) s = s + ",";
    s = s + arr[i].toString();
  }
  return s;
}

// ── Entry point ───────────────────────────────────────

export function main(): void {
  console.log("── Fibonacci ──");
  for (let n = 0; n < 10; n++) {
    console.log("fib(" + n.toString() + ") iter=" + fibIter(n).toString() + " memo=" + fibMemo(n).toString());
  }
  console.log("fib(30) iter = " + fibIter(30).toString());

  console.log("── Binary search ──");
  const sorted = [1, 3, 5, 8, 13, 21, 34, 55, 89, 144];
  console.log("sorted = [" + joinNums(sorted) + "]");
  console.log("indexOf(13) = " + binarySearch(sorted, 13).toString());
  console.log("indexOf(34) = " + binarySearch(sorted, 34).toString());
  console.log("indexOf(7)  = " + binarySearch(sorted, 7).toString());

  console.log("── Quicksort ──");
  const unsorted = [5, 2, 8, 1, 9, 3, 7, 4, 6, 0];
  console.log("before = [" + joinNums(unsorted) + "]");
  quicksort(unsorted, 0, unsorted.length - 1);
  console.log("after  = [" + joinNums(unsorted) + "]");
}
