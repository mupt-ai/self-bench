import { expect, test } from 'bun:test';

import { loadGuardedTaskDetail } from './detail-loader';
import type { TaskDetail } from './types';

test('a refresh detail response cannot overwrite a task selected while it was pending', async () => {
  let selected = 'old-task';
  let resolveDetail!: (detail: TaskDetail) => void;
  const pending = new Promise<TaskDetail>((resolve) => { resolveDetail = resolve; });
  const committed: TaskDetail[] = [];
  const controller = new AbortController();

  const loading = loadGuardedTaskDetail(
    'old-task',
    controller.signal,
    (taskId) => selected === taskId,
    () => pending,
    (detail) => committed.push(detail),
  );
  selected = 'new-task';
  resolveDetail({ summary: { task_id: 'old-task' } } as TaskDetail);
  await loading;

  expect(committed).toEqual([]);
});
