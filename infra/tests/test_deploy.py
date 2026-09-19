import json
import unittest
from pathlib import Path
from unittest.mock import Mock
from infra.ci import contracts, deploy, source
from infra.tests.test_terraform_ci import context_env


class DeployTests(unittest.TestCase):
    def test_running_workflows_do_not_block_rollout(self):
        root = Path(__file__).parents[1] / 'runtime'
        host = (root / 'deploy-host.py').read_text()
        check = (root / 'deploy-check.mjs').read_text()
        self.assertNotIn("check+['idle']", host)
        self.assertNotIn('workflow.count', check)
        self.assertNotIn('.terminate(', check)
        self.assertNotIn('.cancel(', check)
        self.assertLess(host.index("run(compose+['stop','api'])"),
                        host.index("run(compose+['stop','worker'])"))
        self.assertIn("run(check+['worker'])", host)
        self.assertIn('stop_grace_period: 2m', (root / 'compose.yaml').read_text())

    def test_missing_or_mutable_secret_versions_rejected(self):
        for value in ('{}', '{"shared":"latest","api":1,"worker":2}'):
            with self.assertRaises(ValueError): deploy.settings({'RUNTIME_SECRET_VERSIONS':value,'SELFBENCH_PUBLIC_URL':'https://example.com'})
        self.assertEqual(deploy.settings({'RUNTIME_SECRET_VERSIONS':'{"shared":1,"api":2,"worker":3}',
                                         'SELFBENCH_PUBLIC_URL':'https://example.com',
                                         'SELFBENCH_ACTIVITY_CONCURRENCY':'8'})[0]['worker'],3)

    def test_runtime_concurrency_required_and_bounded_before_cloud_auth(self):
        env={**context_env(),'RUNTIME_SECRET_VERSIONS':'{"shared":1,"api":2,"worker":3}',
             'SELFBENCH_PUBLIC_URL':'https://example.com'}
        for value in ('', '0', '9', '-1', '8.0', '08'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                deploy.preflight({**env,'SELFBENCH_ACTIVITY_CONCURRENCY':value})
        for value in ('1','4','8'):
            self.assertEqual(deploy.preflight({**env,'SELFBENCH_ACTIVITY_CONCURRENCY':value})[2],value)

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
        self.assertNotIn('paths:',dev)
        self.assertNotIn('paths-ignore:',dev)
        self.assertIn('types: [published]',prod)
        self.assertIn('!github.event.release.prerelease',prod)
        self.assertIn('deploy-reusable.yml',dev);self.assertIn('deploy-reusable.yml',prod)
        self.assertIn('bun run validate',shared)
        self.assertIn('python3 -m infra.ci.terraform plan',shared)
        self.assertIn('python3 -m infra.ci.terraform apply',shared)
        self.assertIn('python3 -m infra.ci.deploy',shared)
        deploy_src=(Path(__file__).parents[1]/'ci'/'deploy.py').read_text()
        self.assertIn("docker','image','inspect'",deploy_src)
        self.assertNotIn('artifacts docker images describe',deploy_src)
        self.assertNotIn("compute','scp'",deploy_src)
        self.assertIn("tar','-C'",deploy_src)
        self.assertEqual(deploy_src.count("compute','ssh'"), 1)
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

    def test_single_deployment_environment_with_phase_specific_identities(self):
        from infra.bootstrap import terraform_ci, terraform_github
        root=Path(__file__).parents[2]
        workflow=(root/'.github/workflows/deploy-reusable.yml').read_text()
        self.assertEqual(workflow.count('environment: ${{ inputs.target_environment }}'),1)
        self.assertNotIn('prod-plan',workflow)
        for phase in ('PLAN','APPLY'):
            self.assertIn('vars.GCP_'+phase+'_SERVICE_ACCOUNT',workflow)
            self.assertIn('vars.GCP_'+phase+'_WORKLOAD_IDENTITY_PROVIDER',workflow)
        protection=workflow.split('      - name: Verify Apply Approval Protection\n')[1].split('      - name: Authenticate Terraform Plan')[0]
        self.assertNotIn('if:',protection)
        apply_auth=workflow.split('      - name: Authenticate Terraform Apply\n')[1].split('      - name: Apply the Approved Saved Plan')[0]
        self.assertNotIn('if:',apply_auth)
        # Updating ADC alone leaves gcloud's active account on the planner, breaking OS Login.
        self.assertIn('uses: google-github-actions/setup-gcloud@',apply_auth)
        self.assertLess(apply_auth.index('vars.GCP_APPLY_SERVICE_ACCOUNT'),
                        apply_auth.index('uses: google-github-actions/setup-gcloud@'))
        self.assertIn('steps.plan.outputs.manifest_generation',workflow)
        self.assertIn('steps.plan.outputs.manifest_sha256',workflow)
        config=json.loads((root/'infra/bootstrap/terraform-ci.json.example').read_text())
        config['environment']='prod'
        for phase in ('plan','apply'):
            self.assertEqual(terraform_ci.github_environment(config,phase),'prod')
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
        self.assertIn('if: steps.plan.outputs.has_changes',shared)
        self.assertIn('Infrastructure Bootstrap Complete',shared)
        self.assertNotIn('infrastructure_only',(root/'deploy-prod.yml').read_text())


class BuildTimingTests(unittest.TestCase):
    def test_local_cache_keeps_release_registry_immutable_and_image_pushed(self):
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            runner = Mock(log=Path(directory)/'build.log')
            summary = Path(directory)/'summary.md'
            with patch.dict('os.environ', {'GITHUB_STEP_SUMMARY': str(summary)}):
                deploy.build_image(runner, 'registry/project/app:release', 'a'*40)
            build = runner.run.call_args_list[1].args[0]
            self.assertIn('--load', build)
            self.assertIn('type=local,src=/tmp/selfbench-build-cache', build)
            self.assertIn('type=local,dest=/tmp/selfbench-build-cache-next,mode=max', build)
            self.assertEqual(runner.run.call_args_list[2].args[0], ['docker', 'push', 'registry/project/app:release'])
            self.assertIn('Build Image: passed', summary.read_text())
            self.assertIn('Push Image: passed', summary.read_text())

    def test_failed_build_is_reported_without_pushing_or_leaking_error(self):
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            runner = Mock(log=Path(directory)/'build.log')
            runner.run.side_effect = [None, RuntimeError('private diagnostic')]
            summary = Path(directory)/'summary.md'
            with patch.dict('os.environ', {'GITHUB_STEP_SUMMARY': str(summary)}):
                with self.assertRaises(RuntimeError):
                    deploy.build_image(runner, 'registry/project/app:release', 'a'*40)
            self.assertEqual(runner.run.call_count, 2)
            self.assertIn('Build Image: failed', summary.read_text())
            self.assertNotIn('private diagnostic', summary.read_text())

    def test_commit_metadata_does_not_invalidate_dependency_layer(self):
        dockerfile = (Path(__file__).parents[2]/'Dockerfile').read_text()
        self.assertLess(dockerfile.index('RUN bun install --frozen-lockfile'),
                        dockerfile.index('ARG SELFBENCH_BUILD_COMMIT'))

    def test_workflow_cache_excludes_runtime_state_and_is_environment_scoped(self):
        workflow = (Path(__file__).parents[2]/'.github/workflows/deploy-reusable.yml').read_text()
        cache = workflow.split('      - name: Restore Docker Build Cache')[1].split('      - name: Build,')[0]
        self.assertIn('path: /tmp/selfbench-build-cache', cache)
        self.assertIn('inputs.target_environment', cache)
        self.assertIn('github.run_attempt', cache)
        self.assertIn('!inputs.infrastructure_only', cache)
        self.assertNotIn('terraform-data', cache)

    def test_ci_preserves_checks_without_duplicate_package_verification(self):
        workflow = (Path(__file__).parents[2]/'.github/workflows/ci.yml').read_text()
        for command in ('check', 'test', 'build', 'verify:package:docker'):
            self.assertIn('bun run ' + command, workflow)
        self.assertNotIn('bun run validate', workflow)
