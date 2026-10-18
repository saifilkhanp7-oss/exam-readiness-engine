# Exam Readiness Engine — Product & Technical Spec

> Working name. Alternatives: **ExamCast**, **Recall Radar**. The name lives in one config value (`APP_NAME`) so it can change any time.

Version 0.2 · 18 Oct 2026

---

## 1. What the app is

A study app for students preparing for exams. It doesn't only help you study — it predicts whether you will **remember each topic on exam day**, and plans your study time around that.

It is different from NotebookLM (works on the material) and Anki (uses one general formula). This app learns **you**: your memory, your free time, and your exam.

### Core promises

1. Add several subjects at once with a "+" button: name, exam date, topics or PDFs.
2. Upload a PDF or whole book → topic list, topic importance and quizzes are made automatically.
3. Short self-quizzes build a **personal forgetting curve for every topic**.
4. Reviews are scheduled **just before you would forget**.
5. The revision plan fits into your **real free time**.
6. **Triage mode** when time is short: most marks per hour first, and a clear skip list.
7. **What-if simulator** and a daily **exam-day forecast** (readiness % and score range).
8. **Confidence ratings** catch topics where you think you're good but score badly.
9. **Confusion pairs** (e.g. mitosis vs meiosis) get special "tell them apart" quizzes.
10. **Study-pattern insights** from timer data, in plain words.
11. **Memory-linked notes**: weak topics get detailed notes, mastered topics become one line; formula sheet sorted by forget-risk; a **last night sheet**.

### Golden rule

**Code calculates, AI explains.** Every number (half-life, readiness, score range, marks per hour) is computed by deterministic code. The AI only turns those numbers into sentences and never invents a figure.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite + TypeScript, Tailwind CSS, shadcn/ui |
| Charts | Recharts |
| Mind map | Custom SVG |
| Math | KaTeX |
| Backend | Node 22 + Express 5 (TypeScript, ESM) |
| Database | SQLite via better-sqlite3 (one file on a Railway volume) |
| Auth | Email OTP + JWT, ported from Chronos (section 3) |
| Email | Gmail Apps Script → Gmail SMTP → dev log (same 3 modes as Chronos) |
| PDF | pdfjs-dist for text; Tesseract.js + @napi-rs/canvas OCR for scanned pages |
| AI | Claude API (with a dev fallback when no key is set) |
| Jobs | `jobs` table in SQLite + in-process worker loop |
| Engine | `packages/engine` — pure TypeScript, shared by server and browser |
| Mobile | PWA via vite-plugin-pwa (installable, offline quizzes that sync later) |
| Hosting | Railway, deployed from GitHub, single Dockerfile |

### Repo layout

```
exam-readiness-engine/
  client/              React app
  server/              Express API, jobs worker, AI calls
  packages/engine/     memory model, forecast, scheduler, triage (pure TS, unit-tested)
  gmail-sender.gs      Google Apps Script email sender (copied from Chronos)
  Dockerfile
  spec.md
  README.md
```

---

## 3. Authentication — email OTP (same as Chronos)

Ported from Chronos `server/auth.js` and `server/mailer.js`, behaviour unchanged except the app name and TypeScript.

### 3.1 Flow

**Sign up:** enter name + email → "Send code" → 6-digit code arrives by email → enter code → account is created and you are logged in.

**Log in:** enter email → "Send code" → enter code → logged in.

**Stay logged in:** the token lasts 365 days and is **renewed every time the app opens** (`GET /api/auth/me`), so an active device never gets logged out.

### 3.2 Endpoints

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/auth/request-otp` | `{ mode: "signup" \| "login", email, name? }` | `{ ok: true, devOtp? }` |
| POST | `/api/auth/verify-otp` | `{ email, code }` | `{ token, user }` |
| GET | `/api/auth/me` | — (Bearer token) | `{ user, token }` (renewed token) |

All other `/api/*` routes use `requireAuth` middleware: reads `Authorization: Bearer <jwt>`, loads the user, and reads the `X-TZ` header for the user's time zone.

### 3.3 Rules

| Rule | Value |
|---|---|
| Email check | `^[^\s@]+@[^\s@]+\.[^\s@]{2,}$`, max 254 chars, trimmed and lowercased |
| Name check (sign up) | 2–40 letters; spaces, dots, apostrophes, hyphens allowed (Unicode letters) |
| Code | 6 digits from `crypto.randomInt(100000, 1000000)` |
| Storage | Only the SHA-256 hash of the code is stored |
| Code lifetime | 5 minutes |
| Resend gap | 30 seconds per email |
| Wrong attempts | Max 5, then the code is deleted and a new one must be requested |
| Per-IP limit | 8 code requests per hour |
| One active code per email | New request replaces the old one (upsert) |
| Sign up with existing email | 409 "This email already has an account. Please log in." |
| Log in with unknown email | 404 "No account found for this email. Please sign up." |
| Email send fails | Code row deleted, 502 "Could not send the email right now…" |
| JWT | `{ uid }`, signed with `JWT_SECRET`, expires in 365 days |

### 3.4 Email sending — three modes, picked automatically

1. **Apps Script** (`GMAIL_SCRIPT_URL` + `GMAIL_SCRIPT_SECRET`): POSTs to a Google Apps Script web app in your Gmail. Works on Railway Free/Hobby, which block SMTP ports.
2. **Gmail SMTP** (`GMAIL_USER` + `GMAIL_APP_PASSWORD`): nodemailer with an App Password. Works locally and on Railway Pro.
3. **Dev mode** (neither set): code is printed in the server log, and returned as `devOtp` (shown on screen) when not in production or when `OTP_DEMO_MODE=true`.

Email template: subject `"<code> is your <APP_NAME> code"`, plain-text and HTML versions, big spaced-out code, "expires in 5 minutes" note. Colours updated to the new app's brand.

### 3.5 Tables

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE otps (
  dest TEXT PRIMARY KEY,          -- email
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,          -- 'signup' | 'login'
  username TEXT,                  -- name, only for signup
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL
);
```

### 3.6 Client screens

- **Welcome:** Log in / Sign up tabs.
- **Email step:** name (sign-up only) + email, "Send code".
- **Code step:** 6 boxes, auto-advance, paste support, "Resend" with 30 s countdown, "Change email" link. In dev mode the code is pre-shown in a small banner.
- Token kept in `localStorage`; `/me` called on app start; 401 anywhere → back to Welcome.

### 3.7 Accounts

Accounts are separate from Chronos (own `users` table and database). Free time comes from the app's own daily study-time setting; there is no Chronos import.

---

## 4. Data model (beyond auth)

```sql
subjects       (id, user_id, name, color, exam_at, total_marks, exam_format, created_at)
sources        (id, user_id, subject_id, kind['pdf'|'book'|'past_paper'|'manual'], title, file_path, pages, status, created_at)
chunks         (id, source_id, chapter, page_from, page_to, text)
topics         (id, subject_id, parent_id, title, order_idx, difficulty REAL, weight REAL,
                weight_source['blueprint'|'past_papers'|'ai_estimate'|'manual'], est_learn_min, created_at)
items          (id, topic_id, kind['concept'|'formula'], text, latex)        -- formulas get their own curves
questions      (id, topic_id, item_id, type['mcq'|'short'|'contrast'], prompt, options_json,
                answer, explanation, source_chunk_id, page_ref)
distractors    (question_id, option_idx, belongs_to_topic_id)               -- for confusion detection
attempts       (id, user_id, question_id, topic_id, confidence 1-5, correct 0/1, score REAL,
                response_ms, answered_at, quiz_session_id)
memory_state   (user_id, topic_id | item_id, half_life_days, mastery, last_review_at, n_reviews,
                hl_uncertainty, updated_at)
study_sessions (id, user_id, subject_id, topic_id, start_ts, end_ts, kind['learn'|'review'|'quiz'], breaks)
free_slots     (id, user_id, start_ts, end_ts, recurring_rule, source['manual'|'chronos'])
plan_tasks     (id, user_id, topic_id, kind['learn'|'review'|'contrast'], due_from, due_to,
                scheduled_start, scheduled_end, status, value_score)
confusions     (user_id, topic_a, topic_b, count, exposures, last_at)
notes          (id, topic_id, level['line'|'compact'|'detailed'], markdown, updated_at)
forecasts      (user_id, subject_id, date, readiness, score_p10, score_p50, score_p90, inputs_hash)
user_params    (user_id, params_json, fitted_at, n_attempts, loss_default, loss_fitted)  -- personal model
paper_questions(id, source_id, subject_id, number, text, marks, year, topic_id, match_score)  -- past papers
jobs           (id, user_id, type, payload_json, status, progress, error, created_at, updated_at)
```

---

## 5. Memory engine (`packages/engine/memory`)

### 5.1 Recall

Every topic (and every formula) has a half-life `h` in days.

```
R(t) = 2^(-t / h)        t = days since last review
```

### 5.2 Initial half-life

```
h0 = base_h × difficulty_factor(d) × user_prior
```
- `base_h` = 1.5 days, `d` in [0, 1] from the AI, `difficulty_factor = 1.6 − 1.2·d`.
- `user_prior` = 1 until fitted; afterwards the user's median half-life ratio on similar-difficulty topics.

### 5.3 Update after a quiz

For a quiz on a topic `t` days after its last review with score `p` (fraction correct, clamped to [0.05, 0.95]):

```
p_adj        = p × conf_factor × speed_factor
h_observed   = −t / log2(p_adj)
h_blend      = (1 − α)·h_old + α·h_observed,    α = max(0.15, 0.5 / sqrt(n_reviews + 1))
growth       = 1 + G × (1 − d) × (1 − R_at_review)^0.6 × p + 0.1·p   (spacing effect)
h_new        = h_blend × growth      (only when p ≥ 0.6; otherwise h_new = h_blend × 0.7)
```
- `conf_factor`: correct with confidence 1–2 → 0.9; 3 → 1.0; 4–5 → 1.03. Wrong with high confidence → no extra penalty here (handled by calibration, section 7).
- `speed_factor`: slower than the user's median response time ×2 → 0.95, else 1.0.
- `G` default 1.2 (personalised in 5.5). A near-perfect score is treated as a lower bound: `h_observed` is capped at `max(2·h_old, 3·t)`.
- Delayed quizzes also nudge mastery: `implied = p_adj / R_at_review`, `mastery = 0.8·mastery + 0.2·implied`.
- `mastery` = exponential moving average of accuracy on attempts made within 1 hour of a learn session.
- `hl_uncertainty` shrinks with each review; used for the score range.

### 5.4 Next review

```
t_review = h × log2(1 / R_target),   R_target = 0.85 by default (0.80 in triage mode)
```

### 5.5 Personalisation (built)

Implemented in `packages/engine/src/fit.ts` and `server/src/personalModel.ts`.

- Starts once the student has **100 answers**; refits after every **50 new answers** or once a **week**, and on "Refit now".
- **Data**: every topic's quizzes in order (grouped by quiz id).
- **Prediction**: before each quiz that comes at least 6 hours after the previous one, the model predicts `P(correct) = mastery × 2^(−t/h)`.
- **Objective**: average log loss of those predictions, plus a small pull towards the defaults: `0.01 × (ln(G/G₀)² + ln(prior)²)`.
- **Parameters fitted**: `growth` G (how much a good review strengthens memory) and `userPrior` (how long a new topic lasts compared with the standard first guess). Search: coordinate descent with multiplicative steps 2, 1.4, 1.15, 1.05.
- After fitting, **every topic's memory is recomputed** by replaying its history with the personal values, so forecasts, review dates, planner and what-if all use them.
- Insights shows how much better the personal model predicts the student's answers than the standard formula (share of log loss removed).
- **Time of day** is not a model parameter: a first quiz right after learning says nothing about decay and later quizzes override any starting value, so it cannot be fitted reliably. It is measured directly instead (section 10) and reported only when the bootstrap test says the difference is real.

## 6. Forecast engine (`packages/engine/forecast`)

### 6.1 Topic expectation on exam day

Simulate forward from today to `exam_at`, applying every planned review (assumed successful at the user's typical score):

```
E_i = M_i × R_i(exam_at)            unstudied topic → guess rate (MCQ 0.25, else 0)
```

### 6.2 Topic weight (built)

- Manual marks the student types are never overwritten.
- **Past papers** (`server/src/pastPapers.ts`), uploaded as kind `past_paper`:
  1. Text from pdf.js, with OCR for scanned pages (section 11.2).
  2. **Year** from the file name or first page (latest 4-digit year from 1990 to now).
  3. **Questions** split on `1.`, `1)`, `Q1`, `Question 1`; a number only starts a question if it is the next one, so "3 marks" lines don't. Sub-parts stay with their question.
  4. **Marks** from `[5]`, `[5 marks]`, `(5 marks)`, `5 marks`; sub-part marks are added up. No marks anywhere → every question counts 1.
  5. **Matching** to topics: TF-IDF cosine between the question and each topic's title (×4) plus its notes; best match if similarity ≥ 0.06, else "unmatched". With an API key, Claude does the matching and keyword matching is the fallback. Unmatched questions can be assigned by hand on the subject page.
  6. **Weight**: `score_i = Σ marks × 0.85^(this year − paper year)` (unknown year counts as 2 years ago). Topics never asked get a floor of 15% of the average, so they're not ignored. Weights are rescaled to a share of 100 and marked `past_papers`.
  7. Deleting a paper recomputes the weights; removing all papers falls back to the content estimate.
- Otherwise: AI estimate from content (headings, length, emphasis), marked "estimated".

### 6.3 Readiness

```
Readiness = Σ w_i·E_i / Σ w_i × 100%
```

### 6.4 Score range (Monte Carlo, 1,000 runs)

Each run: sample each `h_i` from a log-normal around its value with spread `hl_uncertainty`, recompute `E_i`, then sample marks per topic as Binomial(questions_i, E_i). Report p10 / p50 / p90 of total marks. Store one `forecasts` row per subject per day so the trend can be charted.

### 6.5 Performance target

Full forecast for 3 subjects × 150 topics in < 150 ms in the browser (needed for live sliders).

---

## 7. Calibration — dangerous topics

- Confidence 1–5 maps to expected 20 / 40 / 60 / 80 / 100%.
- Per topic over the last 20 attempts: `gap = mean(expected%) − accuracy%`.
- **Dangerous** when `gap ≥ 20` and ≥ 5 attempts. Severity = `gap × w_i`.
- Also track a Brier score per subject for a "how well you know what you know" meter.
- Dangerous topics: red badge, top of dashboard, extra review in the plan, detailed notes forced.

---

## 8. Confusion pairs

- Every MCQ wrong option is tagged with the topic it truly belongs to (`distractors` table), set by the AI when generating the question.
- Wrong answer picking a distractor from topic B while being quizzed on A → `confusions(A,B).count += 1`. Each time a question offers a B distractor → `exposures += 1`.
- Short answers: AI classifies the mistake and may name the confused topic.
- Pair is **active** when `count ≥ 3` and `count / exposures ≥ 0.3`.
- Active pairs get **contrast quizzes**: side-by-side "which one…" questions and a comparison table in notes.

---

## 9. Planner (`packages/engine/planner`)

### 9.1 Inputs
Free slots, exam dates, memory states, topic weights, estimated learn times (from the user's own timer data on similar-difficulty topics; default 12 min per textbook page × difficulty), user's best session length.

### 9.2 Tasks
- **Review** task per studied topic with window `[time when R = 0.90, time when R = 0.70]`.
- **Learn** task per unstudied topic.
- **Contrast** task per active confusion pair.
- `value = w_i × (E_with_task − E_without_task) / minutes`.

### 9.3 Scheduling
Greedy: sort by value, place each task in the earliest free slot inside its window, split long learn tasks into blocks of the user's best session length, max one subject switch per 25 min. Recompute every night and whenever a quiz, slot or exam date changes.

### 9.4 Triage mode
Turns on when `required_minutes > available_minutes × 0.9` before any exam.
- Rank topics by `marks_per_hour = w_i × total_marks × ΔE_i / hours_i`.
- Take from the top until time runs out → **Do** list; the rest → **Skip** list with "skipping this costs ≈ X marks".
- Banner explains in one sentence why triage is on.

### 9.5 What-if simulator
Same planner + forecast run in the browser with changed inputs:
- daily study hours slider (0.5–8 h),
- drag a task to another day,
- toggle a subject's exam date,
- "skip this topic".
Shows readiness and score range before → after, per subject.

---

## 10. Study-pattern insights

From `study_sessions` + `attempts`, compare half-lives across buckets (time of day, session length, breaks, gap between sessions). Report a pattern only when each bucket has ≥ 8 topics and a bootstrap 90% interval of the difference excludes zero. The AI receives the computed facts as JSON and writes one or two simple sentences each, e.g. "Topics you study after 11 pm fade about 35% faster."

---

## 11. Content pipeline and notes

### 11.1 Upload
"+" adds a subject; each subject accepts many PDFs (book, notes, past papers). Files up to 200 MB; processed as a background job, chapter by chapter, with a progress bar.

### 11.2 Steps (per source)

1. Extract text per page with pdf.js.
2. **OCR** (built): pages with fewer than 50 non-space characters are rendered with pdf.js on `@napi-rs/canvas` (about 200 dpi) and read with Tesseract (`tesseract.js` + bundled `@tesseract.js-data/eng`, so it works without internet). The source shows how many pages were read with OCR. About 3 seconds per page.
3. Book: split into chapters (PDF outline, else heading patterns), then AI or heuristic topics, notes in three levels, formulas and tagged questions.
4. Past paper: section 6.2.

User can edit, merge, delete or reorder topics at any time.

### 11.3 Notes views
- **Cheat sheet** — compact, two columns, printable.
- **Mind map** — topic tree in React Flow, nodes coloured by recall.
- **Flashcards** — from questions and items, swipe to rate.
- **Simplified chapters** — chapter-by-chapter plain-language version.

### 11.4 Memory-linked detail
| Topic state | Notes level shown |
|---|---|
| Dangerous, or R(exam) < 0.6 | detailed |
| 0.6 ≤ R(exam) < 0.85 | compact |
| R(exam) ≥ 0.85 and mastery ≥ 0.8 | one line |

### 11.5 Formula sheet
Sorted by predicted recall on exam day, lowest first. Each formula shows a small recall bar.

### 11.6 Last night sheet
Items with `R(exam_at) < 0.70` given today's state, grouped by subject, one page, printable.

---

## 12. Offline on the phone (built)

- **Installable PWA** (`vite-plugin-pwa`): manifest, icons, app shell and fonts precached; opens without a connection.
- **Data pages** (`GET /api/*` except auth): network first, last saved copy when offline (14 days).
- **Offline start**: with a saved token and no connection, the app opens with the last known account.
- **Offline quizzes**: `GET /api/quiz/pack` saves all questions for upcoming exams (with answers, explanations and which topic each wrong option belongs to) on the phone. Offline, the quiz picks questions the same way as the server, grades on the phone and shows mix-ups.
- **Sync**: offline quizzes wait in an outbox; when the phone is online again they go to `POST /api/quiz/sync`, which records the answers with their real times, updates confusions and memory, and applies each quiz only once (by quiz id). The top bar shows "Offline" and how many quizzes are waiting.
- Log out clears the pack, outbox and cached data.

## 13. Main screens

1. **Welcome / login** (section 3.6).
2. **Home — Exam forecast:** one card per subject with readiness %, score range, trend sparkline, days left; "Today's plan" list; dangerous-topic alerts.
3. **Subject:** topic list with recall bars, weights, status; upload area; triage banner if active.
4. **Quiz:** confidence picker (1–5) before revealing options, answer, feedback with page reference.
5. **Plan:** week calendar with free slots and tasks; what-if panel.
6. **Notes:** four view tabs, formula sheet, last night sheet.
7. **Insights:** dangerous topics, confusion pairs, study patterns, AI explanations.
8. **Settings:** free time, target recall, theme, account.

Design: clean and modern, mobile-first, large touch targets, one accent colour per subject.

**Light and dark mode** (built): a sun / moon icon at the top right of every page (and on the login screen) switches theme. The choice is remembered on the device; with no choice the device setting is used. Colours are CSS variables with a light set and a dark "night sky" set, so every page, chart and the mind map follow the theme.

---

## 14. AI usage

- One server module `ai.ts` wraps the Claude API; prompts live in `server/prompts/`.
- All AI outputs are JSON validated with zod; invalid output is retried once, then the job step fails visibly.
- **Dev fallback** (no `ANTHROPIC_API_KEY`): simple heuristic topic split by headings, template questions, and template explanation sentences, so the whole app runs locally without a key.
- Explanations always receive computed numbers as input; prompt forbids new numbers.

---

## 15. Environment variables

| Variable | Purpose |
|---|---|
| `APP_NAME` | Display name in UI and emails (default "Exam Readiness Engine") |
| `JWT_SECRET` | Token signing secret (required in production) |
| `GMAIL_SCRIPT_URL`, `GMAIL_SCRIPT_SECRET` | Apps Script email mode |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | SMTP email mode |
| `OTP_DEMO_MODE` | `true` shows the code on screen in production (demo only) |
| `ANTHROPIC_API_KEY` | Claude API |
| `DATA_DIR` | Folder for the SQLite file and uploads (Railway volume) |
| `PORT` | Server port |

---

## 16. Build phases

| # | Phase | Status |
|---|---|---|
| 1 | Foundation + email OTP login | Done |
| 2 | Content pipeline (PDF → topics, notes, formulas, questions) | Done |
| 3 | Quiz with confidence ratings and mix-up tracking | Done |
| 4 | Memory engine | Done |
| 5 | Forecast | Done |
| 6 | Planner, triage, what-if | Done |
| 7 | Insights | Done |
| 8 | Notes (7 views) | Done |
| 9 | OCR for scanned PDFs | Done |
| 10 | Past-paper weighting | Done |
| 11 | Personal model fit after 100 answers | Done |
| 12 | Offline on the phone (PWA, offline quizzes, sync) | Done |
| 13 | Light and dark mode | Done |

## 17. Non-goals for v1

- Group study, sharing, or teacher accounts.
- Native iOS/Android apps (PWA only).
- Payments.
- Handwriting recognition for answers.
