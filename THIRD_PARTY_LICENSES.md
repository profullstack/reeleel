# Third-party licenses

ReelEel is FOSS and every required component must be too. This file is the
running inventory. It is **not** generated — keep it current by hand when
dependencies change, because the interesting cases (FFmpeg build flags, model
weights) are exactly the ones a generator gets wrong.

## The rule that matters most

**A FOSS framework does not make its published weights redistributable.**

PyTorch is BSD-3-Clause. A checkpoint someone trained with PyTorch on a dataset
with a non-commercial or research-only license is *not* BSD-3-Clause, and
shipping it would be a licensing problem regardless of how permissive the
framework is. Every model and every dataset gets reviewed on its own terms and
recorded in the model registry:

```bash
reeleel models add <name> --version <v> --sport soccer \
  --file <weights> --license <spdx>
```

`reeleel doctor` warns about any registered model whose license is `unknown`.

## Runtime dependencies (JavaScript)

| Package | License | Used for |
| --- | --- | --- |
| `hono` | MIT | HTTP routing, JSX SSR, client islands (`hono/jsx/dom`) |
| `@hono/node-server` | MIT | Node adapter for Hono |
| `@libsql/client` | MIT | libSQL/Turso client — local files and optional cloud sync |
| `commander` | MIT | CLI argument parsing |
| `chalk` | MIT | Terminal colour |

## Build and test dependencies

| Package | License | Used for |
| --- | --- | --- |
| `typescript` | Apache-2.0 | Type checking and build |
| `tsx` | MIT | Running TypeScript directly in development |
| `esbuild` | MIT | Bundling the client island |
| `vitest` | MIT | Tests |
| `eslint`, `typescript-eslint` | MIT | Linting |
| `prettier` | MIT | Formatting |

## External programs (not bundled)

| Program | License | Notes |
| --- | --- | --- |
| FFmpeg / ffprobe | LGPL-2.1-or-later, or GPL depending on build flags | **Not bundled.** ReelEel locates an FFmpeg already installed on the system. If a distribution ever bundles it, the build's configure flags decide the license and that decision must be recorded here. |
| Python 3 | PSF-2.0 | Only needed for the optional CV worker |

## Planned CV stack (PRD phase 3, not yet a dependency)

| Component | License | Notes |
| --- | --- | --- |
| PyTorch | BSD-3-Clause | Framework only; weights reviewed separately |
| OpenCV | Apache-2.0 (4.5.0+) | CV utilities and geometry |
| ONNX Runtime | MIT | Portable optimised inference |
| MMDetection | Apache-2.0 | Detector stack; **pretrained weights reviewed separately** |
| ByteTrack | MIT | Tracker; check any bundled weights separately |

## Models and datasets

| Model | Version | License | Dataset | Dataset license | Reviewed |
| --- | --- | --- | --- | --- | --- |
| _(none registered yet)_ | | | | | |

No model ships with ReelEel today. When one does, it gets a row here and a model
card alongside it, covering: what it was trained on, how the data was obtained,
consent and provenance for any footage of minors, and measured performance.

## Footage

No user footage is ever included in this repository, in test fixtures, or in any
public artifact. Test fixtures must be synthetic or clearly-licensed stock.
