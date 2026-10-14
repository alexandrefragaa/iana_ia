import test from 'node:test';
import assert from 'node:assert/strict';
import session from 'express-session';
import MySQLStoreFactory from 'express-mysql-session';
import { createSessionStore } from '../core/session-store.js';

const MySQLStore = MySQLStoreFactory(session);
const unavailable = () => Object.assign(new Error('database temporarily unavailable'), { code: 'ENOTFOUND' });

test('session storage reuses the configured pool and leaves it open when closed', async () => {
  const queries = [];
  const pool = { async query(sql, args) { queries.push({ sql, args }); return [[], []]; }, end() { throw new Error('shared pool must remain open'); } };
  const store = createSessionStore(MySQLStore, pool);
  await store.onReady();
  assert.equal(store.connection, pool);
  assert.equal(store.options.endConnectionOnClose, false);
  assert.match(queries[0].sql, /CREATE TABLE IF NOT EXISTS/);
  await store.close();
});

test('session initialization errors are reported without unhandled rejections', async () => {
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  const store = createSessionStore(MySQLStore, { async query() { throw unavailable(); } }, (operation, error) => report({ operation, error }));
  const result = await reported;
  assert.equal(result.operation, 'inicializacao');
  assert.equal(result.error.code, 'ENOTFOUND');
  await store.close();
});

test('expiration timer absorbs transient query failures and can recover', async () => {
  let offline = false;
  let deleted = 0;
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  const pool = { async query(sql) { if (offline) throw unavailable(); if (sql.startsWith('DELETE')) deleted++; return [[], []]; } };
  const store = createSessionStore(MySQLStore, pool, (operation, error) => report({ operation, error }));
  await store.onReady();
  offline = true;
  store.setExpirationInterval(10);
  const result = await reported;
  store.clearExpirationInterval();
  assert.equal(result.operation, 'limpeza');
  assert.equal(result.error.code, 'ENOTFOUND');
  offline = false;
  await store.clearExpiredSessions();
  assert.equal(deleted, 1);
  await store.close();
});

test('session read/write errors reach Express callbacks without granting authentication', async () => {
  let offline = false;
  const pool = { async query() { if (offline) throw unavailable(); return [[], []]; } };
  const store = createSessionStore(MySQLStore, pool);
  await store.onReady();
  offline = true;
  for (const [method, args] of [['get', ['missing-session']], ['set', ['session-id', { cookie: {} }]], ['touch', ['session-id', { cookie: {} }]], ['destroy', ['session-id']]]) {
    const result = await new Promise(resolve => { store[method](...args, (error, value) => resolve({ error, value })); });
    assert.equal(result.error.code, 'ENOTFOUND', method);
    assert.equal(result.value, undefined, method);
  }
  await store.close();
});
