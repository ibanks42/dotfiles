import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Structural check: the renderer only loads inside the Pi TUI host.
function partialBlock() {
  const root = process.env.PI_PATCH_PACKAGE_ROOT;
  assert.ok(root, 'PI_PATCH_PACKAGE_ROOT must point to a package');
  const src = readFileSync(join(root, 'extensions/renderer/tool/ccstyle-tool.ts'), 'utf8');
  const start = src.indexOf('if (!SHELL_TOOL_NAMES.has(toolName)) {\n\t\t\t\t\treturn new Text(theme.fg("muted", pending), 0, 0);');
  assert.notEqual(start, -1, 'running shell branch of renderResult not found');
  const end = src.indexOf('// shell：结果定型时定一次结束时间', start);
  assert.notEqual(end, -1, 'end of running shell branch not found');
  return src.slice(start, end);
}

test('running shell calls offer a per-tool show-more hint', () => {
  assert.match(partialBlock(), /showMoreHintText\(\)/);
});

test('expanded running shell calls render the Input/Output view', () => {
  const block = partialBlock();
  assert.match(block, /if \(expanded\) \{[\s\S]*renderExpandedToolResult\(/);
  assert.match(block, /setFooter\(/);
});
