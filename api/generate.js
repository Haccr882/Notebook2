// backend/api/generate.js
//
// MULTI-AGENT ARCHITECTURE:
//   1. PLAN — one small, fast call decides the document's structure: how
//      many sections it needs (based on requested length/marks/pages, capped
//      at 30 "pages" worth) and what each section covers. No content yet.
//   2. SECTIONS — the frontend then calls this endpoint ONCE PER SECTION,
//      IN PARALLEL (Promise.all — see index.html), each one a small, fast,
//      independent call that writes just that one section in full. Because
//      they run concurrently instead of one after another, generating many
//      sections no longer means many times the wait — it's roughly as slow
//      as the single slowest section, not the sum of all of them.
//   3. ASSEMBLE — the frontend numbers and assembles the sections itself
//      (never trusting the AI to number correctly), and retries any single
//      section that comes back broken — using a DIFFERENT model as a
//      fallback if the primary one keeps failing that section.
//
// This replaces the old single-thread "keep asking the same model to
// continue" approach, which was slow (sequential) and produced short,
// truncated documents when the model stopped early.
//
// RATE LIMITING: the 3/day limit counts once per user-initiated document
// (the "plan" call), not once per section — see isContinuation below.

const DAILY_LIMIT = 5;
const CHAT_DAILY_LIMIT = 20; // doubt-solving chat — lighter, separate budget from documents
const TOKENS_PER_CALL = 4000; // just under the fallback model's 4096 hard cap
const CALL_TIMEOUT_MS = 45000;

const PRIMARY_MODEL = 'openrouter/free';
const FALLBACK_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const NVIDIA_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function checkAndIncrementLimit(ip, limit) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return { allowed: true, configured: false };

  const dateKey = new Date().toISOString().slice(0, 10);
  const key = `nb:${ip}:${dateKey}`;

  const incrRes = await fetch(`${url}/incr/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const incrData = await incrRes.json();
  const count = incrData.result;

  if (count === 1) {
    await fetch(`${url}/expire/${key}/86400`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  return { allowed: count <= limit, configured: true };
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

const SHARED_RULES = `Math notation: NEVER use LaTeX commands like \\frac, \\sin, $...$, \\theta. Instead write math in plain readable text using Unicode symbols: θ, π, √, °, ², ³, ×, ÷, ±, ≤, ≥, ∠, △.

Use **double asterisks** to bold: question labels (e.g. **Q1.**), part labels (e.g. **(a)**, **(b)**), and short key terms/final answers. Don't bold whole sentences.

"content" must ALWAYS be a single plain text string — flowing prose. NEVER put nested JSON or extra key-value sub-fields inside "content".

QUALITY: Write like a genuinely excellent teacher, not a generic AI summary. Use specific, concrete numbers, named examples, and real formulas — never vague filler like "various factors" or "several examples exist" where an actual example belongs. For a worked numerical, show every calculation step with real numbers, not just the method described in words.

COMPLETENESS: If you were given a questionCount, you MUST write exactly that many fully numbered questions (or answers) — never fewer. Do not stop early, skip a question number, or summarize "and so on" — every single question/answer in your assigned range must be fully written out.`;

const CHAT_PROMPT = `You are Notebook's doubt-solving tutor — a patient, encouraging teacher a student can quickly ask a question to, separate from the full notes/paper generator.

Answer directly and clearly in plain conversational text (NOT JSON, no special format needed). Explain the reasoning, not just the final answer — a student asking a doubt wants to understand it, not just copy an answer. Use plain-text math (θ, π, √, ², etc., never LaTeX). Keep answers focused — a few clear paragraphs, not an entire chapter. If it would genuinely help, offer a short worked example. If the student's question is actually a request for a full notes sheet or specimen paper, gently suggest they use "Generate notes/paper" instead, but still give a short helpful answer here too.`;

const PLAN_PROMPT = `You are Notebook's planning agent. A student has made a request for study notes or a specimen/exam paper. Your ONLY job right now is to decide the document's structure — NOT write any content yet.

Return ONLY valid JSON, no commentary, matching exactly:
{
  "type": "notes" or "specimen",
  "title": "a clear title for the whole document",
  "markScheme": "for a specimen paper: one precise paragraph stating the EXACT structure — e.g. 'Section A: 5 MCQs, 1 mark each = 5 marks. Section B: 4 VSA, 2 marks each = 8 marks. Section C: 3 SA, 3 marks each = 9 marks. Section D: 2 LA, 4 marks each = 8 marks. Total = 30 marks, matching the requested total.' For notes, leave this as an empty string.",
  "sections": [
    { "heading": "Section heading", "questionCount": 0 }
  ]
}

"questionCount" = how many numbered questions THIS section contains (0 for non-question sections like an overview or notes topic).

Rules for deciding sections:
- If this is STUDY NOTES: pick from Overview, Key Concepts, Important Definitions, Formulas/Laws, Worked Examples, Common Mistakes, Exam Tips, Quick Revision Summary — use as many as genuinely fit the topic's breadth. questionCount is 0 for all of these. markScheme is "".
- If this is a SPECIMEN/EXAM PAPER: base the structure on how THIS SPECIFIC board, class, and subject's REAL exams are genuinely structured — not a generic template. Work out the EXACT mark arithmetic for your chosen structure and write it precisely into "markScheme" — this exact text is shown to every section-writer so they all agree with each other and the Overview. Verified real current patterns to match (adapt the marks proportionally if the student asks for a different total, but keep the same section SHAPE):
  - CBSE Class 10 Maths/Science-style papers (80 marks, 3 hours): FIVE sections A-E. Section A = MCQs incl. Assertion-Reason, 1 mark each (largest question count). Section B = Very Short Answer, 2 marks each. Section C = Short Answer, 3 marks each. Section D = Long Answer, 5 marks each. Section E = 3-4 Case-Study questions, 4-5 marks each with sub-parts (e.g. 1+1+2 marks). Internal choice in 2 questions each of B/C/D and in the case-study sub-parts of E. No internal choice in A. This is the current real structure — do NOT use an old-style 4-section "A-D, no case study" layout for CBSE Maths/core subjects.
  - CBSE Class 10 Science is additionally sectioned by SUBJECT: Section A = Biology, B = Chemistry, C = Physics, each internally containing a mix of question types.
  - CBSE Class 10 Social Science: Section A = History, B = Geography, C = Political Science, D = Economics.
  - ICSE Class 10 (e.g. Physics/Chemistry/Biology, 80 theory marks, 2 hours): only TWO sections. Section A = 40 marks, compulsory, short-form questions covering the entire syllabus (definitions, short numericals, conceptual reasoning — no choice). Section B = 40 marks, the student answers 4 out of 6 longer application/numerical questions with diagrams. Do NOT invent a CBSE-style A-E structure for ICSE — this 2-section shape is correct and different on purpose.
  - If the student doesn't specify a board, default to the CBSE-style structure above (most common), but state the assumption briefly in the Overview section.
  - If you're unsure of the exact modern convention for a board/subject not covered above, reason from what's realistic and common for that level rather than defaulting to one fixed template — and keep the section count/shape simple and plausible rather than guessing an elaborate structure you're not confident in.
  - Start with "Paper Overview & Instructions" (questionCount: 0) — restating the markScheme you decided.
  - CRITICAL: do NOT create one single "Answer Key" section for the whole paper — a full answer key in one chunk is too large to generate reliably. Instead create ONE SEPARATE answer-key section immediately after each question section, named like "Answer Key — Section A", "Answer Key — Section B", etc. Each answer-key section's questionCount should match the question section it answers.
- If the student specifies a page count or total marks, size sections/questionCounts so the total genuinely adds up to that target — this must be arithmetically exact, not approximate. Never exceed 30 sections total.
- DEFAULT LENGTH (when the student doesn't ask for a specific length or page count): NO fixed page limit — size the document purely to how much the topic genuinely needs, and default toward being CONCISE and focused rather than padded. A single formula or narrow concept might only need 1-3 sections; a broad chapter might need 8-10. Never add filler sections just to reach a length — every section must earn its place by covering something a student would actually need. If the student DOES specify a page/length/marks target, follow that instead.
- If nothing specific is asked, default to a reasonable 6-10 sections.
- Each heading must be specific enough that another AI could write that ONE section well without seeing the others.`;

function sectionPrompt(type){
  const typeRules = type === 'specimen'
    ? `This is one section of a specimen/exam paper. The paper's exact mark scheme (decided already, shared with every section so they all agree) is given below as "markScheme" — follow it exactly, do not invent different question counts or mark values. If this section is a question section (MCQ/VSA/SA/LA), write the actual questions with marks shown, and internal "OR" choices where realistic — number them starting from the "startingQuestionNumber" given below (e.g. if it's 6, your questions are Q6, Q7, Q8...). If this section is an Answer Key for a specific earlier section, give the full worked solution for exactly the question numbers in that section's range (matching startingQuestionNumber and questionCount), nothing else. If this section is the Paper Overview, restate the markScheme accurately as part of your content.`
    : `This is one section of a student's study notes — write it like the best teacher in school explaining it one-on-one, not a textbook summary. Requirements for genuinely good notes:
- Never give a one-line definition and move on — always follow it with why it matters, what it means in practice, and how it's tested.
- For a "Worked Examples" section, include at least TWO fully solved examples of different difficulty (one straightforward, one that combines concepts) — never just one.
- For "Key Concepts" or "Formulas" sections, add ONE memory aid per tricky concept (a mnemonic, a comparison, or a "students often confuse X with Y because...") — real teachers do this, generic AI summaries don't.
- Connect ideas to what a student can picture or has seen before, not just abstract statements.
- Never use vague hedge phrases like "there are many factors" or "in various situations" — always name the actual factors/situations.
- Cover the topic the way a class topper's own handwritten fair notes would — genuinely thorough for this one section's scope, not a skim. A student reading only this section should not need to open a textbook to understand it.`;

  return `You are Notebook's writing agent, an experienced school teacher. You're writing ONE section of a larger document. Stay focused only on the section you're asked for.

Return ONLY valid JSON, no commentary, matching exactly:
{
  "heading": "the section heading (repeat exactly as given)",
  "explanation": "1-2 plain-language sentences on what this section covers",
  "content": "the FULL content of this section — thorough and complete, written like a teacher explaining on a board, not robotic",
  "diagram": "OPTIONAL raw SVG string — see DIAGRAM rules below. Omit this key entirely if no diagram is needed."
}

DIAGRAM rules: include a "diagram" whenever the section is ABOUT something a real teacher would draw — ray/light diagrams (refraction, reflection, lenses), circuit diagrams, geometry figures (triangles, circles with labelled parts), force/vector diagrams, labelled biological structures, graphs of a relationship. If the content mentions "draw a diagram" or describes a physical setup, you MUST include one — don't just describe it in words and skip the visual. Format requirements (follow EXACTLY, this is validated and stripped if wrong):
- Must start with <svg viewBox="0 0 400 260"> and end with </svg> — no width/height attributes on the svg tag itself.
- Only these child tags: <line> <path> <circle> <rect> <polygon> <text> <g>. No <script>, no event handler attributes (onclick etc), no <image>, no external references.
- Use stroke="#23301F" for lines/shapes, fill="none" unless deliberately filling a shape, <text font-size="12" fill="#23301F"> for labels.
Example of a valid diagram (a simple ray bending at a boundary):
"diagram": "<svg viewBox=\\"0 0 400 260\\"><line x1=\\"0\\" y1=\\"130\\" x2=\\"400\\" y2=\\"130\\" stroke=\\"#23301F\\" stroke-width=\\"1\\"/><line x1=\\"200\\" y1=\\"20\\" x2=\\"200\\" y2=\\"240\\" stroke=\\"#23301F\\" stroke-width=\\"1\\"/><line x1=\\"80\\" y1=\\"40\\" x2=\\"200\\" y2=\\"130\\" stroke=\\"#B8722E\\" stroke-width=\\"2\\"/><line x1=\\"200\\" y1=\\"130\\" x2=\\"260\\" y2=\\"240\\" stroke=\\"#B8722E\\" stroke-width=\\"2\\"/><text x=\\"60\\" y=\\"35\\" font-size=\\"12\\" fill=\\"#23301F\\">Incident ray</text><text x=\\"210\\" y=\\"15\\" font-size=\\"12\\" fill=\\"#23301F\\">Normal</text></svg>"

${typeRules}

${SHARED_RULES}`;
}

async function callOpenRouter(apiKey, chatMessages, origin, model, maxTokens){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': origin || 'https://notebook.app',
        'X-Title': 'Notebook',
      },
      body: JSON.stringify({
        model: model || PRIMARY_MODEL,
        messages: chatMessages,
        max_tokens: maxTokens || TOKENS_PER_CALL,
        temperature: 0.6,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The AI model took too long to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error('Empty response from model.');

  return { text, finishReason: choice.finish_reason };
}

/* Calls NVIDIA's own hosted API directly (build.nvidia.com), completely
   separate from OpenRouter — a different free quota pool entirely. Used
   as a last-resort fallback: if OpenRouter's shared daily limit is hit or
   both OpenRouter models fail, this gives a second independent budget to
   draw from instead of the whole generation failing. */
async function callNvidia(apiKey, chatMessages, maxTokens){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(NVIDIA_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: NVIDIA_MODEL,
        messages: chatMessages,
        max_tokens: maxTokens || TOKENS_PER_CALL,
        temperature: 0.6,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The AI model took too long to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`NVIDIA API error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content;
  if (!text) throw new Error('Empty response from model.');

  return { text, finishReason: choice.finish_reason };
}

/* Calls Google's Gemini API directly (Google AI Studio free tier) — a
   THIRD independent quota pool, separate from both OpenRouter and NVIDIA.
   Gemini's request/response shape differs from the OpenAI-style APIs
   above, so messages are converted to Gemini's "contents" format and the
   system prompt is passed separately as systemInstruction. */
const GEMINI_MODEL = 'gemini-2.5-flash-lite'; // highest free-tier quota (1000 req/day)
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callGemini(apiKey, chatMessages, maxTokens){
  const systemMsg = chatMessages.find(m => m.role === 'system');
  const conversation = chatMessages.filter(m => m.role !== 'system');
  const contents = conversation.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
        generationConfig: {
          maxOutputTokens: maxTokens || TOKENS_PER_CALL,
          temperature: 0.6,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The AI model took too long to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data2 = await response.json();
  const candidate = data2.candidates?.[0];
  const text2 = candidate?.content?.parts?.[0]?.text;
  if (!text2) throw new Error('Empty response from model.');

  const finishReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
  return { text: text2, finishReason };
}

/* Calls Groq's API (groq.com — LPU-based fast inference, NOT the same as
   xAI's paid "Grok"). Groq's free developer tier needs no credit card:
   30 requests/minute, 14,400/day. This is a FOURTH independent quota
   pool, and also the fastest of the four — useful when speed matters
   more than being the highest-quality option (e.g. quick chat answers). */
const GROQ_MODEL = 'openai/gpt-oss-120b'; // llama-3.3-70b-versatile was decommissioned by Groq on Aug 16, 2026
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

async function callGroq(apiKey, chatMessages, maxTokens){
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: chatMessages,
        max_tokens: maxTokens || TOKENS_PER_CALL,
        temperature: 0.6,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('The AI model took too long to respond.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errText.slice(0, 300)}`);
  }

  const data3 = await response.json();
  const choice3 = data3.choices?.[0];
  const text3 = choice3?.message?.content;
  if (!text3) throw new Error('Empty response from model.');

  return { text: text3, finishReason: choice3.finish_reason };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { mode, userRequest, sectionHeading, type, isContinuation, useFallbackModel, provider, startingQuestionNumber, questionCount, markScheme, continueFrom, chatHistory } = req.body || {};
  if (mode !== 'plan' && mode !== 'section' && mode !== 'chat') {
    return res.status(400).json({ error: 'Request must include mode: "plan", "section", or "chat".' });
  }
  if (!userRequest) {
    return res.status(400).json({ error: 'Request must include "userRequest".' });
  }

  // Chat (doubt-solving) uses its OWN, separate daily limit — it's a much
  // lighter single-call feature, not the multi-agent document pipeline, so
  // it shouldn't compete with the documents-per-day budget.
  if (mode === 'chat') {
    const ip = getClientIp(req);
    const limitResult = await checkAndIncrementLimit(`chat:${ip}`, CHAT_DAILY_LIMIT);
    if (!limitResult.allowed) {
      return res.status(429).json({ error: `Daily doubt-chat limit reached (${CHAT_DAILY_LIMIT} per day). Try again after midnight.` });
    }

    const chatMessages = [
      { role: 'system', content: CHAT_PROMPT },
      ...(Array.isArray(chatHistory) ? chatHistory.slice(-10) : []),
      { role: 'user', content: userRequest },
    ];

    // Priority: Groq first (fastest — best for a live chat feel), then
    // Gemini (stable backup, separate quota pool), then OpenRouter as a
    // last resort if both of those aren't configured or fail.
    const groqKey = process.env.GROQ_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    const chatAttempts = [
      groqKey ? () => callGroq(groqKey, chatMessages, 1200) : null,
      geminiKey ? () => callGemini(geminiKey, chatMessages, 1200) : null,
      openrouterKey ? () => callOpenRouter(openrouterKey, chatMessages, req.headers.origin, PRIMARY_MODEL, 1200) : null,
    ].filter(Boolean);

    if (chatAttempts.length === 0) {
      return res.status(500).json({ error: 'Server has no chat provider configured (need GROQ_API_KEY, GEMINI_API_KEY, or OPENROUTER_API_KEY).' });
    }

    let lastErr;
    for (const attempt of chatAttempts) {
      try {
        const { text } = await attempt();
        return res.status(200).json({ content: text });
      } catch (err) {
        lastErr = err;
      }
    }
    return res.status(500).json({ error: lastErr?.message || 'Unexpected server error.' });
  }

  // The daily limit counts once per document (the plan call). All section
  // calls that follow it are part of the SAME user-initiated generation.
  if (!isContinuation) {
    const ip = getClientIp(req);
    const limitResult = await checkAndIncrementLimit(ip, DAILY_LIMIT);
    if (!limitResult.allowed) {
      return res.status(429).json({ error: `Daily limit reached (${DAILY_LIMIT} per day). Try again after midnight.` });
    }
  }

  let chatMessages;
  if (mode === 'plan') {
    chatMessages = [
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: userRequest },
    ];
  } else {
    if (!sectionHeading) {
      return res.status(400).json({ error: 'Section mode requires "sectionHeading".' });
    }
    chatMessages = [
      { role: 'system', content: sectionPrompt(type) },
      { role: 'user', content: `Overall document request: "${userRequest}"${markScheme ? `\nAgreed mark scheme (follow exactly, all sections must match this): ${markScheme}` : ''}\n\nWrite ONLY this section: "${sectionHeading}"${questionCount ? `\nstartingQuestionNumber: ${startingQuestionNumber}\nquestionCount: ${questionCount}` : ''}` },
    ];
    // If this section got cut off last time, ask the model to continue the
    // SAME raw JSON text exactly where it stopped, instead of starting over
    // — this is what fixes truncated content, dropped answer-key entries,
    // and questions that silently went missing near the end of a section.
    if (continueFrom) {
      chatMessages.push({ role: 'assistant', content: continueFrom });
      chatMessages.push({ role: 'user', content: 'Continue exactly where you left off. Output only the next raw chunk of the same JSON — no repetition, no restarting, no commentary. Make sure every question up to questionCount is still fully written.' });
    }
  }

  // Heavy sections (many questions, or an Answer Key with full worked
  // solutions) need more room than a short Overview section — this is
  // what was silently truncating answer keys and dropping later questions
  // before. The fallback OpenRouter model has a hard 4096-token cap, so we
  // only push past 4000 on the primary model and NVIDIA (which allow more).
  const isHeavySection = mode === 'section' && (questionCount > 3 || /answer key/i.test(sectionHeading || ''));
  const dynamicTokens = useFallbackModel ? TOKENS_PER_CALL : (isHeavySection ? 6500 : TOKENS_PER_CALL);

  try {
    if (provider === 'nvidia') {
      const nvidiaKey = process.env.NVIDIA_API_KEY;
      if (!nvidiaKey) {
        return res.status(500).json({ error: 'Server is missing NVIDIA_API_KEY. Add it in Vercel → Settings → Environment Variables, or omit provider:"nvidia" to use OpenRouter only.' });
      }
      const { text, finishReason } = await callNvidia(nvidiaKey, chatMessages, dynamicTokens);
      return res.status(200).json({ content: text, finishReason, modelUsed: NVIDIA_MODEL });
    }

    if (provider === 'gemini') {
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) {
        return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY. Add it in Vercel → Settings → Environment Variables, or omit provider:"gemini" to skip it.' });
      }
      const { text, finishReason } = await callGemini(geminiKey, chatMessages, dynamicTokens);
      return res.status(200).json({ content: text, finishReason, modelUsed: GEMINI_MODEL });
    }

    if (provider === 'groq') {
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) {
        return res.status(500).json({ error: 'Server is missing GROQ_API_KEY. Add it in Vercel → Settings → Environment Variables, or omit provider:"groq" to skip it.' });
      }
      const { text, finishReason } = await callGroq(groqKey, chatMessages, dynamicTokens);
      return res.status(200).json({ content: text, finishReason, modelUsed: GROQ_MODEL });
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY. Add it in Vercel → Settings → Environment Variables.' });
    }
    const model = useFallbackModel ? FALLBACK_MODEL : PRIMARY_MODEL;
    const { text, finishReason } = await callOpenRouter(apiKey, chatMessages, req.headers.origin, model, dynamicTokens);
    return res.status(200).json({ content: text, finishReason, modelUsed: model });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unexpected server error.' });
  }
}
