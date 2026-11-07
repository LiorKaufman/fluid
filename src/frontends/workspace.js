/* This frontend only knows window.fluid. It cannot access storage or Electron. */
(() => {
  const mode = window.FRONTEND_MODE;
  const app = document.getElementById('app');
  const icons = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    circle: '<circle cx="12" cy="12" r="8"/><path d="m12 8 0 4 3 2"/>',
    layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 10 9 5 9-5M3 18l9 5 9-5"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    leaf: '<path d="M19 3C9 3 3 7 5 14s14 5 14-11Z"/><path d="m4 21 11-12"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  };
  const icon = (name, size = 15) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg>`;
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  let tasks = [],
    grants = [],
    filter = 'all',
    project = 'all',
    search = '',
    focusIndex = 0;
  let loading = false,
    again = false,
    disposed = false;
  let modalTask = null;
  const canWrite = () => grants.includes('tasks:write');
  const isToday = (date) => date === new Date().toLocaleDateString('en-CA');
  const dateLabel = (date) => {
    if (!date) return 'No date';
    const today = new Date();
    const tomorrow = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1,
      12,
    ).toLocaleDateString('en-CA');
    if (isToday(date)) return 'Today';
    if (date === tomorrow) return 'Tomorrow';
    return new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  };
  const toast = (message) => {
    document.querySelector('.toast')?.remove();
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    node.setAttribute('role', 'status');
    document.body.append(node);
    setTimeout(() => node.remove(), 4500);
  };
  async function refresh() {
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const info = await fluid.call('workspace.describe');
      grants = info.grantedPermissions;
      const result = await fluid.call('tasks.list');
      tasks = result.tasks;
      if (!document.querySelector('.modal-backdrop')) render();
    } catch (error) {
      if (!document.querySelector('.modal-backdrop'))
        app.innerHTML = `<div class="error-page"><div class="eyebrow">Your data stays in your hands</div><h2>${error.code === 'PERMISSION_DENIED' ? 'This interface needs read access' : 'Let’s reconnect your workspace'}</h2><p>${esc(error.message)}</p><p>Open Permissions in the sidebar to manage access.</p></div>`;
    } finally {
      loading = false;
      if (again && !disposed) {
        again = false;
        refresh();
      }
    }
  }
  function visibleTasks() {
    return tasks.filter(
      (t) =>
        (filter === 'all' || t.status === filter) &&
        (project === 'all' || t.project === project) &&
        (!search ||
          `${t.title} ${t.notes}`.toLowerCase().includes(search.toLowerCase())),
    );
  }
  const projectLabel = (task) =>
    `<span class="project" data-project="${esc(task.project)}">${esc(task.project)}</span>`;
  const due = (task) =>
    `<span class="due ${isToday(task.dueDate) ? 'today' : ''}">${esc(dateLabel(task.dueDate))}</span>`;
  function render() {
    document.body.classList.toggle('focus-mode', mode === 'focus');
    if (mode === 'focus') {
      renderFocus();
      return;
    }
    const done = tasks.filter((t) => t.status === 'done').length;
    const progress = tasks.filter((t) => t.status === 'in-progress').length;
    app.innerHTML = `<main class="workspace">
      <div class="intro"><div><div class="eyebrow">A space for what matters</div><h1>${mode === 'board' ? 'A little momentum goes a long way.' : 'Make room for good work.'}</h1><p>${mode === 'board' ? 'Same work. A fresh perspective. Move things forward at your pace.' : 'Big ideas, small steps, and everything in between. Make yourself at home.'}</p></div><button class="primary" id="new-task" ${!canWrite() ? 'disabled title="Enable write access in Permissions"' : ''}>${icon('plus', 14)} New task</button></div>
      <section class="stats" aria-label="Workspace summary"><div class="stat"><div class="stat-label">On your radar ${icon('layers')}</div><span class="stat-number">${tasks.length - done}</span><span class="stat-note">things to make happen</span></div><div class="stat"><div class="stat-label">In the making ${icon('circle')}</div><span class="stat-number">${progress}</span><span class="stat-note">a little closer every day</span></div><div class="stat"><div class="stat-label">A little progress ${icon('leaf')}</div><span class="stat-number">${done}</span><span class="stat-note">done & feeling good</span></div></section>
      <div class="toolbar"><h2>${mode === 'board' ? 'The bigger picture' : 'Your tasks'} <span style="color:#a8b1a2;font-size:11px;font-weight:400;margin-left:7px">${tasks.length}</span></h2><div class="search">${icon('search', 13)}<input aria-label="Search tasks" placeholder="Find a task…" value="${esc(search)}" id="search"><select class="select" id="project-filter" aria-label="Filter by project"><option value="all">All projects</option>${[...new Set(tasks.map((t) => t.project))].map((p) => `<option ${project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></div></div>
      ${
        mode === 'list'
          ? `<div class="tabs" role="tablist">${[
              ['all', 'All tasks'],
              ['todo', 'To do'],
              ['in-progress', 'In progress'],
              ['done', 'Completed'],
            ]
              .map(
                ([id, label]) =>
                  `<button role="tab" aria-selected="${filter === id}" class="tab ${filter === id ? 'active' : ''}" data-filter="${id}">${label}<span>${id === 'all' ? tasks.length : tasks.filter((t) => t.status === id).length}</span></button>`,
              )
              .join('')}</div>${renderList()}`
          : renderBoard()
      }
      <div class="footnote"><span>A good day starts with a little clarity.</span><em>${icon('leaf', 11)} Your work, at your pace.</em></div>
    </main>`;
    bind();
  }
  function renderList() {
    const rows = visibleTasks();
    return `<div class="table"><div class="table-head"><span>Task name</span><span class="project-cell">Project</span><span class="priority-label">Priority</span><span>Due date</span><span></span></div>${rows.length ? rows.map((t) => `<div class="task-row"><div class="task-title ${t.status === 'done' ? 'done' : ''}"><button class="check ${t.status === 'done' ? 'checked' : t.status === 'in-progress' ? 'progress' : ''}" data-toggle="${t.id}" aria-label="${t.status === 'done' ? 'Reopen' : 'Complete'} ${esc(t.title)}" ${!canWrite() ? 'disabled' : ''}>${t.status === 'done' ? icon('check', 11) : ''}</button><button class="title-button" data-edit="${t.id}">${esc(t.title)}</button></div><div class="project-cell">${projectLabel(t)}</div><span class="priority ${t.priority}"><i></i>${t.priority[0].toUpperCase() + t.priority.slice(1)}</span>${due(t)}<button class="more" data-edit="${t.id}" aria-label="Edit ${esc(t.title)}">···</button></div>`).join('') : '<div class="empty"><h3>A little breathing room.</h3><p>No tasks match this view.</p></div>'}<button class="add-row" id="add-row" ${!canWrite() ? 'disabled' : ''}>＋ &nbsp; Add a new task</button></div>`;
  }
  function renderBoard() {
    const rows = visibleTasks();
    return `<div class="board">${[
      ['todo', 'To do'],
      ['in-progress', 'In progress'],
      ['done', 'Completed'],
    ]
      .map(
        ([status, label]) =>
          `<section class="column"><div class="column-heading"><strong><i class="status-dot ${status}"></i>${label}</strong><span>${rows.filter((t) => t.status === status).length}</span></div>${rows
            .filter((t) => t.status === status)
            .map(
              (t) =>
                `<article class="card">${projectLabel(t)}<h3><button data-edit="${t.id}" style="padding:0;text-align:left">${esc(t.title)}</button></h3><p>${esc(t.notes)}</p><div class="card-meta"><span class="priority ${t.priority}"><i></i>${t.priority}</span>${due(t)}</div><div class="card-actions"><button data-move="${t.id}" data-status="${status === 'todo' ? 'in-progress' : status === 'in-progress' ? 'done' : 'todo'}" ${!canWrite() ? 'disabled' : ''}>${status === 'todo' ? 'Start working →' : status === 'in-progress' ? 'Mark complete ✓' : 'Reopen ↗'}</button></div></article>`,
            )
            .join(
              '',
            )}<button class="add-row" data-new-status="${status}" ${!canWrite() ? 'disabled' : ''}>＋ Add task</button></section>`,
      )
      .join('')}</div>`;
  }
  function renderFocus() {
    const queue = tasks
      .filter((t) => t.status !== 'done')
      .sort(
        (a, b) =>
          (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0),
      );
    focusIndex = queue.length ? focusIndex % queue.length : 0;
    const task = queue[focusIndex];
    app.innerHTML = `<main class="workspace"><div class="eyebrow">A quieter kind of workspace</div><div class="intro"><div><h1>One thing at a time.</h1><p>Take a breath. Find your rhythm. The rest can wait.</p></div><span style="color:#91a48a;font-size:11px">${queue.length} things ahead</span></div>${
      task
        ? `<article class="focus-card">${projectLabel(task)}<h2>${esc(task.title)}</h2><p>${esc(task.notes || 'Give this a little space and see where it takes you.')}</p><div style="margin-top:20px">${due(task)}</div><div class="focus-actions"><button class="primary" id="complete-focus" ${!canWrite() ? 'disabled' : ''}>${icon('check')} Mark complete</button><button class="subtle" id="next-focus">Something else ${icon('arrow', 12)}</button><button class="subtle" data-edit="${task.id}">Edit task</button></div></article><section class="focus-queue"><h3>WAITING IN THE WINGS</h3>${queue
            .filter((t) => t.id !== task.id)
            .slice(0, 3)
            .map(
              (t, i) =>
                `<div class="queue-item"><span>0${i + 1}</span><button data-edit="${t.id}">${esc(t.title)}</button><span style="margin-left:auto">${due(t)}</span></div>`,
            )
            .join('')}</section>`
        : '<div class="focus-card empty"><h3>You’ve made room.</h3><p>Everything is done. Enjoy a well-earned pause.</p><button class="primary" id="new-task" style="margin-top:25px">Add something new</button></div>'
    }<div class="footnote"><span>Focus is a small act of kindness to yourself.</span><em>${icon('leaf', 12)} Made for your pace.</em></div></main>`;
    bind();
    document.getElementById('next-focus')?.addEventListener('click', () => {
      focusIndex++;
      renderFocus();
    });
    document
      .getElementById('complete-focus')
      ?.addEventListener('click', () =>
        mutate(
          'tasks.update',
          { id: task.id, status: 'done' },
          'A little progress. Nicely done.',
        ),
      );
  }
  async function mutate(name, values, message) {
    try {
      await fluid.call(name, values);
      await refresh();
      if (message) toast(message);
    } catch (error) {
      toast(error.message);
    }
  }
  function bind() {
    document
      .getElementById('new-task')
      ?.addEventListener('click', () => showModal());
    document
      .getElementById('add-row')
      ?.addEventListener('click', () => showModal());
    document
      .querySelectorAll('[data-new-status]')
      .forEach((button) =>
        button.addEventListener('click', () =>
          showModal(null, button.dataset.newStatus),
        ),
      );
    document.querySelectorAll('[data-toggle]').forEach((button) =>
      button.addEventListener('click', () => {
        const task = tasks.find((t) => t.id === button.dataset.toggle);
        mutate(
          'tasks.update',
          { id: task.id, status: task.status === 'done' ? 'todo' : 'done' },
          task.status === 'done'
            ? 'Task reopened.'
            : 'A little progress. Nicely done.',
        );
      }),
    );
    document
      .querySelectorAll('[data-edit]')
      .forEach((button) =>
        button.addEventListener('click', () =>
          showModal(tasks.find((t) => t.id === button.dataset.edit)),
        ),
      );
    document.querySelectorAll('[data-move]').forEach((button) =>
      button.addEventListener('click', () =>
        mutate('tasks.update', {
          id: button.dataset.move,
          status: button.dataset.status,
        }),
      ),
    );
    document.querySelectorAll('[data-filter]').forEach((button) =>
      button.addEventListener('click', () => {
        filter = button.dataset.filter;
        render();
      }),
    );
    document
      .getElementById('project-filter')
      ?.addEventListener('change', (event) => {
        project = event.target.value;
        render();
      });
    document.getElementById('search')?.addEventListener('input', (event) => {
      search = event.target.value;
      const start = event.target.selectionStart;
      render();
      const field = document.getElementById('search');
      field.focus();
      field.setSelectionRange(start, start);
    });
  }
  function showModal(task = null, initialStatus = 'todo') {
    modalTask = task;
    const node = document.createElement('div');
    node.className = 'modal-backdrop';
    node.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="task-heading"><h2 id="task-heading">${task ? 'A little attention to detail.' : 'What’s on your mind?'}</h2><label class="form-field">Task name<input name="title" required maxlength="240" placeholder="Give your next step a name…" value="${esc(task?.title || '')}" ${!canWrite() ? 'disabled' : ''}></label><label class="form-field">A little context<textarea name="notes" maxlength="8000" placeholder="Notes, ideas, or a place to start…" ${!canWrite() ? 'disabled' : ''}>${esc(task?.notes || '')}</textarea></label><div class="form-row"><label class="form-field">Project<input name="project" value="${esc(task?.project || 'General')}" maxlength="80" required ${!canWrite() ? 'disabled' : ''}></label><label class="form-field">Due date<input type="date" name="dueDate" value="${esc(task?.dueDate || '')}" ${!canWrite() ? 'disabled' : ''}></label></div><div class="form-row"><label class="form-field">Status<select name="status" ${!canWrite() ? 'disabled' : ''}>${[
      ['todo', 'To do'],
      ['in-progress', 'In progress'],
      ['done', 'Completed'],
    ]
      .map(
        ([id, label]) =>
          `<option value="${id}" ${(task?.status || initialStatus) === id ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select></label><label class="form-field">Priority<select name="priority" ${!canWrite() ? 'disabled' : ''}>${['low', 'medium', 'high'].map((p) => `<option ${(task?.priority || 'medium') === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label></div><div class="form-error" role="alert"></div><div class="modal-footer"><span>${task && grants.includes('tasks:delete') ? '<button type="button" class="danger" id="delete-task">Delete task</button>' : ''}</span><div><button type="button" class="subtle" id="cancel">${canWrite() ? 'Cancel' : 'Close'}</button>${canWrite() ? '<button type="submit" class="primary">Save task</button>' : ''}</div></div></form>`;
    document.body.append(node);
    const close = () => {
      node.remove();
      modalTask = null;
      refresh();
    };
    node.querySelector('#cancel').onclick = close;
    node.onclick = (event) => {
      if (event.target === node) close();
    };
    node.querySelector('[name="title"]').focus();
    node.querySelector('form').onsubmit = async (event) => {
      event.preventDefault();
      const button = node.querySelector('[type="submit"]');
      button.disabled = true;
      const values = Object.fromEntries(new FormData(event.target));
      values.dueDate ||= null;
      try {
        await fluid.call(task ? 'tasks.update' : 'tasks.create', {
          ...(task ? { id: task.id } : {}),
          ...values,
        });
        close();
        toast(task ? 'Changes saved.' : 'A fresh idea, captured.');
      } catch (error) {
        node.querySelector('.form-error').textContent = error.message;
        button.disabled = false;
      }
    };
    node
      .querySelector('#delete-task')
      ?.addEventListener('click', async (event) => {
        const button = event.target;
        if (button.dataset.confirm !== 'yes') {
          button.dataset.confirm = 'yes';
          button.textContent = 'Delete permanently? Click again';
          return;
        }
        button.disabled = true;
        try {
          await fluid.call('tasks.delete', { id: task.id });
          close();
          toast('Task deleted.');
        } catch (error) {
          node.querySelector('.form-error').textContent = error.message;
          button.disabled = false;
        }
      });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      document.querySelector('.modal-backdrop')?.remove();
      modalTask = null;
      refresh();
    }
  });
  fluid.subscribe(refresh);
  window.addEventListener('pagehide', () => {
    disposed = true;
  });
  refresh();
})();
