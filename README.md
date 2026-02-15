# Kirkeåsveien 6b - Shared Build Board

A one-page, Apple Notes-inspired collaborative task board with live sync.

## Features
- Shared live updates (Socket.IO): both users see changes immediately.
- Drag and drop sections and tasks.
- Add/edit/delete sections and tasks.
- Checkbox completion with strikethrough + reduced opacity.
- Optional per-user Polish mode (translated with OpenAI API).
- Data persistence to `data/tasks.json`.
- Minimal neutral UI tuned for mobile use.

## Run locally
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start server:
   ```bash
   npm start
   ```
3. Open:
   ```
   http://localhost:3000
   ```

## Add your logo
Place your square logo file at:
`public/logo.svg`

If no logo exists, the app shows a subtle `K6` fallback badge.

## Optional: Polish translation mode
To enable the top-right `Polish` toggle with live translation, set:

- `OPENAI_API_KEY=your_api_key`
- Optional: `OPENAI_TRANSLATION_MODEL=gpt-4o-mini`

Notes:
- The toggle is per-user/per-browser (local preference), not shared globally.
- Polish mode is read-only for text fields to avoid overwriting original language text.

## Deploy (quick option)
Deploy this repo to Render/Railway as a Node web service.

- Build command: `npm install`
- Start command: `npm start`
- Environment: Node 18+

After deploy, share the single URL with your builder. All changes sync through the live server.
