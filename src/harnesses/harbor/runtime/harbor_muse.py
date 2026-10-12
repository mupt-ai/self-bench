"""Run Harbor's Muse Code on a Meta sign-in, at every effort Muse takes, and turn its session log
into Harbor's trajectory and token totals."""
import json
from pathlib import Path
from typing import Annotated, Literal
from pydantic import Field
from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.muse_code import MuseCode, MuseCodeOptions
from harbor.agents.options import Cli
from harbor.models.trial.paths import EnvironmentPaths


class SelfBenchMuseCodeOptions(MuseCodeOptions):
    # Harbor lists Muse's efforts without max, which Muse Spark 1.3 and Muse Wonder accept.
    reasoning_effort: Annotated[
        Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"] | None,
        Cli("--reasoning-effort", fallback="MUSE_CODE_REASONING_EFFORT"),
    ] = Field(default=None, description="Model reasoning effort.")


class SelfBenchMuseCode(MuseCode):
    """Harbor's Muse Code, signed in from MUSE_AUTH_JSON_PATH when it names a Muse auth.json."""

    options_model = SelfBenchMuseCodeOptions
    _AUTH_UPLOAD = "/tmp/selfbench-muse-auth.json"

    def build_cli_flags(self):
        # Contributor mode would let Meta train on the benchmark's tasks. Web tools are off: the
        # sandbox's network allows only Meta's API, and Meta's own search would reach past it.
        return " ".join(
            filter(None, [super().build_cli_flags(), "--contributor-mode off", "--disable-web-tools"])
        )

    async def run(self, instruction, environment, context):
        auth = self._get_env("MUSE_AUTH_JSON_PATH")
        if not auth:
            return await super().run(instruction, environment, context)
        # Muse Code's own credential file, holding the sign-in's token; at startup Muse mints its
        # subscription key from it and writes the key back into the file.
        await self._upload_agent_owned_file(environment, Path(auth), self._AUTH_UPLOAD)
        await self.exec_as_agent(
            environment,
            command=(
                'dir="${XDG_CONFIG_HOME:-$HOME/.config}/muse"; mkdir -p "$dir" && '
                f'mv {self._AUTH_UPLOAD} "$dir/auth.json" && chmod 600 "$dir/auth.json"'
            ),
        )
        await self._run_signed_in(instruction, environment, context)

    @with_prompt_template
    async def _run_signed_in(self, instruction, environment, context):
        # Harbor's run, less its META_API_KEY requirement: a key in the environment would take
        # priority over the sign-in.
        sessions = (EnvironmentPaths.agent_dir / "sessions").as_posix()
        try:
            await self.exec_as_agent(
                environment,
                command=self._build_run_command(instruction),
                env={"MUSE_NO_AUTO_UPDATE": "1"},
            )
        finally:
            await self.exec_as_agent(
                environment,
                command=(
                    f"mkdir -p {sessions} && "
                    'cp -R "${XDG_DATA_HOME:-$HOME/.local/share}"/muse/sessions/. '
                    f"{sessions}/ 2>/dev/null || true"
                ),
            )

    def populate_context_post_run(self, context):
        logs = sorted((self.logs_dir / "sessions").glob("**/session.jsonl"))
        main = [path for path in logs if "subagent" not in path.parts]
        if len(main) != 1:
            return
        trajectory = muse_trajectory(
            main[0],
            [path for path in logs if path not in main],
            {"name": self.name(), "version": self.version() or "unknown", "model_name": self.model_name},
        )
        (self.logs_dir / "trajectory.json").write_text(
            json.dumps(trajectory, indent=2, ensure_ascii=False)
        )
        totals = trajectory["final_metrics"]
        context.n_input_tokens = totals["total_prompt_tokens"]
        context.n_cache_tokens = totals["total_cached_tokens"]
        context.n_output_tokens = totals["total_completion_tokens"]


def muse_records(path):
    """A Muse session log's records, including those its transactions wrap."""
    for line in path.read_text(errors="replace").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if "children" not in row:
            yield row
            continue
        for child in row["children"]:
            try:
                yield json.loads(child["record_json"])
            except (json.JSONDecodeError, KeyError, TypeError):
                continue


def muse_events(path):
    """The run events of a Muse session log, in order."""
    for record in muse_records(path):
        payload = record.get("payload") or {}
        if record.get("payload_type") == "runtime.session" and payload.get("kind") == "run":
            yield payload.get("event") or {}


def muse_metrics(usage):
    # Muse counts the tokens it read from cache within its input, as Harbor's prompt count does.
    return {
        "prompt_tokens": usage.get("input_tokens") or 0,
        "completion_tokens": usage.get("output_tokens") or 0,
        "cached_tokens": usage.get("cache_read_tokens") or usage.get("cached_tokens") or 0,
        "extra": {
            "cache_write_input_tokens": usage.get("cache_write_tokens") or 0,
            "reasoning_tokens": usage.get("reasoning_tokens") or 0,
        },
    }


def muse_trajectory(main, subagents, agent):
    """Harbor's ATIF trajectory of a Muse Code session: its prompt, then a step for each model
    response with its reply, tool calls and their results. Each request of the checks Muse runs
    in subagents (its goal and verify reminders) is a step without text, so its tokens count."""
    steps = []
    responses = {}
    current = None
    for record in muse_records(main):
        if record.get("payload_type") == "runtime.user_intent.accepted":
            blocks = (record.get("payload") or {}).get("refill_blocks") or []
            text = "\n".join(block.get("text", "") for block in blocks if block.get("kind") == "text")
            steps.append({"source": "user", "message": text})
            break
    for event in muse_events(main):
        kind = event.get("kind")
        step = responses.get(event.get("response_id"))
        if kind == "model_response_created":
            current = {"source": "agent", "message": ""}
            responses[event.get("response_id")] = current
            steps.append(current)
        elif kind == "model_completed" and current is not None:
            # Muse records a response's usage once the response ends, before its tool calls.
            current["model_name"] = event.get("model")
            current["metrics"] = muse_metrics(event.get("usage") or {})
        elif kind == "assistant_message_committed" and step is not None and event.get("text"):
            step["message"] = "\n".join(filter(None, [step["message"], event["text"]]))
        elif kind == "reasoning_committed" and step is not None and event.get("text"):
            step["reasoning_content"] = "\n".join(
                filter(None, [step.get("reasoning_content"), event["text"]])
            )
        elif kind == "assistant_tool_calls_committed" and step is not None:
            for call in event.get("tool_calls") or []:
                try:
                    arguments = json.loads(call.get("args") or "{}")
                except json.JSONDecodeError:
                    arguments = call.get("args")
                step.setdefault("tool_calls", []).append(
                    {
                        "tool_call_id": call.get("call_id"),
                        "function_name": call.get("name") or "tool",
                        "arguments": arguments if isinstance(arguments, dict) else {"input": arguments},
                    }
                )
        elif kind == "tool_result_batch_committed":
            for result in event.get("results") or []:
                called = next(
                    (
                        candidate
                        for candidate in reversed(steps)
                        if any(
                            call["tool_call_id"] == result.get("tool_call_id")
                            for call in candidate.get("tool_calls", [])
                        )
                    ),
                    None,
                )
                if called is not None:
                    called.setdefault("observation", {"results": []})["results"].append(
                        {"source_call_id": result.get("tool_call_id"), "content": result.get("text")}
                    )
    for path in subagents:
        for event in muse_events(path):
            if event.get("kind") == "model_completed":
                steps.append(
                    {
                        "source": "agent",
                        "message": "",
                        "model_name": event.get("model"),
                        "metrics": muse_metrics(event.get("usage") or {}),
                        "extra": {"subagent": path.parent.name},
                    }
                )
    for index, step in enumerate(steps):
        step["step_id"] = index + 1
    metered = [step["metrics"] for step in steps if "metrics" in step]
    return {
        "schema_version": "ATIF-v1.6",
        "session_id": main.parent.name,
        "agent": agent,
        "steps": steps,
        "final_metrics": {
            "total_prompt_tokens": sum(metrics["prompt_tokens"] for metrics in metered),
            "total_completion_tokens": sum(metrics["completion_tokens"] for metrics in metered),
            "total_cached_tokens": sum(metrics["cached_tokens"] for metrics in metered),
            "total_steps": len(steps),
        },
    }
