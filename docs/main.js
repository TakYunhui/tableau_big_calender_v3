/* global tableau, flatpickr */

const SETTINGS_KEYS = {
  kind: "date_kind",
  startParam: "date_start_param",
  endParam: "date_end_param",
  format: "date_format",
};

const DEFAULTS = {
  kind: "range",
  format: "Y. n. j",
};

const MOCK_STORAGE_KEY = "tableau_big_calender_v3_mock_state";
const MOCK_DEFAULT_STATE = {
  settings: {
    kind: "range",
    startParam: "mock_start_date",
    endParam: "mock_end_date",
    format: DEFAULTS.format,
  },
  parameters: {
    mock_start_date: "2026-07-01",
    mock_end_date: "2026-07-06",
    mock_single_date: "2026-07-06",
  },
};

const LAYOUT_PROFILE_BY_NAME = {
  wide: {
    frameWidth: 570,
    frameHeight: 165,
    rangeBarHeight: 165,
    quickPanelMinHeight: 165,
    calendarHeight: 165,
    configPanelHeight: 165,
  },
  compact: {
    frameWidth: 300,
    frameHeight: 112,
    rangeBarHeight: 72,
    quickPanelMinHeight: 112,
    calendarHeight: 112,
    configPanelHeight: 112,
  },
};
const WIDE_LAYOUT_MIN_WIDTH = 360;

let fp = null;
let unregisterParamHandlers = [];
let activeLayoutProfileName = "";
let layoutSyncRafId = 0;
let unregisterDashboardLayoutListener = null;

let isConfigOpen = false;
let isCalendarOpen = false;
let isQuickOpen = false;
let isApplying = false;

let pendingStartDate = null;
let pendingEndDate = null;
let originalStartDate = null;
let originalEndDate = null;

let calendarMode = "range"; // "start" | "end" | "range"
let hasUserSelectionInCurrentOpen = false;
let toastTimer = null;
let selectedQuickType = "";
let lastEditedEdge = ""; // "start" | "end" | "range" | "quick"
let activeTableauApi = null;
let isMockRuntime = false;
let persistentHintMessage = "";
let transientHintMessage = "";

function qs(id) {
  return document.getElementById(id);
}

function getTableauApi() {
  return activeTableauApi || window.tableau || null;
}

function getExtensionsApi() {
  return getTableauApi()?.extensions || null;
}

function renderHint() {
  const el = qs("hint");
  if (!el) return;
  el.textContent = transientHintMessage || persistentHintMessage || "";
}

function setHint(msg) {
  transientHintMessage = msg || "";
  renderHint();
}

function setPersistentHint(msg) {
  persistentHintMessage = msg || "";
  renderHint();
}

function setCfgHint(msg) {
  const el = qs("cfgHint");
  if (el) el.textContent = msg || "";
}

function showToast(msg) {
  const el = qs("toast");
  if (!el) return;

  el.textContent = msg || "";
  el.classList.add("show");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 2200);
}

function isAuthoringMode() {
  return getExtensionsApi()?.environment?.mode === "authoring";
}

function normalizeDisplayFormat(format) {
  const value = String(format || "").trim();
  if (!value) return DEFAULTS.format;

  if (["Y-m-d", "Y. m. d", "Y.m.d", "Y/m/d"].includes(value)) {
    return DEFAULTS.format;
  }

  return value;
}

function loadSettings() {
  const s = getExtensionsApi()?.settings;
  if (!s) {
    return {
      kind: DEFAULTS.kind,
      startParam: "",
      endParam: "",
      format: DEFAULTS.format,
    };
  }

  return {
    kind: s.get(SETTINGS_KEYS.kind) || DEFAULTS.kind,
    startParam: s.get(SETTINGS_KEYS.startParam) || "",
    endParam: s.get(SETTINGS_KEYS.endParam) || "",
    format: normalizeDisplayFormat(s.get(SETTINGS_KEYS.format)),
  };
}

function getLayoutProfileOverride() {
  const params = new URLSearchParams(window.location.search);
  const value = String(params.get("layoutProfile") || "").trim().toLowerCase();
  return LAYOUT_PROFILE_BY_NAME[value] ? value : "";
}

function getFallbackViewportSize() {
  const root = document.documentElement;
  const body = document.body;
  const width = Math.round(root?.clientWidth || body?.clientWidth || window.innerWidth || 0);
  const height = Math.round(root?.clientHeight || body?.clientHeight || window.innerHeight || 0);
  return { width, height };
}

function shouldStartInMockMode() {
  const params = new URLSearchParams(window.location.search);
  const raw = String(params.get("mock") || "").trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;

  return !getExtensionsApi()?.initializeAsync;
}

function normalizeMockDateValue(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toISODateOnly(value);
  }

  const text = String(value ?? "").trim();
  if (!text) return fallback;

  const parsedDate = parseDateStringValue(text);
  if (parsedDate) return toISODateOnly(parsedDate);

  const asNumber = Number(text);
  if (!Number.isNaN(asNumber)) {
    const parsedNumericDate = parseNumericDateValue(asNumber) || tableauSerialNumberToDate(asNumber);
    if (parsedNumericDate) return toISODateOnly(parsedNumericDate);
  }

  return fallback;
}

function readMockStateFromStorage() {
  try {
    const raw = window.localStorage.getItem(MOCK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeMockStateToStorage(state) {
  try {
    window.localStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify(state));
  } catch (_) {}
}

function createDefaultMockState() {
  return {
    settings: { ...MOCK_DEFAULT_STATE.settings },
    parameters: { ...MOCK_DEFAULT_STATE.parameters },
  };
}

function normalizeMockState(rawState) {
  const next = createDefaultMockState();
  const raw = rawState && typeof rawState === "object" ? rawState : {};
  const rawSettings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const rawParameters = raw.parameters && typeof raw.parameters === "object" ? raw.parameters : {};

  next.settings.kind = rawSettings.kind === "single" ? "single" : next.settings.kind;
  next.settings.startParam = String(rawSettings.startParam || next.settings.startParam);
  next.settings.endParam = String(rawSettings.endParam || next.settings.endParam);
  next.settings.format = normalizeDisplayFormat(rawSettings.format || next.settings.format);

  Object.keys(next.parameters).forEach((key) => {
    next.parameters[key] = normalizeMockDateValue(rawParameters[key], next.parameters[key]);
  });

  const params = new URLSearchParams(window.location.search);
  const mockKind = String(params.get("mockKind") || "").trim().toLowerCase();
  const mockFormat = String(params.get("mockFormat") || "").trim();
  const mockStart = params.get("mockStart");
  const mockEnd = params.get("mockEnd");
  const mockSingle = params.get("mockSingle");

  if (mockKind === "single") {
    next.settings.kind = "single";
    next.settings.startParam = "mock_single_date";
    next.settings.endParam = "";
  } else if (mockKind === "range") {
    next.settings.kind = "range";
    next.settings.startParam = "mock_start_date";
    next.settings.endParam = "mock_end_date";
  }

  if (mockFormat) next.settings.format = normalizeDisplayFormat(mockFormat);
  if (mockStart !== null) next.parameters.mock_start_date = normalizeMockDateValue(mockStart, next.parameters.mock_start_date);
  if (mockEnd !== null) next.parameters.mock_end_date = normalizeMockDateValue(mockEnd, next.parameters.mock_end_date);
  if (mockSingle !== null) next.parameters.mock_single_date = normalizeMockDateValue(mockSingle, next.parameters.mock_single_date);

  return next;
}

function createListenerRegistry() {
  const listeners = new Map();

  return {
    add(type, handler) {
      const key = String(type);
      const bucket = listeners.get(key) || new Set();
      bucket.add(handler);
      listeners.set(key, bucket);

      return () => {
        bucket.delete(handler);
        if (!bucket.size) listeners.delete(key);
      };
    },
    emit(type, payload) {
      const bucket = listeners.get(String(type));
      if (!bucket) return;

      bucket.forEach((handler) => {
        try {
          handler(payload);
        } catch (e) {
          console.error(e);
        }
      });
    },
  };
}

function createMockTableauApi() {
  const eventTypes = {
    ParameterChanged: "ParameterChanged",
    DashboardLayoutChanged: "DashboardLayoutChanged",
    SettingsChanged: "SettingsChanged",
  };
  const state = normalizeMockState(readMockStateFromStorage());
  const settingsListeners = createListenerRegistry();
  const dashboardListeners = createListenerRegistry();
  const parameterListeners = new Map();

  function persistState() {
    writeMockStateToStorage(state);
  }

  function getParameterListenerRegistry(name) {
    if (!parameterListeners.has(name)) {
      parameterListeners.set(name, createListenerRegistry());
    }
    return parameterListeners.get(name);
  }

  function getMockParameterCurrentValue(name) {
    const value = state.parameters[name];
    const parsed = parseDateStringValue(value);

    return {
      value,
      formattedValue: parsed ? toUIDateDisplay(parsed) : String(value || ""),
    };
  }

  function createMockParameter(name) {
    return {
      name,
      dataType: "date",
      parameterType: "date",
      type: "date",
      get currentValue() {
        return getMockParameterCurrentValue(name);
      },
      async changeValueAsync(value) {
        state.parameters[name] = normalizeMockDateValue(value, state.parameters[name]);
        persistState();
        getParameterListenerRegistry(name).emit(eventTypes.ParameterChanged, {
          getParameterAsync: async () => this,
        });
      },
      addEventListener(type, handler) {
        return getParameterListenerRegistry(name).add(type, handler);
      },
    };
  }

  const parameters = [
    createMockParameter("mock_start_date"),
    createMockParameter("mock_end_date"),
    createMockParameter("mock_single_date"),
  ];

  const dashboard = {
    name: "Mock Dashboard",
    get size() {
      return getFallbackViewportSize();
    },
    getDashboardObjectById(id) {
      if (id !== "mock-zone") return null;
      return {
        id,
        size: getFallbackViewportSize(),
      };
    },
    async getParametersAsync() {
      return parameters;
    },
    addEventListener(type, handler) {
      return dashboardListeners.add(type, handler);
    },
  };

  window.addEventListener("resize", () => {
    dashboardListeners.emit(eventTypes.DashboardLayoutChanged, { dashboard });
  });

  const settings = {
    get(key) {
      return state.settings[key] ?? "";
    },
    set(key, value) {
      state.settings[key] = String(value ?? "");
    },
    async saveAsync() {
      persistState();
      settingsListeners.emit(eventTypes.SettingsChanged, {});
    },
    addEventListener(type, handler) {
      return settingsListeners.add(type, handler);
    },
  };

  return {
    TableauEventType: eventTypes,
    extensions: {
      environment: { mode: "authoring" },
      dashboardObjectId: "mock-zone",
      settings,
      dashboardContent: { dashboard },
      async initializeAsync() {
        persistState();
      },
    },
  };
}

function applyRuntimeModeState() {
  const mode = isMockRuntime ? "mock" : "tableau";
  document.documentElement.dataset.runtimeMode = mode;
  if (document.body) document.body.dataset.runtimeMode = mode;
  document.title = isMockRuntime ? "조회기간 [Mock]" : "조회기간";
}

function enableMockRuntime(reason) {
  isMockRuntime = true;
  activeTableauApi = createMockTableauApi();
  setPersistentHint("Mock mode: 브라우저 미리보기, 적용값은 localStorage에만 저장됨");
  applyRuntimeModeState();

  if (reason) {
    console.warn("Mock mode enabled:", reason);
  }
}

async function getExtensionLayoutMetrics() {
  const dashboard = await getDashboard();
  const dashboardSize = dashboard?.size || null;
  const dashboardObjectId = getExtensionsApi()?.dashboardObjectId;
  const dashboardObject = dashboardObjectId ? dashboard.getDashboardObjectById(dashboardObjectId) : null;
  const objectSize = dashboardObject?.size || null;
  const fallback = getFallbackViewportSize();

  return {
    dashboardSize,
    objectSize,
    width: Math.round(objectSize?.width || fallback.width || dashboardSize?.width || 0),
    height: Math.round(objectSize?.height || fallback.height || dashboardSize?.height || 0),
  };
}

function resolveLayoutProfileName(measuredWidth) {
  const forcedProfile = getLayoutProfileOverride();
  if (forcedProfile) return forcedProfile;

  return measuredWidth >= WIDE_LAYOUT_MIN_WIDTH ? "wide" : "compact";
}

function getActiveLayoutProfile(measuredWidth) {
  const name = resolveLayoutProfileName(measuredWidth);
  return {
    name,
    ...LAYOUT_PROFILE_BY_NAME[name],
  };
}

function applyLayoutSizeVars(layout, metrics) {
  const root = document.documentElement;
  if (!root) return;

  root.dataset.layoutProfile = layout.name;
  if (document.body) document.body.dataset.layoutProfile = layout.name;

  const frameWidth = Math.round(metrics?.width || layout.frameWidth);
  const frameHeight = Math.round(metrics?.height || layout.frameHeight);

  root.style.setProperty("--frame-width", `${frameWidth}px`);
  root.style.setProperty("--frame-height", `${frameHeight}px`);
  root.style.setProperty("--range-bar-height", `${layout.rangeBarHeight}px`);
  root.style.setProperty("--quick-panel-min-height", `${layout.quickPanelMinHeight}px`);
  root.style.setProperty("--calendar-height", `${layout.calendarHeight}px`);
  root.style.setProperty("--config-panel-height", `${layout.configPanelHeight}px`);
}

async function syncLayoutProfile() {
  const metrics = await getExtensionLayoutMetrics();
  const layout = getActiveLayoutProfile(metrics.width);
  const isProfileChanged = activeLayoutProfileName !== layout.name;
  activeLayoutProfileName = layout.name;

  if (
    isProfileChanged ||
    !document.documentElement?.style.getPropertyValue("--frame-width") ||
    !document.documentElement?.style.getPropertyValue("--frame-height")
  ) {
    applyLayoutSizeVars(layout, metrics);
  } else {
    applyLayoutSizeVars(layout, metrics);
  }

  syncOpenStateClasses();
}

function requestLayoutSync() {
  if (layoutSyncRafId) cancelAnimationFrame(layoutSyncRafId);

  layoutSyncRafId = requestAnimationFrame(() => {
    layoutSyncRafId = 0;
    void syncLayoutProfile().then(() => {
      updateDateFieldLayout();
      updateActionStates();
      updateQuickPanelVisibility();
    });
  });
}

async function getDashboard() {
  return getExtensionsApi()?.dashboardContent?.dashboard || null;
}

async function getParametersMap() {
  const dash = await getDashboard();
  const params = await dash.getParametersAsync();
  const map = new Map();
  params.forEach((p) => map.set(p.name, p));
  return map;
}

function toISODateOnly(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toUIDateDisplay(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}. ${m}. ${day}.`;
}

function formatDateForUI(d, format) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";

  const fmt = normalizeDisplayFormat(format);

  try {
    if (window.flatpickr && typeof window.flatpickr.formatDate === "function") {
      return window.flatpickr.formatDate(d, fmt);
    }
  } catch (_) {}

  return toUIDateDisplay(d);
}

function cloneDate(d) {
  return d ? new Date(d.getTime()) : null;
}

function createDateFromParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(y, m - 1, d);

  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  ) {
    return null;
  }

  return startOfDay(date);
}

function createMonthStartDateFromParts(year, month) {
  return createDateFromParts(year, month, 1);
}

function parseDateStringValue(value) {
  if (typeof value !== "string") return null;

  const text = value.trim();
  if (!text || text === "-") return null;

  const compactMonth = text.match(/^(\d{4})(\d{2})$/);
  if (compactMonth) {
    return createMonthStartDateFromParts(compactMonth[1], compactMonth[2]);
  }

  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return createDateFromParts(compact[1], compact[2], compact[3]);
  }

  const koMonth = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월(?:\s+.*)?$/);
  if (koMonth) {
    return createMonthStartDateFromParts(koMonth[1], koMonth[2]);
  }

  const ko = text.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s+.*)?$/);
  if (ko) {
    return createDateFromParts(ko[1], ko[2], ko[3]);
  }

  const normalized = text
    .replace(/\./g, "-")
    .replace(/\//g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/-$/, "")
    .trim();

  const dashedMonth = normalized.match(/^(\d{4})-(\d{1,2})(?:\s+.*)?$/);
  if (dashedMonth) {
    return createMonthStartDateFromParts(dashedMonth[1], dashedMonth[2]);
  }

  const dashed = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+.*)?$/);
  if (dashed) {
    return createDateFromParts(dashed[1], dashed[2], dashed[3]);
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : startOfDay(date);
}

function parseNumericDateValue(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;

  const text = String(Math.trunc(value));

  if (/^\d{6}$/.test(text)) {
    return createMonthStartDateFromParts(text.slice(0, 4), text.slice(4, 6));
  }

  if (/^\d{8}$/.test(text)) {
    return createDateFromParts(text.slice(0, 4), text.slice(4, 6), text.slice(6, 8));
  }

  return null;
}

function parseDisplayToDate(text) {
  return parseDateStringValue(String(text || ""));
}

function isSameDate(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return toISODateOnly(a) === toISODateOnly(b);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function updateValueHighlightState() {
  const startEl = qs("startText");
  const endEl = qs("endText");
  const settings = loadSettings();

  const shouldHighlight = (isCalendarOpen || isQuickOpen) && hasUserSelectionInCurrentOpen;

  if (startEl) {
    const startChanged = !isSameDate(pendingStartDate, originalStartDate);
    const showStartPending = settings.kind === "range";
    startEl.classList.toggle("pending", showStartPending && shouldHighlight && startChanged);
  }

  if (endEl) {
    const comparePendingEnd = settings.kind === "single" ? pendingStartDate : pendingEndDate;
    const compareOriginalEnd = settings.kind === "single" ? originalStartDate : originalEndDate;
    const endChanged = !isSameDate(comparePendingEnd, compareOriginalEnd);
    endEl.classList.toggle("pending", shouldHighlight && endChanged);
  }
}

function setValueTexts(startDisplay, endDisplay) {
  const startEl = qs("startText");
  const endEl = qs("endText");

  if (startEl) startEl.textContent = startDisplay || "-";
  if (endEl) endEl.textContent = endDisplay || "-";

  updateValueHighlightState();
}

function setDateTextsFromDates(settings, startDate, endDate) {
  if (settings.kind === "single") {
    setValueTexts(
      "",
      startDate ? formatDateForUI(startDate, settings.format) : "-"
    );
  } else {
    setValueTexts(
      startDate ? formatDateForUI(startDate, settings.format) : "-",
      endDate ? formatDateForUI(endDate, settings.format) : "-"
    );
  }
}

function numberToDateDisplay(n, format) {
  if (typeof n !== "number" || Number.isNaN(n)) return "";

  const numericDate = parseNumericDateValue(n);
  if (numericDate) return formatDateForUI(numericDate, format);

  if (n > 10_000_000_000) {
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? "" : formatDateForUI(d, format);
  }

  const base = new Date(Date.UTC(1899, 11, 30));
  const d = new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
  return Number.isNaN(d.getTime()) ? "" : formatDateForUI(d, format);
}

function tableauSerialNumberToDate(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return null;

  const numericDate = parseNumericDateValue(n);
  if (numericDate) return numericDate;

  if (n > 10_000_000_000) {
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : startOfDay(d);
  }

  const base = new Date(Date.UTC(1899, 11, 30));
  const d = new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
  return Number.isNaN(d.getTime()) ? null : startOfDay(d);
}

function getParamDateValue(p) {
  if (!p || !p.currentValue) return null;

  const cv = p.currentValue;
  const raw = (cv && typeof cv === "object" && "value" in cv) ? cv.value : cv;

  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return startOfDay(raw);
  }

  if (typeof raw === "string") {
    return parseDateStringValue(raw);
  }

  if (typeof raw === "number") {
    return tableauSerialNumberToDate(raw);
  }

  return null;
}

function getParamDisplay(p, format) {
  if (!p || !p.currentValue) return "";
  const cv = p.currentValue;
  const raw = (cv && typeof cv === "object" && "value" in cv) ? cv.value : cv;

  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return formatDateForUI(raw, format);
  }

  if (typeof raw === "string") {
    const parsedDate = parseDateStringValue(raw);
    if (parsedDate) return formatDateForUI(parsedDate, format);

    const n = Number(raw);
    if (!Number.isNaN(n)) return numberToDateDisplay(n, format);
  }

  if (typeof raw === "number") return numberToDateDisplay(raw, format);

  if (typeof cv.formattedValue === "string") {
    const fv = cv.formattedValue.trim();
    const formattedDate = parseDateStringValue(fv);
    if (formattedDate) return formatDateForUI(formattedDate, format);
  }

  return "";
}

function updateDateFieldLayout() {
  const settings = loadSettings();
  const rangeBar = qs("rangeBar");
  const startSlot = qs("startSlot");
  const endSlot = qs("endSlot");
  const startLabel = qs("startLabel");
  const endLabel = qs("endLabel");
  const sep = qs("dateSep");

  if (rangeBar) {
    rangeBar.classList.toggle("single-mode", settings.kind === "single");
  }

  const body = document.body;
  if (body) body.dataset.selectionKind = settings.kind;

  const frame = qs("appFrame");
  if (frame) frame.dataset.selectionKind = settings.kind;

  if (settings.kind === "single") {
    if (startSlot) startSlot.style.display = "none";
    if (sep) sep.style.display = "none";
    if (endSlot) endSlot.style.display = "flex";
    if (endLabel) endLabel.textContent = "조회";
    return;
  }

  if (startSlot) startSlot.style.display = "flex";
  if (sep) sep.style.display = activeLayoutProfileName === "compact" ? "none" : "";
  if (endSlot) endSlot.style.display = "flex";
  if (startLabel) startLabel.textContent = "시작";
  if (endLabel) endLabel.textContent = "종료";
}

function syncOpenStateClasses() {
  const body = document.body;
  if (!body) return;

  const panelKind = isConfigOpen
    ? "config"
    : isCalendarOpen
      ? "calendar"
      : isQuickOpen
        ? "quick"
        : "closed";

  body.classList.toggle("panel-open", panelKind !== "closed");
  body.dataset.panelKind = panelKind;

  const frame = qs("appFrame");
  if (frame) frame.dataset.panelKind = panelKind;
}

async function syncUIFromCurrentParameterValues(settings) {
  if (!settings.startParam) {
    pendingStartDate = null;
    pendingEndDate = null;
    originalStartDate = null;
    originalEndDate = null;
    hasUserSelectionInCurrentOpen = false;
    selectedQuickType = "";
    lastEditedEdge = "";
    setValueTexts("", "");
    updateQuickSelectionUI();
    updateActionStates();
    return;
  }

  const map = await getParametersMap();

  const pStart = map.get(settings.startParam);
  const startDate = getParamDateValue(pStart);
  const startDisplay = getParamDisplay(pStart, settings.format);

  let endDate = null;
  let endDisplay = "";

  if (settings.kind === "single") {
    endDate = startDate;
    endDisplay = startDisplay;
  } else {
    const pEnd = map.get(settings.endParam);
    endDate = getParamDateValue(pEnd);
    endDisplay = getParamDisplay(pEnd, settings.format);
  }

  pendingStartDate = cloneDate(startDate);
  pendingEndDate = cloneDate(endDate);

  originalStartDate = cloneDate(startDate);
  originalEndDate = cloneDate(endDate);

  hasUserSelectionInCurrentOpen = false;
  selectedQuickType = "";
  lastEditedEdge = "";

  if (settings.kind === "single") {
    setValueTexts(
      "",
      startDisplay || (startDate ? formatDateForUI(startDate, settings.format) : "")
    );
  } else {
    setValueTexts(
      startDisplay || (startDate ? formatDateForUI(startDate, settings.format) : ""),
      endDisplay || (endDate ? formatDateForUI(endDate, settings.format) : "")
    );
  }

  updateQuickSelectionUI();
  updateActionStates();
}

async function syncUIWithRetry(settings, tries = 8, delayMs = 250) {
  for (let i = 0; i < tries; i++) {
    await syncUIFromCurrentParameterValues(settings);

    const s = qs("startText")?.textContent?.trim();
    const e = qs("endText")?.textContent?.trim();

    const okStart = settings.kind === "single" ? true : (s && s !== "-");
    const okEnd = e && e !== "-";

    if (okStart && okEnd) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

function ensureFlatpickrLoaded() {
  if (typeof window.flatpickr === "undefined") {
    setHint("flatpickr 로드 실패");
    return false;
  }
  return true;
}

function destroyFP() {
  if (fp) {
    fp.destroy();
    fp = null;
  }
}

function closeConfigPanelUI() {
  isConfigOpen = false;
  const p = qs("cfgPanel");
  if (p) p.classList.remove("open");
  syncOpenStateClasses();
}

function openConfigPanelUI() {
  isConfigOpen = true;
  const p = qs("cfgPanel");
  if (p) p.classList.add("open");
  syncOpenStateClasses();
}

function closeCalendarUI() {
  isCalendarOpen = false;
  const h = qs("calHost");
  if (h) h.classList.remove("open");

  const settings = loadSettings();
  setDateTextsFromDates(
    settings,
    pendingStartDate,
    settings.kind === "single" ? pendingStartDate : pendingEndDate
  );

  updateValueHighlightState();
  updateActionStates();
  syncOpenStateClasses();
}

function openCalendarUI() {
  isCalendarOpen = true;
  const h = qs("calHost");
  if (h) h.classList.add("open");
  updateValueHighlightState();
  updateActionStates();
  syncOpenStateClasses();
}

function closeQuickPanelUI() {
  isQuickOpen = false;
  const h = qs("quickHost");
  if (h) h.classList.remove("open");
  updateValueHighlightState();
  updateActionStates();
  syncOpenStateClasses();
}

function openQuickPanelUI() {
  isQuickOpen = true;
  const h = qs("quickHost");
  if (h) h.classList.add("open");
  updateValueHighlightState();
  updateActionStates();
  syncOpenStateClasses();
}

function getKoLocale() {
  return {
    weekdays: {
      shorthand: ["일", "월", "화", "수", "목", "금", "토"],
      longhand: ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"]
    },
    months: {
      shorthand: ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"],
      longhand: ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"]
    },
    firstDayOfWeek: 0,
    rangeSeparator: " ~ ",
    scrollTitle: "스크롤하여 증가",
    toggleTitle: "클릭하여 전환",
    time_24hr: true
  };
}

function applyMonthHeaderPatch(instance) {
  const calendar = instance?.calendarContainer;
  if (!calendar) return;

  const monthsWrap = calendar.querySelector(".flatpickr-months");
  const currentMonth = calendar.querySelector(".flatpickr-current-month");
  const prevBtn = calendar.querySelector(".flatpickr-prev-month");
  const nextBtn = calendar.querySelector(".flatpickr-next-month");
  const yearWrap = currentMonth?.querySelector(".numInputWrapper");
  const monthSelect = currentMonth?.querySelector(".flatpickr-monthDropdown-months");

  if (currentMonth && yearWrap && monthSelect) {
    currentMonth.appendChild(yearWrap);
    currentMonth.appendChild(monthSelect);
  }

  if (monthsWrap && prevBtn && nextBtn && currentMonth) {
    monthsWrap.innerHTML = "";
    monthsWrap.appendChild(prevBtn);
    monthsWrap.appendChild(currentMonth);
    monthsWrap.appendChild(nextBtn);
  }
}

function getCurrentSingleModeDate() {
  if (calendarMode === "start") return pendingStartDate;
  if (calendarMode === "end") return pendingEndDate;
  return null;
}

function getOriginalSingleModeDate() {
  if (calendarMode === "start") return originalStartDate;
  if (calendarMode === "end") return originalEndDate;
  return null;
}

function canCloseCalendarOnSameDateClick(dateObj) {
  if (!isCalendarOpen) return false;
  if (calendarMode !== "start" && calendarMode !== "end") return false;

  const currentDate = getCurrentSingleModeDate();
  const appliedDate = getOriginalSingleModeDate();

  if (!dateObj || !currentDate || !appliedDate) return false;

  return (
    isSameDate(dateObj, currentDate) &&
    isSameDate(currentDate, appliedDate)
  );
}

function initFlatpickr(settings) {
  destroyFP();
  if (!ensureFlatpickrLoaded()) return;

  const input = qs("fpHidden");
  const host = qs("calHost");
  if (!input || !host) {
    setHint("fpHidden 또는 calHost가 없습니다.");
    return;
  }

  host.innerHTML = "";

  const fpMode = calendarMode === "range" ? "range" : "single";

  fp = flatpickr(input, {
    mode: fpMode,
    dateFormat: settings.format || DEFAULTS.format,
    allowInput: false,
    clickOpens: false,
    inline: true,
    appendTo: host,
    locale: getKoLocale(),
    monthSelectorType: "static",
    prevArrow: "<",
    nextArrow: ">",

    onReady: (selectedDates, dateStr, instance) => {
      applyMonthHeaderPatch(instance);
    },

    onMonthChange: (selectedDates, dateStr, instance) => {
      applyMonthHeaderPatch(instance);
    },

    onYearChange: (selectedDates, dateStr, instance) => {
      applyMonthHeaderPatch(instance);
    },

    onOpen: () => setHint(""),

    onChange: (selectedDates) => {
      hasUserSelectionInCurrentOpen = true;
      selectedQuickType = "";
      updateQuickSelectionUI();

      const settingsNow = loadSettings();

      if (calendarMode === "start") {
        const picked = selectedDates[0] || null;
        if (!picked) return;
        pendingStartDate = picked;
        lastEditedEdge = "start";
      } else if (calendarMode === "end") {
        const picked = selectedDates[0] || null;
        if (!picked) return;
        pendingEndDate = picked;
        lastEditedEdge = "end";
      } else {
        const start = selectedDates[0] || null;
        const end = selectedDates[1] || null;

        pendingStartDate = start;
        pendingEndDate = end || null;
        lastEditedEdge = "range";
      }

      setDateTextsFromDates(
        settingsNow,
        pendingStartDate,
        settingsNow.kind === "single" ? pendingStartDate : pendingEndDate
      );

      updateActionStates();
    },

    onDayCreate: (dObj, dStr, instance, dayElem) => {
      const dateObj = dayElem.dateObj;
      if (!dateObj) return;

      if (canCloseCalendarOnSameDateClick(dateObj)) {
        dayElem.classList.add("same-date-close");
        dayElem.title = "현재 적용된 날짜입니다. 다시 누르면 달력이 닫힙니다.";
      }

      dayElem.addEventListener("mousedown", (e) => {
        if (!canCloseCalendarOnSameDateClick(dateObj)) return;

        e.preventDefault();
        e.stopPropagation();
        closeCalendarUI();
        setHint("");
      });
    }
  });

  closeCalendarUI();
}

async function applyDatesToParameters(settings, start, end) {
  const { kind, startParam, endParam } = settings;

  if (!startParam) throw new Error("시작 파라미터가 설정되지 않았습니다.");
  if (kind === "range" && !endParam) throw new Error("종료 파라미터가 설정되지 않았습니다.");
  if (!start) throw new Error("시작날짜를 선택하세요.");
  if (kind === "range" && !end) throw new Error("종료날짜를 선택하세요.");

  const map = await getParametersMap();

  const pStart = map.get(startParam);
  if (!pStart) throw new Error(`파라미터를 찾을 수 없습니다: ${startParam}`);
  await pStart.changeValueAsync(toISODateOnly(start));

  if (kind === "range") {
    const pEnd = map.get(endParam);
    if (!pEnd) throw new Error(`파라미터를 찾을 수 없습니다: ${endParam}`);
    await pEnd.changeValueAsync(toISODateOnly(end));
  }
}

function isSinglePickingMode() {
  return isCalendarOpen && (calendarMode === "start" || calendarMode === "end");
}

function isRangePickingMode() {
  return isCalendarOpen && calendarMode === "range";
}

function isQuickPickingMode() {
  return isQuickOpen;
}

function isDateEditingState() {
  return isCalendarOpen || isQuickOpen;
}

function canEnableRangeMode(settings) {
  if (settings.kind !== "range") return false;
  return !isSinglePickingMode() && !isQuickPickingMode();
}

function canEnableQuickMode() {
  return !isSinglePickingMode() && !isRangePickingMode();
}

function hasPendingChange(settings) {
  const comparePendingEnd = settings.kind === "single" ? pendingStartDate : pendingEndDate;
  const compareOriginalEnd = settings.kind === "single" ? originalStartDate : originalEndDate;

  return (
    !isSameDate(pendingStartDate, originalStartDate) ||
    !isSameDate(comparePendingEnd, compareOriginalEnd)
  );
}

function canEnableApply(settings) {
  if (isApplying) return false;
  if (!isDateEditingState()) return false;
  if (!pendingStartDate) return false;
  if (settings.kind === "range" && !pendingEndDate) return false;
  if (!hasPendingChange(settings)) return false;
  return true;
}

function updatePrimaryModeButton() {
  const settings = loadSettings();
  const btn = qs("rangeModeBtn");
  if (!btn) return;

  if (settings.kind === "single") {
    btn.style.display = "none";
    btn.disabled = true;
    return;
  }

  btn.style.display = "";

  const isRangeOpen = isRangePickingMode();
  btn.textContent = "기간";

  const enabled = !isApplying && (isRangeOpen || canEnableRangeMode(settings));
  btn.disabled = !enabled;

  btn.classList.remove("btn-range-active", "btn-range-inactive", "btn-range-cancel");
  if (enabled) {
    btn.classList.add("btn-range-active");
  } else {
    btn.classList.add("btn-range-inactive");
  }
}

function updateQuickModeButton() {
  const btn = qs("quickModeBtn");
  if (!btn) return;

  const isOpen = isQuickPickingMode();
  btn.textContent = "빠른선택";

  const enabled = !isApplying && (isOpen || canEnableQuickMode());
  btn.disabled = !enabled;

  btn.classList.remove("btn-quick-active", "btn-quick-inactive", "btn-quick-cancel");
  if (enabled) {
    btn.classList.add("btn-quick-active");
  } else {
    btn.classList.add("btn-quick-inactive");
  }
}

function updateApplyButton() {
  const settings = loadSettings();
  const btn = qs("applyBtn");
  if (!btn) return;

  const enabled = canEnableApply(settings);
  btn.disabled = !enabled;
  btn.textContent = "적용";

  btn.classList.remove("btn-primary-active", "btn-primary-inactive", "loading");
  if (isApplying) {
    btn.classList.add("btn-primary-active", "loading");
  } else if (enabled) {
    btn.classList.add("btn-primary-active");
  } else {
    btn.classList.add("btn-primary-inactive");
  }
}

function updateClosePanelButton() {
  const btn = qs("closePanelBtn");
  if (!btn) return;

  const visible = isCalendarOpen || isQuickOpen;
  btn.textContent = "닫기";
  btn.style.display = "inline-flex";
  btn.classList.toggle("layout-hidden", !visible);
  btn.disabled = isApplying || !visible;
}

function updateActionStates() {
  updatePrimaryModeButton();
  updateQuickModeButton();
  updateApplyButton();
  updateClosePanelButton();
}

function restorePendingToOriginal(settings) {
  pendingStartDate = cloneDate(originalStartDate);
  pendingEndDate = settings.kind === "single" ? cloneDate(originalStartDate) : cloneDate(originalEndDate);
  selectedQuickType = "";
  hasUserSelectionInCurrentOpen = false;
  lastEditedEdge = "";

  setDateTextsFromDates(
    settings,
    pendingStartDate,
    settings.kind === "single" ? pendingStartDate : pendingEndDate
  );

  updateQuickSelectionUI();
}

function openCalendarFor(mode) {
  if (isConfigOpen || isApplying) return;

  calendarMode = mode;
  const settings = loadSettings();

  closeQuickPanelUI();
  initFlatpickr(settings);

  openCalendarUI();

  hasUserSelectionInCurrentOpen = false;
  selectedQuickType = "";
  updateQuickSelectionUI();

  if (!fp) return;

  if (mode === "start" && pendingStartDate) {
    fp.setDate(pendingStartDate, false);
  } else if (mode === "end" && pendingEndDate) {
    fp.setDate(pendingEndDate, false);
  } else if (mode === "range" && pendingStartDate && pendingEndDate) {
    fp.setDate([pendingStartDate, pendingEndDate], false);
  } else if (mode === "range" && pendingStartDate) {
    fp.setDate([pendingStartDate], false);
  } else {
    fp.clear();
  }

  updateValueHighlightState();
  updateActionStates();
}

function cancelRangeSelection() {
  const settings = loadSettings();
  restorePendingToOriginal(settings);
  closeCalendarUI();
  setHint("");
}

function cancelQuickSelection() {
  const settings = loadSettings();
  restorePendingToOriginal(settings);
  closeQuickPanelUI();
  setHint("");
}

function getDateRangeError(settings) {
  if (!pendingStartDate) {
    return settings.kind === "single" ? "조회날짜를 선택하세요." : "시작날짜를 선택하세요.";
  }

  const finalEnd = settings.kind === "single" ? pendingStartDate : pendingEndDate;

  if (settings.kind === "range" && !finalEnd) {
    return "종료날짜를 선택하세요.";
  }

  if (
    settings.kind === "range" &&
    pendingStartDate &&
    finalEnd &&
    pendingStartDate > finalEnd
  ) {
    if (lastEditedEdge === "end") {
      return "종료날짜는 시작날짜 이전으로 선택할 수 없습니다.";
    }

    if (lastEditedEdge === "start") {
      return "시작날짜는 종료날짜 이후로 선택할 수 없습니다.";
    }

    return "시작날짜와 종료날짜를 다시 확인하세요.";
  }

  return "";
}

async function applyPendingDates() {
  const settings = loadSettings();

  if (!isDateEditingState() || isApplying) return;

  const err = getDateRangeError(settings);
  if (err) {
    showToast(err);
    updateActionStates();
    return;
  }

  const finalEnd = settings.kind === "single" ? pendingStartDate : pendingEndDate;

  try {
    isApplying = true;
    showToast("조회조건 적용 중...");
    updateActionStates();

    await applyDatesToParameters(settings, pendingStartDate, finalEnd);

    closeCalendarUI();
    closeQuickPanelUI();
    await syncUIWithRetry(settings, 4, 150);

    setHint("");
  } catch (e) {
    const msg = e?.message || String(e);
    showToast(msg);
  } finally {
    isApplying = false;
    updateActionStates();
  }
}

/* ===== 퀵 선택 ===== */
function getTodayRange() {
  const today = startOfDay(new Date());
  return { start: today, end: today };
}

function getYesterdayRange() {
  const today = startOfDay(new Date());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return { start: startOfDay(yesterday), end: startOfDay(yesterday) };
}

function getPreviousMonthRange() {
  const today = startOfDay(new Date());
  const prevMonthLastDay = new Date(today.getFullYear(), today.getMonth(), 0);
  const picked = startOfDay(prevMonthLastDay);
  return { start: picked, end: picked };
}

function getThisWeekRange() {
  const today = startOfDay(new Date());
  const day = today.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const start = new Date(today);
  start.setDate(today.getDate() + diffToMonday);

  return { start: startOfDay(start), end: today };
}

function getThisMonthRange() {
  const today = startOfDay(new Date());
  const start = new Date(today.getFullYear(), today.getMonth(), 1);
  return { start: startOfDay(start), end: today };
}

function getYtdRange() {
  const today = startOfDay(new Date());
  const start = new Date(today.getFullYear(), 0, 1);
  return { start: startOfDay(start), end: today };
}

function getTodayDate() {
  return startOfDay(new Date());
}

function getSameMonthDayInYear(baseDate, targetYear) {
  const base = startOfDay(baseDate);
  const month = base.getMonth();
  const day = base.getDate();
  const lastDay = new Date(targetYear, month + 1, 0).getDate();
  return startOfDay(new Date(targetYear, month, Math.min(day, lastDay)));
}

function getYearToTodayRange() {
  const today = getTodayDate();
  const start = new Date(today.getFullYear(), 0, 1);
  return { start: startOfDay(start), end: today };
}

function getLastMonthFullRange() {
  const today = getTodayDate();
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth(), 0);
  return { start: startOfDay(start), end: startOfDay(end) };
}

function getLastYearSameMonthRange() {
  const today = getTodayDate();
  const year = today.getFullYear() - 1;
  const month = today.getMonth();
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  return { start: startOfDay(start), end: startOfDay(end) };
}

function getLastYearFullRange() {
  const today = getTodayDate();
  const year = today.getFullYear() - 1;
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  return { start: startOfDay(start), end: startOfDay(end) };
}

function getQuarterRange(quarter) {
  const today = getTodayDate();
  const year = today.getFullYear();
  const startMonth = (quarter - 1) * 3;
  const start = new Date(year, startMonth, 1);
  const end = new Date(year, startMonth + 3, 0);
  return { start: startOfDay(start), end: startOfDay(end) };
}

function getQuickRange(settings, type) {
  if (settings.kind === "single") {
    switch (type) {
      case "today":
        return getTodayRange();
      case "yesterday":
        return getYesterdayRange();
      case "thisMonth":
        return getPreviousMonthRange();
      default:
        return null;
    }
  }

  switch (type) {
    case "today":
      return getTodayRange();
    case "yesterday":
      return getYesterdayRange();
    case "thisWeek":
      return getThisWeekRange();
    case "thisMonth":
      return getThisMonthRange();
    case "ytd":
      return getYearToTodayRange();
    case "lastMonth":
      return getLastMonthFullRange();
    case "lastYearSameMonth":
      return getLastYearSameMonthRange();
    case "lastYear":
      return getLastYearFullRange();
    case "q1":
      return getQuarterRange(1);
    case "q2":
      return getQuarterRange(2);
    case "q3":
      return getQuarterRange(3);
    case "q4":
      return getQuarterRange(4);
    default:
      return null;
  }
}

async function applyQuickSelection(type) {
  if (isApplying || isConfigOpen || !isQuickOpen) return;

  const settings = loadSettings();
  const range = getQuickRange(settings, type);
  if (!range) return;

  hasUserSelectionInCurrentOpen = true;
  selectedQuickType = type;
  lastEditedEdge = "quick";

  pendingStartDate = cloneDate(range.start);
  pendingEndDate = settings.kind === "single"
    ? cloneDate(range.start)
    : cloneDate(range.end);

  setDateTextsFromDates(
    settings,
    pendingStartDate,
    settings.kind === "single" ? pendingStartDate : pendingEndDate
  );

  setHint("");
  updateQuickSelectionUI();
  updateActionStates();

  if (!hasPendingChange(settings)) {
    closeQuickPanelUI();
    hasUserSelectionInCurrentOpen = false;
    selectedQuickType = "";
    updateQuickSelectionUI();
    updateValueHighlightState();
    updateActionStates();
    return;
  }

  await applyPendingDates();
}

function updateQuickSelectionUI() {
  const quickBtns = document.querySelectorAll(".quickBtn");
  quickBtns.forEach((btn) => {
    const type = btn.getAttribute("data-quick");
    btn.classList.toggle("selected", type === selectedQuickType);
  });
}

function updateQuickGroupVisibility() {
  const groups = document.querySelectorAll("[data-quick-group]");
  groups.forEach((group) => {
    const buttons = Array.from(group.querySelectorAll(".quickBtn"));
    const hasVisibleButton = buttons.some((btn) => btn.style.display !== "none");
    group.style.display = hasVisibleButton ? "" : "none";
  });
}

/* ===== 설정 패널 ===== */
function detectType(p) {
  return (p?.dataType || p?.parameterType || p?.type || "").toString();
}

function isDateLike(p) {
  const t = detectType(p).toLowerCase();
  if (!t) return false;
  return t.includes("date");
}

function fillSelect(selectEl, items, selectedValue) {
  selectEl.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "선택";
  selectEl.appendChild(empty);

  items.forEach((it) => {
    const opt = document.createElement("option");
    opt.value = it.name;
    opt.textContent = it.label;
    selectEl.appendChild(opt);
  });

  if (selectedValue) selectEl.value = selectedValue;
}

async function loadDateParameterItems() {
  const dash = await getDashboard();
  const params = await dash.getParametersAsync();

  return params
    .filter(isDateLike)
    .map((p) => {
      const t = detectType(p);
      return { name: p.name, label: t ? `${p.name} (${t})` : p.name };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function hydrateConfigPanel(settings) {
  const dash = await getDashboard();
  const dashNameEl = qs("cfgDashName");
  if (dashNameEl) dashNameEl.textContent = dash?.name || "-";

  const items = await loadDateParameterItems();
  setCfgHint(items.length ? "" : "날짜/시간 타입 파라미터를 찾지 못했습니다.");

  const kindSel = qs("kind");
  const startSel = qs("startParam");
  const endSel = qs("endParam");
  const formatInput = qs("format");
  const rowEnd = qs("rowEnd");

  if (kindSel) kindSel.value = settings.kind;
  if (formatInput) formatInput.value = normalizeDisplayFormat(settings.format);

  if (startSel) fillSelect(startSel, items, settings.startParam);
  if (endSel) fillSelect(endSel, items, settings.endParam);

  if (rowEnd) rowEnd.style.display = settings.kind === "single" ? "none" : "";

  if (kindSel) {
    kindSel.onchange = () => {
      const v = kindSel.value;
      if (rowEnd) rowEnd.style.display = v === "single" ? "none" : "";
    };
  }
}

async function saveConfigFromPanel() {
  try {
    setCfgHint("");

    const kindSel = qs("kind");
    const startSel = qs("startParam");
    const endSel = qs("endParam");
    const formatInput = qs("format");

    const kind = (kindSel ? kindSel.value : DEFAULTS.kind) || DEFAULTS.kind;
    const startParam = startSel ? startSel.value : "";
    const endParam = endSel ? endSel.value : "";
    const format = normalizeDisplayFormat(formatInput ? formatInput.value : DEFAULTS.format);

    if (!startParam) throw new Error("시작 파라미터를 선택하세요.");
    if (kind === "range" && !endParam) throw new Error("종료 파라미터를 선택하세요.");

    const s = getExtensionsApi()?.settings;
    if (!s) throw new Error("settings API를 사용할 수 없습니다.");
    s.set(SETTINGS_KEYS.kind, kind);
    s.set(SETTINGS_KEYS.startParam, startParam);
    s.set(SETTINGS_KEYS.endParam, kind === "single" ? "" : endParam);
    s.set(SETTINGS_KEYS.format, format);
    await s.saveAsync();

    closeConfigPanelUI();
    setCfgHint("");
    await render();
  } catch (e) {
    setCfgHint(e?.message || String(e));
  }
}

async function toggleConfigPanel() {
  if (!isAuthoringMode() || isApplying) return;

  if (isConfigOpen) {
    closeConfigPanelUI();
    setHint("");
  } else {
    closeCalendarUI();
    closeQuickPanelUI();
    openConfigPanelUI();
    const settings = loadSettings();
    await hydrateConfigPanel(settings);
  }
}

async function bindParameterChangedListeners(settings) {
  unregisterParamHandlers.forEach((fn) => {
    try { fn(); } catch (_) {}
  });
  unregisterParamHandlers = [];

  if (!settings.startParam) return;

  const api = getTableauApi();
  const dash = await getDashboard();
  const params = await dash.getParametersAsync();

  const targets = new Set([settings.startParam]);
  if (settings.kind === "range" && settings.endParam) targets.add(settings.endParam);

  params.forEach((p) => {
    if (!targets.has(p.name)) return;

    const unregister = p.addEventListener(
      api.TableauEventType.ParameterChanged,
      async () => {
        const s = loadSettings();
        await syncUIWithRetry(s, 6, 200);
      }
    );

    unregisterParamHandlers.push(unregister);
  });
}

function bindHandlers() {
  const startText = qs("startText");
  const endText = qs("endText");
  const rangeModeBtn = qs("rangeModeBtn");
  const quickModeBtn = qs("quickModeBtn");
  const applyBtn = qs("applyBtn");
  const closePanelBtn = qs("closePanelBtn");
  const settingsBtn = qs("settingsBtn");
  const cfgCloseBtn = qs("cfgCloseBtn");
  const cfgSaveBtn = qs("cfgSaveBtn");
  const cfgPanel = qs("cfgPanel");
  const calHost = qs("calHost");
  const quickHost = qs("quickHost");
  const quickBtns = document.querySelectorAll(".quickBtn");

  if (startText) {
    startText.onclick = (e) => {
      e.stopPropagation();
      const settings = loadSettings();
      if (settings.kind === "single") return;
      openCalendarFor("start");
    };
  }

  if (endText) {
    endText.onclick = (e) => {
      e.stopPropagation();
      const settings = loadSettings();

      if (settings.kind === "single") {
        openCalendarFor("start");
        return;
      }

      openCalendarFor("end");
    };
  }

  if (rangeModeBtn) {
    rangeModeBtn.onclick = (e) => {
      e.stopPropagation();

      if (isApplying) return;

      const settings = loadSettings();
      if (!canEnableRangeMode(settings)) return;
      if (isRangePickingMode()) return;
      openCalendarFor("range");
    };
  }

  if (quickModeBtn) {
    quickModeBtn.onclick = (e) => {
      e.stopPropagation();

      if (isApplying) return;

      if (!canEnableQuickMode()) return;
      if (isQuickPickingMode()) return;

      closeCalendarUI();
      openQuickPanelUI();
      hasUserSelectionInCurrentOpen = false;
      selectedQuickType = "";
      updateQuickSelectionUI();
      updateActionStates();
    };
  }

  quickBtns.forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const type = btn.getAttribute("data-quick");
      await applyQuickSelection(type);
    };
  });

  if (applyBtn) {
    applyBtn.onclick = async (e) => {
      e.stopPropagation();
      const settings = loadSettings();
      if (!canEnableApply(settings) && !isApplying) return;
      await applyPendingDates();
    };
  }

  if (closePanelBtn) {
    closePanelBtn.onclick = (e) => {
      e.stopPropagation();
      if (isQuickPickingMode()) {
        cancelQuickSelection();
        return;
      }
      if (isDateEditingState()) {
        cancelRangeSelection();
      }
    };
  }

  if (settingsBtn) {
    settingsBtn.onclick = async (e) => {
      e.stopPropagation();
      await toggleConfigPanel();
    };
  }

  if (cfgPanel) {
    cfgPanel.onclick = (e) => e.stopPropagation();
    cfgPanel.onmousedown = (e) => e.stopPropagation();
  }

  if (calHost) {
    calHost.onclick = (e) => e.stopPropagation();
    calHost.onmousedown = (e) => e.stopPropagation();
  }

  if (quickHost) {
    quickHost.onclick = (e) => e.stopPropagation();
    quickHost.onmousedown = (e) => e.stopPropagation();
  }

  if (cfgCloseBtn) cfgCloseBtn.onclick = async () => { closeConfigPanelUI(); };
  if (cfgSaveBtn) cfgSaveBtn.onclick = async () => { await saveConfigFromPanel(); };
}

function updateQuickPanelVisibility() {
  const settings = loadSettings();
  const todayBtn = document.querySelector('[data-quick="today"]');
  const yesterdayBtn = document.querySelector('[data-quick="yesterday"]');
  const weekBtn = document.querySelector('[data-quick="thisWeek"]');
  const monthBtn = document.querySelector('[data-quick="thisMonth"]');
  const ytdBtn = document.querySelector('[data-quick="ytd"]');
  const lastMonthBtn = document.querySelector('[data-quick="lastMonth"]');
  const lastYearSameMonthBtn = document.querySelector('[data-quick="lastYearSameMonth"]');
  const lastYearBtn = document.querySelector('[data-quick="lastYear"]');
  const q1Btn = document.querySelector('[data-quick="q1"]');
  const q2Btn = document.querySelector('[data-quick="q2"]');
  const q3Btn = document.querySelector('[data-quick="q3"]');
  const q4Btn = document.querySelector('[data-quick="q4"]');

  if (settings.kind === "single") {
    if (todayBtn) todayBtn.textContent = "오늘";
    if (yesterdayBtn) {
      yesterdayBtn.textContent = "어제";
      yesterdayBtn.style.display = "";
    }
    if (monthBtn) {
      monthBtn.textContent = "전월 말일";
      monthBtn.style.display = "";
    }
    if (weekBtn) weekBtn.style.display = "none";
    if (ytdBtn) ytdBtn.style.display = "none";
    if (lastMonthBtn) lastMonthBtn.style.display = "none";
    if (lastYearSameMonthBtn) lastYearSameMonthBtn.style.display = "none";
    if (lastYearBtn) lastYearBtn.style.display = "none";
    if (q1Btn) q1Btn.style.display = "none";
    if (q2Btn) q2Btn.style.display = "none";
    if (q3Btn) q3Btn.style.display = "none";
    if (q4Btn) q4Btn.style.display = "none";
    updateQuickGroupVisibility();
    return;
  } else {
    if (todayBtn) todayBtn.textContent = "오늘";
    if (yesterdayBtn) {
      yesterdayBtn.textContent = "어제";
      yesterdayBtn.style.display = "";
    }
    if (monthBtn) {
      monthBtn.textContent = "당월 누계";
      monthBtn.style.display = "";
    }
    if (weekBtn) {
      weekBtn.textContent = "금주 누계";
      weekBtn.style.display = "";
    }
    if (ytdBtn) {
      ytdBtn.textContent = "금년 누계";
      ytdBtn.style.display = "";
    }
    if (lastMonthBtn) {
      lastMonthBtn.textContent = "전월 전체";
      lastMonthBtn.style.display = "";
    }
    if (lastYearSameMonthBtn) {
      lastYearSameMonthBtn.textContent = "전년 동월";
      lastYearSameMonthBtn.style.display = "";
    }
    if (lastYearBtn) {
      lastYearBtn.textContent = "전년 누계";
      lastYearBtn.style.display = "";
    }
    if (q1Btn) q1Btn.style.display = "";
    if (q2Btn) q2Btn.style.display = "";
    if (q3Btn) q3Btn.style.display = "";
    if (q4Btn) q4Btn.style.display = "";
  }

  updateQuickGroupVisibility();
}

function isCompactProfile() {
  return activeLayoutProfileName === "compact";
}

async function render() {
  await syncLayoutProfile();

  const settings = loadSettings();

  const settingsBtn = qs("settingsBtn");
  if (settingsBtn) settingsBtn.style.display = isAuthoringMode() ? "inline-flex" : "none";

  if (!isAuthoringMode()) closeConfigPanelUI();

  if (!settings.startParam || (settings.kind === "range" && !settings.endParam)) {
    setHint(isAuthoringMode() ? "⚙ 설정에서 파라미터를 매핑하세요." : "조회기간 설정이 아직 완료되지 않았습니다.");
    pendingStartDate = null;
    pendingEndDate = null;
    originalStartDate = null;
    originalEndDate = null;
    hasUserSelectionInCurrentOpen = false;
    selectedQuickType = "";
    lastEditedEdge = "";
    setValueTexts("", "");
    updateQuickSelectionUI();
    updateActionStates();
  } else {
    setHint("");
  }

  initFlatpickr(settings);
  bindHandlers();
  updateDateFieldLayout();
  updateQuickPanelVisibility();
  await bindParameterChangedListeners(settings);

  if (settings.startParam) {
    await syncUIWithRetry(settings);
  } else {
    updateActionStates();
  }
}

async function init() {
  activeTableauApi = getTableauApi();

  if (shouldStartInMockMode()) {
    enableMockRuntime("forced by browser preview");
  } else {
    try {
      await getExtensionsApi().initializeAsync();
      isMockRuntime = false;
      setPersistentHint("");
      applyRuntimeModeState();
    } catch (e) {
      enableMockRuntime(e?.message || String(e));
    }
  }

  const api = getTableauApi();
  const dashboard = await getDashboard();
  unregisterDashboardLayoutListener = dashboard.addEventListener(
    api.TableauEventType.DashboardLayoutChanged,
    async () => { requestLayoutSync(); }
  );

  window.addEventListener("resize", requestLayoutSync);

  getExtensionsApi().settings.addEventListener(
    api.TableauEventType.SettingsChanged,
    async () => { await render(); }
  );

  await render();
}

init().catch((e) => {
  console.error(e);
  setHint(e?.message || String(e));
});
