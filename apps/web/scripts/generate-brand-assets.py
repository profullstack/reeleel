"""
Derives the web assets in public/ from the two source PNGs in static/.

Run with any Python that has Pillow:

    python3 apps/web/scripts/generate-brand-assets.py

The outputs are committed, so this only needs running when the artwork changes.

Both sources are ~1.9MB and 1536x1024 with real transparency. Shipping either
of them as a header logo would mean sending two megabytes to render something
40 pixels tall, so each output is trimmed to its visible content and sized for
exactly one job.

Pillow rather than @profullstack/favicon-generator: that tool takes SVG input
and these are PNG.
"""

import pathlib

from PIL import Image

SRC = pathlib.Path(__file__).resolve().parents[3] / "static"
OUT = pathlib.Path(__file__).resolve().parents[1] / "public"
OUT.mkdir(parents=True, exist_ok=True)


def trimmed(name: str) -> Image.Image:
    """The artwork with its empty margin removed, so sizes mean what they say."""
    im = Image.open(SRC / name).convert("RGBA")
    box = im.getchannel("A").getbbox()
    return im.crop(box) if box else im


def save(im: Image.Image, name: str) -> None:
    im.save(OUT / name, "PNG", optimize=True)
    print(f"  {name:24s} {im.size[0]:4d}x{im.size[1]:<4d} {(OUT / name).stat().st_size // 1024:5d} KB")


print("logo (wordmark, for the header):")
logo = trimmed("logo.png")
# The mark is mascot-over-wordmark at roughly 1.4:1, so it needs real height to
# stay legible — a 40px-tall version renders the word at about eight pixels.
for height, name in ((96, "logo.png"), (192, "logo@2x.png")):
    width = round(logo.width * height / logo.height)
    save(logo.resize((width, height), Image.LANCZOS), name)

print("\nicons (mascot, square):")
mark = trimmed("favicon.png")
# Square canvas rather than a square crop: the mascot is wider than it is tall,
# and cropping to a square would cut the bat off.
side = max(mark.size)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2))

for size, name in (
    (512, "icon-512.png"),
    (192, "icon-192.png"),
    (180, "apple-touch-icon.png"),
    (32, "favicon-32.png"),
    (16, "favicon-16.png"),
):
    save(square.resize((size, size), Image.LANCZOS), name)

# A multi-resolution .ico so /favicon.ico — which browsers request whether or
# not it is linked — is the mascot rather than a 404.
ico = OUT / "favicon.ico"
square.resize((64, 64), Image.LANCZOS).save(
    ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64)]
)
print(f"  {'favicon.ico':24s} multi-res  {ico.stat().st_size // 1024:5d} KB")
