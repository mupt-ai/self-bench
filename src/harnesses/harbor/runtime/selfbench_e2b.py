"""Harbor's E2B environment, rebuilding a template whose last build never became ready.

Harbor names a task's template after its environment's content hash and builds it only when no
template has that name. E2B registers the name, and points its ``default`` tag at the new build,
as soon as a build is requested, so a build that failed or was cut off left a name with no usable
build: every later trial skipped the build and failed to start with "404: tag 'default' does not
exist". Here a template counts as existing only when its ``default`` build is ready; otherwise it
is built again under the same name, which moves the tag to the new build.

A task whose images SelfBench built into its registry gets them as Harbor's `docker_image`,
served by the API's registry endpoint; its template is made from that image with the run's pull
grant (SELFBENCH_REGISTRY_*), which Harbor's own E2B environment does not pass. E2B keeps an
image's files but not its config, and its commands run in login shells that reset PATH, so the
image's ENV goes into /etc/profile.d and its USER and WORKDIR onto the template. Harbor's content
hash covers `docker_image`, so the template is named after the image.
"""

from __future__ import annotations

import os
import shlex

import httpx
from e2b import AsyncTemplate, BuildInfo, Template, TemplateBuildStatus

from harbor.environments.e2b import E2BEnvironment

TAG = "default"
IMAGE_ENV = "/etc/profile.d/selfbench-image-env.sh"
MANIFEST_TYPES = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


class SelfBenchE2BEnvironment(E2BEnvironment):
    async def _does_template_exist(self) -> bool:
        if not await super()._does_template_exist():
            return False
        name = self._template_name
        tags = await AsyncTemplate.get_tags(name)
        build = next((tag.build_id for tag in tags if tag.tag == TAG), None)
        if build is None:
            return False
        status = await AsyncTemplate.get_build_status(
            BuildInfo(template_id=name, build_id=build, name=name, alias=name, tags=[TAG])
        )
        if status.status == TemplateBuildStatus.READY:
            return True
        self.logger.warning(f"Template {name} build {build} is {status.status.value}; building it again")
        return False

    async def _create_template(self):
        image = self.task_env_config.docker_image
        host = os.environ.get("SELFBENCH_REGISTRY_HOST")
        password = os.environ.get("SELFBENCH_REGISTRY_PASSWORD")
        if not image or not host or not password or not image.startswith(f"{host}/"):
            return await super()._create_template()
        username = os.environ.get("SELFBENCH_REGISTRY_USERNAME", "selfbench")
        config = await image_config(image, username, password)
        template = Template().from_image(image=image, username=username, password=password)
        envs = [entry.split("=", 1) for entry in config.get("Env") or [] if "=" in entry]
        if envs:
            script = "".join(f"export {name}={shlex.quote(value)}\n" for name, value in envs)
            template = template.run_cmd(
                f"printf %s {shlex.quote(script)} > {IMAGE_ENV}", user="root"
            )
        if config.get("User"):
            template = template.set_user(config["User"])
        if config.get("WorkingDir"):
            template = template.set_workdir(config["WorkingDir"])
        resources = {"cpu_count": self._effective_cpus, "memory_mb": self._effective_memory_mb}
        await AsyncTemplate.build(
            template=template,
            alias=self._template_name,
            **{key: value for key, value in resources.items() if value is not None},
        )


async def image_config(image: str, username: str, password: str) -> dict:
    """The linux/amd64 config (Env, User, WorkingDir, ...) of `host/name@sha256:...`."""
    host, reference = image.split("/", 1)
    name, digest = reference.split("@", 1)
    async with httpx.AsyncClient(
        base_url=f"https://{host}/v2/{name}",
        auth=(username, password),
        follow_redirects=True,
        timeout=60,
    ) as client:

        async def manifest(at: str) -> dict:
            response = await client.get(f"/manifests/{at}", headers={"accept": MANIFEST_TYPES})
            return response.raise_for_status().json()

        found = await manifest(digest)
        if "manifests" in found:
            platform = next(
                child
                for child in found["manifests"]
                if child.get("platform", {}).get("os") == "linux"
                and child.get("platform", {}).get("architecture") == "amd64"
            )
            found = await manifest(platform["digest"])
        response = await client.get(f"/blobs/{found['config']['digest']}")
        return response.raise_for_status().json().get("config") or {}
