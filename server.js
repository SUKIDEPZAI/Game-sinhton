const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();

/* ============================================================
   CORS — whitelist domain GitHub Pages của bạn
   ============================================================ */
const ALLOWED_ORIGINS = [
  'https://dragon.dragonhunter.gamer.free',
  // dev local
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:8080'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':')))
      return cb(null, true);
    console.log('CORS blocked:', origin);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json({ limit: '15mb' }));

app.get('/', (_, res) => res.send('2DCraft Backend OK'));
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

/* ============================================================
   PeerJS
   ============================================================ */
const PORT = process.env.PORT || 10000;
const server = app.listen(PORT, () => console.log('Listening on', PORT));

const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  proxied: true,
  allow_discovery: false,
  alive_timeout: 60000
});
app.use('/peerjs', peerServer);

peerServer.on('connection', c => console.log('Peer +', c.getId()));
peerServer.on('disconnect', c => console.log('Peer -', c.getId()));

/* ============================================================
   OpenAI Vision proxy — 4 focus mode
   ============================================================ */
const FOCUS_PROMPTS = {
  full: `Bạn là chuyên gia phân tích game 2D top-down pixel art. Phân tích frame + context, trả về có cấu trúc:

1. CẢNH QUAN: mô tả địa hình, biome, cấu trúc quan trọng (1-2 câu).
2. THỰC THỂ: liệt kê mob, người chơi khác, vật thể đáng chú ý.
3. ĐÁNH GIÁ: mức nguy hiểm (1-5), tài nguyên xung quanh, cơ hội/rủi ro.
4. KHUYẾN NGHỊ: 2-3 hành động cụ thể, có ưu tiên.
5. CẢNH BÁO: máu thấp, mob cận kề, thiếu sáng, v.v. (nếu có).

Trả lời tiếng Việt, tối đa 220 từ, không markdown phức tạp.`,

  combat: `Bạn là cố vấn chiến đấu cho game 2D top-down. Phân tích frame + context, tập trung:

1. TÌNH HÌNH: mob nào, số lượng, khoảng cách, hướng áp sát.
2. RỦI RO: mob nguy hiểm nhất, khả năng bị bao vây, máu hiện tại.
3. CHIẾN THUẬT: nên đánh / chạy / đặt block chắn, hướng rút lui.
4. VŨ KHÍ: đánh giá vũ khí đang cầm có phù hợp không.

Tiếng Việt, tối đa 180 từ, gạch đầu dòng rõ ràng.`,

  terrain: `Bạn là chuyên gia đọc địa hình game 2D top-down. Phân tích frame + context:

1. ĐỊA HÌNH: biome, độ cao, vật cản.
2. CẤU TRÚC: nhà, hang, cây, nước, đường đi.
3. ĐƯỜNG ĐI: hướng di chuyển thuận lợi, nơi có thể bị kẹt.
4. ĐIỂM ĐÁNG CHÚ Ý: nơi trú ẩn, vị trí chiến lược.

Tiếng Việt, tối đa 180 từ.`,

  resource: `Bạn là chuyên gia khai thác tài nguyên game 2D top-down. Phân tích frame + context:

1. TÀI NGUYÊN THẤY ĐƯỢC: quặng, gỗ, block quý, cây trồng.
2. VỊ TRÍ: ước lượng hướng + khoảng cách từ người chơi (theo tile).
3. DỤNG CỤ: có cần đổi cúp/kiếm không.
4. KẾ HOẠCH: thứ tự khai thác tối ưu, cảnh báo mob gần đó.

Tiếng Việt, tối đa 180 từ, danh sách ưu tiên.`
};

app.post('/api/analyze-frame', async (req, res) => {
  const KEY = process.env.OPENAI_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Server chưa cấu hình OPENAI_API_KEY' });

  const { image, context, focus } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Thiếu image' });
  if (typeof image !== 'string' || image.length > 4_000_000)
    return res.status(400).json({ error: 'Ảnh quá lớn' });

  const systemPrompt = FOCUS_PROMPTS[focus] || FOCUS_PROMPTS.full;

  try {
    const t0 = Date.now();
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + KEY
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: context || 'Phân tích frame.' },
            { type: 'image_url', image_url: { url: image, detail: 'low' } }
          ]}
        ],
        max_tokens: 500,
        temperature: 0.6
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error('OpenAI error', r.status, errText.slice(0, 300));
      return res.status(502).json({ error: `OpenAI ${r.status}: ${errText.slice(0,150)}` });
    }
    const data = await r.json();
    const result = data.choices?.[0]?.message?.content || '(Không có nội dung)';
    const usage = data.usage || {};
    res.json({
      result,
      meta: {
        model: 'gpt-4o-mini',
        ms: Date.now() - t0,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens
      }
    });
  } catch(e) {
    console.error('analyze error', e);
    res.status(500).json({ error: e.message });
  }
});

app.use((_, res) => res.status(404).json({ error: 'Not found' }));
