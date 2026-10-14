const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
require("dotenv").config();
const { Pool } = require("pg");

const app = express();
const port = Number(process.env.PORT || 3000);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const config = {
  businessName: process.env.BUSINESS_NAME || "Stillpoint",
  therapistName: process.env.THERAPIST_NAME || "Your therapist",
  therapistTitle: process.env.THERAPIST_TITLE || "Psychotherapist",
  therapistCredentials: process.env.THERAPIST_CREDENTIALS || "A supportive space for you",
  therapistBio:
    process.env.THERAPIST_BIO ||
    "A calm, confidential space to understand yourself and find a way forward.",
  whatsappNumber: (process.env.WHATSAPP_NUMBER || "").replace(/\D/g, ""),
  fee: Number(process.env.SESSION_FEE || 1800),
  currency: (process.env.CURRENCY || "INR").toUpperCase(),
  durationMinutes: Number(process.env.SESSION_DURATION_MINUTES || 50),
  timezone: process.env.TIMEZONE || "Asia/Kolkata",
  weekdays: (process.env.AVAILABLE_WEEKDAYS || "1,2,3,4,5,6")
    .split(",")
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
  startTime: process.env.DAILY_START_TIME || "09:00",
  endTime: process.env.DAILY_END_TIME || "17:00",
  intervalMinutes: Number(process.env.SLOT_INTERVAL_MINUTES || 60),
  paymentUrl: process.env.PAYMENT_URL || "",
};

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function weekdayForDate(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function minutesFromTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function buildSlots() {
  const start = minutesFromTime(config.startTime);
  const end = minutesFromTime(config.endTime);
  if (
    start === null ||
    end === null ||
    end <= start ||
    !Number.isInteger(config.intervalMinutes) ||
    config.intervalMinutes < 15
  ) {
    throw new Error("Invalid session availability settings.");
  }

  const slots = [];
  for (let time = start; time + config.durationMinutes <= end; time += config.intervalMinutes) {
    const hours = String(Math.floor(time / 60)).padStart(2, "0");
    const minutes = String(time % 60).padStart(2, "0");
    slots.push(`${hours}:${minutes}`);
  }
  return slots;
}

function paymentUrlForBooking(bookingId) {
  if (!config.paymentUrl) return null;
  return config.paymentUrl
    .replaceAll("{bookingId}", encodeURIComponent(String(bookingId)))
    .replaceAll("{amount}", encodeURIComponent(String(config.fee)));
}

function localDateTimeForZone(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

app.get("/api/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok" });
  } catch (error) {
    console.error("Health check failed:", error);
    response.status(503).json({ error: "Database is unavailable." });
  }
});

app.get("/api/config", (_request, response) => {
  response.json({
    businessName: config.businessName,
    therapistName: config.therapistName,
    therapistTitle: config.therapistTitle,
    therapistCredentials: config.therapistCredentials,
    therapistBio: config.therapistBio,
    fee: config.fee,
    currency: config.currency,
    durationMinutes: config.durationMinutes,
    timezone: config.timezone,
    weekdays: config.weekdays,
    whatsappEnabled: Boolean(config.whatsappNumber),
    paymentEnabled: Boolean(config.paymentUrl),
  });
});

app.get("/api/availability", async (request, response) => {
  const { date } = request.query;
  if (typeof date !== "string" || !isValidDate(date)) {
    return response.status(400).json({ error: "Choose a valid date." });
  }
  if (!config.weekdays.includes(weekdayForDate(date))) {
    return response.json({ slots: [] });
  }

  try {
    const slots = buildSlots();
    const result = await pool.query(
      "SELECT to_char(session_time, 'HH24:MI') AS time FROM bookings WHERE session_date = $1",
      [date],
    );
    const bookedSlots = new Set(result.rows.map((row) => row.time));
    const now = localDateTimeForZone(new Date());
    response.json({
      slots: slots.filter((slot) => {
        const slotMinutes = minutesFromTime(slot);
        return !bookedSlots.has(slot) && (date !== now.date || slotMinutes > now.minutes);
      }),
    });
  } catch (error) {
    console.error("Availability lookup failed:", error);
    response.status(500).json({ error: "Could not load availability. Please try again." });
  }
});

app.post("/api/bookings", async (request, response) => {
  if (!config.whatsappNumber) {
    return response.status(503).json({ error: "WhatsApp booking is not configured yet. Please contact the practice directly." });
  }
  const { fullName, phone, email, sessionType, date, time } = request.body || {};
  const normalizedName = typeof fullName === "string" ? fullName.trim() : "";
  const normalizedPhone = typeof phone === "string" ? phone.trim() : "";
  const normalizedEmail = typeof email === "string" ? email.trim() : "";

  if (
    normalizedName.length < 2 ||
    normalizedName.length > 120 ||
    !/^[+()\d\s.-]{7,30}$/.test(normalizedPhone) ||
    (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) ||
    normalizedEmail.length > 254 ||
    !["online", "in-person"].includes(sessionType) ||
    typeof date !== "string" ||
    !isValidDate(date) ||
    typeof time !== "string" ||
    !buildSlots().includes(time) ||
    !config.weekdays.includes(weekdayForDate(date))
  ) {
    return response.status(400).json({ error: "Please check your details and selected session." });
  }

  const today = localDateTimeForZone(new Date()).date;
  if (date < today) {
    return response.status(400).json({ error: "Please choose a future date." });
  }

  try {
    const result = await pool.query(
      `INSERT INTO bookings
        (full_name, phone, email, session_type, session_date, session_time, fee_amount, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        normalizedName,
        normalizedPhone,
        normalizedEmail || null,
        sessionType,
        date,
        time,
        config.fee,
        config.currency,
      ],
    );

    const bookingId = result.rows[0].id;
    const formattedDate = new Intl.DateTimeFormat("en", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00Z`));
    const message = [
      `Hello ${config.therapistName}, I'd like to book a therapy session.`,
      `Booking reference: #${bookingId}`,
      `Name: ${normalizedName}`,
      `Phone: ${normalizedPhone}`,
      normalizedEmail ? `Email: ${normalizedEmail}` : null,
      `Session: ${sessionType === "online" ? "Online" : "In person"}`,
      `Date: ${formattedDate}`,
      `Time: ${time} (${config.timezone})`,
      `Fee: ${config.currency} ${config.fee}`,
    ]
      .filter(Boolean)
      .join("\n");

    response.status(201).json({
      bookingId,
      whatsappUrl: config.whatsappNumber
        ? `https://wa.me/${config.whatsappNumber}?text=${encodeURIComponent(message)}`
        : null,
      paymentUrl: paymentUrlForBooking(bookingId),
    });
  } catch (error) {
    if (error.code === "23505") {
      return response.status(409).json({
        error: "That time was just booked. Please choose another available time.",
      });
    }
    console.error("Booking creation failed:", error);
    response.status(500).json({ error: "We couldn't save your booking. Please try again." });
  }
});

async function start() {
  if (!Number.isInteger(config.fee) || config.fee <= 0) {
    throw new Error("SESSION_FEE must be a positive whole number.");
  }
  if (!/^[A-Z]{3}$/.test(config.currency)) {
    throw new Error("CURRENCY must be a three-letter currency code.");
  }
  if (!Number.isInteger(config.durationMinutes) || config.durationMinutes <= 0) {
    throw new Error("SESSION_DURATION_MINUTES must be a positive whole number.");
  }
  if (!config.weekdays.length) {
    throw new Error("AVAILABLE_WEEKDAYS must include at least one day from 0 through 6.");
  }
  if (config.whatsappNumber && !/^\d{8,15}$/.test(config.whatsappNumber)) {
    throw new Error("WHATSAPP_NUMBER must include the country code and contain 8 to 15 digits.");
  }
  if (config.paymentUrl) {
    const paymentUrl = new URL(config.paymentUrl.replaceAll("{bookingId}", "1").replaceAll("{amount}", "1"));
    if (paymentUrl.protocol !== "https:") {
      throw new Error("PAYMENT_URL must use HTTPS.");
    }
  }
  new Intl.DateTimeFormat("en", { timeZone: config.timezone });
  buildSlots();
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(schema);
  app.listen(port, () => {
    console.log(`Healing Mind booking app listening on port ${port}`);
  });
}

start().catch((error) => {
  console.error("Application startup failed:", error);
  process.exitCode = 1;
});

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
