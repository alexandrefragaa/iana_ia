//auth.js

export const auth = (req, res, next) => {
    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({ error: "Sem token" });
    }

    // simplificado
    next();
};