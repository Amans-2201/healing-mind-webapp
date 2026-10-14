CREATE TABLE IF NOT EXISTS bookings (
  id BIGSERIAL PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  email VARCHAR(254),
  session_type VARCHAR(20) NOT NULL CHECK (session_type IN ('online', 'in-person')),
  session_date DATE NOT NULL,
  session_time TIME NOT NULL,
  fee_amount INTEGER NOT NULL,
  currency CHAR(3) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bookings_unique_session UNIQUE (session_date, session_time)
);

CREATE INDEX IF NOT EXISTS bookings_session_date_idx ON bookings (session_date);
