# What's real vs empty in this zip

Checked every file in `notebook-full-website.zip`. Here's the honest state:

## Actually working (the whole app runs on just these two)
- `index.html` — the chat website. Just replaced with the latest version
  (had the professional bold-heading styling, bold-text rendering, and the
  sidebar-close fix that the old copy in this zip was missing).
- `api/generate.js` — the backend. Fixed two bugs in it:
  1. Added the instruction that stops the AI from putting nested JSON
     inside "content" (that was the `"question": ..., "solution": ...`
     leaking into the chat you saw).
  2. Lowered `max_tokens` to 9000 for more reliable completion.

## The actual bug you hit
- `vercel.json` in this zip was missing the timeout extension — it only
  set the Node runtime, not `maxDuration`. That's exactly why you saw
  "server took too long to respond" / "Failed to fetch". Fixed: added
  `"maxDuration": 60`.

## Empty — not built, don't rely on these yet
Every one of these is either a one-line placeholder or returns a "not
implemented" error. Opening them won't do anything real right now:

- `pages/dashboard.html`, `study.html`, `notes.html`, `practice.html`,
  `test.html`, `revision.html`, `progress.html`, `library.html`,
  `papers.html`, `exam-profile.html`, `settings.html`
- `api/notes.js`, `api/paper.js`, `api/quota.js`, `api/analyze.js`,
  `api/evaluate.js`, `api/revision.js` — all just return
  `501 "reserved for Notebook backend engine"`
- All of `engine/*.js` — one-line comments, no logic inside
- All of `components/*/` — empty folders with just a `.gitkeep`
- `schemas/*.json` (except notes/specimen, which were already real) — not
  yet wired to anything

This isn't a problem — it just means: **deploy only `index.html`,
`api/generate.js`, and `vercel.json` for now.** The rest is a shell for
future features (dashboard, practice tests, progress tracking) that
doesn't need to be built yet. When you're ready to build one of those
features for real, we do it properly instead of leaving another stub.
