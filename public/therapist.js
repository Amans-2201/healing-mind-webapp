const $ = (selector) => document.querySelector(selector);
const loginView = $("#login-view");
const dashboardView = $("#dashboard-view");
const loginForm = $("#login-form");
const loginButton = $("#login-button");
const bookingList = $("#booking-list");
let bookingView = "upcoming";
let requestNumber = 0;

function setAuthenticated(authenticated, loginMessage = "") {
  loginView.hidden = authenticated;
  dashboardView.hidden = !authenticated;
  $("#login-message").textContent = loginMessage;
}

function formatDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function formatCreatedAt(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function createDetail(label, value) {
  const item = document.createElement("div");
  item.className = "booking-detail";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value || "Not provided";
  item.append(name, content);
  return item;
}

function createContactLink(label, value, scheme) {
  const item = document.createElement("div");
  item.className = "booking-detail";
  const name = document.createElement("span");
  name.textContent = label;
  const link = document.createElement("a");
  link.className = "booking-contact-link";
  link.textContent = value;
  link.href = `${scheme}:${encodeURIComponent(value)}`;
  item.append(name, link);
  return item;
}

function createBookingCard(booking) {
  const card = document.createElement("article");
  card.className = "dashboard-booking-card";

  const datePanel = document.createElement("div");
  datePanel.className = "booking-date-panel";
  const dateLabel = document.createElement("span");
  dateLabel.textContent = formatDate(booking.date);
  const timeLabel = document.createElement("strong");
  timeLabel.textContent = booking.time;
  const timezone = document.createElement("small");
  timezone.textContent = $("#dashboard-timezone").textContent;
  datePanel.append(dateLabel, timeLabel, timezone);

  const details = document.createElement("div");
  details.className = "booking-client-details";
  const clientHeading = document.createElement("div");
  clientHeading.className = "booking-client-heading";
  const clientName = document.createElement("h3");
  clientName.textContent = booking.fullName;
  const reference = document.createElement("span");
  reference.textContent = `#${booking.id}`;
  clientHeading.append(clientName, reference);

  const detailsGrid = document.createElement("div");
  detailsGrid.className = "booking-details-grid";
  detailsGrid.append(
    createContactLink("Phone", booking.phone, "tel"),
    createDetail("Session", booking.sessionType === "online" ? "Online" : "In person"),
    createDetail("Fee", `${booking.currency.trim()} ${booking.fee}`),
  );
  if (booking.email) detailsGrid.append(createContactLink("Email", booking.email, "mailto"));

  const createdAt = document.createElement("p");
  createdAt.className = "booking-created-at";
  createdAt.textContent = `Booked ${formatCreatedAt(booking.createdAt)}`;
  details.append(clientHeading, detailsGrid, createdAt);
  card.append(datePanel, details);
  return card;
}

async function loadBookings() {
  const currentRequest = ++requestNumber;
  $("#dashboard-message").textContent = "";
  $("#refresh-button").disabled = true;
  bookingList.replaceChildren();

  const parameters = new URLSearchParams({ view: bookingView });
  const date = $("#date-filter").value;
  if (date) parameters.set("date", date);
  $("#results-description").textContent = date
    ? `Appointments on ${formatDate(date)}`
    : bookingView === "upcoming"
      ? "Your upcoming sessions"
      : "Your recent and upcoming bookings";
  $("#booking-count-label").textContent = date
    ? "Appointments on selected date"
    : bookingView === "upcoming"
      ? "Upcoming appointments"
      : "Bookings found";

  try {
    const response = await fetch(`/api/therapist/bookings?${parameters}`);
    const result = await response.json();
    if (currentRequest !== requestNumber) return;
    if (response.status === 401) {
      setAuthenticated(false, "Your dashboard session expired. Please sign in again.");
      return;
    }
    if (!response.ok) throw new Error(result.error || "Bookings could not be loaded.");

    $("#booking-count").textContent = result.bookings.length;
    $("#dashboard-limit-note").hidden = result.bookings.length < result.limit || Boolean(date);
    if (!result.bookings.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "dashboard-empty";
      const icon = document.createElement("span");
      icon.className = "empty-state-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "✳";
      const heading = document.createElement("strong");
      heading.textContent = "No bookings to show";
      const description = document.createElement("p");
      description.textContent = date
        ? "There are no sessions booked for this date."
        : bookingView === "upcoming"
          ? "New sessions will appear here when someone books."
          : "No sessions have been booked yet.";
      emptyState.append(icon, heading, description);
      bookingList.append(emptyState);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const booking of result.bookings) fragment.append(createBookingCard(booking));
    bookingList.append(fragment);
  } catch (error) {
    if (currentRequest === requestNumber) {
      $("#dashboard-message").textContent = error.message;
    }
  } finally {
    if (currentRequest === requestNumber) $("#refresh-button").disabled = false;
  }
}

async function checkSession() {
  try {
    const response = await fetch("/api/therapist/session");
    if (response.ok) {
      setAuthenticated(true);
      await loadBookings();
    } else {
      setAuthenticated(false);
    }
  } catch {
    setAuthenticated(false, "Could not connect. Please refresh the page and try again.");
  }
}

async function initialize() {
  $("#current-year").textContent = new Date().getFullYear();
  try {
    const response = await fetch("/api/config");
    if (response.ok) {
      const config = await response.json();
      $("#brand-name").textContent = config.businessName;
      $("#footer-brand").textContent = config.businessName;
      $("#dashboard-timezone").textContent = config.timezone;
      document.title = `Therapist dashboard | ${config.businessName}`;
    }
  } catch {
    // The therapist can still sign in if public display settings are unavailable.
  }
  await checkSession();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#login-message").textContent = "";
  loginButton.disabled = true;
  loginButton.querySelector("span:first-child").textContent = "Signing in…";
  const passwordInput = loginForm.elements.password;
  try {
    const response = await fetch("/api/therapist/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });
    const result = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(result.error || "Sign-in failed. Please try again.");
    passwordInput.value = "";
    setAuthenticated(true);
    await loadBookings();
  } catch (error) {
    $("#login-message").textContent = error.message;
  } finally {
    loginButton.disabled = false;
    loginButton.querySelector("span:first-child").textContent = "Sign in to dashboard";
  }
});

document.querySelectorAll(".dashboard-tab").forEach((button) => {
  button.addEventListener("click", () => {
    bookingView = button.dataset.view;
    document.querySelectorAll(".dashboard-tab").forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-pressed", String(selected));
    });
    loadBookings();
  });
});

$("#date-filter").addEventListener("change", loadBookings);
$("#refresh-button").addEventListener("click", loadBookings);
$("#logout-button").addEventListener("click", async () => {
  const logoutButton = $("#logout-button");
  logoutButton.disabled = true;
  try {
    const response = await fetch("/api/therapist/logout", { method: "POST" });
    if (!response.ok && response.status !== 401) {
      throw new Error("Could not sign out. Please try again.");
    }
    setAuthenticated(false);
  } catch (error) {
    $("#dashboard-message").textContent = error.message;
  } finally {
    logoutButton.disabled = false;
  }
});

initialize();
