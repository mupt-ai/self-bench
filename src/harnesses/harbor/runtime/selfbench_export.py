"""Exports one image a task's verification ran on into SelfBench's task repository.

    python selfbench_export.py <modal image id> <image name>
    python selfbench_export.py <modal|e2b|daytona|vercel> <provider image> <image name>

A provider's verified image cannot be pulled, so this starts a sandbox from it with the run's own
credentials, streams its root filesystem out as one gzipped tar layer (hashed on the way), and
pushes that layer with an image config and manifest to the repository, by digest and untagged so it
can be deleted with its task, so every other provider can start from exactly what passed. Modal
streams the tar directly and it is gzipped here; the others gzip it in the sandbox and their bytes
are the layer blob as downloaded (selfbench_sandbox_export.py). The
environment carries where and how:

- SELFBENCH_EXPORT_REGISTRY: the repository's registry API, `https://<host>/v2/<path>`
- SELFBENCH_EXPORT_TOKEN_FILE: a file holding an access token that may push there (Artifact
  Registry's Basic login), reread before each request because the worker refreshes it
- SELFBENCH_EXPORT_CONFIG: the image config (Env, User, WorkingDir) as JSON; a running sandbox's
  environment carries Modal's own variables, so the worker derives it from the Dockerfile

Prints the pushed manifest's digest.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import queue
import sys
import urllib.parse
import urllib.request
import zlib

from modal import App, Image, Sandbox

# Kernel filesystems and Modal's own mount; --one-file-system already keeps other mounts out.
EXCLUDES = ["./proc", "./sys", "./dev", "./__modal"]
SANDBOX_LIFETIME_SECS = 2 * 60 * 60


class Registry:
    def __init__(self, api: str, token_file: str):
        parsed = urllib.parse.urlsplit(api)
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.path = parsed.path.rstrip("/")
        self.token_file = token_file

    def authorization(self) -> str:
        # The worker keeps the file fresh; an export outlives one access token.
        with open(self.token_file) as file:
            token = file.read().strip()
        login = base64.b64encode(f"oauth2accesstoken:{token}".encode()).decode()
        return f"Basic {login}"

    def request(self, method: str, url: str, body=b"", headers: dict | None = None):
        # A generator body is sent with chunked transfer encoding.
        absolute = urllib.parse.urljoin(self.origin + "/", url)
        request = urllib.request.Request(
            absolute,
            data=body,
            method=method,
            headers={"Authorization": self.authorization(), **(headers or {})},
        )
        with urllib.request.urlopen(request, timeout=600) as response:
            return response.status, dict(response.headers), response.read()

    def start_upload(self, name: str) -> str:
        _, headers, _ = self.request("POST", f"{self.path}/{name}/blobs/uploads/")
        return headers["Location"]

    def finish_upload(self, location: str, digest: str, body: bytes = b"") -> None:
        separator = "&" if "?" in location else "?"
        self.request(
            "PUT",
            f"{location}{separator}digest={urllib.parse.quote(digest)}",
            body,
            {"Content-Type": "application/octet-stream"},
        )

    def push_blob(self, name: str, body: bytes) -> str:
        digest = f"sha256:{hashlib.sha256(body).hexdigest()}"
        self.finish_upload(self.start_upload(name), digest, body)
        return digest


class LayerUpload:
    """Streams one gzipped tar layer into a blob upload, hashing both sides for the image.

    A layer's digest is the sha256 of its gzipped bytes and its diff_id that of the tar inside.
    `write` takes the tar and gzips it here, at level 1 like `gzip -1` in the other providers'
    sandboxes; `write_gzipped` takes a sandbox's own gzip stream, uploads it as it is, and only
    inflates it to hash the tar, far cheaper on the worker's CPU than compressing it again.

    Artifact Registry takes a blob in a single PATCH (as `docker push` sends it), so a thread
    streams the request body from a bounded queue while the sandbox's tar is read. The upload
    opens only with the first bytes: packing a large sandbox first can outlast the request's
    idle timeout.
    """

    def __init__(self, registry: Registry, name: str):
        self.registry = registry
        self.name = name
        self.compressor: zlib._Compress | None = None
        self.decompressor: zlib._Decompress | None = None
        self.raw = hashlib.sha256()
        self.gzipped = hashlib.sha256()
        self.size = 0
        self.chunks: queue.Queue[bytes | None] = queue.Queue(maxsize=8)
        self.upload: asyncio.Future[str] | None = None

    def _open(self) -> asyncio.Future[str]:
        if self.upload is None:
            self.location = self.registry.start_upload(self.name)
            self.upload = asyncio.ensure_future(asyncio.to_thread(self._patch))
        return self.upload

    def _body(self):
        while (chunk := self.chunks.get()) is not None:
            yield chunk

    def _patch(self) -> str:
        _, headers, _ = self.registry.request(
            "PATCH", self.location, self._body(), {"Content-Type": "application/octet-stream"}
        )
        return headers.get("Location", self.location)

    async def _queue(self, chunk: bytes | None) -> None:
        upload = self._open()
        while True:
            if upload.done():
                upload.result()
                raise RuntimeError("the layer upload ended before the layer did")
            try:
                await asyncio.to_thread(self.chunks.put, chunk, True, 5)
                return
            except queue.Full:
                continue

    async def write(self, data: bytes) -> None:
        if self.decompressor is not None:
            raise RuntimeError("a layer takes either a tar or a gzip stream")
        if self.compressor is None:
            self.compressor = zlib.compressobj(1, zlib.DEFLATED, 31)
        self.raw.update(data)
        await self._send(self.compressor.compress(data))

    async def write_gzipped(self, data: bytes) -> None:
        if self.compressor is not None:
            raise RuntimeError("a layer takes either a tar or a gzip stream")
        if self.decompressor is None:
            self.decompressor = zlib.decompressobj(31)
        if not data:
            return
        if self.decompressor.eof:
            # A second gzip member would be a different layer than its diff_id describes.
            raise RuntimeError("the downloaded archive continues past its end")
        self.raw.update(self.decompressor.decompress(data))
        if self.decompressor.unused_data:
            raise RuntimeError("the downloaded archive continues past its end")
        await self._send(data)

    async def _send(self, data: bytes) -> None:
        if data:
            self.gzipped.update(data)
            self.size += len(data)
            await self._queue(data)

    def abort(self) -> None:
        """Ends the request body early so the upload thread returns and the process can exit."""
        if self.upload is None:
            return
        while True:
            try:
                self.chunks.put_nowait(None)
                return
            except queue.Full:
                try:
                    self.chunks.get_nowait()
                except queue.Empty:
                    pass

    async def finish(self) -> tuple[str, str, int]:
        if self.compressor is not None:
            await self._send(self.compressor.flush())
        elif self.decompressor is not None:
            self.raw.update(self.decompressor.flush())
            if not self.decompressor.eof:
                raise RuntimeError("the downloaded archive ended early")
        else:
            # An empty stream is no filesystem; pushing it would make an image of nothing.
            raise RuntimeError("the export produced no layer")
        await self._queue(None)
        location = await self._open()
        digest = f"sha256:{self.gzipped.hexdigest()}"
        self.registry.finish_upload(location, digest)
        return digest, f"sha256:{self.raw.hexdigest()}", self.size


async def stream_root(sandbox, layer: LayerUpload) -> None:
    excludes = [f"--exclude={path}" for path in EXCLUDES]
    process = await sandbox.exec.aio(
        "tar", "--one-file-system", "--numeric-owner", "-C", "/", "-cf", "-", *excludes, ".",
        text=False,
    )
    async for chunk in process.stdout:
        await layer.write(chunk)
    code = await process.wait.aio()
    # 1 means a file changed while it was read, which an idle sandbox does not care about.
    if code not in (0, 1):
        error = await process.stderr.read.aio()
        raise RuntimeError(f"tar exited {code}: {error[-2000:]!r}")


async def export(image_id: str, name: str) -> str:
    async def stream_modal(layer: LayerUpload) -> None:
        # Harbor's Modal environment builds in its default app, so its images live there.
        app = await App.lookup.aio(name="__harbor__", create_if_missing=True)
        sandbox = await Sandbox.create.aio(
            "sleep", "infinity", app=app, image=Image.from_id(image_id), timeout=SANDBOX_LIFETIME_SECS
        )
        try:
            await stream_root(sandbox, layer)
        finally:
            await sandbox.terminate.aio()

    return await push_image(name, stream_modal, f"Modal image {image_id}")


async def push_image(name: str, stream, source: str) -> str:
    """Pushes the root filesystem `stream` writes into a LayerUpload as a one-layer image."""
    registry = Registry(
        os.environ["SELFBENCH_EXPORT_REGISTRY"], os.environ["SELFBENCH_EXPORT_TOKEN_FILE"]
    )
    config = json.loads(os.environ["SELFBENCH_EXPORT_CONFIG"])
    layer = LayerUpload(registry, name)
    try:
        await stream(layer)
        layer_digest, diff_id, layer_size = await layer.finish()
    except BaseException:
        layer.abort()
        raise
    image_config = json.dumps(
        {
            "architecture": "amd64",
            "os": "linux",
            "config": config,
            "rootfs": {"type": "layers", "diff_ids": [diff_id]},
            "history": [{"created_by": f"SelfBench export of {source}"}],
        },
        separators=(",", ":"),
    ).encode()
    config_digest = registry.push_blob(name, image_config)
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": config_digest,
                "size": len(image_config),
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": layer_digest,
                    "size": layer_size,
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    digest = f"sha256:{hashlib.sha256(manifest).hexdigest()}"
    registry.request(
        "PUT",
        f"{registry.path}/{name}/manifests/{digest}",
        manifest,
        {"Content-Type": "application/vnd.oci.image.manifest.v1+json"},
    )
    return digest


if __name__ == "__main__":
    if len(sys.argv) == 3 or sys.argv[1] == "modal":
        image, name = sys.argv[-2:]
        print(asyncio.run(export(image, name)), flush=True)
    else:
        from selfbench_sandbox_export import export_sandbox

        print(asyncio.run(export_sandbox(*sys.argv[1:4])), flush=True)
