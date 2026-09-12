# js2wasm Benchmark Results

Date: 2026-09-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.052ms | 0.047ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.012ms | 0.025ms | gc-native |
| string/includes | 0.019ms | 0.104ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.421ms | 7.57ms | 2.60ms | FAILED | js |
| string/replace | 0.095ms | 0.579ms | 0.270ms | FAILED | js |
| string/case-convert | 0.058ms | 0.527ms | 0.235ms | FAILED | js |
| string/substring | 0.105ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 3.26ms | 2.32ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 2.49ms | 2.49ms | 0.557ms | js |
| array/push-pop | 1.61ms | 0.587ms | 0.585ms | FAILED | gc-native |
| array/sort-i32 | 0.840ms | 0.300ms | 0.300ms | FAILED | host-call |
| array/map-filter | 0.133ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.56ms | 0.590ms | 0.585ms | FAILED | gc-native |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.016ms | 0.016ms | FAILED | gc-native |
| array/reverse | 8.84ms | 3.97ms | 3.98ms | FAILED | host-call |
| array/forEach | 0.051ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.270ms | 0.015ms | 0.015ms | 1.12ms | host-call |
| dom/create-elements | 0.202ms | 0.104ms | — | — | host-call |
| dom/set-attributes | 0.112ms | 0.245ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.135ms | — | — | js |
| dom/modify-text | 0.033ms | 0.115ms | — | — | js |
| mixed/csv-parse | 0.468ms | 8.01ms | 0.535ms | FAILED | js |
| mixed/text-search | 0.403ms | 4.38ms | 2.41ms | 1.13ms | js |
| mixed/fibonacci | 0.125ms | 0.328ms | 0.328ms | 0.325ms | js |
| mixed/matrix-multiply | 0.184ms | 65.05ms | 64.46ms | 0.719ms | js |
| mixed/sieve | 1.72ms | 2.29ms | 2.31ms | FAILED | js |

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
| string/concat-short | 10000 | 3.67 | 5.17 | 4.72 | — |
| string/concat-long | 1000 | 4.29 | 5.33 | 3.38 | — |
| string/indexOf | 1000 | 18.95 | 59.86 | 12.20 | 24.55 |
| string/includes | 1000 | 18.70 | 103.79 | 13.80 | 16.64 |
| string/split | 10000 | 42.08 | 756.78 | 259.70 | — |
| string/replace | 1000 | 94.81 | 578.66 | 269.72 | — |
| string/case-convert | 2000 | 28.98 | 263.56 | 117.35 | — |
| string/substring | 10000 | 10.49 | 3.98 | 3.43 | — |
| string/trim | 10000 | 17.27 | 326.31 | 232.40 | — |
| string/startsWith-endsWith | 20000 | 20.63 | 124.45 | 124.55 | 27.83 |
| array/map-filter | 30000 | 4.43 | 2.17 | 2.17 | — |
| array/indexOf | 1000 | 4458.17 | 2863.43 | 2861.57 | — |
| dom/create-elements | 2000 | 100.92 | 51.90 | — | — |
| dom/set-attributes | 6000 | 18.61 | 40.87 | — | — |
| dom/read-attributes | 3000 | 20.41 | 44.94 | — | — |
| dom/modify-text | 2000 | 16.72 | 57.32 | — | — |
| mixed/csv-parse | 11000 | 42.54 | 728.13 | 48.60 | — |
| mixed/text-search | 40000 | 10.07 | 109.39 | 60.16 | 28.23 |
| mixed/fibonacci | 10000 | 12.53 | 32.76 | 32.75 | 32.50 |
| mixed/matrix-multiply | 125000 | 1.47 | 520.41 | 515.65 | 5.75 |
| mixed/sieve | 200000 | 8.62 | 11.46 | 11.53 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.41x slower | 1.29x slower | — |
| string/concat-long | 1.24x slower | 1.27x faster | — |
| string/indexOf | 3.16x slower | 1.55x faster | 1.30x slower |
| string/includes | 5.55x slower | 1.35x faster | 1.12x faster |
| string/split | 17.99x slower | 6.17x slower | — |
| string/replace | 6.10x slower | 2.84x slower | — |
| string/case-convert | 9.10x slower | 4.05x slower | — |
| string/substring | 2.63x faster | 3.06x faster | — |
| string/trim | 18.89x slower | 13.45x slower | — |
| string/startsWith-endsWith | 6.03x slower | 6.04x slower | 1.35x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.80x faster | 2.80x faster | — |
| array/map-filter | 2.05x faster | 2.05x faster | — |
| array/reduce | 2.65x faster | 2.67x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.00x faster | 2.00x faster | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.80x faster | 1.80x faster | — |
| array/find | 18.54x faster | 18.38x faster | 4.14x slower |
| dom/create-elements | 1.94x faster | — | — |
| dom/set-attributes | 2.20x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.43x slower | — | — |
| mixed/csv-parse | 17.12x slower | 1.14x slower | — |
| mixed/text-search | 10.86x slower | 5.98x slower | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 353.49x slower | 350.26x slower | 3.91x slower |
| mixed/sieve | 1.33x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x faster |
| string/concat-long | 1.57x faster |
| string/indexOf | 4.91x faster |
| string/includes | 7.52x faster |
| string/split | 2.91x faster |
| string/replace | 2.15x faster |
| string/case-convert | 2.25x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.98x faster |
| mixed/text-search | 1.82x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1058.8ms | 603.8ms | — |
| string/concat-long | 436.4ms | 652.0ms | — |
| string/indexOf | 367.1ms | 665.6ms | 551.3ms |
| string/includes | 355.0ms | 683.4ms | 547.1ms |
| string/split | 478.1ms | 654.7ms | — |
| string/replace | 489.7ms | 704.8ms | — |
| string/case-convert | 478.1ms | 557.6ms | — |
| string/substring | 408.1ms | 450.5ms | — |
| string/trim | 463.6ms | 654.0ms | — |
| string/startsWith-endsWith | 481.0ms | 645.2ms | 603.9ms |
| array/push-pop | 498.9ms | 557.8ms | — |
| array/sort-i32 | 630.2ms | 665.7ms | — |
| array/map-filter | 655.1ms | 687.1ms | — |
| array/reduce | 576.4ms | 658.7ms | — |
| array/indexOf | 574.9ms | 645.9ms | — |
| array/slice | 498.2ms | 561.5ms | — |
| array/reverse | 463.2ms | 542.1ms | — |
| array/forEach | 619.7ms | 674.7ms | — |
| array/find | 489.0ms | 536.8ms | 525.6ms |
| dom/create-elements | 425.8ms | — | — |
| dom/set-attributes | 411.2ms | — | — |
| dom/read-attributes | 404.8ms | — | — |
| dom/modify-text | 387.9ms | — | — |
| mixed/csv-parse | 488.5ms | 663.1ms | — |
| mixed/text-search | 486.8ms | 661.7ms | 607.7ms |
| mixed/fibonacci | 461.7ms | 496.2ms | 463.3ms |
| mixed/matrix-multiply | 607.0ms | 684.8ms | 498.0ms |
| mixed/sieve | 560.1ms | 668.7ms | — |
