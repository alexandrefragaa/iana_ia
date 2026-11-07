import test from 'node:test';
import assert from 'node:assert/strict';
import { createChangePasswordHandler } from '../core/change-password.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function setup({ mysqlAvailable = true, rows = [{ senha: 'hash-antigo' }], compare = true, affectedRows = 1, queryError } = {}) {
  const calls = [];
  const logs = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (queryError) throw queryError;
      if (sql.startsWith('SELECT')) return [rows];
      return [{ affectedRows }];
    }
  };
  const bcrypt = {
    async compare(plain, hash) {
      calls.push({ compare: [plain, hash] });
      return compare;
    },
    async hash(plain, cost) {
      calls.push({ hash: [plain, cost] });
      return 'hash-novo';
    }
  };
  const handler = createChangePasswordHandler({
    pool,
    bcrypt,
    isMysqlAvailable: () => mysqlAvailable,
    logger: { error: (...args) => logs.push(args) }
  });
  return { handler, calls, logs };
}

async function invoke(handler, body = { senhaAtual: 'senha-antiga', novaSenha: 'senha-nova-123' }) {
  const res = response();
  await handler({ body, user: { id: 42 } }, res);
  return res;
}

test('troca de senha exige os dois campos como strings', async () => {
  const { handler, calls } = setup();
  for (const body of [
    {},
    { senhaAtual: 123, novaSenha: 'senha-nova-123' },
    { senhaAtual: 'senha-antiga', novaSenha: null }
  ]) {
    const res = await invoke(handler, body);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('troca de senha aplica tamanho mínimo, máximo e diferença', async () => {
  const { handler, calls } = setup();
  for (const novaSenha of ['1234567', 'x'.repeat(129), 'senha-antiga']) {
    const res = await invoke(handler, { senhaAtual: 'senha-antiga', novaSenha });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(calls.length, 0);
});

test('não tenta alterar senha quando o MySQL está indisponível', async () => {
  const { handler, calls } = setup({ mysqlAvailable: false });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 503);
  assert.equal(calls.length, 0);
});

test('retorna 404 quando a conta não existe', async () => {
  const { handler, calls } = setup({ rows: [] });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 404);
  assert.equal(calls.length, 1);
});

test('rejeita senha atual incorreta sem atualizar o banco', async () => {
  const { handler, calls } = setup({ compare: false });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.filter(call => call.sql?.startsWith('UPDATE')).length, 0);
});

test('atualiza somente o hash após validar a senha atual', async () => {
  const { handler, calls } = setup();
  const res = await invoke(handler, {
    senhaAtual: ' senha-antiga ',
    novaSenha: ' senha-nova-123 '
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'sucesso');
  assert.deepEqual(calls[0], {
    sql: 'SELECT senha FROM usuarios WHERE id = ? LIMIT 1',
    params: [42]
  });
  assert.deepEqual(calls[1], { compare: ['senha-antiga', 'hash-antigo'] });
  assert.deepEqual(calls[2], { hash: ['senha-nova-123', 12] });
  assert.deepEqual(calls[3], {
    sql: 'UPDATE usuarios SET senha = ? WHERE id = ?',
    params: ['hash-novo', 42]
  });
});

test('retorna 404 se nenhuma linha for atualizada', async () => {
  const { handler } = setup({ affectedRows: 0 });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 404);
});

test('falha de banco retorna erro genérico sem registrar mensagem sensível', async () => {
  const { handler, logs } = setup({ queryError: Object.assign(new Error('conteúdo privado'), { code: 'DB_ERROR' }) });
  const res = await invoke(handler);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(logs, [['[AUTH TROCAR SENHA]', 'DB_ERROR']]);
  assert.doesNotMatch(JSON.stringify(logs), /conteúdo privado/);
});
