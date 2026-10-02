"""Exports one image a task's verification ran on, from Modal, into SelfBench's task repository.

    python selfbench_export.py <modal image id> <image name>

A Modal image cannot be pulled, so this starts a sandbox from it, streams its root filesystem out
as one tar layer (gzipped and hashed on the way), and pushes that layer with an image config and
manifest to the repository, by digest and untagged so it can be deleted with its task, so every
other provider can start from exactly what passed. The environment carries where and how:

- SELFBENCH_EXPORT_REGISTRY: the repository's registry API, `https://<host>/v2/<path>`
- SELFBENCH_EXPORT_TOKEN: an access token that may push there (Artifact Registry's Basic login)
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
    def __init__(self, api: str, token: str):
        parsed = urllib.parse.urlsplit(api)
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.path = parsed.path.rstrip("/")
        login = base64.b64encode(f"oauth2accesstoken:{token}".encode()).decode()
        self.headers = {"Authorization": f"Basic {login}"}

    def request(self, method: str, url: str, body=b"", headers: dict | None = None):
        # A generator body is sent with chunked transfer encoding.
        absolute = urllib.parse.urljoin(self.origin + "/", url)
        request = urllib.request.Request(
            absolute, data=body, method=method, headers={**self.headers, **(headers or {})}
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
    """Gzips a tar stream into one streamed blob upload, hashing both sides for the image.

    Artifact Registry takes a blob in a single PATCH (as `docker push` sends it), so a thread
    streams the request body from a bounded queue while the sandbox's tar is read.
    """

    def __init__(self, registry: Registry, name: str):
        self.registry = registry
        self.location = registry.start_upload(name)
        self.compressor = zlib.compressobj(6, zlib.DEFLATED, 31)
        self.raw = hashlib.sha256()
        self.gzipped = hashlib.sha256()
        self.size = 0
        self.chunks: queue.Queue[bytes | None] = queue.Queue(maxsize=8)
        self.upload = asyncio.ensure_future(asyncio.to_thread(self._patch))

    def _body(self):
        while (chunk := self.chunks.get()) is not None:
            yield chunk

    def _patch(self) -> str:
        _, headers, _ = self.registry.request(
            "PATCH", self.location, self._body(), {"Content-Type": "application/octet-stream"}
        )
        return headers.get("Location", self.location)

    async def _queue(self, chunk: bytes | None) -> None:
        while True:
            if self.upload.done():
                self.upload.result()
                raise RuntimeError("the layer upload ended before the layer did")
            try:
                await asyncio.to_thread(self.chunks.put, chunk, True, 5)
                return
            except queue.Full:
                continue

    async def write(self, data: bytes) -> None:
        self.raw.update(data)
        await self._send(self.compressor.compress(data))

    async def _send(self, data: bytes) -> None:
        if data:
            self.gzipped.update(data)
            self.size += len(data)
            await self._queue(data)

    async def finish(self) -> tuple[str, str, int]:
        await self._send(self.compressor.flush())
        await self._queue(None)
        location = await self.upload
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
    registry = Registry(os.environ["SELFBENCH_EXPORT_REGISTRY"], os.environ["SELFBENCH_EXPORT_TOKEN"])
    config = json.loads(os.environ["SELFBENCH_EXPORT_CONFIG"])
    # Harbor's Modal environment builds in its default app, so its images live there.
    app = await App.lookup.aio(name="__harbor__", create_if_missing=True)
    sandbox = await Sandbox.create.aio(
        "sleep", "infinity", app=app, image=Image.from_id(image_id), timeout=SANDBOX_LIFETIME_SECS
    )
    try:
        layer = LayerUpload(registry, name)
        await stream_root(sandbox, layer)
        layer_digest, diff_id, layer_size = await layer.finish()
    finally:
        await sandbox.terminate.aio()
    image_config = json.dumps(
        {
            "architecture": "amd64",
            "os": "linux",
            "config": config,
            "rootfs": {"type": "layers", "diff_ids": [diff_id]},
            "history": [{"created_by": f"SelfBench export of Modal image {image_id}"}],
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
    print(asyncio.run(export(*sys.argv[1:3])), flush=True)
