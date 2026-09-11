import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from infra.ci import contracts, terraform
from infra.tests.test_terraform_ci import context_env, sample_plan


class FakeRunner:
    def __init__(self, directory, ctx, blob, record, decoded):
        self.ctx = ctx
        self.directory = directory
        self.root = directory / 'root'
        self.root.mkdir()
        (self.root / '.terraform.lock.hcl').write_bytes(b'lock')
        self.blob, self.record, self.decoded = blob, record, decoded
        self.calls = []
        self.log = directory / 'private.log'

    def run(self, args):
        self.calls.append(args)
        if args[:3] != ['gcloud', 'storage', 'cp']:
            raise AssertionError(args)
        destination = Path(args[4])
        destination.write_bytes(contracts.canonical(self.record) if 'manifest.json#' in args[3] else self.blob)

    def initialize(self, inputs):
        self.calls.append(['initialize'])

    def decode_plan(self, path):
        return self.decoded

    def terraform(self, *args, **kwargs):
        self.calls.append(['terraform', *args])
        if args[0] == 'output':
            return json.dumps({'project_id': self.ctx['project'], 'environment': self.ctx['environment']}).encode()

    def upload(self, path, name):
        self.calls.append(['upload', name])
        return '99'


class ApplyReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.ctx, self.inputs = contracts.context(context_env())
        self.decoded = sample_plan()
        self.blob = b'opaque terraform plan'
        self.record = contracts.manifest(self.ctx, self.blob, '41', b'lock', contracts.inspect_plan(self.decoded, self.ctx))

    def execute(self, record=None, blob=None, decoded=None):
        record = record if record is not None else self.record
        runner = FakeRunner(self.directory, self.ctx, self.blob if blob is None else blob,
                            record, decoded if decoded is not None else self.decoded)
        self.runner = runner
        env = {'PLAN_MANIFEST_GENERATION': '42', 'PLAN_MANIFEST_SHA256': contracts.digest(contracts.canonical(record)),
               'GITHUB_STEP_SUMMARY': str(self.directory / 'summary')}
        with patch.dict(os.environ, env), patch.object(terraform, 'verify_resources'):
            terraform.apply(runner, self.inputs)
        return runner

    def assert_no_apply(self):
        self.assertFalse(any(call[:2] == ['terraform', 'apply'] for call in self.runner.calls))

    def test_only_the_verified_saved_plan_is_applied(self):
        runner = self.execute()
        calls = [call for call in runner.calls if call[:2] == ['terraform', 'apply']]
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0][-1].endswith('/terraform.tfplan'))
        self.assertNotIn('-auto-approve', calls[0])
        self.assertFalse(any(arg.startswith('-var-file') for arg in calls[0]))
        self.assertFalse(any(call[:2] == ['terraform', 'plan'] for call in runner.calls))

    def test_changed_plan_bytes_never_reach_apply(self):
        with self.assertRaises(ValueError): self.execute(blob=b'tampered')
        self.assert_no_apply()
        self.assertNotIn(['initialize'], self.runner.calls)

    def test_wrong_environment_receipt_never_reaches_apply(self):
        with self.assertRaises(ValueError): self.execute(record={**self.record, 'environment': 'prod'})
        self.assert_no_apply()

    def test_rerun_attempt_cannot_reuse_prior_plan(self):
        with self.assertRaises(ValueError): self.execute(record={**self.record, 'run_attempt': '99'})
        self.assert_no_apply()

    def test_expired_plan_never_reaches_apply(self):
        with self.assertRaises(ValueError): self.execute(record={**self.record, 'created_at': 1})
        self.assert_no_apply()

    def test_delete_action_never_reaches_apply(self):
        changed = sample_plan()
        changed['resource_changes'][0]['change']['actions'] = ['delete']
        with self.assertRaises(ValueError): self.execute(decoded=changed)
        self.assert_no_apply()


class CheckoutTests(unittest.TestCase):
    def test_untracked_source_is_rejected_before_backend_access(self):
        ctx, inputs = contracts.context(context_env())
        with tempfile.TemporaryDirectory() as directory:
            runner = terraform.Runner(ctx, Path(directory))
            with patch.object(runner, 'run', side_effect=[ctx['source_sha'].encode(), b'?? infra/injected.tf\n']) as run:
                with self.assertRaises(ValueError): runner.initialize(inputs)
                self.assertEqual(run.call_count, 2)

    def test_incorrect_checkout_sha_is_rejected(self):
        ctx, inputs = contracts.context(context_env())
        with tempfile.TemporaryDirectory() as directory:
            runner = terraform.Runner(ctx, Path(directory))
            with patch.object(runner, 'run', return_value=b'b' * 40) as run:
                with self.assertRaises(ValueError): runner.initialize(inputs)
                self.assertEqual(run.call_count, 1)


class ResourceSmokeTests(unittest.TestCase):
    def test_vm_and_bucket_status_checked_without_any_mutations(self):
        ctx, _ = contracts.context(context_env())
        outputs = {'instance': 'selfbench-dev', 'zone': 'us-central1-a', 'artifact_bucket': 'community-artifacts', 'database': None}
        responses = [{'projectNumber': '123'}, {'status': 'RUNNING'},
                     {'projectNumber': '123', 'iamConfiguration': {'publicAccessPrevention': 'enforced',
                       'uniformBucketLevelAccess': {'enabled': True}}, 'versioning': {'enabled': True}}]
        with tempfile.TemporaryDirectory() as directory:
            runner = terraform.Runner(ctx, Path(directory))
            with patch.object(runner, 'run', side_effect=[json.dumps(value).encode() for value in responses]) as run:
                terraform.verify_resources(runner, outputs)
                self.assertTrue(all('describe' in call.args[0] for call in run.call_args_list))

    def test_stopped_vm_is_not_reported_ready(self):
        ctx, _ = contracts.context(context_env())
        outputs = {'instance': 'selfbench-dev', 'zone': 'us-central1-a', 'artifact_bucket': 'community-artifacts'}
        with tempfile.TemporaryDirectory() as directory:
            runner = terraform.Runner(ctx, Path(directory))
            with patch.object(runner, 'run', side_effect=[b'{"projectNumber":"123"}', b'{"status":"TERMINATED"}']):
                with self.assertRaises(ValueError): terraform.verify_resources(runner, outputs)
