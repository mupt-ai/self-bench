import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../runtime/deploy-check.mjs', import.meta.url), 'utf8');
async function check(mode, pollers = [], hostname = 'new-worker') {
  const calls = [];
  const context = vm.createContext({ process: { argv: ['node', 'check', mode, hostname], env: {} } });
  const modules = {
    '/app/dist/config.js': { loadConfig: () => ({ temporal: { namespace: 'test', taskQueue: 'test' } }) },
    '/app/dist/db/client.js': { openDatabase: async () => {
      calls.push('migrate');
      return { close: async () => calls.push('db-close') };
    } },
    '/app/dist/temporal/connection.js': { connectTemporalClient: async () => {
      calls.push('connect');
      return {
        workflowService: { describeTaskQueue: async ({ taskQueueType }) => {
          calls.push(taskQueueType);
          return { pollers: typeof pollers === 'function' ? pollers(taskQueueType) : pollers };
        } },
        close: async () => calls.push('temporal-close'),
      };
    } },
  };
  async function link(specifier) {
    const exports = modules[specifier];
    assert.ok(exports, `Unexpected dependency ${specifier}`);
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    await module.link(link);
    await module.evaluate();
    return module;
  }
  const module = new vm.SourceTextModule(source, { context, importModuleDynamically: link });
  await module.link(link);
  try { await module.evaluate(); } catch (error) {
    assert.equal(calls.at(-1), 'temporal-close');
    throw error;
  }
  return calls;
}
const recent = (identity) => ({ identity, lastAccessTime: { seconds: Math.floor(Date.now() / 1000) } });

test('config preflight does not contact Temporal or migrate', async () => {
  assert.deepEqual(await check('config'), []);
});
test('migration closes its database without contacting Temporal', async () => {
  assert.deepEqual(await check('migrate'), ['migrate', 'db-close']);
});
test('old worker cannot satisfy new worker readiness', async () => {
  await assert.rejects(check('worker', [recent('1@old-worker')]), /not polling/);
});
test('both workflow and activity queues require a new worker poller', async () => {
  await assert.rejects(check('worker', type => type === 1 ? [recent('1@new-worker')] : []), /not polling/);
});
test('stale poller from the same worker is not ready', async () => {
  await assert.rejects(check('worker', [{ identity: '1@new-worker', lastAccessTime: { seconds: 1 } }]), /not polling/);
});
test('new worker polling both queues passes and connection closes', async () => {
  assert.deepEqual(await check('worker', [recent('1@new-worker')]), ['connect', 1, 2, 'temporal-close']);
});
