"""Shared deploy stage: image -> DB backup -> VM migration/rollout -> HTTPS verification."""
import json
import os
from pathlib import Path
import re
import shlex
import tempfile
import time
import urllib.error
import urllib.request

from infra.ci import contracts
from infra.ci.terraform import Runner


def settings(env):
    versions = json.loads(env.get('RUNTIME_SECRET_VERSIONS','{}'))
    if set(versions) != {'shared','api','worker'} or not all(re.fullmatch('[1-9][0-9]*',str(v)) for v in versions.values()):
        raise ValueError('Configure exact shared/api/worker Secret Manager versions before deploying')
    origin = env.get('SELFBENCH_PUBLIC_URL','')
    if not re.fullmatch(r'https://[a-zA-Z0-9.-]+(?::[0-9]+)?',origin): raise ValueError('Configure public HTTPS origin')
    return versions, origin


def preflight(env):
    ctx, _ = contracts.context(env)
    if not ctx["infrastructure_only"]:
        return settings(env)
    return None


def connect(runner, args, **kwargs):
    error = RuntimeError('VM connection failed')
    for attempt in range(5):
        try:
            return runner.run(args, **kwargs)
        except RuntimeError as cause:
            error = cause
            time.sleep(min(2 ** attempt, 8))
    raise error


def main():
    os.umask(0o077)
    ctx, inputs = contracts.context(os.environ)
    if ctx["infrastructure_only"]: raise ValueError("App deployment is forbidden in infrastructure-only mode")
    versions, origin = settings(os.environ)
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
            with runner.log.open('ab') as log:
                runner.run(['docker','build','--platform','linux/amd64','--build-arg','SELFBENCH_BUILD_COMMIT='+ctx['source_sha'],'-t',tag,'.'],stdout=log)
                runner.run(['docker','push',tag],stdout=log)
            inspect = json.loads(runner.run(['docker','image','inspect',tag]))
            digest = next((ref.rsplit('@',1)[-1] for ref in inspect[0].get('RepoDigests') or [] if ref.startswith(output['image_prefix']+'@')), '')
            if not re.fullmatch('sha256:[0-9a-f]{64}',digest): raise ValueError('Registry digest not confirmed')
            image_ref = output['image_prefix']+'@'+digest
            database=output.get('database')
            if not database: raise ValueError('External DB requires a reviewed backup adapter')
            instance=database['instance'].split(':')[-1]
            # Synchronous provider backup before any schema changes. Failure blocks rollout.
            runner.run(['gcloud','sql','backups','create','--instance='+instance,'--project='+ctx['project'],'--quiet'])
            request={'project':ctx['project'],'environment':ctx['environment'],'sha':ctx['source_sha'],
                     'release_id':ctx['source_sha']+'-'+ctx['run_id']+'-'+ctx['run_attempt'],
                     'image':image_ref,'registry':registry,'secret_versions':versions}
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
            connect(runner, ['gcloud','compute','ssh',output['instance'],*common,'--command='+host,'--','-T'], payload=archive)
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
