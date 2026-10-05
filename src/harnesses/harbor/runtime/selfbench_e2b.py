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

Harbor starts every sandbox with a 24-hour lifetime, which E2B's Hobby plan refuses ("400: Timeout
cannot be greater than 1 hours"), so no trial could start on a Hobby key, and a sandbox whose
trial stopped without cleaning up ran for a day. Here a sandbox lives as long as the longest
Harbor process, or as long as the account's plan allows when that is shorter; on a Hobby key a
trial that runs past the hour loses its sandbox. Harbor creates the sandbox through the
``AsyncSandbox`` its E2B module imported, so that name is pointed at ``PlanLimitedSandbox`` and
every other argument Harbor passes stays Harbor's.
"""

from __future__ import annotations

import logging
import os
import re
import shlex

import httpx
from e2b import (
    AsyncSandbox,
    AsyncTemplate,
    BuildException,
    BuildInfo,
    SandboxException,
    Template,
    TemplateBuildStatus,
)

import harbor.environments.e2b as harbor_e2b
from harbor.environments.e2b import E2BEnvironment

TAG = "default"
# No Harbor process outlives the 3-hour gate cap (HARBOR_PROCESS_TIMEOUT_MS) or a solver trial
# with the most agent minutes (trialTimeouts, under 3 hours).
SANDBOX_LIFETIME_SECS = 3 * 60 * 60
PLAN_LIMIT = re.compile(r"Timeout cannot be greater than (\d+) hours?")
IMAGE_ENV = "/etc/profile.d/selfbench-image-env.sh"
MANIFEST_TYPES = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


class PlanLimitedSandbox(AsyncSandbox):
    """E2B's sandbox, created with SelfBench's lifetime in place of the one Harbor asks for."""

    lifetime_secs = SANDBOX_LIFETIME_SECS

    @classmethod
    async def create(cls, *args, **kwargs):
        try:
            return await super().create(*args, **{**kwargs, "timeout": cls.lifetime_secs})
        except SandboxException as error:
            limit = PLAN_LIMIT.search(str(error))
            hours = int(limit[1]) if limit else 0
            refused = getattr(error, "status_code", None) == 400
            if not refused or not 0 < hours * 60 * 60 < cls.lifetime_secs:
                raise
            # The process's later sandboxes (a separate verifier's) start at the limit at once.
            PlanLimitedSandbox.lifetime_secs = hours * 60 * 60
            logging.getLogger(__name__).warning(
                f"The E2B plan allows sandboxes {hours}h; a trial running longer loses its sandbox"
            )
            return await super().create(*args, **{**kwargs, "timeout": cls.lifetime_secs})


harbor_e2b.AsyncSandbox = PlanLimitedSandbox


class SelfBenchE2BEnvironment(E2BEnvironment):
    async def _does_template_exist(self) -> bool:
        if not await super()._does_template_exist():
            return False
        name = self._template_name
        tags = await AsyncTemplate.get_tags(name)
        build = next((tag.build_id for tag in tags if tag.tag == TAG), None)
        if build is None:
            return False
        try:
            status = (
                await AsyncTemplate.get_build_status(
                    BuildInfo(template_id=name, build_id=build, name=name, alias=name, tags=[TAG])
                )
            ).status
        except BuildException as error:
            if str(error) != f"400: Build '{build}' not found":
                raise
            self.logger.warning(f"Template {name} build {build} is missing; building it again")
            return False
        if status == TemplateBuildStatus.READY:
            return True
        self.logger.warning(f"Template {name} build {build} is {status.value}; building it again")
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
