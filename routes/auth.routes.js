import express from 'express';
import passport from 'passport';
import { register, login, logout, forgotPassword, resetPassword, getUser } from '../controllers/auth.controller.js';

const router = express.Router();

router.post('/registro', register); // alias

router.post('/login', (req, res, next) => {
    passport.authenticate('local', (err, usuario, info) => {
        if (err)      return res.status(500).json({ erro: 'Erro interno no servidor.' });
        if (!usuario) return res.status(401).json({ erro: info?.message || 'Falha no login.' });
        req.login(usuario, (err) => {
            if (err) return res.status(500).json({ erro: 'Erro ao criar sessão.' });
            return login(req, res);
        });
    })(req, res, next);
});

router.post('/logout', logout);
router.post('/forgot-password', forgotPassword);
router.post('/esqueci-senha', forgotPassword); // alias
router.post('/reset-password', resetPassword);
router.post('/mudar-senha', resetPassword); // alias

router.get('/user', getUser);
router.get('/me', (req, res) => {
    if (!req.isAuthenticated()) return res.json({ logado: false });
    res.json({ logado: true, usuario: { id: req.user.id, nome: req.user.nome, email: req.user.email } });
});

export default router;