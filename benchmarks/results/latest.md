# js2wasm Benchmark Results

Date: 2026-10-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.054ms | 0.056ms | 0.067ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.007ms | FAILED | js |
| string/indexOf | 0.016ms | 0.051ms | 0.011ms | 0.020ms | gc-native |
| string/includes | 0.016ms | 0.097ms | 0.014ms | 0.021ms | gc-native |
| string/split | 0.350ms | 6.79ms | 2.41ms | FAILED | js |
| string/replace | 0.096ms | 0.521ms | 0.292ms | FAILED | js |
| string/case-convert | 0.049ms | 0.491ms | 0.239ms | FAILED | js |
| string/substring | 0.103ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.157ms | 3.32ms | 2.46ms | FAILED | js |
| string/startsWith-endsWith | 0.465ms | 2.60ms | 2.62ms | 0.550ms | js |
| array/push-pop | 1.42ms | 0.470ms | 0.476ms | FAILED | host-call |
| array/sort-i32 | 0.631ms | 0.330ms | 0.329ms | FAILED | gc-native |
| array/map-filter | 0.139ms | 0.080ms | 0.080ms | FAILED | gc-native |
| array/reduce | 2.05ms | 0.475ms | 0.471ms | FAILED | gc-native |
| array/indexOf | 5.23ms | 2.58ms | 2.58ms | FAILED | gc-native |
| array/slice | 0.039ms | 0.037ms | 0.036ms | FAILED | gc-native |
| array/reverse | 8.17ms | 3.68ms | 3.68ms | FAILED | gc-native |
| array/forEach | 0.085ms | 0.026ms | 0.025ms | FAILED | gc-native |
| array/find | 0.284ms | 0.016ms | 0.016ms | 0.965ms | host-call |
| dom/create-elements | 0.063ms | 0.097ms | — | — | js |
| dom/set-attributes | 0.127ms | 0.185ms | — | — | js |
| dom/read-attributes | 0.070ms | 0.114ms | — | — | js |
| dom/modify-text | 0.058ms | 0.102ms | — | — | js |
| mixed/csv-parse | 0.416ms | 6.87ms | 0.555ms | FAILED | js |
| mixed/text-search | 0.428ms | 4.00ms | 2.45ms | 1.14ms | js |
| mixed/fibonacci | 0.131ms | 0.210ms | 0.210ms | 0.209ms | js |
| mixed/matrix-multiply | 0.183ms | 61.55ms | 65.13ms | 0.698ms | js |
| mixed/sieve | 1.62ms | 2.38ms | 2.38ms | FAILED | js |

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
| string/concat-short | 10000 | 5.39 | 5.58 | 6.66 | — |
| string/concat-long | 1000 | 5.48 | 5.51 | 6.52 | — |
| string/indexOf | 1000 | 16.09 | 51.23 | 11.19 | 20.10 |
| string/includes | 1000 | 15.92 | 96.77 | 13.95 | 21.35 |
| string/split | 10000 | 34.96 | 679.10 | 240.62 | — |
| string/replace | 1000 | 95.71 | 520.72 | 291.54 | — |
| string/case-convert | 2000 | 24.72 | 245.33 | 119.26 | — |
| string/substring | 10000 | 10.35 | 3.69 | 3.15 | — |
| string/trim | 10000 | 15.71 | 332.50 | 246.10 | — |
| string/startsWith-endsWith | 20000 | 23.24 | 129.87 | 131.22 | 27.51 |
| array/map-filter | 30000 | 4.64 | 2.66 | 2.66 | — |
| array/indexOf | 1000 | 5232.07 | 2582.69 | 2578.21 | — |
| dom/create-elements | 2000 | 31.66 | 48.38 | — | — |
| dom/set-attributes | 6000 | 21.25 | 30.84 | — | — |
| dom/read-attributes | 3000 | 23.41 | 38.10 | — | — |
| dom/modify-text | 2000 | 28.80 | 50.96 | — | — |
| mixed/csv-parse | 11000 | 37.80 | 624.55 | 50.50 | — |
| mixed/text-search | 40000 | 10.69 | 99.90 | 61.37 | 28.54 |
| mixed/fibonacci | 10000 | 13.13 | 20.97 | 20.98 | 20.87 |
| mixed/matrix-multiply | 125000 | 1.47 | 492.40 | 521.01 | 5.58 |
| mixed/sieve | 200000 | 8.09 | 11.92 | 11.89 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.03x slower | 1.24x slower | — |
| string/concat-long | 1.01x slower | 1.19x slower | — |
| string/indexOf | 3.18x slower | 1.44x faster | 1.25x slower |
| string/includes | 6.08x slower | 1.14x faster | 1.34x slower |
| string/split | 19.43x slower | 6.88x slower | — |
| string/replace | 5.44x slower | 3.05x slower | — |
| string/case-convert | 9.93x slower | 4.82x slower | — |
| string/substring | 2.81x faster | 3.29x faster | — |
| string/trim | 21.16x slower | 15.66x slower | — |
| string/startsWith-endsWith | 5.59x slower | 5.65x slower | 1.18x slower |
| array/push-pop | 3.03x faster | 2.99x faster | — |
| array/sort-i32 | 1.91x faster | 1.92x faster | — |
| array/map-filter | 1.74x faster | 1.75x faster | — |
| array/reduce | 4.31x faster | 4.35x faster | — |
| array/indexOf | 2.03x faster | 2.03x faster | — |
| array/slice | 1.05x faster | 1.08x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 3.31x faster | 3.45x faster | — |
| array/find | 17.82x faster | 17.47x faster | 3.40x slower |
| dom/create-elements | 1.53x slower | — | — |
| dom/set-attributes | 1.45x slower | — | — |
| dom/read-attributes | 1.63x slower | — | — |
| dom/modify-text | 1.77x slower | — | — |
| mixed/csv-parse | 16.52x slower | 1.34x slower | — |
| mixed/text-search | 9.34x slower | 5.74x slower | 2.67x slower |
| mixed/fibonacci | 1.60x slower | 1.60x slower | 1.59x slower |
| mixed/matrix-multiply | 335.55x slower | 355.05x slower | 3.80x slower |
| mixed/sieve | 1.47x slower | 1.47x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.19x slower |
| string/concat-long | 1.18x slower |
| string/indexOf | 4.58x faster |
| string/includes | 6.94x faster |
| string/split | 2.82x faster |
| string/replace | 1.79x faster |
| string/case-convert | 2.06x faster |
| string/substring | 1.17x faster |
| string/trim | 1.35x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.04x faster |
| array/find | 1.02x slower |
| mixed/csv-parse | 12.37x faster |
| mixed/text-search | 1.63x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.06x slower |
| mixed/sieve | 1.00x faster |

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
| string/concat-short | 1046.5ms | 590.4ms | — |
| string/concat-long | 421.0ms | 626.5ms | — |
| string/indexOf | 380.3ms | 669.5ms | 530.1ms |
| string/includes | 368.7ms | 670.8ms | 553.7ms |
| string/split | 525.2ms | 661.7ms | — |
| string/replace | 478.3ms | 717.5ms | — |
| string/case-convert | 498.9ms | 589.2ms | — |
| string/substring | 385.7ms | 467.6ms | — |
| string/trim | 478.0ms | 686.8ms | — |
| string/startsWith-endsWith | 490.9ms | 664.2ms | 613.4ms |
| array/push-pop | 500.0ms | 561.0ms | — |
| array/sort-i32 | 646.5ms | 704.1ms | — |
| array/map-filter | 646.0ms | 717.0ms | — |
| array/reduce | 601.7ms | 679.4ms | — |
| array/indexOf | 565.0ms | 648.0ms | — |
| array/slice | 501.1ms | 590.4ms | — |
| array/reverse | 470.0ms | 565.0ms | — |
| array/forEach | 645.8ms | 661.0ms | — |
| array/find | 471.2ms | 583.1ms | 526.6ms |
| dom/create-elements | 402.4ms | — | — |
| dom/set-attributes | 376.7ms | — | — |
| dom/read-attributes | 378.0ms | — | — |
| dom/modify-text | 365.1ms | — | — |
| mixed/csv-parse | 504.0ms | 643.7ms | — |
| mixed/text-search | 478.3ms | 679.8ms | 584.6ms |
| mixed/fibonacci | 429.7ms | 478.7ms | 475.6ms |
| mixed/matrix-multiply | 616.3ms | 683.5ms | 490.2ms |
| mixed/sieve | 595.6ms | 643.0ms | — |
