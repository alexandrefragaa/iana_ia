export function createChangePasswordHandler({ pool, bcrypt, isMysqlAvailable, logger = console }) {
  return async function changePassword(req, res) {
    const senhaAtual = typeof req.body?.senhaAtual === 'string' ? req.body.senhaAtual.trim() : '';
    const novaSenha = typeof req.body?.novaSenha === 'string' ? req.body.novaSenha.trim() : '';

    if (!senhaAtual || !novaSenha) {
      return res.status(400).json({ status: 'erro', mensagem: 'Informe a senha atual e a nova senha.' });
    }
    if (novaSenha.length < 8) {
      return res.status(400).json({ status: 'erro', mensagem: 'A nova senha deve ter no mínimo 8 caracteres.' });
    }
    if (novaSenha.length > 128) {
      return res.status(400).json({ status: 'erro', mensagem: 'A nova senha excede o limite permitido.' });
    }
    if (senhaAtual === novaSenha) {
      return res.status(400).json({ status: 'erro', mensagem: 'A nova senha deve ser diferente da senha atual.' });
    }

    if (!isMysqlAvailable()) {
      return res.status(503).json({
        status: 'erro',
        mensagem: 'A troca de senha está temporariamente indisponível. Tente novamente quando o banco de dados estiver conectado.'
      });
    }

    try {
      const [usuarios] = await pool.query(
        'SELECT senha FROM usuarios WHERE id = ? LIMIT 1',
        [req.user.id]
      );
      if (!usuarios.length) {
        return res.status(404).json({ status: 'erro', mensagem: 'Conta não encontrada.' });
      }

      const senhaValida = await bcrypt.compare(senhaAtual, usuarios[0].senha);
      if (!senhaValida) {
        return res.status(401).json({ status: 'erro', mensagem: 'A senha atual está incorreta.' });
      }

      const novoHash = await bcrypt.hash(novaSenha, 12);
      const [resultado] = await pool.query(
        'UPDATE usuarios SET senha = ? WHERE id = ?',
        [novoHash, req.user.id]
      );
      if (!resultado.affectedRows) {
        return res.status(404).json({ status: 'erro', mensagem: 'Conta não encontrada.' });
      }

      return res.json({ status: 'sucesso', mensagem: 'Senha alterada com sucesso.' });
    } catch (err) {
      logger.error('[AUTH TROCAR SENHA]', err.code || err.name || 'erro');
      return res.status(500).json({ status: 'erro', mensagem: 'Não foi possível alterar a senha agora.' });
    }
  };
}
