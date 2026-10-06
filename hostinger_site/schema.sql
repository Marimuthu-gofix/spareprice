-- Spareprice database tables (MySQL / MariaDB, Hostinger).
--
-- You normally do NOT need this file: the site and the API create these
-- tables by themselves on first use. It is here for a manual setup, a new
-- database, or as a reference.
--
-- How to run it: hPanel > Databases > phpMyAdmin > choose your database on
-- the left > Import tab > choose this file > Go.  (Or paste it into the SQL
-- tab and press Go.)
--
-- It is safe to run on a database that already has the tables: every
-- statement uses IF NOT EXISTS, so nothing is changed or deleted.

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- 1. Sign-in accounts for the dashboard (admin / user).
--    Rows are added from the site: the first visit creates the admin,
--    and the admin adds everyone else under Accounts.
--    password_hash holds a scrambled password, never the real one.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(60)  NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(10)  NOT NULL DEFAULT 'user',   -- 'admin' or 'user'
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- 2. Scraped prices. One row per check of one spare part.
--    Written by the scrapers through /api/prices; read by the dashboard.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_history (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  date        VARCHAR(40)  NOT NULL,          -- when it was checked, ISO time in UTC
  brand       VARCHAR(100) NOT NULL,
  model       VARCHAR(191) NOT NULL,
  part        VARCHAR(191) NOT NULL,
  price       VARCHAR(255) NULL,              -- the text as shown on the source site
  price_value DOUBLE NULL,                    -- the number, for sorting and Excel
  currency    VARCHAR(10) NULL,
  url         TEXT NOT NULL,                  -- the source page
  status      VARCHAR(20) NOT NULL,           -- 'ok' or 'error'
  error       TEXT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_observation (date, brand, model, part),
  KEY idx_lookup (brand, model, part, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
