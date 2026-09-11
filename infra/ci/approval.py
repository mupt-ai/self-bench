"""Fail closed before apply authentication if environment protection was removed."""
import json
import os
import urllib.parse
import urllib.request

from infra.ci import contracts


def verify(environment, policies, branch, *, release=False, require_review=True):
    if environment.get("deployment_branch_policy") != {"protected_branches": False, "custom_branch_policies": True}:
        raise ValueError("Deployment requires an explicit environment ref policy.")
    reviewers = [rule for rule in environment.get("protection_rules", []) if rule.get("type") == "required_reviewers"]
    if require_review and (not reviewers or not all(rule.get("reviewers") for rule in reviewers)):
        raise ValueError("Apply environment must require human review.")
    branches = policies.get("branch_policies", [])
    if (policies.get("total_count") != 1 or len(branches) != 1
            or branches[0].get("name") != ("*" if release else branch) or branches[0].get("type") != ("tag" if release else "branch")):
        raise ValueError("Deployment environment ref policy does not match its branch or release-tag configuration.")


def main():
    ctx, _ = contracts.context(os.environ)
    environment = ctx["environment"]
    base = f"https://api.github.com/repos/{ctx['repository']}/environments/{urllib.parse.quote(environment, safe='')}"
    headers = {"Authorization": f"Bearer {os.environ['GH_TOKEN']}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    def read(url):
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
            return json.load(response)
    verify(read(base), read(base + "/deployment-branch-policies?per_page=100"), os.environ["GITHUB_DEFAULT_BRANCH"], release=ctx["environment"] == "prod", require_review=ctx["environment"] == "prod")
    print("Deployment environment protections verified.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Apply protection could not be verified. No GCP authentication was attempted.") from None
