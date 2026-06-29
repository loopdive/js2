try { risky(); } catch (e) { handle(e); } finally { cleanup(); }
try { risky(); } catch { handle(); }
switch (x) {
  case 1: a(); break;
  case 2:
  case 3: b(); break;
  default: c();
}
outer: for (let i = 0; i < 10; i++) {
  inner: for (let j = 0; j < 10; j++) {
    if (j > 5) continue outer;
    if (i > 8) break outer;
  }
}
