#!/usr/bin/env node
/**
 * Which small model should analyze a message? This measures the thing that actually
 * decides it: does the model return a contract-valid JSON object through the real system
 * prompt (src/issue-classes.ts) at the real request shape (src/analysis/http.ts).
 *
 * A cheap or new model is not automatically better here: the failures that matter are
 * structural (fields nested in the wrong object, reasoning tokens eating the whole
 * max_tokens budget, JSON truncated at the cap), and a model that writes 4x more output
 * costs more per call even at a lower price per token.
 *
 * Usage (needs `npm run build` first and an OPENROUTER_API_KEY in the environment):
 *   node scripts/bench-models.mjs
 *   node scripts/bench-models.mjs --models openai/gpt-4o-mini,qwen/qwen3.8-flash --reps 3 --max-tokens 1200
 *
 * Cost note: it spends real money on the endpoint the key belongs to (a few cents for a
 * full run). It never touches the user's store: nothing is written, no hook is invoked.
 */
import { ANALYSIS_SYSTEM_PROMPT, validateAnalysisResult } from '../dist/issue-classes.js';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
}

const models = String(flag('models', 'openai/gpt-4o-mini,deepseek/deepseek-v4.1-flash')).split(',').map((s) => s.trim()).filter(Boolean);
const reps = Number(flag('reps', '2'));
const maxTokens = Number(flag('max-tokens', '512'));
const endpoint = flag('endpoint', 'https://openrouter.ai/api/v1');
const key = process.env.OPENROUTER_API_KEY;

if (!key) {
  console.error('OPENROUTER_API_KEY is not set; the benchmark needs the endpoint the hook uses.');
  process.exit(1);
}

/** The product's own fixture set: short Chinese, terse Chinese, and English coaching. */
const INPUTS = [
  '帮我看看这个登录 bug 为什么一直失败',
  '推送并更新记录',
  '这个功能现在还不能用',
  '明天再继续做剩下的部分',
  '帮我把这个函数重命名一下',
  '文档需要补充一下安装步骤',
  'Can you help me look this bug?',
  'She go to the office every day and the build fail.',
  'Please kindly be so good as to check the logs.',
  'How is this project efforting?',
];

async function priceTable() {
  const res = await fetch(`${endpoint}/models`, { headers: { authorization: `Bearer ${key}` } });
  const json = await res.json();
  const out = new Map();
  for (const m of json.data ?? []) {
    const p = m.pricing ?? {};
    out.set(m.id, { in: Number(p.prompt ?? 0) * 1e6, out: Number(p.completion ?? 0) * 1e6 });
  }
  return out;
}

async function once(model, text) {
  const started = Date.now();
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  const ms = Date.now() - started;
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = null;
  }
  if (json?.error) return { ok: false, ms, out: 0, why: `provider: ${String(json.error.message).slice(0, 60)}` };
  const content = json?.choices?.[0]?.message?.content ?? '';
  let parsed = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  const valid = parsed ? validateAnalysisResult(parsed) : null;
  return {
    ok: !!valid,
    ms,
    out: json?.usage?.completion_tokens ?? 0,
    why: valid ? null : `contract-invalid (finish=${json?.choices?.[0]?.finish_reason ?? '?'})`,
  };
}

const prices = await priceTable();
console.log(`max_tokens=${maxTokens} reps=${reps} inputs=${INPUTS.length} (temperature 0, real system prompt)`);
for (const model of models) {
  let ok = 0;
  let n = 0;
  let cost = 0;
  const ms = [];
  const outs = [];
  let firstFailure = '';
  for (let rep = 0; rep < reps; rep += 1) {
    for (const text of INPUTS) {
      const r = await once(model, text);
      n += 1;
      ms.push(r.ms);
      outs.push(r.out);
      if (r.ok) ok += 1;
      else if (!firstFailure) firstFailure = r.why;
      const price = prices.get(model) ?? { in: 0, out: 0 };
      cost += (400 * price.in + r.out * price.out) / 1e6;
      await new Promise((x) => setTimeout(x, 400));
    }
  }
  ms.sort((a, b) => a - b);
  outs.sort((a, b) => a - b);
  const price = prices.get(model) ?? { in: 0, out: 0 };
  const p50 = ms[Math.floor(ms.length / 2)];
  const p50out = outs[Math.floor(outs.length / 2)];
  console.log(
    `${model}\n  valid ${ok}/${n} | p50 ${p50}ms | out tokens p50 ${p50out} | ~$${((cost / n) * 1000).toFixed(4)}/1k calls | $${price.in.toFixed(3)}/$${price.out.toFixed(3)} per M${firstFailure ? ` | ${firstFailure}` : ''}`,
  );
}
