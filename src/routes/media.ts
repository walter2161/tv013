import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { db } from '../database/connection.js';
import { config } from '../config/index.js';
import { authenticateToken } from '../middleware/auth.js';
import { upload } from '../middleware/upload.js';
import { broadcastScreenReload } from '../services/websocket.js';

const router = Router();

// List all media
router.get('/', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const media = await db.all('SELECT * FROM media ORDER BY created_at DESC');
    res.json({ media });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Upload single media file (multipart/form-data, also works with Clipboard File paste!)
router.post('/upload', authenticateToken, upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    const sourceUrl = String(req.body.source_url || '').trim();
    if (!req.file && !sourceUrl) {
      res.status(400).json({ error: 'Envie um arquivo ou informe uma URL de streaming.' });
      return;
    }

    const id = randomUUID();
    let filename: string;
    let mimeType: string;
    let mediaType: string;
    let fileSize: number;
    let originalName: string;
    let storagePath: string;
    let duration: number;

    if (req.file) {
      const file = req.file;
      const isVideo = file.mimetype.startsWith('video/');
      mediaType = isVideo ? 'video' : 'image';
      filename = file.filename;
      mimeType = file.mimetype;
      fileSize = file.size;
      originalName = req.body.name ? String(req.body.name).trim() : file.originalname;
      storagePath = file.filename;
      duration = isVideo ? (parseInt(req.body.duration_seconds, 10) || 15) : (parseInt(req.body.duration_seconds, 10) || 10);
    } else {
      let parsed: URL;
      try { parsed = new URL(sourceUrl); } catch {
        res.status(400).json({ error: 'Informe uma URL válida de streaming.' });
        return;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        res.status(400).json({ error: 'A URL de streaming deve usar HTTP ou HTTPS.' });
        return;
      }
      mediaType = 'video';
      filename = 'stream-url';
      mimeType = 'text/stream-url';
      fileSize = 0;
      originalName = String(req.body.name || 'Canal de streaming').trim();
      storagePath = sourceUrl;
      duration = parseInt(req.body.duration_seconds, 10) || 15;
    }

    await db.run(`
      INSERT INTO media (id, filename, original_name, media_type, mime_type, file_size, duration_seconds, storage_path, source_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      filename,
      originalName,
      mediaType,
      mimeType,
      fileSize,
      duration,
      storagePath,
      req.file ? null : sourceUrl
    ]);

    const created = await db.get('SELECT * FROM media WHERE id = ?', [id]);
    res.status(201).json({
      message: 'Arquivo enviado com sucesso.',
      media: created,
      url: req.file ? `/media/${filename}` : sourceUrl
    });
  } catch (err: any) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Update media metadata (name / default duration)
router.put('/:id', authenticateToken, upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { original_name, duration_seconds, source_url } = req.body;

    const existing = await db.get('SELECT * FROM media WHERE id = ?', [id]);
    if (!existing) {
      res.status(404).json({ error: 'Mídia não encontrada.' });
      return;
    }

    let replacements: string[] = [];
    let values: any[] = [];
    let sql = 'UPDATE media SET original_name = ?, duration_seconds = ?';

    values.push(original_name ? String(original_name).trim() : existing.original_name);
    values.push(duration_seconds ? parseInt(duration_seconds, 10) : existing.duration_seconds);

    if (req.file) {
      const file = req.file;
      const oldPath = existing.storage_path ? path.resolve(config.mediaPath, existing.filename) : '';
      if (oldPath && !['luds01.png', 'luds02.png', 'luds03.png', 'mov_bbb.mp4', 'movie.mp4', 'luds_logo100.png'].includes(existing.filename) && fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (e) { console.warn('Could not replace old media file:', e); }
      }
      sql += ', filename = ?, media_type = ?, mime_type = ?, file_size = ?, storage_path = ?, source_url = NULL';
      values.push(file.filename, file.mimetype.startsWith('video/') ? 'video' : 'image', file.mimetype, file.size, file.filename);
    } else if (source_url !== undefined) {
      const cleanUrl = String(source_url).trim();
      if (cleanUrl) {
        let parsed: URL;
        try { parsed = new URL(cleanUrl); } catch {
          res.status(400).json({ error: 'Informe uma URL válida de streaming.' });
          return;
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          res.status(400).json({ error: 'A URL de streaming deve usar HTTP ou HTTPS.' });
          return;
        }
        sql += ', media_type = ?, mime_type = ?, source_url = ?, filename = ?, storage_path = ?';
        values.push('video', 'text/stream-url', cleanUrl, 'stream-url', cleanUrl);
      } else {
        sql += ', source_url = NULL';
      }
    }

    sql += ' WHERE id = ?';
    values.push(id);
    await db.run(sql, values);

    broadcastScreenReload();
    const updated = await db.get('SELECT * FROM media WHERE id = ?', [id]);
    res.json({ message: 'Mídia atualizada com sucesso.', media: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete media
router.delete('/:id', authenticateToken, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const media = await db.get('SELECT * FROM media WHERE id = ?', [id]);
    if (!media) {
      res.status(404).json({ error: 'Arquivo de mídia não encontrado.' });
      return;
    }

    // Do not delete pre-bundled sample files from disk if they are shared, or delete uploaded files safely
    const protectedSamples = ['luds01.png', 'luds02.png', 'luds03.png', 'mov_bbb.mp4', 'movie.mp4', 'luds_logo100.png'];
    if (!protectedSamples.includes(media.filename)) {
      const filePath = path.resolve(config.mediaPath, media.filename);
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (e) {
          console.warn('Could not remove file from disk:', e);
        }
      }
    }

    await db.run('DELETE FROM media WHERE id = ?', [id]);
    broadcastScreenReload();
    res.json({ message: 'Arquivo de mídia removido com sucesso.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Stream media with HTTP Range support for HTML5 Video
router.get('/stream/:filename', (req: Request, res: Response): void => {
  const filename = String(req.params.filename || '');
  const filePath = path.resolve(config.mediaPath, filename);

  if (!fs.existsSync(filePath)) {
    res.status(404).send('Arquivo não encontrado.');
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogg': 'video/ogg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  if (range && contentType.startsWith('video/')) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType,
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400'
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

export default router;
