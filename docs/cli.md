# ReelEel CLI reference

The CLI and the GUI call the same `@reeleel/core` services, so anything you can
do in the app you can script.

```
reeleel [global options] <command> [subcommand] [options]
```

## Global options

| Option | Meaning |
| --- | --- |
| `-p, --project <ref>` | Project to act on: a path, a registered id, or a name |
| `--json` | Machine-readable output only. Errors become JSON on stderr with a stable `code` |
| `-q, --quiet` | Suppress non-essential output |
| `--no-color` | Disable colour |
| `-v, --version` | Print the version |

**How a project is chosen**, in order: the positional argument, then
`--project`, then `$REELEEL_PROJECT`, then the nearest project directory walking
up from the current directory. So `cd my-game && reeleel analyze` just works.

## Alias conventions

Every group follows the same pattern, so you rarely have to check:

| Canonical | Aliases |
| --- | --- |
| `list` | `ls` |
| `update` | `set`, `edit` (plus `trim` on moments and clips) |
| `remove` | `rm`, `delete`, `del` |
| `show` | `info` |
| `create` | `new` |

Group names also answer to their singular/plural forms: `project`/`projects`,
`athlete`/`athletes`/`player`/`players`, `clip`/`clips`, `reel`/`reels`,
`moment`/`moments`/`highlights`, `job`/`jobs`, `model`/`models`.

---

## Projects

```bash
reeleel project create <name> [--sport soccer] [--path <dir>]
                              [--description <text>] [--opponent <team>]
                              [--date <yyyy-mm-dd>] [--tag <tag>]
reeleel project list [--sport <sport>]
reeleel project show [ref]
reeleel project update [ref] [--name <name>] [--sport <sport>]
                             [--description <text>] [--opponent <team>]
                             [--date <yyyy-mm-dd>] [--tag <tag>]
reeleel project remove [ref] [--delete-files --yes] [--derived-only] [--forget]
reeleel project clean [ref]
reeleel project import <dir>
```

Aliases: `create`→`new`/`init`, `show`→`info`/`view`, `import`→`register`/`add`.

Passing an empty string to `--description`, `--opponent` or `--date` **clears**
that field.

`project remove` only unregisters by default; files stay put. `--delete-files`
is destructive and requires `--yes`. `--derived-only` (or `project clean`)
deletes only what can be regenerated — proxies, thumbnails, analysis, clips and
exports — and keeps your sources and your accept/reject decisions.

## Media

```bash
reeleel probe <file>                      # inspect without importing
reeleel import <file...> [--copy]         # import footage
reeleel import list
reeleel import update <ref> [--path <file>] [--order <n>] [--reprobe]
reeleel import remove <ref> [--delete-file]
reeleel import proxy <ref> [--height 540]
reeleel import thumbnails <ref> [--count 60]
reeleel import check                      # report moved or missing sources
```

Aliases: `import`→`video`/`videos`, `thumbnails`→`thumbs`, `check`→`verify`.

Source media is **referenced in place** by default; `--copy` stores it in the
project instead. `import remove --delete-file` only works on copied media —
ReelEel will not delete a file it did not put there.

Moved a file? `reeleel import update <id> --path <new location>` re-points it and
re-probes.

Supported containers: `.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`.

`<ref>` accepts an id, a 1-based index, or a filename fragment.

## Athletes

```bash
reeleel athlete add [--name <name>] [--number <jersey>] [--team <team>]
                    [--color <color>] [--focal]
reeleel athlete list
reeleel athlete show <ref>
reeleel athlete update <ref> [--name …] [--number …] [--team …] [--color …]
                             [--focal] [--track <trackId>]
reeleel athlete focus <ref>
reeleel athlete remove <ref>
```

Every field is optional. The first athlete added becomes focal automatically,
and exactly one athlete is focal at a time. `<ref>` accepts an id, a name or a
jersey number.

Identity is bound to a track during analysis; `--track` rebinds it after a
tracking correction, and `--track ""` unbinds.

## Analysis

```bash
reeleel analyze [ref] [--preset fast|balanced|accurate|custom]
                      [--video <ref>] [--skip-media] [--score-only]
reeleel rescore [ref] [--window <seconds>] [--keep]
```

`analyze` runs proxy → thumbnails → detection → tracking → scoring, recording
progress on a job you can inspect afterwards. Ctrl-C cancels cleanly and the job
is marked canceled rather than left running.

`rescore` re-scores **existing tracks** into moments without re-running
detection. Editing a reel never needs to pay for analysis twice.

Presets trade speed for accuracy: `fast` samples every 5th frame at 512px on the
proxy; `accurate` runs every frame at 1280px on the original.

## Moments

```bash
reeleel moments list [--included] [--rejected] [--favorites] [--min-score <n>]
reeleel moments show <ref>
reeleel moments add --start <time> --end <time> [--title <text>] [--video <id>]
reeleel moments update <ref> [--include] [--exclude] [--undecided]
                             [--start <time>] [--end <time>] [--title <text>]
                             [--favorite] [--unfavorite]
reeleel moments remove <ref>
```

Aliases: `add`→`mark`/`new`, `update`→`set`/`edit`/`trim`.

Times accept `90`, `1:30`, `1:02:03` or `90.5`.

`<ref>` is the `#` from `moments list` or the moment id.

A moment's decision is a **tri-state**: undecided, keep, reject. Only *kept*
moments become clips — undecided ones are skipped, which is the whole point of
the review step. Moments you mark yourself are never overwritten by re-analysis.

## Tracks

```bash
reeleel tracks list [--video <id>] [--class <name>]
reeleel tracks update <id> [--class <name>] [--athlete <id>]
                           [--uncertain] [--certain]
reeleel tracks merge <targetId> <sourceId>
reeleel tracks split <id> <frame>
reeleel tracks remove <id>
reeleel tracks clear
```

`merge` fuses two tracks that are really the same object; frames already claimed
by the target win. `split` cuts a track where the tracker swapped identity and
flags the tail as uncertain.

`tracks clear` discards all cached analysis. Moments you marked yourself survive.

## Clips

```bash
reeleel clips list
reeleel clips from-moments [--include-undecided] [--camera <mode>]
reeleel clips add --start <time> --end <time> [--video <id>]
                  [--camera <mode>] [--title <text>]
reeleel clips update <ref> [--start …] [--end …] [--camera <mode>]
                           [--title <text>] [--order <n>]
reeleel clips reorder <ids...>
reeleel clips remove <ref>
reeleel clips render <ref> [--aspect 16:9] [--no-crop]
```

Camera modes: `follow-player`, `follow-action`, `wide`, `follow-ball`
(experimental).

Trimming a clip or changing its camera mode invalidates its previous render, so
you never ship a stale file.

`clips reorder` takes the ids you care about; anything unlisted keeps its
relative order after them.

## Reels and export

```bash
reeleel reel list
reeleel reel create <name> [--aspect 16:9|9:16|1:1] [--clip <id>]
                           [--title-card <text>] [--music <file>]
                           [--no-original-audio]
reeleel reel update <ref> [--name …] [--aspect …] [--clip <id>]
                          [--title-card <text>] [--music <file>]
                          [--original-audio on|off]
reeleel reel add-clips <ref> <ids...>
reeleel reel remove-clips <ref> <ids...>
reeleel reel remove <ref>

reeleel export [ref] [--reel <name>] [--aspect …] [--fps <n>]
                     [--quality low|medium|high] [--output <file>]
                     [--label <text>] [--watermark]

reeleel exports list
reeleel exports remove <id> [--delete-file]
```

Output sizes: `16:9` → 1920×1080, `9:16` → 1080×1920, `1:1` → 1080×1080.

Removing a reel keeps its clips. Removing a clip from a reel keeps the clip.

## Datasets

```bash
reeleel dataset export [ref] [--format coco|yolo|reeleel] [--output <dir>]
                             [--train 0.7] [--val 0.2] [--test 0.1]
                             [--seed <seed>] [--video <id>]
                             [--include-out-of-frame]
reeleel dataset import <path> [ref] [--format coco|yolo|reeleel]
```

**Splits are by video, never by frame.** Adjacent frames are near-duplicates, so
a frame-level split leaks the validation set into training and makes every
metric a lie. The split is a deterministic hash of the video id and the seed, so
re-exporting a dataset is reproducible.

## Models

```bash
reeleel models list [--sport <sport>]
reeleel models add <name> --version <v> --sport <sport>
                          [--file <weights>] [--link]
                          [--architecture <name>] [--runtime <name>]
                          [--license <spdx>] [--classes <list>]
                          [--dataset-version <version>]
reeleel models show <ref>
reeleel models update <ref> [--license <spdx>] [--path <file>] …
reeleel models remove <ref> [--purge]
reeleel models verify <ref>
```

Aliases: `add`→`install`/`register`, `remove`→`uninstall` (plus the usual).

`<ref>` accepts an id, a `name`, or `name@version`. A bare name resolves to the
newest version.

**Record the license.** A FOSS framework does not make its weights
redistributable; `doctor` warns about any model whose license is `unknown`.
`verify` re-checksums the weights and reports if they moved or changed.

## Jobs

```bash
reeleel jobs list [--status <status>] [--limit <n>]
reeleel jobs show <id>
reeleel jobs cancel <id>
reeleel jobs retry <id>
reeleel jobs remove <id>
reeleel jobs prune [--status completed,failed,canceled]
```

Aliases: `show`→`info`/`logs`, `cancel`→`stop`, `prune`→`clean`.

`retry` re-queues a failed or canceled job with its original parameters as a new
job; the original record is kept for history.

## Settings and diagnostics

```bash
reeleel config list
reeleel config get <key>
reeleel config set <key> <value>
reeleel config unset <key>
reeleel config path

reeleel doctor
reeleel sports list
reeleel sports show <id>
```

Useful keys:

| Key | Default | Notes |
| --- | --- | --- |
| `ffmpeg.ffmpeg`, `ffmpeg.ffprobe` | `null` | Explicit binary paths when they are not on `PATH` |
| `analysis.preset` | `balanced` | Default for `analyze` |
| `analysis.backend` | `auto` | `cpu`, `cuda`, `rocm`, `coreml`, `directml` |
| `projects.dir` | `~/ReelEel` | Where `project create` puts new projects |
| `projects.copySource` | `false` | Copy imported media instead of referencing it |
| `export.aspect`, `export.fps`, `export.quality` | `16:9`, `30`, `high` | Export defaults |
| `privacy.telemetry` | `false` | There is none; the switch exists so it stays off |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `REELEEL_PROJECT` | Default project reference |
| `REELEEL_HOME` | Override config/data/cache root (tests and portable installs) |
| `REELEEL_FFMPEG`, `REELEEL_FFPROBE` | Explicit binary paths |
| `REELEEL_DB_URL`, `REELEEL_DB_AUTH_TOKEN` | Turso for the machine-wide registry |
| `REELEEL_DB_REPLICA_PATH`, `REELEEL_DB_SYNC_INTERVAL` | Embedded replica tuning |
| `REELEEL_CV_WORKER`, `REELEEL_PYTHON` | Locate the CV worker |
| `REELEEL_DEBUG=1` | Print stack traces on unexpected errors |

## Scripting

`--json` prints one JSON object and nothing else. Errors go to stderr with a
stable `code`, and the exit status is non-zero:

```bash
reeleel --json moments list | jq '.moments[] | select(.score > 0.8) | .id'

# accept everything above 0.8
for id in $(reeleel --json moments list | jq -r '.moments[] | select(.score > .8) | .id'); do
  reeleel --quiet moments update "$id" --include
done
```

Error codes you can branch on include `PROJECT_NOT_FOUND`, `FFMPEG_MISSING`,
`SOURCE_MISSING`, `MEDIA_UNSUPPORTED`, `WORKER_MISSING`, `MODEL_MISSING`,
`CONFLICT` and `INVALID_INPUT`.
