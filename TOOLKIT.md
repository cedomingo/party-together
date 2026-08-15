# Toolkit catalog

Personal map of the GitHub repos, sites, plugins, and models collected for design, coding agents, jobs, media, and research.

Use the **decision tree** when you know the job. Use the **category tables** when you are browsing. Use **stack recipes** when you want a proven combo instead of picking one tool at a time.

A few items in the original list were duplicated or mislabeled. Those are called out in [Corrections](#corrections).

---

## Decision tree

| If you need to… | Start here |
|---|---|
| Mock a UI from a vibe / prompt, then hand off to Figma | [Google Stitch](#1-design--frontend) → Figma Education |
| Make a site that does **not** look like default AI slop | [Hallmark](#1-design--frontend) + [Lenis](#1-design--frontend) |
| Copy a live site's look into code you can edit | [SkillUI](#1-design--frontend) (tokens/docs) or [ditto.site](#1-design--frontend) (full Next/Vite app) |
| Stop Cursor/Claude from overbuilding and guessing | [Karpathy skills](#2-agent-skills-prompts--coding-assistants) |
| Make agent writing sound like a human tech doc | [SimpleEnglish](#2-agent-skills-prompts--coding-assistants) |
| Teach Claude a new repeatable workflow | `/skill-creator` |
| Give an agent the latest library docs, not 2023 training data | [Context7](#2-agent-skills-prompts--coding-assistants) |
| Let an agent read Twitter, Reddit, YouTube, GitHub without fighting APIs | [Agent Reach](#3-web-access-scraping--browsers) |
| Run a real browser, debug messy pages, write E2E tests | [Playwright](#3-web-access-scraping--browsers) |
| Self-host scraping + a dashboard + MCP | [HeadlessX](#3-web-access-scraping--browsers) |
| Apply for internships / remote jobs / score a resume | [Jobs & career](#4-jobs--career) |
| Learn Git visually, or ship a real project while learning | [Learning](#5-learning) |
| Speech in, speech out, OCR a whole book, generate images/video | [Media](#6-media-image-video-audio-ocr) |
| Face detect / mocap / WiFi sensing | [Vision & spatial](#7-computer-vision--spatial) |
| Subscriptions, paywalls, OG previews, a free `.is-a.dev` domain | [Ship & monetize](#8-ship-host-pay--market) |
| Huge context window, or a free coding CLI | [Models & chat](#9-models--chat) |
| Authorized security review of **your** app | [Strix](#10-security-authorized-use-only) |
| A hard decision with multiple models arguing | [LLM Council](#11-research--hard-decisions) |
| Overnight ML experiments while you sleep | [autoresearch](#11-research--hard-decisions) |

---

## Stack recipes

**Landing page that does not look AI-generated**
1. Hallmark for layout/type/color opinions
2. Stitch or Figma for the first visual pass
3. Lenis if the page should feel like a smooth editorial scroll
4. Open Graph if the link preview should show a real image, not a blank card

**Clone a reference site into something you can ship**
1. SkillUI if you only need the design system (colors, type, spacing, motion) as markdown for the agent
2. ditto.site if you need a runnable Next.js/Vite project from the live URL
3. Hallmark on top if the clone still looks generic

**Give Cursor/Claude a better default brain**
1. Karpathy skills (what **not** to do)
2. Context7 (fresh docs)
3. SimpleEnglish (plain writing)
4. Agent Reach (read the live internet)
5. Playwright (open the actual UI and catch broken output)

**Job hunt loop**
1. Jake Gut template for the resume PDF
2. HackerRank Hiring Agent to see how an AI rubric scores you
3. Remote.com / Instahyre / internship site to find openings
4. OpenAI Student Collective if you want that specific program

**Multi-agent on one project**
1. Ruflo if you want swarm/orchestration around Claude Code or Codex
2. Agency Agents if you want named specialist personas (frontend, QA, PM) without the full swarm
3. Everything Claude Code if you want a battle-tested plugin pack of agents, hooks, and commands

---

## 1. Design & frontend

Use this section when the problem is **how it looks and feels**, not how the backend works.

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **Google Stitch** | [stitch.withgoogle.com](https://stitch.withgoogle.com/?pli=1) | You have a product idea, a vibe, a sketch, or a screenshot and need high-fidelity screens + frontend code in minutes. | Fastest prompt → UI path. Exports to Figma and HTML/CSS. Best as the **ideation** step, not the final design system. |
| **Figma Education** | [figma.com/education](https://www.figma.com/education/) | You are a student/educator and need Figma (and FigJam) without paying full price. | Official education plan. Use it after Stitch: Stitch explores, Figma is where you refine, share, and hand off. |
| **Hallmark** | [usehallmark.com](https://www.usehallmark.com/) | Any agent-built UI that is drifting into purple gradients, Inter-everywhere, and centered hero sections. | A skill that **refuses** the five most common AI-site tells. Install with `npx skills add nutlope/hallmark`. Use `/hallmark` when generating or auditing pages. |
| **Lenis** | [github.com/darkroomengineering/lenis](https://github.com/darkroomengineering/lenis) | Marketing pages, portfolios, and editorial sites where native scroll feels cheap. | The standard smooth-scroll library. Small, framework-agnostic, pairs with GSAP. Skip it on dashboards and forms. |
| **SkillUI** | [skillui.vercel.app](https://skillui.vercel.app/) / `npx skillui` | You saw a site you like and want its **design system** as markdown the agent can follow. | Static analysis (no API key). Spits out `DESIGN.md`, tokens, screenshots, and a `.skill` file. Use this when you want to **match a look**, not steal a whole codebase. |
| **ditto.site** | [github.com/ion-design/ditto.site](https://github.com/ion-design/ditto.site) | You need a **runnable** Next.js or Vite app cloned from a public URL. | Capture-to-code, not an LLM guessing HTML. Best when you need a starting project, not just tokens. Only use on sites you have the right to copy. |
| **FingerprintJS** | [github.com/fingerprintjs/fingerprintjs](https://github.com/fingerprintjs/fingerprintjs) | You need a visitor ID that survives incognito and cookie clears (fraud, unique-user analytics, A/B without login). | Browser-attribute hash, not a cookie. Open-source core. Get consent and follow privacy law — this is identification, not a toy. |

**How they fit together**

```
idea / vibe  →  Stitch (explore)
reference URL →  SkillUI (tokens)  or  ditto.site (full app)
polish        →  Hallmark + Figma
feel          →  Lenis
identity      →  FingerprintJS (only if you actually need it)
```

---

## 2. Agent skills, prompts & coding assistants

Use this section when the problem is **how the model behaves**, not which website to scrape.

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **skill-creator** | Claude plugin: `/skill-creator` | You want a new Cursor/Claude skill (a `SKILL.md`) and do not want to invent the format by hand. | Official loop: interview you → write the skill → eval → improve. Use it whenever a workflow will happen more than twice. |
| **Everything Claude Code** | [github.com/worldflowai/everything-claude-code](https://github.com/worldflowai/everything-claude-code) (also [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code)) | You want a full Claude Code plugin: agents, slash commands, hooks, rules, MCP examples. | Production configs from heavy daily use (planner, reviewer, TDD, e2e). Install as a plugin; do **not** enable every MCP at once or you will burn the context window. |
| **SimpleEnglish** | [github.com/AminBlg/SimpleEnglish](https://github.com/AminBlg/SimpleEnglish) | READMEs, error messages, runbooks, incident notes, `AGENTS.md`. Anywhere ambiguity is expensive. | Forces ASD-STE100-style rules (short sentences, one meaning per word, no hedging). Kills LinkedIn-robot prose. Do not use it for marketing copy. |
| **Karpathy skills** | [github.com/multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills) | Default instructions for Claude Code / Cursor on every non-trivial coding task. | Four rules: think before coding, simplicity first, surgical diffs, goal-driven loops. This is the "what **not** to do" file. Not a math visualizer — see [Corrections](#corrections). |
| **Agency Agents** | [github.com/msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | You want a named specialist (frontend, QA, PM, copy) with a personality and a deliverable, not a generic chat. | Large roster of role files you can drop into Claude/Cursor. Desktop app can install them. Use one agent at a time; a whole "agency" at once is noise. |
| **Awesome Hermes Agent** | [github.com/0xNyk/awesome-hermes-agent](https://github.com/0xNyk/awesome-hermes-agent) | You are running (or evaluating) Nous Research's Hermes Agent and need skills, plugins, memory, and bridges. | Curated directory for that ecosystem. Skip it if you are staying on Cursor/Claude Code. |
| **Ruflo** | [github.com/ruvnet/ruflo](https://github.com/ruvnet/ruflo) | One project, many agents: swarms, memory across sessions, routing, federation across machines. | Meta-harness around Claude Code / Codex. `npx ruflo init` is the full install; plugins-only is lighter. Overkill for a single-file fix. |
| **Context7** | [github.com/upstash/context7](https://github.com/upstash/context7) | The agent is about to use Next.js, Supabase, Playwright, or any library whose API changed after the model's training cutoff. | Pulls **version-specific** official docs into the prompt. MCP or `ctx7` CLI. This is the default fix for "the code it wrote is from two major versions ago." |
| **Freebuff CLI** | [freebuff.com](https://freebuff.com/) | You want a terminal coding agent with no API key and no subscription. | Ad-supported Claude Code-style loop. Fine for side projects and experiments. Do not put secrets or private company code into an ad-funded cloud agent. |

**Minimum Cursor/Claude setup (do this once)**

1. Karpathy skills in project rules
2. Context7 MCP
3. SimpleEnglish for docs
4. skill-creator whenever you invent a new workflow

---

## 3. Web access, scraping & browsers

Use this section when the agent **cannot see the live internet** (or sees a wall of HTML).

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **Agent Reach** | [github.com/Panniantong/agent-reach](https://github.com/Panniantong/agent-reach) | "Read this tweet / Reddit thread / YouTube / GitHub issue / random URL" and the agent 403s or dumps raw HTML. | Capability layer: it picks the current working backend (Jina, yt-dlp, gh, etc.) and health-checks them. Free, local cookies. Best first install for "give my agent eyes." |
| **HeadlessX** | [github.com/saifyxpro/HeadlessX](https://github.com/saifyxpro/HeadlessX) | You want a **self-hosted** scrape/search platform: dashboard, API keys, queues, proxies, MCP. | Camoufox-based, anti-detect, operators for web / Google AI search / Tavily / Exa / YouTube. Use this when Agent Reach's one-off CLI is not enough and you need a service. |
| **Playwright CLI** | [playwright.dev](https://playwright.dev/) | Open a real browser, click through flows, screenshot failures, write E2E tests, inspect what the user actually sees. | Industry standard. Best at catching "the agent said it works" vs messy DOM, hydration, and visual bugs. Pair with coding agents; do not replace it with a scraper when you need a real page. |
| **Cloudflare Computer** | [github.com/cloudflare/computer](https://github.com/cloudflare/computer) | You need a **durable sandbox + filesystem** for an agent on Cloudflare (container, isolate shell, or isolate JS). | Preview SDK: SQLite-backed VFS inside a Durable Object, optional Linux container. **Not a scraper.** The original note "stop writing scrapers" does not match this repo — see [Corrections](#corrections). For "don't write a scraper, just fetch the page," use Agent Reach / Jina / Playwright instead. |
| **n8n** | [n8n.io](https://n8n.io/) | Recurring workflows: "when a form lands, score the resume, post to Slack, update a sheet." | Self-hostable automation with 400+ integrations. Use it when the job is glue between apps, not a one-off agent chat. |

**Pick one**

- One-off "read this URL/platform" → **Agent Reach**
- Visual / interactive page → **Playwright**
- Always-on scrape API you control → **HeadlessX**
- Scheduled business glue → **n8n**

Only scrape or clone sites you are allowed to access. Login-cookie tools can get accounts banned; use throwaway accounts, never a main login.

---

## 4. Jobs & career

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **HackerRank Hiring Agent** | [github.com/interviewstreet/hiring-agent](https://github.com/interviewstreet/hiring-agent) | Before you send a resume into a volume intern/new-grad pipeline. See how an AI rubric scores you, with evidence. | Open-source resume → GitHub-enrich → score pipeline. Built because HackerRank gets 50k+ intern apps. Scores **vary run to run**; treat it as a rehearsal, not a grade. Optimize for real projects and GitHub signal, not invisible-text tricks. |
| **Jake Gut resume** | [github.com/jakegut/resume](https://github.com/jakegut/resume) | You need a clean, ATS-friendly one-page LaTeX resume. | Simple, widely copied template (via sb2nov). Overleaf-friendly. Best default before you invent a fancy design. |
| **Remote.com** | [remote.com](https://remote.com/) | Searching remote / distributed roles, plus employer-of-record / payroll if you get hired across borders. | Job search **and** the infra companies use to hire you legally in another country. |
| **Instahyre** | [instahyre.com](https://instahyre.com/) | India-heavy tech hiring: recruiter reach-outs, less spray-and-pray than generic boards. | Recruiter-driven. Strong if you want product/engineering roles with Indian companies or India offices. |
| **Internship site** | [internship-raday-2027.yuxhuang.com](http://internship-raday-2027.yuxhuang.com/) | Looking specifically for internships (the 2027 cycle site you saved). | Niche board. Use alongside Remote/Instahyre, not instead of them. |
| **DevOps interview Q&A** | [github.com/rohitg00/devops-interview-questions](https://github.com/rohitg00/devops-interview-questions) | Interview prep for DevOps / SRE / platform: Linux, CI/CD, K8s, cloud, observability. | Large, practical Q&A dump. Use to drill, not as the only source of truth — verify answers against current docs (Context7 helps). |
| **OpenAI Student Collective** | [openai.com/student-collective](https://openai.com/student-collective/#apply) | You are a student and want OpenAI's student program (community, credits, events). | Official apply page. Time-boxed; check eligibility and deadlines when you open it. |

**Job-hunt order that wastes the least time**

1. Rewrite resume on the Jake Gut template
2. Run Hiring Agent against the intern (or closest) rubric; fix evidence gaps
3. Apply on Remote.com / Instahyre / the internship board
4. Drill DevOps (or whatever track) Q&A the night before interviews

---

## 5. Learning

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **Learn Git Branching** | [learngitbranching.js.org](https://learngitbranching.js.org/) | You know `add`/`commit`/`push` but merge, rebase, and detached HEAD still feel like folklore. | Visual sandbox. Best 30 minutes you can spend before a real team Git workflow. |
| **Codecrafters** | [codecrafters.io](https://codecrafters.io/) | You want to **build** Redis, Git, HTTP, or a Docker-like tool from scratch, in your language. | Challenges are real protocol work, not tutorials that fade. Paid; worth it if you learn by implementing. |
| **Figma Education** | [figma.com/education](https://www.figma.com/education/) | Learning UI professionally, or you need Figma for class/portfolio. | See [Design](#1-design--frontend). |

---

## 6. Media: image, video, audio, OCR

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **Fooocus** | [github.com/lllyasviel/Fooocus](https://github.com/lllyasviel/Fooocus) | Local image generation without ComfyUI node spaghetti. | Opinionated Gradio UI on Stable Diffusion. Best "it just makes good images" local tool. Needs a GPU. |
| **Seedance 2.0** | [github.com/Emily2040/seedance-2.0](https://github.com/Emily2040/seedance-2.0) | Text/image → video. Short clips, product motion, concept films. | Community wrapper around ByteDance's Seedance video model. Use when still images are not enough. Check the repo for current API vs local instructions. |
| **Whisper** | [github.com/openai/whisper](https://github.com/openai/whisper) | Speech → text: lectures, interviews, meeting recordings, YouTube captions you already have audio for. | Still the default local ASR. Accurate, many languages, no cloud required if you run it yourself. |
| **Pocket TTS** | [github.com/kyutai-labs/pocket-tts](https://github.com/kyutai-labs/pocket-tts) | Text → speech on a laptop CPU: voiceovers, accessibility, agent voice, cloning a consented voice. | ~100M params, ~200ms first chunk, faster than real-time on Apple Silicon, no GPU required. Do not clone a voice without permission. |
| **Unlimited-OCR** | [github.com/baidu/Unlimited-OCR](https://github.com/baidu/Unlimited-OCR) | Parse a long PDF, a scanned book, or many pages **in one shot** instead of chunking. | Extends DeepSeek-OCR-style long-horizon parsing. Needs a serious NVIDIA GPU. Overkill for a single screenshot (use a vision model instead). |
| **yt-dlp** | [github.com/yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | Download or extract audio/subtitles from YouTube and many other sites you are allowed to copy. | The maintained youtube-dl fork. Also what Agent Reach uses for YouTube captions. Respect site ToS and copyright. |

**Audio pair:** Whisper (in) + Pocket TTS (out) is a full local voice loop.

---

## 7. Computer vision & spatial

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **UniFace** | [github.com/yakhyo/uniface](https://github.com/yakhyo/uniface) | Face detect, recognize, landmarks, gaze, age/emotion, anti-spoof, anonymize — in Python. | One library instead of wiring RetinaFace + ArcFace + BiSeNet yourself. `pip install "uniface[cpu]"`. Check model licenses before commercial use. |
| **PoseCap** | [github.com/CorridorTech/PoseCap](https://github.com/CorridorTech/PoseCap) | Webcam or video → live body motion on a Blender character. No mocap suit. | Markerless SMPL-X capture built with Corridor Digital. Windows + Blender 4.2+. Research SMPL-X license is non-commercial unless you buy Meshcapade. |
| **RuView** | [github.com/ruvnet/ruview](https://github.com/ruvnet/ruview) | Presence, occupancy, breathing/heart-rate, activity **through walls**, no cameras — WiFi CSI on ESP32. | Spatial intelligence from radio, not pixels. Home Assistant / Matter / Apple Home. Hardware + calibration project, not a weekend npm install. Privacy-sensitive: people in the space should know. |

---

## 8. Ship, host, pay & market

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **is-a.dev** | [is-a.dev](https://is-a.dev/) | Free `yourname.is-a.dev` subdomain for a portfolio or side project. | GitHub-PR based DNS. Perfect for a first public URL. Not for a serious product brand. |
| **Open Graph debugger** | [opengraph.xyz](https://www.opengraph.xyz/) | Before you share a link: check the title, description, and preview image Slack/iMessage/Twitter will show. | Fastest way to see why a link looks broken. Pair with Next.js `opengraph-image`. |
| **RevenueCat** | [revenuecat.com](https://www.revenuecat.com/) | iOS/Android/web subscriptions: entitlements, receipts, paywalls, analytics. | Industry default for in-app purchases. Use it instead of talking to App Store / Play Billing yourself. |
| **Superwall** | [superwall.com](https://www.superwall.com/) | You want to **A/B test paywalls** without shipping a new app build for every copy/layout change. | Remote paywall experiments. Pairs with RevenueCat; Superwall is the experiment layer, RevenueCat is the source of truth for "are they subscribed?" |

---

## 9. Models & chat

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **Kimi** | [kimi.com](https://www.kimi.com/) | Free web chat, long documents, Chinese + English, when you do not want to burn Cursor/Claude quota. | Moonshot's Kimi (try Kimi K3 when listed). Good "second opinion" model and long-file reader. |
| **Qwen** | [qwen.ai](https://qwen.ai/) / Alibaba Cloud | Huge context: dump a repo, a book, or a giant log and ask questions. | Qwen's long-context variants are the reason this is on the list. Use when the bottleneck is **fit it in the window**, not "smartest coding model." |

Cursor/Claude remain the daily drivers for coding. Kimi/Qwen are overflow + long-context + free-tier.

---

## 10. Security (authorized use only)

Use these **only** on systems you own or have written permission to test. Do not use them to break into other people's apps, dump credentials, or run CTF/exploit playbooks against third parties.

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **Strix** | [github.com/usestrix/strix](https://github.com/usestrix/strix) | Pentest **your** app: find real vulns, then patch. CI can fail the build on findings. | Autonomous AppSec agent with a developer CLI. Prefer it for **your** attack surface. Pair the **fix** workflow with human review; do not treat generated PoCs as something to copy onto other targets. |
| **reverse-skill** | [github.com/zhaoxuya520/reverse-skill](https://github.com/zhaoxuya520/reverse-skill) | You already do reverse engineering / authorized pentest / CTF on **your** samples, and you want the agent to pick jadx vs Ghidra vs Frida instead of guessing. | Skill router: task → methodology → local tools. Heavy, Windows/Kali oriented. Not a website-cloner (that is SkillUI). Not a toy — it assumes a real RE toolchain. |

If the goal is "understand this public site's CSS so I can restyle my own app," that is **SkillUI**, not reverse-skill.

---

## 11. Research & hard decisions

| Tool | Link | When to use | Why this one |
|---|---|---|---|
| **LLM Council** | [github.com/karpathy/llm-council](https://github.com/karpathy/llm-council) | Architecture choices, career forks, "should we do X" — anything where one model's confidence is not enough. | Several models answer, then peer-review each other, then a chair synthesizes. Slow and spendy. Worth it when reversing the decision is expensive. |
| **autoresearch** | [github.com/karpathy/autoresearch](https://github.com/karpathy/autoresearch) | You have a GPU and want an agent to run short LLM-training experiments overnight (edit `train.py`, 5-minute runs, keep if val loss improved). | Smallest real "AI researcher" loop. You edit `program.md` (the org instructions), not the trainer. Needs NVIDIA; Mac forks exist. |

---

## Corrections

These were on the original list twice, or the note did not match the repo.

| Original note | What is actually true |
|---|---|
| `andrej-karpathy-skills` listed twice: "what NOT to do" **and** "math visualizer for thinking/animation" | Same repo. It is **only** the Karpathy coding-behavior guidelines. It is not a math/animation visualizer. If you wanted visuals of reasoning, that is a different tool (e.g. Manim / 3blue1brown-style). |
| `cloudflare/computer` — "stop writing scrapers" | This repo is a **Durable Object filesystem + sandbox runtime** (container / isolate). It is not a scraping product. For "don't write a scraper," use Agent Reach, Playwright, or Cloudflare Browser Rendering / Markdown fetch — not this. |
| `reverse-skill` — "reverse engineers websites (?)" | It is a **cybersecurity skill router** (APK, binaries, JS crypto, pentest, CTF). For "turn a website's look into markdown," use **SkillUI**. For "turn a URL into a Next app," use **ditto.site**. |
| FingerprintJS as a casual frontend toy | It identifies browsers across incognito. Use it for fraud/unique users with a privacy policy, not as default analytics. |

---

## Install cheatsheet

```bash
# Design skill that fights AI-looking sites
npx skills add nutlope/hallmark

# Plain-English writing skill
npx skills add AminBlg/SimpleEnglish

# Design-system extractor
npm install -g skillui

# Free terminal coding agent (ads; don't paste secrets)
npm install -g freebuff

# Smooth scroll in a frontend app
npm install lenis

# Face analysis
pip install "uniface[cpu]"

# Local TTS
pip install pocket-tts   # or: uvx pocket-tts generate

# YouTube / caption extract
pip install yt-dlp
```

Claude Code extras:

```text
/plugin install skill-creator@claude-plugins-official
/plugin marketplace add affaan-m/everything-claude-code
/plugin marketplace add forrestchang/andrej-karpathy-skills
```

Context7: add the MCP at `https://mcp.context7.com/mcp` in Cursor.

---

## Keep this file useful

When you add a new link, put it in **one** category, fill **When** and **Why**, and add a line to the decision tree if it is a new job type. If two tools do the same job, say which to try first.
