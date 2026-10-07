# js2wasm Benchmark Results

Date: 2026-10-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.020ms | 0.030ms | 0.030ms | FAILED | js |
| string/concat-long | 0.002ms | 0.002ms | 0.002ms | FAILED | gc-native |
| string/indexOf | 0.011ms | 0.032ms | 0.007ms | 0.032ms | gc-native |
| string/includes | 0.011ms | 0.062ms | 0.008ms | 0.034ms | gc-native |
| string/split | 0.221ms | 4.64ms | 1.43ms | FAILED | js |
| string/replace | 0.051ms | 0.347ms | 0.156ms | FAILED | js |
| string/case-convert | 0.034ms | 0.297ms | 0.132ms | FAILED | js |
| string/substring | 0.053ms | 0.022ms | 0.018ms | FAILED | gc-native |
| string/trim | 0.097ms | 1.83ms | 1.36ms | FAILED | js |
| string/startsWith-endsWith | 0.222ms | 1.52ms | 1.43ms | 0.408ms | js |
| array/push-pop | 0.997ms | 0.367ms | 0.363ms | FAILED | gc-native |
| array/sort-i32 | 0.432ms | 0.170ms | 0.169ms | FAILED | gc-native |
| array/map-filter | 0.084ms | 0.042ms | 0.042ms | FAILED | gc-native |
| array/reduce | 0.987ms | 0.331ms | 0.329ms | FAILED | gc-native |
| array/indexOf | 2.55ms | 1.79ms | 1.79ms | FAILED | host-call |
| array/slice | 0.018ms | 0.017ms | 0.017ms | FAILED | gc-native |
| array/reverse | 4.67ms | 1.94ms | 1.96ms | FAILED | host-call |
| array/forEach | 0.059ms | 0.016ms | 0.017ms | FAILED | host-call |
| array/find | 0.165ms | 0.008ms | 0.009ms | 0.557ms | host-call |
| dom/create-elements | 0.026ms | 0.058ms | — | — | js |
| dom/set-attributes | 0.065ms | 0.115ms | — | — | js |
| dom/read-attributes | 0.037ms | 0.077ms | — | — | js |
| dom/modify-text | 0.017ms | 0.059ms | — | — | js |
| mixed/csv-parse | 0.271ms | 4.89ms | 0.323ms | FAILED | js |
| mixed/text-search | 0.207ms | 2.70ms | 1.36ms | 0.646ms | js |
| mixed/fibonacci | 0.061ms | 0.167ms | 0.168ms | 0.182ms | js |
| mixed/matrix-multiply | 0.197ms | 33.94ms | 35.25ms | 0.416ms | js |
| mixed/sieve | 1.06ms | 1.44ms | 1.46ms | FAILED | js |

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
| string/concat-short | 10000 | 1.95 | 3.04 | 3.04 | — |
| string/concat-long | 1000 | 2.29 | 2.46 | 2.23 | — |
| string/indexOf | 1000 | 10.97 | 32.26 | 6.85 | 31.65 |
| string/includes | 1000 | 10.72 | 62.07 | 7.58 | 33.99 |
| string/split | 10000 | 22.05 | 464.40 | 143.03 | — |
| string/replace | 1000 | 51.38 | 347.35 | 155.69 | — |
| string/case-convert | 2000 | 17.00 | 148.68 | 65.84 | — |
| string/substring | 10000 | 5.29 | 2.16 | 1.83 | — |
| string/trim | 10000 | 9.73 | 183.37 | 135.93 | — |
| string/startsWith-endsWith | 20000 | 11.08 | 75.88 | 71.29 | 20.40 |
| array/map-filter | 30000 | 2.79 | 1.42 | 1.41 | — |
| array/indexOf | 1000 | 2546.96 | 1785.19 | 1785.40 | — |
| dom/create-elements | 2000 | 12.78 | 28.77 | — | — |
| dom/set-attributes | 6000 | 10.82 | 19.09 | — | — |
| dom/read-attributes | 3000 | 12.19 | 25.55 | — | — |
| dom/modify-text | 2000 | 8.39 | 29.49 | — | — |
| mixed/csv-parse | 11000 | 24.64 | 444.79 | 29.39 | — |
| mixed/text-search | 40000 | 5.16 | 67.40 | 34.03 | 16.16 |
| mixed/fibonacci | 10000 | 6.08 | 16.74 | 16.80 | 18.16 |
| mixed/matrix-multiply | 125000 | 1.58 | 271.53 | 281.97 | 3.33 |
| mixed/sieve | 200000 | 5.29 | 7.19 | 7.29 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.56x slower | 1.56x slower | — |
| string/concat-long | 1.08x slower | 1.02x faster | — |
| string/indexOf | 2.94x slower | 1.60x faster | 2.89x slower |
| string/includes | 5.79x slower | 1.41x faster | 3.17x slower |
| string/split | 21.06x slower | 6.49x slower | — |
| string/replace | 6.76x slower | 3.03x slower | — |
| string/case-convert | 8.75x slower | 3.87x slower | — |
| string/substring | 2.45x faster | 2.89x faster | — |
| string/trim | 18.84x slower | 13.97x slower | — |
| string/startsWith-endsWith | 6.85x slower | 6.44x slower | 1.84x slower |
| array/push-pop | 2.71x faster | 2.75x faster | — |
| array/sort-i32 | 2.54x faster | 2.56x faster | — |
| array/map-filter | 1.97x faster | 1.98x faster | — |
| array/reduce | 2.98x faster | 3.00x faster | — |
| array/indexOf | 1.43x faster | 1.43x faster | — |
| array/slice | 1.05x faster | 1.05x faster | — |
| array/reverse | 2.41x faster | 2.39x faster | — |
| array/forEach | 3.66x faster | 3.55x faster | — |
| array/find | 19.86x faster | 19.21x faster | 3.37x slower |
| dom/create-elements | 2.25x slower | — | — |
| dom/set-attributes | 1.76x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.52x slower | — | — |
| mixed/csv-parse | 18.05x slower | 1.19x slower | — |
| mixed/text-search | 13.05x slower | 6.59x slower | 3.13x slower |
| mixed/fibonacci | 2.75x slower | 2.76x slower | 2.99x slower |
| mixed/matrix-multiply | 171.91x slower | 178.52x slower | 2.11x slower |
| mixed/sieve | 1.36x slower | 1.38x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x slower |
| string/concat-long | 1.10x faster |
| string/indexOf | 4.71x faster |
| string/includes | 8.18x faster |
| string/split | 3.25x faster |
| string/replace | 2.23x faster |
| string/case-convert | 2.26x faster |
| string/substring | 1.18x faster |
| string/trim | 1.35x faster |
| string/startsWith-endsWith | 1.06x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x faster |
| array/reverse | 1.01x slower |
| array/forEach | 1.03x slower |
| array/find | 1.03x slower |
| mixed/csv-parse | 15.14x faster |
| mixed/text-search | 1.98x faster |
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
| string/concat-short | 705.6ms | 383.7ms | — |
| string/concat-long | 295.1ms | 425.9ms | — |
| string/indexOf | 246.9ms | 418.8ms | 346.1ms |
| string/includes | 251.1ms | 440.1ms | 340.7ms |
| string/split | 329.5ms | 434.2ms | — |
| string/replace | 342.3ms | 474.7ms | — |
| string/case-convert | 346.8ms | 341.2ms | — |
| string/substring | 242.8ms | 294.7ms | — |
| string/trim | 321.6ms | 438.9ms | — |
| string/startsWith-endsWith | 311.5ms | 437.8ms | 380.7ms |
| array/push-pop | 318.4ms | 351.1ms | — |
| array/sort-i32 | 416.1ms | 451.4ms | — |
| array/map-filter | 443.8ms | 474.3ms | — |
| array/reduce | 413.2ms | 430.5ms | — |
| array/indexOf | 358.0ms | 396.7ms | — |
| array/slice | 324.9ms | 374.7ms | — |
| array/reverse | 360.7ms | 366.1ms | — |
| array/forEach | 409.5ms | 457.5ms | — |
| array/find | 343.7ms | 383.6ms | 360.7ms |
| dom/create-elements | 294.7ms | — | — |
| dom/set-attributes | 253.2ms | — | — |
| dom/read-attributes | 245.6ms | — | — |
| dom/modify-text | 230.9ms | — | — |
| mixed/csv-parse | 319.3ms | 415.8ms | — |
| mixed/text-search | 316.0ms | 417.1ms | 394.0ms |
| mixed/fibonacci | 277.8ms | 308.7ms | 405.5ms |
| mixed/matrix-multiply | 404.0ms | 425.9ms | 341.5ms |
| mixed/sieve | 382.2ms | 476.8ms | — |
