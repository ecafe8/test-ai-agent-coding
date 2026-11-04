import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { addTodo, toggleTodo, removeTodo, saveTodos, loadTodos } from '../src/todo.mjs';

function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test('adding tasks trims the title, rejects invalid input, and keeps the original list', () => {
  const original = Object.freeze([]);
  const items = addTodo(original, '  Buy milk  ', 'task-1');
  assert.deepEqual(original, []);
  assert.deepEqual(items, [{ id: 'task-1', title: 'Buy milk', completed: false }]);
  assert.throws(() => addTodo(items, '  ', 'task-2'));
  assert.throws(() => addTodo(items, 'Another', ''));
  assert.throws(() => addTodo(items, 'Another', 'task-1'));
});

test('toggling and removing tasks do not mutate the input', () => {
  const initial = Object.freeze([Object.freeze({ id: 'task-1', title: 'Buy milk', completed: false })]);
  const toggled = toggleTodo(initial, 'task-1');
  assert.deepEqual(toggled, [{ id: 'task-1', title: 'Buy milk', completed: true }]);
  assert.deepEqual(toggleTodo(toggled, 'task-1'), initial);
  assert.deepEqual(toggleTodo(initial, 'missing'), initial);
  assert.deepEqual(removeTodo(initial, 'task-1'), []);
  assert.deepEqual(removeTodo(initial, 'missing'), initial);
  assert.equal(initial[0].completed, false);
});

test('tasks round-trip through browser-style storage; missing and malformed data are empty', () => {
  const store = storage();
  assert.deepEqual(loadTodos(store), []);
  const items = [{ id: 'task-1', title: 'Buy milk', completed: true }];
  saveTodos(store, items);
  assert.equal(store.getItem('todo-list-v1'), JSON.stringify(items));
  assert.deepEqual(loadTodos(store), items);
  store.setItem('todo-list-v1', '{');
  assert.deepEqual(loadTodos(store), []);
});

test('static page exposes an input, button, app module and stylesheet', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const style = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(page, /<input\b/i);
  assert.match(page, /<button\b/i);
  assert.match(page, /src\/app\.mjs/i);
  assert.match(page, /styles\.css/i);
  assert.ok(style.trim());
});
