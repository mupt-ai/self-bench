# Build One Eval Task from a Scenario

A person described a situation an AI agent should handle, usually one where an agent they rely on got it wrong. You are turning it into a benchmark task. Later, an agent gets a workspace of files in /app plus a written instruction, and hidden tests decide whether what it leaves in /app is right. You write the workspace, the instruction, the hidden tests, and the reference outcome, and prove they work with the verify tool.

## Scenario

- Title: {{title}}
- Requested difficulty: {{difficulty}}

<scenario>
{{request}}
</scenario>

{{attachments}}

/work/provenance.json holds the original request record; use it only to confirm the scenario.

{{maintainer}}

# What to Produce

In /work/task/:

- workspace/: every file the agent starts with in /app (documents, mail, spreadsheets, calendars, notes, data, code), as the scenario implies they would exist.
- instruction.md: what the agent is asked to do, as the person would ask it.
- gold.patch: the reference outcome, the files a correct agent writes or changes. No tests.
- test.patch: the hidden tests that check the outcome.
- Dockerfile: the environment the agent works and the tests run in.
- smoke.sh: proves the environment is ready for the agent.
- run-tests.sh: runs the hidden tests.
- services.sh, only if the scenario needs a local service, such as a mail server the agent queries: starts it.

Both patches are `git diff` output against workspace/. Never put a .git in workspace/: copy it, commit the copy, and diff there.

```
rm -rf /tmp/base && cp -a /work/task/workspace /tmp/base
git -C /tmp/base init -q && git -C /tmp/base add -A && git -C /tmp/base -c user.name=a -c user.email=a@a commit -qm base
```

test.patch must apply to that commit first and gold.patch on top of it, and the two must touch different files. Keep the workspace under 50 MB and 5,000 files.

# Make the Scenario a Test

- Find the capability the scenario is about: what a careful person does that the agent failed to do (for example, noticing that a later email supersedes a spreadsheet). The task must reward exactly that.
- Build the workspace so the shortcut fails. The stale or misleading source must be present and plausible, the information that matters must be where a careful agent would look but not handed to it, and an agent that skips the step must produce a wrong outcome the tests catch. Add realistic noise (unrelated messages, similar names, older versions) so finding it takes reading, not one grep for a keyword the instruction gives away.
- Make the files real. A spreadsheet is a real .xlsx (python3 and node are available here; an .xlsx is a zip of XML if no library is installed), mail is .eml or mbox with real headers and dates, a calendar is .ics. Dates, names, and numbers must agree across files except where the scenario needs them to conflict.
- Keep it self-contained: no network, accounts, or credentials. Where attached files hold personal details the scenario does not depend on (addresses, phone numbers, account numbers, other people's emails), replace them with fictional ones; keep the ones it does depend on.
- The requested difficulty is a guide, not a check: easy reads one fact from one source; medium reconciles a few sources or one superseding update; hard needs many sources, several updates, or a multi-step change.

# Grade the Outcome, Fairly

- The instruction defines the output contract: the exact path and format the agent writes (for example `/app/answer.json` with named fields), or the exact files it updates. Tests may check only what that contract and the scenario determine.
- Tests parse structured output and compare facts. Normalize what the contract leaves open: case, whitespace, ordering of unordered lists, equivalent date and time spellings. Never match prose.
- Accept every outcome a careful agent could reasonably reach from the instruction. If two answers are defensible, either the instruction must rule one out or the tests must accept both.
- fail-to-pass checks the outcome. pass-to-pass checks something that holds before and after a correct solution, such as the inputs the agent should not modify still being intact.
- Put the tests in files gold.patch does not touch (for example under tests/). The agent's changes to any file test.patch touches are discarded before grading, so it cannot rewrite the checker.
- Nothing in workspace/ or instruction.md may reveal the expected outcome or the checker.

# Keep the Instruction Fair

- Write it as the person would ask, from the scenario: what they want, not how to find it. Don't point at the file that holds the answer or name the trap.
- State the output contract exactly. If the tests depend on a name, path, field, or format, the instruction says it.
- Mention tools the agent may need that aren't obvious (for example, that python3 with openpyxl is installed).

# Environment

The Dockerfile's build context holds only `repo.tar.gz`, the files of workspace/. Unpack it into /app with `ADD repo.tar.gz /app/`, then install what the agent and the tests need. SelfBench builds the agent's image and the separate verifier's image from your Dockerfile, so both start from the same /app.

- Choose a small, standard base image by tag (`python:3.12-bookworm`); the worker pins each tag to its current digest. Never write a digest yourself. `skopeo inspect docker://IMAGE` confirms a tag exists. Only literal, non-secret values.
- The image needs bash, git, pkill (procps), runuser and useradd (passwd), and tar. Leave /app without a .git directory.
- The agent works in its image as root, and its network is limited to its model provider. Install everything ahead of time, including the libraries an agent would reasonably reach for to read the workspace (for example openpyxl for .xlsx) and everything the tests use.
- smoke.sh runs in /app under exactly the agent's conditions. Exercise the tools the agent needs, such as reading one workspace file the way the agent would.
- run-tests.sh runs in /app as an unprivileged user, over the agent's changes with test.patch applied. Its one argument is `fail-to-pass` or `pass-to-pass`, and it exits 0 only when every one of those tests passes.
- Services run in the image: install them in the Dockerfile, and services.sh starts each in the background as root from /app, waits until it is ready, and exits 0. The agent's image has it at /opt/selfbench-environment/services.sh: smoke.sh runs it first, and instruction.md tells the agent it starts the services.
- Every task gets {{limits}}.

{{howToWork}}
{{feedback}}
