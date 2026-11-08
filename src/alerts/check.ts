import { TelegramNotifier } from '../adapters/alerts';
import { NotificationError } from './errors';

/** No network activity occurs until this command is explicitly invoked. */
export async function checkTelegram(env: NodeJS.ProcessEnv, sendTest = false) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new NotificationError('telegram_not_configured', { permanent: true });
  const notifier = new TelegramNotifier(token, chatId);
  const checked = await notifier.check();
  if (!sendTest) return checked;
  await notifier.notify(
    'Blotato monitoring check\nThis message was requested by the operator to verify notification delivery.\n' +
      new Date().toISOString(),
  );
  return { ...checked, deliveryTested: true };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--send-test')) {
    console.error('Usage: node --env-file=<private environment> dist/alerts/check.js [--send-test]');
    process.exitCode = 2;
  } else {
    checkTelegram(process.env, args.includes('--send-test'))
      .then((status) => console.log(JSON.stringify(status)))
      .catch((error: unknown) => {
        console.error(error instanceof NotificationError ? error.code : 'telegram_check_failed');
        process.exitCode = 1;
      });
  }
}
