#!/usr/bin/env python3
"""Verify a wheel contains the review HTML and every local asset it references."""

from __future__ import annotations

import re
import sys
import zipfile
from pathlib import PurePosixPath


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-wheel-review-assets.py DIST.whl")
    with zipfile.ZipFile(sys.argv[1]) as wheel:
        names = set(wheel.namelist())
        index_path = "selfbench/review_dist/index.html"
        if index_path not in names:
            raise SystemExit(f"missing {index_path}")
        html = wheel.read(index_path).decode("utf-8")
        references = re.findall(r'''(?:src|href)=["']([^"']+)["']''', html)
        missing = []
        for reference in references:
            if reference.startswith(("http://", "https://", "data:", "#")):
                continue
            relative = reference.lstrip("/")
            packaged = str(PurePosixPath("selfbench/review_dist") / relative)
            if packaged not in names:
                missing.append(packaged)
        if missing:
            raise SystemExit("missing referenced review asset(s): " + ", ".join(sorted(missing)))
    print(f"verified packaged review assets in {sys.argv[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
