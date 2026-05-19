# 🚀 AI BDR Intel Engine

An open-source, fully automated Business Development Representative (BDR) intelligence engine built entirely on **Cloudflare Workers** and powered by **DeepSeek AI**. 

It automatically discovers high-value leads from various RSS feeds (Google News, ITJuzi, Google Alerts), intercepts industry newsletters via Cloudflare Email Routing, and utilizes AI to analyze, score, and summarize the business opportunities. High-priority leads are pushed instantly via Telegram and Email.

---

## 🌟 Key Features

- **🌐 Zero-Maintenance Serverless**: Runs entirely on Cloudflare Workers edge network. No servers to manage, nearly $0 to run.
- **📡 Multi-Source Discovery**: Periodically scans custom Google News queries, generic RSS feeds (ITJuzi, 36Kr), and Google Alerts.
- **✉️ Inbound Email Interception**: Integrates with Cloudflare Email Routing to ingest and analyze third-party industry newsletters (Crunchbase, etc.).
- **🧠 DeepSeek AI Analysis**: Automatically filters out noise, reads long articles, and summarizes *why* a company is a high-value target with a 1-10 score.
- **📬 Multi-Channel Alerts**: Pushes beautiful HTML intelligence reports to your personal email (via free MailChannels) and instant alerts to Telegram.
- **🗃️ Lead Deduplication**: Uses Cloudflare D1 (SQL database) to ensure you never get spammed with the same lead twice.

---

## 🛠️ Architecture

1. **Cron Trigger**: Wakes up at 9:00 AM (Mon-Fri) to fetch RSS feeds.
2. **Email Trigger**: Listens for any incoming emails to your subscribed aliases.
3. **DeepSeek Pipeline**: Reads the text/HTML, identifies the target company, scores the lead, and extracts the core rationale.
4. **D1 Database**: Checks for existing entries. If new, inserts the lead.
5. **Notification Engine**: Dispatches HTML emails via `MailChannels` and messages to Telegram Bot API.

---

## 🚀 One-Click Deployment Guide

### Prerequisites
1. A Cloudflare Account (Free tier is perfectly fine).
2. [Node.js](https://nodejs.org/) installed.
3. A DeepSeek API Key.
4. A Telegram Bot Token & Chat ID.

### Step 1: Install Wrangler
```bash
npm install -g wrangler
npm install
```

### Step 2: Configure Cloudflare Services
You need to set up the D1 database and KV namespace.

**Create D1 Database:**
```bash
npx wrangler d1 create bdr-intel-db
# Copy the database_id it outputs!
```

**Create KV Namespace:**
```bash
npx wrangler kv:namespace create "BDR_LEADS_CACHE"
# Copy the id it outputs!
```

### Step 3: Setup `wrangler.toml`
Rename `wrangler.example.toml` to `wrangler.toml` and paste the IDs you got from the previous step.

```toml
# wrangler.toml
[[kv_namespaces]]
binding = "BDR_LEADS_CACHE"
id = "YOUR_KV_NAMESPACE_ID" # <--- Paste Here

[[d1_databases]]
binding = "DB"
database_name = "bdr-intel-db"
database_id = "YOUR_D1_DATABASE_ID" # <--- Paste Here

[vars]
SUBSCRIBER_EMAIL = "your_personal_email@gmail.com" # <--- Where to send leads
```

### Step 4: Setup Secrets
Run the following commands to securely add your API keys to the Cloudflare Worker:
```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
```

### Step 5: Deploy
```bash
npx wrangler deploy
```

---

## 📩 Setting up Email Routing (Optional but Highly Recommended)
To allow the Engine to read Crunchbase/ITJuzi newsletters automatically:
1. Go to your Cloudflare Dashboard -> Email Routing.
2. Create a custom address (e.g., `bdr@yourdomain.com`).
3. Set the Action to **Send to a Worker** and select your newly deployed `ai-bdr-intel-engine`.
4. Go subscribe to industry newsletters using `bdr@yourdomain.com`.

*(Note: The initial subscription verification link might require you to temporarily change the routing to forward to your personal email so you can click "verify").*

---

## 📜 License
MIT License. Feel free to use, modify, and build upon this engine to close more deals!
