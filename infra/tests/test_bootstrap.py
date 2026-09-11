import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("bootstrap", Path(__file__).parents[1] / "bootstrap/bootstrap.py")
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.argv = ["--environment", "dev", "--project", "selfbench-dev-test",
                     "--account", "operator@example.com", "--billing-account", "ABC123-DEF456-ABC789",
                     "--region", "us-central1", "--state-bucket", "selfbench-dev-test-tfstate",
                     "--folder", "123"]
        self.args = bootstrap.parse_args(self.argv)
        self.project = {"projectId": self.args.project, "projectNumber": "1234", "lifecycleState": "ACTIVE",
                        "labels": {"application": "selfbench", "environment": "dev"},
                        "parent": {"type": "folder", "id": "123"}}
        self.billing = {"billingAccountName": "billingAccounts/ABC123-DEF456-ABC789", "billingEnabled": True}
        self.bucket = {"name": self.args.state_bucket, "projectNumber": "1234", "location": "US-CENTRAL1",
                       "iamConfiguration": {"uniformBucketLevelAccess": {"enabled": True},
                                            "publicAccessPrevention": "enforced"},
                       "versioning": {"enabled": True}}

    def test_default_is_completely_offline(self):
        with patch.object(bootstrap.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            bootstrap.main(self.argv)
            run.assert_not_called()

    def test_no_ambient_project_or_account_mutation(self):
        for command in bootstrap.planned_commands(self.args):
            self.assertIn("--account=operator@example.com", command)
            self.assertNotIn("--set-as-default", command)
            self.assertNotIn("config", command)

    def test_project_must_match_environment(self):
        argv = self.argv.copy()
        argv[3] = "selfbench-prod-test"
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            bootstrap.parse_args(argv)

    def test_bucket_must_match_project(self):
        argv = self.argv.copy()
        argv[11] = "some-other-tfstate"
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            bootstrap.parse_args(argv)

    def test_refuses_adoption(self):
        self.project["labels"] = {}
        with patch.object(bootstrap, "read_json", return_value=[self.project]), \
                patch.object(bootstrap.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                bootstrap.execute(self.args)
            run.assert_not_called()

    def test_refuses_parent_mismatch(self):
        self.project["parent"]["id"] = "999"
        with self.assertRaises(ValueError):
            bootstrap.verify_project(self.args, self.project)

    def test_refuses_billing_relink(self):
        self.billing["billingAccountName"] = "billingAccounts/OTHER"
        with patch.object(bootstrap, "read_json", side_effect=[[self.project], self.project, self.billing]), \
                patch.object(bootstrap.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                bootstrap.execute(self.args)
            run.assert_not_called()

    def test_existing_matching_resources_resume_without_recreation(self):
        responses = [[self.project], self.project, self.billing, [self.bucket], self.bucket, self.bucket]
        with patch.object(bootstrap, "read_json", side_effect=responses), \
                patch.object(bootstrap.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            bootstrap.execute(self.args)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands, [bootstrap.planned_commands(self.args)[2], bootstrap.planned_commands(self.args)[4]])

    def test_refuses_cross_project_bucket(self):
        self.bucket["projectNumber"] = "9999"
        responses = [[self.project], self.project, self.billing, [self.bucket], self.bucket]
        with patch.object(bootstrap, "read_json", side_effect=responses), \
                patch.object(bootstrap.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                bootstrap.execute(self.args)
            self.assertEqual(run.call_count, 1)  # Only API enablement, no bucket update.

    def test_missing_security_fields_fail_closed(self):
        del self.bucket["iamConfiguration"]
        responses = [[self.project], self.project, self.billing, [self.bucket], self.bucket]
        with patch.object(bootstrap, "read_json", side_effect=responses), \
                patch.object(bootstrap.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                bootstrap.execute(self.args)
            self.assertEqual(run.call_count, 1)

    def test_new_project_and_bucket_have_poststate_checks(self):
        responses = [[], self.project, {}, self.billing, [], self.bucket, self.bucket]
        with patch.object(bootstrap, "read_json", side_effect=responses), \
                patch.object(bootstrap.subprocess, "run") as run, contextlib.redirect_stdout(io.StringIO()):
            bootstrap.execute(self.args)
        self.assertEqual([call.args[0] for call in run.call_args_list], bootstrap.planned_commands(self.args))

    def test_failed_billing_poststate_stops_before_storage(self):
        responses = [[], self.project, {}, {}]
        with patch.object(bootstrap, "read_json", side_effect=responses), \
                patch.object(bootstrap.subprocess, "run") as run:
            with self.assertRaises(ValueError):
                bootstrap.execute(self.args)
        self.assertEqual([call.args[0] for call in run.call_args_list], bootstrap.planned_commands(self.args)[:2])
