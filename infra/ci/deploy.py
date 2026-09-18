"""Shared deploy stage: image -> DB backup -> VM migration/rollout -> HTTPS verification."""
from contextlib import contextmanager
import time
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import urllib.error
import urllib.request

from infra.ci import contracts
from infra.ci.terraform import Runner


@contextmanager
def stage(name):
    """Publish only fixed stage names and durations, never command output or secrets."""
    started = time.monotonic()
    print(f"Starting {name}", flush=True)
    outcome = "failed"
    try:
        yield
        outcome = "passed"
    finally:
        elapsed = time.monotonic() - started
        print(f"{name}: {outcome} ({elapsed:.1f}s)", flush=True)
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
            summary.write(f"\n- {name}: {outcome} ({elapsed:.1f}s)\n")


def build_image(runner, tag, source_sha):
    # Restored/saved by Actions; release registry tags remain immutable.
    cache = '/tmp/selfbench-build-cache'
    runner.run(['docker', 'buildx', 'create', '--name', 'selfbench-ci',
                '--driver', 'docker-container', '--use'])
    with runner.log.open('ab') as log:
        with stage('Build Image'):
            runner.run(['docker', 'buildx', 'build', '--builder', 'selfbench-ci',
                        '--platform', 'linux/amd64', '--load',
                        '--cache-from', 'type=local,src=' + cache,
                        '--cache-to', 'type=local,dest=' + cache + '-next,mode=max',
                        '--build-arg', 'SELFBENCH_BUILD_COMMIT=' + source_sha,
                        '-t', tag, '.'], stdout=log)
        # Replace the old store instead of accumulating unreachable blobs each run.
        if Path(cache + '-next/index.json').is_file():
            shutil.rmtree(cache, ignore_errors=True)
            Path(cache + '-next').rename(cache)
        with stage('Push Image'):
            runner.run(['docker', 'push', tag], stdout=log)


def settings(env):
    versions = json.loads(env.get('RUNTIME_SECRET_VERSIONS','{}'))
    if set(versions) != {'shared','api','worker'} or not all(re.fullmatch('[1-9][0-9]*',str(v)) for v in versions.values()):
        raise ValueError('Configure exact shared/api/worker Secret Manager versions before deploying')
    origin = env.get('SELFBENCH_PUBLIC_URL','')
    if not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?',origin): raise ValueError('Configure public HTTPS origin')
    concurrency = env.get('SELFBENCH_ACTIVITY_CONCURRENCY', '')
    if not re.fullmatch(r'[1-8]', concurrency):
        raise ValueError('Configure activity concurrency as an integer from 1 to 8')
    return versions, origin, concurrency


def preflight(env):
    ctx, _ = contracts.context(env)
    if not ctx["infrastructure_only"]:
        return settings(env)
    return None


def main():
    os.umask(0o077)
    ctx, inputs = contracts.context(os.environ)
    if ctx["infrastructure_only"]: raise ValueError("App deployment is forbidden in infrastructure-only mode")
    versions, origin, concurrency = settings(os.environ)
    with tempfile.TemporaryDirectory(prefix='selfbench-deploy-') as directory:
        runner = Runner(ctx,Path(directory))
        try:
            runner.initialize(inputs)
            output = json.loads(runner.terraform('output','-json','deployment'))
            if output['project_id'] != ctx['project'] or output['environment'] != ctx['environment']: raise ValueError('Wrong deployment outputs')
            if not inputs.get('enable_public_web'): raise ValueError('DNS/TLS and public web ingress must be configured first')
            registry = output['image_prefix'].split('/')[0]
            runner.run(['gcloud','auth','configure-docker',registry,'--quiet'])
            tag = output['image_prefix']+':'+ctx['source_sha']+'-'+ctx['run_id']+'-'+ctx['run_attempt']
            build_image(runner, tag, ctx['source_sha'])
            inspect = json.loads(runner.run(['docker','image','inspect',tag]))
            digest = next((ref.rsplit('@',1)[-1] for ref in inspect[0].get('RepoDigests') or [] if ref.startswith(output['image_prefix']+'@')), '')
            if not re.fullmatch('sha256:[0-9a-f]{64}',digest): raise ValueError('Registry digest not confirmed')
            image_ref = output['image_prefix']+'@'+digest
            database=output.get('database')
            if not database: raise ValueError('External DB requires a reviewed backup adapter')
            instance=database['instance'].split(':')[-1]
            # Synchronous provider backup before any schema changes. Failure blocks rollout.
            with stage('Back Up Database'):
                runner.run(['gcloud','sql','backups','create','--instance='+instance,'--project='+ctx['project'],'--quiet'])
            request={'project':ctx['project'],'environment':ctx['environment'],'sha':ctx['source_sha'],
                     'release_id':ctx['source_sha']+'-'+ctx['run_id']+'-'+ctx['run_attempt'],
                     'image':image_ref,'registry':registry,'secret_versions':versions,
                     'activity_concurrency':concurrency}
            folder=Path(directory)/'runtime'; folder.mkdir()
            for name in ('deploy-host.py','deploy-check.mjs','compose.yaml','check_release.py'):
                (folder/name).write_bytes((Path('infra/runtime')/name).read_bytes())
            (folder/'request.json').write_bytes(contracts.canonical(request))
            remote='/tmp/selfbench-release-'+ctx['run_id']+'-'+ctx['run_attempt']
            dest=f'/var/lib/selfbench-deploy/{ctx["run_id"]}-{ctx["run_attempt"]}'
            common=['--project='+ctx['project'],'--zone='+output['zone'],'--tunnel-through-iap','--quiet']
            # One SSH session: a second OS Login cert after scp can fail with publickey on first-time profiles.
            archive = runner.run(['tar','-C',str(folder),'-czf','-','.'])
            host=('set -euo pipefail; '
                  f'mkdir -p {shlex.quote(remote)}; tar -C {shlex.quote(remote)} -xzf -; '
                  'sudo install -d -m 0700 /var/lib/selfbench-deploy && '
                  f'sudo cp -r {shlex.quote(remote)} {shlex.quote(dest)} && '
                  f'sudo chown -R root:root {shlex.quote(dest)} && '
                  f'sudo chmod -R go-rwx {shlex.quote(dest)} && '
                  'sudo bash -c '+shlex.quote(f'cd {dest} && python3 deploy-host.py request.json > deploy.log 2>&1'))
            with stage('Migrate and Roll Out'):
                runner.run(['gcloud','compute','ssh',output['instance'],*common,'--command='+host,'--','-T'], payload=archive)
            with urllib.request.urlopen(origin+'/healthz',timeout=30) as response:
                if response.status != 200: raise ValueError('Public health check failed')
            try:
                urllib.request.urlopen(origin+'/api/session',timeout=30)
            except urllib.error.HTTPError as error:
                if error.code != 401: raise
            else: raise ValueError('Anonymous session was not rejected')
            with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as summary:
                summary.write(f'\n## Deployed {ctx["environment"]}\nImage: `{image_ref}`\n\nHTTPS health, anonymous auth rejection and VM worker checks passed.\n')
        finally:
            if runner.log.exists():
                log=Path(directory)/'snapshot.log';log.write_bytes(runner.log.read_bytes())
                # Separate from Terraform apply diagnostics; immutable log object per release stage.
                runner.upload(log,'deploy.log')


if __name__ == '__main__':
    try: main()
    except Exception: raise SystemExit('Deployment failed closed. Inspect private CI/VM logs; no automatic rollback was attempted.') from None
