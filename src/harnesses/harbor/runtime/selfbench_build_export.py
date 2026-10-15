"""Build an OCI image in the isolated platform builder, before provider verification.

The cloud registry token stays in the worker/exporter. Neither Dockerfile instructions nor
sandbox commands receive it. Verification still runs on the run's selected provider.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from modal import App, Image
from selfbench_export import export


async def build(context: str, name: str) -> str:
    directory = Path(context)
    app = await App.lookup.aio(name="__harbor__", create_if_missing=True)
    image = Image.from_dockerfile(directory / "Dockerfile", context_dir=directory)
    await image.build.aio(app)
    return await export(image.object_id, name)


if __name__ == "__main__":
    print(asyncio.run(build(*sys.argv[1:3])), flush=True)
