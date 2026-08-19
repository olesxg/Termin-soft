#!/usr/bin/env node
/**
 * Fires the exact alert path a real slot would fire, so you find out now —
 * not at the one moment it matters — whether the message actually reaches your
 * phone. Run it after filling TELEGRAM_* in .env:
 *
 *   npm run notify:test
 */
import { str } from '../src/config.js';
import { notifyTelegram } from '../src/alert.js';

const token = str('TELEGRAM_BOT_TOKEN');
const chatId = str('TELEGRAM_CHAT_ID');

if (!token || !chatId) {
  console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set in .env.\n');
  console.error('  1. Open @BotFather in Telegram, send /newbot, copy the token.');
  console.error('  2. Send any message to your new bot.');
  console.error('  3. Open https://api.telegram.org/bot<TOKEN>/getUpdates and copy');
  console.error('     the number at result[0].message.chat.id');
  console.error('  4. Put both into .env, then run this again.');
  process.exit(1);
}

console.log(`Sending a test alert to chat ${chatId}...`);

// Same helper the slot alarm uses — if this arrives, the real one will too.
await notifyTelegram(
  [
    '✅ Termín monitor — test',
    '',
    'If you can read this, alerts work.',
    'The real one will look like this and say which dates opened up.',
  ].join('\n'),
);

// notifyTelegram logs its own failure; verify delivery independently so a
// silent misconfiguration cannot pass as success.
const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
  signal: AbortSignal.timeout(15_000),
}).catch(() => null);

if (!res || !res.ok) {
  console.error('\nThe bot token looks wrong — Telegram rejected getMe.');
  process.exit(1);
}
const me = await res.json();
console.log(`Bot: @${me.result?.username ?? '?'}`);
console.log('\nCheck your phone. If nothing arrived, the chat id is wrong —');
console.log('send your bot a message first, then re-read getUpdates.');
