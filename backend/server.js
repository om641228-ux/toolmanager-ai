require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSy_ваш_ключ_gemini';
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_DAILY_REQUESTS = 60; // Бесплатный лимит Gemini

// Кэш для хранения результатов по хешу изображения
const cache = new Map();
let dailyRequests = 0;
let lastResetDate = new Date().toDateString();

// Сброс счетчика в полночь
setInterval(() => {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyRequests = 0;
    lastResetDate = today;
    console.log('🔄 Сброшен дневной счетчик запросов к Gemini');
  }
}, 60000); // Проверяем каждую минуту

// Middleware для проверки размера запроса
app.use((req, res, next) => {
  if (req.method === 'POST' && req.headers['content-length']) {
    const contentLength = parseInt(req.headers['content-length']);
    if (contentLength > MAX_PAYLOAD_SIZE) {
      return res.status(413).json({
        error: 'Payload too large',
        message: 'Размер запроса превышает лимит 10 МБ'
      });
    }
  }
  next();
});

// Увеличиваем лимит для JSON и URL-encoded данных
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());

// Health check с информацией о кэше и запросах
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ToolManager AI Backend is running',
    model: 'Google Gemini 1.5 Pro Vision',
    hasApiKey: !!GEMINI_API_KEY,
    cacheSize: cache.size,
    dailyRequests: dailyRequests,
    maxDailyRequests: MAX_DAILY_REQUESTS,
    requestsRemaining: Math.max(0, MAX_DAILY_REQUESTS - dailyRequests)
  });
});

// Статистика использования
app.get('/stats', (req, res) => {
  res.json({
    totalRequests: dailyRequests,
    requestsRemaining: Math.max(0, MAX_DAILY_REQUESTS - dailyRequests),
    cacheHits: cache.size,
    cacheSize: cache.size,
    lastReset: lastResetDate
  });
});

// Анализ изображения через Google Gemini 1.5 Pro Vision
app.post('/api/analyze-tool', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Генерируем хеш изображения для кэширования
    const imageHash = generateImageHash(image);
    
    // Проверяем кэш
    if (cache.has(imageHash)) {
      console.log('📦 Возвращаем результат из кэша');
      return res.json(cache.get(imageHash));
    }

    // Проверяем лимит запросов
    if (dailyRequests >= MAX_DAILY_REQUESTS) {
      console.warn('⚠️ Достигнут дневной лимит запросов к Gemini');
      return res.status(429).json({ 
        error: `Достигнут дневной лимит запросов (${MAX_DAILY_REQUESTS}/день). Попробуйте завтра.`,
        fallback: getFallbackTool('Лимит запросов'),
        requestsRemaining: 0,
        resetTime: '00:00 UTC'
      });
    }

    console.log(`🔍 Анализ через Google Gemini 1.5 Pro Vision (запрос ${dailyRequests + 1}/${MAX_DAILY_REQUESTS})...`);
    
    // Извлекаем чистый base64 без префикса
    const base64Image = image.split(',')[1];
    if (!base64Image) {
      throw new Error('Invalid image format');
    }
    
    // Формируем запрос к Gemini API
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { 
                text: `Проанализируй это изображение инструмента. Ответь ТОЛЬКО в формате JSON без пояснений:

{
  "name": "точное название инструмента на русском (например: 'Плоскогубцы-секаторы с изоляцией')",
  "type": "ручной/электро/измерительный/режущий/ударный/зажимной",
  "confidence": 0.92,
  "details": {
    "features": [
      "Красные изолированные рукоятки (защита от электричества)",
      "Двойное назначение: зажим и резка проводов",
      "Металлические наконечники с зубцами для надежного захвата"
    ],
    "materials": ["Сталь (рабочая часть)", "Пластик (рукоятки)"],
    "usage": ["Работа с электричеством", "Резка проводов"],
    "precision": "высокая"
  }
}

ВАЖНО:
- Название должно быть точным и описательным
- Тип должен быть одним из: ручной/электро/измерительный/режущий/ударный/зажимной
- Уверенность: 0.7-0.95 (десятичное число)
- Особенности: 2-3 ключевые особенности через запятую
- Материалы: основные материалы через запятую
- Применение: 1-2 основных применения через запятую
- Точность: высокая/средняя/низкая
- НЕ ДОБАВЛЯЙ НИЧЕГО КРОМЕ ЧИСТОГО JSON`
              },
              { 
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: base64Image
                }
              }
            ]
          }],
          generationConfig: {
            maxOutputTokens: 800,
            temperature: 0.1,
            topP: 0.8,
            topK: 40
          }
        })
      }
    );

    // Увеличиваем счетчик запросов
    dailyRequests++;
    
    if (!geminiResponse.ok) {
      const errorData = await geminiResponse.json().catch(() => ({}));
      console.error('❌ Ошибка Gemini API:', errorData);
      
      if (geminiResponse.status === 400) {
        return res.status(400).json({ 
          error: 'Неверный формат изображения',
          fallback: getFallbackTool('Ошибка изображения')
        });
      }
      
      if (geminiResponse.status === 403 || geminiResponse.status === 429) {
        return res.status(429).json({ 
          error: 'Достигнут лимит запросов. Подождите до сброса (60 запросов/день).',
          fallback: getFallbackTool('Лимит запросов'),
          requestsRemaining: 0
        });
      }
      
      if (geminiResponse.status === 404) {
        return res.status(404).json({ 
          error: 'Модель не найдена. Проверьте версию API.',
          fallback: getFallbackTool('Ошибка модели')
        });
      }
      
      throw new Error(`Gemini API error ${geminiResponse.status}: ${JSON.stringify(errorData)}`);
    }

    const geminiData = await geminiResponse.json();
    console.log('📄 Ответ от Gemini получен');
    
    // Извлекаем текст из ответа
    if (!geminiData.candidates || !geminiData.candidates[0]?.content?.parts?.[0]?.text) {
      throw new Error('Некорректный формат ответа от Gemini');
    }
    
    const content = geminiData.candidates[0].content.parts[0].text;
    
    // Извлекаем чистый JSON из ответа
    const cleaned = content
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/```/g, '')
      .trim();
    
    // Парсим JSON
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (parseError) {
      console.warn('⚠️ JSON parse failed, using fallback parser');
      result = parseGeminiResponseFallback(cleaned);
    }
    
    // Валидация результата
    if (!result.name || !result.type) {
      throw new Error('Неполный результат от Gemini');
    }
    
    // Сохраняем в кэш
    cache.set(imageHash, result);
    console.log(`✅ Результат сохранен в кэш (всего в кэше: ${cache.size})`);
    
    // Добавляем информацию о кэшировании в ответ
    result.cacheInfo = {
      cached: false,
      requestsRemaining: Math.max(0, MAX_DAILY_REQUESTS - dailyRequests),
      dailyRequests: dailyRequests
    };
    
    console.log('✅ Распознавание завершено успешно');
    res.json(result);

  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    
    // Обработка ошибки 413
    if (error.message?.includes('413') || error.message?.includes('Payload too large')) {
      return res.status(413).json({ 
        error: 'Payload too large',
        message: 'Изображение слишком большое. Сожмите до 800 пикселей',
        fallback: getFallbackTool('Изображение слишком большое')
      });
    }
    
    // Обработка ошибки таймаута
    if (error.message?.includes('timeout')) {
      return res.status(504).json({ 
        error: 'Таймаут ожидания результата от Gemini',
        fallback: getFallbackTool('Таймаут ИИ')
      });
    }
    
    res.status(500).json({ 
      error: error.message || 'Ошибка сервера',
      fallback: getFallbackTool('Внутренняя ошибка'),
      requestsRemaining: Math.max(0, MAX_DAILY_REQUESTS - dailyRequests)
    });
  }
});

// Генерация хеша изображения для кэширования
function generateImageHash(imageUrl) {
  // Извлекаем чистый base64 без префикса
  const base64 = imageUrl.split(',')[1];
  
  // Создаем простой хеш из первых 150 символов
  return base64.substring(0, 150);
}

// Резервный парсер для ответов Gemini (если JSON не распарсился)
function parseGeminiResponseFallback(text) {
  const result = {
    name: 'Инструмент',
    type: 'ручной',
    confidence: 0.85,
    details: {
      features: ['Распознано через Gemini 1.5 Pro'],
      materials: ['Сталь', 'Пластик'],
      usage: ['Универсальное применение'],
      precision: 'Хорошая точность'
    }
  };
  
  // Извлекаем название
  const nameMatch = text.match(/"name"\s*:\s*"([^"]+)"/i) || 
                    text.match(/название[^\w]*[:=][^\w]*["']?([^"'\n]+)/i) ||
                    text.match(/(?:это|инструмент|предмет)\s+([^.,\n]+)/i);
  if (nameMatch) result.name = nameMatch[1].trim();
  
  // Извлекаем тип
  const typeMatch = text.match(/"type"\s*:\s*"([^"]+)"/i) || 
                    text.match(/тип[^\w]*[:=][^\w]*["']?([^"'\n]+)/i);
  if (typeMatch) {
    const typeLower = typeMatch[1].toLowerCase();
    if (/(электр|дрель|шуруповерт)/.test(typeLower)) result.type = 'электро';
    else if (/(рулетка|линейка|уровень)/.test(typeLower)) result.type = 'измерительный';
    else if (/(нож|ножницы|пила)/.test(typeLower)) result.type = 'режущий';
    else if (/(молоток|кувалда)/.test(typeLower)) result.type = 'ударный';
    else if (/(плоскогубцы|тиски)/.test(typeLower)) result.type = 'зажимной';
  }
  
  // Извлекаем уверенность
  const confMatch = text.match(/"confidence"\s*:\s*([0-9.]+)/i) || 
                    text.match(/уверенность[^\w]*[:=][^\w]*([0-9.]+)/i);
  if (confMatch) {
    result.confidence = Math.min(0.95, Math.max(0.7, parseFloat(confMatch[1]) || 0.85));
  }
  
  return result;
}

// Резервный инструмент
function getFallbackTool(reason) {
  return {
    name: `Инструмент (${reason})`,
    type: 'ручной',
    confidence: 0.65,
    details: {
      features: [reason],
      materials: ['Сталь', 'Пластик'],
      usage: ['Универсальное применение'],
      precision: 'Базовая точность'
    }
  };
}

// Запуск сервера
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                                                            ║');
  console.log('║  ✅ ToolManager AI Backend запущен!                       ║');
  console.log('║                                                            ║');
  console.log(`║  🌐 Порт: ${PORT}                                            ║`);
  console.log(`║  🔑 Gemini API Key: ${GEMINI_API_KEY ? '✓ Установлен' : '✗ ОТСУТСТВУЕТ'}  ║`);
  console.log(`║  🤖 Модель: Google Gemini 1.5 Pro Vision                  ║`);
  console.log('║                                                            ║');
  console.log('║  📡 API: /api/analyze-tool                                 ║');
  console.log('║  ❤️ Health: /health                                         ║');
  console.log('║  📊 Stats: /stats                                           ║');
  console.log('║                                                            ║');
  console.log('║  💡 Первый запрос: 5-10 сек | Последующие: 3-7 сек       ║');
  console.log(`║  ⚠️ Лимит: ${MAX_DAILY_REQUESTS} запросов/день (бесплатно)              ║`);
  console.log('║  💾 Кэширование: Включено (экономия запросов)             ║');
  console.log('║  ⚠️ Макс. размер изображения: 10 МБ                       ║');
  console.log('║                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  // Информация о текущем состоянии
  console.log(`📊 Текущее состояние:`);
  console.log(`   • Запросов сегодня: ${dailyRequests}/${MAX_DAILY_REQUESTS}`);
  console.log(`   • Запросов осталось: ${Math.max(0, MAX_DAILY_REQUESTS - dailyRequests)}`);
  console.log(`   • Размер кэша: ${cache.size} элементов`);
  console.log(`   • Следующий сброс: ${new Date().setHours(24, 0, 0, 0)}`);
});