import express from 'express';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient(); // 2. Ligamos o motor do Prisma
const router = express.Router();

// Rota de Cadastro de Usuário
router.post('/cadastro', async (req, res) => {
    try {
        const user = req.body;

        // 3. Mandamos o Prisma criar o usuário lá no MySQL!
        const userDB = await prisma.user.create({
            data: {
                email: user.email,
                name: user.name,
                password: user.password
            }
        });

        // 4. Retornamos o usuário que o banco acabou de criar (agora com um ID real)
        res.status(201).json(userDB); 
        
    } catch (err) {
        // 5. A nossa trava de segurança caso o banco recuse a entrada
         console.log(err);
        res.status(500).json({ message: "Erro no servidor, tente novamente!" });
    }
});

export default router;