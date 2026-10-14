// The library's built-in expiration timer does not catch rejected queries.
// Reuse the application's TLS-configured pool and contain those background errors.
export function createSessionStore(MySQLStore, pool, reportError = () => {}) {
  const store = new MySQLStore({ endConnectionOnClose: false }, pool);
  const clearExpired = store.clearExpiredSessions.bind(store);
  store.clearExpiredSessions = () => Promise.resolve().then(clearExpired).catch(error => {
    reportError('limpeza', error);
  });
  store.onReady().catch(error => { reportError('inicializacao', error); });
  return store;
}
