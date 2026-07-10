// auth.js
// Requer: npm install jsonwebtoken cookie-parser
// E que o app use: app.use(require('cookie-parser')())
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
    console.warn('⚠️ JWT_SECRET não definido nas variáveis de ambiente!');
}

export const auth = (req, res, next) => {
    let token = null;

    // Caso 1: sessão via cookie (é o que o resto do app usa, já que o
    // front-end faz fetch(..., { credentials: 'include' }) sem header Authorization)
    if (req.cookies?.token) {
        token = req.cookies.token;
    }
    // Caso 2: Authorization: Bearer <token> (útil para API externa / mobile)
    else if (req.headers.authorization) {
        const [scheme, headerToken] = req.headers.authorization.split(' ');
        if (scheme === 'Bearer' && headerToken) {
            token = headerToken;
        }
    }

    if (!token) {
        return res.status(401).json({ error: 'Não autenticado' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.usuario = payload; // fica disponível nas rotas seguintes
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Sessão inválida ou expirada' });
    }
};