#!/usr/bin/env python3
"""Explicit, dry-run-first project/state bootstrap. Never changes gcloud's defaults."""
import argparse
import json
import re
import shlex
import subprocess


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("environment", "project", "account", "billing-account", "region", "state-bucket"):
        parser.add_argument(f"--{name}", required=True)
    parent = parser.add_mutually_exclusive_group(required=True)
    parent.add_argument("--folder")
    parent.add_argument("--organization")
    parent.add_argument("--no-organization", action="store_true")
    parser.add_argument("--execute", action="store_true", help="Create/link resources after identity checks; default prints only.")
    args = parser.parse_args(argv)
    patterns = {
        "environment": r"dev|prod", "project": r"[a-z][a-z0-9-]{4,28}[a-z0-9]",
        "billing_account": r"[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}",
        "region": r"[a-z]+-[a-z]+[0-9]", "state_bucket": r"[a-z0-9][a-z0-9-]{1,61}[a-z0-9]",
        "account": r"[^\s@]+@[^\s@]+", "folder": r"[0-9]+", "organization": r"[0-9]+",
    }
    for key, pattern in patterns.items():
        value = getattr(args, key)
        if value is not None and not re.fullmatch(pattern, value):
            parser.error(f"Invalid --{key.replace('_', '-')}.")
    # This simple house convention prevents accidentally targeting a generic Dari project.
    if not args.project.startswith(f"selfbench-{args.environment}-"):
        parser.error("Project ID must start with selfbench-<environment>- and include a unique suffix.")
    if args.state_bucket != f"{args.project}-tfstate":
        parser.error("State bucket must be <project-id>-tfstate.")
    return args


def command(args, *parts):
    return ["gcloud", *parts, f"--account={args.account}", "--quiet"]


def planned_commands(args):
    parent = [f"--folder={args.folder}"] if args.folder else (
        [f"--organization={args.organization}"] if args.organization else [])
    return [
        command(args, "projects", "create", args.project,
                f"--name=SelfBench {args.environment}",
                f"--labels=application=selfbench,environment={args.environment}", *parent),
        command(args, "billing", "projects", "link", args.project,
                f"--billing-account={args.billing_account}"),
        command(args, "services", "enable", "serviceusage.googleapis.com",
                "cloudresourcemanager.googleapis.com", "storage.googleapis.com",
                f"--project={args.project}"),
        command(args, "storage", "buckets", "create", f"gs://{args.state_bucket}",
                f"--project={args.project}", f"--location={args.region}",
                "--uniform-bucket-level-access", "--public-access-prevention"),
        command(args, "storage", "buckets", "update", f"gs://{args.state_bucket}",
                f"--project={args.project}", "--versioning"),
    ]


def read_json(args, *parts):
    result = subprocess.run(command(args, *parts, "--format=json"), check=True,
                            capture_output=True, text=True)
    return json.loads(result.stdout)


def verify_project(args, project):
    if project.get("projectId") != args.project or project.get("lifecycleState") != "ACTIVE":
        raise ValueError("Existing project identity/state does not match; refusing to modify it.")
    labels = project.get("labels", {})
    if labels.get("application") != "selfbench" or labels.get("environment") != args.environment:
        raise ValueError("Existing project is not labeled for this SelfBench environment; refusing adoption.")
    expected = ("folder", args.folder) if args.folder else ("organization", args.organization)
    parent = project.get("parent", {})
    if args.no_organization:
        if parent:
            raise ValueError("Existing project has an unexpected parent.")
    elif (parent.get("type"), parent.get("id")) != expected:
        raise ValueError("Existing project has an unexpected parent.")


def execute(args):
    commands = planned_commands(args)
    projects = read_json(args, "projects", "list", f"--filter=projectId={args.project}")
    if projects:
        if len(projects) != 1:
            raise ValueError("Ambiguous project lookup.")
        verify_project(args, projects[0])
    else:
        subprocess.run(commands[0], check=True)
    project = read_json(args, "projects", "describe", args.project)
    verify_project(args, project)
    billing = read_json(args, "billing", "projects", "describe", args.project)
    current = billing.get("billingAccountName")
    expected = f"billingAccounts/{args.billing_account}"
    if current and current != expected:
        raise ValueError("Project is linked to a different billing account; refusing to relink.")
    if current != expected or not billing.get("billingEnabled"):
        subprocess.run(commands[1], check=True)
        linked = read_json(args, "billing", "projects", "describe", args.project)
        if linked.get("billingAccountName") != expected or linked.get("billingEnabled") is not True:
            raise ValueError("Billing link was not confirmed; refusing further bootstrap mutations.")
    subprocess.run(commands[2], check=True)
    buckets = read_json(args, "storage", "buckets", "list", f"--project={args.project}")
    if not any(bucket.get("name") == args.state_bucket for bucket in buckets):
        subprocess.run(commands[3], check=True)
    bucket = read_json(args, "storage", "buckets", "describe", f"gs://{args.state_bucket}",
                       f"--project={args.project}", "--raw")
    # Raw API keys include projectNumber; normalized gcloud output omits that field.
    if (str(bucket.get("projectNumber")) != str(project["projectNumber"])
            or str(bucket.get("location", "")).lower() != args.region
            or bucket.get("iamConfiguration", {}).get("uniformBucketLevelAccess", {}).get("enabled") is not True
            or bucket.get("iamConfiguration", {}).get("publicAccessPrevention") != "enforced"):
        raise ValueError("State bucket owner/location/security do not match; refusing to alter it.")
    subprocess.run(commands[4], check=True)
    verified = read_json(args, "storage", "buckets", "describe", f"gs://{args.state_bucket}",
                         f"--project={args.project}", "--raw")
    if verified.get("versioning", {}).get("enabled") is not True:
        raise ValueError("State bucket versioning was not confirmed.")
    print("Bootstrap verified. No VM, database, app deployment, or secret values were created.")


def main(argv=None):
    args = parse_args(argv)
    if args.execute:
        execute(args)
    else:
        print("DRY RUN: no commands are executed. --execute performs checked bootstrap mutations.")
        for cmd in planned_commands(args):
            print(shlex.join(cmd))
        print("Existing resources will be identity-checked, not silently adopted or overwritten.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        # Do not dump captured command output, which might contain account details.
        raise SystemExit(f"Bootstrap stopped: {error}. Inspect partial state before retrying.") from None
