// Cell effect hints: what is accepted into a manifest, and what the gate does with hints it cannot read.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { retrieveTools } from '../dist/agent.js';
import { validTools } from '../dist/manifest.js';

const tool = (annotations) => ({ name: 'read_file', description: 'Read a settings file.', inputSchema: { type: 'object' }, ...(annotations === undefined ? {} : { annotations }) });
const VALID = [undefined, {}, { readOnlyHint: true }, { readOnlyHint: false, destructiveHint: false }, { destructiveHint: true, idempotentHint: true, openWorldHint: true, title: 'Read' }];
const INVALID = [null, 'readOnly', 7, true, [], [{ readOnlyHint: true }], { readOnlyHint: 'true' }, { readOnlyHint: 1 }, { readOnlyHint: null }, { destructiveHint: 'false' }, { readOnlyHint: true, destructiveHint: 0 }];

test('a manifest accepts absent or well-formed annotations only', () => {
  for (const annotations of VALID) assert.equal(validTools([tool(annotations)]), true, JSON.stringify(annotations));
  for (const annotations of INVALID) assert.equal(validTools([tool(annotations)]), false, JSON.stringify(annotations));
});

for (const flavour of ['bare', 'namespaced']) {
  test(`gate (${flavour}): malformed hints refuse a tool to a restricted task, allow-listed or not`, () => {
    for (const realName of ['read_file', 'peek_settings', 'execute_command']) {
      for (const annotations of INVALID) {
        const offered = { ...tool(annotations), name: flavour === 'bare' ? realName : `hela_fixture_${realName}`, realName, cell: 'hela-fixture' };
        const task = realName === 'execute_command' ? 'Check disk usage of the settings' : 'Inspect the settings';
        assert.deepEqual(retrieveTools([offered], task), [], `${realName} ${JSON.stringify(annotations)}`);
      }
    }
  });
}

const catalogFile = new URL('../../hela-mcp-ecosystem/config/tool-catalog.json', import.meta.url);
test('every variant of the sibling ecosystem catalog still validates', { skip: !existsSync(catalogFile) }, () => {
  for (const [cell, { variants }] of Object.entries(JSON.parse(readFileSync(catalogFile)).cells)) {
    for (const variant of variants) assert.equal(validTools(variant.tools), true, cell);
  }
});
