import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / 'infra/ci/verify-source.sh'
SETTINGS = {'SELFBENCH_PUBLIC_URL': 'https://example.com',
            'SELFBENCH_ACTIVITY_CONCURRENCY': '8'}
EVENT = {'repository': {'default_branch': 'main'}}


def workflow(name):
    return (ROOT / '.github/workflows' / name).read_text()


def step(text, name):
    """The YAML of one named step in deploy-reusable.yml, up to the next step."""
    body = text.split(f'      - name: {name}\n')[1]
    return body.split('\n      - ')[0]


class SourceVerificationTests(unittest.TestCase):
    """Run verify-source.sh with a stubbed git and event payload, as the workflow step would."""

    def run_script(self, tmp, event=EVENT, git_ancestry=True, sha='a' * 40, **overrides):
        shim = tmp / 'bin'; shim.mkdir(exist_ok=True)
        git = shim / 'git'
        merge_base = 'exit 0' if git_ancestry else 'exit 1'
        git.write_text(f'#!/usr/bin/env bash\n'
                       f'if [[ "$1" == merge-base ]]; then {merge_base}; fi\n'
                       f'if [[ "$1" == rev-parse ]]; then echo {sha}; exit 0; fi\n'
                       'exit 1\n')
        git.chmod(0o755)
        event_path = tmp / 'event.json'; event_path.write_text(json.dumps(event))
        env = {'PATH': f'{shim}:{os.environ["PATH"]}', 'HOME': os.environ.get('HOME', '')}
        env.update({'TF_ENVIRONMENT': 'dev', 'GCP_PROJECT_ID': 'community-infra',
                    'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1', 'GITHUB_SHA': 'a' * 40,
                    'GITHUB_DEFAULT_BRANCH': 'main', 'GITHUB_EVENT_PATH': str(event_path),
                    'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'push',
                    'RUNNER_ENVIRONMENT': 'github-hosted', 'INFRASTRUCTURE_ONLY': 'false', **SETTINGS})
        env.update(overrides)
        if 'RUNTIME_SECRET_VERSIONS' in env:
            versions = env.pop('RUNTIME_SECRET_VERSIONS')
            versions_path = tmp / 'runtime-secret-versions.json'
            versions_path.write_text(versions)
            env['RUNTIME_SECRET_VERSIONS_FILE'] = str(versions_path)
        for key, value in list(env.items()):
            if value is None: del env[key]
        return subprocess.run(['bash', str(SCRIPT)], env=env, capture_output=True, text=True)

    def test_valid_dev_deploy_passes_all_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_script(Path(directory))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_running_workflows_do_not_block_rollout(self):
        root = ROOT / 'infra/runtime'
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
        for value in ('{}', '[]', '{"shared":"latest","api":1,"worker":2}', '{"shared":1,"worker":3}'):
            with tempfile.TemporaryDirectory() as directory:
                result = self.run_script(Path(directory), RUNTIME_SECRET_VERSIONS=value)
            self.assertEqual(result.returncode, 1, value)
            self.assertIn('runtime secret version manifest', result.stderr)

    def test_runtime_concurrency_required_and_bounded_before_cloud_auth(self):
        for value in ('', '0', '101', '-1', '8.0', '08', '010'):
            with tempfile.TemporaryDirectory() as directory, self.subTest(value=value):
                result = self.run_script(Path(directory), SELFBENCH_ACTIVITY_CONCURRENCY=value)
            self.assertEqual(result.returncode, 1, value)
        shared = workflow('deploy-reusable.yml')
        self.assertLess(shared.index('Verify Trusted Deploy Source and Runtime Settings'),
                        shared.index('google-github-actions/auth@'))

    def test_published_stable_release_can_deploy_prod(self):
        base = {'TF_ENVIRONMENT': 'prod', 'GITHUB_EVENT_NAME': 'release', 'GITHUB_REF': 'refs/tags/v1'}
        event = {'repository': {'default_branch': 'main'}, 'action': 'published',
                 'release': {'draft': False, 'prerelease': False, 'tag_name': 'v1'}}
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_script(Path(directory), event=event, **base)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prerelease_or_draft_cannot_deploy_prod(self):
        base = {'TF_ENVIRONMENT': 'prod', 'GITHUB_EVENT_NAME': 'release', 'GITHUB_REF': 'refs/tags/v1'}
        event = {'repository': {'default_branch': 'main'}, 'action': 'published',
                 'release': {'draft': False, 'prerelease': False, 'tag_name': 'v1'}}
        with tempfile.TemporaryDirectory() as directory:
            self.run_script(Path(directory), event=event, **base)
            for alter in ({'draft': True}, {'prerelease': True}, {'draft': None}):
                with self.subTest(release=alter):
                    result = self.run_script(Path(directory), event={**event, 'release': {**event['release'], **alter}}, **base)
                self.assertEqual(result.returncode, 1, alter)
            with self.subTest(tag='moved'):
                result = self.run_script(Path(directory), event=event, sha='b' * 40, **base)
            self.assertEqual(result.returncode, 1)

    def test_deploy_source_must_be_ancestors_of_default_branch(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_script(Path(directory), git_ancestry=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn('default branch', result.stderr)

    def test_checkout_must_match_the_triggering_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_script(Path(directory), sha='b' * 40)
        self.assertEqual(result.returncode, 1)
        self.assertIn('Checkout', result.stderr)

    def test_manual_dev_bootstrap_does_not_require_runtime_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_script(Path(directory), GITHUB_EVENT_NAME='workflow_dispatch',
                                     INFRASTRUCTURE_ONLY='true', **{key: None for key in SETTINGS})
        self.assertEqual(result.returncode, 0, result.stderr)


class ReleaseStageTests(unittest.TestCase):
    def test_release_stages_run_in_order_as_workflow_steps(self):
        shared = workflow('deploy-reusable.yml')
        names = ['Read Release Coordinates', 'Authenticate Docker to Artifact Registry', 'Build and Push Image',
                 'Back Up Database', 'Migrate and Roll Out on the VM', 'Verify Public HTTPS', 'Record Deployment']
        positions = [shared.index(f'- name: {name}\n') for name in names]
        self.assertEqual(positions, sorted(positions))
        self.assertGreater(positions[0], shared.index('Apply the Approved Saved Plan'))
        for name in names:
            self.assertIn('if: ${{ !inputs.infrastructure_only }}', step(shared, name), name)
        self.assertIn('bash infra/ci/verify-source.sh', shared)

    def test_image_build_is_a_standard_action_with_gha_cache(self):
        build = step(workflow('deploy-reusable.yml'), 'Build and Push Image')
        self.assertIn('uses: docker/build-push-action@', build)
        self.assertIn('push: true', build)
        self.assertIn('platforms: linux/amd64', build)
        self.assertIn('SELFBENCH_BUILD_COMMIT=${{ github.sha }}', build)
        self.assertIn('${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}', build)
        self.assertIn('cache-from: type=gha,scope=${{ inputs.target_environment }}', build)
        self.assertIn('cache-to: type=gha,scope=${{ inputs.target_environment }}', build)

    def test_rollout_ships_a_digest_pinned_bundle_over_one_ssh_session(self):
        shared = workflow('deploy-reusable.yml')
        rollout = step(shared, 'Migrate and Roll Out on the VM')
        self.assertNotIn('compute scp', rollout)
        self.assertEqual(shared.count('gcloud compute ssh'), 1)
        self.assertIn('sha256:[0-9a-f]{64}', rollout)
        self.assertIn('deploy-host.py request.json > deploy.log 2>&1', rollout)
        self.assertIn('tunnel-through-iap', rollout)
        for runtime_file in ('deploy-host.py', 'deploy-check.mjs', 'compose.yaml', 'check_release.py'):
            self.assertIn(runtime_file, rollout)
        self.assertIn('gcloud sql backups create', step(shared, 'Back Up Database'))
        verify = step(shared, 'Verify Public HTTPS')
        self.assertIn('/healthz', verify); self.assertIn('/api/session', verify); self.assertIn('401', verify)

    def test_release_module_python_is_gone_from_the_release_path(self):
        shared = workflow('deploy-reusable.yml')
        self.assertNotIn('infra.ci.rollout', shared)
        self.assertNotIn('infra.ci.source', shared)
        self.assertFalse((ROOT / 'infra/ci/rollout.py').exists())

    def test_commit_metadata_does_not_invalidate_dependency_layer(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertLess(dockerfile.index('RUN bun install --frozen-lockfile'),
                        dockerfile.index('ARG SELFBENCH_BUILD_COMMIT'))

    def test_ci_preserves_checks_without_duplicate_package_verification(self):
        ci = workflow('ci.yml')
        for command in ('check', 'test', 'build', 'verify:package:docker'):
            self.assertIn('bun run ' + command, ci)
        self.assertNotIn('bun run validate', ci)


if __name__ == '__main__':
    unittest.main()
