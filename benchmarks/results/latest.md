# js2wasm Benchmark Results

Date: 2026-09-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.048ms | 0.047ms | 0.045ms | FAILED | gc-native |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.037ms | 0.009ms | 0.025ms | gc-native |
| string/includes | 0.012ms | 0.065ms | 0.011ms | 0.028ms | gc-native |
| string/split | 0.267ms | 4.45ms | 1.68ms | FAILED | js |
| string/replace | 0.060ms | 0.357ms | 0.206ms | FAILED | js |
| string/case-convert | 0.042ms | 0.328ms | 0.158ms | FAILED | js |
| string/substring | 0.120ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.235ms | 2.38ms | 1.69ms | FAILED | js |
| string/startsWith-endsWith | 0.393ms | 1.76ms | 1.87ms | 0.393ms | linear-memory |
| array/push-pop | 1.15ms | 0.382ms | 0.387ms | FAILED | host-call |
| array/sort-i32 | 0.471ms | 0.249ms | 0.247ms | FAILED | gc-native |
| array/map-filter | 0.113ms | 0.066ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.16ms | 0.392ms | 0.378ms | FAILED | gc-native |
| array/indexOf | 3.92ms | 2.16ms | 1.89ms | FAILED | gc-native |
| array/slice | 0.030ms | 0.031ms | 0.040ms | FAILED | js |
| array/reverse | 5.23ms | 2.79ms | 2.79ms | FAILED | host-call |
| array/forEach | 0.053ms | 0.020ms | 0.021ms | FAILED | host-call |
| array/find | 0.223ms | 0.014ms | 0.014ms | 0.814ms | gc-native |
| dom/create-elements | 0.072ms | 0.147ms | — | — | js |
| dom/set-attributes | 0.121ms | 0.147ms | — | — | js |
| dom/read-attributes | 0.067ms | 0.092ms | — | — | js |
| dom/modify-text | 0.054ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.297ms | 4.79ms | 0.452ms | FAILED | js |
| mixed/text-search | 0.308ms | 3.20ms | 1.85ms | 0.948ms | js |
| mixed/fibonacci | 0.099ms | 0.156ms | 0.157ms | 0.155ms | js |
| mixed/matrix-multiply | 0.152ms | 42.90ms | 44.16ms | 0.538ms | js |
| mixed/sieve | 1.31ms | 1.85ms | 1.85ms | FAILED | js |

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
| string/concat-short | 10000 | 4.83 | 4.73 | 4.52 | — |
| string/concat-long | 1000 | 3.94 | 4.26 | 6.13 | — |
| string/indexOf | 1000 | 11.82 | 36.62 | 8.87 | 25.44 |
| string/includes | 1000 | 11.83 | 64.56 | 11.17 | 27.77 |
| string/split | 10000 | 26.70 | 445.04 | 167.92 | — |
| string/replace | 1000 | 60.17 | 357.41 | 205.51 | — |
| string/case-convert | 2000 | 20.98 | 164.16 | 79.10 | — |
| string/substring | 10000 | 12.02 | 2.74 | 2.34 | — |
| string/trim | 10000 | 23.49 | 238.26 | 168.68 | — |
| string/startsWith-endsWith | 20000 | 19.65 | 88.07 | 93.63 | 19.65 |
| array/map-filter | 30000 | 3.78 | 2.22 | 2.19 | — |
| array/indexOf | 1000 | 3918.45 | 2160.97 | 1887.32 | — |
| dom/create-elements | 2000 | 36.22 | 73.41 | — | — |
| dom/set-attributes | 6000 | 20.13 | 24.53 | — | — |
| dom/read-attributes | 3000 | 22.48 | 30.60 | — | — |
| dom/modify-text | 2000 | 26.99 | 44.48 | — | — |
| mixed/csv-parse | 11000 | 27.01 | 435.27 | 41.07 | — |
| mixed/text-search | 40000 | 7.71 | 80.09 | 46.17 | 23.69 |
| mixed/fibonacci | 10000 | 9.86 | 15.65 | 15.69 | 15.51 |
| mixed/matrix-multiply | 125000 | 1.22 | 343.19 | 353.28 | 4.31 |
| mixed/sieve | 200000 | 6.57 | 9.23 | 9.25 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x faster | 1.07x faster | — |
| string/concat-long | 1.08x slower | 1.56x slower | — |
| string/indexOf | 3.10x slower | 1.33x faster | 2.15x slower |
| string/includes | 5.46x slower | 1.06x faster | 2.35x slower |
| string/split | 16.67x slower | 6.29x slower | — |
| string/replace | 5.94x slower | 3.42x slower | — |
| string/case-convert | 7.83x slower | 3.77x slower | — |
| string/substring | 4.38x faster | 5.14x faster | — |
| string/trim | 10.14x slower | 7.18x slower | — |
| string/startsWith-endsWith | 4.48x slower | 4.76x slower | 1.00x faster |
| array/push-pop | 3.01x faster | 2.97x faster | — |
| array/sort-i32 | 1.89x faster | 1.91x faster | — |
| array/map-filter | 1.70x faster | 1.72x faster | — |
| array/reduce | 2.95x faster | 3.06x faster | — |
| array/indexOf | 1.81x faster | 2.08x faster | — |
| array/slice | 1.03x slower | 1.35x slower | — |
| array/reverse | 1.87x faster | 1.87x faster | — |
| array/forEach | 2.58x faster | 2.54x faster | — |
| array/find | 15.57x faster | 16.03x faster | 3.64x slower |
| dom/create-elements | 2.03x slower | — | — |
| dom/set-attributes | 1.22x slower | — | — |
| dom/read-attributes | 1.36x slower | — | — |
| dom/modify-text | 1.65x slower | — | — |
| mixed/csv-parse | 16.12x slower | 1.52x slower | — |
| mixed/text-search | 10.39x slower | 5.99x slower | 3.07x slower |
| mixed/fibonacci | 1.59x slower | 1.59x slower | 1.57x slower |
| mixed/matrix-multiply | 281.46x slower | 289.74x slower | 3.53x slower |
| mixed/sieve | 1.41x slower | 1.41x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.44x slower |
| string/indexOf | 4.13x faster |
| string/includes | 5.78x faster |
| string/split | 2.65x faster |
| string/replace | 1.74x faster |
| string/case-convert | 2.08x faster |
| string/substring | 1.17x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.04x faster |
| array/indexOf | 1.14x faster |
| array/slice | 1.31x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.02x slower |
| array/find | 1.03x faster |
| mixed/csv-parse | 10.60x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.00x slower |

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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
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
| string/concat-short | 786.8ms | 444.9ms | — |
| string/concat-long | 328.7ms | 479.8ms | — |
| string/indexOf | 284.2ms | 497.0ms | 415.3ms |
| string/includes | 281.3ms | 528.0ms | 415.2ms |
| string/split | 362.4ms | 514.9ms | — |
| string/replace | 363.6ms | 567.3ms | — |
| string/case-convert | 371.3ms | 425.5ms | — |
| string/substring | 302.8ms | 381.6ms | — |
| string/trim | 357.0ms | 503.6ms | — |
| string/startsWith-endsWith | 371.9ms | 506.5ms | 458.2ms |
| array/push-pop | 362.2ms | 417.1ms | — |
| array/sort-i32 | 497.3ms | 521.5ms | — |
| array/map-filter | 473.2ms | 544.2ms | — |
| array/reduce | 439.3ms | 500.3ms | — |
| array/indexOf | 433.5ms | 486.7ms | — |
| array/slice | 396.9ms | 431.4ms | — |
| array/reverse | 379.3ms | 414.8ms | — |
| array/forEach | 466.5ms | 504.9ms | — |
| array/find | 369.6ms | 401.2ms | 437.3ms |
| dom/create-elements | 343.6ms | — | — |
| dom/set-attributes | 325.4ms | — | — |
| dom/read-attributes | 302.4ms | — | — |
| dom/modify-text | 316.9ms | — | — |
| mixed/csv-parse | 367.7ms | 499.2ms | — |
| mixed/text-search | 380.3ms | 529.5ms | 465.4ms |
| mixed/fibonacci | 357.1ms | 397.7ms | 352.3ms |
| mixed/matrix-multiply | 447.0ms | 512.6ms | 375.1ms |
| mixed/sieve | 427.0ms | 477.2ms | — |
