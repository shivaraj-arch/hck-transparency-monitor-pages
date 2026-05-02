/* Dashboard app.js
 * Loads causelist.json + eod_report.json from public/data/<date>/
 * plus a compact multi-day index from public/data/index.json.
 * Renders charts and tables. Fully deterministic, no LLM calls.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const TODAY = new Date().toISOString().slice(0, 10);
const THEME_STORAGE_KEY = "hck-theme";
const CALENDAR_2026 = {
  year: 2026,
  generalHolidays: [
    "2026-01-15", "2026-01-26", "2026-03-19", "2026-03-21", "2026-03-31",
    "2026-04-03", "2026-04-14", "2026-04-20", "2026-05-01", "2026-05-28",
    "2026-06-26", "2026-08-15", "2026-08-26", "2026-09-14", "2026-10-02",
    "2026-10-20", "2026-10-21", "2026-11-10", "2026-11-27", "2026-12-25",
  ],
  extraHighCourtHolidays: [
    "2026-01-01", "2026-01-02", "2026-01-16", "2026-03-20", "2026-03-30",
    "2026-04-13", "2026-08-21", "2026-09-04", "2026-11-09",
  ],
  restrictedHolidays: [
    "2026-01-27", "2026-02-04", "2026-03-02", "2026-03-17", "2026-03-20",
    "2026-03-23", "2026-03-27", "2026-04-04", "2026-04-21", "2026-04-22",
    "2026-08-21", "2026-08-27", "2026-08-28", "2026-09-04", "2026-09-08",
    "2026-09-17", "2026-09-25", "2026-11-24", "2026-11-26", "2026-12-24",
  ],
  vacations: [
    ["2026-05-04", "2026-05-30"],
    ["2026-10-19", "2026-10-24"],
    ["2026-12-21", "2026-12-31"],
  ],
  highCourtSittingDays: [
    "2026-01-31", "2026-02-21", "2026-04-18", "2026-04-25",
    "2026-08-29", "2026-09-19", "2026-11-21",
  ],
};

// ── State ──
let causelistData = null;
let eodData = null;
let historyIndex = [];
let allCases = []; // flattened
let currentDate = TODAY;
let currentTab = "overview"; // Track current tab
let charts = {};
let courtCalendarDays = buildCourtCalendarDays();
let courtCalendarIndex = new Map(courtCalendarDays.map((day) => [day.date, day]));
let publishedDates = new Set();

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  setupThemeToggle();
  populateDateSelect();
  updateDateHeader();
  setupDonateModal();
  $("#dateSelect").addEventListener("change", (e) => {
    currentDate = e.target.value;
    updateDateHeader();
    loadData();
  });

  // Tab switching
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      currentTab = tab; // Track current tab
      $$("[id^='tab-']").forEach((s) => (s.style.display = "none"));
      $(`#tab-${tab}`).style.display = "";
      renderTab(tab);
    });
  });

  // Search/filter
  $("#caseSearch")?.addEventListener("input", renderCasesTable);
  $("#caseFilter")?.addEventListener("change", renderCasesTable);
  $("#hallFilter")?.addEventListener("change", renderCasesTable);

  loadData();
});

async function loadData() {
  const base = `data/${currentDate}`;
  const log = (msg) => console.log(msg);
  
  try {
    log(`⏳ Loading ${base}/causelist.json ...`);
    const clResp = await fetch(`${base}/causelist.json`);
    log(`📌 Fetch status: ${clResp.status}`);
    if (clResp.ok) {
      causelistData = await clResp.json();
      if (!causelistData || !causelistData.judges) {
        throw new Error("Invalid causelist structure: missing judges array");
      }
    } else {
      causelistData = null;
      log(`⚠️ Causelist fetch failed: ${clResp.status}`);
    }
  } catch (e) { 
    log(`❌ Causelist error: ${e.message}`);
    causelistData = null;
  }

  try {
    const eodResp = await fetch(`${base}/eod_report.json`);
    if (eodResp.ok) eodData = await eodResp.json();
    else eodData = null;
  } catch (e) { 
    log(`⚠️ EOD error: ${e.message}`);
    eodData = null;
  }

  try {
    const historyResp = await fetch(`data/index.json`);
    if (historyResp.ok) {
      const indexData = await historyResp.json();
      historyIndex = Array.isArray(indexData?.days) ? indexData.days : [];
    } else {
      historyIndex = [];
    }
  } catch (e) {
    log(`⚠️ History error: ${e.message}`);
    historyIndex = [];
  }

  publishedDates = new Set(historyIndex.map((day) => day.date).filter(Boolean));
  if (causelistData || eodData) {
    publishedDates.add(currentDate);
  }
  currentDate = coerceSelectableDate(currentDate);
  populateDateSelect();
  updateDateHeader();

  try {
    flattenCases();
    log(`✅ Loaded ${allCases.length} cases from ${causelistData?.judges?.length || 0} judges`);
  } catch (e) {
    log(`❌ Case flattening error: ${e.message}`);
  }
  
  try {
    renderAll();
  } catch (e) {
    log(`❌ Render error: ${e.message}`);
  }
}

function flattenCases() {
  allCases = [];
  if (!causelistData) return;
  for (const judge of causelistData.judges || []) {
    for (const c of judge.cases || []) {
      allCases.push({
        ...c,
        judge_name: judge.judge_name,
        court_hall: judge.court_hall,
        cause_list_no: judge.cause_list_no,
      });
    }
  }
}

// ── Render ──
function renderAll() {
  renderOverview();
  renderJudges();
  renderHearings();
  renderTrends();
  renderCalendarTab();
  renderCasesTable();
}

function renderTab(tab) {
  try {
    if (tab === "judges") {
      renderJudges();
      return;
    }
    if (tab === "hearings") {
      renderHearings();
      return;
    }
    if (tab === "trends") {
      renderTrends();
      return;
    }
    if (tab === "calendar") {
      renderCalendarTab();
      return;
    }
    if (tab === "cases") {
      renderCasesTable();
    }
  } catch (e) {
    console.error(`renderTab(${tab}) failed:`, e);
  }
}

function renderOverview() {
  if (!causelistData) {
    $("#st-scheduled").textContent = "—";
    $("#st-heard").textContent = "—";
    $("#st-not-heard").textContent = "—";
    $("#st-pct").textContent = "—";
    const noDataMessage = getNoDataMessage();
    const registrarNote = $("#registrarNote");
    if (registrarNote) {
      registrarNote.textContent = "Registrar (Protocol and Hospitality) administrative lists are excluded from totals.";
    }
    $("#chartTypesText").textContent = noDataMessage;
    $("#chartStagesText").textContent = noDataMessage;
    $("#chartTypesBars").innerHTML = `<div class="bar-detail">${escapeHtml(noDataMessage)}</div>`;
    $("#chartStagesBars").innerHTML = `<div class="bar-detail">${escapeHtml(noDataMessage)}</div>`;
    $("#stageInsights").innerHTML = `<div class="insight-item"><div class="insight-copy">${escapeHtml(noDataMessage)}</div></div>`;
    $("#typeInsights").innerHTML = `<div class="insight-item"><div class="insight-copy">${escapeHtml(noDataMessage)}</div></div>`;
    $("#chartAgeText").textContent = noDataMessage;
    destroyChart("chartAge");
    $("#narrativeCard").style.display = "none";
    $("#narrative").innerHTML = "";
    populateHallFilter();
    return;
  }

  const summary = eodData?.summary;
  const total = allCases.length;
  const heard = summary?.total_heard ?? 0;
  const notHeard = summary ? total - heard : 0;
  const pct = summary?.heard_pct ?? "—";

  $("#st-scheduled").textContent = total;
  $("#st-heard").textContent = summary ? heard : "—";
  $("#st-not-heard").textContent = summary ? notHeard : "—";
  $("#st-pct").textContent = summary ? `${pct}%` : "EOD pending";

  const excludedAdminCases = causelistData.excluded_admin_cases || 0;
  const registrarNote = $("#registrarNote");
  if (registrarNote) {
    registrarNote.textContent = excludedAdminCases > 0
      ? `Registrar (Protocol and Hospitality) administrative lists are excluded from totals (${excludedAdminCases} cases).`
      : "Registrar (Protocol and Hospitality) administrative lists are excluded from totals.";
  }

  // Narrative
  if (eodData?.narrative) {
    $("#narrativeCard").style.display = "";
    const title = $("#narrativeTitle");
    const modelLabel = eodData.narrative_model || "AI";
    if (title) {
      title.textContent = `AI Insights (${modelLabel})`;
    }
    $("#narrative").innerHTML = renderNarrative(eodData.narrative, eodData.narrative_format);
  } else {
    $("#narrativeCard").style.display = "none";
  }

  populateHallFilter();

  // Charts
  renderTypeChart();
  renderStageChart();
  renderOverviewInsights();
  renderAgeChart();
}

function renderTypeChart() {
  const rows = getCaseTypeRows().slice(0, 8);

  const el = $("#chartTypesText");
  if (el) {
    if (!rows.length) {
      el.textContent = "Run EOD to see case-type hearing analysis.";
    } else {
      el.innerHTML = rows
        .slice(0, 4)
        .map((row) => `<span style="display:inline-block;margin:2px 6px">${escapeHtml(row.label)}: <b>${row.heard_pct}%</b> (${row.heard}/${row.scheduled})</span>`)
        .join("");
    }
  }

  renderBarList("#chartTypesBars", rows, { detail: (row) => `${row.heard} heard of ${row.scheduled} scheduled` });
}

function renderStageChart() {
  const rows = getStageRows().slice(0, 8);

  const el = $("#chartStagesText");
  if (el) {
    if (!rows.length) {
      el.textContent = "Run EOD to see hearing-stage analysis.";
    } else {
      el.innerHTML = rows
        .slice(0, 4)
        .map((row) => `<span style="display:inline-block;margin:2px 6px">${escapeHtml(row.label)}: <b>${row.heard_pct}%</b> (${row.heard}/${row.scheduled})</span>`)
        .join("");
    }
  }

  renderBarList("#chartStagesBars", rows, { detail: (row) => `${row.heard} heard of ${row.scheduled} scheduled` });
}

function renderAgeChart() {
  if (!allCases.length) {
    const el = $("#chartAgeText");
    if (el) el.textContent = getNoDataMessage();
    destroyChart("chartAge");
    return;
  }

  const buckets = { "0-2y": 0, "3-5y": 0, "6-10y": 0, "11-20y": 0, "20+y": 0 };
  allCases.forEach((c) => {
    const age = c.case_age_years || 0;
    if (age <= 2) buckets["0-2y"]++;
    else if (age <= 5) buckets["3-5y"]++;
    else if (age <= 10) buckets["6-10y"]++;
    else if (age <= 20) buckets["11-20y"]++;
    else buckets["20+y"]++;
  });

  const el = $("#chartAgeText");
  if (el) el.innerHTML = Object.entries(buckets).map(([k, v]) => `<span style="display:inline-block;margin:2px 6px">${k}: <b>${v}</b></span>`).join('');

  if (typeof Chart === 'undefined') return;

  destroyChart("chartAge");
  charts.chartAge = new Chart($("#chartAge"), {
    type: "bar",
    data: {
      labels: Object.keys(buckets),
      datasets: [{
        data: Object.values(buckets),
        backgroundColor: ["#22c55e", "#6366f1", "#f59e0b", "#ef4444", "#dc2626"],
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#9ca3af" }, grid: { display: false } },
        y: { ticks: { color: "#9ca3af" }, grid: { color: "#1f2937" } },
      },
    },
  });
}

// ── Judges Tab ──
function renderJudges() {
  const container = $("#judgeCards");
  if (!container) return;
  container.innerHTML = "";

  try {
    if (!causelistData) {
      container.innerHTML = '<p class="text-gray-400 text-sm">No data loaded</p>';
      return;
    }

    const groupedJudges = new Map();
    for (const judge of causelistData.judges || []) {
      const judgeNames = judge.judge_names?.length ? judge.judge_names : [judge.judge_name || "Unknown"];
      const reportJudgeName = judge.judge_name || judgeNames.join(" & ");
      const judgeKey = `${judge.court_hall || "?"}::${judgeNames.join(" & ")}`;
      if (!groupedJudges.has(judgeKey)) {
        groupedJudges.set(judgeKey, {
          hall: judge.court_hall || "?",
          judgeNames,
          benchType: judge.bench_type || (judgeNames.length > 1 ? "BENCH" : "SINGLE"),
          listSummaries: [],
          totalCases: 0,
          totalHeard: 0,
          totalScheduled: 0,
          topStage: null,
        });
      }

      const groupedJudge = groupedJudges.get(judgeKey);
      const totalCases = judge.cases?.length || 0;
      groupedJudge.totalCases += totalCases;
      groupedJudge.listSummaries.push({
        listNo: judge.cause_list_no || groupedJudge.listSummaries.length + 1,
        totalCases,
      });

      const judgeReports = (eodData?.judge_reports || []).filter((report) =>
        report.court_hall === judge.court_hall &&
        report.judge_name === reportJudgeName
      );

      for (const jr of judgeReports) {
        groupedJudge.totalHeard += jr.total_heard || 0;
        groupedJudge.totalScheduled += jr.total_scheduled || 0;
        const stage = summarizeBreakdownObject(jr.by_stage);
        if (stage && (!groupedJudge.topStage || stage.scheduled > groupedJudge.topStage.scheduled)) {
          groupedJudge.topStage = stage;
        }
      }
    }

    const rows = [...groupedJudges.values()].sort((left, right) => {
      const hallCompare = String(left.hall).localeCompare(String(right.hall), undefined, { numeric: true });
      if (hallCompare !== 0) return hallCompare;
      return left.judgeNames.join(", ").localeCompare(right.judgeNames.join(", "));
    });
    const listedTotal = rows.reduce((sum, row) => sum + row.totalCases, 0);
    const scheduledTotal = allCases.length;
    const totalsMatch = listedTotal === scheduledTotal;
    if (!rows.length) {
      container.innerHTML = '<p class="text-gray-400 text-sm">No judges available for this date</p>';
      return;
    }

    const card = document.createElement("div");
    card.className = "card";
    const summary = document.createElement("div");
    summary.style.cssText = "display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;font-size:0.8rem;color:var(--subtle);";
    summary.innerHTML = `
      <span>Judge rows total: <b style="color:var(--title);">${listedTotal}</b></span>
      <span>Scheduled total: <b style="color:var(--title);">${scheduledTotal}</b></span>
      <span>Reconciled: <b style="color:${totalsMatch ? "#22c55e" : "#ef4444"};">${totalsMatch ? "Yes" : "No"}</b></span>
    `;
    card.appendChild(summary);
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:0.84rem;";
    table.innerHTML = `
      <thead style="border-bottom:2px solid #374151;">
        <tr style="text-align:left;">
          <th style="padding:10px 8px;color:var(--muted);">Hall</th>
          <th style="padding:10px 8px;color:var(--muted);">Judge</th>
          <th style="padding:10px 8px;color:var(--muted);">Lists</th>
          <th style="padding:10px 8px;color:var(--muted);text-align:right;">Listed</th>
          <th style="padding:10px 8px;color:var(--muted);text-align:right;">Heard</th>
          <th style="padding:10px 8px;color:var(--muted);">Top Stage</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => {
          const heardPct = row.totalScheduled > 0
            ? Math.round((row.totalHeard / row.totalScheduled) * 1000) / 10
            : null;
          const heardColor = heardPct == null
            ? "#9ca3af"
            : heardPct >= 70
              ? "#22c55e"
              : heardPct >= 50
                ? "#f59e0b"
                : "#ef4444";
          const listSummaries = row.listSummaries
            .sort((left, right) => left.listNo - right.listNo)
            .map((summary) => `L${summary.listNo}: ${summary.totalCases}`)
            .join(" · ");
          return `
            <tr style="border-bottom:1px solid rgba(31,41,55,0.7);vertical-align:top;">
              <td style="padding:10px 8px;color:var(--title);font-weight:600;">${escapeHtml(row.hall)}</td>
              <td style="padding:10px 8px;">
                <div style="color:var(--title);font-weight:600;">${escapeHtml(row.judgeNames.join(", "))}</div>
                <div style="font-size:0.75rem;color:var(--subtle);margin-top:4px;">${row.benchType}</div>
              </td>
              <td style="padding:10px 8px;color:var(--pill-text);">
                <div>${[...new Set(row.listSummaries.map((summary) => summary.listNo))].sort((a, b) => a - b).join(", ")}</div>
                <div style="font-size:0.75rem;color:var(--subtle);margin-top:4px;">${escapeHtml(listSummaries)}</div>
              </td>
              <td style="padding:10px 8px;text-align:right;color:#c084fc;font-weight:600;">${row.totalCases}</td>
              <td style="padding:10px 8px;text-align:right;color:${heardColor};font-weight:600;">${heardPct == null ? "—" : `${heardPct}%`} ${row.totalScheduled ? `<span style="display:block;font-size:0.75rem;color:var(--subtle);font-weight:400;">${row.totalHeard}/${row.totalScheduled}</span>` : ""}</td>
              <td style="padding:10px 8px;color:var(--pill-text);">${row.topStage ? `${escapeHtml(row.topStage.label)} <span style="color:var(--subtle);">(${row.topStage.heard_pct}%)</span>` : "—"}</td>
            </tr>`;
        }).join("")}
      </tbody>
    `;
    card.appendChild(table);
    container.appendChild(card);
  } catch (e) {
    console.error("renderJudges error:", e);
    container.innerHTML = `<p class="text-red-400 text-sm">Error loading judges: ${escapeHtml(e.message)}</p>`;
  }
}

// ── Hearings Tab ──
function renderHearings() {
  const stageRows = getStageRows();
  const typeRows = getCaseTypeRows();
  const bestStage = getBestPerformer(stageRows);
  const bestType = getBestPerformer(typeRows);
  const backlog = getLargestBacklog(stageRows, typeRows);

  $("#hearing-best-stage").textContent = bestStage ? `${bestStage.label} ${bestStage.heard_pct}%` : "—";
  $("#hearing-best-type").textContent = bestType ? `${bestType.label} ${bestType.heard_pct}%` : "—";
  $("#hearing-backlog").textContent = backlog ? `${backlog.label} ${backlog.pending}` : "—";

  renderBreakdownTable("#hearingStageTable", stageRows);
  renderBreakdownTable("#hearingTypeTable", typeRows);
}

function renderTrends() {
  const days = getHistoryDays();
  const overviewEl = $("#trendOverviewBars");
  if (!overviewEl) return;

  if (!days.length) {
    overviewEl.innerHTML = '<div class="bar-detail">Run EOD on multiple days to populate trend views.</div>';
    renderTrendGroups("#trendStageGroups", [], "by_stage");
    renderTrendGroups("#trendTypeGroups", [], "by_case_type");
    return;
  }

  renderBarList(
    "#trendOverviewBars",
    days.map((day) => ({
      label: shortDate(day.date),
      heard_pct: day.heard_pct,
      heard: day.heard,
      scheduled: day.scheduled,
    })),
    { detail: (row) => `${row.heard}/${row.scheduled} heard` }
  );

  renderTrendGroups("#trendStageGroups", pickTrendLabels(days, "by_stage"), "by_stage");
  renderTrendGroups("#trendTypeGroups", pickTrendLabels(days, "by_case_type"), "by_case_type");
}

function renderCalendarTab() {
  const summary = getCalendarSummary();
  $("#cal-working-over").textContent = summary.workingOver;
  $("#cal-holidays-over").textContent = summary.holidaysOver;
  $("#cal-working-left").textContent = summary.workingLeft;
  $("#cal-holidays-left").textContent = summary.holidaysLeft;
  $("#cal-working-total").textContent = summary.workingTotal;
  $("#cal-holidays-total").textContent = summary.holidaysTotal;

  const selectedDay = getCalendarDay(currentDate);
  const selectedEl = $("#calendarSelectedDate");
  if (selectedEl && selectedDay) {
    selectedEl.innerHTML = `
      <div class="insight-item">
        <div class="insight-kicker">${escapeHtml(selectedDay.weekdayLong)}</div>
        <div class="insight-title">${escapeHtml(selectedDay.date)}</div>
        <div class="insight-copy">${escapeHtml(getDayStatusLabel(selectedDay))}</div>
      </div>
    `;
  }

  renderInsightList("#calendarRules", [
    {
      kicker: "Closed by default",
      title: "Sundays and second Saturdays are blocked",
      copy: "The date selector disables all Sundays and second Saturdays for 2026.",
    },
    {
      kicker: "Court calendar",
      title: "General, restricted and vacation days are treated as holidays",
      copy: "The selector also disables all red, green and vacation dates listed in the High Court calendar.",
    },
    {
      kicker: "High Court override",
      title: "Declared sitting days stay enabled",
      copy: "Special High Court sitting days override holiday or vacation treatment and remain selectable.",
    },
  ]);
}

function setupDonateModal() {
  const openButton = $("#donateButton");
  const modal = $("#donateModal");
  const closeButton = $("#donateClose");
  if (!openButton || !modal || !closeButton) return;

  const closeModal = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  openButton.addEventListener("click", () => {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  });

  closeButton.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      closeModal();
    }
  });
}

function setupThemeToggle() {
  const select = $("#themeSelect");
  if (!select) return;

  const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  const initialTheme = savedTheme === "light" ? "light" : "dark";
  applyTheme(initialTheme);
  select.value = initialTheme;

  select.addEventListener("change", (event) => {
    const theme = event.target.value === "light" ? "light" : "dark";
    applyTheme(theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  });
}

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
}

// ── Cases Table ──
function renderCasesTable() {
  const tbody = $("#casesTable");
  if (!tbody) return;

  const search = ($("#caseSearch")?.value || "").toLowerCase();
  const filter = $("#caseFilter")?.value || "";
  const hallFilter = $("#hallFilter")?.value || "";

  let filtered = allCases;
  if (search) {
    filtered = filtered.filter((c) =>
      (c.case_number + c.petitioner + c.respondent + c.subject_code + c.case_type + c.judge_name + c.court_hall)
        .toLowerCase()
        .includes(search)
    );
  }
  if (filter === "heard" || filter === "not-heard") {
    const eodCases = eodData?.judge_reports?.flatMap((r) => r.cases) || [];
    const heardSet = new Set(eodCases.filter((e) => e.was_heard).map((e) => e.case_number));
    if (filter === "heard") filtered = filtered.filter((c) => heardSet.has(c.case_number));
    else filtered = filtered.filter((c) => !heardSet.has(c.case_number));
  }
  if (hallFilter) {
    filtered = filtered.filter((c) => String(c.court_hall || "") === hallFilter);
  }

  filtered = [...filtered].sort((left, right) => {
    const hallCompare = String(left.court_hall || "").localeCompare(String(right.court_hall || ""), undefined, { numeric: true });
    if (hallCompare !== 0) return hallCompare;
    const judgeCompare = String(left.judge_name || "").localeCompare(String(right.judge_name || ""));
    if (judgeCompare !== 0) return judgeCompare;
    return String(left.case_number || "").localeCompare(String(right.case_number || ""), undefined, { numeric: true });
  });

  if (!filtered.length) {
    const hasCaseData = allCases.length > 0;
    const emptyMessage = hasCaseData ? "No cases match the current search/filter." : getNoDataMessage();
    tbody.innerHTML = `<tr><td colspan="11" class="py-3 text-sm" style="color:var(--subtle);">${escapeHtml(emptyMessage)}</td></tr>`;
    return;
  }

  const rows = [];
  for (const c of filtered) {
    const eodCase = eodData?.judge_reports
      ?.flatMap((r) => r.cases)
      ?.find((ec) => ec.case_number === c.case_number);
    const heard = eodCase?.was_heard;
    rows.push(`<tr class="border-b border-gray-800/50 hover:bg-gray-800/30">
      <td class="py-1.5"><span class="pill">Hall ${escapeHtml(c.court_hall || "—")}</span></td>
      <td class="py-1.5 text-xs max-w-[180px] truncate">${escapeHtml(c.judge_name || '—')}</td>
      <td class="py-1.5">${c.sl_no}</td>
      <td class="py-1.5 font-mono text-xs whitespace-nowrap">${c.case_number}</td>
      <td class="py-1.5 text-xs">${escapeHtml(c.case_type || '—')}</td>
      <td class="py-1.5 text-xs">${c.subject_code || '—'}</td>
      <td class="py-1.5 text-xs">${(c.stage || '').substring(0, 20)}</td>
      <td class="py-1.5 text-xs max-w-[120px] truncate">${c.petitioner || '—'}</td>
      <td class="py-1.5 text-xs max-w-[120px] truncate">${c.respondent || '—'}</td>
      <td class="py-1.5 text-xs">${c.case_age_years}y</td>
      <td class="py-1.5">${heard === true ? '✅' : heard === false ? '❌' : '—'}</td>
    </tr>`);
  }
  tbody.innerHTML = rows.join("");
}

function populateHallFilter() {
  const select = $("#hallFilter");
  if (!select) return;

  const currentValue = select.value;
  const halls = [...new Set(allCases.map((c) => String(c.court_hall || "")).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  select.innerHTML = `<option value="">All Halls</option>${halls
    .map((hall) => `<option value="${escapeHtml(hall)}">Hall ${escapeHtml(hall)}</option>`)
    .join("")}`;

  if (halls.includes(currentValue)) {
    select.value = currentValue;
  }
}

function renderNarrative(markdown, format) {
  const source = String(markdown || "").trim();
  if (!source) {
    return "";
  }

  if (format !== "markdown") {
    return `<p>${escapeHtml(source)}</p>`;
  }

  return source
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${formatInlineMarkdown(paragraph)}</p>`)
    .join("");
}

function formatInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

// ── Util ──
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function getStageRows() {
  return (eodData?.summary?.by_stage || []).map((row) => ({
    ...row,
    pending: Math.max((row.scheduled || 0) - (row.heard || 0), 0),
  }));
}

function getCaseTypeRows() {
  return (eodData?.summary?.by_case_type || []).map((row) => ({
    ...row,
    pending: Math.max((row.scheduled || 0) - (row.heard || 0), 0),
  }));
}

function getBestPerformer(rows) {
  return rows
    .filter((row) => (row.scheduled || 0) >= 3)
    .sort((a, b) => (b.heard_pct - a.heard_pct) || (b.heard - a.heard) || (b.scheduled - a.scheduled))[0] || null;
}

function buildCourtCalendarDays() {
  const year = CALENDAR_2026.year;
  const general = new Set(CALENDAR_2026.generalHolidays);
  const restricted = new Set(CALENDAR_2026.restrictedHolidays);
  const extra = new Set(CALENDAR_2026.extraHighCourtHolidays);
  const sitting = new Set(CALENDAR_2026.highCourtSittingDays);
  const days = [];

  for (let month = 1; month <= 12; month += 1) {
    const lastDay = new Date(year, month, 0).getDate();
    for (let day = 1; day <= lastDay; day += 1) {
      const date = toIsoDate(year, month, day);
      const localDate = new Date(year, month - 1, day);
      const reasons = [];
      const isSunday = localDate.getDay() === 0;
      const isSecondSaturday = localDate.getDay() === 6 && day >= 8 && day <= 14;

      if (isSunday) reasons.push("Sunday");
      if (isSecondSaturday) reasons.push("Second Saturday");
      if (general.has(date)) reasons.push("General holiday");
      if (restricted.has(date)) reasons.push("Restricted holiday");
      if (extra.has(date)) reasons.push("Declared High Court holiday");
      if (CALENDAR_2026.vacations.some(([start, end]) => date >= start && date <= end)) reasons.push("Court vacation");

      const isSittingDay = sitting.has(date);
      const isHoliday = reasons.length > 0 && !isSittingDay;
      const isFuture = date > TODAY;

      days.push({
        date,
        isHoliday,
        isFuture,
        isSittingDay,
        reasons,
        weekdayShort: localDate.toLocaleDateString(undefined, { weekday: "short" }),
        weekdayLong: localDate.toLocaleDateString(undefined, { weekday: "long" }),
      });
    }
  }

  return days;
}

function populateDateSelect() {
  const select = $("#dateSelect");
  if (!select) return;

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  select.innerHTML = "";
  monthNames.forEach((monthName, index) => {
    const prefix = `${CALENDAR_2026.year}-${String(index + 1).padStart(2, "0")}`;
    const group = document.createElement("optgroup");
    group.label = monthName;

    courtCalendarDays
      .filter((day) => day.date.startsWith(prefix))
      .forEach((day) => {
        const option = document.createElement("option");
        option.value = day.date;
        option.disabled = !isSelectableDay(day);
        option.textContent = `${day.date} · ${day.weekdayShort}${day.reasons.length ? ` · ${day.reasons[0]}` : ""}${isPublishedDate(day.date) ? " · Published" : ""}`;
        group.appendChild(option);
      });

    select.appendChild(group);
  });

  select.value = currentDate;
}

function updateDateHeader() {
  const day = getCalendarDay(currentDate);
  const badge = $("#dateStatus");
  const workingLeft = $("#workingDaysLeft");
  const summary = getCalendarSummary();

  if (badge && day) {
    const isPublished = isPublishedDate(day.date);
    badge.textContent = getDayStatusLabel(day);
    badge.style.background = day.isFuture && !isPublished ? "var(--badge-disabled-bg)" : day.isHoliday && !isPublished ? "var(--badge-holiday-bg)" : "var(--badge-working-bg)";
    badge.style.borderColor = day.isFuture && !isPublished ? "var(--badge-disabled-border)" : day.isHoliday && !isPublished ? "var(--badge-holiday-border)" : "var(--badge-working-border)";
    badge.style.color = day.isFuture && !isPublished ? "var(--badge-disabled-text)" : day.isHoliday && !isPublished ? "var(--badge-holiday-text)" : "var(--badge-working-text)";
  }

  if (workingLeft) {
    workingLeft.textContent = `${summary.workingLeft} working days left in 2026`;
  }
}

function getCalendarDay(date) {
  return courtCalendarIndex.get(date) || null;
}

function coerceSelectableDate(date) {
  const target = typeof date === "string" && date ? date : TODAY;
  const validDays = courtCalendarDays.filter((day) => isSelectableDay(day));
  const exact = validDays.find((day) => day.date === target);
  if (exact) return exact.date;

  const previous = validDays.filter((day) => day.date <= target).pop();
  return previous?.date || validDays[validDays.length - 1]?.date || target;
}

function getCalendarSummary() {
  const pastOrToday = courtCalendarDays.filter((day) => day.date <= TODAY);
  const future = courtCalendarDays.filter((day) => day.date > TODAY);

  return {
    workingOver: pastOrToday.filter((day) => !day.isHoliday).length,
    holidaysOver: pastOrToday.filter((day) => day.isHoliday).length,
    workingLeft: future.filter((day) => !day.isHoliday).length,
    holidaysLeft: future.filter((day) => day.isHoliday).length,
    workingTotal: courtCalendarDays.filter((day) => !day.isHoliday).length,
    holidaysTotal: courtCalendarDays.filter((day) => day.isHoliday).length,
  };
}

function getDayStatusLabel(day) {
  if (!day) return "Unknown date";
  if (isPublishedDate(day.date)) {
    return day.reasons.length
      ? `Working day · Published data available (${day.reasons.join(", ")})`
      : "Working day · Published data available";
  }
  if (day.isFuture) {
    return day.reasons.length ? `Unavailable · ${day.reasons.join(", ")}` : "Unavailable";
  }
  if (day.isHoliday) {
    return `Holiday · ${day.reasons.join(", ")}`;
  }
  if (day.isSittingDay) {
    return "Working day · Declared sitting day";
  }
  return "Working day";
}

function isPublishedDate(date) {
  return publishedDates.has(date);
}

function isSelectableDay(day) {
  return isPublishedDate(day.date) || (!day.isHoliday && !day.isFuture);
}

function getNoDataMessage() {
  const day = getCalendarDay(currentDate);
  if (!day) return "No data available for this date.";
  if (day.isFuture) return day.reasons.length ? `Unavailable: ${day.reasons.join(", ")}.` : "Future dates are disabled in the 2026 court calendar.";
  if (day.isHoliday && !isPublishedDate(day.date)) return `No cause list expected: ${getDayStatusLabel(day)}.`;
  return "No data available for this working day.";
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function getHistoryDays(anchorDate = currentDate) {
  const sorted = [...historyIndex]
    .filter((day) => day && day.date)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!sorted.length) return [];

  // Anchor trend window to the selected date instead of always using latest days.
  const capped = sorted.filter((day) => day.date <= anchorDate);
  const source = capped.length ? capped : sorted;
  return source.slice(-14);
}

function summarizeBreakdownObject(counter) {
  if (!counter) return null;
  const rows = Object.entries(counter).map(([label, stats]) => {
    const scheduled = stats?.scheduled || 0;
    const heard = stats?.heard || 0;
    return {
      label,
      scheduled,
      heard,
      heard_pct: scheduled ? Math.round((heard / scheduled) * 1000) / 10 : 0,
    };
  });
  rows.sort((a, b) => (b.scheduled - a.scheduled) || (b.heard - a.heard));
  return rows[0] || null;
}

function getLargestBacklog(...groups) {
  return groups
    .flat()
    .filter((row) => (row.scheduled || 0) >= 3)
    .sort((a, b) => (b.pending - a.pending) || (b.scheduled - a.scheduled))[0] || null;
}

function renderOverviewInsights() {
  const stageRows = getStageRows();
  const typeRows = getCaseTypeRows();
  const bestStage = getBestPerformer(stageRows);
  const weakestStage = [...stageRows]
    .filter((row) => (row.scheduled || 0) >= 3)
    .sort((a, b) => (a.heard_pct - b.heard_pct) || (b.pending - a.pending))[0] || null;
  const busiestType = [...typeRows].sort((a, b) => (b.scheduled - a.scheduled) || (b.heard - a.heard))[0] || null;
  const backlogType = [...typeRows]
    .filter((row) => (row.scheduled || 0) >= 3)
    .sort((a, b) => (b.pending - a.pending) || (a.heard_pct - b.heard_pct))[0] || null;

  renderInsightList("#stageInsights", [
    bestStage
      ? {
          kicker: "Top stage",
          title: `${bestStage.label} is moving fastest`,
          copy: `${bestStage.heard_pct}% heard (${bestStage.heard}/${bestStage.scheduled}).`,
        }
      : null,
    weakestStage
      ? {
          kicker: "Watchlist",
          title: `${weakestStage.label} is dragging`,
          copy: `${weakestStage.pending} matters remain unheard, with only ${weakestStage.heard_pct}% cleared.`,
        }
      : null,
    stageRows[0]
      ? {
          kicker: "Volume",
          title: `${stageRows[0].label} drives the docket`,
          copy: `${stageRows[0].scheduled} cases were listed in this stage today.`,
        }
      : null,
  ].filter(Boolean));

  renderInsightList("#typeInsights", [
    busiestType
      ? {
          kicker: "Most listed",
          title: `${busiestType.label} had the most listings`,
          copy: `${busiestType.scheduled} scheduled and ${busiestType.heard} heard.`,
        }
      : null,
    backlogType
      ? {
          kicker: "Backlog",
          title: `${backlogType.label} has the largest carry-over`,
          copy: `${backlogType.pending} cases were not heard, leaving a ${backlogType.heard_pct}% hearing rate.`,
        }
      : null,
    getBestPerformer(typeRows)
      ? {
          kicker: "Strongest conversion",
          title: `${getBestPerformer(typeRows).label} is clearing well`,
          copy: `${getBestPerformer(typeRows).heard_pct}% heard across ${getBestPerformer(typeRows).scheduled} listings.`,
        }
      : null,
  ].filter(Boolean));
}

function renderInsightList(selector, items) {
  const el = $(selector);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="insight-item"><div class="insight-copy">Run EOD to populate hearing insights.</div></div>';
    return;
  }

  el.innerHTML = items.map((item) => `
    <div class="insight-item">
      <div class="insight-kicker">${escapeHtml(item.kicker)}</div>
      <div class="insight-title">${escapeHtml(item.title)}</div>
      <div class="insight-copy">${escapeHtml(item.copy)}</div>
    </div>
  `).join("");
}

function renderBarList(selector, rows, options = {}) {
  const el = $(selector);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<div class="bar-detail">No EOD hearing data available.</div>';
    return;
  }

  const detail = options.detail || ((row) => `${row.heard_pct}% heard`);
  el.innerHTML = rows.map((row) => `
    <div class="bar-row">
      <div class="bar-meta">
        <span>${escapeHtml(row.label)}</span>
        <span>${row.heard_pct}%</span>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, row.heard_pct || 0))}%"></div></div>
      <div class="bar-detail">${escapeHtml(detail(row))}</div>
    </div>
  `).join("");
}

function renderBreakdownTable(selector, rows) {
  const el = $(selector);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '<p class="text-sm text-gray-400">Run EOD to populate this view.</p>';
    return;
  }

  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Label</th>
          <th>Scheduled</th>
          <th>Heard</th>
          <th>Pending</th>
          <th>Rate</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((row) => `
          <tr>
            <td>${escapeHtml(row.label)}</td>
            <td>${row.scheduled}</td>
            <td>${row.heard}</td>
            <td>${row.pending}</td>
            <td>${row.heard_pct}%</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function pickTrendLabels(days, key) {
  const sourceDay = days.find((day) => day.date === currentDate) || days[days.length - 1];
  return (sourceDay?.[key] || []).slice(0, 3).map((row) => row.label);
}

function renderTrendGroups(selector, labels, key) {
  const el = $(selector);
  if (!el) return;
  const days = getHistoryDays();

  if (!days.length || !labels.length) {
    el.innerHTML = '<div class="trend-group"><div class="bar-detail">No multi-day trend data yet.</div></div>';
    return;
  }

  el.innerHTML = labels.map((label) => {
    const rows = days.map((day) => {
      const match = (day[key] || []).find((row) => row.label === label);
      return {
        label: shortDate(day.date),
        heard_pct: match?.heard_pct || 0,
        heard: match?.heard || 0,
        scheduled: match?.scheduled || 0,
      };
    });
    return `
      <div class="trend-group">
        <div class="trend-title">${escapeHtml(label)}</div>
        ${rows.map((row) => `
          <div class="bar-row">
            <div class="bar-meta">
              <span>${escapeHtml(row.label)}</span>
              <span>${row.heard_pct}%</span>
            </div>
            <div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, row.heard_pct || 0))}%"></div></div>
            <div class="bar-detail">${row.heard}/${row.scheduled} heard</div>
          </div>
        `).join("")}
      </div>
    `;
  }).join("");
}

function shortDate(value) {
  return value ? value.slice(5) : "—";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
