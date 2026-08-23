# js2wasm Benchmark Results

Date: 2026-08-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.047ms | 0.035ms | 0.043ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.040ms | 0.009ms | 0.027ms | gc-native |
| string/includes | 0.012ms | 0.068ms | 0.011ms | 0.029ms | gc-native |
| string/split | 0.272ms | 3.16ms | 0.307ms | FAILED | js |
| string/replace | 0.061ms | 0.174ms | 0.043ms | FAILED | gc-native |
| string/case-convert | 0.041ms | 0.129ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.124ms | 0.027ms | 0.023ms | FAILED | gc-native |
| string/trim | 0.165ms | 0.527ms | 0.121ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.359ms | 0.271ms | 0.188ms | 0.392ms | gc-native |
| array/push-pop | 1.17ms | 0.387ms | 0.389ms | FAILED | host-call |
| array/sort-i32 | 0.460ms | 0.249ms | 0.247ms | FAILED | gc-native |
| array/map-filter | 0.113ms | 0.067ms | 0.066ms | FAILED | gc-native |
| array/reduce | 1.74ms | 0.396ms | 0.356ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.87ms | 1.87ms | FAILED | host-call |
| array/slice | 0.034ms | 0.029ms | 0.033ms | FAILED | host-call |
| array/reverse | 4.96ms | 2.72ms | 2.72ms | FAILED | host-call |
| array/forEach | 0.071ms | 0.021ms | 0.021ms | FAILED | host-call |
| array/find | 0.219ms | 0.013ms | 0.015ms | 0.710ms | host-call |
| dom/create-elements | 0.062ms | FAILED | — | — | js |
| dom/set-attributes | 0.108ms | FAILED | — | — | js |
| dom/read-attributes | 0.066ms | FAILED | — | — | js |
| dom/modify-text | 0.057ms | FAILED | — | — | js |
| mixed/csv-parse | 0.606ms | 4.26ms | 0.214ms | FAILED | gc-native |
| mixed/text-search | 0.311ms | 0.865ms | 0.186ms | 0.812ms | gc-native |
| mixed/fibonacci | 0.109ms | 0.153ms | 0.153ms | 0.159ms | js |
| mixed/matrix-multiply | 0.143ms | 0.169ms | 0.170ms | 0.528ms | js |
| mixed/sieve | 1.31ms | 1.23ms | 1.22ms | FAILED | gc-native |

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
| dom/create-elements | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/set-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/read-attributes | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| dom/modify-text | host-call | warmup | Cannot read properties of null (reading 'createElement') |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 4.66 | 3.51 | 4.27 | — |
| string/concat-long | 1000 | 3.74 | 4.28 | 6.32 | — |
| string/indexOf | 1000 | 11.83 | 40.22 | 8.66 | 26.57 |
| string/includes | 1000 | 11.82 | 67.61 | 10.65 | 28.86 |
| string/split | 10000 | 27.21 | 316.21 | 30.70 | — |
| string/replace | 1000 | 61.30 | 173.69 | 42.70 | — |
| string/case-convert | 2000 | 20.36 | 64.52 | 2.42 | — |
| string/substring | 10000 | 12.42 | 2.73 | 2.30 | — |
| string/trim | 10000 | 16.54 | 52.73 | 12.13 | — |
| string/startsWith-endsWith | 20000 | 17.97 | 13.57 | 9.42 | 19.62 |
| array/map-filter | 30000 | 3.78 | 2.22 | 2.20 | — |
| array/indexOf | 1000 | 3912.81 | 1872.60 | 1873.31 | — |
| dom/create-elements | 2000 | 31.04 | — | — | — |
| dom/set-attributes | 6000 | 18.00 | — | — | — |
| dom/read-attributes | 3000 | 22.09 | — | — | — |
| dom/modify-text | 2000 | 28.40 | — | — | — |
| mixed/csv-parse | 11000 | 55.13 | 387.18 | 19.43 | — |
| mixed/text-search | 40000 | 7.77 | 21.62 | 4.64 | 20.30 |
| mixed/fibonacci | 10000 | 10.90 | 15.32 | 15.28 | 15.95 |
| mixed/matrix-multiply | 125000 | 1.15 | 1.36 | 1.36 | 4.22 |
| mixed/sieve | 200000 | 6.53 | 6.17 | 6.10 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.33x faster | 1.09x faster | — |
| string/concat-long | 1.15x slower | 1.69x slower | — |
| string/indexOf | 3.40x slower | 1.37x faster | 2.25x slower |
| string/includes | 5.72x slower | 1.11x faster | 2.44x slower |
| string/split | 11.62x slower | 1.13x slower | — |
| string/replace | 2.83x slower | 1.44x faster | — |
| string/case-convert | 3.17x slower | 8.41x faster | — |
| string/substring | 4.54x faster | 5.40x faster | — |
| string/trim | 3.19x slower | 1.36x faster | — |
| string/startsWith-endsWith | 1.32x faster | 1.91x faster | 1.09x slower |
| array/push-pop | 3.02x faster | 2.99x faster | — |
| array/sort-i32 | 1.85x faster | 1.86x faster | — |
| array/map-filter | 1.70x faster | 1.71x faster | — |
| array/reduce | 4.41x faster | 4.90x faster | — |
| array/indexOf | 2.09x faster | 2.09x faster | — |
| array/slice | 1.16x faster | 1.02x faster | — |
| array/reverse | 1.82x faster | 1.82x faster | — |
| array/forEach | 3.43x faster | 3.41x faster | — |
| array/find | 17.49x faster | 14.98x faster | 3.24x slower |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 7.02x slower | 2.84x faster | — |
| mixed/text-search | 2.78x slower | 1.67x faster | 2.61x slower |
| mixed/fibonacci | 1.41x slower | 1.40x slower | 1.46x slower |
| mixed/matrix-multiply | 1.18x slower | 1.18x slower | 3.68x slower |
| mixed/sieve | 1.06x faster | 1.07x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x slower |
| string/concat-long | 1.47x slower |
| string/indexOf | 4.64x faster |
| string/includes | 6.35x faster |
| string/split | 10.30x faster |
| string/replace | 4.07x faster |
| string/case-convert | 26.66x faster |
| string/substring | 1.19x faster |
| string/trim | 4.35x faster |
| string/startsWith-endsWith | 1.44x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.11x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.14x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.17x slower |
| mixed/csv-parse | 19.93x faster |
| mixed/text-search | 4.66x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.7KB | 2.1KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 939.0ms | 783.1ms | — |
| string/concat-long | 468.8ms | 703.8ms | — |
| string/indexOf | 486.5ms | 676.1ms | 590.2ms |
| string/includes | 484.1ms | 679.9ms | 599.0ms |
| string/split | 541.3ms | 688.1ms | — |
| string/replace | 545.1ms | 728.4ms | — |
| string/case-convert | 559.1ms | 627.6ms | — |
| string/substring | 483.5ms | 554.4ms | — |
| string/trim | 549.1ms | 685.5ms | — |
| string/startsWith-endsWith | 566.1ms | 704.2ms | 639.9ms |
| array/push-pop | 576.7ms | 589.1ms | — |
| array/sort-i32 | 636.4ms | 687.9ms | — |
| array/map-filter | 636.2ms | 698.9ms | — |
| array/reduce | 609.2ms | 680.2ms | — |
| array/indexOf | 607.3ms | 645.1ms | — |
| array/slice | 569.3ms | 597.2ms | — |
| array/reverse | 562.8ms | 613.8ms | — |
| array/forEach | 651.8ms | 678.7ms | — |
| array/find | 530.2ms | 608.3ms | 595.2ms |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 582.4ms | 673.4ms | — |
| mixed/text-search | 545.8ms | 675.9ms | 649.7ms |
| mixed/fibonacci | 556.6ms | 558.6ms | 616.3ms |
| mixed/matrix-multiply | 584.4ms | 675.9ms | 552.1ms |
| mixed/sieve | 623.8ms | 688.8ms | — |
