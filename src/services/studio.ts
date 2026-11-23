import { db } from '../database/connection.js';
import { broadcastScreenReload } from './websocket.js';

export async function getStudioState(): Promise<Record<string, any>> {
  const state = await db.get<Record<string, any>>('SELECT * FROM studio_state WHERE id = 1');
  if (!state) {
    throw new Error('Estado do estúdio não inicializado.');
  }

  if (state.mode === 'ad' && state.ad_ends_at && Date.parse(state.ad_ends_at) <= Date.now()) {
    await db.run(`
      UPDATE studio_state
      SET mode = 'playlist', source_url = NULL, media_id = NULL, ad_ends_at = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1 AND mode = 'ad' AND ad_ends_at = ?
    `, [state.ad_ends_at]);
    broadcastScreenReload();
    return getStudioState();
  }

  if (state.mode !== 'ad' || !state.media_id) {
    return { ...state, media: null };
  }

  const media = await db.get(
    'SELECT id, filename, original_name, media_type FROM media WHERE id = ?',
    [state.media_id]
  );
  return { ...state, media: media || null };
}
