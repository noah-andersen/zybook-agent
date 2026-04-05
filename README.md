# 🤖 ZyBook Agent

A Chrome extension that uses OpenAI's GPT models to automatically complete zyBooks assignments. Primarily optimized for **introductory Python** courses.

## Features

- **Multiple Choice Questions** — AI reads the question and choices, selects the correct answer
- **Short Answer / Fill-in-the-Blank** — AI generates concise answers for text inputs
- **Coding Exercises (zyDE)** — AI writes Python code solutions and inserts them into the editor
- **Challenge Activities** — Multi-level code challenges with auto-retry on incorrect answers
- **Participation Activities** — Auto-clicks through animations and step-by-step content
- **Matching Activities** — AI determines correct pairings
- **Content Tool Activities** — Handles interactive tools like array games
- **Configurable** — Choose your model, set delays, toggle auto-submit
- **Visual Feedback** — In-page overlay shows progress, activities are highlighted as they're completed

## Installation

### 1. Get an OpenAI API Key

1. Go to [platform.openai.com](https://platform.openai.com/)
2. Create an account or sign in
3. Navigate to **API Keys** and create a new key
4. Copy the key (starts with `sk-`)

### 2. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top right)
3. Click **"Load unpacked"**
4. Select the `zybook-agent` folder (the folder containing `manifest.json`)
5. The extension icon should appear in your toolbar

### 3. Configure

1. Click the ZyBook Agent icon in your Chrome toolbar
2. Paste your OpenAI API key
3. Choose your preferred model:
   - **GPT-4o Mini** — Fastest and cheapest, good for simple questions
   - **GPT-4o** — Recommended balance of speed and accuracy
   - **GPT-4 Turbo** — Most capable, slower and more expensive
4. Adjust delay and auto-submit settings
5. Click **Save Settings**

## Usage

1. Navigate to a zyBooks assignment page
2. Click the ZyBook Agent extension icon
3. Click **🔍 Scan Page** to detect activities
4. Review the activity summary
5. Click **▶️ Run Agent** to start
6. Watch the agent work through each activity
7. Click **⏹ Stop** at any time to halt

## Project Structure

```
zybook-agent/
├── manifest.json              # Chrome extension manifest (V3)
├── background/
│   └── service-worker.js      # Handles OpenAI API calls
├── content/
│   ├── main.js                # Entry point — overlay UI, message handler, agent runner
│   ├── utils.js               # Shared utilities (AI calls, DOM helpers, sleep, etc.)
│   ├── scanner.js             # Activity scanner & completion detection
│   ├── overlay.css            # In-page status overlay styles
│   └── handlers/
│       ├── animation.js       # Play-through animation handler
│       ├── multiple-choice.js # MC & true/false questions
│       ├── short-answer.js    # Fill-in-the-blank / text input
│       ├── content-tool.js    # Interactive tools (array games, etc.)
│       ├── challenge.js       # Multi-level code challenges (ACE editor)
│       ├── coding.js          # zyDE coding exercises
│       ├── matching.js        # Drag-and-drop matching
│       ├── participation.js   # Click-through participation activities
│       └── generic.js         # Fallback for unrecognized activity types
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.css              # Popup styles (dark theme)
│   └── popup.js               # Popup controller logic
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── lib/
│   └── phosphor/              # Bundled Phosphor Icons (fonts + CSS)
└── README.md
```

## How It Works

1. **Content Scripts** are injected into zyBooks pages (utils → scanner → handlers → main entry point)
2. **Scan** detects interactive activities by querying zyBooks DOM selectors and classifying by CSS classes
3. For each activity, the content is extracted and sent to OpenAI via the **Background Service Worker**
4. The AI response is parsed and applied back to the page (clicking choices, filling inputs, writing code)
5. **Challenge activities** iterate through multiple levels, writing code in ACE editors and auto-retrying on failure
6. If auto-submit is enabled, the agent clicks "Check" / "Submit" buttons automatically

## Tips

- **Refresh the page** if the scan doesn't find activities — sometimes zyBooks lazy-loads content
- **Use GPT-4o** for coding exercises — it's significantly more accurate than Mini
- **Set a reasonable delay** (1.5-3s) to avoid appearing bot-like
- **Review answers** before submitting — the AI is good but not perfect
- **Coding exercises** may need manual tweaking for edge cases

## Cost Estimation

Approximate OpenAI API costs per zyBooks chapter (varies by content):
- **GPT-4o Mini**: ~$0.01–$0.05
- **GPT-4o**: ~$0.10–$0.50
- **GPT-4 Turbo**: ~$0.20–$1.00

## ⚠️ Disclaimer

This tool is provided for **educational and research purposes only**. Using AI to complete academic assignments may violate your institution's academic integrity policies. Use responsibly and at your own risk.

## Development

To modify the extension:

1. Edit the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the ZyBook Agent card
4. Reload the zyBooks page

No build step required — this is a pure HTML/CSS/JS Chrome extension.