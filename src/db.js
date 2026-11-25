const MIGRATION_LOCK = 704_202_512;

const schema = `
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
    async createParty({ partyId, code, name, host }) {
      return transaction(pool, async (client) => {
        await client.query('INSERT INTO parties (id, code, name) VALUES ($1, $2, $3)', [partyId, code, name]);
        await client.query(
          'INSERT INTO players (id, party_id, name, token_hash, is_host) VALUES ($1, $2, $3, $4, true)',
          [host.id, partyId, host.name, host.tokenHash],
        );
      });
    },

    async findPlayer(code, tokenHash) {
      const { rows } = await pool.query(`
        SELECT pl.id, pl.name, pl.is_host, pl.media_consent, pa.id AS party_id, pa.code, pa.phase, pa.version
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
          'INSERT INTO players (id, party_id, name, token_hash, added_by) VALUES ($1, $2, $3, $4, $5)',
          [player.id, partyId, player.name, player.tokenHash, addedBy],
        );
        await bump(client, partyId);
        return 'joined';
      });
    },

    async snapshot(partyId) {
      const [players, photos, guesses] = await Promise.all([
        pool.query('SELECT id, name, is_host, added_by, media_consent FROM players WHERE party_id = $1 ORDER BY created_at, id', [partyId]),
        pool.query('SELECT id, player_id, eyes_key, face_key FROM photos WHERE party_id = $1 ORDER BY id', [partyId]),
        pool.query(`
          SELECT g.guesser_id, g.photo_id, g.guessed_player_id
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
        return 'advanced';
      });
    },

    async addGuess({ partyId, guesserId, photoId, guessedPlayerId }) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query('SELECT phase FROM parties WHERE id = $1 FOR SHARE', [partyId]);
        if (rows[0]?.phase !== 'guessing') return 'closed';
        // A crew is a member plus the players they added; nobody guesses their own crew's Santas.
        const photo = await client.query(`
          SELECT pl.id, coalesce(pl.added_by, pl.id) AS crew FROM photos ph JOIN players pl ON pl.id = ph.player_id
          WHERE ph.id = $1 AND ph.party_id = $2`, [photoId, partyId]);
        if (!photo.rows[0]) return 'missing-photo';
        if (photo.rows[0].id === guesserId) return 'own-photo';
        const guesser = await client.query('SELECT coalesce(added_by, id) AS crew FROM players WHERE id = $1', [guesserId]);
        if (guesser.rows[0]?.crew === photo.rows[0].crew) return 'crew-photo';
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
