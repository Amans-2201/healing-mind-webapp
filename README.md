# Healing Mind booking app

A small, mobile-friendly psychotherapy booking site using Node.js, Express, and PostgreSQL. It stores a requested appointment, prevents two bookings for the same date and time, then gives the client a pre-filled WhatsApp message to send to the therapist's business account.

## Run locally

Requirements: Node.js 20+ and PostgreSQL.

1. Create a PostgreSQL database named `healing_mind`.
2. Copy `.env.example` to `.env` and update `DATABASE_URL`, therapist details, fee, schedule, and WhatsApp number. The WhatsApp number must include the country code (digits only is recommended).
3. Install and start:

   ```sh
   npm install
   npm run dev
   ```

4. Open <http://localhost:3000>.

The app creates its `bookings` table at startup. To change the displayed therapist, fee, or schedule, update the corresponding environment variables. `AVAILABLE_WEEKDAYS` uses Sunday = 0 through Saturday = 6.

## Payment

Online payment is optional. Set `PAYMENT_URL` to a checkout/payment link to show the payment action after a booking. Leave it blank to hide that action. The URL can include `{bookingId}` and `{amount}` placeholders, which are replaced when the booking is created.

This app does not verify payment status or process card data. Use a provider-hosted checkout link and confirm appointments through WhatsApp. Never collect card details in this app.

## Deploy to Render for testing

1. Push this folder to a GitHub repository.
2. In Render, choose **New + → Blueprint**, connect the repository, and deploy the included `render.yaml`.
3. Set `WHATSAPP_NUMBER` in the web service environment to the therapist's WhatsApp Business number, including country code. Set `PAYMENT_URL` if online payment is enabled.
4. Wait for the deployment to become live, then test creating a booking and opening the WhatsApp message.

The Blueprint provisions a free web service and a free PostgreSQL database. Render's free Postgres instances are intended for testing and expire after 30 days; do not use this configuration for production or store sensitive health information. The booking form intentionally does not request therapy notes or health details.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `BUSINESS_NAME` | Practice name | `Stillpoint` |
| `THERAPIST_NAME` | Therapist display name | `Your therapist` |
| `THERAPIST_TITLE` | Role displayed in the site | `Psychotherapist` |
| `THERAPIST_CREDENTIALS` | Short credential line | `A supportive space for you` |
| `THERAPIST_BIO` | Practice introduction | Calm, confidential space |
| `WHATSAPP_NUMBER` | WhatsApp Business number in international format | Not configured |
| `SESSION_FEE` | Fee per session | `1800` |
| `CURRENCY` | ISO 4217 currency code | `INR` |
| `SESSION_DURATION_MINUTES` | Session duration | `50` |
| `TIMEZONE` | Displayed appointment time zone | `Asia/Kolkata` |
| `AVAILABLE_WEEKDAYS` | Comma-separated weekdays (0–6) | `1,2,3,4,5,6` |
| `DAILY_START_TIME` / `DAILY_END_TIME` | Daily availability window (`HH:MM`) | `09:00` / `17:00` |
| `SLOT_INTERVAL_MINUTES` | Minutes between offered start times | `60` |
| `PAYMENT_URL` | Optional external checkout URL | Hidden |

## API

- `GET /api/health` — app/database health check.
- `GET /api/config` — public practice and booking display settings.
- `GET /api/availability?date=YYYY-MM-DD` — available session start times.
- `POST /api/bookings` — saves a booking and returns the WhatsApp/payment links.
