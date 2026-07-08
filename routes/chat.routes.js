
import express from 'express';
import {
    streamChat, getHistoricoChat, listarConversas,
    criarConversa, renomearConversa, alternarFixada, deletarConversa
} from '../controllers/chat.controller.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.post('/stream', streamChat); // visitante ou autenticado

router.get('/historico/:id', requireAuth, getHistoricoChat);
router.get('/conversas', requireAuth, listarConversas);
router.post('/conversas', requireAuth, criarConversa);
router.put('/conversas/:id', requireAuth, renomearConversa);
router.patch('/conversas/:id/fixar', requireAuth, alternarFixada);
router.delete('/conversas/:id', requireAuth, deletarConversa);

export default router;