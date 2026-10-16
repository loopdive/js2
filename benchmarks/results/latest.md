# js2wasm Benchmark Results

Date: 2026-10-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.048ms | 0.043ms | 0.045ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.037ms | 0.009ms | 0.014ms | gc-native |
| string/includes | 0.012ms | 0.066ms | 0.011ms | 0.015ms | gc-native |
| string/split | 0.260ms | 4.62ms | 1.72ms | FAILED | js |
| string/replace | 0.062ms | 0.362ms | 0.214ms | FAILED | js |
| string/case-convert | 0.042ms | 0.362ms | 0.184ms | FAILED | js |
| string/substring | 0.127ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.235ms | 2.32ms | 1.93ms | FAILED | js |
| string/startsWith-endsWith | 0.361ms | 1.86ms | 1.98ms | 0.415ms | js |
| array/push-pop | 1.19ms | 0.392ms | 0.380ms | FAILED | gc-native |
| array/sort-i32 | 0.461ms | 0.248ms | 0.277ms | FAILED | host-call |
| array/map-filter | 0.116ms | 0.066ms | 0.075ms | FAILED | host-call |
| array/reduce | 1.15ms | 0.394ms | 0.388ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.88ms | 1.88ms | FAILED | gc-native |
| array/slice | 0.040ms | 0.035ms | 0.038ms | FAILED | host-call |
| array/reverse | 5.00ms | 2.73ms | 2.73ms | FAILED | gc-native |
| array/forEach | 0.053ms | 0.021ms | 0.021ms | FAILED | host-call |
| array/find | 0.219ms | 0.015ms | 0.015ms | 0.705ms | host-call |
| dom/create-elements | 0.065ms | 0.137ms | — | — | js |
| dom/set-attributes | 0.117ms | 0.167ms | — | — | js |
| dom/read-attributes | 0.072ms | 0.091ms | — | — | js |
| dom/modify-text | 0.057ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.754ms | 4.78ms | 0.521ms | FAILED | gc-native |
| mixed/text-search | 0.304ms | 2.76ms | 1.82ms | 0.858ms | js |
| mixed/fibonacci | 0.113ms | 0.157ms | 0.156ms | 0.155ms | js |
| mixed/matrix-multiply | 0.144ms | 44.83ms | 46.70ms | 0.531ms | js |
| mixed/sieve | 1.34ms | 1.82ms | 1.82ms | FAILED | js |

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
| string/concat-short | 10000 | 4.76 | 4.28 | 4.49 | — |
| string/concat-long | 1000 | 3.89 | 4.38 | 6.29 | — |
| string/indexOf | 1000 | 11.83 | 36.72 | 8.84 | 14.20 |
| string/includes | 1000 | 11.86 | 65.63 | 10.74 | 15.49 |
| string/split | 10000 | 25.99 | 461.68 | 172.09 | — |
| string/replace | 1000 | 61.72 | 362.05 | 214.29 | — |
| string/case-convert | 2000 | 21.03 | 181.14 | 91.80 | — |
| string/substring | 10000 | 12.66 | 2.73 | 2.31 | — |
| string/trim | 10000 | 23.53 | 231.93 | 192.64 | — |
| string/startsWith-endsWith | 20000 | 18.06 | 93.06 | 99.10 | 20.74 |
| array/map-filter | 30000 | 3.88 | 2.20 | 2.51 | — |
| array/indexOf | 1000 | 3909.92 | 1879.09 | 1878.90 | — |
| dom/create-elements | 2000 | 32.61 | 68.43 | — | — |
| dom/set-attributes | 6000 | 19.47 | 27.77 | — | — |
| dom/read-attributes | 3000 | 23.86 | 30.19 | — | — |
| dom/modify-text | 2000 | 28.68 | 44.54 | — | — |
| mixed/csv-parse | 11000 | 68.55 | 434.41 | 47.33 | — |
| mixed/text-search | 40000 | 7.61 | 68.93 | 45.58 | 21.45 |
| mixed/fibonacci | 10000 | 11.27 | 15.68 | 15.62 | 15.51 |
| mixed/matrix-multiply | 125000 | 1.15 | 358.67 | 373.60 | 4.25 |
| mixed/sieve | 200000 | 6.69 | 9.12 | 9.10 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.11x faster | 1.06x faster | — |
| string/concat-long | 1.13x slower | 1.61x slower | — |
| string/indexOf | 3.10x slower | 1.34x faster | 1.20x slower |
| string/includes | 5.53x slower | 1.10x faster | 1.31x slower |
| string/split | 17.76x slower | 6.62x slower | — |
| string/replace | 5.87x slower | 3.47x slower | — |
| string/case-convert | 8.61x slower | 4.37x slower | — |
| string/substring | 4.63x faster | 5.49x faster | — |
| string/trim | 9.86x slower | 8.19x slower | — |
| string/startsWith-endsWith | 5.15x slower | 5.49x slower | 1.15x slower |
| array/push-pop | 3.02x faster | 3.12x faster | — |
| array/sort-i32 | 1.86x faster | 1.66x faster | — |
| array/map-filter | 1.76x faster | 1.55x faster | — |
| array/reduce | 2.92x faster | 2.97x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.15x faster | 1.05x faster | — |
| array/reverse | 1.83x faster | 1.84x faster | — |
| array/forEach | 2.54x faster | 2.54x faster | — |
| array/find | 14.87x faster | 14.73x faster | 3.22x slower |
| dom/create-elements | 2.10x slower | — | — |
| dom/set-attributes | 1.43x slower | — | — |
| dom/read-attributes | 1.27x slower | — | — |
| dom/modify-text | 1.55x slower | — | — |
| mixed/csv-parse | 6.34x slower | 1.45x faster | — |
| mixed/text-search | 9.06x slower | 5.99x slower | 2.82x slower |
| mixed/fibonacci | 1.39x slower | 1.39x slower | 1.38x slower |
| mixed/matrix-multiply | 311.93x slower | 324.92x slower | 3.69x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x slower |
| string/concat-long | 1.43x slower |
| string/indexOf | 4.15x faster |
| string/includes | 6.11x faster |
| string/split | 2.68x faster |
| string/replace | 1.69x faster |
| string/case-convert | 1.97x faster |
| string/substring | 1.19x faster |
| string/trim | 1.20x faster |
| string/startsWith-endsWith | 1.06x slower |
| array/push-pop | 1.03x faster |
| array/sort-i32 | 1.12x slower |
| array/map-filter | 1.14x slower |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.10x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 9.18x faster |
| mixed/text-search | 1.51x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
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
| string/concat-short | 850.0ms | 455.1ms | — |
| string/concat-long | 338.6ms | 469.9ms | — |
| string/indexOf | 282.5ms | 476.8ms | 397.3ms |
| string/includes | 286.9ms | 485.9ms | 392.3ms |
| string/split | 421.3ms | 501.2ms | — |
| string/replace | 357.2ms | 536.5ms | — |
| string/case-convert | 423.7ms | 464.0ms | — |
| string/substring | 295.5ms | 378.7ms | — |
| string/trim | 361.6ms | 504.6ms | — |
| string/startsWith-endsWith | 344.1ms | 541.6ms | 468.7ms |
| array/push-pop | 375.4ms | 420.7ms | — |
| array/sort-i32 | 464.6ms | 531.1ms | — |
| array/map-filter | 500.6ms | 520.2ms | — |
| array/reduce | 441.9ms | 496.7ms | — |
| array/indexOf | 420.1ms | 484.6ms | — |
| array/slice | 384.9ms | 423.4ms | — |
| array/reverse | 374.8ms | 487.6ms | — |
| array/forEach | 461.3ms | 512.8ms | — |
| array/find | 378.9ms | 441.8ms | 393.5ms |
| dom/create-elements | 319.6ms | — | — |
| dom/set-attributes | 319.1ms | — | — |
| dom/read-attributes | 296.6ms | — | — |
| dom/modify-text | 288.4ms | — | — |
| mixed/csv-parse | 428.3ms | 496.0ms | — |
| mixed/text-search | 408.3ms | 498.5ms | 453.1ms |
| mixed/fibonacci | 367.5ms | 374.0ms | 351.6ms |
| mixed/matrix-multiply | 481.6ms | 506.4ms | 376.5ms |
| mixed/sieve | 485.1ms | 491.9ms | — |
