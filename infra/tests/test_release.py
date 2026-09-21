import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("check_release", Path(__file__).parents[1] / "runtime/check_release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
ROOT = Path(__file__).parents[1]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.values = {
            "shared": {
                "SELFBENCH_API_HOST": "0.0.0.0", "SELFBENCH_API_PORT": "8080",
                "SELFBENCH_ARTIFACT_BACKEND": "gcs", "SELFBENCH_GCS_BUCKET": "selfbench-dev-test-artifacts",
                "SELFBENCH_GCS_PREFIX": "selfbench", "SELFBENCH_TEMPORAL_TLS": "true",
                "SELFBENCH_TEMPORAL_ADDRESS": "test.tmprl.cloud:7233",
                "SELFBENCH_TEMPORAL_NAMESPACE": "selfbench-dev.test", "SELFBENCH_TEMPORAL_API_KEY": "fake-test-key",
                "SELFBENCH_TASK_QUEUE": "selfbench-dev", "SELFBENCH_EVAL_TASK_QUEUE": "selfbench-dev",
                "SELFBENCH_GENERATION_TASK_QUEUE": "selfbench-dev",
                "SELFBENCH_EXECUTION_BACKEND": "modal", "SELFBENCH_HARBOR_ENVIRONMENT": "modal",
                "SELFBENCH_DATABASE_URL": "postgres://test:fake@db.test/selfbench?sslmode=require",
                "SELFBENCH_EVAL_CREDENTIAL_KEY": "a" * 64,
            },
            "api": {"SELFBENCH_API_TOKEN": "a" * 40, "GITHUB_OAUTH_CLIENT_ID": "fake-client",
                    "GITHUB_OAUTH_CLIENT_SECRET": "fake-client-secret", "SELFBENCH_SESSION_SECRET": "b" * 40,
                    "SELFBENCH_PUBLIC_URL": "https://dev.example.com"},
            "worker": {"SELFBENCH_API_TOKEN": "c" * 40},
        }
        self.coordinates = {"SELFBENCH_ENVIRONMENT": "dev", "SELFBENCH_ACTIVITY_CONCURRENCY": "8",
                            "SELFBENCH_IMAGE": "us-central1-docker.pkg.dev/selfbench-dev-test/selfbench/selfbench@sha256:" + "a" * 64}
        for role in self.values:
            self.coordinates[f"SELFBENCH_{role.upper()}_ENV_FILE"] = str(self.directory / f"{role}.env")
        self.release_path = self.directory / "release.env"
        self.write()

    def write(self):
        for role, values in {**self.values, "release": self.coordinates}.items():
            path = self.directory / f"{role}.env"
            path.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
            path.chmod(0o600)

    def validate(self):
        self.write()
        return release.validate("dev", "selfbench-dev-test", self.release_path)

    def test_valid_release_does_not_disclose_secrets(self):
        result = self.validate()
        self.assertEqual(result["project"], "selfbench-dev-test")
        self.assertNotIn("fake-model", json.dumps(result))

    def test_release_concurrency_is_bounded(self):
        for value in ("1", "8", "20", "99", "100"):
            self.coordinates["SELFBENCH_ACTIVITY_CONCURRENCY"] = value
            self.assertEqual(self.validate()["environment"], "dev")
        for value in ("0", "101", "1000", "-1", "8.0", "08", "010"):
            self.coordinates["SELFBENCH_ACTIVITY_CONCURRENCY"] = value
            with self.assertRaises(ValueError): self.validate()

    def test_production_accepts_one_hundred_without_secret_concurrency(self):
        self.coordinates = {key:value.replace('selfbench-dev', 'selfbench-prod')
                            for key,value in self.coordinates.items()}
        self.coordinates['SELFBENCH_ENVIRONMENT'] = 'prod'
        self.values['shared'] = {key:value.replace('selfbench-dev', 'selfbench-prod')
                                 for key,value in self.values['shared'].items()}
        self.write()
        self.assertEqual(release.validate('prod','selfbench-prod-test',self.release_path)['environment'],'prod')
        self.coordinates['SELFBENCH_ACTIVITY_CONCURRENCY'] = '100'
        self.write()
        self.assertEqual(release.validate('prod','selfbench-prod-test',self.release_path)['environment'],'prod')
        self.coordinates['SELFBENCH_ACTIVITY_CONCURRENCY'] = '101'
        self.write()
        with self.assertRaises(ValueError):release.validate('prod','selfbench-prod-test',self.release_path)

    def test_missing_runtime_setting_cannot_fall_back_to_legacy_secret(self):
        self.values['shared']['SELFBENCH_ACTIVITY_CONCURRENCY'] = '1'
        del self.coordinates['SELFBENCH_ACTIVITY_CONCURRENCY']
        with self.assertRaises(ValueError):self.validate()

    def test_cross_environment_image_rejected(self):
        self.coordinates["SELFBENCH_IMAGE"] = self.coordinates["SELFBENCH_IMAGE"].replace("selfbench-dev-test", "selfbench-prod-test")
        with self.assertRaises(ValueError): self.validate()

    def test_byok_worker_needs_no_global_provider_credentials(self):
        self.values["worker"] = {"SELFBENCH_API_TOKEN": "c" * 40}
        self.assertEqual(self.validate()["environment"], "dev")

    def test_worker_token_is_still_required(self):
        del self.values["worker"]["SELFBENCH_API_TOKEN"]
        with self.assertRaises(ValueError): self.validate()

    def test_unknown_worker_keys_rejected(self):
        self.values["worker"]["UNKNOWN_SECRET"] = "fake-secret"
        with self.assertRaises(ValueError): self.validate()

    def test_mutable_image_rejected(self):
        self.coordinates["SELFBENCH_IMAGE"] = "us-central1-docker.pkg.dev/selfbench-dev-test/selfbench/selfbench:latest"
        with self.assertRaises(ValueError): self.validate()

    def test_orphaned_evaluation_queue_rejected(self):
        self.values["shared"]["SELFBENCH_EVAL_TASK_QUEUE"] = "selfbench-evaluations"
        with self.assertRaises(ValueError): self.validate()

    def test_missing_generation_queue_rejected(self):
        del self.values["shared"]["SELFBENCH_GENERATION_TASK_QUEUE"]
        with self.assertRaises(ValueError): self.validate()

    def test_orphaned_generation_queue_rejected(self):
        self.values["shared"]["SELFBENCH_GENERATION_TASK_QUEUE"] = "selfbench-generation"
        with self.assertRaises(ValueError): self.validate()

    def test_dev_cannot_use_prod_namespace(self):
        self.values["shared"]["SELFBENCH_TEMPORAL_NAMESPACE"] = "selfbench-prod.test"
        with self.assertRaises(ValueError): self.validate()

    def test_optional_managed_keys_accepted(self):
        self.values["shared"]["SELFBENCH_MANAGED_E2B_API_KEY"] = "fake-e2b"
        self.values["shared"]["SELFBENCH_MANAGED_OPENROUTER_API_KEY"] = "fake-openrouter"
        self.validate()

    def test_billing_policy_keys_accepted_shared(self):
        self.values["shared"]["SELFBENCH_BILLING_UNIT_SCALE"] = "10000000"
        self.values["shared"]["SELFBENCH_BILLING_MARKUP_BPS"] = "0"
        self.values["shared"]["SELFBENCH_STRIPE_METER_EVENT_NAME"] = "selfbench_managed_usage"
        self.validate()

    def test_stripe_billing_secrets_accepted_together(self):
        self.values["api"]["SELFBENCH_STRIPE_SECRET_KEY"] = "sk_live_fake"
        self.values["api"]["SELFBENCH_STRIPE_PRICE_ID"] = "price_fake"
        self.values["api"]["SELFBENCH_STRIPE_WEBHOOK_SECRET"] = "whsec_fake"
        self.validate()

    def test_partial_stripe_billing_secrets_rejected(self):
        self.values["api"]["SELFBENCH_STRIPE_SECRET_KEY"] = "sk_live_fake"
        with self.assertRaises(ValueError): self.validate()

    def test_stripe_secrets_rejected_on_worker(self):
        self.values["worker"]["SELFBENCH_STRIPE_SECRET_KEY"] = "sk_live_fake"
        with self.assertRaises(ValueError): self.validate()

    def test_allowed_github_orgs_accepted_on_api(self):
        self.values["api"]["SELFBENCH_ALLOWED_GITHUB_ORGS"] = "mupt-ai"
        self.validate()

    def test_allowed_github_orgs_rejected_on_worker(self):
        self.values["worker"]["SELFBENCH_ALLOWED_GITHUB_ORGS"] = "mupt-ai"
        with self.assertRaises(ValueError): self.validate()

    def test_managed_e2b_key_on_api_rejected(self):
        self.values["api"]["SELFBENCH_MANAGED_E2B_API_KEY"] = "fake-e2b"
        with self.assertRaises(ValueError): self.validate()

    def test_api_cannot_receive_model_credentials(self):
        self.values["api"]["OPENAI_API_KEY"] = "fake-model"
        with self.assertRaises(ValueError): self.validate()

    def test_worker_cannot_receive_oauth_secret(self):
        self.values["worker"]["GITHUB_OAUTH_CLIENT_SECRET"] = "fake-secret"
        with self.assertRaises(ValueError): self.validate()

    def test_shared_api_bearer_rejected(self):
        self.values["worker"]["SELFBENCH_API_TOKEN"] = self.values["api"]["SELFBENCH_API_TOKEN"]
        with self.assertRaises(ValueError): self.validate()

    def test_missing_secret_permissions_rejected(self):
        (self.directory / "api.env").chmod(0o644)
        with self.assertRaises(ValueError): release.validate("dev", "selfbench-dev-test", self.release_path)

    def test_duplicate_keys_rejected(self):
        with (self.directory / "api.env").open("a") as file: file.write("SELFBENCH_API_TOKEN=duplicate\n")
        with self.assertRaises(ValueError): release.validate("dev", "selfbench-dev-test", self.release_path)

    def test_tls_disabled_rejected(self):
        self.values["shared"]["SELFBENCH_TEMPORAL_TLS"] = "false"
        with self.assertRaises(ValueError): self.validate()

    def test_db_sslmode_substring_bypass_rejected(self):
        self.values["shared"]["SELFBENCH_DATABASE_URL"] += "-not-really"
        with self.assertRaises(ValueError): self.validate()

    def test_compose_shape_and_literal_secret_values(self):
        # Existing pinned secret versions must not silently override new runtime configuration.
        self.values['shared']['SELFBENCH_ACTIVITY_CONCURRENCY'] = '1'
        self.validate()
        result = subprocess.run(["docker", "compose", "--env-file", str(self.release_path),
                                 "-f", str(ROOT / "runtime/compose.yaml"), "config", "--format=json"],
                                check=True, capture_output=True, text=True,
                                env={key: value for key, value in os.environ.items() if not key.startswith("SELFBENCH_")})
        config = json.loads(result.stdout)
        self.assertEqual(set(config["services"]), {"api", "worker"})
        api, worker = config["services"]["api"], config["services"]["worker"]
        self.assertEqual(api["image"], worker["image"])
        self.assertEqual(worker["environment"]["SELFBENCH_ACTIVITY_CONCURRENCY"], "8")
        # Compose escapes dollars in its serialized output so round-tripping is safe.
        self.assertNotIn("OPENAI_API_KEY", worker["environment"])
        self.assertNotIn("MODAL_TOKEN_ID", worker["environment"])
        self.assertNotIn("GH_TOKEN", worker["environment"])
        self.assertNotIn("GITHUB_OAUTH_CLIENT_SECRET", worker["environment"])
        self.assertFalse(worker.get("ports"))
        self.assertFalse(worker.get("volumes"))
        self.assertEqual(api["ports"][0]["host_ip"], "127.0.0.1")
