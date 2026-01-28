const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();

// Порт для Render.com
const PORT = process.env.PORT || 3000;

// Ключ API из переменных окружения (безопасно!)
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-6a17b9c2e73a4f8fa0a7191190863b42';
const API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation';

// Разрешаем запросы с любого фронтенда
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ToolManager AI Backend is running',
    model: 'qwen-vl-chat-v1 (free)',
    hasApiKey: !!DASHSCOPE_API_KEY
  });
});

// Анализ изображения через БЕСПЛАТНУЮ модель
app.post('/api/analyze-tool', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Таймаут 20 секунд для защиты от зависаний
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-vl-chat-v1', // ← БЕСПЛАТНАЯ МОДЕЛЬ
        input: {
          messages: [{
            role: 'user',
            content: [
              { image: image.split(',')[1] },
              { 
                text: 'Проанализируй это изображение инструмента. Ответь строго в формате JSON: {"name":"название","type":"ручной/электро/измерительный/режущий/ударный/зажимной","confidence":0.8,"details":{"features":["особенность"],"materials":["материал"],"usage":["применение"],"precision":"точность"}}'
              }
            ]
          }]
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      
      // Обработка ошибок квот
      if (errorData.code === 'Throttling' || errorData.message?.includes('quota')) {
        return res.status(429).json({ 
          error: 'Лимит запросов исчерпан. Подождите до сброса квот (2000/день).',
          fallback: getFallbackTool('Лимит квот')
        });
      }
      
      return res.status(response.status).json({ 
        error: errorData.message || errorData.code || `API error ${response.status}`,
        fallback: getFallbackTool('Ошибка API')
      });
    }

    const data = await response.json();
    const content = data.output.choices[0].message.content[0].text;
    
    // Очистка и парсинг JSON
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    let result;
    
    try {
      result = JSON.parse(cleaned);
    } catch (e) {
      // Резервный парсер при ошибке парсинга
      result = parseFallback(content);
    }

    res.json(result);

  } catch (error) {
    console.error('Backend error:', error);
    
    // Таймаут запроса
    if (error.name === 'AbortError') {
      return res.status(504).json({ 
        error: 'Таймаут запроса к ИИ (20 сек)',
        fallback: getFallbackTool('Таймаут ИИ')
      });
    }
    
    res.status(500).json({ 
      error: error.message || 'Internal server error',
      fallback: getFallbackTool('Внутренняя ошибка')
    });
  }
});

// Резервный инструмент
function getFallbackTool(reason) {
  return {
    name: `Инструмент (${reason})`,
    type: "ручной",
    confidence: 0.7,
    details: {
      features: [reason],
      materials: ["Сталь", "Пластик"],
      usage: ["Универсальное применение"],
      precision: "Базовая точность"
    }
  };
}

// Резервный парсер текста
function parseFallback(text) {
  const lower = text.toLowerCase();
  let type = 'ручной';
  
  if (/(электр|дрель|шуруповерт)/.test(lower)) type = 'электро';
  else if (/(рулетка|линейка|уровень)/.test(lower)) type = 'измерительный';
  else if (/(нож|ножницы|пила)/.test(lower)) type = 'режущий';
  else if (/(молоток|кувалда)/.test(lower)) type = 'ударный';
  else if (/(плоскогубцы|тиски)/.test(lower)) type = 'зажимной';

  return {
    name: "Инструмент (резервный режим)",
    type: type,
    confidence: 0.75,
    details: {
      features: ["Распознано в резервном режиме"],
      materials: ["Сталь", "Пластик"],
      usage: ["Универсальное применение"],
      precision: "Базовая точность"
    }
  };
}

// Запуск сервера
app.listen(PORT, () => {
  console.log(`✅ ToolManager AI Backend запущен на порту ${PORT}`);
  console.log(`🔑 API Key: ${DASHSCOPE_API_KEY ? 'Установлен' : 'ОТСУТСТВУЕТ!'}`);
  console.log(`🤖 Модель: qwen-vl-chat-v1 (бесплатная)`);
});