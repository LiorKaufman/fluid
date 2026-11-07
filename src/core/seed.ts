import type { Task } from '../protocol/index.ts';
export function seedTasks(): Task[] {
  const now = new Date();
  const due = (days: number) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + days,
      12,
    );
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const rows = [
    [
      'Find the feeling for our new homepage',
      'Brand refresh',
      'in-progress',
      'high',
      0,
      'Explore a warmer palette and a more human voice.',
    ],
    [
      'Sketch the first onboarding flow',
      'Fluid launch',
      'in-progress',
      'high',
      0,
      'A short path from opening the app to making it your own.',
    ],
    [
      'Write a few words about the protocol',
      'Fluid launch',
      'todo',
      'medium',
      1,
      'Explain the contract, the runtime, and why interfaces belong to users.',
    ],
    [
      'Collect inspiration for the studio',
      'Brand refresh',
      'todo',
      'low',
      2,
      'Quiet spaces, useful objects, and things with character.',
    ],
    [
      'Take the board interface for a spin',
      'Fluid launch',
      'todo',
      'medium',
      2,
      'Switch interfaces. Your work comes with you.',
    ],
    [
      'Make something just for the fun of it',
      'Personal',
      'todo',
      'low',
      4,
      'Leave a little room for a happy accident.',
    ],
    [
      'Set up a space to think',
      'Personal',
      'done',
      'medium',
      -1,
      'A fresh workspace, ready for good work.',
    ],
    [
      'Define what an app can expose',
      'Fluid launch',
      'done',
      'high',
      -1,
      'Data, actions, permissions, and meaning.',
    ],
  ];
  return rows.map(
    ([title, project, status, priority, days, notes], i) =>
      ({
        id: `task-${i + 1}`,
        title,
        project,
        status,
        priority,
        dueDate: due(Number(days)),
        notes,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      }) as Task,
  );
}
