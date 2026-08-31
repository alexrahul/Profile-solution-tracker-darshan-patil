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

const dataModules = {
  calendar:{label:"Calendar Data", endpoint:"calendar", fields:[
    {name:"event_date",label:"Date",type:"date",required:true},
    {name:"event_title",label:"Event Title",type:"text",required:true},
    {name:"description",label:"Event Description",type:"textarea"}
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

  await restoreAuthSession();
  if (currentUser) await loadDashboardPreference();
  updateAuthUI();
  setPage(calendarRedirectStatus && token ? "settings" : "dashboard");
  renderDashboardVisibility();

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
    accounts:["Accounts","Accounts Module"],
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
  } else if (["accounts","projects","cctv"].includes(page)) {
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
  } else {
    statusEl.textContent = "Not Connected";
    statusEl.classList.remove("connected");
    emailEl.textContent = "";
    btn.textContent = `Connect ${label} Calendar`;
    btn.onclick = () => connectCalendar(provider);
    syncBtn.classList.add("hidden");
    syncBtn.onclick = null;
  }
}

async function syncCalendarNow(id, syncBtn) {
  const msg = $("calendarConnectMessage");
  syncBtn.disabled = true;
  syncBtn.textContent = "Syncing...";
  try {
    const result = await api(`/api/calendar/connections/${id}/sync`, { method: "POST" });
    msg.classList.remove("hidden");
    msg.className = "calendar-connect-message success";
    msg.textContent = `Synced ${result.synced} event${result.synced === 1 ? "" : "s"} just now.`;
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
  $("meetingList").innerHTML = mergedMeetings.slice(0, 5).map(renderMeetingRow).join("") || emptyCompact("No meetings");

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
  return `<div class="meeting-row"><b>${esc(m.time || "")}</b><div><strong>${nameHtml}</strong><small>${esc(m.team || "")}</small></div>${tagHtml}</div>`;
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
