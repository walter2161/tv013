import request from 'supertest';
import { app } from './setup.js';
import { clearRssCache } from '../src/services/rss.js';

describe('Widgets API (Weather & RSS)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearRssCache();
  });

  it('should return weather data for default or custom city', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      current: {
        temperature_2m: 22,
        relative_humidity_2m: 55,
        apparent_temperature: 23,
        weather_code: 1,
        wind_speed_10m: 8
      }
    }), { headers: { 'Content-Type': 'application/json' } }));

    const res = await request(app).get('/api/widgets/weather?city=São Paulo');

    expect(res.status).toBe(200);
    expect(res.body.city).toBe('São Paulo');
    expect(res.body.temperature).toBe(22);
    expect(res.body.condition).toBe('Parcialmente Nublado');
    expect(res.body.icon).toBe('⛅');
  });

  it('should return parsed RSS news items', async () => {
    const feed = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test feed</title>
          <link>https://example.com</link>
          <description>Test feed</description>
          <item>
            <title>Notícia de teste</title>
            <link>https://example.com/noticia</link>
          </item>
        </channel>
      </rss>`;
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(feed));

    const res = await request(app).get('/api/widgets/rss');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0].title).toBe('Notícia de teste');
  });
});
