# ReelEel.com — Full MVP PRD

The product spec this repository implements. Kept in-tree so decisions can be
checked against it. See [../README.md](../README.md) for what is actually built
so far.

## Product

ReelEel is a local-first, FOSS youth-sports video intelligence application for
Windows, macOS, Linux, and an installable mobile-friendly PWA. Soccer is the
first supported sport.

**Core promise:** Import a game, identify your kid, let ReelEel follow the
action, review suggested moments, and generate a shareable highlight reel.

## Core constraints

- All software required for core functionality must be FOSS.
- No proprietary AI API is required.
- GPU is optional; CPU-only operation is required.
- Core desktop workflows work offline.
- Source youth-sports footage stays local by default.
- No facial recognition or biometric identification of minors.
- No account is required for local desktop use.
- Architecture must support additional sports later.

## Target users

1. Parents recording youth games.
2. Youth athletes creating highlights/recruiting footage.
3. Coaches reviewing player-specific moments.
4. Amateur teams needing inexpensive automated video tools.

## MVP user flow

1. Install ReelEel.
2. Create a project and import MP4/MOV/MKV/WebM/M4V footage.
3. Select Soccer.
4. ReelEel probes the video and generates thumbnails/proxy media.
5. User scrubs to a clear frame and clicks/draws a box around their athlete.
6. User may enter player name, jersey number, team, and jersey color.
7. Click **Analyze Game**.
8. ReelEel locally detects and tracks players, ball, referees, goalkeeper, and goal.
9. ReelEel follows the selected player and scores candidate interesting moments.
10. User reviews, accepts/rejects, trims, and reorders suggested clips.
11. Virtual Cameraman creates smooth player/action-focused crops from wide footage.
12. User clicks **Create Reel**.
13. FFmpeg renders a 16:9, 9:16, or 1:1 MP4.

## Platforms

### Desktop

First-class: Windows 11+, macOS (Apple Silicon first), Linux (Ubuntu 24.04+ first).

Desktop performs heavy local media/CV processing, filesystem access, model
management, background jobs, and exports.

### PWA

Responsive/installable for desktop browsers, Android, iPhone/iPad, and tablets
where browser APIs permit.

PWA MVP features: projects, import/capture where supported, player selection,
analysis status, highlight review, clip trimming, reel preview, export/share,
settings.

Heavy CV processing may be limited in browsers. Shared UI and business logic
should be maximized.

## Local-first architecture

Each game is a portable project:

```text
project/
├── project.json
├── source/
├── proxies/
├── thumbnails/
├── analysis/
├── annotations/
├── clips/
├── models/
└── exports/
```

Source media should normally be referenced in place rather than duplicated.
SQLite stores project metadata, jobs, detections, tracks, moments, clips, and
annotations.

## FOSS stack

Preferred components, subject to license review:

- FFmpeg/ffprobe — decoding, encoding, thumbnails, proxies, crops, clips, overlays, final renders.
- PyTorch — training/inference.
- OpenCV — CV utilities and geometry.
- MMDetection/OpenMMLab-compatible detector stack — custom object detection.
- ByteTrack or equivalent FOSS tracker — multi-object tracking.
- ONNX Runtime — portable optimized inference where useful.
- SQLite — local database.
- Python — CV/model workers and training tools.
- TypeScript — application UI/business logic.
- FOSS PWA tooling.
- FOSS cross-platform desktop wrapper/runtime.

Maintain `THIRD_PARTY_LICENSES.md`, dependency/model license inventory, model
cards, and dataset provenance. **Every pretrained model and dataset must be
reviewed separately; a FOSS framework does not guarantee its weights/data are
suitable for commercial redistribution.**

## Desktop architecture

```text
Shared UI
    |
Desktop bridge
    |
+---+------+------+
|          |      |
SQLite   FFmpeg  CV Worker
                  |
            PyTorch/ONNX
```

Desktop responsibilities: native filesystem access, FFmpeg process management,
SQLite, Python/CV workers, model storage, hardware/backend detection, background
jobs/progress, export destinations, OS notifications.

## Video import

Use ffprobe to show duration, resolution, FPS, codec, and size. Generate
thumbnails and an optional lower-resolution editing proxy. Preserve original
media for final rendering. Multiple sequential source files may represent one
game; multi-camera synchronization is out of MVP scope.

## Sport plugin system

```text
sports/
├── soccer/
│   ├── classes.json
│   ├── rules.json
│   ├── models/
│   └── events/
├── basketball/
├── baseball/
└── hockey/
```

A sport plugin can define object classes, models, tracker settings, field/court
geometry, event rules, thresholds, annotation schema, highlight scoring, and UI
terminology.

## Soccer classes

Required: `player`, `ball`, `referee`, `goalkeeper`, `goal`.

Experimental: `goal_post`, `field_line`, `corner_flag`, `scoreboard`, `bench`.

Team identity should be metadata/classification layered onto player detections.

## Player identification

The user selects the focal athlete from a clear frame. ReelEel associates that
detection with a track ID.

Optional metadata: display name, jersey number, team, jersey color.

Re-identification may use jersey appearance/color/number, non-biometric
appearance embeddings, position, and track continuity. Low-confidence identity
segments must be marked uncertain rather than silently assigning the wrong
player. **Facial recognition is excluded.**

## Tracking

Persist player, ball, referee, and goalkeeper tracks independently of rendered
video.

Track data includes: track ID/class, frame/timestamp, bounding box,
detection/tracking confidence, occlusion state.

Manual tools: correct box, reassign focal player, merge tracks, split tracks,
mark lost/occluded, restore identity.

## Built-in annotation tool

ReelEel includes its own sports-focused annotator so no hosted annotation
product is required.

Required: play/pause, frame stepping, variable playback speed, draw/move/resize
box, assign class and track ID, delete, copy forward, keyframes/interpolation,
accept/reject AI predictions, occluded/out-of-frame flags, merge/split tracks,
undo/redo, keyboard shortcuts.

Suggested shortcuts:

```text
1 player     Space accept/next
2 ball       Delete remove
3 referee    Left  previous frame
4 goalkeeper Right next frame
5 goal
```

Import/export: COCO JSON, YOLO-style labels, ReelEel JSON.

## Human-in-the-loop learning

```text
manual labels → train v1 → v1 pre-labels new footage → human corrects
→ corrected labels join dataset → train v2
```

The annotator should optimize *correction* rather than repeatedly labeling from
scratch.

## Training pipeline

```text
annotated projects → dataset builder → train/validation/test split
→ PyTorch training → evaluation → versioned model → local model registry
```

Prefer splits by game/recording to reduce adjacent-frame leakage.

Model registry stores sport, version, architecture, classes, dataset version,
metrics, license, checksum, date, and runtime requirements.

Ordinary users do not need to train models; training is an advanced/developer
workflow.

## CPU and GPU

GPU is not required. CPU mode must support the full workflow using frame
sampling, reduced inference resolution, small detector models, proxy media,
background processing, and ONNX optimization where useful.

Optional acceleration may support compatible NVIDIA, AMD, Apple, and other
runtime backends.

Presets: Fast, Balanced, Accurate, Custom. Show estimated processing
time/storage where practical.

## Virtual Cameraman

Use focal-player track, ball track, nearby-player cluster, velocity, confidence,
and source resolution to produce a smooth crop path.

Requirements: smooth pans/zooms, avoid jitter, keep focal athlete visible,
prefer ball visibility when relevant, anticipate motion where practical,
preserve usable source resolution.

Modes: Follow Player, Follow Action, Wide, Follow Ball (experimental). MVP
priority: Follow Player and Follow Action.

## Suggested moment detection

MVP may use observable heuristics/model signals rather than claiming perfect
soccer semantics: ball approaches focal player, player-ball proximity, player
acceleration, player/ball moving toward goal, high activity near goal, sustained
player-ball proximity, sudden motion/activity changes, optional audio-energy
spike, user marker.

```json
{
  "start": 182.4,
  "end": 194.8,
  "score": 0.87,
  "reasons": ["player_ball_proximity", "high_motion", "toward_goal"]
}
```

UI calls these **Suggested Moments** unless a specific event classifier is
sufficiently reliable.

## Highlight review

Chronological cards show preview, timestamp, duration, score, reason,
include/exclude, favorite, trim, and delete. Users can manually add a highlight
anywhere on the timeline.

## Reel editor

Lightweight: timeline, reorder clips, trim, add/remove clips, preview, title
card, athlete name/number overlay, team/opponent/date text, basic transitions,
original audio toggle, user-supplied music/audio.

This is a highlight assembler, not a full professional NLE.

## Export

FFmpeg renders 1920x1080 (16:9), 1080x1920 (9:16), 1080x1080 (1:1).

Options: resolution, FPS, quality, audio, intro/outro, player label, watermark
toggle, optional timestamp.

## Jobs

Long-running work runs outside the UI thread: probe, proxy, thumbnails,
detection, tracking, highlight scoring, clip generation, reel rendering, dataset
export, training.

Jobs have queued/running/completed/failed/canceled status, stage, progress, ETA
when reasonable, logs, retry, and cancel. Cache analysis so reel edits do not
rerun AI. Resume interrupted work where practical.

## Data model

Core entities: Project, SourceVideo, Athlete, Team, Detection, Track,
TrackPoint, Annotation, SuggestedMoment, Clip, Reel, Export, AnalysisJob, Model,
Dataset, SportPlugin.

Use versioned SQLite migrations.

## Privacy / youth safety

- No facial recognition.
- No default public minor profiles.
- No automatic geotagging.
- Local storage by default.
- Explicit opt-in for any future cloud upload.
- One-click project/derived-data deletion.
- Do not use private footage for centralized training without explicit opt-in.
- Any future shared-training program requires clear, revocable consent.
- Avoid collecting birthdays, schools, locations, or other unnecessary child data.
- Strip/warn about unnecessary media metadata on social exports where practical.

## Accounts

No account required for desktop MVP. Future optional accounts may support sync,
collaboration, sharing, and model distribution without removing offline/local
functionality.

## Screens

1. Welcome/New Project
2. Projects
3. Import Game
4. Game Setup
5. Player Selection
6. Analysis
7. Game Viewer
8. Suggested Moments
9. Annotation/Correction
10. Reel Editor
11. Export
12. Models
13. Settings
14. About/Licenses

## CLI

GUI and CLI use the same underlying services.

```bash
reeleel probe game.mp4
reeleel project create game.mp4
reeleel analyze ./my-game
reeleel analyze ./my-game --preset fast
reeleel export ./my-game --reel highlights
reeleel dataset export ./my-game --format coco
reeleel models list
```

See [cli.md](cli.md) for the implemented command surface.

## Performance requirements

- UI remains responsive during analysis.
- Probe/import starts within seconds.
- Proxy scrubbing is smooth on typical hardware.
- CPU-only full-game analysis is supported.
- Analysis can be canceled.
- Cached detections/tracks are reusable.
- Editing a reel never requires rerunning detection.
- Hardware encoding may be used when available with software fallback.

## Error handling

Handle: corrupt/unsupported media, missing FFmpeg, low disk space, worker crash,
model missing/corrupt, GPU backend failure, out-of-memory, source file moved,
interrupted render.

GPU failure should fall back to CPU when possible.

## Accessibility

Keyboard-operable desktop UI, visible focus states, semantic controls,
captions/text alternatives where applicable, scalable UI, touch-friendly PWA, do
not rely on color alone for track/class state.

## Telemetry

Core app must work without telemetry. Any future diagnostics/analytics must be
optional, privacy-preserving, disclosed, and disableable.

## Testing

Required: TypeScript unit tests, Python/CV unit tests, SQLite migration tests,
FFmpeg integration tests, desktop E2E tests, PWA E2E tests, fixture videos,
deterministic annotation import/export tests, model regression benchmarks,
CPU-only CI path where practical.

**Never include private user youth footage in public test fixtures.**

## MVP acceptance criteria

MVP is complete when a user can, on a supported desktop OS:

1. Install ReelEel.
2. Create a soccer project.
3. Import a normal game video.
4. Identify a player.
5. Run CPU-only analysis.
6. See player/ball detections and tracks.
7. Correct tracking/annotations.
8. Receive suggested moments.
9. Preview/edit clips.
10. Generate a virtual-camera crop.
11. Assemble a reel.
12. Export a playable 16:9 or 9:16 MP4.
13. Reopen the project without losing analysis.
14. Export annotations/dataset.
15. Complete all core steps offline after installation.

The PWA MVP is complete when its responsive project/review/edit experience is
installable and usable on modern mobile/desktop browsers within browser
limitations.

## MVP development phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 — Foundation | Cross-platform shell, shared UI, SQLite, project model, FFmpeg discovery/probe, video import, thumbnails, proxies, viewer | mostly done (shell is web; desktop packaging pending) |
| 2 — Annotation | Bounding boxes, classes, tracks, keyframes, interpolation, keyboard workflow, COCO/YOLO/ReelEel I/O | storage + import/export done; editor UI pending |
| 3 — CV | Pretrained detector integration, soccer classes, CPU inference, optional acceleration, tracking, overlays, focal-player selection | contract defined, not implemented |
| 4 — Sports intelligence | Focal-player continuity, ball/player relationships, suggested-moment scoring, uncertainty UX | scoring engine done |
| 5 — Virtual Cameraman | Smooth crop path generation, player/action modes, preview, FFmpeg render | done |
| 6 — Reel editor | Suggested clips, trimming, ordering, title/labels, audio controls, 16:9/9:16/1:1 exports | done (CLI + API; richer UI pending) |
| 7 — PWA | Responsive/installable PWA, offline shell, browser-safe local workflows | SSR + islands done; installability pending |
| 8 — Training loop | Dataset builder, local training commands, evaluation, model registry, model-assisted annotation | dataset builder + registry done |
| 9 — Hardening | Packaging, resumable jobs, performance, accessibility, privacy controls, tests, docs, license audit | ongoing |

## Post-MVP roadmap

Basketball, baseball/softball, hockey, lacrosse, football, volleyball. Better
jersey-number OCR. Team classification. Field calibration/homography.
Distance/speed/heatmaps. Pass/shot/goal event classifiers. Player stats.
Recruiting-reel templates. Coach workflows. Local-network phone remote. Optional
encrypted sync/team collaboration. Live capture/analysis. Multi-camera
synchronization. FOSS community model/dataset ecosystem with explicit
consent/provenance.

## Product principle

**ReelEel should make a cheap tripod and ordinary camera feel like an automated
youth-sports camera crew — without forcing families to upload their kids'
footage to someone else's AI cloud.**
