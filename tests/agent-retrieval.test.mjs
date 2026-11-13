import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, compactParameters, needleEngineCandidates, repairArgs, scoreTools, validateArgs } from '../dist/agent.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-assets-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells. Map tasks to tools.\n');

const tool = (name, description, properties = {}, required = []) => ({
  name,
  cell: 'hela-fixture',
  realName: name,
  description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});

const catalog = [
  tool('execute_command', 'Run a shell command with bash.', {
    command: { type: 'string' }, workingDirectory: { type: 'string' }, host: { type: 'string' },
  }, ['command']),
  tool('list_directory', 'List files and folders in a directory.', { path: { type: 'string' } }, ['path']),
  tool('read_file', 'Read a file from disk.', { path: { type: 'string' } }, ['path']),
  tool('write_file', 'Create or overwrite a file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('browser_navigate', 'Open a URL in the browser.', { url: { type: 'string' } }, ['url']),
  tool('browser_type', 'Type into a form field.', { selector: { type: 'string' }, text: { type: 'string' } }),
  tool('browser_press', 'Press a keyboard key.', { key: { type: 'string' } }, ['key']),
  tool('browser_assert', 'Assert page text or a JavaScript condition.', {
    type: { type: 'string' }, target: { type: 'string' }, expected: { type: 'string' },
  }),
  tool('browser_screenshot', 'Take a screenshot.', { mark_elements: { type: 'boolean' } }),
  tool('academic_search', 'Search academic papers on arXiv.', { query: { type: 'string' } }, ['query']),
  tool('wikipedia_search', 'Search Wikipedia.', { query: { type: 'string' } }),
  tool('google_search', 'Search the web with Google.', { query: { type: 'string' } }, ['query']),
];

const context = { workspaceRoot: '/tmp/hela-workspace', cwd: '/tmp/hela-root' };
const host = {
  agentCatalog: () => catalog,
  executeAgentTool: async (selected, args) => ({ ok: true, tool: selected.name, args }),
  agentContext: () => context,
};

test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

test('Windows Needle resolution prefers executable assets', () => {
  assert.deepEqual(needleEngineCandidates('win32').slice(0, 2), ['needle3.exe', 'needle.exe']);
  assert.deepEqual(needleEngineCandidates('linux'), ['needle3', 'needle']);
});

test('negative roster lines are sanitized before reaching Needle', () => {
  const profilePath = path.join(assetRoot, 'profile-not.txt');
  writeFileSync(profilePath, 'Active: browser, files.\n(Note: mobile and 3D are NOT active in this profile).\n');
  const previous = process.env.NEEDLE_SYSTEM_PATH;
  process.env.NEEDLE_SYSTEM_PATH = profilePath;
  try {
    const agent = new NativeNeedleAgent(host, { root: assetRoot, profile: null });
    const health = agent.health();
    assert.equal(health.system, profilePath);
    assert.equal(health.sanitized, true);
  } finally {
    if (previous === undefined) delete process.env.NEEDLE_SYSTEM_PATH;
    else process.env.NEEDLE_SYSTEM_PATH = previous;
  }
});

test('retrieval ranks the intended tool first', () => {
  const list = scoreTools(catalog, 'List the files in the workspace directory');
  assert.equal(list[0].tool.name, 'list_directory');
  const disk = scoreTools(catalog, 'Check disk usage and list large files');
  assert.equal(disk[0].tool.name, 'execute_command');
  const research = scoreTools(catalog, 'Search the web for recent papers on protein folding');
  assert.equal(research[0].tool.name, 'academic_search');
});

test('plans keep browser, shell and file intents separate', async () => {
  const agent = new NativeNeedleAgent(host, { root: assetRoot, profile: 'dev-workspace' });
  const plan = async (task) => (await agent.plan({ task })).plan.map((step) => step.tool);

  assert.deepEqual(await plan('Open http://127.0.0.1:8765/hela-demo/index.html and verify the headline'), ['browser_navigate', 'browser_assert']);
  assert.deepEqual(await plan('List the files in the workspace directory'), ['list_directory']);
  assert.deepEqual(await plan('Check disk usage and list large files'), ['execute_command']);
  assert.deepEqual(await plan('Search the web for recent papers on protein folding'), ['academic_search']);
  assert.deepEqual(await plan('Read package.json and tell me the version'), ['read_file']);
  assert.deepEqual(await plan('Create a new file notes.md with a summary of the runtime'), ['write_file']);
  assert.deepEqual(await plan('Open Wikipedia, search for HeLa cells, and take a screenshot'), ['browser_navigate', 'browser_type', 'browser_press', 'browser_screenshot']);
});

test('argument repair fills schema-valid values', () => {
  const byName = (name) => catalog.find((entry) => entry.name === name);

  const disk = repairArgs(byName('execute_command'), { command: 'bash', host: 'remote' }, 'Check disk usage and list large files', [], context);
  assert.match(disk.args.command, /df -h/);
  assert.equal(disk.args.host, undefined);
  assert.equal(disk.args.workingDirectory, context.cwd);
  assert.deepEqual(validateArgs(byName('execute_command'), disk.args), { ok: true });

  const counted = repairArgs(byName('execute_command'), { command: 'wc' }, 'Count the lines in the TypeScript files under hela-runtime/src', [], context);
  assert.match(counted.args.command, /find hela-runtime\/src -type f/);
  assert.match(counted.args.command, /wc -l/);

  const listed = repairArgs(byName('list_directory'), { path: 'workspace directory' }, 'List the files in the workspace directory', [], context);
  assert.equal(listed.args.path, context.workspaceRoot);
  assert.deepEqual(validateArgs(byName('list_directory'), listed.args), { ok: true });

  const navigate = repairArgs(byName('browser_navigate'), {}, 'Open example.com and verify the headline', [], context);
  assert.equal(navigate.args.url, 'https://example.com');
  assert.deepEqual(validateArgs(byName('browser_navigate'), navigate.args), { ok: true });

  const typed = repairArgs(byName('browser_type'), { selector: 'https://en.wikipedia.org', text: 'HeLa cells' }, 'Search Wikipedia for HeLa cells', [], context);
  assert.equal(typed.args.selector, 'input[name="search"]');
  assert.equal(typed.args.text, 'HeLa cells');

  const asserted = repairArgs(byName('browser_assert'), { type: 'text', target: 'HeLa', expected: 'text' }, 'Open the demo and verify the headline', [], context);
  assert.equal(asserted.args.type, 'js');
  assert.match(asserted.args.target, /querySelector\("h1"\)/);
});

test('relative source paths resolve against the installation root', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-paths-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(path.join(root, 'hela-runtime'));
  writeFileSync(path.join(root, 'hela-runtime', 'package.json'), '{}');
  const paths = { workspaceRoot: workspace, cwd: workspace };
  try {
    const read = repairArgs(catalog.find((entry) => entry.name === 'read_file'), {}, 'Read hela-runtime/package.json and tell me the version', [], paths);
    assert.equal(read.args.path, path.join(root, 'hela-runtime', 'package.json'));

    const write = repairArgs(catalog.find((entry) => entry.name === 'write_file'), {}, 'Create notes.md with notes about the runtime', [], paths);
    assert.equal(write.args.path, path.join(workspace, 'notes.md'));
    assert.match(write.args.content, /notes about the runtime/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validation rejects missing required fields', () => {
  assert.equal(validateArgs(catalog.find((entry) => entry.name === 'browser_navigate'), {}).ok, false);
  assert.equal(validateArgs(catalog.find((entry) => entry.name === 'browser_navigate'), { url: 'https://example.com' }).ok, true);
});

test('oversized schemas are compacted for the 8k Needle context', () => {
  const bulky = {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: { type: 'string', description: 'main prompt' },
      options: { type: 'object', properties: { nested: { type: 'object', properties: { deep: { type: 'string', description: 'x'.repeat(9000) } } } } },
      count: { type: 'number' },
    },
  };
  const compact = compactParameters(bulky, 500);
  assert.deepEqual(Object.keys(compact.properties).sort(), ['count', 'prompt']);
  assert.equal(compact.properties.options, undefined);
  assert.ok(JSON.stringify(compact).length < 500);
});

