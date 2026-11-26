import { createHash, randomBytes, randomUUID } from 'node:crypto';

async function sendMail({ apiKey, sender, email, subject, content, description }) {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from: { email: sender, name: "Santa's Helpers | Guess Who's Santa" },
      subject,
      tracking_settings: { click_tracking: { enable: false, enable_text: false } },
      content,
    }),
  });
  if (response.status !== 202) {
    const error = new Error(`SendGrid rejected ${description} (HTTP ${response.status})`);
    error.name = 'SendGridDeliveryError';
    error.status = response.status;
    throw error;
  }
}

export function createGuessMailer({ apiKey, sender }) {
  if (!apiKey || !sender) return undefined;
  return ({ email, link }) => sendMail({
    apiKey, sender, email, subject: "It's time to guess who's Santa!", description: 'guessing notification',
    content: [{
      type: 'text/plain',
      value: `The Santas are ready! Open your private link to return to your party and make your guesses:\n\n${link}\n\nThis link gives access to your party. Please don't share it. It expires when the party expires.`,
    }, {
      type: 'text/html',
      value: `<p>The Santas are ready! It's time to guess who's behind the beards.</p><p><a href="${link}">Return to your party and guess</a></p><p>This link gives access to your party. Please don't share it. It expires when the party expires.</p>`,
    }],
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function createSubmissionMailer({ apiKey, sender }) {
  if (!apiKey || !sender) return undefined;
  return ({ email, link, playerName }) => sendMail({
    apiKey, sender, email, subject: 'A new Santa is ready!', description: 'Santa submission notification',
    content: [{
      type: 'text/plain',
      value: `${playerName} submitted a Santa photo! Open your private party link to see who is ready:\n\n${link}\n\nThis link gives access to your party. Please don't share it. It expires when the party expires.`,
    }, {
      type: 'text/html',
      value: `<p>${escapeHtml(playerName)} submitted a Santa photo!</p><p><a href="${escapeHtml(link)}">See who is ready in your party</a></p><p>This link gives access to your party. Please don't share it. It expires when the party expires.</p>`,
    }],
  });
}

export function createNotificationWorker({ repository, sendGuessEmail, sendSubmissionEmail, clientOrigin }) {
  let running = false;
  async function deliver({ claim, finish, send, kind }) {
    for (let count = 0; count < 25; count += 1) {
      const token = randomBytes(32).toString('base64url');
      const leaseId = randomUUID();
      const item = await claim({ tokenHash: createHash('sha256').update(token).digest(), leaseId });
      if (!item) break;
      const link = `${clientOrigin}/p/${item.code}#access=${token}`;
      let sent = false;
      try {
        if (!send) throw new Error(`${kind} email delivery is not configured`);
        await send({ email: item.email, link, ...(item.player_name && { playerName: item.player_name }) });
        sent = true;
      } catch (error) {
        if (!send) console.error(`${kind} email delivery is not configured`);
        else console.error(`${kind} delivery failed`, { name: error.name, status: error.status });
      }
      await finish({ playerId: item.player_id, partyId: item.party_id, leaseId, sent });
    }
  }
  async function run() {
    if (running) return;
    running = true;
    try {
      const results = await Promise.allSettled([
        deliver({ claim: repository.claimGuessNotification, finish: repository.finishGuessNotification,
          send: sendGuessEmail, kind: 'Guessing notification' }),
        deliver({ claim: repository.claimSubmissionNotification, finish: repository.finishSubmissionNotification,
          send: sendSubmissionEmail, kind: 'Santa submission notification' }),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      running = false;
    }
  }
  return { run };
}
