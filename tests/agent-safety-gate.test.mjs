// Review of 38e13fa: one permission gate for write-banned and read-only tasks. Every case runs against a bare and a
// namespaced catalog. Needle is stubbed to make the worst choice: the gate, not the model, is under test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, retrieveTools } from '../dist/agent.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-gate-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells.\n');
test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

const context = { workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' };
const envelope = (value) => ({ content: [{ type: 'text', text: value }] });
const FLAVOURS = ['bare', 'namespaced'];
const text = { type: 'string' };
const catalogOf = (flavour, specs) => specs.map(([realName, description, properties = {}, required = [], annotations]) => ({
  name: flavour === 'bare' ? realName : `hela_fixture_${realName}`, cell: 'hela-fixture', realName, description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) }, ...(annotations ? { annotations } : {}),
}));

// Needle picks `want` whenever it is offered, and answers with it even when it is not.
async function run(tools, task, want, args = {}) {
  const calls = [];
  const offered = new Set();
  const agent = new NativeNeedleAgent({
    agentCatalog: () => tools, agentContext: () => context,
    executeAgentTool: async (tool, repaired) => { calls.push({ tool: tool.realName, args: repaired }); return envelope('settings files command'); },
  }, { root: assetRoot, profile: null });
  agent.choose = async (shortlist) => {
    for (const tool of shortlist) offered.add(tool.realName);
    return shortlist.find((tool) => tool.realName === want)?.name ?? tools.find((tool) => tool.realName === want)?.name;
  };
  agent.arguments = async (tool) => ({ args: args[tool.realName] ?? {} });
  const result = await agent.run({ task, maxIterations: 5, maxToolCalls: 5 });
  const { plan } = await agent.plan({ task });
  return { result, calls, ran: calls.map((call) => call.tool), offered: [...offered], plan: plan.map((step) => step.tool) };
}

const SIDE_EFFECTS = [
  'execute_command', 'shell_exec', 'session_spawn', 'session_write', 'transfer_file', 'execute_sql',
  'execute_blender_code', 'agent_spawn', 'browser_evaluate', 'browser_check', 'data_export', 'some_future_tool',
];
const dangerous = [
  ...SIDE_EFFECTS.map((name) => [name, `Inspect repository configuration settings files command with ${name}.`, { command: text }]),
  ['read_file', 'Read a configuration file.', { path: text }],
];

for (const flavour of FLAVOURS) {
  const tools = catalogOf(flavour, dangerous);
  for (const task of [
    'Inspect the repository configuration. Do not modify any files.',
    'Inspect the repository configuration settings.',
    'Tell me which command settings files exist',
  ]) {
    for (const want of SIDE_EFFECTS) {
      test(`gate (${flavour}): ${want} is never offered, planned or run for: ${task}`, async () => {
        const { ran, offered, plan } = await run(tools, task, want, { [want]: { command: 'touch /tmp/never' } });
        for (const list of [ran, offered, plan, retrieveTools(tools, task, [], 50).map((tool) => tool.realName)]) {
          assert.deepEqual(list.filter((name) => SIDE_EFFECTS.includes(name)), []);
        }
      });
    }
  }

  test(`gate (${flavour}): cell hints decide before the allow-list`, () => {
    const hinted = catalogOf(flavour, [
      ['peek_settings', 'Inspect settings.', {}, [], { readOnlyHint: true }],
      ['poke_settings', 'Inspect settings.', {}, [], { readOnlyHint: false }],
      ['read_file', 'Inspect settings.', {}, [], { destructiveHint: true }],
      ['delete_settings', 'Inspect settings.', {}, [], { readOnlyHint: true }],
      ['list_directory', 'Inspect settings.'],
    ]);
    assert.deepEqual(retrieveTools(hinted, 'Inspect the settings', [], 10).map((tool) => tool.realName).sort(), ['list_directory', 'peek_settings']);
  });

  const shell = catalogOf(flavour, [['execute_command', 'Run a shell command.', { command: text, env: { type: 'object' }, useRtk: { type: 'boolean' } }, ['command']]]);
  const sabotage = { execute_command: { command: 'touch /tmp/never', env: { GIT_EXTERNAL_DIFF: '/tmp/x' }, useRtk: false } };

  test(`gate (${flavour}): a read-only diagnostic runs the runtime's command and nothing from the model`, async () => {
    for (const task of ['Check disk usage and list large files', 'Show the git status', 'Tell me about `touch /tmp/never` and disk usage']) {
      const { calls } = await run(shell, task, 'execute_command', sabotage);
      for (const call of calls) {
        assert.doesNotMatch(call.args.command, /touch/, task);
        assert.deepEqual(Object.keys(call.args).sort(), ['command', 'workingDirectory'], task);
      }
      assert.equal(calls.length, task.includes('`') ? 0 : 1, task);
    }
  });

  test(`gate (${flavour}): a write ban closes the shell even for diagnostics`, async () => {
    const { ran, plan, result } = await run(shell, 'Check disk usage. Do not modify any files.', 'execute_command', sabotage);
    assert.deepEqual([ran, plan], [[], []]);
    assert.equal(result.status, 'failed');
  });

  test(`gate (${flavour}): the final arguments are checked at dispatch`, async () => {
    const browser = catalogOf(flavour, [['browser_navigate', 'Open a URL.', { url: text }, ['url']]]);
    const task = 'Open the settings page. Do not modify any files.';
    const { ran, result } = await run(browser, task, 'browser_navigate', { browser_navigate: { url: 'javascript:document.body.remove()' } });
    assert.deepEqual(ran, []);
    assert.match(result.decision.reason, /permission gate/);
  });

  test(`gate (${flavour}): an unrecognised change verb is not treated as read-only`, async () => {
    const dirs = catalogOf(flavour, [['create_directory', 'Create a directory.', { path: text }, ['path']]]);
    for (const task of ['Provision a directory at /tmp/output', 'Set up a directory at /tmp/output', 'Scaffold a directory at /tmp/output']) {
      const { ran } = await run(dirs, task, 'create_directory', { create_directory: { path: '/tmp/output' } });
      assert.deepEqual(ran.slice(0, 1), ['create_directory'], task);
    }
  });

  const page = catalogOf(flavour, [
    ['browser_navigate', 'Open a URL in the browser page.', { url: text }, ['url']],
    ['browser_get_state', 'Inspect the current page settings.'],
    ['browser_click', 'Click an element on the page. Delete settings.', { selector: text }],
    ['browser_type', 'Type into a form on the page.', { text }],
    ['browser_press', 'Press a key on the page to submit.', { key: text }],
    ['browser_screenshot', 'Take a screenshot of the page.'],
    ['delete_file', 'Delete a settings file on the page.', { path: text }],
  ]);
  const BANNED_BY = { browser_click: /click/i, browser_type: /typ/i, browser_press: /press|submit|click/i, delete_file: /delet|modify/i };
  const ACTIONS = Object.keys(BANNED_BY);

  for (const task of [
    'Open https://example.test/settings and inspect the page. Do not click Delete. Do not modify any files.',
    'Open https://example.test/settings and inspect the page. Do not click Delete.',
    'Open https://example.test/settings and take a screenshot. Do not click, type, submit or delete anything.',
    'Open https://example.test/settings and take a screenshot without clicking, typing, or submitting anything',
    "Open https://example.test/settings. Don't click or type, and never press Enter.",
    'Open https://example.test/settings. You should not, under any circumstances, delete or click anything.',
  ]) {
    for (const want of ACTIONS.filter((name) => BANNED_BY[name].test(task))) {
      test(`gate (${flavour}): a banned ${want} is neither planned nor run: ${task}`, async () => {
        const { ran, plan } = await run(page, task, want, { browser_navigate: { url: 'https://example.test/settings' } });
        assert.ok(!plan.includes(want), `planned: ${plan}`);
        assert.ok(!ran.includes(want), `ran: ${ran}`);
        assert.equal(ran[0], 'browser_navigate');
      });
    }
  }

  test(`gate (${flavour}): a ban ends where the next request begins`, async () => {
    const planOf = async (task) => (await run(page, task, 'browser_navigate')).plan;
    assert.deepEqual(await planOf('Open https://example.test/a. Do not click Delete and take a screenshot'), ['browser_navigate', 'browser_screenshot']);
    assert.deepEqual(await planOf('Open https://example.test/a, do not type anything, just click Next'), ['browser_navigate', 'browser_click']);
    assert.deepEqual(await planOf('Open https://example.test/a, do not take a screenshot, and click Next'), ['browser_navigate', 'browser_click']);
  });

  test(`gate (${flavour}): many negations do not stall the gate`, () => {
    for (const task of [`inspect ${"don't ".repeat(20000)}`, `inspect do not click${', type'.repeat(20000)}`]) {
      const started = Date.now();
      retrieveTools(page, task);
      assert.ok(Date.now() - started < 5000, task.slice(0, 30));
    }
  });

  test(`gate (${flavour}): a ban naming a concrete file stays a full write ban`, async () => {
    const writers = catalogOf(flavour, [['write_file', 'Write a file.', { path: text }], ['copy_file', 'Copy a file.', { path: text }], ['read_file', 'Read a file.', { path: text }]]);
    for (const task of ['Summarise notes. Do not modify a.txt', 'Read /etc/hosts and do not change /tmp/a.txt', 'Show config.json without editing config.json', 'Copy a.txt to b.txt, do not change /tmp/c.txt']) {
      for (const want of ['write_file', 'copy_file']) {
        const { ran, offered, plan } = await run(writers, task, want, { [want]: { path: '/tmp/never' } });
        for (const list of [ran, offered, plan]) assert.ok(!list.includes(want), `${want}: ${task}`);
      }
    }
  });

  test(`gate (${flavour}): a question about deleting is not permission to delete`, async () => {
    const files = catalogOf(flavour, [['delete_file', 'Delete a file the app owns.', { path: text }], ['get_file_info', 'Get file metadata.', { path: text }]]);
    for (const task of ['Tell me which files the app can delete', 'Which files can I delete?', 'Inspect metadata for delete.md.']) {
      const { ran, offered } = await run(files, task, 'delete_file', { delete_file: { path: '/tmp/never' } });
      assert.ok(!ran.includes('delete_file') && !offered.includes('delete_file'), task);
    }
  });
}
