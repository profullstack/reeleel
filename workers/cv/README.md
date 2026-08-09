# ReelEel CV worker

Detection and tracking run **out of process**, in Python. That is deliberate: a
crashed model, an out-of-memory kill, or a wedged GPU driver takes down this
worker instead of the app the user is editing in.

Everything else in ReelEel — import, probe, review, trim, reorder, export —
works without this worker installed. `reeleel doctor` reports it as a warning,
not a failure.

## Status

Not implemented yet. This directory defines the **contract** so the TypeScript
side can be built, tested and shipped against a stable interface (PRD phase 3).

## Install

```bash
pip install -e workers/cv
```

Or point ReelEel at any executable that speaks the protocol below:

```bash
export REELEEL_CV_WORKER=/path/to/my-worker
```

Resolution order used by `@reeleel/core`:

1. `$REELEEL_CV_WORKER`
2. `reeleel-cv` on `$PATH`
3. `workers/cv/reeleel_cv/__main__.py` run through `$REELEEL_PYTHON` (default `python3`)

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
