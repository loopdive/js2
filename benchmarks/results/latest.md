# js2wasm Benchmark Results

Date: 2026-09-26
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.040ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.032ms | gc-native |
| string/includes | 0.015ms | 0.079ms | 0.011ms | 0.024ms | gc-native |
| string/split | 0.329ms | 6.05ms | 2.05ms | FAILED | js |
| string/replace | 0.076ms | 0.473ms | 0.214ms | FAILED | js |
| string/case-convert | 0.045ms | 0.434ms | 0.190ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.60ms | 1.86ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 2.03ms | 1.97ms | 0.432ms | js |
| array/push-pop | 1.32ms | 0.478ms | 0.469ms | FAILED | gc-native |
| array/sort-i32 | 0.662ms | 0.233ms | 0.236ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.052ms | 0.052ms | FAILED | host-call |
| array/reduce | 1.88ms | 0.477ms | 0.476ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.031ms | 0.014ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.076ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.212ms | 0.012ms | 0.012ms | 0.945ms | gc-native |
| dom/create-elements | 0.030ms | 0.122ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.181ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.090ms | — | — | js |
| mixed/csv-parse | 0.366ms | 6.31ms | 0.428ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.40ms | 1.93ms | 0.870ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 57.21ms | 54.20ms | 0.565ms | js |
| mixed/sieve | 1.46ms | 1.78ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.71 | 3.96 | 3.88 | — |
| string/concat-long | 1000 | 3.10 | 4.20 | 2.97 | — |
| string/indexOf | 1000 | 14.75 | 46.69 | 9.75 | 31.55 |
| string/includes | 1000 | 14.55 | 79.49 | 11.09 | 23.75 |
| string/split | 10000 | 32.87 | 605.10 | 205.04 | — |
| string/replace | 1000 | 75.76 | 472.65 | 213.63 | — |
| string/case-convert | 2000 | 22.70 | 217.10 | 94.83 | — |
| string/substring | 10000 | 8.08 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.37 | 259.75 | 186.13 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 101.63 | 98.30 | 21.58 |
| array/map-filter | 30000 | 3.59 | 1.74 | 1.75 | — |
| array/indexOf | 1000 | 3459.27 | 2222.05 | 2219.76 | — |
| dom/create-elements | 2000 | 14.91 | 61.23 | — | — |
| dom/set-attributes | 6000 | 14.27 | 30.24 | — | — |
| dom/read-attributes | 3000 | 16.35 | 34.80 | — | — |
| dom/modify-text | 2000 | 11.51 | 45.12 | — | — |
| mixed/csv-parse | 11000 | 33.30 | 573.99 | 38.89 | — |
| mixed/text-search | 40000 | 7.81 | 84.91 | 48.30 | 21.76 |
| mixed/fibonacci | 10000 | 9.74 | 25.43 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.17 | 457.66 | 433.60 | 4.52 |
| mixed/sieve | 200000 | 7.32 | 8.89 | 9.03 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.46x slower | 1.43x slower | — |
| string/concat-long | 1.35x slower | 1.04x faster | — |
| string/indexOf | 3.17x slower | 1.51x faster | 2.14x slower |
| string/includes | 5.46x slower | 1.31x faster | 1.63x slower |
| string/split | 18.41x slower | 6.24x slower | — |
| string/replace | 6.24x slower | 2.82x slower | — |
| string/case-convert | 9.57x slower | 4.18x slower | — |
| string/substring | 2.61x faster | 3.03x faster | — |
| string/trim | 19.43x slower | 13.92x slower | — |
| string/startsWith-endsWith | 6.35x slower | 6.14x slower | 1.35x slower |
| array/push-pop | 2.76x faster | 2.81x faster | — |
| array/sort-i32 | 2.84x faster | 2.81x faster | — |
| array/map-filter | 2.06x faster | 2.06x faster | — |
| array/reduce | 3.94x faster | 3.94x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.20x faster | 2.21x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.35x faster | 3.35x faster | — |
| array/find | 17.54x faster | 17.88x faster | 4.45x slower |
| dom/create-elements | 4.11x slower | — | — |
| dom/set-attributes | 2.12x slower | — | — |
| dom/read-attributes | 2.13x slower | — | — |
| dom/modify-text | 3.92x slower | — | — |
| mixed/csv-parse | 17.24x slower | 1.17x slower | — |
| mixed/text-search | 10.87x slower | 6.18x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.59x slower |
| mixed/matrix-multiply | 391.28x slower | 370.71x slower | 3.86x slower |
| mixed/sieve | 1.22x slower | 1.23x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.02x faster |
| string/concat-long | 1.41x faster |
| string/indexOf | 4.79x faster |
| string/includes | 7.17x faster |
| string/split | 2.95x faster |
| string/replace | 2.21x faster |
| string/case-convert | 2.29x faster |
| string/substring | 1.16x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.03x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x faster |
| mixed/csv-parse | 14.76x faster |
| mixed/text-search | 1.76x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x faster |
| mixed/sieve | 1.02x slower |

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
| string/concat-short | 865.7ms | 486.9ms | — |
| string/concat-long | 333.6ms | 497.4ms | — |
| string/indexOf | 291.0ms | 511.3ms | 411.7ms |
| string/includes | 288.4ms | 504.2ms | 416.1ms |
| string/split | 392.6ms | 528.7ms | — |
| string/replace | 389.8ms | 574.3ms | — |
| string/case-convert | 397.9ms | 438.3ms | — |
| string/substring | 302.6ms | 370.4ms | — |
| string/trim | 368.0ms | 515.3ms | — |
| string/startsWith-endsWith | 376.9ms | 528.8ms | 474.7ms |
| array/push-pop | 399.4ms | 473.0ms | — |
| array/sort-i32 | 531.1ms | 559.3ms | — |
| array/map-filter | 502.1ms | 578.0ms | — |
| array/reduce | 471.2ms | 515.2ms | — |
| array/indexOf | 471.2ms | 519.6ms | — |
| array/slice | 394.4ms | 472.7ms | — |
| array/reverse | 373.6ms | 462.6ms | — |
| array/forEach | 479.8ms | 578.0ms | — |
| array/find | 371.3ms | 462.2ms | 415.2ms |
| dom/create-elements | 329.6ms | — | — |
| dom/set-attributes | 297.9ms | — | — |
| dom/read-attributes | 293.6ms | — | — |
| dom/modify-text | 296.1ms | — | — |
| mixed/csv-parse | 407.2ms | 522.9ms | — |
| mixed/text-search | 389.2ms | 523.4ms | 471.9ms |
| mixed/fibonacci | 354.4ms | 394.2ms | 359.8ms |
| mixed/matrix-multiply | 482.8ms | 525.4ms | 396.0ms |
| mixed/sieve | 467.4ms | 511.8ms | — |
