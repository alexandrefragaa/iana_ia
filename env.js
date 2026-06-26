import dotenv from "dotenv";
dotenv.config();

export const env = {
  db: process.env.DATABASE_URL,
  geminiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL,
  sessionSecret: process.env.SESSION_SECRET,
  systemPrompt: process.env.SYSTEM_PROMPT,
};