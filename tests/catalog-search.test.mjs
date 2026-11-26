// hela.catalog.search and hela.catalog.list: a cell name is searchable and queries are literal, in both naming modes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelaRuntime } from '../dist/daemon.js';
import { scoreTools } from '../dist/agent.js';

const tool = (name, description) => ({ name, description, inputSchema: { type: 'object', properties: {} } });
// Descriptions avoid their own cell's name; one tool elsewhere mentions another cell.
const CELLS = {
  'hela-membrane': [tool('read_file', 'Read a file from disk.'), tool('move_file', 'Move or rename a file.')],
  'hela-nucleus': [tool('terminal_cat', 'Read remote files; prefer membrane for local ones.'), tool('execute_command', 'Run a shell command.')],
  'hela-receptor': [tool('app_list', 'List installed apps by package.'), tool('screenshot', 'Capture the device screen.')],
  'hela-cytosol': [tool('browser_screenshot', 'Take a screenshot of the page.'), tool('browser_back', 'Go back in history.')],
};
function runtime(namespaced) {
  const host = new HelaRuntime({ namespaced });
  for (const [cell, tools] of Object.entries(CELLS)) {
    host.specs.set(cell, {});
    host.cachedManifest[cell] = tools;
  }
  return host;
}
const MODES = [false, true];
const search = (host, query) => {
  const byName = new Map(host.agentCatalog().map((entry) => [entry.name, entry]));
  return host.catalogSearch({ query, limit: 20 }).matches.map((match) => `${byName.get(match.name).cell}:${byName.get(match.name).realName}`);
};

for (const namespaced of MODES) {
  const mode = namespaced ? 'namespaced' : 'bare';

  test(`catalog search (${mode}): a cell name ranks that cell's tools first`, () => {
    const host = runtime(namespaced);
    for (const cell of Object.keys(CELLS)) {
      for (const query of [cell.replace('hela-', ''), cell]) {
        const own = search(host, query).slice(0, CELLS[cell].length);
        assert.deepEqual(own.sort(), CELLS[cell].map((entry) => `${cell}:${entry.name}`).sort(), query);
      }
    }
  });

  test(`catalog list (${mode}): a cell name query finds that cell's tools`, () => {
    const listed = runtime(namespaced).catalogList({ query: 'membrane' }).tools.slice(0, 2);
    assert.deepEqual(listed.map((entry) => entry.cell), ['hela-membrane', 'hela-membrane']);
  });

  test(`catalog search (${mode}): tool queries and filename or slash queries are matched literally`, () => {
    const host = runtime(namespaced);
    assert.equal(search(host, 'read file disk')[0], 'hela-membrane:read_file');
    assert.equal(search(host, 'cytosol screenshot')[0], 'hela-cytosol:browser_screenshot');
    assert.equal(search(host, 'move/rename')[0], 'hela-membrane:move_file');
    assert.equal(search(host, 'package.json')[0], 'hela-receptor:app_list');
  });
}

test('catalog search ranks identically in both naming modes', () => {
  for (const query of ['membrane', 'nucleus', 'read file', 'screenshot', 'execute command', 'browser']) {
    assert.deepEqual(search(runtime(true), query), search(runtime(false), query), query);
  }
});

test('catalog search applies no task-intent boost; task retrieval does', () => {
  // "run" boosts execute_command for a task. A lookup ranks by the words alone.
  const tools = [
    { ...tool('execute_command', 'Execute a shell command.'), realName: 'execute_command', cell: 'hela-fixture' },
    { ...tool('run_report', 'Run the report.'), realName: 'run_report', cell: 'hela-fixture' },
  ];
  const first = (options) => scoreTools(tools, 'run report', options)[0].tool.realName;
  assert.equal(first({ catalog: true }), 'run_report');
  assert.equal(first({}), 'execute_command');
});

test('task retrieval still ignores cell names', () => {
  assert.deepEqual(scoreTools(runtime(true).agentCatalog().filter((entry) => entry.cell === 'hela-membrane'), 'membrane'), []);
});
