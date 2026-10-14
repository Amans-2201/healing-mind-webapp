const state = {
  config: null,
  currentMonth: new Date(),
  selectedDate: null,
  selectedTime: null,
  availableSlots: [],
};

const $ = (selector) => document.querySelector(selector);
const calendarDays = $("#calendar-days");
const timeSlots = $("#time-slots");
const form = $("#booking-form");
const submitButton = $("#submit-button");

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function updateSubmitState() {
  submitButton.disabled =
    !state.config?.whatsappEnabled || !state.selectedDate || !state.selectedTime;
}

function renderCalendar() {
  const year = state.currentMonth.getFullYear();
  const month = state.currentMonth.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = localDateString(new Date());
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" })
    .format(state.currentMonth);
  const now = new Date();

  $("#month-label").textContent = monthLabel;
  $("#prev-month").disabled =
    year < now.getFullYear() ||
    (year === now.getFullYear() && month <= now.getMonth());
  calendarDays.replaceChildren();

  for (let index = 0; index < firstWeekday; index += 1) {
    const blank = document.createElement("span");
    blank.className = "calendar-day blank";
    blank.setAttribute("aria-hidden", "true");
    calendarDays.append(blank);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = new Date(year, month, day);
    const dateString = localDateString(date);
    const button = document.createElement("button");
    const weekday = date.getDay();
    const isPast = dateString < today;
    const isAvailableDay = state.config.weekdays.includes(weekday);
    button.type = "button";
    button.className = "calendar-day";
    button.textContent = day;
    button.disabled = isPast || !isAvailableDay;
    button.setAttribute("aria-label", new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(date));
    if (dateString === today) button.classList.add("today");
    if (dateString === state.selectedDate) {
      button.classList.add("selected");
      button.setAttribute("aria-pressed", "true");
    }
    button.addEventListener("click", () => selectDate(dateString));
    calendarDays.append(button);
  }
}

function renderSlots() {
  timeSlots.replaceChildren();
  if (!state.selectedDate) {
    timeSlots.innerHTML = '<div class="empty-slots">Choose a date to see available times.</div>';
    return;
  }
  if (!state.availableSlots.length) {
    timeSlots.innerHTML = '<div class="empty-slots">There are no times available on this date. Please choose another day.</div>';
    return;
  }
  for (const time of state.availableSlots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `time-slot${time === state.selectedTime ? " selected" : ""}`;
    button.textContent = formatTime(time);
    button.setAttribute("aria-pressed", String(time === state.selectedTime));
    button.addEventListener("click", () => {
      state.selectedTime = time;
      renderSlots();
      updateSubmitState();
    });
    timeSlots.append(button);
  }
}

function formatTime(time) {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

async function selectDate(date) {
  state.selectedDate = date;
  state.selectedTime = null;
  state.availableSlots = [];
  $("#selected-date-label").textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00`));
  $("#form-message").textContent = "";
  renderCalendar();
  renderSlots();
  updateSubmitState();

  try {
    const response = await fetch(`/api/availability?date=${encodeURIComponent(date)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load times.");
    if (state.selectedDate !== date) return;
    state.availableSlots = result.slots;
    renderSlots();
  } catch (error) {
    if (state.selectedDate !== date) return;
    $("#form-message").textContent = error.message;
    timeSlots.innerHTML = '<div class="empty-slots">Availability could not be loaded. Please try again.</div>';
  }
}

function showConfirmation(booking) {
  const dateText = new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(new Date(`${state.selectedDate}T00:00:00Z`));
  $("#confirmation-details").textContent =
    `${dateText} at ${formatTime(state.selectedTime)} · ${formatMoney(state.config.fee, state.config.currency)}`;
  $("#booking-reference").textContent = `Booking reference #${booking.bookingId}`;

  const whatsappLink = $("#whatsapp-link");
  if (booking.whatsappUrl) {
    whatsappLink.href = booking.whatsappUrl;
    whatsappLink.hidden = false;
  } else {
    whatsappLink.hidden = true;
  }

  const paymentLink = $("#payment-link");
  const paymentDisclaimer = $("#payment-disclaimer");
  if (booking.paymentUrl) {
    paymentLink.href = booking.paymentUrl;
    paymentLink.hidden = false;
    paymentDisclaimer.hidden = false;
  } else {
    paymentLink.hidden = true;
    paymentDisclaimer.hidden = true;
  }

  $("#confirmation-dialog").showModal();
  $("#dialog-backdrop").classList.add("visible");
}

async function initialize() {
  $("#current-year").textContent = new Date().getFullYear();
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("Booking details could not be loaded.");
    state.config = await response.json();
    $("#brand-name").textContent = state.config.businessName;
    $("#footer-brand").textContent = state.config.businessName;
    document.title = `Book a session | ${state.config.businessName}`;
    $("#therapist-name").textContent = state.config.therapistName;
    $("#therapist-bio").textContent = state.config.therapistBio;
    $("#aside-therapist").textContent = state.config.therapistName;
    $("#therapist-title").textContent = state.config.therapistTitle;
    $("#aside-title").textContent = state.config.therapistTitle;
    $("#therapist-credentials").textContent = state.config.therapistCredentials;
    $("#fee-label").textContent = formatMoney(state.config.fee, state.config.currency);
    $("#duration-label").textContent = `${state.config.durationMinutes} min`;
    $("#timezone-label").textContent = state.config.timezone;
    if (!state.config.whatsappEnabled) {
      $("#form-message").textContent = "WhatsApp booking is not set up yet. Please contact the practice directly.";
      submitButton.disabled = true;
    }
    renderCalendar();
  } catch (error) {
    $("#form-message").textContent = error.message;
    submitButton.disabled = true;
  }
}

document.querySelectorAll('input[name="sessionType"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    document.querySelectorAll(".session-option").forEach((option) => option.classList.remove("selected"));
    radio.closest(".session-option").classList.add("selected");
  });
});

$("#prev-month").addEventListener("click", () => {
  state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() - 1, 1);
  renderCalendar();
});
$("#next-month").addEventListener("click", () => {
  state.currentMonth = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth() + 1, 1);
  renderCalendar();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.selectedDate || !state.selectedTime) return;
  $("#form-message").textContent = "";
  submitButton.disabled = true;
  submitButton.querySelector("span:first-child").textContent = "Saving your booking…";
  const fields = new FormData(form);
  try {
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: fields.get("fullName"),
        phone: fields.get("phone"),
        email: fields.get("email"),
        sessionType: fields.get("sessionType"),
        date: state.selectedDate,
        time: state.selectedTime,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409) await selectDate(state.selectedDate);
      throw new Error(result.error || "Booking could not be saved.");
    }
    showConfirmation(result);
    await selectDate(state.selectedDate);
  } catch (error) {
    $("#form-message").textContent = error.message;
  } finally {
    submitButton.querySelector("span:first-child").textContent = "Continue to booking";
    updateSubmitState();
  }
});

function closeConfirmation() {
  $("#confirmation-dialog").close();
  $("#dialog-backdrop").classList.remove("visible");
}
$("#close-dialog").addEventListener("click", closeConfirmation);
$("#dialog-backdrop").addEventListener("click", closeConfirmation);
$("#confirmation-dialog").addEventListener("close", () => $("#dialog-backdrop").classList.remove("visible"));

initialize();
