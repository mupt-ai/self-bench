#!/usr/bin/env python3
"""Run only as root on the selected VM with a reviewed release JSON argument."""
import base64
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def metadata(path):
    request = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/' + path,
                                     headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(request, timeout=15) as response: return response.read()


def main():
    if os.geteuid() != 0: raise ValueError('Run as root')
    os.umask(0o077)
    config = json.loads(Path(sys.argv[1]).read_text())
    project, env, sha = config['project'], config['environment'], config['sha']
    if not re.fullmatch('[0-9a-f]{40}', sha) or env not in ('dev', 'prod'): raise ValueError('Invalid release identity')
    if metadata('project/project-id').decode() != project: raise ValueError('Wrong VM project')
    if not re.fullmatch(r'[0-9a-f]{40}-[1-9][0-9]*-[1-9][0-9]*',config['release_id']): raise ValueError('Invalid release directory')
    state = Path('/opt/selfbench'); state.mkdir(exist_ok=True)
    lock = (state / 'deploy.lock').open('w'); fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Unique immutable release directory; old release and secrets retained for explicit recovery.
    release = state / 'releases' / config['release_id']; release.mkdir(parents=True, exist_ok=False)
    source = Path(__file__).resolve().parent
    for name in ('compose.yaml', 'check_release.py', 'deploy-check.mjs'):
        (release / name).write_bytes((source / name).read_bytes())
        if name == 'deploy-check.mjs': (release / name).chmod(0o644)
    token = json.loads(metadata('instance/service-accounts/default/token'))['access_token']
    for role, version in config['secret_versions'].items():
        if role not in ('shared', 'api', 'worker') or not re.fullmatch('[1-9][0-9]*', str(version)):
            raise ValueError('Pin numeric secret versions')
        url = f'https://secretmanager.googleapis.com/v1/projects/{project}/secrets/selfbench-{role}-env/versions/{version}:access'
        with urllib.request.urlopen(urllib.request.Request(url, headers={'Authorization': 'Bearer '+token}), timeout=30) as response:
            payload = base64.b64decode(json.load(response)['payload']['data'], validate=True)
        (release / f'{role}.env').write_bytes(payload)
    # Temporary registry login; no durable access token or Docker config retained.
    import tempfile
    with tempfile.TemporaryDirectory() as authdir:
        os.environ['DOCKER_CONFIG'] = authdir
        run(['docker','login','--username','oauth2accesstoken','--password-stdin',config['registry']], input=token.encode(), stdout=subprocess.DEVNULL)
        values = {'SELFBENCH_ENVIRONMENT':env,'SELFBENCH_IMAGE':config['image']}
        values.update({f'SELFBENCH_{role.upper()}_ENV_FILE':str(release/f'{role}.env') for role in ('shared','api','worker')})
        release_env = release/'release.env'; release_env.write_text(''.join(f'{k}={v}\n' for k,v in values.items()))
        run(['python3',str(release/'check_release.py'),'--environment',env,'--project',project,'--release-env',str(release_env)])
        compose=['docker','compose','--env-file',str(release_env),'-f',str(release/'compose.yaml')]
        run(compose+['pull'])
        check=['docker','run','--rm','--env-file',str(release/'shared.env'),'--env-file',str(release/'worker.env'),
               '-v',f'{release}/deploy-check.mjs:/app/deploy-check.mjs:ro',config['image'],'node','/app/deploy-check.mjs']
        # Stop ingress first, check quiescence, then stop worker. Never retry/cancel active workflows.
        run(compose+['stop','api'])
        try: run(check+['idle'])
        except Exception:
            run(compose+['start','api'])  # Restore old existing service, not a new image.
            raise
        run(compose+['stop','worker'])
        # Backup was created by CI before stopping the service. This migration reuses maintained app code.
        migration="const {openDatabase}=await import('/app/dist/db/client.js'); const c=await openDatabase(process.env.SELFBENCH_DATABASE_URL); await c.close();"
        run(['docker','run','--rm','--env-file',str(release/'shared.env'),config['image'],'node','--input-type=module','-e',migration])
        run(compose+['up','-d','--wait','--wait-timeout','180'])
        for attempt in range(12):
            try:
                run(check+['worker']); break
            except subprocess.CalledProcessError:
                if attempt == 11: raise
                time.sleep(5)
        with urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=15) as response:
            if response.status != 200: raise ValueError('API health failed')
        (state/'current-release').write_text(str(release)+'\n')
        print('Release, migrations, API health and recent worker polling verified.')


if __name__ == '__main__':
    try: main()
    except Exception: raise SystemExit('VM deployment failed; inspect protected deployment log. No schema rollback attempted.') from None
