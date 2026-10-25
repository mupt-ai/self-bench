"""Exports the image a task's verification ran on from E2B, Daytona or Vercel.

Each starts one sandbox from the template, snapshot or image verification recorded, with the run's
own credentials, packs its root filesystem into a gzipped tar there, downloads that, and hands the
gzip stream to selfbench_export.push_image as the layer blob itself: the worker only inflates it to
hash the tar, and never compresses it again. None of these providers streams a command's binary
output, so the archive goes through a file; it is excluded from itself.
"""

from __future__ import annotations

import os
import tempfile
import time

from selfbench_export import LayerUpload, push_image

ARCHIVE = "/tmp/selfbench-rootfs.tar.gz"
SANDBOX_LIFETIME_SECS = 2 * 60 * 60
E2B_LIFETIME_SECS = 60 * 60
CHUNK = 1024 * 1024
# Tar's 1 means a file changed while it was read, which an idle sandbox does not care about.
PACK = (
    "tar --one-file-system --numeric-owner -C / -cf - --exclude=./proc --exclude=./sys "
    f"--exclude=./dev --exclude=.{ARCHIVE} . | gzip -1 > {ARCHIVE}; "
    # One assignment: any command, even `t=…`, resets PIPESTATUS for the next.
    's=("${PIPESTATUS[@]}"); '
    '[ "${s[1]}" = 0 ] && { [ "${s[0]}" = 0 ] || [ "${s[0]}" = 1 ]; } '
    '|| { echo "tar ${s[0]} gzip ${s[1]}" >&2; exit 1; }'
)


async def stream_e2b(template: str, layer: LayerUpload) -> None:
    from e2b import AsyncSandbox

    # E2B's Hobby plan refuses sandboxes past an hour; one pack and download fits well inside it.
    # Over HTTP/2, envd sends a file as many small DATA frames, which the h2 client in the SDK
    # (pyqwest, from h2 0.4.16) ends a few MB in as too_many_data_frames; HTTP/1.1 has no frames.
    started = time.monotonic()
    sandbox = await AsyncSandbox.create(
        template=template, timeout=E2B_LIFETIME_SECS, http_version="1.1"
    )
    try:
        await sandbox.commands.run(f"bash -c {quote(PACK)}", user="root", timeout=0)
        try:
            stream = await sandbox.files.read(
                ARCHIVE, format="stream", user="root", request_timeout=0
            )
            async for chunk in stream:
                await layer.write_gzipped(chunk)
        except Exception as error:
            # E2B ends the sandbox at its lifetime, which reaches a download only as a reset.
            if time.monotonic() - started >= E2B_LIFETIME_SECS - 60:
                raise RuntimeError(
                    "the E2B sandbox reached its one-hour lifetime before the export downloaded"
                ) from error
            raise
    finally:
        await sandbox.kill()


async def stream_daytona(snapshot: str, layer: LayerUpload) -> None:
    from daytona import AsyncDaytona, CreateSandboxFromSnapshotParams

    daytona = AsyncDaytona()
    try:
        # As root, so a Dockerfile USER cannot hide part of the tree, and never auto-stopped,
        # since it sits idle while the archive downloads; the finally below deletes it.
        sandbox = await daytona.create(
            CreateSandboxFromSnapshotParams(snapshot=snapshot, os_user="root", auto_stop_interval=0),
            timeout=SANDBOX_LIFETIME_SECS,
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
                with open(local, "rb") as archive:
                    while chunk := archive.read(CHUNK):
                        await layer.write_gzipped(chunk)
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
        async with sandbox.fs.open(ARCHIVE, "rb") as reader:
            while chunk := await reader.read(CHUNK):
                await layer.write_gzipped(chunk)
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
