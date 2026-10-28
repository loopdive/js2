// #7143 B0 fixture — a unit that touches `document`, which a host-free target cannot claim.
export function paint(n: number): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    const e = document.createElement("div");
    e.textContent = "row";
    count++;
  }
  return count;
}
