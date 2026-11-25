import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function createGuessMailer({ apiKey, sender }) {
  if (!apiKey || !sender) return undefined;
  return async ({ email, link }) => {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: sender, name: "Santa's Helpers | Guess Who's Santa" },
        subject: "It's time to guess who's Santa!",
        tracking_settings: { click_tracking: { enable: false, enable_text: false } },
        content: [{
          type: 'text/plain',
          value: `The Santas are ready! Open your private link to return to your party and make your guesses:\n\n${link}\n\nThis link gives access to your party. Please don't share it. It expires when the party expires.`,
        }, {
          type: 'text/html',
          value: `<p>The Santas are ready! It's time to guess who's behind the beards.</p><p><a href="${link}">Return to your party and guess</a></p><p>This link gives access to your party. Please don't share it. It expires when the party expires.</p>`,
        }],
      }),
    });
    if (response.status !== 202) {
      const error = new Error(`SendGrid rejected guessing notification (HTTP ${response.status})`);
      error.name = 'SendGridDeliveryError';
      error.status = response.status;
      throw error;
    }
  };
}

export function createNotificationWorker({ repository, sendGuessEmail, clientOrigin }) {
  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      for (let count = 0; count < 25; count += 1) {
        const token = randomBytes(32).toString('base64url');
        const leaseId = randomUUID();
        const item = await repository.claimGuessNotification({
          tokenHash: createHash('sha256').update(token).digest(), leaseId,
        });
        if (!item) break;
        const link = `${clientOrigin}/p/${item.code}#access=${token}`;
        let sent = false;
        try {
          if (!sendGuessEmail) throw new Error('Guessing notification email delivery is not configured');
          await sendGuessEmail({ email: item.email, link });
          sent = true;
        } catch (error) {
          if (!sendGuessEmail) console.error('Guessing notification email delivery is not configured');
          else console.error('Guessing notification delivery failed', { name: error.name, status: error.status });
        }
        await repository.finishGuessNotification({ playerId: item.player_id, partyId: item.party_id, leaseId, sent });
      }
    } finally {
      running = false;
    }
  }
  return { run };
}
