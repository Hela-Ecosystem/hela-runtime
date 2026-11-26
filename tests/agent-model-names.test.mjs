// What the model is shown: cell tool names in every namespacing mode. Only the engine call is stubbed, so the real
// choose() and arguments() build the declarations and prompts under test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent } from '../dist/agent.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-names-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells.\n');
test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

const text = { type: 'string' };
const entry = (cell, realName, description, namespaced) => ({
  name: namespaced ? `hela_${cell}_${realName}` : realName, cell: `hela-${cell}`, realName, description,
  inputSchema: { type: 'object', properties: { path: text } },
});

// `pick` stands in for the engine: it sees the declared names and answers with one of them.
async function run(tools, task, pick) {
  const shown = [];
  const ran = [];
  const agent = new NativeNeedleAgent({
    agentCatalog: () => tools,
    agentContext: () => ({ workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' }),
    executeAgentTool: async (tool) => { ran.push(tool.name); return { content: [{ type: 'text', text: 'nothing relevant' }] }; },
  }, { root: assetRoot, profile: null });
  agent.invoke = async (declarations, prompt) => {
    shown.push({ declarations, prompt });
    return { function_calls: [{ name: pick(declarations.map((declaration) => declaration.name), prompt), arguments: {} }] };
  };
  const result = await agent.run({ task, maxIterations: 3, maxToolCalls: 3 });
  return { shown, ran, result };
}
const firstTool = (declared) => declared.find((name) => name !== 'done') ?? 'done';

test('the model sees the same declarations, prompts and history in both namespacing modes', async () => {
  const catalog = (namespaced) => [
    entry('membrane', 'read_file', 'Read the settings file.', namespaced),
    entry('membrane', 'list_directory', 'List the settings files.', namespaced),
    // No hint and no description: the planner falls back to the name.
    { ...entry('genome', 'inspect_untrusted_text', undefined, namespaced), description: undefined, inputSchema: { type: 'object', properties: { settings: text } } },
  ];
  const task = 'Show the settings';
  const bare = await run(catalog(false), task, firstTool);
  const namespaced = await run(catalog(true), task, firstTool);
  assert.deepEqual(namespaced.shown, bare.shown);
  assert.ok(namespaced.shown.some(({ prompt }) => /Recent actions:\n(read_file|list_directory|inspect_untrusted_text)\(/.test(prompt)), 'history was shown');
  assert.ok(!JSON.stringify(namespaced.shown).includes('hela_'));
  assert.ok(bare.ran.length > 1);
  assert.deepEqual(namespaced.ran.map((name) => name.replace(/^hela_[a-z]+_/, '')), bare.ran);
});

test('tools sharing a name are told apart by cell, in declarations and history, and map back', async () => {
  const tools = [
    entry('membrane', 'read_file', 'Read a local settings file.', true),
    entry('receptor', 'read_file', 'Read a device settings file.', true),
  ];
  for (const [declared, exposed] of [['membrane_read_file', 'hela_membrane_read_file'], ['receptor_read_file', 'hela_receptor_read_file']]) {
    const { shown, ran } = await run(tools, 'Inspect the settings', (names) => (names.includes(declared) ? declared : 'done'));
    assert.equal(ran[0], exposed);
    assert.deepEqual(shown[0].declarations.map((entry) => entry.name).sort(), ['done', 'membrane_read_file', 'receptor_read_file']);
    // arguments() declares one tool, so there is nothing to tell apart until history shows both.
    assert.deepEqual(shown[1].declarations.map((entry) => entry.name), ['read_file']);
    assert.match(shown[1].prompt, /Chosen tool: read_file\./);
    assert.match(shown[2].prompt, new RegExp(`Recent actions:\\n${declared}\\(`));
  }
});

test('a name the engine was not offered selects nothing', async () => {
  const tools = [entry('membrane', 'read_file', 'Read a settings file.', true)];
  const agent = new NativeNeedleAgent({ agentCatalog: () => tools, agentContext: () => ({ workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' }), executeAgentTool: async () => ({}) }, { root: assetRoot, profile: null });
  for (const [answer, expected] of [['hela_membrane_read_file', undefined], ['delete_file', undefined], ['read_file', 'hela_membrane_read_file'], ['done', 'done']]) {
    agent.invoke = async () => ({ function_calls: [{ name: answer }] });
    assert.equal(await agent.choose(tools, 'Inspect the settings', undefined, []), expected, answer);
    agent.invoke = async () => ({ suppressed_calls: [{ name: answer }] });
    assert.equal(await agent.choose(tools, 'Inspect the settings', undefined, []), expected, `suppressed ${answer}`);
  }
});

test('a tool named like the done sentinel keeps its cell', async () => {
  const tools = [entry('mitosis', 'done', 'Mark the settings task finished.', true)];
  const { shown } = await run(tools, 'Finish the settings task', () => 'done');
  assert.deepEqual(shown[0].declarations.map((entry) => entry.name), ['mitosis_done', 'done']);
});
