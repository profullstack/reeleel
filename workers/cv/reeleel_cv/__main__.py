"""ReelEel CV worker entry point.

Speaks the protocol documented in ../README.md. Detection and tracking are not
implemented yet (PRD phase 3); this module exists so the TypeScript side can be
built and tested against a stable interface, and so a missing model produces an
actionable message instead of a stack trace.
"""

from __future__ import annotations

import argparse
import json
import sys


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="reeleel-cv", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    detect = sub.add_parser(
        "detect-and-track",
        help="run detection and multi-object tracking over one video",
    )
    detect.add_argument("--input", required=True, help="video file to analyze")
    detect.add_argument("--sport", default="soccer")
    detect.add_argument("--classes", default="", help="comma-separated class names")
    detect.add_argument("--frame-stride", type=int, default=2)
    detect.add_argument("--inference-size", type=int, default=768)
    detect.add_argument("--min-confidence", type=float, default=0.3)
    detect.add_argument("--tracker", default="bytetrack")
    detect.add_argument("--backend", default="auto")
    detect.add_argument("--json", action="store_true", help="emit JSON on stdout")

    sub.add_parser("capabilities", help="report what this worker can do")
    return parser


def capabilities() -> dict:
    """What the host can rely on. Kept honest as the worker gains features."""
    return {
        "version": "0.1.0",
        "implemented": False,
        "backends": ["cpu"],
        "trackers": ["bytetrack"],
        "sports": ["soccer"],
    }


def detect_and_track(args: argparse.Namespace) -> dict:
    # Detection needs a registered model; there is no bundled one yet, and
    # inventing tracks would be worse than saying so.
    return {
        "error": (
            "The ReelEel CV worker has no detection model installed, so "
            f"{args.input!r} cannot be analyzed yet. Register one with "
            "`reeleel models add <name> --version <v> --sport "
            f"{args.sport} --file <weights> --license <spdx>`. "
            "Import, review, trim and export work without it."
        )
    }


def main() -> int:
    args = build_parser().parse_args()

    if args.command == "capabilities":
        json.dump(capabilities(), sys.stdout)
        sys.stdout.write("\n")
        return 0

    result = detect_and_track(args)
    # Data on stdout, progress and diagnostics on stderr — the host parses
    # stdout as a single JSON object.
    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
