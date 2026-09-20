# js2wasm Benchmark Results

Date: 2026-09-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.049ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.016ms | gc-native |
| string/includes | 0.019ms | 0.115ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.423ms | 8.29ms | 3.01ms | FAILED | js |
| string/replace | 0.107ms | 0.693ms | 0.334ms | FAILED | js |
| string/case-convert | 0.056ms | 0.607ms | 0.286ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.99ms | 2.94ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 3.26ms | 3.02ms | 0.560ms | js |
| array/push-pop | 1.42ms | 0.509ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.789ms | 0.295ms | 0.295ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.070ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.504ms | 0.502ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.034ms | 0.145ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.217ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.123ms | — | — | js |
| dom/modify-text | 0.029ms | 0.107ms | — | — | js |
| mixed/csv-parse | 0.481ms | 9.03ms | 0.641ms | FAILED | js |
| mixed/text-search | 0.390ms | 5.11ms | 3.02ms | 1.10ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 73.21ms | 73.79ms | 0.720ms | js |
| mixed/sieve | 1.57ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 3.37 | 4.88 | 4.51 | — |
| string/concat-long | 1000 | 3.55 | 4.46 | 3.50 | — |
| string/indexOf | 1000 | 19.16 | 63.65 | 12.26 | 15.67 |
| string/includes | 1000 | 19.20 | 114.52 | 14.79 | 15.46 |
| string/split | 10000 | 42.33 | 829.48 | 300.94 | — |
| string/replace | 1000 | 107.35 | 692.94 | 334.00 | — |
| string/case-convert | 2000 | 27.87 | 303.41 | 143.22 | — |
| string/substring | 10000 | 9.88 | 3.74 | 3.07 | — |
| string/trim | 10000 | 17.03 | 399.26 | 294.46 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 163.17 | 151.16 | 27.98 |
| array/map-filter | 30000 | 4.25 | 2.35 | 2.35 | — |
| array/indexOf | 1000 | 3948.58 | 2639.39 | 2637.62 | — |
| dom/create-elements | 2000 | 17.01 | 72.69 | — | — |
| dom/set-attributes | 6000 | 17.09 | 36.16 | — | — |
| dom/read-attributes | 3000 | 18.28 | 41.11 | — | — |
| dom/modify-text | 2000 | 14.30 | 53.71 | — | — |
| mixed/csv-parse | 11000 | 43.71 | 820.83 | 58.27 | — |
| mixed/text-search | 40000 | 9.75 | 127.83 | 75.43 | 27.39 |
| mixed/fibonacci | 10000 | 12.01 | 28.32 | 28.32 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.26 | 585.66 | 590.34 | 5.76 |
| mixed/sieve | 200000 | 7.84 | 10.59 | 10.53 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.34x slower | — |
| string/concat-long | 1.26x slower | 1.02x faster | — |
| string/indexOf | 3.32x slower | 1.56x faster | 1.22x faster |
| string/includes | 5.96x slower | 1.30x faster | 1.24x faster |
| string/split | 19.59x slower | 7.11x slower | — |
| string/replace | 6.46x slower | 3.11x slower | — |
| string/case-convert | 10.89x slower | 5.14x slower | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 23.44x slower | 17.29x slower | — |
| string/startsWith-endsWith | 8.15x slower | 7.55x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.82x faster | — |
| array/sort-i32 | 2.67x faster | 2.68x faster | — |
| array/map-filter | 1.81x faster | 1.81x faster | — |
| array/reduce | 4.27x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.73x faster | 1.72x faster | — |
| array/find | 15.88x faster | 16.02x faster | 4.22x slower |
| dom/create-elements | 4.27x slower | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.76x slower | — | — |
| mixed/csv-parse | 18.78x slower | 1.33x slower | — |
| mixed/text-search | 13.11x slower | 7.74x slower | 2.81x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.34x slower |
| mixed/matrix-multiply | 465.24x slower | 468.96x slower | 4.58x slower |
| mixed/sieve | 1.35x slower | 1.34x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.28x faster |
| string/indexOf | 5.19x faster |
| string/includes | 7.74x faster |
| string/split | 2.76x faster |
| string/replace | 2.07x faster |
| string/case-convert | 2.12x faster |
| string/substring | 1.22x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.08x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.09x faster |
| mixed/text-search | 1.69x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.01x faster |

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
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1136.4ms | 641.2ms | — |
| string/concat-long | 426.2ms | 663.1ms | — |
| string/indexOf | 372.3ms | 654.3ms | 545.1ms |
| string/includes | 365.9ms | 663.2ms | 554.9ms |
| string/split | 504.1ms | 694.7ms | — |
| string/replace | 508.3ms | 761.1ms | — |
| string/case-convert | 513.7ms | 687.3ms | — |
| string/substring | 390.9ms | 479.8ms | — |
| string/trim | 493.8ms | 671.8ms | — |
| string/startsWith-endsWith | 485.1ms | 699.2ms | 597.4ms |
| array/push-pop | 492.8ms | 594.1ms | — |
| array/sort-i32 | 679.2ms | 718.7ms | — |
| array/map-filter | 675.6ms | 731.3ms | — |
| array/reduce | 627.6ms | 696.5ms | — |
| array/indexOf | 603.7ms | 691.6ms | — |
| array/slice | 520.5ms | 589.7ms | — |
| array/reverse | 486.1ms | 582.5ms | — |
| array/forEach | 664.5ms | 733.2ms | — |
| array/find | 493.0ms | 593.6ms | 527.0ms |
| dom/create-elements | 406.4ms | — | — |
| dom/set-attributes | 377.6ms | — | — |
| dom/read-attributes | 385.5ms | — | — |
| dom/modify-text | 358.2ms | — | — |
| mixed/csv-parse | 542.2ms | 686.2ms | — |
| mixed/text-search | 505.0ms | 697.8ms | 634.0ms |
| mixed/fibonacci | 424.5ms | 498.1ms | 471.0ms |
| mixed/matrix-multiply | 624.3ms | 704.2ms | 512.5ms |
| mixed/sieve | 587.0ms | 667.6ms | — |
