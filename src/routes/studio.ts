import { Router, Request, Response } from 'express';
import { db } from '../database/connection.js';
import { authenticateToken } from '../middleware/auth.js';
import { broadcastScreenReload } from '../services/websocket.js';
import { getStudioState } from '../services/studio.js';

const router = Router();

router.get('/state', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    res.json({ studio: await getStudioState() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/state', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { mode } = req.body || {};
    if (!['playlist', 'stream', 'ad', 'blank'].includes(mode)) {
      res.status(400).json({ error: 'Modo inválido. Use playlist, stream, ad ou blank.' });
      return;
    }

    if (mode === 'playlist' || mode === 'blank') {
      await db.run(`
        UPDATE studio_state
        SET mode = ?, source_url = NULL, media_id = NULL, ad_ends_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `, [mode]);
    } else if (mode === 'stream') {
      let sourceUrl: URL;
      try {
        sourceUrl = new URL(String(req.body.source_url || '').trim());
      } catch {
        res.status(400).json({ error: 'Informe uma URL válida para o canal ou stream.' });
        return;
      }

      if (!['http:', 'https:'].includes(sourceUrl.protocol)) {
        res.status(400).json({ error: 'O stream deve usar HTTP ou HTTPS.' });
        return;
      }

      await db.run(`
        UPDATE studio_state
        SET mode = 'stream', source_url = ?, media_id = NULL, ad_ends_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `, [sourceUrl.toString()]);
    } else {
      const mediaId = String(req.body.media_id || '');
      const duration = Number(req.body.duration_seconds);
      if (!mediaId || !Number.isInteger(duration) || duration < 5 || duration > 3600) {
        res.status(400).json({ error: 'Selecione uma mídia e informe uma duração entre 5 e 3600 segundos.' });
        return;
      }

      const media = await db.get('SELECT id FROM media WHERE id = ?', [mediaId]);
      if (!media) {
        res.status(404).json({ error: 'Mídia de propaganda não encontrada.' });
        return;
      }

      const adEndsAt = new Date(Date.now() + duration * 1000).toISOString();
      await db.run(`
        UPDATE studio_state
        SET mode = 'ad', source_url = NULL, media_id = ?, ad_ends_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `, [mediaId, adEndsAt]);
    }

    broadcastScreenReload();
    res.json({ message: 'Transmissão atualizada.', studio: await getStudioState() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
