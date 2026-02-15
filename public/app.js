const socket = io();

const sectionsEl = document.getElementById("sections");
const addSectionBtn = document.getElementById("addSectionBtn");
const polishToggle = document.getElementById("polishToggle");
const syncPill = document.getElementById("syncPill");
const syncLabel = document.getElementById("syncLabel");
const logoImage = document.getElementById("logoImage");
const logoShell = document.getElementById("logoShell");
const saveToast = document.getElementById("saveToast");
const translateOverlay = document.getElementById("translateOverlay");
const polishToggleText = polishToggle ? polishToggle.querySelector("span:last-child") : null;

const LANGUAGE_STORAGE_KEY = "kirkeaas-board-language";

let state = {
  title: "Kirkeåsveien 6b",
  sections: [],
  updatedAt: null
};

let sectionSortable = null;
let taskSortables = [];
let pendingFocus = null;
let saveToastTimer = null;
let hideToastTimer = null;
let translationTimer = null;
let translationRequestId = 0;
let translationInFlight = false;
let translationSignature = "";
let translatedSectionTitles = new Map();
let translatedTaskTexts = new Map();
let isPolishMode = localStorage.getItem(LANGUAGE_STORAGE_KEY) === "pl";

function toId(prefix) {
  if (window.crypto && window.crypto.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stateSignature(value) {
  return JSON.stringify({
    title: value.title,
    sections: value.sections
  });
}

function translationSourceSignature(value) {
  return JSON.stringify(
    value.sections.map((section) => ({
      id: section.id,
      title: section.title,
      tasks: section.tasks.map((task) => ({
        id: task.id,
        text: task.text
      }))
    }))
  );
}

function normalizeState(nextState) {
  if (!nextState || typeof nextState !== "object") {
    return { title: "Kirkeåsveien 6b", sections: [], updatedAt: new Date().toISOString() };
  }

  const sections = Array.isArray(nextState.sections)
    ? nextState.sections.map((section) => ({
        id: String(section.id || toId("section")),
        title: String(section.title || "Untitled"),
        tasks: Array.isArray(section.tasks)
          ? section.tasks
              .filter((task) => task && typeof task === "object")
              .map((task) => ({
                id: String(task.id || toId("task")),
                text: String(task.text || "").trim(),
                done: Boolean(task.done),
                starred: Boolean(task.starred)
              }))
              .filter((task) => task.text.length > 0)
          : []
      }))
    : [];

  return {
    title: "Kirkeåsveien 6b",
    sections,
    updatedAt: String(nextState.updatedAt || new Date().toISOString())
  };
}

function setSyncStatus(isConnected) {
  syncPill.classList.toggle("connected", isConnected);
  syncLabel.textContent = isConnected ? "Up to date" : "Reconnecting...";
}

function scheduleSavedToast() {
  if (!saveToast) {
    return;
  }

  if (saveToastTimer) {
    clearTimeout(saveToastTimer);
  }

  saveToastTimer = setTimeout(() => {
    showToast("Saved");
  }, 2500);
}

function showToast(message) {
  if (!saveToast) {
    return;
  }

  saveToast.textContent = message;
  saveToast.classList.add("visible");

  if (hideToastTimer) {
    clearTimeout(hideToastTimer);
  }

  hideToastTimer = setTimeout(() => {
    saveToast.classList.remove("visible");
  }, 1400);
}

function setPendingFocus(nextFocus) {
  pendingFocus = nextFocus;
}

function applyPendingFocus() {
  if (!pendingFocus) {
    return;
  }

  requestAnimationFrame(() => {
    if (!pendingFocus) {
      return;
    }

    if (pendingFocus.type === "section") {
      const input = sectionsEl.querySelector(`.section-title-input[data-section-id="${pendingFocus.sectionId}"]`);
      if (input) {
        input.focus();
        input.select();
      }
    }

    if (pendingFocus.type === "task") {
      const input = sectionsEl.querySelector(
        `.task-text-input[data-section-id="${pendingFocus.sectionId}"][data-task-id="${pendingFocus.taskId}"]`
      );
      if (input) {
        input.focus();
        input.select();
      }
    }

    pendingFocus = null;
  });
}

function setPolishMode(nextMode) {
  isPolishMode = Boolean(nextMode);
  localStorage.setItem(LANGUAGE_STORAGE_KEY, isPolishMode ? "pl" : "default");
  document.body.classList.toggle("polish-mode", isPolishMode);
  if (!isPolishMode) {
    if (translationTimer) {
      clearTimeout(translationTimer);
      translationTimer = null;
    }
    translationRequestId += 1;
    translationInFlight = false;
  }

  if (isPolishMode) {
    scheduleTranslation();
  }

  updatePolishToggle();
  render();
}

function updatePolishToggle() {
  if (!polishToggle) {
    return;
  }

  if (polishToggleText) {
    polishToggleText.textContent = isPolishMode ? "Norsk" : "Polish";
  }

  polishToggle.classList.toggle("active", isPolishMode);
  polishToggle.classList.toggle("loading", translationInFlight);
  polishToggle.setAttribute("aria-pressed", isPolishMode ? "true" : "false");

  if (translateOverlay) {
    const isVisible = isPolishMode && translationInFlight;
    translateOverlay.classList.toggle("visible", isVisible);
    translateOverlay.setAttribute("aria-hidden", isVisible ? "false" : "true");
  }
}

function clearTranslationCache() {
  translatedSectionTitles = new Map();
  translatedTaskTexts = new Map();
  translationSignature = "";
}

function translationPayloadFromState() {
  return {
    targetLanguage: "Polish",
    sections: state.sections.map((section) => ({
      id: section.id,
      title: section.title,
      tasks: section.tasks.map((task) => ({ id: task.id, text: task.text }))
    }))
  };
}

function scheduleTranslation() {
  if (!isPolishMode) {
    return;
  }

  if (translationTimer) {
    clearTimeout(translationTimer);
  }

  translationTimer = setTimeout(() => {
    requestPolishTranslations();
  }, 320);
}

async function requestPolishTranslations() {
  if (!isPolishMode) {
    return;
  }

  const signature = translationSourceSignature(state);
  if (signature === translationSignature) {
    return;
  }

  const requestId = ++translationRequestId;
  translationInFlight = true;
  updatePolishToggle();

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(translationPayloadFromState())
    });

    if (!response.ok) {
      throw new Error(`Translation request failed: ${response.status}`);
    }

    const payload = await response.json();
    if (requestId !== translationRequestId) {
      return;
    }

    const nextSectionTitles = new Map();
    const nextTaskTexts = new Map();
    const translatedSections = Array.isArray(payload?.sections) ? payload.sections : [];

    translatedSections.forEach((section) => {
      if (!section || typeof section !== "object" || typeof section.id !== "string") {
        return;
      }

      if (typeof section.title === "string" && section.title.trim()) {
        nextSectionTitles.set(section.id, section.title.trim());
      }

      const tasks = Array.isArray(section.tasks) ? section.tasks : [];
      tasks.forEach((task) => {
        if (!task || typeof task !== "object" || typeof task.id !== "string") {
          return;
        }

        if (typeof task.text === "string" && task.text.trim()) {
          nextTaskTexts.set(`${section.id}:${task.id}`, task.text.trim());
        }
      });
    });

    translatedSectionTitles = nextSectionTitles;
    translatedTaskTexts = nextTaskTexts;
    translationSignature = signature;

    if (isPolishMode) {
      render();
    }
  } catch (error) {
    console.error("Polish translation failed:", error);
    showToast("Translation unavailable");
  } finally {
    if (requestId === translationRequestId) {
      translationInFlight = false;
      updatePolishToggle();
    }
  }
}

function getDisplaySectionTitle(section) {
  if (!isPolishMode) {
    return section.title;
  }

  return translatedSectionTitles.get(section.id) || section.title;
}

function getDisplayTaskText(sectionId, task) {
  if (!isPolishMode) {
    return task.text;
  }

  return translatedTaskTexts.get(`${sectionId}:${task.id}`) || task.text;
}

function removeTask(sectionId, taskId) {
  const section = state.sections.find((entry) => entry.id === sectionId);
  if (!section) {
    return;
  }

  section.tasks = section.tasks.filter((task) => task.id !== taskId);
  commitState();
}

function removeSection(sectionId) {
  state.sections = state.sections.filter((entry) => entry.id !== sectionId);
  commitState();
}

function toggleTaskPriority(sectionId, taskId) {
  const section = state.sections.find((entry) => entry.id === sectionId);
  const task = section?.tasks.find((entry) => entry.id === taskId);
  if (!task) {
    return;
  }

  task.starred = !task.starred;
  commitState();
}

function moveItem(list, fromIndex, toIndex) {
  const copy = [...list];
  const [item] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, item);
  return copy;
}

function createSection() {
  const sectionId = toId("section");
  state.sections.push({
    id: sectionId,
    title: "New section",
    tasks: []
  });

  setPendingFocus({ type: "section", sectionId });
  commitState();
}

function createTask(sectionId) {
  const section = state.sections.find((entry) => entry.id === sectionId);
  if (!section) {
    return;
  }

  const taskId = toId("task");
  section.tasks.push({
    id: taskId,
    text: "New task",
    done: false,
    starred: false
  });

  setPendingFocus({ type: "task", sectionId, taskId });
  commitState();
}

function destroySortables() {
  if (sectionSortable) {
    sectionSortable.destroy();
    sectionSortable = null;
  }

  taskSortables.forEach((sortable) => sortable.destroy());
  taskSortables = [];
}

function onTaskMoved(event) {
  const taskId = event.item.dataset.taskId;
  const sourceSectionId = event.from.dataset.sectionId;
  const targetSectionId = event.to.dataset.sectionId;

  const sourceSection = state.sections.find((section) => section.id === sourceSectionId);
  const targetSection = state.sections.find((section) => section.id === targetSectionId);

  if (!sourceSection || !targetSection || !taskId) {
    return;
  }

  const taskIndex = sourceSection.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex < 0) {
    return;
  }

  const [task] = sourceSection.tasks.splice(taskIndex, 1);
  const rawTargetIndex = Number.isInteger(event.newIndex) ? event.newIndex : targetSection.tasks.length;
  const targetIndex = Math.max(0, Math.min(rawTargetIndex, targetSection.tasks.length));
  targetSection.tasks.splice(targetIndex, 0, task);
  commitState();
}

function initSortables() {
  destroySortables();

  if (typeof Sortable === "undefined") {
    return;
  }

  sectionSortable = new Sortable(sectionsEl, {
    animation: 160,
    draggable: ".section-card",
    handle: ".section-drag",
    ghostClass: "drag-ghost",
    chosenClass: "drag-chosen",
    onEnd(event) {
      if (event.oldIndex === event.newIndex) {
        return;
      }

      const fromIndex = Number.isInteger(event.oldIndex) ? event.oldIndex : 0;
      const rawToIndex = Number.isInteger(event.newIndex) ? event.newIndex : state.sections.length - 1;
      const toIndex = Math.max(0, Math.min(rawToIndex, state.sections.length - 1));
      state.sections = moveItem(state.sections, fromIndex, toIndex);
      commitState();
    }
  });

  sectionsEl.querySelectorAll(".task-list").forEach((taskList) => {
    const sortable = new Sortable(taskList, {
      animation: 160,
      group: "shared-tasks",
      draggable: ".task-item",
      handle: ".task-drag",
      ghostClass: "drag-ghost",
      chosenClass: "drag-chosen",
      onEnd(event) {
        if (event.oldIndex === event.newIndex && event.from === event.to) {
          return;
        }

        onTaskMoved(event);
      }
    });

    taskSortables.push(sortable);
  });
}

function render() {
  document.body.classList.toggle("polish-mode", isPolishMode);

  if (addSectionBtn) {
    addSectionBtn.disabled = isPolishMode;
  }

  if (state.sections.length === 0) {
    sectionsEl.innerHTML = '<div class="empty-state">No sections yet. Add one to start your build plan.</div>';
    destroySortables();
    return;
  }

  sectionsEl.innerHTML = state.sections
    .map((section, index) => {
      const sectionTitle = getDisplaySectionTitle(section);
      const sectionReadonly = isPolishMode ? "readonly" : "";
      const addTaskDisabled = isPolishMode ? "disabled" : "";

      const tasksMarkup = section.tasks
        .map((task) => {
          const taskText = getDisplayTaskText(section.id, task);
          const taskReadonly = isPolishMode ? "readonly" : "";

          return `
            <li class="task-item ${task.done ? "is-done" : ""} ${task.starred ? "is-priority" : ""}" data-task-id="${escapeHtml(task.id)}">
              <button class="drag-btn task-drag" type="button" title="Drag task" aria-label="Drag task">⋮⋮</button>
              <input class="task-checkbox" type="checkbox" ${task.done ? "checked" : ""} data-section-id="${escapeHtml(section.id)}" data-task-id="${escapeHtml(task.id)}" />
              <input class="task-text-input" type="text" value="${escapeHtml(taskText)}" maxlength="220" ${taskReadonly} data-section-id="${escapeHtml(section.id)}" data-task-id="${escapeHtml(task.id)}" aria-label="Task text" />
              <button class="priority-btn ${task.starred ? "active" : ""}" type="button" title="Mark as priority" aria-label="Mark as priority" aria-pressed="${task.starred ? "true" : "false"}" data-action="toggle-priority" data-section-id="${escapeHtml(section.id)}" data-task-id="${escapeHtml(task.id)}">${task.starred ? "★" : "☆"}</button>
              <button class="delete-btn" type="button" title="Delete task" aria-label="Delete task" data-action="delete-task" data-section-id="${escapeHtml(section.id)}" data-task-id="${escapeHtml(task.id)}">✕</button>
            </li>
          `;
        })
        .join("");

      return `
        <article class="section-card" data-section-id="${escapeHtml(section.id)}" style="--index:${index}">
          <div class="section-head">
            <button class="drag-btn section-drag" type="button" title="Drag section" aria-label="Drag section">⋮⋮</button>
            <input class="section-title-input" type="text" value="${escapeHtml(sectionTitle)}" maxlength="80" ${sectionReadonly} data-section-id="${escapeHtml(section.id)}" />
            <button type="button" class="task-add-btn section-task-add" data-action="create-task" data-section-id="${escapeHtml(section.id)}" ${addTaskDisabled} aria-label="Add task">+</button>
            <button class="delete-btn" type="button" title="Delete section" aria-label="Delete section" data-action="delete-section" data-section-id="${escapeHtml(section.id)}">✕</button>
          </div>

          <ul class="task-list" data-section-id="${escapeHtml(section.id)}">
            ${tasksMarkup}
          </ul>
        </article>
      `;
    })
    .join("");

  initSortables();
  applyPendingFocus();
}

function commitState() {
  state.updatedAt = new Date().toISOString();
  socket.emit("state:update", state);
  render();
  scheduleSavedToast();

  if (isPolishMode) {
    scheduleTranslation();
  }
}

if (addSectionBtn) {
  addSectionBtn.addEventListener("click", () => {
    if (isPolishMode) {
      return;
    }

    createSection();
  });
}

if (polishToggle) {
  polishToggle.addEventListener("click", () => {
    setPolishMode(!isPolishMode);
  });
}

sectionsEl.addEventListener("change", (event) => {
  const target = event.target;

  if (target.classList.contains("task-checkbox")) {
    const section = state.sections.find((entry) => entry.id === target.dataset.sectionId);
    const task = section?.tasks.find((entry) => entry.id === target.dataset.taskId);
    if (!task) {
      return;
    }

    task.done = target.checked;
    commitState();
    return;
  }

  if (isPolishMode) {
    return;
  }

  if (target.classList.contains("section-title-input")) {
    const section = state.sections.find((entry) => entry.id === target.dataset.sectionId);
    if (!section) {
      return;
    }

    section.title = target.value.trim() || "Untitled";
    commitState();
  }
});

sectionsEl.addEventListener(
  "blur",
  (event) => {
    if (isPolishMode) {
      return;
    }

    const target = event.target;
    if (!target.classList.contains("task-text-input")) {
      return;
    }

    const section = state.sections.find((entry) => entry.id === target.dataset.sectionId);
    const task = section?.tasks.find((entry) => entry.id === target.dataset.taskId);
    if (!task) {
      return;
    }

    const text = target.value.trim();
    if (!text) {
      removeTask(target.dataset.sectionId, target.dataset.taskId);
      return;
    }

    if (task.text !== text) {
      task.text = text;
      commitState();
    }
  },
  true
);

sectionsEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && event.target.classList.contains("section-title-input")) {
    event.preventDefault();
    event.target.blur();
    return;
  }

  if (event.key === "Enter" && event.target.classList.contains("task-text-input")) {
    event.preventDefault();
    event.target.blur();
  }
});

sectionsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.action;
  const sectionId = button.dataset.sectionId;

  if (action === "create-task" && sectionId) {
    if (isPolishMode) {
      return;
    }

    createTask(sectionId);
    return;
  }

  if (action === "delete-section" && sectionId) {
    removeSection(sectionId);
    return;
  }

  if (action === "toggle-priority" && sectionId && button.dataset.taskId) {
    if (isPolishMode) {
      return;
    }

    toggleTaskPriority(sectionId, button.dataset.taskId);
    return;
  }

  if (action === "delete-task" && sectionId && button.dataset.taskId) {
    removeTask(sectionId, button.dataset.taskId);
  }
});

socket.on("connect", () => {
  setSyncStatus(true);
});

socket.on("disconnect", () => {
  setSyncStatus(false);
});

socket.on("state:sync", (incoming) => {
  const normalized = normalizeState(incoming);

  if (stateSignature(normalized) === stateSignature(state)) {
    state.updatedAt = normalized.updatedAt;
    return;
  }

  state = normalized;
  render();

  if (isPolishMode) {
    scheduleTranslation();
  }
});

if (logoImage) {
  logoImage.addEventListener("error", () => {
    logoShell.classList.add("fallback");
    logoShell.innerHTML = "<span>K6</span>";
  });
}

updatePolishToggle();
if (isPolishMode) {
  clearTranslationCache();
}
