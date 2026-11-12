import assert from 'node:assert/strict';
import test from 'node:test';

import { parseChatStreamInput } from '../core/chat-stream-input.js';

test('lê mensagem, conversa e preferências do corpo POST', () => {
  const config = { personalidade: ['bem-humorada'], instrucoes: 'Seja direta.' };
  const parsed = parseChatStreamInput({
    method: 'POST',
    body: { mensagem: '  Oi, Iana  ', conversa_id: ' conversa-1 ', config }
  });

  assert.deepEqual(parsed, {
    mensagem: 'Oi, Iana',
    conversaId: 'conversa-1',
    configUsuario: config
  });
});

test('não usa query string como fallback para mensagens POST', () => {
  const parsed = parseChatStreamInput({
    method: 'POST',
    body: {},
    query: { mensagem: 'texto que não deve ser usado' }
  });

  assert.equal(parsed.mensagem, '');
});

test('mantém leitura de query string para clientes GET legados', () => {
  const config = { personalidade: ['objetiva'] };
  const parsed = parseChatStreamInput({
    method: 'GET',
    query: {
      mensagem: '  mensagem antiga  ',
      conversa_id: ' legado-1 ',
      config: JSON.stringify(config)
    }
  });

  assert.deepEqual(parsed, {
    mensagem: 'mensagem antiga',
    conversaId: 'legado-1',
    configUsuario: config
  });
});

test('ignora configurações malformadas, arrays e valores primitivos', () => {
  for (const config of ['{malformado', '["não é objeto"]', 'null', '42']) {
    assert.deepEqual(
      parseChatStreamInput({ method: 'GET', query: { mensagem: 'Oi', config } }).configUsuario,
      {}
    );
  }
});

test('normaliza campos que não são strings sem lançar exceção', () => {
  const parsed = parseChatStreamInput({
    method: 'POST',
    body: { mensagem: ['Oi'], conversa_id: 123, config: [] }
  });

  assert.deepEqual(parsed, {
    mensagem: '',
    conversaId: '',
    configUsuario: {}
  });
});
