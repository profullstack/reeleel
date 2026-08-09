# ReelEel CV worker

Detection and tracking run **out of process**, in Python. That is deliberate: a
crashed model, an out-of-memory kill, or a wedged GPU driver takes down this
worker instead of the app the user is editing in.

Everything else in ReelEel — import, probe, review, trim, reorder, export —
works without this worker installed. `reeleel doctor` reports it as a warning,
not a failure.

## Status

**Implemented — see [`apps/cv-worker`](../../apps/cv-worker).**

The shipped worker is TypeScript on onnxruntime-node, not Python. The protocol
below is unchanged and language-agnostic, so a Python worker can replace it by
setting `REELEEL_CV_WORKER`; this directory keeps the contract and the Python
skeleton for that.

Why TypeScript for the reference implementation:

- It runs in the same Node runtime the rest of the app already needs, so the
  container gains ~15 MB of native onnxruntime rather than Python plus torch,
  opencv and numpy wheels.
- Frames come from FFmpeg, which is already a hard dependency, instead of
  OpenCV.
- It is testable in the same suite as everything else.

Training tools remain Python's job (PRD phase 8) — that is where PyTorch
genuinely earns its place.

## Install

Nothing to install: it is built with the workspace. Fetch the weights once.

```bash
pnpm build
node apps/cv-worker/dist/index.js fetch-model --sport soccer
```

Or point ReelEel at any executable that speaks the protocol below:

```bash
export REELEEL_CV_WORKER=/path/to/my-worker
```

Resolution order used by `@reeleel/core`:

1. `$REELEEL_CV_WORKER` (a `.js` path is run with the current Node binary)
2. `reeleel-cv` on `$PATH`
3. `apps/cv-worker/dist/index.js`, located relative to the core module
4. `workers/cv/reeleel_cv/__main__.py` through `$REELEEL_PYTHON`

## What it can and cannot detect

The default model is **YOLOX-Tiny trained on COCO** (Apache-2.0, framework and
weights). COCO knows `person` and `sports ball`, which map to **player** and
**ball**.

It does **not** produce `referee`, `goalkeeper` or `goal`. COCO has no such
classes, and every person on a pitch looks identical to it. Guessing a role from
a person box would be inventing data, so the worker reports those classes as
unsupported instead. Moment scoring already tolerates missing signals — rules
like `toward_goal` simply never fire until a sport-specific model exists.

Training that model is PRD phase 8, and the annotation and dataset-export
machinery for it already ships.

## Protocol

One subcommand, JSON on stdout, human-readable progress on stderr.

```bash
reeleel-cv detect-and-track \
  --input /path/to/proxy.mp4 \
  --sport soccer \
  --classes player,ball,referee,goalkeeper,goal \
  --frame-stride 2 \
  --inference-size 768 \
  --min-confidence 0.3 \
  --tracker bytetrack \
  --backend auto \
  --json
```

### Success

Exit `0`, with a single JSON object on stdout:

```json
{
  "tracks": [
    {
      "class": "player",
      "confidence": 0.91,
      "points": [
        { "frame": 0, "ts": 0.0, "x": 812, "y": 430, "w": 64, "h": 148, "confidence": 0.93 }
      ]
    }
  ]
}
```

Boxes are **pixels in the coordinate space of `--input`**. When ReelEel passes a
proxy, it scales the boxes back to source resolution itself — the worker should
not try to guess the original size.

### Failure

Either exit non-zero with a message on stderr, or exit `0` with:

```json
{ "error": "No model registered for sport 'soccer'." }
```

Both surface as a `WORKER_CRASHED` error with the message attached, so make the
message something a parent can act on.

## Requirements the worker must honour

- **CPU-only must work.** GPU is an optimisation, never a requirement. Fall back
  to CPU when a backend fails rather than erroring out.
- **No facial recognition.** Identity is re-established from jersey appearance,
  colour, position and track continuity. Never from faces.
- **Respect `--frame-stride`.** The tracker interpolates the gaps; the detector
  does not need to see every frame.
- **Emit progress on stderr, data on stdout.** Anything on stdout that is not
  the final JSON object will break parsing.

## Licensing

Every pretrained model and dataset needs its own review. A FOSS framework
(PyTorch, MMDetection, ONNX Runtime) does **not** make its published weights
redistributable. Record each model's license with
`reeleel models add … --license <spdx>` and keep `THIRD_PARTY_LICENSES.md`
current.
