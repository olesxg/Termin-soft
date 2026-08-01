import 'dotenv/config';

export function str(name, fallback = '') {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw.trim();
}

export function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

export function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Comma-separated list, empty entries dropped. */
export function list(name, fallback = []) {
  const raw = str(name);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function json(name, fallback = {}) {
  const raw = str(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} must be valid JSON: ${err.message}`);
  }
}

export function required(name) {
  const value = str(name);
  if (!value) {
    throw new Error(`${name} is not set — copy .env.example to .env and fill it in`);
  }
  return value;
}

/** Interval with random jitter so the request pattern is not perfectly periodic. */
export function nextDelay(baseMs, jitterMs) {
  if (jitterMs <= 0) return baseMs;
  return baseMs + Math.floor(Math.random() * jitterMs);
}

export const ts = () => new Date().toLocaleTimeString('sk-SK', { hour12: false });
