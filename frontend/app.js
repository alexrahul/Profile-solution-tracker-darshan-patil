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
  accounts:{label:"Accounts Data", endpoint:"accounts", fields:[
    {name:"t_month",label:"Month (YYYY-MM)",type:"month",required:true},
    {name:"sales_order_amount",label:"Sales Order Amount (₹ Lakhs)",type:"number",required:true},
    {name:"purchase_order_amount",label:"Purchase Order Amount (₹ Lakhs)",type:"number",required:true},
    {name:"invoice_amount",label:"Invoice Amount (₹ Lakhs)",type:"number",required:true}
  ]},
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
  setupAccounts();
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
    accounts:["Accounts","Sales Orders, Purchase Orders & Invoices"],
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
    loadRecords();
  } else if (page === "settings") {
    loadCalendarConnections();
  } else if (page === "accounts") {
    loadAccountsDashboard();
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

function setupDataTabs() {
  $("dataTabs").innerHTML = Object.entries(dataModules).map(([k, v]) =>
    `<button data-key="${k}" class="${k === currentDataTab ? "active" : ""}">${v.label}</button>`
  ).join("");

  $("dataTabs").querySelectorAll("button").forEach(b => b.onclick = () => {
    currentDataTab = b.dataset.key;
    editingId = null;
    setupDataTabs();
    renderDataForm();
    updateBulkPanel();
    loadRecords();
  });

  renderDataForm();
  updateBulkPanel();
  $("recordSearch").oninput = loadRecords;
  $("bulkUploadBtn").onclick = bulkUpload;
  $("downloadTemplateBtn").onclick = downloadTemplate;
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
 * Accounts module - KPI dashboard (totals + monthly trend)
 * All figures are computed live from /api/public/accounts, which returns
 * one row per month. Aggregation and range filtering happen here.
 * ------------------------------------------------------------------ */

// Amounts are entered/stored in Lakhs (full precision). The dashboard displays
// them in Crores: 1 Cr = 100 L, so divide by ACCOUNTS_DISPLAY_DIVISOR for display.
const ACCOUNTS_UNIT_LABEL = "₹ in Crores";
const ACCOUNTS_UNIT_SUFFIX = "Cr";
const ACCOUNTS_DISPLAY_DIVISOR = 100;
const ACCOUNTS_SERIES = [
  { key: "salesOrder", label: "Sales Orders", color: "#3B82F6" },
  { key: "purchaseOrder", label: "Purchase Orders", color: "#F59E0B" },
  { key: "invoice", label: "Invoices", color: "#22C55E" }
];

let accountsRows = [];
let accountsUnitLabel = ACCOUNTS_UNIT_LABEL;
let accountsRangeMode = "12";
let accountsHiddenSeries = new Set();

function setupAccounts() {
  const addBtn = $("accountsAddDataBtn");
  if (addBtn) addBtn.onclick = openAccountsDataEntry;

  const toggle = $("accountsRangeToggle");
  if (toggle) {
    toggle.querySelectorAll("[data-range]").forEach(btn => {
      btn.onclick = () => applyAccountsRangeMode(btn.dataset.range);
    });
  }
}

function setAccountsView(view) {
  $("accountsLoading").classList.toggle("hidden", view !== "loading");
  $("accountsEmpty").classList.toggle("hidden", view !== "empty");
  $("accountsDashboard").classList.toggle("hidden", view !== "dashboard");
}

async function loadAccountsDashboard() {
  setAccountsView("loading");
  $("accountsError").classList.add("hidden");

  try {
    const result = await api("/api/public/accounts");
    accountsRows = (result.rows || [])
      .map(r => ({
        month: r.month,
        salesOrder: Number(r.salesOrder) || 0,
        purchaseOrder: Number(r.purchaseOrder) || 0,
        invoice: Number(r.invoice) || 0
      }))
      .filter(r => /^\d{4}-\d{2}$/.test(r.month || ""))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

    accountsUnitLabel = result.unitLabel || ACCOUNTS_UNIT_LABEL;
    $("accountsUnitLabel").textContent = accountsUnitLabel;

    if (!accountsRows.length) {
      setAccountsView("empty");
      return;
    }

    setAccountsView("dashboard");
    initAccountsFilters();
  } catch (err) {
    accountsRows = [];
    setAccountsView("empty");
    const notice = $("accountsError");
    notice.classList.remove("hidden");
    notice.textContent = "Accounts data could not be loaded. " + err.message;
  }
}

function initAccountsFilters() {
  const months = accountsRows.map(r => r.month);
  const options = months.map(m => `<option value="${escAttr(m)}">${esc(formatAccountsMonth(m))}</option>`).join("");
  $("accountsFrom").innerHTML = options;
  $("accountsTo").innerHTML = options;

  $("accountsFrom").onchange = () => {
    if ($("accountsFrom").value > $("accountsTo").value) $("accountsTo").value = $("accountsFrom").value;
    accountsRangeMode = "custom";
    syncAccountsRangeButtons();
    renderAccounts();
  };
  $("accountsTo").onchange = () => {
    if ($("accountsTo").value < $("accountsFrom").value) $("accountsFrom").value = $("accountsTo").value;
    accountsRangeMode = "custom";
    syncAccountsRangeButtons();
    renderAccounts();
  };

  applyAccountsRangeMode("12");
}

function applyAccountsRangeMode(mode) {
  const months = accountsRows.map(r => r.month);
  if (!months.length) return;
  accountsRangeMode = mode;

  if (mode === "all") {
    $("accountsFrom").value = months[0];
    $("accountsTo").value = months[months.length - 1];
  } else {
    accountsRangeMode = "12";
    const start = Math.max(0, months.length - 12);
    $("accountsFrom").value = months[start];
    $("accountsTo").value = months[months.length - 1];
  }

  syncAccountsRangeButtons();
  renderAccounts();
}

function syncAccountsRangeButtons() {
  $("accountsRangeToggle").querySelectorAll("[data-range]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.range === accountsRangeMode);
  });
}

function getAccountsFiltered() {
  const from = $("accountsFrom").value;
  const to = $("accountsTo").value;
  if (!from || !to) return accountsRows.slice();
  return accountsRows.filter(r => r.month >= from && r.month <= to);
}

function renderAccounts() {
  const rows = getAccountsFiltered();
  renderAccountsKpis(rows);
  renderAccountsLegend();
  renderAccountsChart(rows);
}

function renderAccountsKpis(rows) {
  const totals = { salesOrder: 0, purchaseOrder: 0, invoice: 0 };
  rows.forEach(r => ACCOUNTS_SERIES.forEach(s => { totals[s.key] += r[s.key] || 0; }));

  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];

  $("accountsKpiRow").innerHTML = ACCOUNTS_SERIES.map(s => {
    let sub;
    if (!latest) {
      sub = `<span class="accounts-kpi-sub muted">No data in selected range</span>`;
    } else {
      const current = latest[s.key] || 0;
      let deltaHtml = "";
      if (prev) {
        const change = accountsPctChange(current, prev[s.key] || 0);
        deltaHtml = ` <span class="accounts-delta ${change.dir}">${esc(change.text)}</span>`;
      }
      sub = `<span class="accounts-kpi-sub">${esc(formatAccountsMonth(latest.month))}: ${esc(formatAccountsAmount(current))}${deltaHtml}</span>`;
    }
    return `<article class="card accounts-kpi-card">
        <span class="accounts-kpi-dot" style="background:${s.color}"></span>
        <h3 class="accounts-kpi-title">Total ${esc(s.label)}</h3>
        <div class="accounts-kpi-value">${esc(formatAccountsAmount(totals[s.key]))}</div>
        ${sub}
      </article>`;
  }).join("");
}

// % change vs the previous month in range. Guards previous === 0 so a month
// that follows a zero month shows "New" instead of dividing by zero.
function accountsPctChange(current, previous) {
  if (previous === 0 && current === 0) return { text: "0.0% vs prev", dir: "flat" };
  if (previous === 0) return { text: "New vs prev", dir: "up" };
  const pct = ((current - previous) / previous) * 100;
  const dir = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "▬";
  return { text: `${arrow} ${Math.abs(pct).toFixed(1)}% vs prev`, dir };
}

function renderAccountsLegend() {
  const legend = $("accountsLegend");
  legend.innerHTML = ACCOUNTS_SERIES.map(s => {
    const off = accountsHiddenSeries.has(s.key);
    return `<button type="button" class="accounts-legend-item${off ? " off" : ""}" data-series="${s.key}">
        <span class="accounts-legend-swatch" style="background:${s.color}"></span>${esc(s.label)}
      </button>`;
  }).join("");

  legend.querySelectorAll("[data-series]").forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.series;
      if (accountsHiddenSeries.has(key)) accountsHiddenSeries.delete(key);
      else accountsHiddenSeries.add(key);
      renderAccountsLegend();
      renderAccountsChart(getAccountsFiltered());
    };
  });
}

// Lightweight hand-rolled SVG line chart (no chart library dependency, matching
// the rest of the app). Responsive through the viewBox.
function renderAccountsChart(rows) {
  const wrap = $("accountsChart");
  const visible = ACCOUNTS_SERIES.filter(s => !accountsHiddenSeries.has(s.key));

  if (!rows.length) {
    wrap.innerHTML = `<div class="accounts-empty-inline">No data in the selected range.</div>`;
    return;
  }

  const W = 920, H = 360, padL = 64, padR = 20, padT = 18, padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = rows.length;

  // Chart geometry and axis labels are in display units (Crores).
  const div = ACCOUNTS_DISPLAY_DIVISOR;
  let maxV = 0;
  rows.forEach(r => visible.forEach(s => { maxV = Math.max(maxV, (r[s.key] || 0) / div); }));
  const niceMax = accountsNiceMax(maxV || 1);

  const xAt = i => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = v => padT + plotH - (v / niceMax) * plotH;

  const steps = 5;
  let grid = "";
  for (let i = 0; i <= steps; i++) {
    const gv = (niceMax / steps) * i;
    const gy = yAt(gv).toFixed(1);
    grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" class="accounts-grid-line" />`;
    grid += `<text x="${padL - 10}" y="${(Number(gy) + 4).toFixed(1)}" class="accounts-axis-label" text-anchor="end">${esc(accountsShortNum(gv))}</text>`;
  }

  const stepX = Math.max(1, Math.ceil(n / 8));
  let xLabels = "";
  rows.forEach((r, i) => {
    if (i % stepX === 0 || i === n - 1) {
      xLabels += `<text x="${xAt(i).toFixed(1)}" y="${H - padB + 20}" class="accounts-axis-label" text-anchor="middle">${esc(formatAccountsMonth(r.month))}</text>`;
    }
  });

  let series = "";
  visible.forEach(s => {
    const d = rows.map((r, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt((r[s.key] || 0) / div).toFixed(1)}`).join(" ");
    series += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" />`;
    series += rows.map((r, i) =>
      `<circle cx="${xAt(i).toFixed(1)}" cy="${yAt((r[s.key] || 0) / div).toFixed(1)}" r="2.6" fill="${s.color}"><title>${esc(formatAccountsMonth(r.month))} — ${esc(s.label)}: ${esc(formatAccountsAmount(r[s.key] || 0))}</title></circle>`
    ).join("");
  });

  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="accounts-chart-svg" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Monthly trend of sales orders, purchase orders and invoices">
      ${grid}
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="accounts-axis-line" />
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="accounts-axis-line" />
      ${series}
      ${xLabels}
    </svg>`;
}

function accountsNiceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const base = v / pow;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * pow;
}

function accountsShortNum(v) {
  const abs = Math.abs(v);
  if (abs >= 1000) return (v / 1000).toLocaleString("en-IN", { maximumFractionDigits: 1 }) + "k";
  return v.toLocaleString("en-IN", { maximumFractionDigits: abs < 10 ? 1 : 0 });
}

function formatAccountsMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  if (!y || !m) return String(month);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatAccountsAmount(value) {
  const v = (Number(value) || 0) / ACCOUNTS_DISPLAY_DIVISOR;
  return `₹ ${v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ACCOUNTS_UNIT_SUFFIX}`;
}

function openAccountsDataEntry() {
  if (!token) { showLogin(); return; }
  currentDataTab = "accounts";
  editingId = null;
  setupDataTabs();
  setPage("data");
}
