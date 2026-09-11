import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
SPEC = importlib.util.spec_from_file_location("github_auth", ROOT / "bootstrap/github_auth.py")
auth = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auth)


class GitHubAuthTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "bootstrap/github-auth.json.example").read_text())
        self.provider = {
            "name": auth.coordinates(self.config)["provider"], "state": "ACTIVE",
            "description": auth.DESCRIPTION, "attributeMapping": auth.MAPPING,
            "attributeCondition": auth.condition(self.config),
            "oidc": {"issuerUri": "https://token.actions.githubusercontent.com"},
        }
        self.binding = {"role": "roles/iam.workloadIdentityUser",
                        "members": [auth.coordinates(self.config)["member"]]}
        self.project = {"projectId": self.config["project_id"], "projectNumber": self.config["project_number"],
                        "lifecycleState": "ACTIVE"}
        self.repo = {"full_name": self.config["repository"], "id": int(self.config["repository_id"]),
                     "owner": {"id": int(self.config["repository_owner_id"])}, "default_branch": "main"}

    def test_configuration_is_not_tied_to_mupt_or_project_prefix(self):
        self.config.update(project_id="community-infra", environment="staging", repository="community/tool")
        auth.validate_config(self.config)
        self.assertIn("environment:staging", auth.claims(self.config)["sub"])

    def test_default_invokes_no_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps(self.config))
            with patch.object(auth.subprocess, "run") as run, \
                    patch.object(auth.subprocess, "check_output") as read, contextlib.redirect_stdout(io.StringIO()):
                auth.main(["--config", str(config)])
            run.assert_not_called()
            read.assert_not_called()

    def test_trust_includes_all_required_claims(self):
        condition = auth.condition(self.config)
        expected = {
            "repository_id": "12345678", "repository_owner_id": "1234567",
            "repository": "your-org/your-repository", "ref": "refs/heads/main",
            "sub": "repo:your-org/your-repository:environment:dev",
            "workflow_ref": "your-org/your-repository/.github/workflows/gcp-auth.yml@refs/heads/main",
            "event_name": "workflow_dispatch", "runner_environment": "github-hosted",
        }
        self.assertEqual(auth.claims(self.config), expected)
        for key, value in expected.items():
            self.assertIn(f"assertion.{key} == '{value}'", condition)
        self.assertNotIn(" || ", condition)

    def test_cel_injection_and_unknown_fields_rejected(self):
        for key in ("environment", "repository", "branch"):
            config = copy.deepcopy(self.config)
            config[key] = "main' || true || '"
            with self.assertRaises(ValueError): auth.validate_config(config)
        with self.assertRaises(ValueError): auth.validate_config({**self.config, "unexpected": "field"})

    def test_no_keys_or_resource_roles_in_planned_commands(self):
        commands = auth.planned_commands(self.config)
        for command in commands:
            self.assertIn("--project=your-existing-project", command)
            self.assertIn("--account=operator@example.com", command)
            self.assertNotIn("--set-as-default", command)
            self.assertNotIn("keys", command)
        grants = [value for command in commands for value in command if value.startswith("--role=")]
        self.assertEqual(grants, ["--role=roles/iam.workloadIdentityUser"])

    def test_verify_provider_rejects_broader_trust(self):
        auth.verify_provider(self.config, self.provider)
        for key, value in (("attributeCondition", "true"), ("disabled", True), ("state", "DELETED")):
            with self.assertRaises(ValueError):
                auth.verify_provider(self.config, {**self.provider, key: value})
        altered = copy.deepcopy(self.provider)
        altered["oidc"]["allowedAudiences"] = ["arbitrary-audience"]
        with self.assertRaises(ValueError): auth.verify_provider(self.config, altered)

    def test_existing_bindings_must_match_exactly(self):
        self.assertFalse(auth.verify_bindings(self.config, {}))
        self.assertTrue(auth.verify_bindings(self.config, {"bindings": [self.binding]}))
        with self.assertRaises(ValueError):
            auth.verify_bindings(self.config, {"bindings": [self.binding, {"role": "roles/owner", "members": []}]})

    def test_repo_mismatch_stops_before_any_write(self):
        self.repo["id"] = 999
        with patch.object(auth, "read", return_value=self.project), \
                patch.object(auth.subprocess, "check_output", return_value=json.dumps(self.repo)), \
                patch.object(auth.subprocess, "run") as run:
            with self.assertRaises(ValueError): auth.execute(self.config)
            run.assert_not_called()

    def test_matching_existing_resources_do_not_recreate_or_rebind(self):
        names = auth.coordinates(self.config)
        pool = {"name": names["pool"], "description": auth.DESCRIPTION, "state": "ACTIVE"}
        account = {"email": names["service_account"], "description": auth.DESCRIPTION}
        policy = {"bindings": [self.binding]}
        responses = [self.project, [pool], pool, [self.provider], self.provider,
                     [account], account, {}, [], policy, policy]
        with patch.object(auth, "read", side_effect=responses), \
                patch.object(auth.subprocess, "check_output", return_value=json.dumps(self.repo)), \
                patch.object(auth.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            auth.execute(self.config)
        self.assertEqual([call.args[0] for call in run.call_args_list], auth.planned_commands(self.config)[:1])

    def test_new_resources_are_verified(self):
        names = auth.coordinates(self.config)
        pool = {"name": names["pool"], "description": auth.DESCRIPTION, "state": "ACTIVE"}
        account = {"email": names["service_account"], "description": auth.DESCRIPTION}
        responses = [self.project, [], pool, [], self.provider, [], account, {}, [], {}, {"bindings": [self.binding]}]
        with patch.object(auth, "read", side_effect=responses), \
                patch.object(auth.subprocess, "check_output", return_value=json.dumps(self.repo)), \
                patch.object(auth.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            auth.execute(self.config)
        self.assertEqual([call.args[0] for call in run.call_args_list], auth.planned_commands(self.config))

    def test_other_provider_in_pool_is_rejected(self):
        names = auth.coordinates(self.config)
        pool = {"name": names["pool"], "description": auth.DESCRIPTION, "state": "ACTIVE"}
        responses = [self.project, [pool], pool, [self.provider, {"name": names["pool"] + "/providers/untrusted"}]]
        with patch.object(auth, "read", side_effect=responses), \
                patch.object(auth.subprocess, "check_output", return_value=json.dumps(self.repo)), \
                patch.object(auth.subprocess, "run") as run:
            with self.assertRaises(ValueError): auth.execute(self.config)
        self.assertEqual(run.call_count, 1)  # API enablement only.

    def test_workflow_is_opt_in_and_auth_only(self):
        workflow = (ROOT.parent / ".github/workflows/gcp-auth.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("vars.GCP_AUTH_ENABLED == 'true'", workflow)
        self.assertIn("create_credentials_file: false", workflow)
        self.assertIn("access_token_lifetime: 300s", workflow)
        for forbidden in ("pull_request", "terraform apply", "terraform plan", "credentials_json:", "mupt-ai"):
            self.assertNotIn(forbidden, workflow)
        self.assertIn("id-token: write", workflow)
        self.assertIn("github.event.repository.default_branch", workflow)

    def test_new_iam_resource_not_found_read_is_retried(self):
        error = auth.subprocess.CalledProcessError(1, ["gcloud"], stderr="NOT_FOUND: newly created resource")
        with patch.object(auth, "read", side_effect=[error, self.provider]) as read, \
                patch.object(auth.time, "sleep") as sleep:
            self.assertEqual(auth.read_after_create(self.config, "describe", fresh=True), self.provider)
            self.assertEqual(read.call_count, 2)
            sleep.assert_called_once_with(1)

    def test_permission_failure_is_never_retried(self):
        error = auth.subprocess.CalledProcessError(1, ["gcloud"], stderr="PERMISSION_DENIED")
        with patch.object(auth, "read", side_effect=error) as read, patch.object(auth.time, "sleep") as sleep:
            with self.assertRaises(auth.subprocess.CalledProcessError):
                auth.read_after_create(self.config, "describe", fresh=True)
            self.assertEqual(read.call_count, 1)
            sleep.assert_not_called()

    def test_existing_resource_failure_is_never_retried(self):
        error = auth.subprocess.CalledProcessError(1, ["gcloud"], stderr="NOT_FOUND:")
        with patch.object(auth, "read", side_effect=error) as read:
            with self.assertRaises(auth.subprocess.CalledProcessError):
                auth.read_after_create(self.config, "describe", fresh=False)
            self.assertEqual(read.call_count, 1)
