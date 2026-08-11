import { config } from "dotenv";
config({ path: ".env.local" });
const key = process.env.GEMINI_API_KEY;
const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`);
const data = await res.json();
const models = (data.models ?? []).filter(m => (m.supportedGenerationMethods ?? []).includes("generateContent"));
console.log(`${models.length} models support generateContent. Candidates for the corrector:\n`);
models.map(m => m.name.replace("models/", ""))
  .filter(n => /^gemini-(3|2\.5)/.test(n) && !/tts|image|embedding|live|native-audio|dialog/.test(n))
  .forEach(n => console.log("  " + n));
