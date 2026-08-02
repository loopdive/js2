# js2wasm Benchmark Results

Date: 2026-08-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.038ms | 0.033ms | FAILED | js |
| string/concat-long | 0.003ms | 0.007ms | 0.007ms | FAILED | js |
| string/indexOf | 0.015ms | 0.062ms | 0.019ms | FAILED | js |
| string/includes | 0.015ms | 0.095ms | 0.018ms | FAILED | js |
| string/split | 0.328ms | 4.32ms | 1.09ms | FAILED | js |
| string/replace | 0.035ms | 0.163ms | 0.060ms | FAILED | js |
| string/case-convert | 0.049ms | 0.179ms | 0.088ms | FAILED | js |
| string/substring | 0.081ms | 1.50ms | 0.719ms | FAILED | js |
| string/trim | 0.135ms | 1.05ms | 0.569ms | FAILED | js |
| string/startsWith-endsWith | 0.332ms | 2.14ms | 0.410ms | FAILED | js |
| array/push-pop | 1.33ms | 2.01ms | 2.01ms | FAILED | js |
| array/sort-i32 | 0.657ms | 0.326ms | 0.321ms | FAILED | gc-native |
| array/map-filter | 0.109ms | 0.538ms | 0.537ms | FAILED | js |
| array/reduce | 1.89ms | 2.02ms | 2.04ms | FAILED | js |
| array/indexOf | 3.46ms | 2.99ms | 2.99ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.020ms | 0.021ms | FAILED | host-call |
| array/reverse | 6.86ms | 2.86ms | 2.86ms | FAILED | host-call |
| array/forEach | 0.075ms | 0.096ms | 0.096ms | FAILED | js |
| array/find | 0.221ms | 0.397ms | 0.397ms | 3.82ms | js |
| dom/create-elements | 0.031ms | 0.204ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.295ms | — | — | js |
| dom/read-attributes | 0.048ms | 0.143ms | — | — | js |
| dom/modify-text | 0.038ms | 0.126ms | — | — | js |
| mixed/csv-parse | 0.367ms | 5.43ms | 0.625ms | FAILED | js |
| mixed/text-search | 0.316ms | 4.21ms | 0.905ms | FAILED | js |
| mixed/fibonacci | 0.097ms | 0.236ms | 0.236ms | 0.955ms | js |
| mixed/matrix-multiply | 0.147ms | 0.440ms | 0.440ms | 1.58ms | js |
| mixed/sieve | 1.39ms | 1.16ms | 1.17ms | FAILED | host-call |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/includes | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/split | linear-memory | warmup | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/startsWith-endsWith | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/text-search | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.64 | 3.81 | 3.34 | — |
| string/concat-long | 1000 | 3.40 | 6.62 | 7.28 | — |
| string/indexOf | 1000 | 14.85 | 62.05 | 18.72 | — |
| string/includes | 1000 | 14.52 | 95.37 | 17.79 | — |
| string/split | 10000 | 32.77 | 431.90 | 109.36 | — |
| string/replace | 1000 | 35.34 | 163.01 | 60.24 | — |
| string/case-convert | 2000 | 24.29 | 89.45 | 44.06 | — |
| string/substring | 10000 | 8.12 | 149.97 | 71.85 | — |
| string/trim | 10000 | 13.49 | 104.84 | 56.94 | — |
| string/startsWith-endsWith | 20000 | 16.62 | 106.88 | 20.51 | — |
| mixed/csv-parse | 11000 | 33.33 | 493.80 | 56.85 | — |
| mixed/text-search | 40000 | 7.91 | 105.25 | 22.64 | — |
| mixed/fibonacci | 10000 | 9.72 | 23.63 | 23.62 | 95.52 |
| mixed/matrix-multiply | 125000 | 1.17 | 3.52 | 3.52 | 12.63 |
| mixed/sieve | 200000 | 6.97 | 5.78 | 5.86 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.27x slower | — |
| string/concat-long | 1.95x slower | 2.14x slower | — |
| string/indexOf | 4.18x slower | 1.26x slower | — |
| string/includes | 6.57x slower | 1.23x slower | — |
| string/split | 13.18x slower | 3.34x slower | — |
| string/replace | 4.61x slower | 1.70x slower | — |
| string/case-convert | 3.68x slower | 1.81x slower | — |
| string/substring | 18.47x slower | 8.85x slower | — |
| string/trim | 7.77x slower | 4.22x slower | — |
| string/startsWith-endsWith | 6.43x slower | 1.23x slower | — |
| array/push-pop | 1.51x slower | 1.51x slower | — |
| array/sort-i32 | 2.01x faster | 2.05x faster | — |
| array/map-filter | 4.93x slower | 4.92x slower | — |
| array/reduce | 1.07x slower | 1.08x slower | — |
| array/indexOf | 1.16x faster | 1.16x faster | — |
| array/slice | 1.63x faster | 1.58x faster | — |
| array/reverse | 2.40x faster | 2.40x faster | — |
| array/forEach | 1.28x slower | 1.27x slower | — |
| array/find | 1.80x slower | 1.80x slower | 17.31x slower |
| dom/create-elements | 6.68x slower | — | — |
| dom/set-attributes | 3.48x slower | — | — |
| dom/read-attributes | 2.96x slower | — | — |
| dom/modify-text | 3.35x slower | — | — |
| mixed/csv-parse | 14.82x slower | 1.71x slower | — |
| mixed/text-search | 13.30x slower | 2.86x slower | — |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 9.83x slower |
| mixed/matrix-multiply | 3.00x slower | 3.00x slower | 10.76x slower |
| mixed/sieve | 1.21x faster | 1.19x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.10x slower |
| string/indexOf | 3.32x faster |
| string/includes | 5.36x faster |
| string/split | 3.95x faster |
| string/replace | 2.71x faster |
| string/case-convert | 2.03x faster |
| string/substring | 2.09x faster |
| string/trim | 1.84x faster |
| string/startsWith-endsWith | 5.21x faster |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 8.69x faster |
| mixed/text-search | 4.65x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 724B | — |
| string/concat-long | 233B | 964B | — |
| string/indexOf | 412B | 1.3KB | — |
| string/includes | 398B | 1.3KB | — |
| string/split | 1.7KB | 3.4KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.4KB | 13.1KB | — |
| string/substring | 556B | 1.0KB | — |
| string/trim | 1.4KB | 2.8KB | — |
| string/startsWith-endsWith | 1.8KB | 3.7KB | — |
| array/push-pop | 956B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.0KB | 1.3KB | — |
| array/slice | 1.0KB | 1.3KB | — |
| array/reverse | 1020B | 1.3KB | — |
| array/forEach | 2.6KB | 2.9KB | — |
| array/find | 2.7KB | 3.0KB | 623B |
| dom/create-elements | 240B | — | — |
| dom/set-attributes | 507B | — | — |
| dom/read-attributes | 357B | — | — |
| dom/modify-text | 247B | — | — |
| mixed/csv-parse | 2.2KB | 4.4KB | — |
| mixed/text-search | 2.0KB | 4.4KB | — |
| mixed/fibonacci | 297B | 297B | 313B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 950B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1028.3ms | 859.0ms | — |
| string/concat-long | 519.1ms | 775.2ms | — |
| string/indexOf | 598.7ms | 789.2ms | — |
| string/includes | 583.8ms | 786.5ms | — |
| string/split | 663.8ms | 813.4ms | — |
| string/replace | 638.5ms | 823.4ms | — |
| string/case-convert | 640.4ms | 849.5ms | — |
| string/substring | 562.9ms | 729.7ms | — |
| string/trim | 634.7ms | 828.5ms | — |
| string/startsWith-endsWith | 653.8ms | 780.0ms | — |
| array/push-pop | 599.4ms | 659.1ms | — |
| array/sort-i32 | 770.0ms | 793.2ms | — |
| array/map-filter | 743.1ms | 777.1ms | — |
| array/reduce | 666.8ms | 732.7ms | — |
| array/indexOf | 617.5ms | 637.1ms | — |
| array/slice | 605.8ms | 700.4ms | — |
| array/reverse | 621.9ms | 663.7ms | — |
| array/forEach | 681.9ms | 730.4ms | — |
| array/find | 701.1ms | 754.5ms | 642.8ms |
| dom/create-elements | 501.6ms | — | — |
| dom/set-attributes | 554.7ms | — | — |
| dom/read-attributes | 563.7ms | — | — |
| dom/modify-text | 547.2ms | — | — |
| mixed/csv-parse | 703.8ms | 770.1ms | — |
| mixed/text-search | 632.7ms | 799.7ms | — |
| mixed/fibonacci | 627.3ms | 735.3ms | 618.1ms |
| mixed/matrix-multiply | 707.5ms | 729.5ms | 625.6ms |
| mixed/sieve | 672.8ms | 706.3ms | — |
