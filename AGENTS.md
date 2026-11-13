# AGENTS.md

Drop-in operating instructions for coding agents. Read this file before every task.

**Working code only. Finish the job. Plausibility is not correctness.**

This file follows the [AGENTS.md](https://agents.md) open standard (Linux Foundation / Agentic AI Foundation). Claude Code, Codex, Cursor, Windsurf, Copilot, Aider, Devin, Amp, Google Antigravity, OpenCode, Cline read it natively. For tools that look elsewhere, symlink:

```bash
ln -s AGENTS.md CLAUDE.md
ln -s AGENTS.md GEMINI.md
```

---

## 0. Non-negotiables

These rules override everything else in this file when in conflict:

1. **No flattery, no filler.** Skip openers like "Great question", "You're absolutely right", "Excellent idea", "I'd be happy to". Start with the answer or the action.
2. **Disagree when you disagree.** If the user's premise is wrong, say so before doing the work. Agreeing with false premises to be polite is the single worst failure mode in coding agents.
3. **Never fabricate.** Not file paths, not commit hashes, not API names, not test results, not library functions. If you don't know, read the file, run the command, or say "I don't know, let me check."
4. **Stop when confused.** If the task has two plausible interpretations, ask. Do not pick silently and proceed.
5. **Touch only what you must.** No drive-by refactors, reformatting, or "while I was in there" cleanups.

---

## 1. Before writing code

**Goal: understand the problem and the codebase before producing a diff.**

- State your plan in one or two sentences before editing. For anything non-trivial, produce a numbered list of steps with a verification check for each.
- Read the files you will touch. Read the files that call the files you will touch. Gemini: use subagents for exploration so the main context stays clean.
- Match existing patterns in the codebase. If the project uses pattern X, use pattern X, even if you'd do it differently in a greenfield repo.
- Surface assumptions out loud: "I'm assuming you want X, Y, Z. If that's wrong, say so." Do not bury assumptions inside the implementation.
- If two approaches exist, present both with tradeoffs. Do not pick one silently. Exception: trivial tasks (typo, rename, log line) where the diff fits in one sentence.

---

## 2. Writing code: simplicity first

**Goal: the minimum code that solves the stated problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code. No configurability, flexibility, or hooks that were not requested.
- No error handling for impossible scenarios. Handle the failures that can actually happen.
- If the solution runs 200 lines and could be 50, rewrite it before showing it.
- If you find yourself adding "for future extensibility", stop. Future extensibility is a future decision.
- Bias toward deleting code over adding code. Shipping less is almost always better.

The test: would a senior engineer reading the diff call this overcomplicated? If yes, simplify.

---

## 3. Surgical changes

**Goal: clean, reviewable diffs. Change only what the request requires.**

- Do not "improve" adjacent code, comments, formatting, or imports that are not part of the task.
- Do not refactor code that works just because you are in the file.
- Do not delete pre-existing dead code unless asked. If you notice it, mention it in the summary.
- Do clean up orphans created by your own changes (unused imports, variables, functions your edit made obsolete).
- Match the project's existing style exactly: indentation, quotes, naming, file layout.

The test: every changed line traces directly to the user's request. If a line fails that test, revert it.

---

## 4. Goal-driven execution

**Goal: define success as something you can verify, then loop until verified.**

Rewrite vague asks into verifiable goals before starting:

- "Add validation" becomes "Write tests for invalid inputs (empty, malformed, oversized), then make them pass."
- "Fix the bug" becomes "Write a failing test that reproduces the reported symptom, then make them pass."
- "Refactor X" becomes "Ensure the existing test suite passes before and after, and no public API changes."
- "Make it faster" becomes "Benchmark the current hot path, identify the bottleneck with profiling, change it, show the benchmark is faster."

For every task:

1. State the success criteria before writing code.
2. Write the verification (test, script, benchmark, screenshot diff) where practical.
3. Run the verification. Read the output. Do not claim success without checking.
4. If the verification fails, fix the cause, not the test.

---

## 5. Tool use and verification

- Prefer running the code to guessing about the code. If a test suite exists, run it. If a linter exists, run it. If a type checker exists, run it.
- Never report "done" based on a plausible-looking diff alone. Plausibility is not correctness.
- When debugging, address root causes, not symptoms. Suppressing the error is not fixing the error.
- For UI changes, verify visually: screenshot before, screenshot after, describe the diff.
- Use CLI tools (gh, aws, gcloud, kubectl) when they exist. They are more context-efficient than reading docs or hitting APIs unauthenticated.
- When reading logs, errors, or stack traces, read the whole thing. Half-read traces produce wrong fixes.
- Put all build outputs, extra scripts and debug dumps into `<project-root>/artifacts/`.
- Look up today's real date and the freshest project stack versions on the web before starting every task; never use or trust old model data.

---

## 6. Session hygiene

- Context is the constraint. Long sessions with accumulated failed attempts perform worse than fresh sessions with a better prompt.
- After two failed corrections on the same issue, stop. Summarize what you learned and ask the user to reset the session with a sharper prompt.
- Use subagents (Gemini: "use subagents to investigate X") for exploration tasks that would otherwise pollute the main context with dozens of file reads.
- When committing or updating changelog, write descriptive commit messages (subject under 72 chars, body explains the why). No "update file" or "fix bug" commits. No "Co-Authored-By: Gemini" attribution unless the project explicitly wants it.
- Write patch notes and public text in simple language: no words longer than 12 letters. If a word is long, break it into small, plain words.

---

## 7. Communication style

- Direct, not diplomatic. "This won't scale because X" beats "That's an interesting approach, but have you considered...".
- Concise by default. Two or three short paragraphs unless the user asks for depth. No padding, no restating the question, no ceremonial closings.
- When a question has a clear answer, give it. When it does not, say so and give your best read on the tradeoffs.
- Celebrate only what matters: shipping, solving genuinely hard problems, metrics that moved. Not feature ideas, not scope creep, not "wouldn't it be cool if".
- No excessive bullet points, no unprompted headers, no emoji. Prose is usually clearer than structure for short answers.

---

## 8. When to ask, when to proceed

**Ask before proceeding when:**
- The request has two plausible interpretations and the choice materially affects the output.
- The change touches something you've been told is load-bearing, versioned, or has a migration path.
- You need a credential, a secret, or a production resource you don't have access to.
- The user's stated goal and the literal request appear to conflict.

**Proceed without asking when:**
- The task is trivial and reversible (typo, rename a local variable, add a log line).
- The ambiguity can be resolved by reading the code or running a command.
- The user has already answered the question once in this session.

---

## 9. Self-improvement loop

**This file is living. Keep it short by keeping it honest.**

After every session where the agent did something wrong:

1. Ask: was the mistake because this file lacks a rule, or because the agent ignored a rule?
2. If lacking: add the rule under "Project Learnings" below, written as concretely as possible ("Always use X for Y" not "be careful with Y").
3. If ignored: the rule may be too long, too vague, or buried. Tighten it or move it up.
4. Every few weeks, prune. For each line, ask: "Would removing this cause the agent to make a mistake?" If no, delete. Bloated AGENTS.md files get ignored wholesale.

---

## 10. Project context

### Stack
- Language and version: Vanilla JavaScript (ES2022+ / Web APIs)
- Framework(s): Pure Vanilla JS (No build step, no npm/bundler frameworks, Chrome Extensions MV3)
- Package manager: None (Direct browser execution)
- Runtime / deployment target: Google Chrome / Chromium-based browsers (Manifest V3, Shreddit and Old Reddit DOM)
- VCS / Remote: Private GitHub repository (`https://github.com/LiarToMyself/IvoryRedditButtons`) via GitHub MCP and local Git CLI
- Branch strategy: `dev` is default branch for active integration; `main` is protected release baseline. Direct pushes to `main` are strictly forbidden. Feature work in `feat/vX.Y.Z` or versioned feature branches (e.g. `v1.4.3-gemini-3.8FH`) with atomic, granular commits per logical diff. Remote operations (branches, PRs, merges) managed via `github-mcp-server`.
- Versioning: SemVer 2.0.0 via standard Git tags (`vX.Y.Z`) and GitHub Releases. Releases are tagged with annotated Git tags (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`).

### Commands
- Install: Open `chrome://extensions/` in Chrome -> Enable Developer mode -> Click "Load unpacked" -> Select repository directory
- Build: None (interpreted directly by browser engine)
- Test (all): `node --check content.js` for syntax validation; manual live test on Reddit feeds and profile pages
- Test (single file): `node --check content.js`
- Lint: ESLint / vanilla JavaScript linter if configured
- Typecheck: None (Vanilla JS / JSDoc)
- Run locally: Reload unpacked extension at `chrome://extensions/` and refresh Reddit tab (`Ctrl+R` / `F5`)

Prefer single-file or single-test runs during iteration. Full suites are for the final verification pass.

### Layout
- Source lives in: `./` (`manifest.json`, `content.js`, `icon.png`)
- Tests live in: `tests/`, `artifacts/tests/`
- Logs live in: `logs/`
- Screenshots live in: `screenshots/`
- Do not modify: `icon.png`, `.env.example`

### Conventions specific to this repo
- Naming: camelCase for variables/functions, UPPER_SNAKE_CASE for constants, PascalCase for classes; standard placeholders `<project-root>`, `<desktop>`; zero host-absolute paths.
- Import style: None (single-file content script `content.js` loaded directly via `manifest.json`)
- Error handling pattern: Graceful degradation, try/catch with `console.warn`/`console.error`, strict adherence to Reddit rate limits (`429`), network backoff.
- Testing pattern and framework: Syntax check via `node --check content.js`; in-browser live UI and network inspection via Chrome DevTools.
- Screenshots: Save user chat UI captures in `screenshots/vX.Y.Z_YYYY-MM-DD_HH-mm.<ext>`

### Forbidden
- Calling merge_pull_request or merging any pull request or branch into dev or main. Merging is strictly reserved for the human developer.
- Direct pushes to main or dev branches.

---

## 11. Project Learnings

**Accumulated corrections. This section is for the agent to maintain, not just the human.**

When the user corrects your approach, append a one-line rule here before ending the session. Write it concretely ("Always use X for Y"), never abstractly ("be careful with Y"). If an existing line already covers the correction, tighten it instead of adding a new one. Remove lines when the underlying issue goes away (model upgrades, refactors, process changes).

- Always respect Reddit API and HTML page rate limits: never spam unauthenticated requests or background fetch without strict backoff and rate-limit headers inspection.
- Reddit user profile pages can be hidden, empty, or restricted by user privacy settings (e.g., hidden post history or NSFW/suspended accounts); handle 404, 403, and empty listings distinctly.
- Never block the browser UI thread or cause HTTP 429 lockouts for the user across open tabs.
