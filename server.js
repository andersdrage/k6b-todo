const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { randomUUID } = require("crypto");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_TRANSLATION_MODEL = process.env.OPENAI_TRANSLATION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data");
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(DATA_DIR, "tasks.json");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

function createDefaultState() {
  return {
    title: "Kirkeåsveien 6b",
    sections: [
      {
        id: `section-${randomUUID()}`,
        title: "Entré",
        tasks: [
          { id: `task-${randomUUID()}`, text: "Legge flis i gangen", done: false, starred: false },
          { id: `task-${randomUUID()}`, text: "Fuge flis", done: false, starred: false },
          { id: `task-${randomUUID()}`, text: "Silikonere", done: false, starred: false },
          { id: `task-${randomUUID()}`, text: "Fikse flis i entré", done: false, starred: false },
          { id: `task-${randomUUID()}`, text: "Pusse ferdig vegg", done: false, starred: false },
          { id: `task-${randomUUID()}`, text: "Male vegger", done: false, starred: false }
        ]
      }
    ],
    updatedAt: new Date().toISOString()
  };
}

function normalizeText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function sanitizeState(rawState) {
  if (!rawState || typeof rawState !== "object") {
    return null;
  }

  const sectionList = Array.isArray(rawState.sections) ? rawState.sections : [];
  const sections = [];

  for (const rawSection of sectionList.slice(0, 100)) {
    if (!rawSection || typeof rawSection !== "object") {
      continue;
    }

    const title = normalizeText(rawSection.title, 80) || "Untitled";
    const tasks = [];
    const rawTasks = Array.isArray(rawSection.tasks) ? rawSection.tasks : [];

    for (const rawTask of rawTasks.slice(0, 500)) {
      if (!rawTask || typeof rawTask !== "object") {
        continue;
      }

      const text = normalizeText(rawTask.text, 220);
      if (!text) {
        continue;
      }

      tasks.push({
        id: typeof rawTask.id === "string" && rawTask.id ? rawTask.id : `task-${randomUUID()}`,
        text,
        done: Boolean(rawTask.done),
        starred: Boolean(rawTask.starred)
      });
    }

    sections.push({
      id: typeof rawSection.id === "string" && rawSection.id ? rawSection.id : `section-${randomUUID()}`,
      title,
      tasks
    });
  }

  return {
    title: "Kirkeåsveien 6b",
    sections,
    updatedAt: new Date().toISOString()
  };
}

function sanitizeTranslationInput(rawBody) {
  if (!rawBody || typeof rawBody !== "object") {
    return null;
  }

  const sourceSections = Array.isArray(rawBody.sections) ? rawBody.sections : [];
  const sections = [];

  for (const rawSection of sourceSections.slice(0, 100)) {
    if (!rawSection || typeof rawSection !== "object") {
      continue;
    }

    const sectionId = typeof rawSection.id === "string" && rawSection.id ? rawSection.id : `section-${randomUUID()}`;
    const sectionTitle = normalizeText(rawSection.title, 80);
    const tasks = [];
    const rawTasks = Array.isArray(rawSection.tasks) ? rawSection.tasks : [];

    for (const rawTask of rawTasks.slice(0, 500)) {
      if (!rawTask || typeof rawTask !== "object") {
        continue;
      }

      const taskId = typeof rawTask.id === "string" && rawTask.id ? rawTask.id : `task-${randomUUID()}`;
      const taskText = normalizeText(rawTask.text, 220);
      if (!taskText) {
        continue;
      }

      tasks.push({
        id: taskId,
        text: taskText
      });
    }

    sections.push({
      id: sectionId,
      title: sectionTitle || "Untitled",
      tasks
    });
  }

  return {
    targetLanguage: normalizeText(rawBody.targetLanguage, 24) || "Polish",
    sections
  };
}

function extractJsonFromModelOutput(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    throw new Error("Empty model output");
  }

  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (!objectMatch) {
    throw new Error("Model output missing JSON object");
  }

  return JSON.parse(objectMatch[0]);
}

function sanitizeTranslationOutput(rawOutput, sourceSections) {
  const translatedSections = Array.isArray(rawOutput?.sections) ? rawOutput.sections : [];
  const sectionMap = new Map();

  for (const translated of translatedSections) {
    if (!translated || typeof translated !== "object" || typeof translated.id !== "string") {
      continue;
    }

    const translatedTasks = Array.isArray(translated.tasks) ? translated.tasks : [];
    const taskMap = new Map();
    for (const translatedTask of translatedTasks) {
      if (!translatedTask || typeof translatedTask !== "object" || typeof translatedTask.id !== "string") {
        continue;
      }

      taskMap.set(translatedTask.id, normalizeText(translatedTask.text, 220));
    }

    sectionMap.set(translated.id, {
      title: normalizeText(translated.title, 80),
      tasks: taskMap
    });
  }

  return {
    sections: sourceSections.map((section) => {
      const translatedSection = sectionMap.get(section.id);

      return {
        id: section.id,
        title: translatedSection?.title || section.title,
        tasks: section.tasks.map((task) => ({
          id: task.id,
          text: translatedSection?.tasks.get(task.id) || task.text
        }))
      };
    })
  };
}

function getTextFromResponsesPayload(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  const outputBlocks = Array.isArray(payload?.output) ? payload.output : [];
  for (const block of outputBlocks) {
    const contentBlocks = Array.isArray(block?.content) ? block.content : [];
    for (const content of contentBlocks) {
      if (typeof content?.text === "string" && content.text.trim()) {
        return content.text;
      }
    }
  }

  return "";
}

async function translateSectionsWithOpenAI(input) {
  if (!OPENAI_API_KEY) {
    const error = new Error("OPENAI_API_KEY is not configured");
    error.statusCode = 503;
    throw error;
  }

  const prompt = [
    `Translate all text values to ${input.targetLanguage} for a construction todo board.`,
    "Keep ids exactly unchanged.",
    "Keep the same JSON structure and ordering.",
    'Return only strict JSON with this schema: {"sections":[{"id":"...","title":"...","tasks":[{"id":"...","text":"..."}]}]}',
    `Input JSON: ${JSON.stringify({ sections: input.sections })}`
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_TRANSLATION_MODEL,
      input: prompt,
      max_output_tokens: 1200
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Translation API failed with ${response.status}: ${errorText}`);
    error.statusCode = 502;
    throw error;
  }

  const payload = await response.json();
  const rawText = getTextFromResponsesPayload(payload);
  const parsed = extractJsonFromModelOutput(rawText);
  return sanitizeTranslationOutput(parsed, input.sections);
}

function ensureDataFile() {
  const dataDir = path.dirname(DATA_FILE);

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(createDefaultState(), null, 2));
  }
}

function loadState() {
  ensureDataFile();

  try {
    const fileContent = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(fileContent);
    return sanitizeState(parsed) || createDefaultState();
  } catch (error) {
    return createDefaultState();
  }
}

let saveTimer = null;
function saveStateDebounced(nextState) {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(nextState, null, 2), (error) => {
      if (error) {
        console.error("Failed to save tasks:", error);
      }
    });
  }, 150);
}

let state = loadState();

io.on("connection", (socket) => {
  socket.emit("state:sync", state);

  socket.on("state:update", (incoming) => {
    const sanitized = sanitizeState(incoming);
    if (!sanitized) {
      return;
    }

    state = sanitized;
    saveStateDebounced(state);
    io.emit("state:sync", state);
  });
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/translate", async (req, res) => {
  const input = sanitizeTranslationInput(req.body);
  if (!input) {
    res.status(400).json({ error: "Invalid translation payload" });
    return;
  }

  if (input.sections.length === 0) {
    res.json({ sections: [] });
    return;
  }

  try {
    const translated = await translateSectionsWithOpenAI(input);
    res.json(translated);
  } catch (error) {
    const statusCode = Number(error?.statusCode) || 500;
    res.status(statusCode).json({ error: "Translation failed" });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, updatedAt: state.updatedAt });
});

server.listen(PORT, () => {
  console.log(`Kirkeåsveien board running on http://localhost:${PORT}`);
});
