"""Run default-branch Terraform plans/applies without publishing sensitive plan data.

Run only through .github/workflows/terraform.yml; no local apply entry point is advertised.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from infra.ci import contracts


class Runner:
    def __init__(self, ctx, directory):
        self.ctx, self.directory = ctx, directory
        self.root = Path(f"infra/terraform/environments/{ctx['environment']}").resolve()
        self.log = directory / "diagnostics.txt"
        self.env = {**os.environ, "TF_IN_AUTOMATION": "true", "TF_INPUT": "0", "TF_WORKSPACE": "default",
                    "TF_DATA_DIR": str(directory / "terraform-data"), "CHECKPOINT_DISABLE": "1"}
        if any(name in os.environ for name in ("TF_CLI_ARGS", "TF_CLI_ARGS_plan", "TF_CLI_ARGS_apply")):
            raise ValueError("Unreviewed Terraform CLI argument overrides are forbidden.")

    def run(self, args, *, stdout=None, allowed=(0,)):
        with self.log.open("ab") as errors:
            result = subprocess.run(args, stdout=subprocess.PIPE if stdout is None else stdout,
                                    stderr=errors, env=self.env, timeout=1800)
        if result.returncode not in allowed:
            if stdout is None and result.stdout:
                with self.log.open("ab") as errors: errors.write(result.stdout)
            raise RuntimeError(f"Command failed (exit {result.returncode}); diagnostics kept private.")
        return result.stdout if stdout is None else result.returncode

    def terraform(self, *args, **kwargs):
        return self.run(["terraform", f"-chdir={self.root}", *args], **kwargs)

    def upload(self, path, filename):
        uri = contracts.object_uri(self.ctx, filename)
        self.run(["gcloud", "storage", "cp", str(path), uri, "--if-generation-match=0", "--quiet"])
        metadata = json.loads(self.run(["gcloud", "storage", "objects", "describe", uri, "--raw", "--format=json"]))
        contracts.object_uri(self.ctx, filename, metadata["generation"])
        return str(metadata["generation"])

    def initialize(self, inputs):
        if self.run(["git", "rev-parse", "HEAD"]).decode().strip() != self.ctx["source_sha"]:
            raise ValueError("Checkout does not match the workflow commit.")
        if self.run(["git", "status", "--porcelain", "--untracked-files=all"]).strip():
            raise ValueError("Terraform requires an unchanged checkout, including untracked source files.")
        # Missing state is a bootstrap problem; planner must not write a new snapshot.
        self.run(["gcloud", "storage", "objects", "describe",
                  f"gs://{self.ctx['state_bucket']}/selfbench/{self.ctx['environment']}/default.tfstate", "--format=json"])
        self.terraform("init", "-input=false", "-lockfile=readonly", f"-backend-config=bucket={self.ctx['state_bucket']}")
        version = json.loads(self.terraform("version", "-json"))
        if version["terraform_version"] != contracts.TERRAFORM_VERSION:
            raise ValueError("Terraform version does not match the pinned plan contract.")
        self.terraform("validate", "-json")
        values = self.directory / "inputs.tfvars.json"
        values.write_bytes(contracts.canonical(inputs))
        return values

    def decode_plan(self, path):
        return json.loads(self.terraform("show", "-json", str(path)))


def append_output(values):
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for name, value in values.items():
            output.write(f"{name}={value}\n")


def write_summary(ctx, summary, generation=None, text_generation=None):
    counts = summary["counts"]
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(f"## Terraform: {ctx['environment']}\n\n")
        output.write(f"Project: `{ctx['project']}` · Source: `{ctx['source_sha']}`\n\n")
        output.write(f"**{counts['create']} to add, {counts['update']} to change, {counts['delete']} to destroy.**\n\n")
        # Values are extracted from the plan, not guessed from requested inputs.
        output.write("Capacity (not a price quote): `" + json.dumps(summary["sizing"], sort_keys=True) + "`\n\n")
        if generation:
            output.write("Review the full plan in private GCS before approving Apply:\n\n````text\n")
            output.write(contracts.object_uri(ctx, "plan.txt", text_generation) + "\n")
            output.write(contracts.object_uri(ctx, "manifest.json", generation) + "\n````\n\n")
            output.write("Approval provisions billed infrastructure; it does not deploy the SelfBench application.\n")


def plan(runner, inputs):
    values = runner.initialize(inputs)
    path = runner.directory / "terraform.tfplan"
    with runner.log.open("ab") as log:
        runner.terraform("plan", "-input=false", "-no-color", "-lock-timeout=300s", "-detailed-exitcode",
                         f"-var-file={values}", f"-out={path}", stdout=log, allowed=(0, 2))
    summary = contracts.inspect_plan(runner.decode_plan(path), runner.ctx)
    plan_bytes = path.read_bytes()
    generation = runner.upload(path, "terraform.tfplan")
    text_path = runner.directory / "plan.txt"
    text_path.write_bytes(runner.terraform("show", "-no-color", str(path)))
    text_generation = runner.upload(text_path, "plan.txt")
    record = contracts.manifest(runner.ctx, plan_bytes, generation,
                                (runner.root / ".terraform.lock.hcl").read_bytes(), summary)
    record.update(plan_text_generation=text_generation, plan_text_sha256=contracts.digest(text_path.read_bytes()))
    manifest_path = runner.directory / "manifest.json"
    manifest_path.write_bytes(contracts.canonical(record))
    manifest_generation = runner.upload(manifest_path, "manifest.json")
    append_output({"has_changes": str(summary["has_changes"]).lower(),
                   "manifest_generation": manifest_generation,
                   "manifest_sha256": contracts.digest(manifest_path.read_bytes())})
    write_summary(runner.ctx, summary, manifest_generation, text_generation)



def verify_resources(runner, outputs):
    project = runner.ctx["project"]
    metadata = json.loads(runner.run(["gcloud", "projects", "describe", project, "--format=json"]))
    vm = json.loads(runner.run(["gcloud", "compute", "instances", "describe", outputs["instance"],
                                f"--zone={outputs['zone']}", f"--project={project}", "--format=json", "--quiet"]))
    if vm.get("status") != "RUNNING":
        raise ValueError("Provisioned VM is not RUNNING; inspect private diagnostics before retrying.")
    bucket = json.loads(runner.run(["gcloud", "storage", "buckets", "describe", f"gs://{outputs['artifact_bucket']}",
                                    "--raw", "--format=json"]))
    iam = bucket.get("iamConfiguration", {})
    if (str(bucket.get("projectNumber")) != str(metadata["projectNumber"])
            or iam.get("publicAccessPrevention") != "enforced"
            or iam.get("uniformBucketLevelAccess", {}).get("enabled") is not True
            or bucket.get("versioning", {}).get("enabled") is not True):
        raise ValueError("Provisioned artifact bucket protections/ownership differ.")
    if outputs.get("database"):
        instance = outputs["database"]["instance"].split(":")[-1]
        database = json.loads(runner.run(["gcloud", "sql", "instances", "describe", instance,
                                          f"--project={project}", "--format=json", "--quiet"]))
        network = database.get("settings", {}).get("ipConfiguration", {})
        if database.get("state") != "RUNNABLE" or network.get("ipv4Enabled") is not False or not network.get("privateNetwork"):
            raise ValueError("Provisioned database is not RUNNABLE/private.")


def apply(runner, inputs):
    generation = os.environ.get("PLAN_MANIFEST_GENERATION", "")
    expected_hash = os.environ.get("PLAN_MANIFEST_SHA256", "")
    uri = contracts.object_uri(runner.ctx, "manifest.json", generation)
    manifest_path = runner.directory / "manifest.json"
    runner.run(["gcloud", "storage", "cp", uri, str(manifest_path), "--quiet"])
    if contracts.digest(manifest_path.read_bytes()) != expected_hash:
        raise ValueError("Manifest differs from the planning job receipt.")
    record = json.loads(manifest_path.read_text())
    contracts.verify_manifest(record, runner.ctx, (runner.root / ".terraform.lock.hcl").read_bytes())
    path = runner.directory / "terraform.tfplan"
    runner.run(["gcloud", "storage", "cp", contracts.object_uri(runner.ctx, "terraform.tfplan", record["plan_generation"]),
                str(path), "--quiet"])
    if contracts.digest(path.read_bytes()) != record["plan_sha256"]:
        raise ValueError("Saved plan differs from the reviewed digest.")
    runner.initialize(inputs)
    summary = contracts.inspect_plan(runner.decode_plan(path), runner.ctx)
    if summary != record["summary"]:
        raise ValueError("Plan summary differs from the reviewed manifest.")
    with runner.log.open("ab") as log:
        runner.terraform("apply", "-input=false", "-no-color", "-lock-timeout=300s", str(path), stdout=log)
    # Read Terraform outputs, not application readiness. Keep full outputs off public logs.
    outputs = runner.terraform("output", "-json", "deployment")
    result = json.loads(outputs)
    if result.get("project_id") != runner.ctx["project"] or result.get("environment") != runner.ctx["environment"]:
        raise ValueError("Applied outputs do not match the intended environment.")
    verify_resources(runner, result)
    outputs_path = runner.directory / "outputs.json"
    outputs_path.write_bytes(outputs)
    runner.upload(outputs_path, "outputs.json")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
        output.write(f"## Applied {runner.ctx['environment']}\n\nSaved plan applied; output identity, VM status, private DB status and bucket protections verified. "
                     "VM startup scripts, database login/connectivity, application deployment and HTTP health still require verification.\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=["plan", "apply"])
    args = parser.parse_args()
    os.umask(0o077)
    ctx, inputs = contracts.context(os.environ)
    with tempfile.TemporaryDirectory(prefix="selfbench-terraform-") as directory:
        runner = Runner(ctx, Path(directory))
        try:
            (plan if args.phase == "plan" else apply)(runner, inputs)
        except Exception as error:
            with runner.log.open("a") as log:
                log.write(f"\n{type(error).__name__}: {error}\n")
            raise
        finally:
            if runner.log.exists():
                # Snapshot before uploading: gcloud's own stderr must not modify its upload source.
                snapshot = runner.directory / "private-diagnostics.txt"
                snapshot.write_bytes(runner.log.read_bytes())
                filename = "diagnostics.txt" if args.phase == "plan" else "apply.log"
                try:
                    runner.upload(snapshot, filename)
                    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                        summary.write("\nPrivate diagnostic log: `" + contracts.object_uri(ctx, filename) + "`\n")
                except Exception:
                    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                        summary.write("\nPrivate log upload failed. Do not retry an apply without reconciling state.\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never print raw Terraform errors or env/plan payloads into a public repository's logs.
        raise SystemExit("Terraform CI failed closed. Inspect the private plan diagnostics or operator logs; no automatic rollback was attempted.") from None
