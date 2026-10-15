"""Exports the image a task's verification ran on from E2B, Daytona or Vercel.

Each starts one sandbox from the template, snapshot or image verification recorded, with the run's
own credentials, packs its root filesystem into a gzipped tar there, downloads that, and hands the
uncompressed stream to selfbench_export.push_image. None of these providers streams a command's
binary output, so the archive goes through a file; it is excluded from itself.
"""

from __future__ import annotations

import os
import tempfile
import zlib

from selfbench_export import LayerUpload, push_image

ARCHIVE = "/tmp/selfbench-rootfs.tar.gz"
SANDBOX_LIFETIME_SECS = 2 * 60 * 60
CHUNK = 1024 * 1024
# Tar's 1 means a file changed while it was read, which an idle sandbox does not care about.
PACK = (
    "tar --one-file-system --numeric-owner -C / -cf - --exclude=./proc --exclude=./sys "
    f"--exclude=./dev --exclude=.{ARCHIVE} . | gzip -1 > {ARCHIVE}; "
    't=${PIPESTATUS[0]}; g=${PIPESTATUS[1]}; '
    '[ "$g" = 0 ] && { [ "$t" = 0 ] || [ "$t" = 1 ]; } || { echo "tar $t gzip $g" >&2; exit 1; }'
)


class Gunzip:
    """Feeds a downloaded gzip stream to the layer uncompressed, as tar wrote it."""

    def __init__(self, layer: LayerUpload):
        self.layer = layer
        self.decompressor = zlib.decompressobj(31)

    async def write(self, chunk: bytes) -> None:
        if chunk:
            await self.layer.write(self.decompressor.decompress(chunk))

    async def close(self) -> None:
        await self.layer.write(self.decompressor.flush())
        if not self.decompressor.eof:
            raise RuntimeError("the downloaded archive ended early")


async def stream_e2b(template: str, layer: LayerUpload) -> None:
    from e2b import AsyncSandbox

    sandbox = await AsyncSandbox.create(template=template, timeout=SANDBOX_LIFETIME_SECS)
    try:
        await sandbox.commands.run(f"bash -c {quote(PACK)}", user="root", timeout=0)
        output = Gunzip(layer)
        stream = await sandbox.files.read(ARCHIVE, format="stream", user="root", request_timeout=0)
        async for chunk in stream:
            await output.write(chunk)
        await output.close()
    finally:
        await sandbox.kill()


async def stream_daytona(snapshot: str, layer: LayerUpload) -> None:
    from daytona import AsyncDaytona, CreateSandboxFromSnapshotParams

    daytona = AsyncDaytona()
    try:
        sandbox = await daytona.create(
            CreateSandboxFromSnapshotParams(snapshot=snapshot), timeout=SANDBOX_LIFETIME_SECS
        )
        try:
            result = await sandbox.process.exec(
                f"bash -c {quote(PACK)}", timeout=SANDBOX_LIFETIME_SECS
            )
            if result.exit_code != 0:
                raise RuntimeError(f"packing the filesystem failed: {result.result[-2000:]}")
            # Daytona downloads to a path, so the archive lands on the worker's disk first.
            with tempfile.TemporaryDirectory(prefix="selfbench-export-") as root:
                local = os.path.join(root, "rootfs.tar.gz")
                await sandbox.fs.download_file(ARCHIVE, local, SANDBOX_LIFETIME_SECS)
                output = Gunzip(layer)
                with open(local, "rb") as archive:
                    while chunk := archive.read(CHUNK):
                        await output.write(chunk)
                await output.close()
        finally:
            await sandbox.delete()
    finally:
        await daytona.close()


async def stream_vercel(image: str, layer: LayerUpload) -> None:
    from harbor.environments.vercel.vcr import resolve_vcr_scope
    from vercel.sandbox import create_sandbox

    scope = await resolve_vcr_scope()
    sandbox = await create_sandbox(
        image=image, project_id=scope.project_id, execution_time_limit=SANDBOX_LIFETIME_SECS
    )
    try:
        result = await sandbox.run_process(
            "bash", ["-c", PACK], sudo=True, capture_output=True, kill_after=SANDBOX_LIFETIME_SECS
        )
        if result.returncode != 0:
            raise RuntimeError(f"packing the filesystem failed: {(result.stderr or '')[-2000:]}")
        output = Gunzip(layer)
        async with sandbox.fs.open(ARCHIVE, "rb") as reader:
            while chunk := await reader.read(CHUNK):
                await output.write(chunk)
        await output.close()
    finally:
        await sandbox.destroy()


STREAMS = {"e2b": stream_e2b, "daytona": stream_daytona, "vercel": stream_vercel}


def quote(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


async def export_sandbox(provider: str, image: str, name: str) -> str:
    stream = STREAMS.get(provider)
    if stream is None:
        raise ValueError(f"{provider} images cannot be exported")
    return await push_image(name, lambda layer: stream(image, layer), f"{provider} image {image}")
