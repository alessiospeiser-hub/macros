// Local runner for the Worker, no install needed:  node worker/dev.mjs
// Reads secrets from worker/.dev.vars and serves http://localhost:8787/estimate
// MOCK_GEMINI=1 node worker/dev.mjs  -> fake estimates, no API key or network needed.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "./src/index.js";

const dir = fileURLToPath(new URL(".", import.meta.url));
const env = {};
const toml = readFileSync(dir + "wrangler.toml", "utf8");
for (const m of toml.matchAll(/^(GEMINI_MODEL|ALLOWED_ORIGINS)\s*=\s*"([^"]*)"/gm)) env[m[1]] = m[2];
if (existsSync(dir + ".dev.vars")) {
  for (const line of readFileSync(dir + ".dev.vars", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const mock = process.env.MOCK_GEMINI === "1";
const mockFetch = async (url, init) => {
  const text = JSON.parse(init.body).contents[0].parts[0].text.replace("What I ate: ", "");
  await new Promise((r) => setTimeout(r, 600));
  if (/ratelimit/i.test(text)) return new Response('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', { status: 429 });
  const reply = { items: [{ name: text, amount: "1 portion", kcal: 420, protein: 24, carbs: 38, fat: 18 }], total: { kcal: 420, protein: 24, carbs: 38, fat: 18 } };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(reply) + "\n```" }] } }] }));
};
if (mock) env.GEMINI_API_KEY = env.GEMINI_API_KEY || "mock";

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request("http://localhost:8787" + req.url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD", "OPTIONS"].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const out = await worker.fetch(request, env, null, mock ? mockFetch : fetch);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
  console.log(req.method, req.url, out.status);
}).listen(8787, "127.0.0.1", () => {
  console.log(`Macros AI proxy on http://localhost:8787  model=${env.GEMINI_MODEL}  ${mock ? "(MOCK Gemini)" : env.GEMINI_API_KEY ? "(key loaded)" : "(NO KEY: create worker/.dev.vars)"}`);
});
