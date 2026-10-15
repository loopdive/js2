# js2wasm Benchmark Results

Date: 2026-10-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.039ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.098ms | 0.011ms | 0.019ms | gc-native |
| string/split | 0.331ms | 6.02ms | 2.06ms | FAILED | js |
| string/replace | 0.074ms | 0.468ms | 0.217ms | FAILED | js |
| string/case-convert | 0.045ms | 0.437ms | 0.191ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.67ms | 1.86ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.99ms | 1.97ms | 0.429ms | js |
| array/push-pop | 1.28ms | 0.468ms | 0.471ms | FAILED | host-call |
| array/sort-i32 | 0.684ms | 0.236ms | 0.236ms | FAILED | host-call |
| array/map-filter | 0.110ms | 0.052ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.27ms | 0.466ms | 0.471ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.074ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.212ms | 0.012ms | 0.012ms | 0.945ms | host-call |
| dom/create-elements | 0.037ms | 0.084ms | — | — | js |
| dom/set-attributes | 0.084ms | 0.185ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.363ms | 6.55ms | 0.427ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.28ms | 1.93ms | 0.861ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.253ms | js |
| mixed/matrix-multiply | 0.148ms | 50.25ms | 54.79ms | 0.562ms | js |
| mixed/sieve | 1.44ms | 1.81ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.71 | 3.95 | 3.86 | — |
| string/concat-long | 1000 | 3.10 | 4.22 | 3.00 | — |
| string/indexOf | 1000 | 14.74 | 46.67 | 9.81 | 12.53 |
| string/includes | 1000 | 14.54 | 97.75 | 11.06 | 18.60 |
| string/split | 10000 | 33.13 | 601.68 | 205.77 | — |
| string/replace | 1000 | 73.59 | 467.95 | 216.98 | — |
| string/case-convert | 2000 | 22.63 | 218.34 | 95.34 | — |
| string/substring | 10000 | 8.08 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.41 | 267.12 | 185.94 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 99.37 | 98.66 | 21.44 |
| array/map-filter | 30000 | 3.67 | 1.74 | 1.74 | — |
| array/indexOf | 1000 | 3460.99 | 2230.58 | 2226.95 | — |
| dom/create-elements | 2000 | 18.61 | 41.97 | — | — |
| dom/set-attributes | 6000 | 14.06 | 30.90 | — | — |
| dom/read-attributes | 3000 | 16.50 | 34.53 | — | — |
| dom/modify-text | 2000 | 11.48 | 43.84 | — | — |
| mixed/csv-parse | 11000 | 33.02 | 595.69 | 38.79 | — |
| mixed/text-search | 40000 | 7.82 | 82.02 | 48.36 | 21.52 |
| mixed/fibonacci | 10000 | 9.72 | 25.41 | 25.41 | 25.27 |
| mixed/matrix-multiply | 125000 | 1.18 | 402.01 | 438.31 | 4.50 |
| mixed/sieve | 200000 | 7.19 | 9.04 | 9.05 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.42x slower | — |
| string/concat-long | 1.36x slower | 1.04x faster | — |
| string/indexOf | 3.17x slower | 1.50x faster | 1.18x faster |
| string/includes | 6.72x slower | 1.31x faster | 1.28x slower |
| string/split | 18.16x slower | 6.21x slower | — |
| string/replace | 6.36x slower | 2.95x slower | — |
| string/case-convert | 9.65x slower | 4.21x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.92x slower | 13.87x slower | — |
| string/startsWith-endsWith | 6.21x slower | 6.16x slower | 1.34x slower |
| array/push-pop | 2.73x faster | 2.72x faster | — |
| array/sort-i32 | 2.90x faster | 2.90x faster | — |
| array/map-filter | 2.10x faster | 2.11x faster | — |
| array/reduce | 2.72x faster | 2.69x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.26x faster | 2.25x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.26x faster | 3.27x faster | — |
| array/find | 17.72x faster | 17.60x faster | 4.45x slower |
| dom/create-elements | 2.26x slower | — | — |
| dom/set-attributes | 2.20x slower | — | — |
| dom/read-attributes | 2.09x slower | — | — |
| dom/modify-text | 3.82x slower | — | — |
| mixed/csv-parse | 18.04x slower | 1.17x slower | — |
| mixed/text-search | 10.49x slower | 6.19x slower | 2.75x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 340.26x slower | 370.98x slower | 3.81x slower |
| mixed/sieve | 1.26x slower | 1.26x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.41x faster |
| string/indexOf | 4.76x faster |
| string/includes | 8.84x faster |
| string/split | 2.92x faster |
| string/replace | 2.16x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.16x faster |
| string/trim | 1.44x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.36x faster |
| mixed/text-search | 1.70x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.09x slower |
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
| string/concat-short | 858.1ms | 462.1ms | — |
| string/concat-long | 335.6ms | 484.7ms | — |
| string/indexOf | 283.4ms | 486.2ms | 413.0ms |
| string/includes | 283.9ms | 504.8ms | 414.9ms |
| string/split | 391.0ms | 518.2ms | — |
| string/replace | 375.1ms | 555.7ms | — |
| string/case-convert | 395.7ms | 462.2ms | — |
| string/substring | 308.2ms | 355.5ms | — |
| string/trim | 365.4ms | 517.4ms | — |
| string/startsWith-endsWith | 381.9ms | 520.2ms | 472.1ms |
| array/push-pop | 396.9ms | 438.3ms | — |
| array/sort-i32 | 509.2ms | 549.9ms | — |
| array/map-filter | 541.2ms | 550.2ms | — |
| array/reduce | 483.5ms | 518.9ms | — |
| array/indexOf | 447.4ms | 492.0ms | — |
| array/slice | 392.2ms | 456.0ms | — |
| array/reverse | 371.1ms | 438.4ms | — |
| array/forEach | 490.5ms | 530.0ms | — |
| array/find | 373.5ms | 452.4ms | 411.9ms |
| dom/create-elements | 325.0ms | — | — |
| dom/set-attributes | 296.4ms | — | — |
| dom/read-attributes | 291.8ms | — | — |
| dom/modify-text | 312.6ms | — | — |
| mixed/csv-parse | 389.2ms | 516.5ms | — |
| mixed/text-search | 393.3ms | 548.2ms | 486.4ms |
| mixed/fibonacci | 361.7ms | 382.8ms | 363.2ms |
| mixed/matrix-multiply | 493.8ms | 531.9ms | 399.2ms |
| mixed/sieve | 462.7ms | 506.5ms | — |
