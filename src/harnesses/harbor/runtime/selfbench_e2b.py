"""Harbor's E2B environment, rebuilding a template whose last build never became ready.

Harbor names a task's template after its environment's content hash and builds it only when no
template has that name. E2B registers the name, and points its ``default`` tag at the new build,
as soon as a build is requested, so a build that failed or was cut off left a name with no usable
build: every later trial skipped the build and failed to start with "404: tag 'default' does not
exist". Here a template counts as existing only when its ``default`` build is ready; otherwise it
is built again under the same name, which moves the tag to the new build.

E2B keeps an image's files but not its config, keeps a Dockerfile's ENV for the build only, and
runs commands in login shells that reset PATH. Harbor's own E2B environment leaves it there, so a
task whose tests need its image's PATH, virtualenv or caches could not find them (DeepSWE's
verifiers exited with "missing pytest" and scored -1). Here every template gives its sandboxes the
environment Docker gives a container: the image's ENV, or a Dockerfile's base image ENV followed
by its own, goes into /etc/profile.d. Variables Harbor sets for a sandbox or command still win, as
`docker run -e` does, except PATH, which the login shell has already reset. A `docker_image`'s
USER and WORKDIR go onto the template too. Templates built before this have the same content hash,
so these take a new name. One difference remains: E2B boots the image with systemd before any
build step runs, which empties /tmp, so whatever an image left there is gone.

A task whose images SelfBench built into its registry gets them as Harbor's `docker_image`,
served by the API's registry endpoint; its template is made from that image with the run's pull
grant (SELFBENCH_REGISTRY_*), which Harbor's own E2B environment does not pass. Any other image's
config is read anonymously, as E2B pulls it. Harbor's content hash covers `docker_image`, so the
template is named after the image.

Harbor starts every sandbox with a 24-hour lifetime. E2B's Hobby plan caps sandboxes at an hour
and refuses with "400: Timeout cannot be greater than 1 hours", which left a trial failing with no
hint of what to change; that refusal is reported here as the key's plan being too small. Harbor
creates sandboxes through the ``AsyncSandbox`` its E2B module imported, so that name is pointed at
``PlanCheckedSandbox``, which passes Harbor's arguments through unchanged. E2B also caps a
template's memory at 8 GiB on Hobby, and on Pro until E2B support raises it, refusing a task that
asks for more with "400: Memory can't be higher than 8192 MiB"; that refusal names the plan's
limit and the task's request.

An E2B team runs a limited number of sandboxes and template builds at once, and refuses more with
"429: Rate limit exceeded" ("maximum number of concurrent template builds (20)"). Harbor tried
again once and failed the trial, so an evaluation that started more trials than the key's plan
runs failed most of them in its first minute. Here a refused build, sandbox, or template lookup
waits for a free slot and asks again, backing off from 15 seconds to two minutes. The caller's
own limit still bounds the wait: Harbor's environment start timeout in a trial, the process
timeout in selfbench_prepare.py.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
import shlex
from collections.abc import Awaitable, Callable
from typing import TypeVar

import httpx
from dockerfile_parse import DockerfileParser
from e2b import (
    AsyncSandbox,
    AsyncTemplate,
    BuildException,
    BuildInfo,
    RateLimitException,
    SandboxException,
    Template,
    TemplateBuildStatus,
)

import harbor.environments.e2b as harbor_e2b
from harbor.environments.e2b import E2BEnvironment
from registry_auth import record_image

TAG = "default"
CAPACITY_WAIT_SECS = (15, 120)
PLAN_LIMIT = re.compile(r"Timeout cannot be greater than (\d+) hours?")
MEMORY_LIMIT = re.compile(r"Memory can't be higher than (\d+) MiB")
IMAGE_ENV = "/etc/profile.d/selfbench-image-env.sh"
# Keeps templates built without IMAGE_ENV from being reused.
TEMPLATE_SUFFIX = "__env"
DOCKER_HUB = "registry-1.docker.io"
MANIFEST_TYPES = ", ".join(
    [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ]
)


class PlanCheckedSandbox(AsyncSandbox):
    """E2B's sandbox, whose refusal of Harbor's lifetime names the plan as the cause."""

    @classmethod
    async def create(cls, *args, **kwargs):
        try:
            return await super().create(*args, **kwargs)
        except SandboxException as error:
            limit = PLAN_LIMIT.search(str(error))
            # Older e2b releases leave status_code unset; the message leads with the status.
            refused = getattr(error, "status_code", None) == 400 or str(error).startswith("400:")
            if not refused or not limit:
                raise
            hours = int(limit[1])
            raise SandboxException(
                f"This E2B key's plan allows sandboxes of at most {hours} hour"
                f"{'' if hours == 1 else 's'}, and SelfBench trials run in 24-hour sandboxes. "
                "Use an E2B key on a plan that allows 24-hour sandboxes, such as Pro."
            ) from error


harbor_e2b.AsyncSandbox = PlanCheckedSandbox

T = TypeVar("T")


class SelfBenchE2BEnvironment(E2BEnvironment):
    def __init__(self, *args, image_record_dir: str | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._selfbench_record = image_record_dir
        self._template_name += TEMPLATE_SUFFIX

    def _registry_grant(self) -> tuple[str, str] | None:
        """The run's pull grant, when the task's image is in SelfBench's registry."""
        image = self.task_env_config.docker_image
        host = os.environ.get("SELFBENCH_REGISTRY_HOST")
        password = os.environ.get("SELFBENCH_REGISTRY_PASSWORD")
        if not image or not host or not password or not image.startswith(f"{host}/"):
            return None
        return os.environ.get("SELFBENCH_REGISTRY_USERNAME", "selfbench"), password

    async def start(self, force_build: bool):
        await super().start(force_build)
        # The template verification ran on, which the worker exports once the task is accepted.
        if self._selfbench_record:
            record_image(self._selfbench_record, self.environment_dir, self._template_name)

    async def _when_free(self, what: str, start: Callable[[], Awaitable[T]]) -> T:
        """Runs `start`, waiting while E2B refuses it at the team's concurrency limit."""
        first, most = CAPACITY_WAIT_SECS
        wait = first
        while True:
            try:
                return await start()
            except RateLimitException as error:
                # Jitter spreads the retries of many trials that were refused together.
                delay = wait * random.uniform(0.75, 1.25)
                self.logger.warning(f"E2B refused the {what} ({error}); asking again in {delay:.0f}s")
                await asyncio.sleep(delay)
                wait = min(wait * 2, most)

    async def _create_sandbox(self):
        await self._when_free("sandbox", super()._create_sandbox)

    async def _create_template(self):
        try:
            await self._when_free(f"template build {self._template_name}", self._build_template)
        except BuildException as error:
            # BuildException carries no status_code; the message leads with the status.
            limit = MEMORY_LIMIT.search(str(error))
            if not str(error).startswith("400:") or not limit:
                raise
            raise BuildException(
                f"This E2B key's plan allows sandboxes of at most {mib(int(limit[1]))} of memory, "
                f"and this task asks for {mib(self._effective_memory_mb)}. Ask E2B support "
                "(support@e2b.dev) to raise the team's memory limit, or run the task on another "
                "sandbox."
            ) from error

    async def _does_template_exist(self) -> bool:
        return await self._when_free("template lookup", self._template_ready)

    async def _template_ready(self) -> bool:
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

    async def _build_template(self):
        image = self.task_env_config.docker_image
        grant = self._registry_grant()
        config: dict = {}
        if image:
            username, password = grant or (None, None)
            config = await image_config(image, grant)
            template = Template().from_image(image=image, username=username, password=password)
            env = image_env(config)
        else:
            dockerfile = str(self._environment_definition_path)
            template = Template(file_context_path=str(self.environment_dir)).from_dockerfile(
                dockerfile_content_or_path=dockerfile
            )
            env = await dockerfile_env(dockerfile)
        if env:
            template = template.run_cmd(
                f"printf %s {shlex.quote(profile_script(env))} > {IMAGE_ENV}", user="root"
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


def mib(amount: int) -> str:
    """`amount` MiB in whole GiB when it is one, else in MiB."""
    return f"{amount // 1024} GiB" if amount % 1024 == 0 else f"{amount} MiB"


def image_env(config: dict) -> dict[str, str]:
    """An image config's ENV, in order."""
    return dict(entry.split("=", 1) for entry in config.get("Env") or [] if "=" in entry)


async def dockerfile_env(path: str) -> dict[str, str]:
    """The ENV a single-stage Dockerfile's container starts with, expanded against its base."""
    parsed = DockerfileParser(path)
    if sum(instruction["instruction"] == "FROM" for instruction in parsed.structure) > 1:
        raise ValueError("Multi-stage Dockerfiles are not supported")
    base = parsed.baseimage
    inherited = image_env(await image_config(base)) if base and base != "scratch" else {}
    own = DockerfileParser(path, env_replace=True, parent_env=inherited).envs
    return {**inherited, **own}


def profile_script(env: dict[str, str]) -> str:
    """Exports `env` in a login shell, leaving variables the sandbox or command set, except PATH."""
    return "".join(
        f"export {name}={shlex.quote(value)}\n"
        if name == "PATH"
        else f'[ -n "${{{name}+set}}" ] || export {name}={shlex.quote(value)}\n'
        for name, value in env.items()
    )


def image_parts(image: str) -> tuple[str, str, str]:
    """`image`'s registry host, repository and tag or digest, with Docker Hub's defaults."""
    name, _, digest = image.partition("@")
    first, _, rest = name.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        host, repository = first, rest
    else:
        host, repository = DOCKER_HUB, name
    if host in ("docker.io", "index.docker.io", DOCKER_HUB):
        host = DOCKER_HUB
        if "/" not in repository:
            repository = f"library/{repository}"
    tag = "latest"
    if ":" in repository.rsplit("/", 1)[-1]:
        repository, tag = repository.rsplit(":", 1)
    return host, repository, digest or tag


async def image_config(image: str, grant: tuple[str, str] | None = None) -> dict:
    """
    The linux/amd64 config (Env, User, WorkingDir, ...) of `image`, read with `grant` or, for a
    registry that asks for a token, the anonymous token anyone pulling it gets.
    """
    host, repository, reference = image_parts(image)
    async with httpx.AsyncClient(
        base_url=f"https://{host}/v2/{repository}", follow_redirects=True, timeout=60
    ) as client:
        headers: dict[str, str] = {}

        async def get(path: str, accept: str | None = None) -> httpx.Response:
            extra = {"accept": accept} if accept else {}
            response = await client.get(path, headers={**headers, **extra}, auth=grant)
            challenge = response.headers.get("www-authenticate", "")
            if response.status_code == 401 and challenge.lower().startswith("bearer "):
                headers["authorization"] = f"Bearer {await token(challenge, repository, grant)}"
                response = await client.get(path, headers={**headers, **extra})
            return response.raise_for_status()

        found = (await get(f"/manifests/{reference}", MANIFEST_TYPES)).json()
        if "manifests" in found:
            platform = next(
                child
                for child in found["manifests"]
                if child.get("platform", {}).get("os") == "linux"
                and child.get("platform", {}).get("architecture") == "amd64"
            )
            found = (await get(f"/manifests/{platform['digest']}", MANIFEST_TYPES)).json()
        return (await get(f"/blobs/{found['config']['digest']}")).json().get("config") or {}


async def token(challenge: str, repository: str, grant: tuple[str, str] | None) -> str:
    """A pull token from the realm a registry's `WWW-Authenticate: Bearer ...` challenge names."""
    fields = dict(re.findall(r'(\w+)="([^"]*)"', challenge))
    params = {"scope": fields.get("scope") or f"repository:{repository}:pull"}
    if fields.get("service"):
        params["service"] = fields["service"]
    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
        response = await client.get(fields["realm"], params=params, auth=grant)
        body = response.raise_for_status().json()
    return body.get("token") or body["access_token"]
