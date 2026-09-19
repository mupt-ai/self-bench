#!/usr/bin/env python3
"""Deploy selected Compose services on the VM; invoked by CI over IAP."""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request

from check_release import read_env, validate


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def metadata(path):
    request = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/' + path,
                                     headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.read()


def rollout(compose, check_script, service, release, state):
    services = ['api', 'worker'] if service == 'all' else [service]
    run(compose + ['pull', *services])
    # Validate with the image's application code before migrations or container replacement.
    def check(role, *args):
        return compose + ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node',
                          '-v', f'{check_script}:/app/deploy-check.mjs:ro', role,
                          '/app/deploy-check.mjs', *args]
    for role in services:
        run(check(role, 'config'))
    # CI has completed a DB backup. Migrations must support the still-running old services.
    run(check(services[0], 'migrate'))
    for role in services:
        run(compose + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '180', role])
        if role == 'worker':
            container = run(compose + ['ps', '-q', 'worker'], capture_output=True, text=True).stdout.strip()
            hostname = run(['docker', 'inspect', '--format', '{{.Config.Hostname}}', container],
                           capture_output=True, text=True).stdout.strip()
            if not hostname:
                raise ValueError('Missing new worker identity')
            for attempt in range(12):
                try:
                    run(check('worker', 'worker', hostname))
                    break
                except subprocess.CalledProcessError:
                    if attempt == 11:
                        raise
                    time.sleep(5)
        # A partial release never claims that the other service was upgraded.
        (state / f'current-{role}-release').write_text(str(release) + '\n')
    if service == 'all':
        (state / 'current-release').write_text(str(release) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release_env', type=Path)
    parser.add_argument('--project', required=True)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--service', choices=['api', 'worker', 'all'], default='all')
    for role in ('shared', 'api', 'worker'):
        parser.add_argument(f'--{role}-version', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise ValueError('Run as root')
    os.umask(0o077)
    if not re.fullmatch(r'[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*', args.release_id):
        raise ValueError('Invalid release directory')
    if metadata('project/project-id').decode() != args.project:
        raise ValueError('Wrong VM project')
    state = Path('/opt/selfbench'); state.mkdir(exist_ok=True)
    lock = (state / 'deploy.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    release = state / 'releases' / args.release_id
    release.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).resolve().parent
    for name in ('compose.yaml', 'deploy-check.mjs'):
        (release / name).write_bytes((source / name).read_bytes())
    (release / 'deploy-check.mjs').chmod(0o644)
    release_env = release / 'release.env'
    release_env.write_bytes(args.release_env.read_bytes())
    coordinates = read_env(release_env)
    token = json.loads(metadata('instance/service-accounts/default/token'))['access_token']
    for role in ('shared', 'api', 'worker'):
        version = getattr(args, f'{role}_version')
        if not re.fullmatch('[1-9][0-9]*', version):
            raise ValueError('Pin numeric secret versions')
        if coordinates[f'SELFBENCH_{role.upper()}_ENV_FILE'] != str(release / f'{role}.env'):
            raise ValueError('Secret paths must belong to this release')
        url = f'https://secretmanager.googleapis.com/v1/projects/{args.project}/secrets/selfbench-{role}-env/versions/{version}:access'
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token}), timeout=30) as response:
            (release / f'{role}.env').write_bytes(base64.b64decode(json.load(response)['payload']['data'], validate=True))
    checked = validate(coordinates['SELFBENCH_ENVIRONMENT'], args.project, release_env)
    with tempfile.TemporaryDirectory() as authdir:
        os.environ['DOCKER_CONFIG'] = authdir
        run(['docker', 'login', '--username', 'oauth2accesstoken', '--password-stdin', checked['registry']],
            input=token.encode(), stdout=subprocess.DEVNULL)
        compose = ['docker', 'compose', '--env-file', str(release_env), '-f', str(release / 'compose.yaml')]
        rollout(compose, release / 'deploy-check.mjs', args.service, release, state)
    print(f'{args.service} deployment verified.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('VM deployment failed; inspect protected deployment log. No schema rollback attempted.') from None
