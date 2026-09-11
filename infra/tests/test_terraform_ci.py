import copy
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from infra.bootstrap import github_auth
from infra.bootstrap import terraform_ci as bootstrap
from infra.ci import approval, contracts

ROOT = Path(__file__).parents[1]


def context_env():
    return {"TF_ENVIRONMENT": "dev", "GCP_PROJECT_ID": "community-infra", "TF_STATE_BUCKET": "community-state",
            "TF_PLAN_BUCKET": "community-plans", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_SHA": "a" * 40, "GITHUB_REPOSITORY": "community/tool", "GITHUB_EVENT_NAME": "push",
            "GITHUB_REF": "refs/heads/main", "GITHUB_DEFAULT_BRANCH": "main", "RUNNER_ENVIRONMENT": "github-hosted",
            "TF_INPUTS_JSON": json.dumps({"project_id": "community-infra", "region": "us-central1", "zone": "us-central1-a",
                                          "boot_image": "image", "operator_members": []})}


def sample_plan():
    return {"terraform_version": "1.14.2", "format_version": "1.2", "complete": True, "resource_changes": [
        {"mode": "managed", "type": "google_compute_instance", "address": "module.selfbench.google_compute_instance.app",
         "change": {"actions": ["create"], "after": {"project": "community-infra", "machine_type": "e2-standard-2"}}}]}


class ContractsTests(unittest.TestCase):
    def setUp(self):
        self.env = context_env()
        self.ctx, self.inputs = contracts.context(self.env)
        self.plan = sample_plan()

    def test_valid_context_and_plan(self):
        self.assertEqual(contracts.inspect_plan(self.plan, self.ctx)["counts"], {"create": 1, "update": 0, "delete": 0})
        self.assertIn('/dev/123/1/' + 'a' * 40, contracts.object_uri(self.ctx, "terraform.tfplan"))

    def test_untrusted_events_branches_and_runners_rejected(self):
        for key, value in (("GITHUB_EVENT_NAME", "pull_request"), ("GITHUB_EVENT_NAME", "pull_request_target"),
                           ("GITHUB_REF", "refs/pull/7/merge"), ("RUNNER_ENVIRONMENT", "self-hosted")):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                contracts.context({**self.env, key: value})

    def test_prod_cannot_follow_push(self):
        with self.assertRaises(ValueError): contracts.context({**self.env, "TF_ENVIRONMENT": "prod"})
        contracts.context({**self.env, "TF_ENVIRONMENT": "prod", "GITHUB_EVENT_NAME": "release", "GITHUB_REF": "refs/tags/v1", "RELEASE_PRERELEASE": "false", "RELEASE_DRAFT": "false"})

    def test_input_project_and_secret_keys_rejected(self):
        for inputs in ({**self.inputs, "project_id": "other-project"}, {**self.inputs, "database_password": "secret"}):
            with self.assertRaises(ValueError): contracts.context({**self.env, "TF_INPUTS_JSON": json.dumps(inputs)})

    def test_buckets_and_uri_generations_fail_closed(self):
        with self.assertRaises(ValueError): contracts.context({**self.env, "TF_PLAN_BUCKET": "community-state"})
        for generation in ("", "latest", "12\nvalue=evil", "../path"):
            with self.assertRaises(ValueError): contracts.object_uri(self.ctx, "terraform.tfplan", generation)
        with self.assertRaises(ValueError): contracts.object_uri(self.ctx, "../../credentials")

    def test_destructive_replacement_and_cross_project_plans_rejected(self):
        for actions in (["delete"], ["delete", "create"], ["create", "delete"], ["forget"]):
            plan = copy.deepcopy(self.plan)
            plan['resource_changes'][0]['change']['actions'] = actions
            with self.assertRaises(ValueError): contracts.inspect_plan(plan, self.ctx)
        self.plan['resource_changes'][0]['change']['after']['project'] = 'other-project'
        with self.assertRaises(ValueError): contracts.inspect_plan(self.plan, self.ctx)

    def test_unknown_resources_or_incomplete_plans_rejected(self):
        for key, value in (("terraform_version", "1.9.0"), ("complete", False), ("errored", True), ("resource_changes", None)):
            with self.assertRaises(ValueError): contracts.inspect_plan({**self.plan, key: value}, self.ctx)
        self.plan['resource_changes'][0]['type'] = 'google_organization_iam_member'
        with self.assertRaises(ValueError): contracts.inspect_plan(self.plan, self.ctx)

    def test_noop_does_not_request_apply(self):
        self.plan['resource_changes'][0]['change']['actions'] = ['no-op']
        self.assertFalse(contracts.inspect_plan(self.plan, self.ctx)['has_changes'])

    def test_manifest_binds_every_context_field(self):
        record = contracts.manifest(self.ctx, b'plan', '42', b'lock', {}, now=10000)
        contracts.verify_manifest(record, self.ctx, b'lock', now=10001)
        for key in self.ctx:
            altered = {**record, key: 'different'}
            with self.subTest(key=key), self.assertRaises(ValueError):
                contracts.verify_manifest(altered, self.ctx, b'lock', now=10001)
        with self.assertRaises(ValueError): contracts.verify_manifest(record, self.ctx, b'new-lock', now=10001)
        with self.assertRaises(ValueError): contracts.verify_manifest(record, self.ctx, b'lock', now=10000+86401)
        with self.assertRaises(ValueError): contracts.verify_manifest(record, self.ctx, b'lock', now=9999)

    def test_apply_logs_have_separate_prefix(self):
        self.assertIn('/apply-logs/terraform/', contracts.object_uri(self.ctx, 'apply.log'))
        self.assertNotIn('/apply-logs/', contracts.object_uri(self.ctx, 'manifest.json'))


class BootstrapPolicyTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / 'bootstrap/terraform-ci.json.example').read_text())
        bootstrap.validate_config(self.config)

    def test_generic_project_and_distinct_stage_identities(self):
        self.config['project_id'] = 'community-infra'
        bootstrap.validate_config(self.config)
        plan = bootstrap.identity(self.config, 'plan')
        apply = bootstrap.identity(self.config, 'apply')
        self.assertNotEqual(plan['service_account_id'], apply['service_account_id'])
        self.assertNotEqual(plan['pool_id'], apply['pool_id'])
        self.assertEqual(plan['environment'], 'dev')
        self.assertEqual(apply['environment'], 'dev')

    def test_trust_events_exclude_prs_and_prod_push(self):
        self.assertEqual(bootstrap.events(self.config), ('push', 'workflow_dispatch'))
        self.config['environment'] = 'prod'
        self.assertEqual(bootstrap.events(self.config), ('release',))
        for events in (('pull_request',), ('pull_request_target',), ()):
            with self.assertRaises(ValueError): github_auth.condition(bootstrap.identity(self.config, 'plan'), events)

    def test_plan_role_has_no_resource_writes_or_secret_access(self):
        roles = bootstrap.permissions()
        for permission in roles['plan']:
            self.assertIn(permission.rsplit('.', 1)[-1], ('get', 'list', 'getIamPolicy', 'use'))
        for permission in roles['plan'] + roles['apply']:
            self.assertNotIn(permission, ('secretmanager.versions.access', 'iam.serviceAccountKeys.create'))
            self.assertFalse(permission.startswith(('billing.', 'resourcemanager.organizations.')))
        self.assertIn('resourcemanager.projects.setIamPolicy', roles['apply'])  # Explicitly privileged within project.

    def test_planner_lock_condition_cannot_match_state_file(self):
        condition = bootstrap.state_lock_condition(self.config)
        self.assertEqual(condition['expression'], "resource.name == 'projects/_/buckets/your-existing-state-bucket/objects/selfbench/dev/default.tflock'")
        self.assertNotIn('startsWith', condition['expression'])
        self.assertNotIn('default.tfstate', condition['expression'])

    def test_bucket_binding_refuses_different_condition(self):
        policy = {'bindings': [{'role': 'custom-lock-role', 'members': ['serviceAccount:plan'], 'condition': {'expression': 'true'}}]}
        with patch.object(bootstrap.auth, 'read', return_value=policy), patch.object(bootstrap, 'mutate') as mutate:
            with self.assertRaises(ValueError):
                bootstrap.ensure_bucket_binding(self.config, 'bucket', 'serviceAccount:plan', 'custom-lock-role', {'expression': 'false'})
            mutate.assert_not_called()


class ApprovalTests(unittest.TestCase):
    def test_requires_reviewers_and_exact_branch_not_tags(self):
        environment = {'deployment_branch_policy': {'protected_branches': False, 'custom_branch_policies': True},
                       'protection_rules': [{'type': 'required_reviewers', 'reviewers': [{'id': 123}]}]}
        policy = {'total_count': 1, 'branch_policies': [{'name': 'main', 'type': 'branch'}]}
        approval.verify(environment, policy, 'main')
        for altered in ({**environment, 'protection_rules': []}, {**environment, 'deployment_branch_policy': None}):
            with self.assertRaises(ValueError): approval.verify(altered, policy, 'main')
        for name, kind in (('*', 'branch'), ('main', 'tag'), ('other', 'branch')):
            with self.assertRaises(ValueError): approval.verify(environment, {'total_count': 1, 'branch_policies': [{'name': name, 'type': kind}]}, 'main')
