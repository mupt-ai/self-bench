import json
import unittest
from pathlib import Path
from unittest.mock import Mock
from infra.ci import contracts, deploy, source
from infra.tests.test_terraform_ci import context_env


class DeployTests(unittest.TestCase):
    def test_missing_or_mutable_secret_versions_rejected(self):
        for value in ('{}', '{"shared":"latest","api":1,"worker":2}'):
            with self.assertRaises(ValueError): deploy.settings({'RUNTIME_SECRET_VERSIONS':value,'SELFBENCH_PUBLIC_URL':'https://example.com'})
        self.assertEqual(deploy.settings({'RUNTIME_SECRET_VERSIONS':'{"shared":1,"api":2,"worker":3}',
                                         'SELFBENCH_PUBLIC_URL':'https://example.com'})[0]['worker'],3)

    def test_prerelease_or_draft_cannot_deploy_prod(self):
        base={**context_env(),'TF_ENVIRONMENT':'prod','GITHUB_EVENT_NAME':'release','GITHUB_REF':'refs/tags/v1',
              'RELEASE_PRERELEASE':'false','RELEASE_DRAFT':'false'}
        contracts.context(base)
        for key in ('RELEASE_PRERELEASE','RELEASE_DRAFT'):
            with self.assertRaises(ValueError): contracts.context({**base,key:'true'})

    def test_release_checks_actual_event_tag_and_main_ancestry(self):
        env={**context_env(),'TF_ENVIRONMENT':'prod','GITHUB_EVENT_NAME':'release','GITHUB_REF':'refs/tags/v1'}
        event={'repository':{'default_branch':'main'},'action':'published',
               'release':{'draft':False,'prerelease':False,'tag_name':'v1'}}
        git=Mock(side_effect=['a'*40,'a'*40,''])
        source.verify_source(env,event,git)
        git.assert_any_call('merge-base','--is-ancestor','a'*40,'refs/remotes/origin/main')
        with self.assertRaises(ValueError):source.verify_source(env,event,Mock(side_effect=['a'*40,'b'*40]))
        with self.assertRaises(ValueError):source.verify_source(env,{**event,'action':'edited'},Mock(return_value='a'*40))

    def test_workflows_match_dari_trigger_structure(self):
        root=Path(__file__).parents[2]/'.github/workflows'
        dev=(root/'deploy-dev.yml').read_text();prod=(root/'deploy-prod.yml').read_text()
        shared=(root/'deploy-reusable.yml').read_text()
        self.assertIn('branches: [main]',dev)
        self.assertIn('types: [published]',prod)
        self.assertIn('!github.event.release.prerelease',prod)
        self.assertIn('deploy-reusable.yml',dev);self.assertIn('deploy-reusable.yml',prod)
        self.assertIn('bun run validate',shared)
        self.assertIn('python3 -m infra.ci.terraform plan',shared)
        self.assertIn('python3 -m infra.ci.terraform apply',shared)
        self.assertIn('python3 -m infra.ci.deploy',shared)
        self.assertLess(shared.index('Verify Apply Approval Protection'),shared.rindex('google-github-actions/auth@'))
        self.assertNotIn('pull_request_target',shared)
        self.assertNotIn('upload-artifact',shared)

    def test_production_cloud_trust_requires_reusable_release_workflow(self):
        from infra.bootstrap import github_auth, terraform_ci
        config=json.loads((Path(__file__).parents[1]/'bootstrap/terraform-ci.json.example').read_text())
        config['environment']='prod'
        policy=github_auth.condition(terraform_ci.identity(config,'apply'),terraform_ci.events(config))
        self.assertIn("assertion.event_name == 'release'",policy)
        self.assertIn("assertion.ref.startsWith('refs/tags/')",policy)
        self.assertIn('assertion.job_workflow_ref',policy)
        self.assertIn('deploy-reusable.yml@',policy)
        self.assertIn('deploy-prod.yml@',policy)
        self.assertNotIn('pull_request',policy)

    def test_only_dev_and_prod_environments_with_phase_specific_identities(self):
        from infra.bootstrap import terraform_ci, terraform_github
        root=Path(__file__).parents[2]
        workflow=(root/'.github/workflows/deploy-reusable.yml').read_text()
        self.assertEqual(workflow.count('environment: ${{ inputs.target_environment }}'),2)
        self.assertNotIn('target_environment }}-plan',workflow)
        self.assertNotIn('target_environment }}-apply',workflow)
        for phase in ('PLAN','APPLY'):
            self.assertIn('vars.GCP_'+phase+'_SERVICE_ACCOUNT',workflow)
            self.assertIn('vars.GCP_'+phase+'_WORKLOAD_IDENTITY_PROVIDER',workflow)
        config=json.loads((root/'infra/bootstrap/terraform-ci.json.example').read_text())
        for phase in ('plan','apply'):
            self.assertEqual(terraform_ci.identity(config,phase)['environment'],'dev')
            values=terraform_github.variables(config,{},phase)
            self.assertIn('GCP_'+phase.upper()+'_SERVICE_ACCOUNT',values)

    def test_dev_requires_branch_restriction_but_not_prod_reviewers(self):
        from infra.ci.approval import verify
        env={'deployment_branch_policy':{'protected_branches':False,'custom_branch_policies':True},'protection_rules':[]}
        policy={'total_count':1,'branch_policies':[{'name':'main','type':'branch'}]}
        verify(env,policy,'main',require_review=False)
        with self.assertRaises(ValueError):verify(env,policy,'main',require_review=True)

    def test_manual_dev_bootstrap_does_not_require_runtime_secrets(self):
        env={**context_env(),'GITHUB_EVENT_NAME':'workflow_dispatch','INFRASTRUCTURE_ONLY':'true'}
        self.assertIsNone(deploy.preflight(env))
        self.assertTrue(contracts.context(env)[0]['infrastructure_only'])
        for event in ('push','pull_request'):
            with self.assertRaises(ValueError): deploy.preflight({**env,'GITHUB_EVENT_NAME':event})
        with self.assertRaises(ValueError): deploy.preflight({**env,'TF_ENVIRONMENT':'prod'})
        with self.assertRaises(ValueError): deploy.preflight({**env,'INFRASTRUCTURE_ONLY':'false'})

    def test_bootstrap_workflow_skips_only_runtime_not_terraform(self):
        root=Path(__file__).parents[2]/'.github/workflows'
        shared=(root/'deploy-reusable.yml').read_text()
        self.assertIn('if: ${{ !inputs.infrastructure_only }}',shared)
        self.assertIn('if: needs.plan.outputs.has_changes',shared)
        self.assertIn('Infrastructure Bootstrap Complete',shared)
        self.assertNotIn('infrastructure_only',(root/'deploy-prod.yml').read_text())
