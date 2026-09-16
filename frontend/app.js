const API = (window.APP_CONFIG && window.APP_CONFIG.API_BASE_URL) || "http://localhost:4000";
const $ = id => document.getElementById(id);

let token = localStorage.getItem("ps_admin_token") || "";
let refreshToken = localStorage.getItem("ps_refresh_token") || "";
let refreshPromise = null;
let currentUser = null;
let currentPage = "dashboard";
let currentDataTab = "calendar";
let dashboardData = null;
let editingId = null;
let selectedDate = localStorage.getItem("ps_selected_date") || localToday();
let calendarCursor = dateFromYmd(selectedDate);
let calendarMonthEvents = [];
let refreshInFlight = false;
let manpowerImageIndex = 0;
let inlineImageZoom = 1;
let imageZoom = 1;
let hideDashboard = localStorage.getItem("ps_hide_dashboard") === "true";
let tvView = localStorage.getItem("ps_tv_view") === "true";

const dataModules = {
  calendar:{label:"Calendar Data", endpoint:"calendar", fields:[
    {name:"event_date",label:"Date",type:"date",required:true},
    {name:"event_title",label:"Event Title",type:"text",required:true},
    {name:"description",label:"Event Description",type:"textarea"}
  ]},
  // Receivables/Payables use their own bulk-editable grid + upload UI (see
  // the "Accounts (Receivables & Payables)" section below) instead of the
  // generic single-row form, so these entries only exist to drive the tab bar.
  receivables:{label:"Receivables Data", endpoint:"receivables", fields:[]},
  payables:{label:"Payables Data", endpoint:"payables", fields:[]},
  meetings:{label:"Meeting Schedule Data", endpoint:"meetings", fields:[
    {name:"meeting_date",label:"Date",type:"date",required:true},
    {name:"meeting_time",label:"Time",type:"text",required:true},
    {name:"meeting_name",label:"Meeting Name",type:"text",required:true},
    {name:"team",label:"Team Name",type:"text"},
    {name:"meeting_room",label:"Meeting Room",type:"text"}
  ]},
  departments:{label:"Department Schedule Data", endpoint:"departments", fields:[
    {name:"schedule_date",label:"Date",type:"date",required:true},
    {name:"department_name",label:"Department",type:"text",required:true},
    {name:"start_time",label:"Start Time",type:"text",required:true},
    {name:"end_time",label:"End Time",type:"text",required:true},
    {name:"location",label:"Location",type:"text",required:true}
  ]},
  attendance:{label:"Attendance Data", endpoint:"attendance", fields:[
    {name:"reading_date",label:"Date",type:"date",required:true},
    {name:"location_name",label:"Location",type:"select",options:["Manpower","Wada","HO"],required:true},
    {name:"present_count",label:"Present",type:"number",required:true},
    {name:"absent_count",label:"Absent",type:"number",required:true},
    {name:"half_day_count",label:"Half Day",type:"number",required:true}
  ]},
  manpowerImages:{label:"Manpower Images", endpoint:"manpower-images", noBulk:true, tableFields:["id","date","title","description","image_url"], fields:[
    {name:"date",label:"Date",type:"date",required:true},
    {name:"image",label:"Image Upload",type:"file",accept:".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp",required:true},
    {name:"title",label:"Image Title",type:"text",required:true},
    {name:"description",label:"Description",type:"textarea"}
  ]},
  tasks:{label:"Tasks Data", endpoint:"tasks", fields:[
    {name:"task_date",label:"Date",type:"date",required:true},
    {name:"task_time",label:"Time",type:"text",required:true},
    {name:"task_name",label:"Task Name",type:"text",required:true},
    {name:"status",label:"Status",type:"select",options:["Pending","Completed","Overdue"],required:true}
  ]},
  notes:{label:"Notes Data", endpoint:"notes", fields:[
    {name:"note_date",label:"Date",type:"date",required:true},
    {name:"note_title",label:"Note Title",type:"text",required:true},
    {name:"note_description",label:"Description",type:"textarea",required:true}
  ]},
  reminders:{label:"Reminder Data", endpoint:"reminders", fields:[
    {name:"reminder_date",label:"Date",type:"date",required:true},
    {name:"reminder_time",label:"Reminder Time",type:"text",required:true},
    {name:"reminder_description",label:"Reminder Description",type:"textarea",required:true}
  ]}
};

document.addEventListener("DOMContentLoaded", async () => {
  const calendarRedirectStatus = new URLSearchParams(location.search).get("calendar");
  setupNavigation();
  setupAuth();
  setupCalendarButtons();
  setupDataTabs();
  setupReports();
  setupViewAllControls();
  setupDashboardVisibility();
  setupCalendarIntegration();
  setupArAp();
  setupTvView();

  await restoreAuthSession();
  if (currentUser) await loadDashboardPreference();
  updateAuthUI();
  setPage(calendarRedirectStatus && token ? "settings" : "dashboard");
  renderDashboardVisibility();
  renderTvView();

  if (!hideDashboard) {
    await refreshCalendarMonthEvents();
    await refreshDashboard();
  } else {
    renderCalendar();
  }

  setInterval(() => {
    if (currentPage === "dashboard" && !document.hidden && !hideDashboard) {
      refreshDashboard({ silent: true });
    }
  }, 30000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentPage === "dashboard" && !hideDashboard) refreshDashboard({ silent: true });
  });
});

async function api(path, options = {}, allowRefresh = true) {
  const isFormData = options.body instanceof FormData;
  const headers = { ...(isFormData ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) };
  if (token && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/refresh")) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(API + path, { ...options, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text ? { message: text } : null; }

  const isAuthEndpoint = path.startsWith("/api/auth/login") || path.startsWith("/api/auth/refresh");
  if (res.status === 401 && !isAuthEndpoint) {
    if (allowRefresh) {
      const refreshed = await refreshAccessToken();
      if (refreshed) return api(path, options, false);
    }
    handleSessionExpired();
    const err = new Error("Your session has expired. Please log in again.");
    err.code = "SESSION_EXPIRED";
    throw err;
  }

  if (!res.ok) {
    const base = body?.message || `Request failed (${res.status})`;
    const detail = body?.detail && body.detail !== base ? `: ${body.detail}` : "";
    const err = new Error(base + detail);
    err.code = body?.code || null;
    err.status = res.status;
    throw err;
  }
  return body;
}

function storeAuthSession(result) {
  token = result.accessToken || result.token || "";
  refreshToken = result.refreshToken || refreshToken || "";
  if (token) localStorage.setItem("ps_admin_token", token);
  if (refreshToken) localStorage.setItem("ps_refresh_token", refreshToken);
}

function clearAuthSession() {
  token = "";
  refreshToken = "";
  currentUser = null;
  localStorage.removeItem("ps_admin_token");
  localStorage.removeItem("ps_refresh_token");
}

async function refreshAccessToken() {
  if (!refreshToken) return false;
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch(API + "/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken })
      });
      if (!res.ok) return false;
      const result = await res.json();
      storeAuthSession(result);
      updateAuthUI();
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function restoreAuthSession() {
  if (!token) return;
  try {
    const session = await api("/api/auth/session");
    currentUser = session?.user || null;
    if (!refreshToken) {
      const pair = await api("/api/auth/bootstrap-refresh", { method: "POST", body: JSON.stringify({}) });
      storeAuthSession(pair);
    }
  } catch (err) {
    if (err.code !== "SESSION_EXPIRED" && err.status !== 401) {
      console.warn("Session validation deferred:", err.message);
    }
  }
}

function handleSessionExpired() {
  clearAuthSession();
  updateAuthUI();
  if (currentPage === "data" || currentPage === "settings") setPage("dashboard");
  showLogin("Your session has expired. Please log in again.");
}

function setupNavigation() {
  document.querySelectorAll(".nav-item").forEach(btn => btn.addEventListener("click", () => setPage(btn.dataset.page)));
}

async function setPage(page) {
  if ((page === "data" || page === "settings") && !token) {
    showLogin();
    return;
  }

  currentPage = page;
  document.body.classList.toggle("dashboard-mode", page === "dashboard");
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const pageEl = $(page + "Page");
  if (!pageEl) return;
  pageEl.classList.add("active");
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.page === page));

  const titles = {
    dashboard:["Good Afternoon, Reema!","Here's your overview"],
    accounts:["Accounts","Receivables & Payables"],
    projects:["Projects","Projects Module"],
    cctv:["CCTV","CCTV Module"],
    data:["Data","Manage all information that feeds the dashboard"],
    reports:["Reports","Profile Solutions Dashboard Analytics"],
    settings:["Settings","Profile Solutions Dashboard Analytics"]
  };
  $("pageHeading").textContent = titles[page]?.[0] || page;
  $("pageSubheading").textContent = titles[page]?.[1] || "";

  if (page === "dashboard") {
    updateDateLabels();
    if (!hideDashboard && dashboardData !== null) refreshDashboard({ silent: true });
  } else if (page === "data") {
    syncDataPageMode();
  } else if (page === "settings") {
    loadCalendarConnections();
  } else if (page === "accounts") {
    loadArApDashboard();
  } else if (["projects","cctv"].includes(page)) {
    loadPlaceholderModule(page);
  }
}

function setupCalendarIntegration() {
  $("googleCalendarBtn").onclick = () => connectCalendar("google");
  $("microsoftCalendarBtn").onclick = () => connectCalendar("microsoft");
  handleCalendarRedirect();
}

function handleCalendarRedirect() {
  const params = new URLSearchParams(location.search);
  const status = params.get("calendar");
  if (!status) return;

  const msg = $("calendarConnectMessage");
  msg.classList.remove("hidden");
  if (status === "connected") {
    msg.className = "calendar-connect-message success";
    msg.textContent = "Calendar connected successfully.";
  } else {
    msg.className = "calendar-connect-message form-error";
    msg.textContent = "Calendar connection failed. Please try again.";
  }

  params.delete("calendar");
  const newSearch = params.toString();
  history.replaceState({}, "", location.pathname + (newSearch ? `?${newSearch}` : "") + location.hash);
}

function connectCalendar(provider) {
  if (!token) return showLogin();
  window.location.href = `${API}/api/calendar/connect/${provider}?token=${encodeURIComponent(token)}`;
}

async function loadCalendarConnections() {
  let connections = [];
  try {
    connections = await api("/api/calendar/connections");
  } catch {}

  const byProvider = { GOOGLE: null, MICROSOFT: null };
  (connections || []).forEach(c => { if (c.is_active) byProvider[c.provider] = c; });
  updateCalendarProviderUI("google", byProvider.GOOGLE);
  updateCalendarProviderUI("microsoft", byProvider.MICROSOFT);
}

function updateCalendarProviderUI(provider, connection) {
  const statusEl = $(`${provider}CalendarStatus`);
  const emailEl = $(`${provider}CalendarEmail`);
  const btn = $(`${provider}CalendarBtn`);
  const syncBtn = $(`${provider}CalendarSyncBtn`);
  const manageBtn = $(`${provider}CalendarManageBtn`);
  const listPanel = $(`${provider}CalendarList`);
  const label = provider === "google" ? "Google" : "Microsoft";

  if (connection) {
    statusEl.textContent = "Connected";
    statusEl.classList.add("connected");
    emailEl.textContent = connection.connected_email || "";
    btn.textContent = `Disconnect ${label} Calendar`;
    btn.onclick = () => disconnectCalendar(connection.id);
    syncBtn.classList.remove("hidden");
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync Now";
    syncBtn.onclick = () => syncCalendarNow(connection.id, syncBtn);
    manageBtn.classList.remove("hidden");
    manageBtn.onclick = () => toggleCalendarManage(provider, connection.id);
  } else {
    statusEl.textContent = "Not Connected";
    statusEl.classList.remove("connected");
    emailEl.textContent = "";
    btn.textContent = `Connect ${label} Calendar`;
    btn.onclick = () => connectCalendar(provider);
    syncBtn.classList.add("hidden");
    syncBtn.onclick = null;
    manageBtn.classList.add("hidden");
    manageBtn.onclick = null;
    listPanel.classList.add("hidden");
    listPanel.innerHTML = "";
  }
}

// Lists the calendars available on a connected account (My Calendars + Google
// "Other calendars") so the admin can choose which ones feed Meeting Schedule.
async function toggleCalendarManage(provider, connectionId) {
  const panel = $(`${provider}CalendarList`);
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="calendar-list-loading">Loading calendars…</p>`;
  try {
    const result = await api(`/api/calendar/connections/${connectionId}/calendars`);
    renderCalendarList(provider, connectionId, result.calendars || []);
  } catch (err) {
    panel.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  }
}

function renderCalendarList(provider, connectionId, calendars) {
  const panel = $(`${provider}CalendarList`);
  if (!calendars.length) {
    panel.innerHTML = `<p class="calendar-list-empty">No calendars found for this account.</p>`;
    return;
  }

  panel.innerHTML = `
    <div class="calendar-list-items">
      ${calendars.map(c => `
        <label class="calendar-list-item${c.readable === false ? " disabled" : ""}">
          <input type="checkbox" data-cal-id="${escAttr(c.external_calendar_id)}" ${c.selected ? "checked" : ""} ${c.readable === false ? "disabled" : ""}>
          <span class="calendar-list-name">${esc(c.calendar_name || c.external_calendar_id)}${c.is_primary ? " <em>(Primary)</em>" : ""}</span>
          <span class="calendar-list-role">${esc(c.access_role || "")}</span>
          ${c.last_sync_error ? `<span class="calendar-list-error">${esc(c.last_sync_error)}</span>` : ""}
        </label>`).join("")}
    </div>
    <div class="calendar-list-actions">
      <button type="button" class="primary" id="${provider}CalendarSaveBtn">Save Selection</button>
      <span class="calendar-list-status" id="${provider}CalendarSaveStatus"></span>
    </div>`;

  $(`${provider}CalendarSaveBtn`).onclick = async () => {
    const statusEl = $(`${provider}CalendarSaveStatus`);
    const selected = Array.from(panel.querySelectorAll("input[type=checkbox]:checked")).map(el => el.dataset.calId);
    statusEl.textContent = "Saving…";
    try {
      const result = await api(`/api/calendar/connections/${connectionId}/calendars`, {
        method: "PUT",
        body: JSON.stringify({ selectedCalendarIds: selected })
      });
      renderCalendarList(provider, connectionId, result.calendars || []);
      const errCount = (result.errors || []).length;
      $(`${provider}CalendarSaveStatus`).textContent = `Saved. Synced ${result.synced} event${result.synced === 1 ? "" : "s"} across ${result.calendars} calendar${result.calendars === 1 ? "" : "s"}${errCount ? ` — ${errCount} calendar${errCount === 1 ? "" : "s"} had errors (see below).` : "."}`;
      await refreshCalendarMonthEvents();
      if (!hideDashboard) await refreshDashboard({ silent: true });
    } catch (err) {
      statusEl.textContent = err.message;
    }
  };
}

async function syncCalendarNow(id, syncBtn) {
  const msg = $("calendarConnectMessage");
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing...";
  try {
    const result = await api(`/api/calendar/connections/${id}/sync`, { method: "POST" });
    msg.classList.remove("hidden");
    const errCount = (result.errors || []).length;
    msg.className = `calendar-connect-message ${errCount ? "form-error" : "success"}`;
    msg.textContent = errCount
      ? `Synced ${result.synced} event${result.synced === 1 ? "" : "s"} across ${result.calendars} calendar${result.calendars === 1 ? "" : "s"}, but ${errCount} calendar${errCount === 1 ? "" : "s"} failed: ${result.errors.map(e => e.calendar).join(", ")}.`
      : `Synced ${result.synced} event${result.synced === 1 ? "" : "s"} across ${result.calendars} calendar${result.calendars === 1 ? "" : "s"} just now.`;
    await refreshCalendarMonthEvents();
  } catch (err) {
    msg.classList.remove("hidden");
    msg.className = "calendar-connect-message form-error";
    msg.textContent = err.message;
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = "Sync Now";
  }
}

async function disconnectCalendar(id) {
  try {
    await api(`/api/calendar/connections/${id}`, { method: "DELETE" });
    await loadCalendarConnections();
  } catch (err) {
    const msg = $("calendarConnectMessage");
    msg.classList.remove("hidden");
    msg.className = "calendar-connect-message form-error";
    msg.textContent = err.message;
  }
}

async function loadPlaceholderModule(module) {
  const target = $(module + "ModuleMessage");
  if (!target) return;
  try {
    const result = await api(`/api/public/${module}`);
    target.textContent = result.message || `${module} Module Under Development`;
  } catch {
    target.textContent = `${module[0].toUpperCase() + module.slice(1)} Module Under Development`;
  }
}

function setupAuth() {
  $("adminLoginBtn").onclick = () => showLogin();
  $("closeLogin").onclick = () => $("loginModal").classList.add("hidden");

  $("logoutBtn").onclick = async () => {
    const tokenToRevoke = refreshToken;
    clearAuthSession();
    updateAuthUI();
    setPage("dashboard");

    if (tokenToRevoke) {
      try {
        await fetch(API + "/api/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: tokenToRevoke })
        });
      } catch {}
    }
  };

  $("loginForm").onsubmit = async e => {
    e.preventDefault();
    const msg = $("loginMessage");
    msg.textContent = "";
    try {
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: $("loginEmail").value, password: $("loginPassword").value })
      });
      storeAuthSession(result);
      currentUser = result.user || null;
      await loadDashboardPreference();
      updateAuthUI();
      $("loginModal").classList.add("hidden");
      setPage("data");
    } catch (err) {
      msg.className = "form-error";
      msg.textContent = err.message;
    }
  };
}

function showLogin(message = "") {
  const msg = $("loginMessage");
  if (message) {
    msg.className = "form-error";
    msg.textContent = message;
  } else {
    msg.textContent = "";
  }
  $("loginModal").classList.remove("hidden");
}

function updateAuthUI() {
  document.querySelectorAll(".admin-only").forEach(x => x.classList.toggle("hidden", !token));
  $("adminLoginBtn").classList.toggle("hidden", !!token);
  $("logoutBtn").classList.toggle("hidden", !token);
}

function setupDashboardVisibility() {
  $("dashboardVisibilityBtn").onclick = async () => {
    hideDashboard = !hideDashboard;
    localStorage.setItem("ps_hide_dashboard", String(hideDashboard));
    renderDashboardVisibility();

    if (currentUser && token) {
      try {
        await api("/api/admin/preferences/dashboard", {
          method: "PUT",
          body: JSON.stringify({ hideDashboard })
        });
      } catch (err) {
        console.warn("Unable to save dashboard preference:", err.message);
      }
    }

    if (!hideDashboard && currentPage === "dashboard") {
      await refreshCalendarMonthEvents();
      await refreshDashboard();
    }
  };
}

// TV View is a presentation-only toggle (larger text/spacing for viewing from
// a distance) - it does not gate on screen size, since Smart TV browsers can
// report a smaller viewport than their physical resolution. The preference is
// per-browser (localStorage), same pattern as Hide Data.
function setupTvView() {
  $("tvViewBtn").onclick = () => {
    tvView = !tvView;
    localStorage.setItem("ps_tv_view", String(tvView));
    renderTvView();
  };
}

function renderTvView() {
  document.body.classList.toggle("tv-view", tvView);
  const btn = $("tvViewBtn");
  if (btn) {
    btn.textContent = tvView ? "🖥 Exit TV View" : "📺 TV View";
    btn.setAttribute("aria-pressed", String(tvView));
  }
}

async function loadDashboardPreference() {
  if (!currentUser || !token) return;
  try {
    const result = await api("/api/admin/preferences/dashboard");
    hideDashboard = Boolean(result.hideDashboard);
    localStorage.setItem("ps_hide_dashboard", String(hideDashboard));
    renderDashboardVisibility();
  } catch (err) {
    console.warn("Dashboard preference could not be loaded:", err.message);
  }
}

function renderDashboardVisibility() {
  const btn = $("dashboardVisibilityBtn");
  if (btn) btn.textContent = hideDashboard ? "👁 Show Data" : "👁‍🗨 Hide Data";
  $("dashboardContent")?.classList.toggle("hidden", hideDashboard);
  $("dashboardHiddenMessage")?.classList.toggle("hidden", !hideDashboard);
}

async function refreshDashboard({ silent = false } = {}) {
  if (hideDashboard || refreshInFlight) return;
  refreshInFlight = true;
  const notice = $("apiNotice");

  try {
    dashboardData = await api(`/api/public/dashboard?date=${encodeURIComponent(selectedDate)}`);
    notice.classList.add("hidden");
    renderDashboard();
  } catch (err) {
    if (!silent) {
      notice.classList.remove("hidden");
      notice.textContent = "Dashboard API is not connected yet. Configure frontend/config.js and start the Node.js API. " + err.message;
    }
    renderEmptyDashboard();
  } finally {
    refreshInFlight = false;
  }
}

function renderEmptyDashboard() {
  dashboardData = {
    selectedDate, calendar: [], meetings: [], departments: [],
    manpowerImages: [], tasks: [], notes: [], reminders: []
  };
  renderDashboard();
}

function renderDashboard() {
  updateDateLabels();
  renderCalendar();

  const mergedMeetings = [...(dashboardData.meetings || []), ...(dashboardData.calendarEvents || [])];
  // Render every meeting; the #meetingList container fills the card's remaining
  // height and scrolls vertically when the rows exceed the available space.
  $("meetingList").innerHTML = mergedMeetings.map(renderMeetingRow).join("") || emptyCompact("No meetings");

  const d = (dashboardData.departments || [])[0];
  $("departmentSchedule").innerHTML = d
    ? `<div class="lunch-item"><div class="lunch-icon">♟</div><b>${esc(d.department || "")}</b><small>Department</small><span>${esc(d.start || "")} –<br>${esc(d.end || "")}</span><small>${esc(d.location || "")}</small></div>`
    : `<div class="lunch-item"><div class="manpower-image-empty">No lunch schedule</div></div>`;

  $("taskList").innerHTML = (dashboardData.tasks || []).slice(0, 5).map(t =>
    `<div class="task-row"><input type="checkbox" ${t.status === "Completed" ? "checked" : ""} disabled><time>${esc(t.time || "")}</time><span>${esc(t.name || "")}</span><span class="task-status">${esc(t.status || "")}</span></div>`
  ).join("") || emptyCompact("No tasks");

  $("quickNotes").innerHTML = (dashboardData.notes || []).slice(0, 5).map(n =>
    `<p class="note-row">• <strong>${esc(n.title || "")}</strong>${n.description ? ` — ${esc(n.description)}` : ""}</p>`
  ).join("") || emptyCompact("No notes");

  $("reminderList").innerHTML = (dashboardData.reminders || []).slice(0, 5).map(r =>
    `<div class="reminder-row"><time>${esc(r.time || "")}</time><span>•</span><p>${esc(r.description || "")}</p></div>`
  ).join("") || emptyCompact("No reminders");

  renderManpowerImages();
}

function emptyCompact(text) {
  return `<div class="manpower-image-empty">${esc(text)}</div>`;
}

function renderMeetingRow(m) {
  const nameHtml = m.meetingLink
    ? `<a href="${esc(m.meetingLink)}" target="_blank" rel="noopener">${esc(m.name || "")}</a>`
    : esc(m.name || "");
  const tagHtml = m.provider
    ? `<span class="room-tag provider-tag ${m.provider === "GOOGLE" ? "google" : "microsoft"}">${m.provider === "GOOGLE" ? "Meet" : "Teams"}</span>`
    : `<span class="room-tag ${String(m.room || "").includes("2") ? "green" : ""}">${esc(m.room || "")}</span>`;
  // calendarName is only set for a non-primary source calendar (e.g. a shared
  // "Other calendar"), so a primary-calendar row renders exactly as before.
  const subtitleParts = [m.team, m.calendarName].filter(Boolean).map(esc);
  const timeLabel = m.time || (m.allDay ? "All day" : "");
  return `<div class="meeting-row"><b>${esc(timeLabel)}</b><div><strong>${nameHtml}</strong><small>${subtitleParts.join(" • ")}</small></div>${tagHtml}</div>`;
}

async function refreshCalendarMonthEvents() {
  if (hideDashboard) return;
  const month = `${calendarCursor.getFullYear()}-${String(calendarCursor.getMonth() + 1).padStart(2, "0")}`;
  try {
    calendarMonthEvents = await api(`/api/public/calendar?month=${encodeURIComponent(month)}`);
  } catch {
    calendarMonthEvents = [];
  }
  renderCalendar();
}

function renderCalendar() {
  $("calendarMonth").textContent = calendarCursor.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  $("weekRow").innerHTML = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(x => `<span>${x}</span>`).join("");

  const y = calendarCursor.getFullYear();
  const m = calendarCursor.getMonth();
  const first = new Date(y, m, 1).getDay();
  const days = new Date(y, m + 1, 0).getDate();
  const monthEvents = new Map();

  for (const event of calendarMonthEvents || []) {
    const key = normalizeDateValue(event.date);
    if (!monthEvents.has(key)) monthEvents.set(key, []);
    monthEvents.get(key).push(event);
  }

  let html = "";
  for (let i = 0; i < first; i++) html += "<span></span>";
  for (let day = 1; day <= days; day++) {
    const date = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const events = monthEvents.get(date) || [];
    const title = events.length ? events.map(x => x.title).join(" | ") : "Select date";
    html += `<span role="button" tabindex="0" data-date="${date}" class="${date === selectedDate ? "selected" : ""}" title="${escAttr(title)}">${day}</span>`;
  }

  $("calendarGrid").innerHTML = html;
  $("calendarGrid").querySelectorAll("[data-date]").forEach(el => {
    el.onclick = () => selectDashboardDate(el.dataset.date);
    el.onkeydown = e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectDashboardDate(el.dataset.date);
      }
    };
  });

  const selectedEvents = dashboardData?.calendar || [];
  const formatted = dateFromYmd(selectedDate).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" });
  const eventText = selectedEvents.length ? ` • ${selectedEvents.map(x => x.title).join(", ")}` : "";
  $("todayLabel").textContent = formatted + eventText;
}

async function selectDashboardDate(date) {
  selectedDate = date;
  manpowerImageIndex = 0;
  inlineImageZoom = 1;
  localStorage.setItem("ps_selected_date", selectedDate);
  calendarCursor = dateFromYmd(selectedDate);
  updateDateLabels();
  renderCalendar();
  await refreshCalendarMonthEvents();
  await refreshDashboard();
}

function setupCalendarButtons() {
  $("prevMonth").onclick = async () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() - 1, 1);
    await refreshCalendarMonthEvents();
  };
  $("nextMonth").onclick = async () => {
    calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
    await refreshCalendarMonthEvents();
  };
  $("todayBtn").onclick = () => selectDashboardDate(localToday());
}

function renderManpowerImages() {
  const images = dashboardData.manpowerImages || [];
  const viewer = $("manpowerImageViewer");
  if (!viewer) return;

  if (!images.length) {
    manpowerImageIndex = 0;
    inlineImageZoom = 1;
    viewer.innerHTML = `<div class="manpower-image-stage"><div class="manpower-image-empty">No manpower image uploaded for ${esc(formatDashboardDate(selectedDate))}.</div></div>`;
    return;
  }

  if (manpowerImageIndex >= images.length) manpowerImageIndex = 0;
  if (manpowerImageIndex < 0) manpowerImageIndex = images.length - 1;
  const image = images[manpowerImageIndex];

  viewer.innerHTML = `
    <div class="manpower-image-stage">
      <img id="activeManpowerImage" src="${escAttr(image.image_url)}" alt="${escAttr(image.title || "Manpower image")}" loading="eager">
    </div>
    <div class="manpower-image-footer">
      <div class="manpower-image-meta">
        <b>${esc(image.title || "Manpower Image")}</b>
        ${image.description ? `<p>${esc(image.description)}</p>` : ""}
      </div>
      <div class="manpower-image-controls">
        <button id="manpowerPrevImage" type="button" ${images.length < 2 ? "disabled" : ""}>← Previous</button>
        <span class="image-counter">${manpowerImageIndex + 1} / ${images.length}</span>
        <button id="manpowerNextImage" type="button" ${images.length < 2 ? "disabled" : ""}>Next →</button>
        <button id="manpowerZoomOut" type="button">− Zoom</button>
        <button id="manpowerZoomIn" type="button">+ Zoom</button>
        <button id="manpowerFullscreen" type="button">Full Screen</button>
        <button id="manpowerDownload" type="button">Download</button>
      </div>
    </div>`;

  applyInlineImageZoom();
  $("activeManpowerImage").onclick = () => openImageViewer(image);

  $("manpowerPrevImage").onclick = () => {
    if (images.length < 2) return;
    manpowerImageIndex = (manpowerImageIndex - 1 + images.length) % images.length;
    inlineImageZoom = 1;
    renderManpowerImages();
  };
  $("manpowerNextImage").onclick = () => {
    if (images.length < 2) return;
    manpowerImageIndex = (manpowerImageIndex + 1) % images.length;
    inlineImageZoom = 1;
    renderManpowerImages();
  };
  $("manpowerZoomIn").onclick = () => { inlineImageZoom = Math.min(3, inlineImageZoom + .2); applyInlineImageZoom(); };
  $("manpowerZoomOut").onclick = () => { inlineImageZoom = Math.max(.5, inlineImageZoom - .2); applyInlineImageZoom(); };
  $("manpowerFullscreen").onclick = () => openImageViewer(image, true);
  $("manpowerDownload").onclick = () => downloadImage(image.id, image.image_url, image.title);
}

function applyInlineImageZoom() {
  const img = $("activeManpowerImage");
  if (img) img.style.transform = `scale(${inlineImageZoom})`;
}

function openImageViewer(image, fullscreen = false) {
  const modal = ensureImageViewerModal();
  imageZoom = 1;
  modal.dataset.imageId = image.id || "";
  modal.dataset.imageUrl = image.image_url || "";
  modal.dataset.imageTitle = image.title || "Manpower Image";
  modal.querySelector("[data-image-title]").textContent = image.title || "Manpower Image";
  const img = modal.querySelector("[data-image-preview]");
  img.src = image.image_url;
  img.alt = image.title || "Manpower Image";
  applyImageZoom(modal);
  modal.classList.remove("hidden");

  if (fullscreen) {
    setTimeout(async () => {
      try { if (!document.fullscreenElement) await modal.requestFullscreen(); } catch {}
    }, 0);
  }
}

function ensureImageViewerModal() {
  let modal = $("imageViewerModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "imageViewerModal";
  modal.className = "image-viewer-modal hidden";
  modal.innerHTML = `
    <div class="image-viewer-toolbar">
      <strong data-image-title>Manpower Image</strong>
      <button type="button" data-zoom-out>− Zoom Out</button>
      <button type="button" data-zoom-in>+ Zoom In</button>
      <button type="button" data-fullscreen>Full Screen</button>
      <button type="button" data-download>Download</button>
      <button type="button" data-close>Close</button>
    </div>
    <div class="image-viewer-canvas"><img data-image-preview alt="Manpower Image"></div>`;
  document.body.appendChild(modal);

  modal.querySelector("[data-close]").onclick = async () => {
    if (document.fullscreenElement === modal) {
      try { await document.exitFullscreen(); } catch {}
    }
    modal.classList.add("hidden");
  };
  modal.querySelector("[data-zoom-in]").onclick = () => { imageZoom = Math.min(4, imageZoom + .25); applyImageZoom(modal); };
  modal.querySelector("[data-zoom-out]").onclick = () => { imageZoom = Math.max(.25, imageZoom - .25); applyImageZoom(modal); };
  modal.querySelector("[data-fullscreen]").onclick = async () => {
    try {
      if (!document.fullscreenElement) await modal.requestFullscreen();
      else await document.exitFullscreen();
    } catch {}
  };
  modal.querySelector("[data-download]").onclick = () => downloadImage(modal.dataset.imageId, modal.dataset.imageUrl, modal.dataset.imageTitle);
  modal.addEventListener("click", e => { if (e.target === modal) modal.classList.add("hidden"); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !modal.classList.contains("hidden")) modal.classList.add("hidden"); });
  return modal;
}

function applyImageZoom(modal) {
  modal.querySelector("[data-image-preview]").style.transform = `scale(${imageZoom})`;
}

async function downloadImage(id, url, title) {
  if (!url) return;
  try {
    const downloadUrl = id ? `${API}/api/public/manpower-images/${encodeURIComponent(id)}/download` : url;
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error("Download failed");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `${safeFileName(title || "manpower-image")}.${imageExtension(blob.type)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function safeFileName(value) {
  return String(value || "image").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "image";
}
function imageExtension(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

function setupViewAllControls() {
  const meetingLink = document.querySelector(".meeting-card .card-title a");
  const departmentLink = document.querySelector(".lunch-card .card-title a");
  const reminderLink = document.querySelector(".view-reminders");

  if (meetingLink) meetingLink.onclick = e => { e.preventDefault(); openDetailView("meetings", "Meeting Schedule"); };
  if (departmentLink) departmentLink.onclick = e => { e.preventDefault(); openDetailView("departments", "Department Schedule"); };
  if (reminderLink) reminderLink.onclick = e => { e.preventDefault(); openDetailView("reminders", "Reminders"); };

  bindHeadingDetail(document.querySelector(".tasks-card .card-title"), "tasks", "Tasks");
  bindHeadingDetail(document.querySelector(".notes-card .card-title"), "notes", "Notes");
}

function bindHeadingDetail(el, module, title) {
  if (!el) return;
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.setAttribute("title", `View all ${title.toLowerCase()} for selected date`);
  el.onclick = () => openDetailView(module, title);
  el.onkeydown = e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetailView(module, title);
    }
  };
}

async function openDetailView(module, title) {
  const modal = ensureDetailModal();
  modal.querySelector("[data-detail-title]").textContent = title;
  modal.querySelector("[data-detail-date]").textContent = formatDashboardDate(selectedDate);
  const bodyEl = modal.querySelector("[data-detail-body]");
  bodyEl.innerHTML = "<p>Loading...</p>";
  modal.classList.remove("hidden");

  try {
    const result = await api(`/api/public/details/${encodeURIComponent(module)}?date=${encodeURIComponent(selectedDate)}`);
    bodyEl.innerHTML = renderDetailRows(module, result.rows || []);
  } catch (err) {
    bodyEl.innerHTML = `<div class="form-error">${esc(err.message)}</div>`;
  }
}

function ensureDetailModal() {
  let modal = $("detailModal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "detailModal";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-card" style="width:min(760px,92vw);max-height:82vh;overflow:auto">
      <button type="button" class="close-btn" data-detail-close>×</button>
      <h2 data-detail-title>Details</h2>
      <p data-detail-date></p>
      <div data-detail-body></div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector("[data-detail-close]").onclick = () => modal.classList.add("hidden");
  modal.onclick = e => { if (e.target === modal) modal.classList.add("hidden"); };
  return modal;
}

function renderDetailRows(module, rows) {
  if (!rows.length) return `<p>No records found for ${esc(formatDashboardDate(selectedDate))}.</p>`;
  if (module === "meetings") {
    return rows.map(renderMeetingRow).join("");
  }
  if (module === "departments") {
    return rows.map(r => `<div class="meeting-row"><b>${esc(r.start || "")}</b><div><strong>${esc(r.department || "")}</strong><small>${esc(r.start || "")} – ${esc(r.end || "")}</small></div><span class="room-tag">${esc(r.location || "")}</span></div>`).join("");
  }
  if (module === "tasks") {
    return rows.map(r => `<div class="task-row"><input type="checkbox" ${r.status === "Completed" ? "checked" : ""} disabled><time>${esc(r.time || "")}</time><span>${esc(r.name || "")}</span><span class="task-status">${esc(r.status || "")}</span></div>`).join("");
  }
  if (module === "notes") {
    return rows.map(r => `<p class="note-row">• <strong>${esc(r.title || "")}</strong>${r.description ? ` — ${esc(r.description)}` : ""}</p>`).join("");
  }
  if (module === "reminders") {
    return rows.map(r => `<div class="reminder-row"><time>${esc(r.time || "")}</time><span>•</span><p>${esc(r.description || "")}</p></div>`).join("");
  }
  return rows.map(r => `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`).join("");
}

function updateDateLabels() {
  const label = formatDashboardDate(selectedDate);
  document.querySelectorAll("[data-dashboard-date]").forEach(el => el.textContent = label);
  if (currentPage === "dashboard") $("pageSubheading").textContent = `Overview • ${label}`;
}

function isArApTab(tab) {
  return tab === "receivables" || tab === "payables";
}

function setupDataTabs() {
  $("dataTabs").innerHTML = Object.entries(dataModules).map(([k, v]) =>
    `<button data-key="${k}" class="${k === currentDataTab ? "active" : ""}">${v.label}</button>`
  ).join("");

  $("dataTabs").querySelectorAll("button").forEach(b => b.onclick = () => {
    currentDataTab = b.dataset.key;
    editingId = null;
    setupDataTabs();
    syncDataPageMode();
  });

  $("recordSearch").oninput = loadRecords;
  $("bulkUploadBtn").onclick = bulkUpload;
  $("downloadTemplateBtn").onclick = downloadTemplate;
  updateArApTabCounts();
}

// Receivables/Payables get their own bulk-editable grid + upload panel
// (#arApPanel) instead of the generic single-row form + records table, since
// they're bulk invoice data rather than one-record-per-day admin entries.
function syncDataPageMode() {
  const isArAp = isArApTab(currentDataTab);
  document.querySelector(".data-layout").classList.toggle("hidden", isArAp);
  document.querySelector(".records-card").classList.toggle("hidden", isArAp);
  $("arApPanel").classList.toggle("hidden", !isArAp);

  if (isArAp) {
    updateArApBulkTargetBadge();
    loadArApRecords();
  } else {
    renderDataForm();
    updateBulkPanel();
    loadRecords();
  }
}

function renderDataForm(record = {}) {
  const mod = dataModules[currentDataTab];
  $("dataFormTitle").textContent = mod.label;

  const fields = mod.fields.map(f => {
    let value = record[f.name] ?? "";
    if (f.type === "date") value = value ? normalizeDateValue(value) : selectedDate;

    let control;
    if (f.type === "textarea") {
      control = `<textarea name="${f.name}" ${f.required ? "required" : ""}>${esc(value)}</textarea>`;
    } else if (f.type === "select") {
      control = `<select name="${f.name}" ${f.required ? "required" : ""}>${f.options.map(o => `<option ${String(value) === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    } else if (f.type === "file") {
      const required = f.required && !editingId;
      const current = editingId && record.image_url ? `<div class="image-file-hint">Current image: <a class="image-record-link" href="${escAttr(record.image_url)}" target="_blank" rel="noopener">View image</a>. Upload a new file only to replace it.</div>` : "";
      control = `<input name="${f.name}" type="file" accept="${escAttr(f.accept || "")}" ${required ? "required" : ""}>${current}`;
    } else {
      control = `<input name="${f.name}" type="${f.type}" value="${escAttr(value)}" ${f.required ? "required" : ""}>`;
    }
    return `<label>${f.label}${control}</label>`;
  }).join("");

  $("dynamicDataForm").innerHTML = `<div class="dynamic-field-grid">${fields}</div><button class="primary">${editingId ? "Save Changes" : "Add Data"}</button>${editingId ? '<button type="button" id="cancelEdit" class="outline" style="margin-left:8px">Cancel</button>' : ""}`;
  $("dynamicDataForm").onsubmit = saveRecord;
  const cancel = $("cancelEdit");
  if (cancel) cancel.onclick = () => { editingId = null; renderDataForm(); };
}

async function saveRecord(e) {
  e.preventDefault();
  const mod = dataModules[currentDataTab];
  const formData = new FormData($("dynamicDataForm"));
  const isMultipart = mod.fields.some(f => f.type === "file");

  try {
    if (isMultipart) {
      if (editingId) {
        const file = formData.get("image");
        if (file && file.size === 0) formData.delete("image");
        await api(`/api/admin/${mod.endpoint}/${editingId}`, { method: "PUT", body: formData });
      } else {
        await api(`/api/admin/${mod.endpoint}`, { method: "POST", body: formData });
      }
    } else {
      const body = Object.fromEntries(formData.entries());
      mod.fields.filter(f => f.type === "number").forEach(f => body[f.name] = Number(body[f.name]));
      if (editingId) await api(`/api/admin/${mod.endpoint}/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
      else await api(`/api/admin/${mod.endpoint}`, { method: "POST", body: JSON.stringify(body) });
    }

    $("formMessage").className = "form-success";
    $("formMessage").textContent = editingId ? "Data updated successfully." : "Data saved successfully.";
    editingId = null;
    renderDataForm();
    await loadRecords();
    if (!hideDashboard) {
      await refreshCalendarMonthEvents();
      await refreshDashboard({ silent: true });
    }
  } catch (err) {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = err.message;
  }
}

async function loadRecords() {
  if (!token) return;
  const mod = dataModules[currentDataTab];

  try {
    let rows = await api(`/api/admin/${mod.endpoint}`);
    const q = $("recordSearch").value.trim().toLowerCase();
    if (q) rows = rows.filter(r => JSON.stringify(r).toLowerCase().includes(q));

    const cols = mod.tableFields || ["id", ...mod.fields.filter(f => f.type !== "file").map(f => f.name)];
    $("recordsTable").innerHTML = `<thead><tr>${cols.map(c => `<th>${esc(c)}</th>`).join("")}<th>Actions</th></tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td>${renderRecordCell(c, r[c], r)}</td>`).join("")}<td><button class="table-action edit-btn" data-id="${r.id}">Edit</button><button class="table-action delete delete-btn" data-id="${r.id}">Delete</button></td></tr>`).join("")}</tbody>`;

    $("recordsTable").querySelectorAll(".edit-btn").forEach(btn => btn.onclick = () => {
      const record = rows.find(r => r.id === btn.dataset.id);
      if (!record) return;
      editingId = record.id;
      renderDataForm(record);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("recordsTable").querySelectorAll(".delete-btn").forEach(btn => btn.onclick = () => deleteRecord(btn.dataset.id));
  } catch (err) {
    $("recordsTable").innerHTML = `<tbody><tr><td>${esc(err.message)}</td></tr></tbody>`;
  }
}

async function deleteRecord(id) {
  if (!confirm("Delete this record?")) return;
  try {
    await api(`/api/admin/${dataModules[currentDataTab].endpoint}/${id}`, { method: "DELETE" });
    $("formMessage").className = "form-success";
    $("formMessage").textContent = "Record deleted successfully.";
    await loadRecords();
    if (!hideDashboard) {
      await refreshCalendarMonthEvents();
      await refreshDashboard({ silent: true });
    }
  } catch (err) {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = err.message;
  }
}

function updateBulkPanel() {
  const mod = dataModules[currentDataTab];
  const bulk = document.querySelector(".bulk-card");
  const layout = document.querySelector(".data-layout");
  if (bulk) bulk.classList.toggle("hidden", !!mod.noBulk);
  if (layout) layout.classList.toggle("image-upload-mode", !!mod.noBulk);
}

function renderRecordCell(column, value, row) {
  if (column === "image_url" && value) {
    return `<a class="image-record-link" href="${escAttr(value)}" target="_blank" rel="noopener"><img class="image-record-thumb" src="${escAttr(value)}" alt="${escAttr(row.title || "Image")}"> View</a>`;
  }
  return esc(formatCell(value));
}

function downloadTemplate() {
  const mod = dataModules[currentDataTab];
  if (mod.noBulk) return;
  const csv = mod.fields.filter(f => f.type !== "file").map(f => f.name).join(",") + "\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentDataTab}_template.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function bulkUpload() {
  if (dataModules[currentDataTab].noBulk) return;
  const file = $("bulkFile").files[0];
  if (!file) return alert("Select a CSV file first.");
  const form = new FormData();
  form.append("file", file);

  try {
    const result = await api(`/api/admin/${dataModules[currentDataTab].endpoint}/bulk`, { method: "POST", body: form });
    $("formMessage").className = "form-success";
    $("formMessage").textContent = `${result.inserted} rows uploaded successfully.`;
    $("bulkFile").value = "";
    await loadRecords();
    if (!hideDashboard) {
      await refreshCalendarMonthEvents();
      await refreshDashboard({ silent: true });
    }
  } catch (err) {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = err.message;
  }
}

function setupReports() {
  document.querySelectorAll(".report-btn").forEach(btn => btn.onclick = async () => {
    try {
      const data = await api(`/api/public/reports?type=${encodeURIComponent(btn.dataset.type)}&date=${encodeURIComponent(selectedDate)}`);
      $("reportPreview").textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      $("reportPreview").textContent = err.message;
    }
  });
}

function formatDashboardDate(value) {
  const d = dateFromYmd(value);
  const day = String(d.getDate()).padStart(2, "0");
  const month = d.toLocaleDateString("en-US", { month: "short" });
  return `${day}-${month}-${d.getFullYear()}`;
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dateFromYmd(value) {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function normalizeDateValue(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function formatCell(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m]));
}
function escAttr(v) { return esc(v); }


/* ------------------------------------------------------------------ *
 * Accounts module - Receivables & Payables aging dashboard
 * Accounts page (#accountsPage): read-only, fetches /api/public/receivables
 * and /api/public/payables, computes aging/KPIs/DSO/trend client-side.
 * Data page (#dataPage, tabs "receivables"/"payables"): bulk-editable grid +
 * spreadsheet bulk-upload, backed by /api/admin/receivables|payables.
 * ------------------------------------------------------------------ */

function fmtCr(n) {
  return "₹ " + (Number(n) / 1e7).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " Cr";
}
function arApDaysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

const AR_AP_BUCKETS = [
  { label: "0", hi: 30 },
  { label: "30", hi: 45 },
  { label: "45", hi: 60 },
  { label: "60", hi: 120 },
  { label: "120", hi: null }
];
function arApBucketFor(days) {
  if (days <= 30) return 0;
  if (days <= 45) return 1;
  if (days <= 60) return 2;
  if (days <= 120) return 3;
  return 4;
}
// byCust buckets/invoiced sums rely on JS's `null` coercing to 0 in `+=` so a
// row with a missing (null) Balance simply contributes nothing to aging.
function arApComputeAging(rows, asOf) {
  const byCust = {};
  rows.forEach(r => {
    const days = arApDaysBetween(r.due, asOf);
    const bi = arApBucketFor(days);
    if (!byCust[r.customer]) byCust[r.customer] = { buckets: [0, 0, 0, 0, 0], invoiced: 0 };
    byCust[r.customer].buckets[bi] += r.balance;
    byCust[r.customer].invoiced += r.amount;
  });
  const list = Object.entries(byCust).map(([customer, o]) => {
    const total = o.buckets.reduce((s, v) => s + v, 0);
    return { customer, buckets: o.buckets, total, invoiced: o.invoiced };
  });
  list.sort((a, b) => a.total - b.total);
  return list;
}

const AR_AP_BAND_COLORS = ["#e05a5a", "#e8c547", "#4fc98a"]; // low=red, medium=yellow, high=green
function arApTotalBand(v, lo, hi) {
  if (hi === lo) return 0;
  const t = (v - lo) / (hi - lo);
  return t < 1 / 3 ? 0 : (t < 2 / 3 ? 1 : 2);
}

function arApRenderAgingTable(elId, rows, asOf, labelCol) {
  const el = $(elId);
  el.innerHTML = "";
  const agg = arApComputeAging(rows, asOf).slice().sort((a, b) => a.invoiced - b.invoiced);

  const thead = document.createElement("tr");
  thead.innerHTML = `<th>${esc(labelCol)}</th>` + AR_AP_BUCKETS.map(b => `<th class="num">${esc(b.label)}</th>`).join("") +
    `<th class="num">Total Amount</th><th class="num">Balance</th>`;
  el.appendChild(thead);

  if (!agg.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" class="ar-ap-empty-row">No data yet</td>`;
    el.appendChild(tr);
  }

  const totVals = agg.map(r => r.invoiced);
  const bandLo = totVals.length ? Math.min(...totVals) : 0;
  const bandHi = totVals.length ? Math.max(...totVals) : 0;

  agg.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(r.customer)}</td>` +
      r.buckets.map(v => `<td class="num">${esc(fmtCr(v))}</td>`).join("") +
      `<td class="num ar-ap-band" style="background:${AR_AP_BAND_COLORS[arApTotalBand(r.invoiced, bandLo, bandHi)]}">${esc(fmtCr(r.invoiced))}</td>` +
      `<td class="num">${esc(fmtCr(r.total))}</td>`;
    el.appendChild(tr);
  });

  const totals = [0, 0, 0, 0, 0];
  let grandInvoiced = 0;
  agg.forEach(r => { r.buckets.forEach((v, i) => { totals[i] += v; }); grandInvoiced += r.invoiced; });
  const grand = totals.reduce((s, v) => s + v, 0);
  const totRow = document.createElement("tr");
  totRow.className = "totalrow";
  totRow.innerHTML = `<td>Total</td>` + totals.map(v => `<td class="num">${esc(fmtCr(v))}</td>`).join("") +
    `<td class="num">${esc(fmtCr(grandInvoiced))}</td>` + `<td class="num">${esc(fmtCr(grand))}</td>`;
  el.appendChild(totRow);
  return grand;
}

function arApRenderKpis(recv, pay, recvTotal, payTotal, asOf) {
  const totalInvoiced = recv.reduce((s, r) => s + r.amount, 0);
  const custCount = new Set(recv.filter(r => (r.balance || 0) > 0).map(r => r.customer)).size;
  const overdue60 = recv.filter(r => arApDaysBetween(r.due, asOf) > 60).reduce((s, r) => s + (r.balance || 0), 0);
  const cards = [
    ["Total Receivables Outstanding", fmtCr(recvTotal)],
    ["Total Payables Outstanding", fmtCr(payTotal)],
    ["Net Position (Recv − Pay)", fmtCr(recvTotal - payTotal)],
    ["Total Invoiced (Receivables)", fmtCr(totalInvoiced)],
    ["Customers with Balance", String(custCount)],
    ["Overdue > 60 Days", fmtCr(overdue60)]
  ];
  $("arApKpiRow").innerHTML = cards.map(([label, val]) => `
    <article class="card accounts-kpi-card">
      <h3 class="accounts-kpi-title">${esc(label)}</h3>
      <div class="accounts-kpi-value">${esc(val)}</div>
    </article>`).join("");

  const collected = totalInvoiced - recvTotal;
  const collectionEff = totalInvoiced > 0 ? (collected / totalInvoiced * 100) : 0;
  const overdueAny = recv.filter(r => arApDaysBetween(r.due, asOf) > 0 && (r.balance || 0) > 0).reduce((s, r) => s + (r.balance || 0), 0);
  const overduePct = recvTotal > 0 ? (overdueAny / recvTotal * 100) : 0;
  let periodDays = 365;
  const fromV = $("arApFromDate").value, toV = $("arApToDate").value;
  if (fromV && toV) periodDays = Math.max(1, arApDaysBetween(fromV, toV) + 1);
  const dso = totalInvoiced > 0 ? (recvTotal / totalInvoiced * periodDays) : 0;
  const agg = arApComputeAging(recv, asOf);
  const topCust = agg.length ? agg.reduce((a, b) => (b.total > a.total ? b : a)) : null;
  const concentration = (recvTotal > 0 && topCust) ? (topCust.total / recvTotal * 100) : 0;
  const invoiceCount = recv.length;
  const avgInvoice = invoiceCount > 0 ? totalInvoiced / invoiceCount : 0;

  const ceo = [
    ["Collection Efficiency", collectionEff.toFixed(1) + "%", collectionEff >= 70 ? "up" : "down"],
    ["Total Collected", esc(fmtCr(collected)), ""],
    ["DSO (Days Sales Outstanding)", Math.round(dso) + " days", dso <= 60 ? "up" : "down"],
    ["Overdue % of Outstanding", overduePct.toFixed(1) + "%", overduePct <= 30 ? "up" : "down"],
    ["Top Customer Concentration", concentration.toFixed(1) + "%" + (topCust ? `<div class="accounts-kpi-sub">${esc(topCust.customer)}</div>` : ""), concentration <= 25 ? "up" : "down"],
    ["Invoices / Avg Size", `${invoiceCount} / ${esc(fmtCr(avgInvoice))}`, ""]
  ];
  const toneColor = tone => (tone === "up" ? "var(--green)" : tone === "down" ? "var(--red)" : "var(--blue)");
  $("arApCeoKpiRow").innerHTML = ceo.map(([label, val, tone]) => `
    <article class="card accounts-kpi-card" style="border-left:3px solid ${toneColor(tone)}">
      <h3 class="accounts-kpi-title">${esc(label)}</h3>
      <div class="accounts-kpi-value">${val}</div>
    </article>`).join("");
}

let arApTrendChart;
function arApRenderTrend(recv, pay) {
  const monthKey = d => d.slice(0, 7);
  const recvByMonth = {}, payByMonth = {};
  recv.forEach(r => { const k = monthKey(r.date); recvByMonth[k] = (recvByMonth[k] || 0) + r.amount; });
  pay.forEach(r => { const k = monthKey(r.date); payByMonth[k] = (payByMonth[k] || 0) + r.amount; });
  const months = Array.from(new Set([...Object.keys(recvByMonth), ...Object.keys(payByMonth)])).sort();
  const finalMonths = months.length ? months : [localToday().slice(0, 7)];
  const recvData = finalMonths.map(m => recvByMonth[m] || 0);
  const payData = finalMonths.map(m => payByMonth[m] || 0);

  if (typeof Chart === "undefined") {
    console.warn("Chart.js did not load; Receivables/Payables trend chart skipped.");
    return;
  }
  if (arApTrendChart) arApTrendChart.destroy();
  arApTrendChart = new Chart($("arApTrendChart"), {
    type: "line",
    data: {
      labels: finalMonths,
      datasets: [
        { label: "Receivables", data: recvData, borderColor: "#3B82F6", backgroundColor: "rgba(59,130,246,.12)", borderWidth: 2, tension: .25, pointRadius: 2 },
        { label: "Payables", data: payData, borderColor: "#EF4444", backgroundColor: "rgba(239,68,68,.12)", borderWidth: 2, borderDash: [5, 3], tension: .25, pointRadius: 2 }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: "#9CA3AF" } } },
      scales: {
        x: { ticks: { color: "#9CA3AF", maxRotation: 60, minRotation: 60 }, grid: { display: false } },
        y: { ticks: { color: "#9CA3AF", callback: v => "₹" + (v / 1e7).toFixed(1) + "Cr" }, grid: { color: "#1F2937" } }
      }
    }
  });
}

/* ---------------- Accounts page: fetch + filter + render ---------------- */

let arApDashboard = { receivables: [], payables: [] };

function setArApView(view) {
  $("accountsLoading").classList.toggle("hidden", view !== "loading");
  $("accountsEmpty").classList.toggle("hidden", view !== "empty");
  $("accountsDashboard").classList.toggle("hidden", view !== "dashboard");
}

async function loadArApDashboard() {
  setArApView("loading");
  $("accountsError").classList.add("hidden");
  try {
    const [recvResult, payResult] = await Promise.all([
      api("/api/public/receivables"),
      api("/api/public/payables")
    ]);
    arApDashboard.receivables = recvResult.rows || [];
    arApDashboard.payables = payResult.rows || [];

    if (!arApDashboard.receivables.length && !arApDashboard.payables.length) {
      setArApView("empty");
      return;
    }
    setArApView("dashboard");
    initArApFilters();
  } catch (err) {
    arApDashboard = { receivables: [], payables: [] };
    setArApView("empty");
    const notice = $("accountsError");
    notice.classList.remove("hidden");
    notice.textContent = "Accounts data could not be loaded. " + err.message;
  }
}

function initArApFilters() {
  const fy = $("arApFySelect"), from = $("arApFromDate"), to = $("arApToDate"), asOf = $("arApAsOfDate");
  if (!asOf.value) asOf.value = localToday();

  fy.onchange = () => {
    const v = fy.value;
    if (v === "all") { from.value = ""; to.value = ""; }
    else if (v !== "custom") {
      const y = parseInt(v, 10);
      from.value = `${y}-04-01`;
      to.value = `${y + 1}-03-31`;
    }
    renderArApAccounts();
  };
  from.oninput = () => { fy.value = "custom"; renderArApAccounts(); };
  to.oninput = () => { fy.value = "custom"; renderArApAccounts(); };
  asOf.oninput = renderArApAccounts;

  renderArApAccounts();
}

function arApInRange(r) {
  const f = $("arApFromDate").value, t = $("arApToDate").value;
  if (f && r.date < f) return false;
  if (t && r.date > t) return false;
  return true;
}

function renderArApAccounts() {
  const asOf = $("arApAsOfDate").value || localToday();
  const recv = arApDashboard.receivables.filter(arApInRange);
  const pay = arApDashboard.payables.filter(arApInRange);

  const recvTotal = arApRenderAgingTable("recvAgingTable", recv, asOf, "Customer");
  const payTotal = arApRenderAgingTable("payAgingTable", pay, asOf, "Vendor");
  arApRenderKpis(recv, pay, recvTotal, payTotal, asOf);
  arApRenderTrend(recv, pay);
}

/* ---------------- Data page: editable grid ---------------- */

let arApEditRows = [];

function updateArApBulkTargetBadge() {
  const which = currentDataTab === "payables" ? "Payables" : "Receivables";
  $("arApBulkTargetBadge").textContent = "→ " + which;
  $("arApDataTitle").textContent = currentDataTab === "payables" ? "Payables — raw vendor bills" : "Receivables — raw invoices";
}

async function updateArApTabCounts() {
  if (!token) return;
  try {
    const [recv, pay] = await Promise.all([api("/api/admin/receivables"), api("/api/admin/payables")]);
    const rBtn = document.querySelector('#dataTabs button[data-key="receivables"]');
    const pBtn = document.querySelector('#dataTabs button[data-key="payables"]');
    if (rBtn) rBtn.textContent = `Receivables Data (${recv.length})`;
    if (pBtn) pBtn.textContent = `Payables Data (${pay.length})`;
  } catch {
    // best-effort; tab labels just keep their previous text
  }
}

async function loadArApRecords() {
  if (!token) return;
  updateArApBulkTargetBadge();
  const endpoint = dataModules[currentDataTab].endpoint;
  const isPayables = currentDataTab === "payables";
  try {
    const rows = await api(`/api/admin/${endpoint}`);
    arApEditRows = rows.map(r => ({
      id: r.id,
      customer: isPayables ? r.vendor_name : r.customer_name,
      date: normalizeDateValue(r.invoice_date),
      due: normalizeDateValue(r.due_date),
      amount: r.invoice_amount === null || r.invoice_amount === undefined ? null : Number(r.invoice_amount),
      balance: r.balance === null || r.balance === undefined ? null : Number(r.balance)
    }));
    arApRenderDataTable();
  } catch (err) {
    $("arApDataTable").innerHTML = `<tbody><tr><td>${esc(err.message)}</td></tr></tbody>`;
  }
  updateArApTabCounts();
}

function arApRenderDataTable() {
  const el = $("arApDataTable");
  el.innerHTML = "";
  const nameLabel = currentDataTab === "payables" ? "Vendor" : "Customer";

  const thead = document.createElement("tr");
  thead.innerHTML = `<th>${esc(nameLabel)}</th><th>Invoice Date</th><th>Due Date</th><th class="num">Amount</th><th class="num">Balance</th><th></th>`;
  el.appendChild(thead);

  arApEditRows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input value="${escAttr(r.customer)}" data-f="customer"></td>
      <td><input type="date" value="${escAttr(r.date || "")}" data-f="date"></td>
      <td><input type="date" value="${escAttr(r.due || "")}" data-f="due"></td>
      <td><input type="number" step="0.01" value="${r.amount === null || r.amount === undefined ? "" : r.amount}" data-f="amount" style="text-align:right"></td>
      <td><input type="number" step="0.01" value="${r.balance === null || r.balance === undefined ? "" : r.balance}" data-f="balance" style="text-align:right"></td>
      <td><button type="button" class="table-action delete">Remove</button></td>`;
    tr.querySelectorAll("input").forEach(inp => { inp.onblur = () => arApSaveRow(i, inp.dataset.f, inp.value); });
    tr.querySelector(".table-action.delete").onclick = () => arApRemoveRow(i);
    el.appendChild(tr);
  });
}

async function arApSaveRow(index, field, rawValue) {
  const row = arApEditRows[index];
  if (!row) return;
  const value = (field === "amount" || field === "balance")
    ? (String(rawValue).trim() === "" ? null : (isNaN(parseFloat(rawValue)) ? null : parseFloat(rawValue)))
    : rawValue;
  if (row[field] === value) return; // unchanged on this blur - skip the write
  row[field] = value;

  const endpoint = dataModules[currentDataTab].endpoint;
  const nameField = currentDataTab === "payables" ? "vendor_name" : "customer_name";
  const body = { [nameField]: row.customer, invoice_date: row.date, due_date: row.due, invoice_amount: row.amount, balance: row.balance };
  try {
    await api(`/api/admin/${endpoint}/${row.id}`, { method: "PUT", body: JSON.stringify(body) });
  } catch (err) {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = err.message;
  }
}

async function arApAddRow() {
  const endpoint = dataModules[currentDataTab].endpoint;
  const isPayables = currentDataTab === "payables";
  const nameField = isPayables ? "vendor_name" : "customer_name";
  const today = localToday();
  const dueDate = dateFromYmd(today);
  dueDate.setDate(dueDate.getDate() + 30);
  const due = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, "0")}-${String(dueDate.getDate()).padStart(2, "0")}`;
  const body = { [nameField]: isPayables ? "New Vendor" : "New Customer", invoice_date: today, due_date: due, invoice_amount: 0, balance: 0 };

  try {
    await api(`/api/admin/${endpoint}`, { method: "POST", body: JSON.stringify(body) });
    await loadArApRecords();
    $("formMessage").className = "form-success";
    $("formMessage").textContent = "Row added — edit the name, dates and amount below.";
  } catch (err) {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = err.message;
  }
}

async function arApRemoveRow(index) {
  const row = arApEditRows[index];
  if (!row) return;
  const endpoint = dataModules[currentDataTab].endpoint;
  try {
    await api(`/api/admin/${endpoint}/${row.id}`, { method: "DELETE" });
    await loadArApRecords();
  } catch (err) {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = err.message;
  }
}

/* ---------------- Data page: bulk upload (.xlsx/.xls/.csv) ---------------- */

function arApTemplateCols() {
  return ["Date", currentDataTab === "payables" ? "Vendor Name" : "Customer Name", "Due Date", "Invoice Amount", "Balance"];
}

function arApDownloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function arApDownloadTemplate(fmt) {
  const cols = arApTemplateCols();
  const which = currentDataTab === "payables" ? "payables" : "receivables";
  const base = which + "-template";
  if (fmt === "csv") {
    const csv = "﻿" + cols.join(",") + "\r\n"; // BOM so Excel opens it as UTF-8
    arApDownloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), base + ".csv");
    return;
  }
  if (typeof XLSX === "undefined") {
    $("formMessage").className = "form-error";
    $("formMessage").textContent = "Spreadsheet library not loaded — cannot build .xlsx/.xls template (check internet access). CSV still works.";
    return;
  }
  const ws = XLSX.utils.aoa_to_sheet([cols]);
  ws["!cols"] = [{ wch: 14 }, { wch: 40 }, { wch: 14 }, { wch: 16 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, which === "payables" ? "Payables" : "Receivables");
  XLSX.writeFile(wb, `${base}.${fmt}`, { bookType: fmt }); // genuine XLSX (zip) or BIFF8 XLS, not a renamed file
}

const arApPad2 = n => String(n).padStart(2, "0");
function arApIsoFromYMD(y, m, d) {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${arApPad2(m)}-${arApPad2(d)}`;
}
function arApParseDateCell(v) {
  if (v === null || v === undefined || v === "") return { iso: null, missing: true };
  if (v instanceof Date) {
    if (isNaN(v)) return { iso: null };
    return { iso: arApIsoFromYMD(v.getFullYear(), v.getMonth() + 1, v.getDate()) }; // native Excel date cell
  }
  if (typeof v === "number") {
    if (v > 0 && v < 2958466 && typeof XLSX !== "undefined") {
      const p = XLSX.SSF.parse_date_code(v);
      return { iso: p ? arApIsoFromYMD(p.y, p.m, p.d) : null };
    }
    return { iso: null };
  }
  const str = String(v).trim();
  let m;
  if ((m = str.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) return { iso: arApIsoFromYMD(+m[3], +m[2], +m[1]) }; // DD-MM-YYYY
  if ((m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) return { iso: arApIsoFromYMD(+m[1], +m[2], +m[3]) }; // ISO
  return { iso: null };
}
function arApParseAmountCell(v) {
  if (v === null || v === undefined) return { val: null, missing: true };
  if (typeof v === "number") return isFinite(v) ? { val: v } : { val: null };
  let str = String(v).replace(/[₹\s,]/g, "").replace(/^(Rs\.?|INR)/i, "");
  if (str === "") return { val: null, missing: true };
  if (!/^-?\d+(\.\d+)?$/.test(str)) return { val: null };
  return { val: parseFloat(str) };
}
const arApNormHdr = h => String(h === null || h === undefined ? "" : h).toLowerCase().replace(/[^a-z]/g, "");
function arApMapHeaders(headerRow) {
  const H = headerRow.map(arApNormHdr);
  const find = (...keys) => { for (const k of keys) { const i = H.indexOf(k); if (i >= 0) return i; } return -1; };
  const idx = { date: find("date", "invoicedate"), name: find("customername", "vendorname", "customer", "vendor", "name"), due: find("duedate", "due"), amount: find("invoiceamount", "amount"), balance: find("balance", "outstandingbalance", "outstanding") };
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => ({ date: "Date", name: "Customer Name / Vendor Name", due: "Due Date", amount: "Invoice Amount", balance: "Balance" }[k]));
  return { idx, missing };
}
function arApParseSheetRows(aoa) {
  const errors = [], rows = [];
  let h = 0;
  while (h < aoa.length && !(aoa[h] || []).some(c => c !== null && c !== undefined && String(c).trim() !== "")) h++;
  if (h >= aoa.length) return { rows, errors: ["File is empty."] };
  const { idx, missing } = arApMapHeaders(aoa[h]);
  if (missing.length) return { rows, errors: ["Missing required column(s): " + missing.join(", ") + ". Expected: " + arApTemplateCols().join(" | ")] };

  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const excelRow = i + 1;
    if (!r.some(c => c !== null && c !== undefined && String(c).trim() !== "")) continue; // skip blank rows
    const errs = [];
    const name = String(r[idx.name] === null || r[idx.name] === undefined ? "" : r[idx.name]).replace(/\s+/g, " ").trim();
    if (!name) errs.push((currentDataTab === "payables" ? "Vendor" : "Customer") + " Name is missing");
    const d = arApParseDateCell(r[idx.date]); if (d.missing) errs.push("Date is missing"); else if (!d.iso) errs.push("Date is invalid (use DD-MM-YYYY)");
    const du = arApParseDateCell(r[idx.due]); if (du.missing) errs.push("Due Date is missing"); else if (!du.iso) errs.push("Due Date is invalid (use DD-MM-YYYY)");
    const am = arApParseAmountCell(r[idx.amount]); if (am.missing) errs.push("Invoice Amount is missing"); else if (am.val === null) errs.push("Invoice Amount is not a number");
    const bl = arApParseAmountCell(r[idx.balance]); if (!bl.missing && bl.val === null) errs.push("Balance is not a number");
    if (errs.length) errors.push(`Row ${excelRow}: ${errs.join("; ")}`);
    rows.push({ customer: name, date: d.iso, due: du.iso, amount: am.val, balance: bl.missing ? null : bl.val, _row: excelRow, _bad: errs.length > 0 });
  }
  if (!rows.length) errors.push("No data rows found below the header.");
  return { rows, errors };
}

let arApBulkParsed = null; // {rows:[...], which}

function arApSetBulkStatus(msg, cls) {
  const el = $("arApBulkStatus");
  el.innerHTML = "";
  if (!msg) return;
  const d = document.createElement("div");
  d.className = cls === "err" ? "form-error" : "form-success";
  d.textContent = msg;
  el.appendChild(d);
}
function arApResetBulk() {
  arApBulkParsed = null;
  arApSetBulkStatus("");
  $("arApBulkErrors").innerHTML = "";
  $("arApBulkPreview").innerHTML = "";
  $("arApBulkAppend").disabled = true;
  $("arApBulkReplace").disabled = true;
  $("arApBulkFile").value = "";
}

function arApHandleBulkFile(e) {
  const file = e.target.files[0];
  arApBulkParsed = null;
  $("arApBulkAppend").disabled = true;
  $("arApBulkReplace").disabled = true;
  $("arApBulkErrors").innerHTML = "";
  $("arApBulkPreview").innerHTML = "";
  if (!file) return;
  if (typeof XLSX === "undefined") { arApSetBulkStatus("Spreadsheet library not loaded — cannot read files (check internet access).", "err"); return; }

  const isCsv = /\.csv$/i.test(file.name);
  const reader = new FileReader();
  reader.onload = ev => {
    let aoa;
    try {
      // CSV is read as UTF-8 text (so ₹ and Indian names survive); Excel files as binary
      const wb = isCsv
        ? XLSX.read(String(ev.target.result).replace(/^﻿/, ""), { type: "string", raw: true })
        : XLSX.read(new Uint8Array(ev.target.result), { type: "array", cellDates: true, raw: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    } catch (err) {
      arApSetBulkStatus("Could not read this file: " + (err.message || err), "err");
      return;
    }

    const which = currentDataTab === "payables" ? "payables" : "receivables";
    const parsed = arApParseSheetRows(aoa);
    const errBox = $("arApBulkErrors");
    if (parsed.errors.length) {
      const ul = document.createElement("div");
      ul.className = "errlist";
      parsed.errors.forEach(m => { const d = document.createElement("div"); d.textContent = "• " + m; ul.appendChild(d); });
      errBox.appendChild(ul);
      arApSetBulkStatus(`${file.name}: ${parsed.rows.length} row(s) read, ${parsed.errors.length} error(s). Fix the rows listed and upload again — import is blocked until the file is clean.`, "err");
    } else {
      arApBulkParsed = { rows: parsed.rows.map(({ _row, _bad, ...r }) => r), which };
      arApSetBulkStatus(`${file.name}: ${parsed.rows.length} row(s) valid and ready to import into ${which === "payables" ? "Payables" : "Receivables"}.`, "ok");
      $("arApBulkAppend").disabled = false;
      $("arApBulkReplace").disabled = false;
    }

    // preview (first 50 rows)
    const pw = document.createElement("div");
    pw.className = "previewwrap";
    const t = document.createElement("table");
    const th = document.createElement("tr");
    ["Row", ...arApTemplateCols()].forEach(h => { const c = document.createElement("th"); c.textContent = h; th.appendChild(c); });
    t.appendChild(th);
    parsed.rows.slice(0, 50).forEach(r => {
      const tr = document.createElement("tr");
      if (r._bad) tr.className = "badrow";
      [r._row, r.date || "", r.customer, r.due || "", r.amount === null ? "" : r.amount, r.balance === null ? "(blank)" : r.balance].forEach(v => {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    if (parsed.rows.length > 50) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.style.textAlign = "center";
      td.textContent = `+ ${parsed.rows.length - 50} more row(s)`;
      tr.appendChild(td);
      t.appendChild(tr);
    }
    pw.appendChild(t);
    $("arApBulkPreview").appendChild(pw);
  };
  if (isCsv) reader.readAsText(file, "utf-8"); else reader.readAsArrayBuffer(file);
}

async function arApCommitBulk(mode) {
  if (!arApBulkParsed) return;
  const which = arApBulkParsed.which;
  const endpoint = which;
  if (mode === "replace") {
    if (!confirm(`Replace ALL existing ${which} data (${arApEditRows.length} row(s)) with ${arApBulkParsed.rows.length} uploaded row(s)? This cannot be undone.`)) return;
  }
  const nameField = which === "payables" ? "vendor_name" : "customer_name";
  const rows = arApBulkParsed.rows.map(r => ({ [nameField]: r.customer, invoice_date: r.date, due_date: r.due, invoice_amount: r.amount, balance: r.balance }));

  try {
    const result = await api(`/api/admin/${endpoint}/bulk-import`, { method: "POST", body: JSON.stringify({ mode, rows }) });
    arApResetBulk();
    await loadArApRecords();
    arApSetBulkStatus(`${result.inserted} row(s) ${mode === "replace" ? "replaced" : "appended"} into ${which === "payables" ? "Payables" : "Receivables"}. Dashboard updated.`, "ok");
  } catch (err) {
    arApSetBulkStatus(err.message, "err");
  }
}

function setupArAp() {
  $("arApAddRowBtn").onclick = arApAddRow;
  $("arApBulkFile").onchange = arApHandleBulkFile;
  $("arApBulkAppend").onclick = () => arApCommitBulk("append");
  $("arApBulkReplace").onclick = () => arApCommitBulk("replace");
  document.querySelectorAll("[data-ar-tpl]").forEach(b => { b.onclick = () => arApDownloadTemplate(b.dataset.arTpl); });
  $("accountsAddDataBtn").onclick = () => {
    if (!token) { showLogin(); return; }
    currentDataTab = "receivables";
    editingId = null;
    setupDataTabs();
    setPage("data");
  };
}
