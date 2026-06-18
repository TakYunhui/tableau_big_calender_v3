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

const LAYOUT_PROFILE_BY_NAME = {
  wide: {
    frameWidth: 420,
    frameHeight: 150,
    rangeBarHeight: 48,
    quickPanelMinHeight: 102,
    calendarHeight: 102,
    configPanelHeight: 150,
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

function qs(id) {
  return document.getElementById(id);
}

function setHint(msg) {
  const el = qs("hint");
  if (el) el.textContent = msg || "";
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
  return tableau?.extensions?.environment?.mode === "authoring";
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
  const s = tableau.extensions.settings;
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

async function getExtensionLayoutMetrics() {
  const dashboard = await getDashboard();
  const dashboardSize = dashboard?.size || null;
  const dashboardObjectId = tableau?.extensions?.dashboardObjectId;
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
  return tableau.extensions.dashboardContent.dashboard;
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

  if (settings.kind === "single") {
    if (startSlot) startSlot.style.display = "none";
    if (sep) sep.style.display = "none";
    if (endSlot) endSlot.style.display = "flex";
    if (endLabel) endLabel.textContent = "기준";
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
  btn.style.display = visible ? "inline-flex" : "none";
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
    showToast("조회기간 적용 중입니다...");
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
      return getYtdRange();
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

    const s = tableau.extensions.settings;
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

  const dash = await getDashboard();
  const params = await dash.getParametersAsync();

  const targets = new Set([settings.startParam]);
  if (settings.kind === "range" && settings.endParam) targets.add(settings.endParam);

  params.forEach((p) => {
    if (!targets.has(p.name)) return;

    const unregister = p.addEventListener(
      tableau.TableauEventType.ParameterChanged,
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
  const isCompact = isCompactProfile();
  const todayBtn = document.querySelector('[data-quick="today"]');
  const yesterdayBtn = document.querySelector('[data-quick="yesterday"]');
  const weekBtn = document.querySelector('[data-quick="thisWeek"]');
  const monthBtn = document.querySelector('[data-quick="thisMonth"]');
  const ytdBtn = document.querySelector('[data-quick="ytd"]');

  if (settings.kind === "single") {
    if (todayBtn) todayBtn.textContent = "오늘";
    if (yesterdayBtn) {
      yesterdayBtn.textContent = "어제";
      yesterdayBtn.style.display = "";
    }
    if (monthBtn) {
      monthBtn.textContent = "전월 말";
      monthBtn.style.display = "";
    }
    if (weekBtn) weekBtn.style.display = "none";
    if (ytdBtn) ytdBtn.style.display = "none";
    return;
  } else {
    if (todayBtn) todayBtn.textContent = "오늘";
    if (yesterdayBtn) {
      yesterdayBtn.textContent = "어제";
      yesterdayBtn.style.display = "";
    }
    if (monthBtn) {
      monthBtn.textContent = "이번달";
      monthBtn.style.display = "";
    }
    if (weekBtn) weekBtn.style.display = isCompact ? "none" : "";
    if (ytdBtn) ytdBtn.style.display = isCompact ? "none" : "";
  }
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
  await tableau.extensions.initializeAsync();

  const dashboard = await getDashboard();
  unregisterDashboardLayoutListener = dashboard.addEventListener(
    tableau.TableauEventType.DashboardLayoutChanged,
    async () => { requestLayoutSync(); }
  );

  window.addEventListener("resize", requestLayoutSync);

  tableau.extensions.settings.addEventListener(
    tableau.TableauEventType.SettingsChanged,
    async () => { await render(); }
  );

  await render();
}

init().catch((e) => {
  console.error(e);
  setHint(e?.message || String(e));
});
