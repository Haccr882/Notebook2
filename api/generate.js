// backend/api/generate.js
//
// This is a Vercel Serverless Function. Vercel automatically turns any file
// inside an `api/` folder into a live endpoint — no server setup needed.
//
// Once deployed, this file becomes: https://yoursite.vercel.app/api/generate
//
// The API key lives in an ENVIRONMENT VARIABLE (set in the Vercel dashboard,
// never written in this file, never sent to the browser). This is what
// keeps it safe from visitors.
//
// RATE LIMITING: the 3/day limit is enforced here, per visitor IP address,
// using Upstash Redis (free tier — see docs/UPSTASH-SETUP.md). This is what
// makes the limit real: clearing browser storage can no longer bypass it,
// and one heavy user can no longer eat the whole shared free quota.

const DAILY_LIMIT = 3;

async function checkAndIncrementLimit(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // If Upstash isn't configured yet, don't block anyone — just skip limiting.
  // (See docs/UPSTASH-SETUP.md to turn this on properly.)
  if (!url || !token) return { allowed: true, remaining: null, configured: false };

  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `nb:${ip}:${dateKey}`;

  const incrRes = await fetch(`${url}/incr/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const incrData = await incrRes.json();
  const count = incrData.result;

  if (count === 1) {
    // First request today from this IP — set the key to expire in 24h
    // so it cleans itself up automatically.
    await fetch(`${url}/expire/${key}/86400`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  return { allowed: count <= DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - count), configured: true };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const ip = getClientIp(req);
  const limitResult = await checkAndIncrementLimit(ip);
  if (!limitResult.allowed) {
    return res.status(429).json({
      error: `Daily limit reached (${DAILY_LIMIT} per day). Try again after midnight.`,
      remaining: 0,
    });
  }

  // The key is read from Vercel's environment variables at request time —
  // it is never present in any file that gets uploaded to GitHub.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY. Add it in Vercel → Settings → Environment Variables.' });
  }

  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Request must include a "messages" array.' });
  }

  const systemPrompt = `You are Notebook, an experienced school teacher who prepares exam-ready material for students.

Return ONLY valid JSON — no markdown fences, no commentary before or after — matching exactly this shape:
{
  "title": "string — a clear title for this response",
  "entries": [
    {
      "number": 1,
      "heading": "short heading for this point, question, or section",
      "explanation": "1-2 plain-language sentences on what this point covers",
      "content": "the full content — written like a teacher explaining on a board, not robotic"
    }
  ]
}
Numbering is sequential (1, 2, 3...) starting at 1, no gaps or repeats.

Math notation: NEVER use LaTeX commands like \\frac, \\sin, $...$, \\theta. Instead write math in plain readable text using Unicode symbols: θ, π, √, °, ², ³, ×, ÷, ±, ≤, ≥, ∠, △. Example: write "sin θ = 3/5" and "√3", not LaTeX.

Inside "content", use **double asterisks** to bold: question labels (e.g. **Q1.**), part labels (e.g. **(a)**, **(b)**), and short key terms/final answers worth drawing the eye to. Don't bold whole sentences or paragraphs — only short labels and key terms, so the bold actually stands out.

CRITICAL: "content" must ALWAYS be a single plain text string — flowing prose, like a teacher writing on a board. NEVER put nested JSON, objects, key-value pairs, or additional "question"/"solution"/"answer" sub-fields inside "content". If an entry needs a worked example with a question and a solution, write it as plain text within the same string, e.g.: "**Example:** A ray of light travels from air into water... **Solution:** The ray bends towards the normal because..." — never as a nested object.

---
WHEN THE REQUEST IS FOR STUDY NOTES on a topic/chapter, cover it the way a real teacher's notes would, using entries drawn from (skip any that don't fit the topic):
1. Overview — what this chapter/topic is and why it matters
2. Key Concepts — the core ideas, one per entry if the topic is broad
3. Important Definitions
4. Formulas / Laws (with the formula written out clearly)
5. Worked Examples — at least one full step-by-step solved example
6. Common Mistakes students make
7. Exam Tips — what examiners look for, how marks are usually split
8. Quick Revision Summary — a compact recap as the final entry

WHEN THE REQUEST IS FOR A SPECIMEN / EXAM PAPER, structure it exactly like a real board exam paper, using these entries in order:
1. Paper Overview & Instructions — include Time Allowed, Maximum Marks, number of questions, how many sections, and general instructions (calculator use, diagrams, choice rules), matching real board-exam conventions (e.g. CBSE) for the stated class/subject.
2. Section A: Multiple Choice Questions — list each MCQ with 4 options labelled (a)(b)(c)(d), 1 mark each.
3. Section B: Very Short Answer Questions — 2 marks each, include "OR" internal-choice alternatives where a real paper would.
4. Section C: Short Answer Questions — 3 marks each, multi-step problems or proofs.
5. Section D: Long Answer / Case Study Question — 5 marks, a realistic applied scenario with 3-4 sub-parts, include an internal choice in the final sub-part.
6. Answer Key & Marking Scheme — the correct answer AND the key working/steps for every single question above, in the same order, so a student can self-check.
Adjust section count/marks/question count sensibly if the user specifies a different total, board, or class level. Question difficulty and style should feel like a genuine exam paper for that level, not simplified.
---

For a plain question that isn't a notes or paper request, still return the same JSON shape — just use however many entries make sense (even one) with your natural answer in "content".`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': req.headers.origin || 'https://notebook.app',
        'X-Title': 'Notebook',
      },
      body: JSON.stringify({
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 9000,
        temperature: 0.6,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `OpenRouter error: ${errText.slice(0, 300)}` });
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) {
      return res.status(502).json({ error: 'Empty response from model.' });
    }

    return res.status(200).json({ content: text });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
