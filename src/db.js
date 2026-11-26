import { randomUUID, timingSafeEqual } from 'node:crypto';

const MIGRATION_LOCK = 704_202_512;

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash bytea PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days'
);
CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx ON account_sessions (expires_at);
CREATE TABLE IF NOT EXISTS login_codes (
  email text PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  code_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz NOT NULL DEFAULT now(),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  send_count integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS parties (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  phase text NOT NULL DEFAULT 'lobby' CHECK (phase IN ('lobby', 'guessing', 'reveal')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parties_created_at_idx ON parties (created_at);
ALTER TABLE parties ADD COLUMN IF NOT EXISTS name text;
CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY,
  party_id uuid NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  is_host boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Players added by another member (kids, anyone without a phone); that member acts for them.
ALTER TABLE players ADD COLUMN IF NOT EXISTS added_by uuid REFERENCES players (id) ON DELETE CASCADE;
ALTER TABLE players ADD COLUMN IF NOT EXISTS media_consent jsonb NOT NULL DEFAULT '{}';
ALTER TABLE players ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES accounts (id);
ALTER TABLE players ADD COLUMN IF NOT EXISTS revealed_at timestamptz;
ALTER TABLE players ADD COLUMN IF NOT EXISTS notification_email text;
UPDATE players SET revealed_at = now() FROM parties
  WHERE players.party_id = parties.id AND parties.phase = 'reveal' AND players.revealed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS players_party_account_idx ON players (party_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS players_added_by_idx ON players (added_by);
CREATE UNIQUE INDEX IF NOT EXISTS players_party_name_idx ON players (party_id, lower(name));
CREATE TABLE IF NOT EXISTS photos (
  id uuid PRIMARY KEY,
  party_id uuid NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
  player_id uuid NOT NULL UNIQUE REFERENCES players (id) ON DELETE CASCADE,
  eyes_key text NOT NULL,
  face_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_party_idx ON photos (party_id);
CREATE TABLE IF NOT EXISTS guesses (
  guesser_id uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  photo_id uuid NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  guessed_player_id uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guesser_id, photo_id)
);
CREATE INDEX IF NOT EXISTS guesses_photo_idx ON guesses (photo_id);
CREATE TABLE IF NOT EXISTS guess_notifications (
  player_id uuid PRIMARY KEY REFERENCES players (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_id uuid
);
CREATE TABLE IF NOT EXISTS notification_links (
  token_hash bytea PRIMARY KEY,
  player_id uuid NOT NULL REFERENCES players (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS notification_links_player_idx ON notification_links (player_id);
CREATE TABLE IF NOT EXISTS monitor_totals (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL DEFAULT now(),
  parties_created bigint NOT NULL DEFAULT 0,
  page_loads bigint NOT NULL DEFAULT 0
);
INSERT INTO monitor_totals (id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS monitor_visitors (
  token_hash bytea PRIMARY KEY,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION monitor_party_created() RETURNS trigger AS $$
BEGIN
  UPDATE monitor_totals SET parties_created = parties_created + 1 WHERE id = true;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS monitor_party_created_trigger ON parties;
CREATE TRIGGER monitor_party_created_trigger AFTER INSERT ON parties
  FOR EACH ROW EXECUTE FUNCTION monitor_party_created();
`;

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(schema);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

export async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createRepository(pool, { retentionDays = 30 } = {}) {
  return {
    ...createAccountRepository(pool, retentionDays),
    async recordVisit(tokenHash) {
      await transaction(pool, async (client) => {
        await client.query(`
          INSERT INTO monitor_visitors (token_hash) VALUES ($1)
          ON CONFLICT (token_hash) DO UPDATE SET last_seen = now()`, [tokenHash]);
        await client.query('UPDATE monitor_totals SET page_loads = page_loads + 1 WHERE id = true');
      });
    },

    async monitorStats() {
      const { rows } = await pool.query(`
        SELECT m.started_at, m.parties_created, m.page_loads,
          (SELECT count(*) FROM monitor_visitors) AS browsers,
          (SELECT count(*) FROM monitor_visitors WHERE last_seen >= now() - interval '7 days') AS browsers_7d,
          (SELECT count(*) FROM parties WHERE created_at > now() - make_interval(days => $1)) AS active_parties,
          (SELECT count(*) FROM players pl JOIN parties pa ON pa.id = pl.party_id
            WHERE pa.created_at > now() - make_interval(days => $1)) AS active_players,
          (SELECT count(*) FROM parties WHERE phase = 'lobby' AND created_at > now() - make_interval(days => $1)) AS lobby,
          (SELECT count(*) FROM parties WHERE phase = 'guessing' AND created_at > now() - make_interval(days => $1)) AS guessing,
          (SELECT count(*) FROM parties WHERE phase = 'reveal' AND created_at > now() - make_interval(days => $1)) AS reveal
        FROM monitor_totals m WHERE m.id = true`, [retentionDays]);
      return rows[0];
    },

    async createParty({ partyId, code, name, host }) {
      return transaction(pool, async (client) => {
        await client.query('INSERT INTO parties (id, code, name) VALUES ($1, $2, $3)', [partyId, code, name]);
        await client.query(
          'INSERT INTO players (id, party_id, name, token_hash, is_host, account_id) VALUES ($1, $2, $3, $4, true, $5)',
          [host.id, partyId, host.name, host.tokenHash, host.accountId],
        );
      });
    },

    async findPlayer(code, tokenHash) {
      const { rows } = await pool.query(`
        SELECT pl.id, pl.name, pl.is_host, pl.media_consent, pl.account_id, pa.id AS party_id, pa.code, pa.phase, pa.version
        FROM players pl JOIN parties pa ON pa.id = pl.party_id
        WHERE pa.code = $1 AND pl.token_hash = $2
          AND pa.created_at > now() - make_interval(days => $3)`, [code, tokenHash, retentionDays]);
      return rows[0];
    },

    async findParty(code) {
      const { rows } = await pool.query(`
        SELECT id, code, name, phase, version FROM parties
        WHERE code = $1 AND created_at > now() - make_interval(days => $2)`, [code, retentionDays]);
      return rows[0];
    },

    async renameParty({ partyId, name }) {
      await pool.query('UPDATE parties SET name = $2, version = version + 1 WHERE id = $1', [partyId, name]);
    },

    async addPlayer({ partyId, player, addedBy = null }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query(
          "SELECT phase FROM parties WHERE id = $1 FOR UPDATE", [partyId]);
        if (rows[0]?.phase !== 'lobby') return 'closed';
        await client.query(
          'INSERT INTO players (id, party_id, name, token_hash, added_by, account_id, notification_email) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [player.id, partyId, player.name, player.tokenHash, addedBy, player.accountId ?? null, player.notificationEmail ?? null],
        );
        await bump(client, partyId);
        return 'joined';
      });
    },

    async snapshot(partyId) {
      const [players, photos, guesses] = await Promise.all([
        pool.query(`SELECT pl.id, pl.name, pl.is_host, pl.added_by, pl.media_consent, pl.revealed_at,
          coalesce(pl.notification_email, a.email) AS notification_email, n.status AS notification_status,
          n.attempts AS notification_attempts
          FROM players pl LEFT JOIN accounts a ON a.id = pl.account_id
          LEFT JOIN guess_notifications n ON n.player_id = pl.id
          WHERE pl.party_id = $1 ORDER BY pl.created_at, pl.id`, [partyId]),
        pool.query('SELECT id, player_id, eyes_key, face_key FROM photos WHERE party_id = $1 ORDER BY id', [partyId]),
        pool.query(`
          SELECT g.guesser_id, g.photo_id, g.guessed_player_id, g.created_at
          FROM guesses g JOIN photos ph ON ph.id = g.photo_id
          WHERE ph.party_id = $1`, [partyId]),
      ]);
      return { players: players.rows, photos: photos.rows, guesses: guesses.rows };
    },

    async findAddedPlayer({ partyId, addedBy, playerId }) {
      const { rows } = await pool.query(
        'SELECT id, name, is_host, media_consent FROM players WHERE id = $1 AND party_id = $2 AND added_by = $3',
        [playerId, partyId, addedBy]);
      return rows[0];
    },

    async lockLobby(client, partyId) {
      const { rows } = await client.query('SELECT phase FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
      return rows[0]?.phase === 'lobby';
    },

    async saveMediaConsent({ partyId, playerId, kind, granted, recordedBy }) {
      return transaction(pool, async (client) => {
        if (!(await this.lockLobby(client, partyId))) return 'closed';
        const { rowCount } = await client.query(`
          UPDATE players SET media_consent = media_consent || jsonb_build_object($2::text,
            jsonb_build_object('granted', $3::boolean, 'recordedAt', now(), 'recordedBy', $4::text, 'version', 1))
          WHERE id = $1 AND party_id = $5`, [playerId, kind, granted, recordedBy, partyId]);
        if (!rowCount) return 'missing';
        await bump(client, partyId);
        return 'saved';
      });
    },

    async savePhoto({ partyId, playerId, photo, source, recordedBy }) {
      return transaction(pool, async (client) => {
        if (!(await this.lockLobby(client, partyId))) return { status: 'closed' };
        const consent = await client.query('SELECT media_consent FROM players WHERE id = $1 AND party_id = $2', [playerId, partyId]);
        if (!consent.rows[0]?.media_consent[source]?.granted) return { status: 'consent-required' };
        const { rows } = await client.query(
          'SELECT eyes_key, face_key FROM photos WHERE player_id = $1', [playerId]);
        await client.query(`
          INSERT INTO photos (id, party_id, player_id, eyes_key, face_key) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (player_id) DO UPDATE SET id = EXCLUDED.id, eyes_key = EXCLUDED.eyes_key,
            face_key = EXCLUDED.face_key, created_at = now()`,
        [photo.id, partyId, playerId, photo.eyesKey, photo.faceKey]);
        await client.query(`
          UPDATE players SET media_consent = media_consent || jsonb_build_object('sharing',
            jsonb_build_object('granted', true, 'recordedAt', now(), 'recordedBy', $2::text, 'version', 1))
          WHERE id = $1`, [playerId, recordedBy]);
        await bump(client, partyId);
        return { status: 'saved', replaced: rows[0] };
      });
    },

    // The host can remove anyone else; members can remove players they added.
    // Removing a member also removes the players they added (and their photos).
    async removePlayer({ partyId, playerId, requester }) {
      return transaction(pool, async (client) => {
        if (!(await this.lockLobby(client, partyId))) return { status: 'closed' };
        const { rows } = await client.query(
          'SELECT is_host, added_by FROM players WHERE id = $1 AND party_id = $2', [playerId, partyId]);
        if (!rows[0]) return { status: 'missing' };
        if (rows[0].is_host) return { status: 'host' };
        if (!requester.is_host && rows[0].added_by !== requester.id) return { status: 'forbidden' };
        const photos = await client.query(`
          SELECT ph.eyes_key, ph.face_key FROM photos ph JOIN players pl ON pl.id = ph.player_id
          WHERE pl.id = $1 OR pl.added_by = $1`, [playerId]);
        await client.query('DELETE FROM players WHERE id = $1', [playerId]);
        await bump(client, partyId);
        return { status: 'removed', photos: photos.rows };
      });
    },

    async advance({ partyId, from, to, minimumPhotos = 0 }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query('SELECT phase FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
        if (rows[0]?.phase !== from) return 'wrong-phase';
        const count = await client.query('SELECT count(*)::int AS n FROM photos WHERE party_id = $1', [partyId]);
        if (count.rows[0].n < minimumPhotos) return 'not-enough-photos';
        await client.query('UPDATE parties SET phase = $2, version = version + 1 WHERE id = $1', [partyId, to]);
        if (from === 'lobby' && to === 'guessing') {
          await client.query(`
            INSERT INTO guess_notifications (player_id)
            SELECT pl.id FROM players pl LEFT JOIN accounts a ON a.id = pl.account_id
            WHERE pl.party_id = $1 AND pl.added_by IS NULL
              AND coalesce(pl.notification_email, a.email) IS NOT NULL
            ON CONFLICT DO NOTHING`, [partyId]);
        }
        return 'advanced';
      });
    },

    async saveNotificationEmail({ partyId, playerId, email, replacementHash }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query('SELECT phase FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
        if (!rows[0]) return 'missing';
        const existing = await client.query(`
          SELECT coalesce(pl.notification_email, a.email) AS email FROM players pl
          LEFT JOIN accounts a ON a.id = pl.account_id
          WHERE pl.id = $1 AND pl.party_id = $2 AND pl.added_by IS NULL`, [playerId, partyId]);
        if (!existing.rows[0]) return 'missing';
        if (existing.rows[0].email === email) return 'unchanged';
        const updated = await client.query(`
          UPDATE players SET notification_email = $3 WHERE id = $1 AND party_id = $2 AND added_by IS NULL`,
        [playerId, partyId, email]);
        if (!updated.rowCount) return 'missing';
        await client.query('DELETE FROM notification_links WHERE player_id = $1', [playerId]);
        if (replacementHash) {
          await client.query('INSERT INTO notification_links (token_hash, player_id) VALUES ($1, $2)', [replacementHash, playerId]);
        }
        if (rows[0].phase === 'guessing') {
          await client.query(`
            INSERT INTO guess_notifications (player_id) VALUES ($1)
            ON CONFLICT (player_id) DO UPDATE SET status = 'pending', attempts = 0,
              next_attempt = now(), lease_until = NULL, lease_id = NULL`, [playerId]);
        }
        await bump(client, partyId);
        return 'saved';
      });
    },

    async findNotificationPlayer(code, tokenHash) {
      const { rows } = await pool.query(`
        SELECT pl.id, pl.name, pl.is_host, pl.media_consent, pl.account_id,
          pa.id AS party_id, pa.code, pa.phase, pa.version
        FROM notification_links nl JOIN players pl ON pl.id = nl.player_id
        JOIN parties pa ON pa.id = pl.party_id
        WHERE nl.token_hash = $1 AND pa.code = $2
          AND pa.created_at > now() - make_interval(days => $3)`, [tokenHash, code, retentionDays]);
      return rows[0];
    },

    async claimGuessNotification({ tokenHash, leaseId }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query(`
          SELECT n.player_id, pa.id AS party_id, pa.code, coalesce(pl.notification_email, a.email) AS email
          FROM guess_notifications n JOIN players pl ON pl.id = n.player_id
          JOIN parties pa ON pa.id = pl.party_id LEFT JOIN accounts a ON a.id = pl.account_id
          WHERE pa.created_at > now() - make_interval(days => $1) AND pa.phase = 'guessing'
            AND coalesce(pl.notification_email, a.email) IS NOT NULL
            AND ((n.status = 'pending' AND n.next_attempt <= now())
              OR (n.status = 'sending' AND n.lease_until < now()))
          ORDER BY n.next_attempt FOR UPDATE OF n SKIP LOCKED LIMIT 1`, [retentionDays]);
        const item = rows[0];
        if (!item) return null;
        await client.query(`
          UPDATE guess_notifications SET status = 'sending', attempts = attempts + 1,
            lease_id = $2, lease_until = now() + interval '2 minutes' WHERE player_id = $1`, [item.player_id, leaseId]);
        await client.query('INSERT INTO notification_links (token_hash, player_id) VALUES ($1, $2)', [tokenHash, item.player_id]);
        return item;
      });
    },

    async finishGuessNotification({ playerId, partyId, leaseId, sent }) {
      return transaction(pool, async (client) => {
        const { rowCount } = await client.query(`
          UPDATE guess_notifications SET status = $3, lease_id = NULL, lease_until = NULL,
            next_attempt = now() + make_interval(secs => least(900, 15 * power(2, least(attempts, 6))::int))
          WHERE player_id = $1 AND lease_id = $2`,
        [playerId, leaseId, sent ? 'sent' : 'pending']);
        if (rowCount) await bump(client, partyId);
      });
    },

    async addGuess({ partyId, guesserId, photoId, guessedPlayerId }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query('SELECT phase FROM parties WHERE id = $1 FOR SHARE', [partyId]);
        if (rows[0]?.phase !== 'guessing') return 'closed';
        const guesser = await client.query('SELECT revealed_at FROM players WHERE id = $1 AND party_id = $2', [guesserId, partyId]);
        if (!guesser.rows[0] || guesser.rows[0].revealed_at) return 'closed';
        const photo = await client.query(`
          SELECT pl.id FROM photos ph JOIN players pl ON pl.id = ph.player_id
          WHERE ph.id = $1 AND ph.party_id = $2`, [photoId, partyId]);
        if (!photo.rows[0]) return 'missing-photo';
        if (photo.rows[0].id === guesserId) return 'own-photo';
        const suspect = await client.query(`
          SELECT 1 FROM players pl JOIN photos ph ON ph.player_id = pl.id
          WHERE pl.id = $1 AND pl.party_id = $2 AND pl.id <> $3`, [guessedPlayerId, partyId, guesserId]);
        if (!suspect.rows[0]) return 'invalid-suspect';
        const inserted = await client.query(`
          INSERT INTO guesses (guesser_id, photo_id, guessed_player_id) VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING`, [guesserId, photoId, guessedPlayerId]);
        if (!inserted.rowCount) return 'duplicate';
        await client.query('UPDATE parties SET version = version + 1 WHERE id = $1', [partyId]);
        return 'saved';
      });
    },

    async revealPlayer({ partyId, playerId }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query('SELECT phase FROM parties WHERE id = $1 FOR UPDATE', [partyId]);
        if (rows[0]?.phase !== 'guessing') return 'closed';
        const updated = await client.query(`
          UPDATE players SET revealed_at = now()
          WHERE id = $1 AND party_id = $2 AND revealed_at IS NULL`, [playerId, partyId]);
        if (!updated.rowCount) return 'closed';
        await client.query(`
          UPDATE parties SET version = version + 1,
            phase = CASE WHEN NOT EXISTS (
              SELECT 1 FROM players WHERE party_id = $1 AND revealed_at IS NULL
            ) THEN 'reveal' ELSE phase END
          WHERE id = $1`, [partyId]);
        return 'revealed';
      });
    },

    async deleteExpiredParties(days) {
      const { rowCount } = await pool.query(
        "DELETE FROM parties WHERE created_at < now() - make_interval(days => $1)", [days]);
      return rowCount;
    },
  };
}

function bump(client, partyId) {
  return client.query('UPDATE parties SET version = version + 1 WHERE id = $1', [partyId]);
}

function createAccountRepository(pool, retentionDays) {
  return {
    async requestLogin({ email, tokenHash, codeHash }) {
      const { rowCount } = await pool.query(`
        INSERT INTO login_codes (email, token_hash, code_hash, expires_at)
        VALUES ($1, $2, $3, now() + interval '10 minutes')
        ON CONFLICT (email) DO UPDATE SET token_hash = EXCLUDED.token_hash,
          code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = now(),
          window_started_at = CASE WHEN login_codes.window_started_at < now() - interval '1 hour' THEN now() ELSE login_codes.window_started_at END,
          send_count = CASE WHEN login_codes.window_started_at < now() - interval '1 hour' THEN 1 ELSE login_codes.send_count + 1 END
        WHERE login_codes.sent_at < now() - interval '1 minute'
          AND (login_codes.window_started_at < now() - interval '1 hour' OR login_codes.send_count < 5)`,
      [email, tokenHash, codeHash]);
      return rowCount === 1;
    },

    async cancelLogin(tokenHash) {
      await pool.query('UPDATE login_codes SET expires_at = now() WHERE token_hash = $1', [tokenHash]);
    },

    async verifyLogin({ tokenHash, codeHash, sessionHash, claims }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query(`
          SELECT email, code_hash FROM login_codes WHERE token_hash = $1
            AND expires_at > now() AND attempts < 5 FOR UPDATE`, [tokenHash]);
        const challenge = rows[0];
        if (!challenge) return null;
        if (!timingSafeEqual(challenge.code_hash, codeHash)) {
          await client.query('UPDATE login_codes SET attempts = attempts + 1 WHERE token_hash = $1', [tokenHash]);
          return null;
        }
        await client.query('UPDATE login_codes SET expires_at = now(), attempts = 5 WHERE token_hash = $1', [tokenHash]);
        const account = await client.query(`
          INSERT INTO accounts (id, email) VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, email`,
        [randomUUID(), challenge.email]);
        const user = account.rows[0];
        await client.query('INSERT INTO account_sessions (token_hash, account_id) VALUES ($1, $2)', [sessionHash, user.id]);
        const claimed = [];
        const rejected = [];
        for (const claim of claims) {
          const found = await client.query(`
            SELECT pl.id, pl.account_id, pl.party_id FROM players pl JOIN parties pa ON pa.id = pl.party_id
            WHERE pa.code = $1 AND (pl.token_hash = $2 OR EXISTS (
              SELECT 1 FROM notification_links nl WHERE nl.player_id = pl.id AND nl.token_hash = $2
            )) AND pl.added_by IS NULL
              AND pa.created_at > now() - make_interval(days => $3) FOR UPDATE OF pl`,
          [claim.code, claim.tokenHash, retentionDays]);
          const player = found.rows[0];
          const existing = player && await client.query(
            'SELECT id FROM players WHERE party_id = $1 AND account_id = $2', [player.party_id, user.id]);
          if (!player || (player.account_id && player.account_id !== user.id) ||
              (existing.rows[0] && existing.rows[0].id !== player.id)) {
            rejected.push(claim.code);
            continue;
          }
          await client.query('UPDATE players SET account_id = $2 WHERE id = $1', [player.id, user.id]);
          claimed.push(claim.code);
        }
        return { user, claimed, rejected };
      });
    },

    async findAccountSession(tokenHash) {
      const { rows } = await pool.query(`
        SELECT a.id, a.email, s.expires_at FROM account_sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND s.created_at > now() - interval '365 days'`, [tokenHash]);
      const session = rows[0];
      if (!session) return null;
      const renewed = session.expires_at.getTime() < Date.now() + 89 * 24 * 60 * 60 * 1000;
      if (renewed) {
        const result = await pool.query(`
          UPDATE account_sessions SET expires_at = least(now() + interval '90 days', created_at + interval '365 days')
          WHERE token_hash = $1 AND expires_at > now()`, [tokenHash]);
        if (!result.rowCount) return null;
      }
      return { user: { id: session.id, email: session.email }, renewed };
    },

    async deleteAccountSession(tokenHash) {
      await pool.query('DELETE FROM account_sessions WHERE token_hash = $1', [tokenHash]);
    },

    async accountParties(accountId) {
      const { rows } = await pool.query(`
        SELECT pa.code, pa.name, pa.phase, pl.id AS player_id, pl.is_host,
          host.name AS host_name
        FROM players pl JOIN parties pa ON pa.id = pl.party_id
          JOIN players host ON host.party_id = pa.id AND host.is_host
        WHERE pl.account_id = $1 AND pa.created_at > now() - make_interval(days => $2)
        ORDER BY pa.created_at DESC`, [accountId, retentionDays]);
      return rows;
    },

    async findAccountPlayer(code, accountId) {
      const { rows } = await pool.query(`
        SELECT pl.id, pl.name, pl.is_host, pl.media_consent, pl.account_id,
          pa.id AS party_id, pa.code, pa.phase, pa.version
        FROM players pl JOIN parties pa ON pa.id = pl.party_id
        WHERE pa.code = $1 AND pl.account_id = $2
          AND pa.created_at > now() - make_interval(days => $3)`, [code, accountId, retentionDays]);
      return rows[0];
    },

    async cleanupAccounts() {
      await pool.query("DELETE FROM login_codes WHERE sent_at < now() - interval '1 day'");
      await pool.query('DELETE FROM account_sessions WHERE expires_at < now()');
    },
  };
}
