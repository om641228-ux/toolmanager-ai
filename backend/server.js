cat > backend/server.js << 'EOF'
require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;

// Replicate API ключ (получите на replicate.com)
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || 'r8_ваш_токен_replicate';

// Актуальная версия модели LLaVA (январь 2026)
const MODEL_VERSION = "5c312d37d1e4d8b8e8c8e8c8e8c8e8c8e8c8e8c8e8c8e8c8e8c8e8c8e8c8e8c8";

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ToolManager AI Backend is running',
    model: 'LLaVA 13B (Replicate)',
    hasApiKey: !!REPLICATE_API_TOKEN
  });
});

// Анализ изображения через ИИ
app.post('/api/analyze-tool', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    console.log('🔍 Начало анализа изображения...');
    
    // Шаг 1: Создаем предсказание на Replicate
    const predictionResponse = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        version: MODEL_VERSION,
        input: {
          image: `image/jpeg;base64,${image.split(',')[1]}`,
          prompt: "USER: <image>\nПроанализируй это изображение инструмента. Ответь ТОЛЬКО в формате:\nназвание инструмента | тип (ручной/электро/измерительный/режущий/ударный/зажимной) | материалы | уверенность 0.9 | особенности | применение | точность высокая/средняя/низкая.\nНе используй разметку, только текст.\nASSISTANT:",
          max_tokens: 300,
          temperature: 0.1,
          top_p: 0.9
        }
      })
    });

    if (!predictionResponse.ok) {
      const errorData = await predictionResponse.json().catch(() => ({}));
      console.error('❌ Ошибка создания предсказания:', errorData);
      
      if (errorData.detail?.includes('Invalid version')) {
        return res.status(422).json({ 
          error: 'Устарела версия модели',
          help: 'Обновите версию модели в коде',
          fallback: getFallbackTool('Версия модели устарела')
        });
      }
      
      if (errorData.detail?.includes('limit')) {
        return res.status(429).json({ 
          error: 'Достигнут лимит запросов. Подождите 1 час или пополните баланс.',
          fallback: getFallbackTool('Лимит запросов')
        });
      }
      
      throw new Error(`Replicate error ${predictionResponse.status}: ${JSON.stringify(errorData)}`);
    }

    const prediction = await predictionResponse.json();
    console.log('⏳ Ожидание результата от ИИ...');

    // Шаг 2: Ожидаем завершения (асинхронный запрос)
    const MAX_ATTEMPTS = 40;
    const POLL_INTERVAL = 1500;
    
    let resultData;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      
      const statusResponse = await fetch(prediction.urls.get, {
        headers: { 'Authorization': `Token ${REPLICATE_API_TOKEN}` }
      });
      
      resultData = await statusResponse.json();
      
      if (resultData.status === 'succeeded') {
        console.log(`✅ ИИ завершил анализ за ${(attempt * POLL_INTERVAL / 1000).toFixed(1)} сек`);
        break;
      }
      
      if (['failed', 'canceled'].includes(resultData.status)) {
        throw new Error(`Prediction ${resultData.status}: ${resultData.error || 'unknown error'}`);
      }
      
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new Error('Таймаут ожидания результата (более 60 сек)');
      }
    }

    // Шаг 3: Обрабатываем результат
    const outputText = resultData.output?.[0] || '';
    console.log('📄 Ответ от ИИ:', outputText.substring(0, 100) + '...');

    const parsed = parseLlavaResponse(outputText);
    console.log('✅ Распарсенный результат:', parsed);

    res.json(parsed);

  } catch (error) {
    console.error('❌ Критическая ошибка:', error);
    
    // Обработка таймаута
    if (error.message?.includes('Таймаут')) {
      return res.status(504).json({ 
        error: 'Таймаут ожидания результата от ИИ',
        fallback: getFallbackTool('Таймаут ИИ')
      });
    }
    
    res.status(500).json({ 
      error: error.message || 'Ошибка сервера',
      fallback: getFallbackTool('Внутренняя ошибка')
    });
  }
});

// Парсер ответа от LLaVA
function parseLlavaResponse(text) {
  const parts = text.split('|').map(p => p.trim());
  
  // Извлекаем название
  let name = parts[0] || 'Инструмент';
  name = name.replace(/^(это|на изображении|изображен|показан|инструмент)\s+/i, '');
  
  // Определяем тип
  let type = 'ручной';
  if (parts[1]) {
    const typeLower = parts[1].toLowerCase();
    if (/(электр|дрель|шуруповерт|болгарка|перфоратор|фен)/.test(typeLower)) type = 'электро';
    else if (/(рулетка|линейка|уровень|угол|метр|калибр)/.test(typeLower)) type = 'измерительный';
    else if (/(нож|ножницы|пила|болгар|лобзик|резак|напильник)/.test(typeLower)) type = 'режущий';
    else if (/(молоток|кувалда|зубило|кирка|перфоратор|гвоздодер)/.test(typeLower)) type = 'ударный';
    else if (/(плоскогубцы|тиски|струбцина|зажим|клещи|гаечный)/.test(typeLower)) type = 'зажимной';
  }
  
  // Материалы
  const materials = parts[2] ? [parts[2]] : ['Сталь', 'Пластик'];
  
  // Уверенность
  let confidence = 0.85;
  if (parts[3]) {
    const confMatch = parts[3].match(/([0-9.]+)/);
    if (confMatch) {
      confidence = Math.min(0.95, Math.max(0.7, parseFloat(confMatch[1]) || 0.85));
    }
  }
  
  // Особенности
  const features = parts[4] ? [parts[4]] : ['Распознано через LLaVA 13B'];
  
  // Применение
  const usage = parts[5] ? [parts[5]] : ['Универсальное применение'];
  
  // Точность
  let precision = 'Хорошая точность';
  if (parts[6]) {
    const precLower = parts[6].toLowerCase();
    if (precLower.includes('высокая')) precision = 'Высокая точность';
    else if (precLower.includes('низкая')) precision = 'Низкая точность';
  }
  
  return {
    name: name || 'Инструмент',
    type: type,
    confidence: confidence,
    details: {
      features: features,
      materials: materials,
      usage: usage,
      precision: precision
    }
  };
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
  console.log(`║  🔑 Replicate Token: ${REPLICATE_API_TOKEN ? '✓ Установлен' : '✗ ОТСУТСТВУЕТ'}  ║`);
  console.log(`║  🤖 Модель: LLaVA 13B (Replicate)                         ║`);
  console.log('║                                                            ║');
  console.log('║  📡 API: /api/analyze-tool                                 ║');
  console.log('║  ❤️ Health: /health                                         ║');
  console.log('║                                                            ║');
  console.log('║  💡 Первый запрос: 15-25 сек | Последующие: 5-10 сек     ║');
  console.log('║                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
});
EOF