"""Harbor's E2B environment, rebuilding a template whose last build never became ready.

Harbor names a task's template after its environment's content hash and builds it only when no
template has that name. E2B registers the name, and points its ``default`` tag at the new build,
as soon as a build is requested, so a build that failed or was cut off left a name with no usable
build: every later trial skipped the build and failed to start with "404: tag 'default' does not
exist". Here a template counts as existing only when its ``default`` build is ready; otherwise it
is built again under the same name, which moves the tag to the new build.
"""

from __future__ import annotations

from e2b import AsyncTemplate, BuildInfo, TemplateBuildStatus

from harbor.environments.e2b import E2BEnvironment

TAG = "default"


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
