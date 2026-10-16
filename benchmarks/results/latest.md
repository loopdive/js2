# js2wasm Benchmark Results

Date: 2026-10-16
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.039ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.017ms | gc-native |
| string/includes | 0.015ms | 0.095ms | 0.011ms | 0.020ms | gc-native |
| string/split | 0.330ms | 5.95ms | 2.10ms | FAILED | js |
| string/replace | 0.074ms | 0.472ms | 0.224ms | FAILED | js |
| string/case-convert | 0.045ms | 0.419ms | 0.185ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.56ms | 1.91ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.95ms | 1.94ms | 0.429ms | js |
| array/push-pop | 1.27ms | 0.473ms | 0.467ms | FAILED | gc-native |
| array/sort-i32 | 0.661ms | 0.234ms | 0.232ms | FAILED | gc-native |
| array/map-filter | 0.107ms | 0.052ms | 0.052ms | FAILED | gc-native |
| array/reduce | 1.28ms | 0.477ms | 0.471ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.075ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.942ms | host-call |
| dom/create-elements | 0.030ms | 0.123ms | — | — | js |
| dom/set-attributes | 0.085ms | 0.182ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.103ms | — | — | js |
| dom/modify-text | 0.024ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.367ms | 6.59ms | 0.430ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.61ms | 1.96ms | 0.855ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 53.14ms | 53.52ms | 0.567ms | js |
| mixed/sieve | 1.40ms | 1.82ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.68 | 3.93 | 3.78 | — |
| string/concat-long | 1000 | 3.37 | 4.10 | 2.93 | — |
| string/indexOf | 1000 | 14.74 | 46.57 | 9.80 | 16.79 |
| string/includes | 1000 | 14.54 | 95.02 | 11.04 | 19.61 |
| string/split | 10000 | 33.02 | 595.25 | 209.58 | — |
| string/replace | 1000 | 73.87 | 471.70 | 224.42 | — |
| string/case-convert | 2000 | 22.46 | 209.31 | 92.54 | — |
| string/substring | 10000 | 8.09 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.40 | 255.82 | 190.75 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 97.65 | 97.12 | 21.43 |
| array/map-filter | 30000 | 3.58 | 1.75 | 1.74 | — |
| array/indexOf | 1000 | 3462.54 | 2229.63 | 2227.93 | — |
| dom/create-elements | 2000 | 15.17 | 61.68 | — | — |
| dom/set-attributes | 6000 | 14.21 | 30.42 | — | — |
| dom/read-attributes | 3000 | 16.74 | 34.30 | — | — |
| dom/modify-text | 2000 | 11.91 | 43.75 | — | — |
| mixed/csv-parse | 11000 | 33.35 | 599.41 | 39.13 | — |
| mixed/text-search | 40000 | 7.81 | 90.26 | 49.07 | 21.38 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.41 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 425.16 | 428.17 | 4.53 |
| mixed/sieve | 200000 | 7.02 | 9.09 | 9.05 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.47x slower | 1.41x slower | — |
| string/concat-long | 1.22x slower | 1.15x faster | — |
| string/indexOf | 3.16x slower | 1.50x faster | 1.14x slower |
| string/includes | 6.54x slower | 1.32x faster | 1.35x slower |
| string/split | 18.03x slower | 6.35x slower | — |
| string/replace | 6.39x slower | 3.04x slower | — |
| string/case-convert | 9.32x slower | 4.12x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.08x slower | 14.23x slower | — |
| string/startsWith-endsWith | 6.10x slower | 6.07x slower | 1.34x slower |
| array/push-pop | 2.69x faster | 2.73x faster | — |
| array/sort-i32 | 2.82x faster | 2.85x faster | — |
| array/map-filter | 2.05x faster | 2.06x faster | — |
| array/reduce | 2.68x faster | 2.71x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.23x faster | 2.24x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.29x faster | 3.29x faster | — |
| array/find | 17.79x faster | 17.66x faster | 4.43x slower |
| dom/create-elements | 4.07x slower | — | — |
| dom/set-attributes | 2.14x slower | — | — |
| dom/read-attributes | 2.05x slower | — | — |
| dom/modify-text | 3.67x slower | — | — |
| mixed/csv-parse | 17.97x slower | 1.17x slower | — |
| mixed/text-search | 11.55x slower | 6.28x slower | 2.74x slower |
| mixed/fibonacci | 2.61x slower | 2.62x slower | 2.60x slower |
| mixed/matrix-multiply | 363.51x slower | 366.09x slower | 3.88x slower |
| mixed/sieve | 1.30x slower | 1.29x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.40x faster |
| string/indexOf | 4.75x faster |
| string/includes | 8.61x faster |
| string/split | 2.84x faster |
| string/replace | 2.10x faster |
| string/case-convert | 2.26x faster |
| string/substring | 1.16x faster |
| string/trim | 1.34x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 15.32x faster |
| mixed/text-search | 1.84x faster |
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
| string/concat-short | 891.7ms | 447.6ms | — |
| string/concat-long | 353.6ms | 493.7ms | — |
| string/indexOf | 287.2ms | 514.7ms | 426.9ms |
| string/includes | 282.8ms | 510.7ms | 422.9ms |
| string/split | 386.3ms | 522.0ms | — |
| string/replace | 393.0ms | 547.4ms | — |
| string/case-convert | 389.0ms | 460.4ms | — |
| string/substring | 298.7ms | 366.1ms | — |
| string/trim | 381.8ms | 519.2ms | — |
| string/startsWith-endsWith | 378.0ms | 534.0ms | 454.0ms |
| array/push-pop | 392.5ms | 445.1ms | — |
| array/sort-i32 | 507.1ms | 543.2ms | — |
| array/map-filter | 499.0ms | 551.1ms | — |
| array/reduce | 470.6ms | 523.0ms | — |
| array/indexOf | 442.0ms | 507.9ms | — |
| array/slice | 386.3ms | 464.6ms | — |
| array/reverse | 375.1ms | 450.5ms | — |
| array/forEach | 513.7ms | 517.4ms | — |
| array/find | 381.1ms | 443.8ms | 416.6ms |
| dom/create-elements | 325.1ms | — | — |
| dom/set-attributes | 290.4ms | — | — |
| dom/read-attributes | 295.5ms | — | — |
| dom/modify-text | 304.0ms | — | — |
| mixed/csv-parse | 395.4ms | 524.5ms | — |
| mixed/text-search | 390.5ms | 542.2ms | 478.6ms |
| mixed/fibonacci | 348.3ms | 392.3ms | 381.3ms |
| mixed/matrix-multiply | 480.1ms | 530.6ms | 395.6ms |
| mixed/sieve | 463.7ms | 509.7ms | — |
