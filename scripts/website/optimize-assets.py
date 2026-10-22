#!/usr/bin/env python3
"""Regenerate responsive site images; requires Pillow only for asset authoring."""
from pathlib import Path

from PIL import Image

ASSETS = Path(__file__).resolve().parents[2] / "docs" / "assets"
for name in ["still-01-youtube", "still-02-switches", "still-03-sync"]:
    with Image.open(ASSETS / "screens" / f"{name}.jpg") as image:
        for width in [480, 800, 1280]:
            resized = image.resize(
                (width, round(image.height * width / image.width)),
                Image.Resampling.LANCZOS,
            )
            resized.save(
                ASSETS / "screens" / f"{name}-{width}.webp", quality=90, method=6
            )
