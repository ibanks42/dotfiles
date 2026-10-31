import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { target, bridgeLoader } from './target.mjs';

// Exercise the actual reporter and its socket protocol, not a duplicate state reducer.
test('Herdr stays working for background work and nested subagent calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-activity-'));
  const socket = join(directory, 'agent.sock');
  const reports = [];
  const server = net.createServer(client => {
    let buffer = '';
    client.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.trim());
      if (request.method === 'pane.report_agent') reports.push(request.params);
      client.end('{}\n');
    });
  });
  const saved = { ...process.env };
  await new Promise(resolve => server.listen(socket, resolve));
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: 'w1:p1' });
  try {
    const { default: register } = await import('../../extensions/herdr-agent-state.ts');
    const handlers = new Map();
    const listeners = new Map();
    const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getSessionId: () => 'test-session' } };
    const pi = {
      on(name, handler) { handlers.set(name, handler); },
      events: { on(name, handler) { listeners.set(name, handler); } },
    };
    register(pi);
    const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);
    const bus = (name, event) => listeners.get(name)?.(event);
    const expectState = async state => {
      const deadline = Date.now() + 500;
      while (reports.at(-1)?.state !== state && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(reports.at(-1)?.state, state);
    };
    await emit('session_start');
    await expectState('idle');
    await emit('agent_start');
    await expectState('working');
    bus('herdr:activity', { source: 'background-tasks', active: true });
    await emit('agent_settled');
    // A barrier report ensures any incorrectly queued idle has reached the socket.
    await emit('session_start');
    await expectState('working');
    bus('herdr:blocked', { active: true, label: 'Approval' });
    await expectState('blocked');
    bus('herdr:blocked', { active: false });
    await expectState('working');
    bus('herdr:activity', { source: 'background-tasks', active: false });
    await expectState('idle');

    await emit('agent_start');
    await emit('tool_execution_start', { toolName: 'herdr_subagents', toolCallId: 'codemode/1' });
    await emit('tool_execution_start', { toolName: 'herdr_subagents', toolCallId: 'codemode/2' });
    await emit('agent_settled');
    await emit('tool_execution_end', { toolCallId: 'codemode/1' });
    await expectState('working');
    await emit('tool_execution_end', { toolCallId: 'codemode/2' });
    await expectState('idle');
  } finally {
    for (const key of ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('real background task lifecycle publishes activity even without a UI', async () => {
  const root = target('@maxiaochao/pi-toolkit');
  const load = await bridgeLoader(root);
  const { default: register } = await load.import(join(root, 'packages/background-tasks/extensions/background-tasks.ts'));
  const directory = await mkdtemp(join(tmpdir(), 'herdr-bg-'));
  const handlers = new Map();
  const activity = [];
  const calls = [];
  let tool;
  const ctx = { cwd: directory, mode: 'print', hasUI: false, isIdle: () => false };
  register({
    on(name, handler) { handlers.set(name, handler); },
    events: { emit(name, data) { if (name === 'herdr:activity') activity.push(data); } },
    registerTool(value) { tool = value; }, registerCommand() {}, sendMessage() {},
  }, {
    env: {}, logRoot: directory,
    operations: { exec(_command, _cwd, { signal }) {
      return new Promise(resolve => {
        const finish = () => resolve({ exitCode: 0 });
        calls.push(finish);
        signal.addEventListener('abort', finish, { once: true });
      });
    } },
  });
  try {
    await handlers.get('session_start')({}, ctx);
    await tool.execute('first', { action: 'start', command: 'first' }, undefined, undefined, ctx);
    await tool.execute('second', { action: 'start', command: 'second' }, undefined, undefined, ctx);
    assert.deepEqual(activity.at(-1), { source: 'background-tasks', active: true });
    calls[0]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity.at(-1).active, true, 'one remaining task still owns activity');
    calls[1]();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activity.at(-1).active, false);
    await tool.execute('third', { action: 'start', command: 'third' }, undefined, undefined, ctx);
    assert.equal(activity.at(-1).active, true);
  } finally {
    await handlers.get('session_shutdown')({}, ctx);
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(activity.at(-1).active, false, 'shutdown releases activity');
});
