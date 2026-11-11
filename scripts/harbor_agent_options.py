"""Writes the harness options a run condition may set (src/contracts/harbor-agent-options.ts), read
from the installed Harbor's agent option models, so a Harbor upgrade brings its new knobs with it.

Run it with Harbor's own interpreter after an upgrade:

    $(head -1 "$(command -v harbor)" | cut -c3-) scripts/harbor_agent_options.py > \
        src/contracts/harbor-agent-options.ts && bunx biome format --write src/contracts

tests/harbor/harbor-contract.test.ts fails while the file differs from what this prints.

An option is left out when SelfBench sets it itself (the model's address, its reasoning level), when
it names a model (the trial's gateway key serves only the trial's model), or when Harbor would read
it as a path or address on the worker rather than in the sandbox.
"""

import json
import re
import sys
from typing import Any, Literal, Union, get_args, get_origin

import harbor
from harbor.agents.factory import AgentFactory
from harbor.models.agent.name import AgentName

# The harness ids SelfBench runs (src/evaluation/models.ts harnessIds), as Harbor names its agents.
HARNESSES = ["codex", "claude-code", "pi", "mini-swe-agent", "terminus-2", "muse-code"]

# Options SelfBench never passes on, whatever Harbor version adds them, each with why.
WITHHELD = {
    # SelfBench routes every trial: the model's address and API style, and its reasoning level,
    # which the run's setting (model, harness, reasoning) already names.
    "base_url": "routing",
    "api_base": "routing",
    "model_api": "routing",
    "model_details": "routing",
    "model_info": "routing",
    "litellm_model_registry": "routing",
    "use_responses_api": "routing",
    "reasoning_effort": "setting",
    # A second model needs its own place on the trial's gateway key, which conditions don't add yet.
    "fallback_model": "model",
    # Read from the worker's disk, not the sandbox's.
    "prompt_template_path": "worker path",
    "memory_dir": "worker path",
    "config_file": "worker path",
    "litellm_model_registry_file": "worker path",
    # Harbor bookkeeping, not agent behavior.
    "session_id": "bookkeeping",
    "session_id_headers": "bookkeeping",
    "collect_rollout_details": "bookkeeping",
    "store_all_messages": "bookkeeping",
    "record_terminal_session": "bookkeeping",
}
# Any other option whose description reads like a location on the worker is withheld too.
LOCATION = re.compile(r"\b(path|paths|directory|url|urls|endpoint)\b", re.IGNORECASE)
# Muse Code's installer always takes the latest release (MuseCode's docstring).
UNPINNABLE = {"muse-code"}

WORDS = {"usd": "USD", "mcp": "MCP", "api": "API", "id": "ID", "llm": "LLM"}
SMALL = {"a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to"}


def label(name: str) -> str:
    words = name.split("_")
    return " ".join(
        WORDS.get(word)
        or (word if 0 < at < len(words) - 1 and word in SMALL else word.capitalize())
        for at, word in enumerate(words)
    )


def described(text: str | None) -> str:
    return " ".join((text or "").split())


def kind_of(annotation: Any) -> tuple[str, list[str] | None] | None:
    """The option's kind as the Run page edits it, or None for a type it can't."""
    origin = get_origin(annotation)
    if origin is Union or str(origin) == "types.UnionType":
        present = [arg for arg in get_args(annotation) if arg is not type(None)]
        return kind_of(present[0]) if len(present) == 1 else None
    if origin is not None and getattr(origin, "__name__", "") == "Annotated":
        return kind_of(get_args(annotation)[0])
    if origin is Literal:
        values = [value for value in get_args(annotation) if value is not None]
        return ("enum", [str(value) for value in values]) if all(
            isinstance(value, str) for value in values
        ) else None
    if annotation is bool:
        return ("boolean", None)
    if annotation is int:
        return ("integer", None)
    if annotation is float:
        return ("number", None)
    if annotation is str:
        return ("string", None)
    return None


def options(harness: str) -> list[dict[str, Any]]:
    agent = AgentFactory.get_agent_class(AgentName(harness))
    native_config = bool(getattr(getattr(agent, "capabilities", None), "native_config", False))
    found = []
    for name, field in agent.options_model.model_fields.items():
        if name in WITHHELD or LOCATION.search(described(field.description)):
            if name != "config":
                continue
        if name == "version" and harness in UNPINNABLE:
            continue
        if name == "config":
            if not native_config:
                continue
            option = {"kind": "object"}
        else:
            kind = kind_of(field.annotation)
            if kind is None:
                continue
            option = {"kind": kind[0], **({"values": kind[1]} if kind[1] else {})}
        default = field.default
        found.append(
            {
                "name": name,
                "label": "Native Config" if name == "config" else label(name),
                **option,
                **(
                    {"default": default}
                    if isinstance(default, (bool, int, float, str)) and name != "config"
                    else {}
                ),
                "description": "Settings in the agent's own config, as a JSON object."
                if name == "config"
                else described(field.description),
            }
        )
    return found


catalog = {harness: options(harness) for harness in HARNESSES}
body = json.dumps(catalog, indent=2)
sys.stdout.write(
    f"""// Generated by scripts/harbor_agent_options.py from Harbor {harbor.__version__}; do not edit.
import type {{ HarborAgentOptions }} from "./harness-options.js";

export const harborAgentOptions = {body} as const satisfies HarborAgentOptions;
"""
)
