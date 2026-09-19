"""Exercise rollout ordering and failures without cloud credentials or containers."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

RUNTIME = Path(__file__).parents[1] / 'runtime'
sys.path.insert(0, str(RUNTIME))
SPEC = importlib.util.spec_from_file_location('deploy_host', RUNTIME / 'deploy-host.py')
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)
sys.path.pop(0)


class RolloutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.release = self.state / 'release'
        self.compose = ['docker', 'compose', '-f', 'compose.yaml']
        self.calls = []
        self.runner = patch.object(host, 'run', side_effect=self.command)
        self.runner.start()
        self.addCleanup(self.runner.stop)

    def command(self, args, **kwargs):
        self.calls.append(args)
        return Mock(stdout='new-worker\n')

    def rollout(self, service):
        host.rollout(self.compose, self.release / 'deploy-check.mjs', service, self.release, self.state)

    def test_api_update_never_recreates_or_checks_worker(self):
        (self.state / 'current-worker-release').write_text('old-worker\n')
        self.rollout('api')
        self.assertFalse(any('worker' in call for call in self.calls))
        self.assertEqual((self.state / 'current-worker-release').read_text(), 'old-worker\n')
        self.assertEqual((self.state / 'current-api-release').read_text().strip(), str(self.release))
        self.assertFalse((self.state / 'current-release').exists())

    def test_worker_update_keeps_api_running_and_checks_new_identity(self):
        self.rollout('worker')
        self.assertFalse(any('api' in call or 'stop' in call for call in self.calls))
        self.assertIn(self.compose + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', 'worker'], self.calls)
        self.assertEqual(self.calls[-1][-2:], ['worker', 'new-worker'])

    def test_full_deploy_validates_and_migrates_before_replacing_services(self):
        self.rollout('all')
        stages = [call[-1] for call in self.calls]
        self.assertEqual(stages[:4], ['worker', 'config', 'config', 'migrate'])
        updates = [call[-1] for call in self.calls if 'up' in call]
        self.assertEqual(updates, ['api', 'worker'])
        self.assertTrue((self.state / 'current-release').exists())

    def test_config_or_migration_failure_leaves_services_and_pointers_untouched(self):
        for failed_stage in ('config', 'migrate'):
            def fail(args, **kwargs):
                self.calls.append(args)
                if args[-1] == failed_stage:
                    raise subprocess.CalledProcessError(1, args)
                return Mock(stdout='')
            self.calls.clear()
            with patch.object(host, 'run', side_effect=fail), self.assertRaises(subprocess.CalledProcessError):
                self.rollout('all')
            self.assertFalse(any('up' in call or 'stop' in call for call in self.calls))
            self.assertFalse(list(self.state.glob('current-*')))

    def test_worker_readiness_failure_does_not_mark_worker_as_successful(self):
        def fail(args, **kwargs):
            if args[-2:] == ['worker', 'new-worker']:
                raise subprocess.CalledProcessError(1, args)
            return self.command(args, **kwargs)
        with patch.object(host, 'run', side_effect=fail), patch.object(host.time, 'sleep'), self.assertRaises(subprocess.CalledProcessError):
            self.rollout('all')
        self.assertTrue((self.state / 'current-api-release').exists())
        self.assertFalse((self.state / 'current-worker-release').exists())
        self.assertFalse((self.state / 'current-release').exists())


class ReadinessTests(unittest.TestCase):
    def test_application_checks_with_isolated_temporal_and_database(self):
        result = subprocess.run(['node', '--experimental-vm-modules', '--test',
                                 str(Path(__file__).with_name('deploy-check.test.mjs'))],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
