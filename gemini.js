import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "./env.js";

const genAI = new GoogleGenerativeAI(env.geminiKey);

export async function askGemini(message) {
  const model = genAI.getGenerativeModel({
    model: env.model,
  });

  const result = await model.generateContent([
    env.systemPrompt,
    message,
  ]);

  return result.response.text();
}