import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SerialTasks } from './serialTasks';

test('resource mutations are ordered, other resources proceed, and failures release the queue', async () => {
  const tasks = new SerialTasks();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = tasks.run('a', async () => { events.push('first'); await gate; throw new Error('failed'); });
  const failure = assert.rejects(first, /failed/);
  const second = tasks.run('a', async () => { events.push('second'); return 42; });
  await tasks.run('b', async () => { events.push('independent'); });
  assert.deepEqual(events, ['first', 'independent']);
  release();
  await failure;
  assert.equal(await second, 42);
  assert.deepEqual(events, ['first', 'independent', 'second']);
});
