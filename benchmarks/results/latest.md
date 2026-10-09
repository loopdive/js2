# js2wasm Benchmark Results

Date: 2026-10-09
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.047ms | 0.046ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.115ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.424ms | 8.43ms | 2.99ms | FAILED | js |
| string/replace | 0.101ms | 0.703ms | 0.338ms | FAILED | js |
| string/case-convert | 0.056ms | 0.634ms | 0.273ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 4.15ms | 2.79ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 2.92ms | 3.08ms | 0.562ms | js |
| array/push-pop | 1.43ms | 0.512ms | 0.513ms | FAILED | host-call |
| array/sort-i32 | 0.801ms | 0.294ms | 0.295ms | FAILED | host-call |
| array/map-filter | 0.130ms | 0.071ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.16ms | 0.509ms | 0.516ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.65ms | 2.65ms | FAILED | gc-native |
| array/slice | 0.028ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.256ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.037ms | 0.096ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.221ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.122ms | — | — | js |
| dom/modify-text | 0.030ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.487ms | 8.83ms | 0.631ms | FAILED | js |
| mixed/text-search | 0.388ms | 5.11ms | 2.98ms | 1.09ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.294ms | js |
| mixed/matrix-multiply | 0.160ms | 73.01ms | 75.72ms | 0.721ms | js |
| mixed/sieve | 1.64ms | 2.11ms | 2.13ms | FAILED | js |

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
| string/concat-short | 10000 | 3.49 | 4.70 | 4.57 | — |
| string/concat-long | 1000 | 3.76 | 4.68 | 3.90 | — |
| string/indexOf | 1000 | 19.19 | 64.04 | 12.32 | 15.38 |
| string/includes | 1000 | 19.25 | 114.81 | 14.88 | 15.40 |
| string/split | 10000 | 42.45 | 843.47 | 299.31 | — |
| string/replace | 1000 | 100.97 | 703.17 | 337.74 | — |
| string/case-convert | 2000 | 27.81 | 317.24 | 136.27 | — |
| string/substring | 10000 | 9.91 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.05 | 414.57 | 279.15 | — |
| string/startsWith-endsWith | 20000 | 20.11 | 146.08 | 154.04 | 28.10 |
| array/map-filter | 30000 | 4.33 | 2.37 | 2.39 | — |
| array/indexOf | 1000 | 3953.41 | 2646.47 | 2645.11 | — |
| dom/create-elements | 2000 | 18.73 | 47.87 | — | — |
| dom/set-attributes | 6000 | 17.55 | 36.75 | — | — |
| dom/read-attributes | 3000 | 18.74 | 40.56 | — | — |
| dom/modify-text | 2000 | 14.98 | 54.78 | — | — |
| mixed/csv-parse | 11000 | 44.26 | 802.83 | 57.37 | — |
| mixed/text-search | 40000 | 9.71 | 127.76 | 74.48 | 27.13 |
| mixed/fibonacci | 10000 | 12.02 | 28.30 | 28.31 | 29.43 |
| mixed/matrix-multiply | 125000 | 1.28 | 584.08 | 605.79 | 5.77 |
| mixed/sieve | 200000 | 8.19 | 10.54 | 10.65 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.35x slower | 1.31x slower | — |
| string/concat-long | 1.24x slower | 1.04x slower | — |
| string/indexOf | 3.34x slower | 1.56x faster | 1.25x faster |
| string/includes | 5.96x slower | 1.29x faster | 1.25x faster |
| string/split | 19.87x slower | 7.05x slower | — |
| string/replace | 6.96x slower | 3.35x slower | — |
| string/case-convert | 11.41x slower | 4.90x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 24.31x slower | 16.37x slower | — |
| string/startsWith-endsWith | 7.26x slower | 7.66x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.79x faster | — |
| array/sort-i32 | 2.72x faster | 2.71x faster | — |
| array/map-filter | 1.82x faster | 1.81x faster | — |
| array/reduce | 4.25x faster | 4.20x faster | — |
| array/indexOf | 1.49x faster | 1.49x faster | — |
| array/slice | 1.05x slower | 1.05x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.77x faster | — |
| array/find | 15.84x faster | 16.03x faster | 4.22x slower |
| dom/create-elements | 2.56x slower | — | — |
| dom/set-attributes | 2.09x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.66x slower | — | — |
| mixed/csv-parse | 18.14x slower | 1.30x slower | — |
| mixed/text-search | 13.16x slower | 7.67x slower | 2.79x slower |
| mixed/fibonacci | 2.35x slower | 2.36x slower | 2.45x slower |
| mixed/matrix-multiply | 457.16x slower | 474.16x slower | 4.51x slower |
| mixed/sieve | 1.29x slower | 1.30x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.20x faster |
| string/includes | 7.72x faster |
| string/split | 2.82x faster |
| string/replace | 2.08x faster |
| string/case-convert | 2.33x faster |
| string/substring | 1.22x faster |
| string/trim | 1.49x faster |
| string/startsWith-endsWith | 1.05x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 13.99x faster |
| mixed/text-search | 1.72x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1189.0ms | 623.6ms | — |
| string/concat-long | 458.1ms | 661.0ms | — |
| string/indexOf | 384.4ms | 682.8ms | 552.3ms |
| string/includes | 391.8ms | 672.8ms | 570.3ms |
| string/split | 538.6ms | 692.1ms | — |
| string/replace | 521.2ms | 772.1ms | — |
| string/case-convert | 529.7ms | 619.8ms | — |
| string/substring | 407.9ms | 500.0ms | — |
| string/trim | 487.8ms | 686.8ms | — |
| string/startsWith-endsWith | 513.9ms | 688.9ms | 625.9ms |
| array/push-pop | 514.2ms | 596.8ms | — |
| array/sort-i32 | 669.3ms | 747.3ms | — |
| array/map-filter | 704.3ms | 740.6ms | — |
| array/reduce | 635.4ms | 723.7ms | — |
| array/indexOf | 601.3ms | 695.5ms | — |
| array/slice | 516.3ms | 609.2ms | — |
| array/reverse | 538.3ms | 597.0ms | — |
| array/forEach | 655.2ms | 705.9ms | — |
| array/find | 510.6ms | 582.9ms | 553.0ms |
| dom/create-elements | 400.6ms | — | — |
| dom/set-attributes | 400.8ms | — | — |
| dom/read-attributes | 404.8ms | — | — |
| dom/modify-text | 370.5ms | — | — |
| mixed/csv-parse | 540.1ms | 666.8ms | — |
| mixed/text-search | 513.9ms | 712.4ms | 624.4ms |
| mixed/fibonacci | 470.7ms | 501.2ms | 490.5ms |
| mixed/matrix-multiply | 652.3ms | 698.6ms | 527.0ms |
| mixed/sieve | 614.8ms | 689.4ms | — |
