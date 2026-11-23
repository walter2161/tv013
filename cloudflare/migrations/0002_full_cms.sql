CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS layouts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  description TEXT,
  config_json TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS displays (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  layout_id TEXT,
  playlist_id TEXT,
  orientation TEXT NOT NULL DEFAULT 'landscape',
  resolution TEXT DEFAULT '1920x1080',
  location TEXT,
  show_header INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'offline',
  last_ping TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT,
  original_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER DEFAULT 10,
  storage_path TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  media_id TEXT,
  widget_type TEXT,
  widget_config_json TEXT,
  order_num INTEGER NOT NULL DEFAULT 1,
  duration_seconds INTEGER NOT NULL DEFAULT 10,
  is_active INTEGER NOT NULL DEFAULT 1,
  start_date TEXT,
  end_date TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue_calls (
  id TEXT PRIMARY KEY,
  ticket_number TEXT NOT NULL,
  location TEXT NOT NULL,
  service_type TEXT NOT NULL DEFAULT 'Normal',
  service_name TEXT DEFAULT 'Atendimento Geral',
  patient_name TEXT,
  status TEXT NOT NULL DEFAULT 'waiting',
  called_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_desks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'Consultório',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT 'A',
  is_priority INTEGER NOT NULL DEFAULT 0,
  current_seq INTEGER NOT NULL DEFAULT 100,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS studio_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'playlist',
  source_url TEXT,
  media_id TEXT,
  ad_ends_at TEXT,
  headlines TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE media ADD COLUMN filename TEXT;
ALTER TABLE media ADD COLUMN duration_seconds INTEGER DEFAULT 10;
ALTER TABLE media ADD COLUMN storage_path TEXT;
ALTER TABLE media ADD COLUMN source_url TEXT;

INSERT OR IGNORE INTO users (id, name, username, password_hash, role)
VALUES ('admin', 'Administrador', 'admin', 'a184b7fd28abf530e8b0f1f265b7e1ca0b614db89d05251d5540fc92ab620f50', 'admin');

INSERT OR IGNORE INTO users (id, name, username, password_hash, role)
VALUES ('edkallenn', 'Edkallenn', 'edkallenn', '8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92', 'admin');

INSERT OR IGNORE INTO layouts (id, name, aspect_ratio, description, config_json) VALUES
('layout-fullscreen', 'Tela Cheia (16:9 / 9:16)', '16:9', 'Exibição em tela cheia.', '{"name":"Tela Cheia","aspect_ratio":"16:9","zones":[{"id":"zone_main","name":"Mídia Principal","type":"PLAYLIST","bounds":{"top":"0%","left":"0%","width":"100%","height":"100%"}}]}'),
('layout-corporate-news', 'Notícias & TV Corporativa', '16:9', 'Vídeo, barra lateral e notícias.', '{"name":"Notícias & TV Corporativa","aspect_ratio":"16:9","zones":[{"id":"zone_media","name":"Vídeo & Imagens","type":"PLAYLIST","bounds":{"top":"0%","left":"0%","width":"70%","height":"90%"}},{"id":"zone_sidebar","name":"Barra Lateral","type":"COMPOSITE","bounds":{"top":"0%","left":"70%","width":"30%","height":"90%"},"sub_widgets":[{"type":"CLOCK","height":"22%"},{"type":"WEATHER","height":"28%"},{"type":"ANNOUNCEMENTS","height":"50%"}]},{"id":"zone_ticker","name":"Rodapé de Notícias","type":"RSS_TICKER","bounds":{"top":"90%","left":"0%","width":"100%","height":"10%"}}]}'),
('layout-clinic-reception', 'Consultório & Chamada de Senhas', '16:9', 'Vídeos e chamada de senhas.', '{"name":"Consultório & Chamada de Senhas","aspect_ratio":"16:9","zones":[{"id":"zone_media","name":"Vídeos Institucionais","type":"PLAYLIST","bounds":{"top":"0%","left":"0%","width":"65%","height":"90%"}},{"id":"zone_sidebar","name":"Painel de Senhas","type":"COMPOSITE","bounds":{"top":"0%","left":"65%","width":"35%","height":"90%"},"sub_widgets":[{"type":"CLOCK","height":"18%"},{"type":"WEATHER","height":"22%"},{"type":"QUEUE_CALL","height":"60%"}]},{"id":"zone_footer","name":"Rodapé de Notícias","type":"RSS_TICKER","bounds":{"top":"90%","left":"0%","width":"100%","height":"10%"}}]}'),
('layout-elevator-vertical', 'Elevador / Totem Vertical (9:16)', '9:16', 'Layout vertical.', '{"name":"Elevador / Totem Vertical","aspect_ratio":"9:16","zones":[{"id":"zone_header","name":"Cabeçalho","type":"COMPOSITE","bounds":{"top":"0%","left":"0%","width":"100%","height":"18%"},"sub_widgets":[{"type":"CLOCK","width":"50%"},{"type":"WEATHER","width":"50%"}]},{"id":"zone_media","name":"Mídia Vertical","type":"PLAYLIST","bounds":{"top":"18%","left":"0%","width":"100%","height":"58%"}},{"id":"zone_announcements","name":"Comunicados","type":"ANNOUNCEMENTS","bounds":{"top":"76%","left":"0%","width":"100%","height":"16%"}},{"id":"zone_footer","name":"Rodapé de Notícias","type":"RSS_TICKER","bounds":{"top":"92%","left":"0%","width":"100%","height":"8%"}}]}'),
('layout-grid-quad', 'Grid 4 Zonas (2x2)', '16:9', 'Grid de quatro zonas.', '{"name":"Grid 4 Zonas","aspect_ratio":"16:9","zones":[{"id":"zone_q1","name":"Quadrante 1","type":"PLAYLIST","bounds":{"top":"0%","left":"0%","width":"50%","height":"50%"}},{"id":"zone_q2","name":"Quadrante 2","type":"COMPOSITE","bounds":{"top":"0%","left":"50%","width":"50%","height":"50%"}},{"id":"zone_q3","name":"Quadrante 3","type":"ANNOUNCEMENTS","bounds":{"top":"50%","left":"0%","width":"50%","height":"50%"}},{"id":"zone_q4","name":"Quadrante 4","type":"RSS_TICKER","bounds":{"top":"50%","left":"50%","width":"50%","height":"50%"}}]}');

INSERT OR IGNORE INTO playlists (id, name, description)
VALUES ('playlist-default', 'Playlist Padrão da Empresa', 'Campanhas institucionais e informes gerais.');

INSERT OR IGNORE INTO displays (id, name, code, layout_id, playlist_id, orientation, resolution, location, show_header, status) VALUES
('display-tv-01', 'TV Recepção Principal', 'TV-01', 'layout-corporate-news', 'playlist-default', 'landscape', '1920x1080', 'Recepção Térreo', 1, 'online'),
('display-tv-02', 'TV Sala de Espera / Consultório', 'TV-02', 'layout-clinic-reception', 'playlist-default', 'landscape', '1920x1080', 'Ambulatório 2º Andar', 1, 'online'),
('display-tv-03', 'Totem Vertical Elevador', 'TV-03', 'layout-elevator-vertical', 'playlist-default', 'portrait', '1080x1920', 'Hall dos Elevadores', 1, 'offline');

INSERT OR IGNORE INTO service_desks (id, name, category, is_active) VALUES
('desk-01', 'Guichê 01 - Recepção', 'Guichê', 1),
('desk-02', 'Guichê 02 - Atendimento Geral', 'Guichê', 1),
('desk-03', 'Guichê 03 - Prioritário', 'Guichê', 1),
('desk-04', 'Consultório 01 - Clínica Médica', 'Consultório', 1),
('desk-05', 'Consultório 02 - Pediatria', 'Consultório', 1),
('desk-06', 'Consultório 03 - Ortopedia', 'Consultório', 1);

INSERT OR IGNORE INTO service_types (id, name, prefix, is_priority, current_seq) VALUES
('srv-geral', 'Atendimento Geral (Recepção)', 'A', 0, 102),
('srv-prio', 'Atendimento Prioritário (Idoso/Gestante/PCD)', 'P', 1, 43),
('srv-cons', 'Consulta Médica', 'C', 0, 201),
('srv-exam', 'Exames & Laboratório', 'E', 0, 301),
('srv-tria', 'Triagem / Emergência', 'T', 1, 10);

INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
('site_title', 'tv013', 'Título da empresa'),
('company_subtitle', 'Comunicação Interna & Atendimento Integrado', 'Subtítulo da empresa'),
('company_logo', '', 'URL do logo'),
('show_company_header', 'true', 'Exibir cabeçalho'),
('theme_color', '#1e40af', 'Cor principal'),
('weather_city', 'São Paulo', 'Cidade do clima'),
('weather_latitude', '-23.5505', 'Latitude'),
('weather_longitude', '-46.6333', 'Longitude'),
('rss_feed_url', 'https://g1.globo.com/sp/santos-regiao/rss.xml,https://g1.globo.com/sp/sao-paulo/rss.xml,https://g1.globo.com/ciencia-e-saude/rss.xml,https://ge.globo.com/rss/ge/', 'Feeds RSS'),
('rss_scroll_speed', '40', 'Velocidade do ticker'),
('enable_tts', 'true', 'Habilitar síntese de voz'),
('default_slide_duration', '10', 'Duração padrão'),
('announcement_title', '📢 COMUNICADOS & AVISOS', 'Título dos comunicados'),
('announcement_text', 'Seja bem-vindo(a)! Fique atento aos comunicados internos e informes importantes.', 'Texto dos comunicados'),
('announcement_image', '', 'Imagem dos comunicados'),
('announcement_mode', 'both', 'Modo dos comunicados'),
('announcement_font_family', "'Roboto', sans-serif", 'Fonte dos comunicados'),
('announcement_font_size', '20', 'Tamanho da fonte'),
('announcement_stream_url', '', 'Stream dos comunicados'),
('announcement_stream_type', 'auto', 'Tipo do stream'),
('rss_font_family', "'Titillium Web', sans-serif", 'Fonte do RSS'),
('rss_font_size', '22', 'Tamanho do RSS');

INSERT OR IGNORE INTO studio_state (id, mode, headlines)
VALUES (1, 'playlist', '');
