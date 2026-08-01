import { str, num, bool } from './config.js';

const BEEP = '\x07';

/**
 * Beeps forever until the process is killed. The whole point is that the user
 * is in another room / another country and needs to hear this.
 */
export function startBeeping() {
  if (!bool('BEEP_ENABLED', true)) return () => {};

  const intervalMs = num('BEEP_INTERVAL_MS', 700);
  const perBurst = num('BEEP_COUNT', 3);

  const timer = setInterval(() => {
    process.stdout.write(BEEP.repeat(perBurst));
  }, intervalMs);

  process.stdout.write(BEEP.repeat(perBurst));
  return () => clearInterval(timer);
}

export async function notifyTelegram(text) {
  const token = str('TELEGRAM_BOT_TOKEN');
  const chatId = str('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`  Telegram push failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`  Telegram push failed: ${err.message}`);
  }
}

export function banner(lines) {
  const width = Math.max(...lines.map((line) => line.length)) + 4;
  const edge = '='.repeat(width);
  console.log(`\n${edge}`);
  for (const line of lines) {
    console.log(`  ${line}`);
  }
  console.log(`${edge}\n`);
}

/** Fired when a slot is detected: beeps, banner, Telegram. Returns the beep stopper. */
export async function raiseSlotAlarm(details = []) {
  banner([
    '*** SLOT AVAILABLE — GO BOOK IT NOW ***',
    ...details,
    `detected at ${new Date().toISOString()}`,
  ]);
  const stopBeeping = startBeeping();
  await notifyTelegram(['🚨 TERMÍN AVAILABLE 🚨', ...details].join('\n'));
  return stopBeeping;
}
