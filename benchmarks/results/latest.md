# js2wasm Benchmark Results

Date: 2026-09-26
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.019ms | gc-native |
| string/includes | 0.015ms | 0.092ms | 0.011ms | 0.020ms | gc-native |
| string/split | 0.326ms | 6.40ms | 2.03ms | FAILED | js |
| string/replace | 0.074ms | 0.460ms | 0.215ms | FAILED | js |
| string/case-convert | 0.045ms | 0.454ms | 0.186ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 2.69ms | 1.87ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.95ms | 2.03ms | 0.433ms | js |
| array/push-pop | 1.32ms | 0.479ms | 0.473ms | FAILED | gc-native |
| array/sort-i32 | 0.659ms | 0.236ms | 0.229ms | FAILED | gc-native |
| array/map-filter | 0.109ms | 0.053ms | 0.053ms | FAILED | gc-native |
| array/reduce | 1.87ms | 0.479ms | 0.475ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.09ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.044ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.214ms | 0.012ms | 0.012ms | 0.944ms | gc-native |
| dom/create-elements | 0.031ms | 0.119ms | — | — | js |
| dom/set-attributes | 0.087ms | 0.189ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.363ms | 6.45ms | 0.432ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.29ms | 1.91ms | 0.870ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.147ms | 51.98ms | 50.62ms | 0.562ms | js |
| mixed/sieve | 1.42ms | 1.80ms | 1.82ms | FAILED | js |

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
| string/concat-short | 10000 | 2.87 | 3.98 | 3.84 | — |
| string/concat-long | 1000 | 3.24 | 4.56 | 3.07 | — |
| string/indexOf | 1000 | 14.79 | 46.62 | 9.86 | 18.98 |
| string/includes | 1000 | 14.52 | 92.39 | 11.12 | 20.29 |
| string/split | 10000 | 32.63 | 640.47 | 202.97 | — |
| string/replace | 1000 | 74.45 | 460.01 | 215.44 | — |
| string/case-convert | 2000 | 22.68 | 226.84 | 92.80 | — |
| string/substring | 10000 | 8.09 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.52 | 269.41 | 186.61 | — |
| string/startsWith-endsWith | 20000 | 16.01 | 97.49 | 101.31 | 21.63 |
| array/map-filter | 30000 | 3.65 | 1.76 | 1.76 | — |
| array/indexOf | 1000 | 3461.14 | 2222.42 | 2221.17 | — |
| dom/create-elements | 2000 | 15.31 | 59.62 | — | — |
| dom/set-attributes | 6000 | 14.51 | 31.56 | — | — |
| dom/read-attributes | 3000 | 16.58 | 34.51 | — | — |
| dom/modify-text | 2000 | 11.52 | 43.95 | — | — |
| mixed/csv-parse | 11000 | 33.04 | 586.10 | 39.25 | — |
| mixed/text-search | 40000 | 7.81 | 82.35 | 47.73 | 21.74 |
| mixed/fibonacci | 10000 | 9.72 | 25.41 | 25.40 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.18 | 415.81 | 404.96 | 4.50 |
| mixed/sieve | 200000 | 7.08 | 8.98 | 9.09 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.39x slower | 1.34x slower | — |
| string/concat-long | 1.41x slower | 1.06x faster | — |
| string/indexOf | 3.15x slower | 1.50x faster | 1.28x slower |
| string/includes | 6.36x slower | 1.31x faster | 1.40x slower |
| string/split | 19.63x slower | 6.22x slower | — |
| string/replace | 6.18x slower | 2.89x slower | — |
| string/case-convert | 10.00x slower | 4.09x slower | — |
| string/substring | 2.62x faster | 3.04x faster | — |
| string/trim | 19.93x slower | 13.81x slower | — |
| string/startsWith-endsWith | 6.09x slower | 6.33x slower | 1.35x slower |
| array/push-pop | 2.75x faster | 2.78x faster | — |
| array/sort-i32 | 2.79x faster | 2.88x faster | — |
| array/map-filter | 2.07x faster | 2.07x faster | — |
| array/reduce | 3.90x faster | 3.94x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.24x faster | 2.25x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.92x faster | 1.92x faster | — |
| array/find | 17.46x faster | 17.67x faster | 4.42x slower |
| dom/create-elements | 3.89x slower | — | — |
| dom/set-attributes | 2.17x slower | — | — |
| dom/read-attributes | 2.08x slower | — | — |
| dom/modify-text | 3.81x slower | — | — |
| mixed/csv-parse | 17.74x slower | 1.19x slower | — |
| mixed/text-search | 10.54x slower | 6.11x slower | 2.78x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 352.44x slower | 343.24x slower | 3.81x slower |
| mixed/sieve | 1.27x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.48x faster |
| string/indexOf | 4.73x faster |
| string/includes | 8.31x faster |
| string/split | 3.16x faster |
| string/replace | 2.14x faster |
| string/case-convert | 2.44x faster |
| string/substring | 1.16x faster |
| string/trim | 1.44x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.03x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.93x faster |
| mixed/text-search | 1.73x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.03x faster |
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
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 922.8ms | 506.1ms | — |
| string/concat-long | 355.8ms | 508.7ms | — |
| string/indexOf | 302.5ms | 512.5ms | 405.7ms |
| string/includes | 288.9ms | 499.1ms | 426.8ms |
| string/split | 403.6ms | 532.3ms | — |
| string/replace | 396.8ms | 567.2ms | — |
| string/case-convert | 411.9ms | 473.3ms | — |
| string/substring | 299.9ms | 374.3ms | — |
| string/trim | 381.6ms | 518.9ms | — |
| string/startsWith-endsWith | 396.6ms | 529.3ms | 477.5ms |
| array/push-pop | 392.1ms | 458.9ms | — |
| array/sort-i32 | 504.3ms | 540.5ms | — |
| array/map-filter | 509.4ms | 569.1ms | — |
| array/reduce | 479.1ms | 505.1ms | — |
| array/indexOf | 452.4ms | 518.2ms | — |
| array/slice | 386.1ms | 466.4ms | — |
| array/reverse | 383.7ms | 455.1ms | — |
| array/forEach | 514.4ms | 536.8ms | — |
| array/find | 387.9ms | 466.2ms | 408.2ms |
| dom/create-elements | 339.0ms | — | — |
| dom/set-attributes | 302.5ms | — | — |
| dom/read-attributes | 302.4ms | — | — |
| dom/modify-text | 298.3ms | — | — |
| mixed/csv-parse | 390.8ms | 525.4ms | — |
| mixed/text-search | 380.4ms | 525.4ms | 474.0ms |
| mixed/fibonacci | 348.7ms | 389.8ms | 356.0ms |
| mixed/matrix-multiply | 500.6ms | 535.9ms | 392.4ms |
| mixed/sieve | 467.7ms | 515.6ms | — |
