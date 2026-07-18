import dotenv from "dotenv";
dotenv.config();

export const env = {
  // Banco de dados (Aiven MySQL) — campos separados, é o que o server.js realmente usa
  db: {
    url:      process.env.DATABASE_URL,      // ⚠️ não usado pelo server.js atual; mantido por compatibilidade
    host:     process.env.DB_HOST,
    port:     process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
    user:     process.env.DB_USER,
    password: process.env.DB_PASS,
    name:     process.env.DB_NAME,
    ssl:      process.env.DB_SSL === 'true',
  },

  // Gemini / IA
  geminiKey:    process.env.GEMINI_API_KEY,
  model:        process.env.GEMINI_MODEL,
  systemPrompt: process.env.SYSTEM_PROMPT,

  // Sessão / segurança
  sessionSecret:   process.env.SESSION_SECRET,
  sessionSecure:   process.env.SESSION_SECURE === 'true',
  allowedOrigins:  (process.env.ALLOWED_ORIGINS || 'http://localhost:3333').split(',').map(o => o.trim()),

  // E-mail (nodemailer / recuperação de senha)
  emailUser: process.env.EMAIL_USER,
  emailPass: process.env.EMAIL_PASS,

  // Integração Python (iana.py) — fallback quando o Gemini falha
  enablePython:   process.env.ENABLE_PYTHON === 'true',
  pythonPath:     process.env.IANA_PYTHON_PATH,

  // Steam (usado pelo script de mineração de conquistas, lado Python — listado
  // aqui só pra referência central, o script Python lê seu próprio .env)
  steamApiKey: process.env.STEAM_API_KEY,

  // Google OAuth — presentes no .env mas NENHUM código do projeto usa isso ainda
  // (não há passport-google-oauth20 instalado nem strategy registrada no server.js).
  // Deixe undefined/vazio até implementar, ou remova do .env se não for usar.
  googleClientId:     process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,

  // Servidor
  port:     process.env.PORT ? Number(process.env.PORT) : 3333,
  nodeEnv:  process.env.NODE_ENV || 'development',
  isProd:   process.env.NODE_ENV === 'production',
};