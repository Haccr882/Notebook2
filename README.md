# Notebook — AI Study Notes & Specimen Paper Generator

Complete, tested website. This is the final consolidated version combining
every fix made so far.

## What's inside

```
notebook/
├── index.html              ← the website (chat UI, generation, PDF, help/feedback)
├── vercel.json               ← server timeout config (60s, Vercel's max on free plan)
├── api/
│   ├── generate.js             ← multi-agent AI backend (plan → parallel sections)
│   ├── redeem.js                ← premium code redemption (currently unused/hidden)
│   └── feedback.js               ← stores user feedback (readable via admin secret)
├── pages/
│   └── premium.html            ← premium redeem page (not linked from main site yet)
└── docs/
    └── UPSTASH-SETUP.md          ← optional: real per-IP rate limiting setup
```

## How the AI generation works (multi-agent)

1. **Plan agent** — one fast call decides the document's structure: how many
   sections, what each covers, and (for specimen papers) the exact mark
   scheme, based on real CBSE/ICSE board patterns.
2. **Section agents** — every section is written in **parallel**, not one
   after another, so a 15-section paper takes about as long as one section.
3. **Verification** — each section is checked for actually containing every
   question it was assigned (not just "the AI said it's done"). If a
   section is incomplete, it's retried — up to 4 attempts across 2
   independent AI providers (OpenRouter + NVIDIA direct) — and the most
   complete attempt is kept even if none are perfect.
4. **Assembly** — numbering is assigned by the code, never trusted from the
   AI, eliminating numbering bugs entirely.

## AI Providers (4 independent free quota pools)

1. **OpenRouter** (`openrouter/free` auto-router + Llama 3.3 70B fallback)
2. **NVIDIA** (Nemotron 3 Ultra, direct via build.nvidia.com)
3. **Gemini** (Google AI Studio free tier — genuinely free, no card, ~1000 req/day)
4. **Groq** (groq.com — LPU fast inference, genuinely free, 30 RPM / 14,400/day — NOT the same as xAI's paid "Grok")

Document sections retry across all 4 (6 attempts total) before giving up.
The doubt-chat feature tries **Groq first for speed**, falling back to
**Gemini** for stability, then OpenRouter as a last resort.

**Environment variables needed:** `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`,
`GEMINI_API_KEY`, `GROQ_API_KEY` — all have free tiers, all optional
except OpenRouter (the others just widen the safety net; the site still
works with only OpenRouter configured).

## New: Doubt-solving Chat

A second mode alongside the notes/paper generator — toggle with the
"💬 Ask a Doubt" button above the composer. This skips the whole
plan → parallel-sections pipeline (overkill for a quick question) and
just answers directly and conversationally. Separate daily limit (15/day
free, 50/day premium) from document generation.

## New: Colorful, Hierarchical Headings

Headings are now color- and size-coded by what kind of section they are
(Overview = amber, Formulas = maroon, Examples = green, Mistakes = red,
Summary = navy) — a real notebook doesn't use one flat style for every
heading, and now neither does this.

## New: Page-length guardrails

By default (unless the student asks for a specific length), documents are
now planned to land between 4-5 pages minimum and 7-8 pages maximum —
thorough enough to be useful, not so long it stops being a quick
reference.

## Limits

- **Documents:** 5/day free, 10/day premium (premium not yet linked in UI —
  everything is free for now, as requested)
- **Doubt chat:** 20/day free, 50/day premium
- **Page length:** no fixed limit — sized purely to the topic's real
  breadth, biased toward concise/focused over padded. If a student
  specifies a length or page count, that's followed instead.

## Testing note (read before assuming live API calls were verified)

This sandbox has no internet access, so the Groq and Gemini integrations
could NOT be tested against their real live APIs. What WAS verified (104
automated tests, all passing): the request format sent to each API
exactly matches their official documented shape, response parsing handles
their real response structure, error handling for missing/invalid keys,
and the Groq-first/Gemini-backup priority order for chat. The first real
call with your actual API keys is the true first live test — if either
returns an unexpected error, share the exact message and it can be fixed
quickly, since the logic itself is already thoroughly tested.

## Known-fixed issues (from earlier versions)

- ✅ Blank/broken PDFs — now uses the browser's native print-to-PDF, no
  fragile screenshot library.
- ✅ Server timeouts on long papers — each server call does only one small
  piece of work; the browser drives the overall generation.
- ✅ Marks/section mismatches (e.g. Overview says one thing, Section A says
  another) — every section receives the same agreed "markScheme" text.
- ✅ Missing questions in answer keys — real verification counts actual
  question numbers written, not just whether the AI claimed to finish.
- ✅ Diagrams disappearing — a common AI mistake (unescaped `&`) that broke
  SVG parsing is now auto-repaired before rendering.
- ✅ Rate limit exhausted by one big document — the daily-limit counter
  only increments once per document, not once per section.

## Deploy steps

1. **GitHub**: create a repo, upload this entire `notebook/` folder's
   contents to the repo ROOT (not inside a subfolder — this caused a 404
   once before; `index.html` must be directly at the root).
2. **Vercel**: New Project → connect the repo → Deploy.
3. **Environment variables** (Vercel → Settings → Environment Variables):
   - `OPENROUTER_API_KEY` — from openrouter.ai/keys (never share this key
     anywhere public, including chat)
   - `NVIDIA_API_KEY` — from build.nvidia.com (optional but recommended —
     gives a second independent fallback quota pool)
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — optional, for
     real per-IP daily limits (see docs/UPSTASH-SETUP.md); without these,
     the limit still works but is easier to bypass
   - `ADMIN_SECRET` — only needed if you use redeem.js/feedback.js's admin
     actions; pick any long random string, never share it
4. Redeploy after adding environment variables (they only apply to new
   deployments).

## Turning on ads later

`index.html` already has an ad slot ready (`#adSlot`, currently hidden).
Once you have an AdSense account (needs a guardian, same as any payment
account for under-18s), paste your ad unit code inside that div and change
its CSS `display: none` to `display: block` — nothing else needs to
change.

## Turning on Premium later

The redeem-code system (`api/redeem.js`, `pages/premium.html`) is fully
built and tested but not linked from the main site — everything is free
for now, as requested. To turn it on:
1. Add `ADMIN_SECRET` to Vercel if not already there.
2. Generate a code by POSTing `{"action":"generate","adminSecret":"..."}`
   to `/api/redeem`.
3. Send the code to whoever paid; they redeem it at `/pages/premium.html`.
4. Link to `/pages/premium.html` from the main site's sidebar when ready.

## Testing

73 automated tests exist across the codebase (not included in this zip to
keep it focused on the deployable site) — they cover the plan/section
generation logic, rate limiting, redeem codes, feedback storage, SVG
sanitization, and the completeness-verification fix. Ask if you'd like
the test files added back in for future changes.
