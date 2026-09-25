# js2wasm Benchmark Results

Date: 2026-09-25
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.041ms | 0.046ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.013ms | 0.041ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.014ms | 0.082ms | 0.012ms | 0.013ms | gc-native |
| string/split | 0.306ms | 5.17ms | 1.87ms | FAILED | js |
| string/replace | 0.069ms | 0.407ms | 0.241ms | FAILED | js |
| string/case-convert | 0.045ms | 0.383ms | 0.188ms | FAILED | js |
| string/substring | 0.131ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.247ms | 2.66ms | 1.98ms | FAILED | js |
| string/startsWith-endsWith | 0.410ms | 2.14ms | 2.17ms | 0.456ms | js |
| array/push-pop | 1.31ms | 0.446ms | 0.436ms | FAILED | gc-native |
| array/sort-i32 | 0.534ms | 0.291ms | 0.424ms | FAILED | host-call |
| array/map-filter | 0.124ms | 0.075ms | 0.075ms | FAILED | host-call |
| array/reduce | 1.89ms | 0.437ms | 0.437ms | FAILED | gc-native |
| array/indexOf | 4.56ms | 2.20ms | 2.19ms | FAILED | gc-native |
| array/slice | 0.045ms | 0.050ms | 0.043ms | FAILED | gc-native |
| array/reverse | 5.76ms | 3.18ms | 3.18ms | FAILED | host-call |
| array/forEach | 0.080ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.252ms | 0.016ms | 0.016ms | 0.821ms | host-call |
| dom/create-elements | 0.067ms | 0.097ms | — | — | js |
| dom/set-attributes | 0.118ms | 0.171ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.101ms | — | — | js |
| dom/modify-text | 0.060ms | 0.093ms | — | — | js |
| mixed/csv-parse | 0.326ms | 5.57ms | 0.478ms | FAILED | js |
| mixed/text-search | 0.355ms | 3.17ms | 2.11ms | 0.949ms | js |
| mixed/fibonacci | 0.111ms | 0.183ms | 0.182ms | 0.176ms | js |
| mixed/matrix-multiply | 0.161ms | 50.12ms | 50.49ms | 0.610ms | js |
| mixed/sieve | 1.51ms | 2.11ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 4.50 | 4.14 | 4.61 | — |
| string/concat-long | 1000 | 3.88 | 4.51 | 6.41 | — |
| string/indexOf | 1000 | 13.38 | 40.87 | 9.95 | 13.05 |
| string/includes | 1000 | 13.65 | 82.34 | 12.17 | 12.76 |
| string/split | 10000 | 30.58 | 516.98 | 187.36 | — |
| string/replace | 1000 | 68.73 | 407.21 | 241.10 | — |
| string/case-convert | 2000 | 22.44 | 191.65 | 94.14 | — |
| string/substring | 10000 | 13.13 | 3.17 | 2.65 | — |
| string/trim | 10000 | 24.71 | 266.03 | 198.49 | — |
| string/startsWith-endsWith | 20000 | 20.52 | 106.87 | 108.39 | 22.81 |
| array/map-filter | 30000 | 4.14 | 2.50 | 2.51 | — |
| array/indexOf | 1000 | 4561.44 | 2195.19 | 2193.45 | — |
| dom/create-elements | 2000 | 33.30 | 48.55 | — | — |
| dom/set-attributes | 6000 | 19.69 | 28.48 | — | — |
| dom/read-attributes | 3000 | 24.32 | 33.72 | — | — |
| dom/modify-text | 2000 | 30.24 | 46.44 | — | — |
| mixed/csv-parse | 11000 | 29.60 | 506.44 | 43.46 | — |
| mixed/text-search | 40000 | 8.87 | 79.28 | 52.70 | 23.74 |
| mixed/fibonacci | 10000 | 11.14 | 18.28 | 18.25 | 17.60 |
| mixed/matrix-multiply | 125000 | 1.29 | 400.97 | 403.89 | 4.88 |
| mixed/sieve | 200000 | 7.53 | 10.54 | 10.44 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.09x faster | 1.03x slower | — |
| string/concat-long | 1.16x slower | 1.65x slower | — |
| string/indexOf | 3.05x slower | 1.34x faster | 1.03x faster |
| string/includes | 6.03x slower | 1.12x faster | 1.07x faster |
| string/split | 16.91x slower | 6.13x slower | — |
| string/replace | 5.92x slower | 3.51x slower | — |
| string/case-convert | 8.54x slower | 4.20x slower | — |
| string/substring | 4.14x faster | 4.95x faster | — |
| string/trim | 10.77x slower | 8.03x slower | — |
| string/startsWith-endsWith | 5.21x slower | 5.28x slower | 1.11x slower |
| array/push-pop | 2.94x faster | 3.01x faster | — |
| array/sort-i32 | 1.84x faster | 1.26x faster | — |
| array/map-filter | 1.66x faster | 1.65x faster | — |
| array/reduce | 4.32x faster | 4.32x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.11x slower | 1.06x faster | — |
| array/reverse | 1.81x faster | 1.81x faster | — |
| array/forEach | 3.40x faster | 3.40x faster | — |
| array/find | 15.48x faster | 15.46x faster | 3.25x slower |
| dom/create-elements | 1.46x slower | — | — |
| dom/set-attributes | 1.45x slower | — | — |
| dom/read-attributes | 1.39x slower | — | — |
| dom/modify-text | 1.54x slower | — | — |
| mixed/csv-parse | 17.11x slower | 1.47x slower | — |
| mixed/text-search | 8.93x slower | 5.94x slower | 2.67x slower |
| mixed/fibonacci | 1.64x slower | 1.64x slower | 1.58x slower |
| mixed/matrix-multiply | 311.85x slower | 314.13x slower | 3.80x slower |
| mixed/sieve | 1.40x slower | 1.39x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x slower |
| string/concat-long | 1.42x slower |
| string/indexOf | 4.11x faster |
| string/includes | 6.76x faster |
| string/split | 2.76x faster |
| string/replace | 1.69x faster |
| string/case-convert | 2.04x faster |
| string/substring | 1.20x faster |
| string/trim | 1.34x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.46x slower |
| array/map-filter | 1.01x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.18x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 11.65x faster |
| mixed/text-search | 1.50x faster |
| mixed/fibonacci | 1.00x faster |
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
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 934.8ms | 506.7ms | — |
| string/concat-long | 380.8ms | 541.5ms | — |
| string/indexOf | 323.0ms | 558.7ms | 453.2ms |
| string/includes | 333.9ms | 544.1ms | 449.4ms |
| string/split | 425.3ms | 568.9ms | — |
| string/replace | 395.3ms | 602.9ms | — |
| string/case-convert | 425.5ms | 501.0ms | — |
| string/substring | 330.2ms | 399.0ms | — |
| string/trim | 404.6ms | 570.1ms | — |
| string/startsWith-endsWith | 460.9ms | 558.2ms | 503.8ms |
| array/push-pop | 450.6ms | 490.5ms | — |
| array/sort-i32 | 554.9ms | 613.9ms | — |
| array/map-filter | 558.8ms | 598.1ms | — |
| array/reduce | 484.8ms | 563.2ms | — |
| array/indexOf | 508.2ms | 592.2ms | — |
| array/slice | 442.0ms | 499.6ms | — |
| array/reverse | 425.2ms | 488.1ms | — |
| array/forEach | 541.8ms | 604.1ms | — |
| array/find | 418.5ms | 490.8ms | 453.9ms |
| dom/create-elements | 355.9ms | — | — |
| dom/set-attributes | 323.4ms | — | — |
| dom/read-attributes | 326.4ms | — | — |
| dom/modify-text | 328.6ms | — | — |
| mixed/csv-parse | 431.9ms | 574.4ms | — |
| mixed/text-search | 430.0ms | 592.2ms | 529.5ms |
| mixed/fibonacci | 384.3ms | 426.3ms | 406.7ms |
| mixed/matrix-multiply | 505.3ms | 589.9ms | 455.4ms |
| mixed/sieve | 522.9ms | 583.2ms | — |
