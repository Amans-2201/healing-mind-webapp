const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
  therapistPassword: process.env.THERAPIST_PASSWORD || "",
};

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api/therapist", (_request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  next();
});

const sessionSecret = crypto.randomBytes(32);
const loginAttempts = new Map();
const therapistSessionCookie = "therapist_session";
const therapistSessionDurationMs = 12 * 60 * 60 * 1000;

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

function getTherapistSessionExpiry(request) {
  const cookieHeader = request.headers.cookie || "";
  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${therapistSessionCookie}=`));
  if (!sessionCookie) return null;

  const cookieValue = sessionCookie.slice(therapistSessionCookie.length + 1);
  const match = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(cookieValue);
  if (!match) return null;
  const [, expiry, signature] = match;
  const expiryTime = Number(expiry);
  if (!Number.isSafeInteger(expiryTime) || expiryTime <= Date.now()) return null;

  const expectedSignature = crypto
    .createHmac("sha256", sessionSecret)
    .update(String(expiryTime))
    .digest("base64url");
  const expectedBuffer = Buffer.from(expectedSignature);
  const signatureBuffer = Buffer.from(signature);
  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    return null;
  }
  return expiryTime;
}

function setTherapistSessionCookie(response) {
  const expiry = Date.now() + therapistSessionDurationMs;
  const signature = crypto
    .createHmac("sha256", sessionSecret)
    .update(String(expiry))
    .digest("base64url");
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${therapistSessionCookie}=${expiry}.${signature}; Path=/api/therapist; HttpOnly; SameSite=Strict; Max-Age=${therapistSessionDurationMs / 1000}${secure}`,
  );
}

function clearTherapistSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${therapistSessionCookie}=; Path=/api/therapist; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
  );
}

function requireTherapistSession(request, response, next) {
  if (getTherapistSessionExpiry(request)) return next();
  response.status(401).json({ error: "Please sign in to view bookings." });
}

function allowLoginAttempt(request, response) {
  const now = Date.now();
  const attempt = loginAttempts.get(request.ip);
  if (attempt && attempt.resetAt <= now) loginAttempts.delete(request.ip);
  const current = loginAttempts.get(request.ip);
  if (current && current.count >= 10) {
    response.setHeader("Retry-After", Math.ceil((current.resetAt - now) / 1000));
    response.status(429).json({ error: "Too many sign-in attempts. Please wait and try again." });
    return false;
  }
  loginAttempts.set(request.ip, {
    count: (current?.count || 0) + 1,
    resetAt: current?.resetAt || now + 15 * 60 * 1000,
  });
  return true;
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

app.get("/therapist", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(__dirname, "public", "therapist.html"));
});

app.post("/api/therapist/login", (request, response) => {
  if (!config.therapistPassword) {
    return response.status(503).json({ error: "Therapist dashboard password is not configured." });
  }
  if (!allowLoginAttempt(request, response)) return;

  const password = request.body?.password;
  if (typeof password !== "string" || password.length > 256) {
    return response.status(400).json({ error: "Enter the dashboard password." });
  }

  const providedPasswordHash = crypto
    .createHmac("sha256", sessionSecret)
    .update(password)
    .digest();
  const configuredPasswordHash = crypto
    .createHmac("sha256", sessionSecret)
    .update(config.therapistPassword)
    .digest();
  if (!crypto.timingSafeEqual(providedPasswordHash, configuredPasswordHash)) {
    return response.status(401).json({ error: "That password doesn’t match. Please try again." });
  }

  loginAttempts.delete(request.ip);
  setTherapistSessionCookie(response);
  response.json({ authenticated: true });
});

app.get("/api/therapist/session", (request, response) => {
  if (!getTherapistSessionExpiry(request)) {
    return response.status(401).json({ authenticated: false });
  }
  response.json({ authenticated: true });
});

app.post("/api/therapist/logout", requireTherapistSession, (_request, response) => {
  clearTherapistSessionCookie(response);
  response.status(204).end();
});

app.get("/api/therapist/bookings", requireTherapistSession, async (request, response) => {
  const { date, view = "upcoming" } = request.query;
  if (view !== "upcoming" && view !== "all") {
    return response.status(400).json({ error: "Choose upcoming or all bookings." });
  }
  if (date !== undefined && (typeof date !== "string" || !isValidDate(date))) {
    return response.status(400).json({ error: "Choose a valid date." });
  }

  const conditions = [];
  const parameters = [];
  if (date) {
    parameters.push(date);
    conditions.push(`session_date = $${parameters.length}::date`);
  } else if (view === "upcoming") {
    parameters.push(localDateTimeForZone(new Date()).date);
    conditions.push(`session_date >= $${parameters.length}::date`);
  }

  parameters.push(100);
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortOrder = view === "all" && !date ? "DESC" : "ASC";
  try {
    const result = await pool.query(
      `SELECT
        id,
        full_name AS "fullName",
        phone,
        email,
        session_type AS "sessionType",
        to_char(session_date, 'YYYY-MM-DD') AS date,
        to_char(session_time, 'HH24:MI') AS time,
        fee_amount AS fee,
        currency,
        created_at AS "createdAt"
       FROM bookings
       ${whereClause}
       ORDER BY session_date ${sortOrder}, session_time ${sortOrder}
       LIMIT $${parameters.length}`,
      parameters,
    );
    response.json({ bookings: result.rows, limit: 100 });
  } catch (error) {
    console.error("Therapist booking lookup failed:", error);
    response.status(500).json({ error: "Could not load bookings. Please try again." });
  }
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
  if (config.therapistPassword && config.therapistPassword.length < 12) {
    throw new Error("THERAPIST_PASSWORD must be at least 12 characters.");
  }
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
