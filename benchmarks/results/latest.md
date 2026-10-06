# js2wasm Benchmark Results

Date: 2026-10-06
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.023ms | gc-native |
| string/includes | 0.015ms | 0.096ms | 0.011ms | 0.032ms | gc-native |
| string/split | 0.328ms | 6.11ms | 2.05ms | FAILED | js |
| string/replace | 0.075ms | 0.461ms | 0.212ms | FAILED | js |
| string/case-convert | 0.045ms | 0.443ms | 0.187ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.63ms | 1.86ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 2.01ms | 1.98ms | 0.433ms | js |
| array/push-pop | 1.32ms | 0.479ms | 0.479ms | FAILED | host-call |
| array/sort-i32 | 0.660ms | 0.236ms | 0.235ms | FAILED | gc-native |
| array/map-filter | 0.111ms | 0.052ms | 0.052ms | FAILED | host-call |
| array/reduce | 1.89ms | 0.471ms | 0.472ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.212ms | 0.012ms | 0.012ms | 0.940ms | host-call |
| dom/create-elements | 0.030ms | 0.078ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.190ms | — | — | js |
| dom/read-attributes | 0.048ms | 0.103ms | — | — | js |
| dom/modify-text | 0.023ms | 0.087ms | — | — | js |
| mixed/csv-parse | 0.361ms | 6.48ms | 0.438ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.47ms | 1.94ms | 0.880ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 51.76ms | 54.47ms | 0.563ms | js |
| mixed/sieve | 1.48ms | 1.80ms | 1.80ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.66 | 3.93 | 3.84 | — |
| string/concat-long | 1000 | 3.36 | 4.22 | 2.97 | — |
| string/indexOf | 1000 | 14.75 | 46.78 | 9.81 | 22.94 |
| string/includes | 1000 | 14.51 | 96.08 | 11.05 | 32.30 |
| string/split | 10000 | 32.81 | 610.55 | 205.04 | — |
| string/replace | 1000 | 74.86 | 461.45 | 212.24 | — |
| string/case-convert | 2000 | 22.46 | 221.73 | 93.47 | — |
| string/substring | 10000 | 8.07 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.40 | 263.38 | 185.90 | — |
| string/startsWith-endsWith | 20000 | 16.02 | 100.67 | 99.23 | 21.66 |
| array/map-filter | 30000 | 3.69 | 1.74 | 1.74 | — |
| array/indexOf | 1000 | 3461.11 | 2229.93 | 2226.04 | — |
| dom/create-elements | 2000 | 15.06 | 39.25 | — | — |
| dom/set-attributes | 6000 | 14.25 | 31.60 | — | — |
| dom/read-attributes | 3000 | 16.06 | 34.40 | — | — |
| dom/modify-text | 2000 | 11.35 | 43.71 | — | — |
| mixed/csv-parse | 11000 | 32.77 | 588.65 | 39.84 | — |
| mixed/text-search | 40000 | 7.81 | 86.80 | 48.45 | 22.00 |
| mixed/fibonacci | 10000 | 9.72 | 25.39 | 25.40 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.17 | 414.06 | 435.72 | 4.51 |
| mixed/sieve | 200000 | 7.40 | 8.98 | 9.00 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.44x slower | — |
| string/concat-long | 1.26x slower | 1.13x faster | — |
| string/indexOf | 3.17x slower | 1.50x faster | 1.55x slower |
| string/includes | 6.62x slower | 1.31x faster | 2.23x slower |
| string/split | 18.61x slower | 6.25x slower | — |
| string/replace | 6.16x slower | 2.84x slower | — |
| string/case-convert | 9.87x slower | 4.16x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 19.66x slower | 13.87x slower | — |
| string/startsWith-endsWith | 6.29x slower | 6.20x slower | 1.35x slower |
| array/push-pop | 2.76x faster | 2.76x faster | — |
| array/sort-i32 | 2.79x faster | 2.81x faster | — |
| array/map-filter | 2.12x faster | 2.11x faster | — |
| array/reduce | 4.01x faster | 3.99x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.26x faster | 2.24x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.89x faster | 1.89x faster | — |
| array/find | 17.57x faster | 17.36x faster | 4.43x slower |
| dom/create-elements | 2.61x slower | — | — |
| dom/set-attributes | 2.22x slower | — | — |
| dom/read-attributes | 2.14x slower | — | — |
| dom/modify-text | 3.85x slower | — | — |
| mixed/csv-parse | 17.96x slower | 1.22x slower | — |
| mixed/text-search | 11.11x slower | 6.20x slower | 2.82x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 354.34x slower | 372.89x slower | 3.86x slower |
| mixed/sieve | 1.21x slower | 1.22x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.42x faster |
| string/indexOf | 4.77x faster |
| string/includes | 8.70x faster |
| string/split | 2.98x faster |
| string/replace | 2.17x faster |
| string/case-convert | 2.37x faster |
| string/substring | 1.16x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.77x faster |
| mixed/text-search | 1.79x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.05x slower |
| mixed/sieve | 1.00x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 855.1ms | 454.6ms | — |
| string/concat-long | 333.1ms | 484.6ms | — |
| string/indexOf | 289.8ms | 517.2ms | 414.6ms |
| string/includes | 287.1ms | 518.8ms | 422.5ms |
| string/split | 386.0ms | 521.0ms | — |
| string/replace | 400.6ms | 583.0ms | — |
| string/case-convert | 389.6ms | 476.1ms | — |
| string/substring | 294.6ms | 344.7ms | — |
| string/trim | 368.0ms | 510.9ms | — |
| string/startsWith-endsWith | 382.8ms | 524.5ms | 476.3ms |
| array/push-pop | 388.3ms | 448.7ms | — |
| array/sort-i32 | 524.0ms | 541.5ms | — |
| array/map-filter | 517.6ms | 551.5ms | — |
| array/reduce | 473.1ms | 537.2ms | — |
| array/indexOf | 453.4ms | 512.8ms | — |
| array/slice | 393.7ms | 454.2ms | — |
| array/reverse | 384.7ms | 430.8ms | — |
| array/forEach | 501.9ms | 527.8ms | — |
| array/find | 391.6ms | 446.4ms | 413.5ms |
| dom/create-elements | 321.2ms | — | — |
| dom/set-attributes | 300.4ms | — | — |
| dom/read-attributes | 299.7ms | — | — |
| dom/modify-text | 306.2ms | — | — |
| mixed/csv-parse | 399.4ms | 508.6ms | — |
| mixed/text-search | 385.4ms | 545.0ms | 478.8ms |
| mixed/fibonacci | 345.6ms | 387.9ms | 359.9ms |
| mixed/matrix-multiply | 610.8ms | 526.6ms | 398.3ms |
| mixed/sieve | 471.3ms | 512.3ms | — |
