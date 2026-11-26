// The catalog an agent plans from may be a cached manifest. At dispatch the runtime asks the task gate again about the
// descriptor of the booted cell. Real HelaRuntime, no cell processes; Needle is stubbed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent } from '../dist/agent.js';
import { HelaRuntime } from '../dist/daemon.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-live-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells.\n');
test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

const descriptor = (annotations) => ({ name: 'peek_settings', description: 'Inspect the settings.', inputSchema: { type: 'object', properties: {} }, ...(annotations === undefined ? {} : { annotations }) });

async function run(namespaced, task, live) {
  const runtime = new HelaRuntime({ namespaced });
  runtime.specs.set('hela-fixture', {});
  runtime.cachedManifest['hela-fixture'] = [descriptor({ readOnlyHint: true })];
  const invoked = [];
  // Not ready until dispatch: planning sees the cached hints, the call sees the booted cell's.
  runtime.ensureCell = async () => ({ ready: true, tools: new Map([['peek_settings', live]]) });
  runtime.invokeTool = async (cell, tool) => { invoked.push(tool); return { content: [{ type: 'text', text: 'settings' }] }; };
  const agent = new NativeNeedleAgent(runtime, { root: assetRoot, profile: null });
  agent.health = () => ({ ok: true });
  agent.choose = async (shortlist) => shortlist[0].name;
  agent.arguments = async () => ({ args: {} });
  const result = await agent.run({ task, maxIterations: 4, maxToolCalls: 3 });
  return { invoked, result };
}

const RESTRICTED = ['Inspect the settings', 'Inspect the settings. Do not modify any files.'];
const VETOES = [{ destructiveHint: true }, { readOnlyHint: false }, { readOnlyHint: 'true' }, null, undefined];

for (const namespaced of [false, true]) {
  const flavour = namespaced ? 'namespaced' : 'bare';
  for (const task of RESTRICTED) {
    for (const annotations of VETOES) {
      test(`live gate (${flavour}): live hints ${JSON.stringify(annotations)} stop the call: ${task}`, async () => {
        const { invoked, result } = await run(namespaced, task, descriptor(annotations));
        assert.deepEqual(invoked, []);
        assert.equal(result.status, 'failed');
        assert.equal(result.toolCalls, 0);
        assert.equal(result.iterations, 1, 'a refused call is not retried');
        assert.match(result.decision.reason, /blocked by the permission gate/);
      });
    }

    test(`live gate (${flavour}): a live descriptor that is still read-only runs: ${task}`, async () => {
      const { invoked, result } = await run(namespaced, task, descriptor({ readOnlyHint: true }));
      assert.deepEqual(invoked, ['peek_settings']);
      assert.equal(result.status, 'ok');
    });
  }

  test(`live gate (${flavour}): the runtime's own tools pass through the same check`, async () => {
    const runtime = new HelaRuntime({ namespaced });
    const apply = runtime.agentCatalog().find((tool) => tool.realName === 'hela.update.apply');
    const asked = [];
    await assert.rejects(runtime.executeAgentTool(apply, { confirm: true }, (tool) => { asked.push(tool); return false; }), /not permitted/);
    assert.deepEqual(asked, [{ realName: 'hela.update.apply', annotations: { destructiveHint: true } }]);
  });
}
