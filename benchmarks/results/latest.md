# js2wasm Benchmark Results

Date: 2026-09-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.040ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.014ms | gc-native |
| string/includes | 0.015ms | 0.080ms | 0.011ms | 0.020ms | gc-native |
| string/split | 0.324ms | 6.27ms | 2.08ms | FAILED | js |
| string/replace | 0.077ms | 0.465ms | 0.209ms | FAILED | js |
| string/case-convert | 0.045ms | 0.425ms | 0.184ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 2.50ms | 1.83ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.90ms | 1.89ms | 0.436ms | js |
| array/push-pop | 1.29ms | 0.476ms | 0.487ms | FAILED | host-call |
| array/sort-i32 | 0.652ms | 0.238ms | 0.298ms | FAILED | host-call |
| array/map-filter | 0.109ms | 0.053ms | 0.056ms | FAILED | host-call |
| array/reduce | 1.86ms | 0.475ms | 0.477ms | FAILED | host-call |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.035ms | 0.015ms | 0.015ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.044ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.940ms | gc-native |
| dom/create-elements | 0.032ms | 0.120ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.408ms | — | — | js |
| dom/read-attributes | 0.047ms | 0.104ms | — | — | js |
| dom/modify-text | 0.024ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.363ms | 6.07ms | 0.419ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.31ms | 1.85ms | 0.875ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 1.09ms | js |
| mixed/matrix-multiply | 0.147ms | 51.15ms | 51.32ms | 0.563ms | js |
| mixed/sieve | 1.42ms | 1.83ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.81 | 3.99 | 3.85 | — |
| string/concat-long | 1000 | 3.23 | 4.26 | 3.06 | — |
| string/indexOf | 1000 | 14.78 | 46.67 | 9.81 | 13.51 |
| string/includes | 1000 | 14.53 | 79.87 | 11.03 | 20.17 |
| string/split | 10000 | 32.37 | 627.36 | 207.60 | — |
| string/replace | 1000 | 76.65 | 465.29 | 209.25 | — |
| string/case-convert | 2000 | 22.50 | 212.43 | 91.90 | — |
| string/substring | 10000 | 8.10 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.47 | 249.56 | 183.30 | — |
| string/startsWith-endsWith | 20000 | 15.98 | 95.03 | 94.64 | 21.78 |
| array/map-filter | 30000 | 3.62 | 1.76 | 1.86 | — |
| array/indexOf | 1000 | 3462.17 | 2222.81 | 2222.51 | — |
| dom/create-elements | 2000 | 15.98 | 60.01 | — | — |
| dom/set-attributes | 6000 | 14.38 | 67.92 | — | — |
| dom/read-attributes | 3000 | 15.79 | 34.73 | — | — |
| dom/modify-text | 2000 | 12.11 | 44.31 | — | — |
| mixed/csv-parse | 11000 | 32.96 | 551.90 | 38.13 | — |
| mixed/text-search | 40000 | 7.82 | 82.87 | 46.34 | 21.88 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.40 | 109.31 |
| mixed/matrix-multiply | 125000 | 1.18 | 409.22 | 410.57 | 4.51 |
| mixed/sieve | 200000 | 7.10 | 9.16 | 9.04 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.42x slower | 1.37x slower | — |
| string/concat-long | 1.32x slower | 1.05x faster | — |
| string/indexOf | 3.16x slower | 1.51x faster | 1.09x faster |
| string/includes | 5.50x slower | 1.32x faster | 1.39x slower |
| string/split | 19.38x slower | 6.41x slower | — |
| string/replace | 6.07x slower | 2.73x slower | — |
| string/case-convert | 9.44x slower | 4.09x slower | — |
| string/substring | 2.62x faster | 3.05x faster | — |
| string/trim | 18.52x slower | 13.60x slower | — |
| string/startsWith-endsWith | 5.95x slower | 5.92x slower | 1.36x slower |
| array/push-pop | 2.70x faster | 2.64x faster | — |
| array/sort-i32 | 2.74x faster | 2.19x faster | — |
| array/map-filter | 2.06x faster | 1.94x faster | — |
| array/reduce | 3.92x faster | 3.90x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.34x faster | 2.32x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.93x faster | 1.92x faster | — |
| array/find | 17.55x faster | 17.75x faster | 4.41x slower |
| dom/create-elements | 3.75x slower | — | — |
| dom/set-attributes | 4.72x slower | — | — |
| dom/read-attributes | 2.20x slower | — | — |
| dom/modify-text | 3.66x slower | — | — |
| mixed/csv-parse | 16.74x slower | 1.16x slower | — |
| mixed/text-search | 10.60x slower | 5.93x slower | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 11.25x slower |
| mixed/matrix-multiply | 347.94x slower | 349.09x slower | 3.83x slower |
| mixed/sieve | 1.29x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x faster |
| string/concat-long | 1.39x faster |
| string/indexOf | 4.76x faster |
| string/includes | 7.24x faster |
| string/split | 3.02x faster |
| string/replace | 2.22x faster |
| string/case-convert | 2.31x faster |
| string/substring | 1.16x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.25x slower |
| array/map-filter | 1.06x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 14.48x faster |
| mixed/text-search | 1.79x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 980B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.2KB | 10.4KB |
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
| array/indexOf | 1.8KB | 2.2KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.1KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1318.8ms | 835.4ms | — |
| string/concat-long | 612.3ms | 774.8ms | — |
| string/indexOf | 542.0ms | 782.4ms | 681.7ms |
| string/includes | 546.6ms | 772.0ms | 648.5ms |
| string/split | 604.7ms | 774.9ms | — |
| string/replace | 631.7ms | 826.7ms | — |
| string/case-convert | 633.9ms | 700.1ms | — |
| string/substring | 539.8ms | 640.6ms | — |
| string/trim | 606.5ms | 767.0ms | — |
| string/startsWith-endsWith | 595.5ms | 766.6ms | 709.1ms |
| array/push-pop | 615.2ms | 704.4ms | — |
| array/sort-i32 | 755.1ms | 806.5ms | — |
| array/map-filter | 733.3ms | 819.9ms | — |
| array/reduce | 691.9ms | 785.7ms | — |
| array/indexOf | 692.1ms | 787.3ms | — |
| array/slice | 630.6ms | 680.3ms | — |
| array/reverse | 631.4ms | 708.4ms | — |
| array/forEach | 746.4ms | 810.2ms | — |
| array/find | 637.6ms | 679.3ms | 686.6ms |
| dom/create-elements | 594.5ms | — | — |
| dom/set-attributes | 605.6ms | — | — |
| dom/read-attributes | 601.1ms | — | — |
| dom/modify-text | 574.6ms | — | — |
| mixed/csv-parse | 670.4ms | 798.8ms | — |
| mixed/text-search | 628.2ms | 799.6ms | 736.9ms |
| mixed/fibonacci | 616.6ms | 623.9ms | 628.7ms |
| mixed/matrix-multiply | 737.1ms | 783.5ms | 656.0ms |
| mixed/sieve | 711.1ms | 761.1ms | — |
