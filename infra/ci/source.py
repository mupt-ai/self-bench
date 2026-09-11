"""Check deploy source before requesting cloud credentials."""
import json
import os
import subprocess
from infra.ci.contracts import context


def verify_source(env, event, git):
    # The reusable workflow has trusted callers; validate the actual event, not a boolean input.
    environment = env['TF_ENVIRONMENT']
    default = event['repository']['default_branch']
    if env['GITHUB_DEFAULT_BRANCH'] != default:
        raise ValueError('Default branch mismatch.')
    sha = git('rev-parse', 'HEAD')
    if sha != env['GITHUB_SHA']:
        raise ValueError('Checkout differs from triggering commit.')
    if environment == 'prod':
        release = event.get('release', {})
        if (event.get('action') != 'published' or release.get('draft') is not False
                or release.get('prerelease') is not False
                or env['GITHUB_REF'] != 'refs/tags/' + release.get('tag_name', '')):
            raise ValueError('Only published stable releases may deploy production.')
        if git('rev-parse', '--verify', env['GITHUB_REF'] + '^{commit}') != sha:
            raise ValueError('Release tag moved or does not match the triggering commit.')
    elif env['GITHUB_REF'] != 'refs/heads/' + default:
        raise ValueError('Dev deploy source must be main.')
    git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/' + default)
    return sha


def main():
    context(os.environ)
    event = json.loads(open(os.environ['GITHUB_EVENT_PATH']).read())
    def git(*args):
        return subprocess.check_output(['git', *args], text=True, stderr=subprocess.DEVNULL).strip()
    sha = verify_source(os.environ, event, git)
    print('Verified deploy source ' + sha)


if __name__ == '__main__':
    try: main()
    except Exception: raise SystemExit('Deploy source verification failed; no cloud authentication attempted.') from None
