import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";

const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));

test("Daytona registry entries are task-scoped and cleaned on both successful and failed creation", async () => {
  const script = `
import asyncio, os, sys, types
sys.path.insert(0, sys.argv[1])
os.environ.update(SELFBENCH_REGISTRY_HOST='registry.test', SELFBENCH_REGISTRY_USERNAME='selfbench', SELFBENCH_REGISTRY_PASSWORD='scoped-token')
events=[]
class Params:
 def __init__(self, **kwargs): self.__dict__.update(kwargs)
class Registry:
 def __init__(self, client): pass
 async def create_registry(self, params):
  assert params.url=='registry.test' and params.project=='task-1'
  assert params.password=='scoped-token'
  events.append('register'); return types.SimpleNamespace(id='owned-entry')
 async def delete_registry(self, id): assert id=='owned-entry'; events.append('delete')
class Base:
 async def _create_sandbox(self, **kwargs):
  events.append('create')
  if self.fail: raise RuntimeError('provider failed')
  return 'sandbox'
for name in ['daytona_api_client_async','daytona_api_client_async.api','daytona_api_client_async.models','harbor','harbor.environments']:
 sys.modules[name]=types.ModuleType(name)
for name, attr, value in [
 ('daytona_api_client_async.api.docker_registry_api','DockerRegistryApi',Registry),
 ('daytona_api_client_async.models.create_docker_registry','CreateDockerRegistry',Params),
 ('harbor.environments.daytona','DaytonaEnvironment',Base)]:
 module=types.ModuleType(name); setattr(module,attr,value); sys.modules[name]=module
from selfbench_daytona import SelfBenchDaytonaEnvironment
async def check():
 client=types.SimpleNamespace(_api_client=object())
 for fail in [False, True]:
  env=SelfBenchDaytonaEnvironment(); env._compose_mode=False; env.fail=fail
  env.task_env_config=types.SimpleNamespace(docker_image='registry.test/task-1@sha256:abc')
  try: assert await env._create_sandbox(Params(), daytona=client)=='sandbox'
  except RuntimeError: assert fail
  assert events[-3:]==['register','create','delete']
 # With a record directory, the snapshot each role started from is written for the export.
 import pathlib, tempfile
 record=tempfile.mkdtemp()
 for role_dir, snapshot in [('environment','harbor__a__snapshot'),('tests','harbor__b__snapshot')]:
  env=SelfBenchDaytonaEnvironment(image_record_dir=record); env._compose_mode=False; env.fail=False
  env.environment_dir=pathlib.Path('/task')/role_dir; env.task_env_config=types.SimpleNamespace(docker_image=None)
  await env._create_sandbox(Params(snapshot=snapshot), daytona=client)
 assert (pathlib.Path(record)/'agent').read_text()=='harbor__a__snapshot'
 assert (pathlib.Path(record)/'verifier').read_text()=='harbor__b__snapshot'
asyncio.run(check())
print('ok')
`;
  const result = await runCommand("python3", ["-I", "-c", script, runtime]);
  expect(result.stdout.trim()).toBe("ok");
});

test("Vercel authenticates only source-image reads and destroys its builder when auth setup fails", async () => {
  const script = `
import asyncio, os, sys, types
sys.path.insert(0,sys.argv[1])
class Params:
 def __init__(self, **kwargs): self.__dict__.update(kwargs)
class Match:
 @staticmethod
 def exact(path): return ('exact',path)
 @staticmethod
 def starts_with(path): return ('prefix',path)
class Policy:
 @staticmethod
 def custom(**kwargs): return kwargs
module=types.ModuleType('harbor.environments.vercel'); module.VercelSandboxEnvironment=object
module.environment=types.SimpleNamespace()
sys.modules['harbor']=types.ModuleType('harbor'); sys.modules['harbor.environments']=types.ModuleType('harbor.environments')
sys.modules['harbor.environments.vercel']=module
from selfbench_vercel import PullAuthenticatedBuilder
class Sandbox:
 destroyed=False
 fail=False
 async def update_network_policy(self,policy):
  self.policy=policy
  if self.fail: raise RuntimeError('policy refused')
 async def destroy(self): self.destroyed=True
async def check():
 sandbox=Sandbox()
 async def create(**kwargs): return sandbox
 sdk=types.SimpleNamespace(create_sandbox=create, NetworkPolicy=Policy, NetworkPolicyRule=Params,NetworkPolicyTransform=Params,NetworkPolicyRequestMatcher=Params,NetworkPolicyMatcher=Match)
 builder=PullAuthenticatedBuilder(sdk,('registry.test','user','scoped-token'),'registry.test/task-1@sha256:abc')
 assert await builder.create_sandbox()==sandbox
 rules=sandbox.policy['allow']['registry.test']
 assert rules[0].match.path==('exact','/v2/')
 assert rules[1].match.path==('prefix','/v2/task-1/')
 assert rules[1].match.method==('GET','HEAD')
 assert not hasattr(sandbox.policy['allow']['*'][0],'transform')
 sandbox.fail=True
 try: await builder.create_sandbox(); assert False
 except RuntimeError: pass
 assert sandbox.destroyed
asyncio.run(check())
print('ok')
`;
  const result = await runCommand("python3", ["-I", "-c", script, runtime]);
  expect(result.stdout.trim()).toBe("ok");
});
