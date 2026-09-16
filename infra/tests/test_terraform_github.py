"""GitHub environment provisioning must preserve the production apply gate."""
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from infra.bootstrap import terraform_github


class GithubEnvironmentTests(unittest.TestCase):
    def configure(self, target):
        config = json.loads((Path(__file__).parents[1] / 'bootstrap/terraform-ci.json.example').read_text())
        config['environment'] = target
        environments = {}
        variables = {}
        policies = {}

        def api(endpoint, method='GET', data=None):
            base = f"repos/{config['repository']}"
            if endpoint == base:
                return {'id': config['repository_id'], 'owner': {'id': config['repository_owner_id']},
                        'default_branch': config['branch'], 'permissions': {'admin': True}}
            if endpoint == base + '/environments?per_page=100':
                return {'total_count': 0, 'environments': []}
            name, _, suffix = endpoint.removeprefix(base + '/environments/').partition('/')
            if not suffix:
                if method == 'PUT':
                    environments[name] = {
                        'deployment_branch_policy': data['deployment_branch_policy'],
                        'protection_rules': ([{'type': 'required_reviewers', 'reviewers': [
                            {'reviewer': {'id': user['id']}} for user in data['reviewers']]}]
                            if data['reviewers'] else [])}
                    variables[name] = {}
                    policies[name] = []
                return environments[name]
            if suffix.startswith('deployment-branch-policies'):
                if method == 'POST':
                    policies[name].append(data)
                return {'total_count': len(policies[name]), 'branch_policies': policies[name]}
            if suffix.startswith('variables'):
                return {'total_count': len(variables[name]), 'variables': [
                    {'name': key, 'value': value} for key, value in variables[name].items()]}
            raise AssertionError(endpoint)

        def set_variable(args, **kwargs):
            variables[args[args.index('--env') + 1]][args[3]] = args[args.index('--body') + 1]

        with patch.object(terraform_github, 'api', side_effect=api), \
                patch.object(terraform_github.subprocess, 'run', side_effect=set_variable):
            terraform_github.execute(config, {}, [123])
        return environments, variables, policies

    def test_prod_plan_is_ungated_and_apply_retains_review(self):
        environments, variables, policies = self.configure('prod')
        self.assertEqual(set(environments), {'prod-plan', 'prod'})
        self.assertEqual(environments['prod-plan']['protection_rules'], [])
        self.assertEqual(environments['prod']['protection_rules'][0]['reviewers'], [{'reviewer': {'id': 123}}])
        self.assertIn('GCP_PLAN_SERVICE_ACCOUNT', variables['prod-plan'])
        self.assertNotIn('GCP_APPLY_SERVICE_ACCOUNT', variables['prod-plan'])
        self.assertIn('GCP_APPLY_SERVICE_ACCOUNT', variables['prod'])
        for rules in policies.values():
            self.assertEqual(rules, [{'name': '*', 'type': 'tag'}])

    def test_dev_keeps_both_identities_in_one_environment(self):
        environments, variables, policies = self.configure('dev')
        self.assertEqual(set(environments), {'dev'})
        self.assertEqual(environments['dev']['protection_rules'], [])
        self.assertIn('GCP_PLAN_SERVICE_ACCOUNT', variables['dev'])
        self.assertIn('GCP_APPLY_SERVICE_ACCOUNT', variables['dev'])
        self.assertEqual(policies['dev'], [{'name': 'main', 'type': 'branch'}])
