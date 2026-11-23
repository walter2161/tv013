import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const env = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET || (env === 'production' ? '' : 'development-only-change-me');

if (!jwtSecret) {
  throw new Error('JWT_SECRET must be set when NODE_ENV=production.');
}

export const config = {
  port: parseInt(process.env.PORT || '5179', 10),
  env,
  jwtSecret,
  jwtExpiresIn: '7d',
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'tv_corporativa.db'),
  mediaPath: process.env.MEDIA_PATH || path.resolve(process.cwd(), 'media'),
  defaultCity: process.env.DEFAULT_CITY || 'São Paulo',
  defaultRssUrl: process.env.DEFAULT_RSS_URL || 'https://g1.globo.com/rss/g1/',
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
};
