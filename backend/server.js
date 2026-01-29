const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY || 'sk-6a17b9c2e73a4f8fa0a7191190863b42';
const API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation';

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'ToolManager AI Backend is running',
    model: 'qwen-vl-plus (мультимодальный анализ)',
    hasApiKey: !!DASHSCOPE_API_KEY
  });
});

// Анализ изображения через qwen-vl-plus
app.post('/api/analyze-tool', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Таймаут 25 секунд (модель может быть медленнее)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    // ЗАПРОС К МОДЕЛИ qwen-vl-plus
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-vl-plus', // ← ИСПОЛЬЗУЕМ МОДЕЛЬ ДЛЯ АНАЛИЗА ИЗОБРАЖЕНИЙ
        input: {
          messages: [{
            role: 'user',
            content: [
              { 
                image: image.split(',')[1] 
              },
              { 
                text: 'Проанализируй это изображение инструмента детально:\n' +
                      '1. Определи точное название инструмента (на русском)\n' +
                      '2. Классифицируй по типу: ручной/электро/измерительный/режущий/ударный/зажимной/строительный\n' +
                      '3. Определи материалы изготовления (сталь, пластик, дерево, резина и т.д.)\n' +
                      '4. Опиши основные особенности и конструктивные элементы\n' +
                      '5. Определи основное назначение и сферу применения\n' +
                      '6. Оцени точность распознавания (высокая/средняя/низкая)\n' +
                      '7. Укажи уровень уверенности (0.0-1.0)\n' +
                      '\n' +
                      'Ответь СТРОГО в формате JSON без пояснений:\n' +
                      '{\n' +
                      '  "name": "полное название инструмента",\n' +
                      '  "type": "тип инструмента",\n' +
                      '  "confidence": 0.85,\n' +
                      '  "details": {\n' +
                      '    "features": ["особенность 1", "особенность 2", "особенность 3"],\n' +
                      '    "materials": ["материал 1", "материал 2"],\n' +
                      '    "usage": ["применение 1", "применение 2"],\n' +
                      '    "precision": "высокая"\n' +
                      '  }\n' +
                      '}'
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
      
      // Обработка ошибок
      if (errorData.code === 'InvalidApiKey') {
        return res.status(401).json({ 
          error: 'Неверный или отсутствующий API ключ DashScope',
          fallback: getFallbackTool('Ошибка API ключа')
        });
      }
      
      if (errorData.code === 'Throttling' || errorData.message?.includes('quota')) {
        return res.status(429).json({ 
          error: 'Превышены квоты. Подождите до сброса (2000 запросов/день).',
          fallback: getFallbackTool('Лимит квот')
        });
      }
      
      if (errorData.code === 'ModelNotActivated') {
        return res.status(403).json({ 
          error: 'Модель qwen-vl-plus не активирована в консоли DashScope',
          help: 'Активируйте модель: Model Studio → Model List → qwen-vl-plus → Activate',
          fallback: getFallbackTool('Модель не активирована')
        });
      }
      
      if (errorData.code === 'InvalidParameter' || errorData.code === 'DataInspectionFailed') {
        return res.status(400).json({ 
          error: 'Неверный формат изображения. Загрузите другое фото.',
          fallback: getFallbackTool('Ошибка изображения')
        });
      }
      
      return res.status(response.status).json({ 
        error: errorData.message || errorData.code || `API error ${response.status}`,
        fallback: getFallbackTool('Ошибка API')
      });
    }

    const data = await response.json();
    console.log('📄 Ответ от qwen-vl-plus:', JSON.stringify(data, null, 2));
    
    const content = data.output.choices[0].message.content[0].text;
    console.log('🔍 Сырой текст:', content);
    
    // Парсинг ответа
    const result = parseQwenVLPlusResponse(content);
    console.log('✅ Распарсенный результат:', result);
    
    res.json(result);

  } catch (error) {
    console.error('❌ Ошибка в /api/analyze-tool:', error);
    
    if (error.name === 'AbortError') {
      return res.status(504).json({ 
        error: 'Таймаут запроса к ИИ (25 сек)',
        fallback: getFallbackTool('Таймаут ИИ')
      });
    }
    
    res.status(500).json({ 
      error: error.message || 'Внутренняя ошибка сервера',
      fallback: getFallbackTool('Внутренняя ошибка')
    });
  }
});

// Парсинг ответа от qwen-vl-plus
function parseQwenVLPlusResponse(text) {
  // Извлекаем чистый JSON из текста
  let cleaned = text
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .replace(/^[^{]*/g, '')
    .replace(/[^}]*$/g, '')
    .trim();
  
  try {
    const result = JSON.parse(cleaned);
    if (result.name && result.type) {
      // Нормализуем тип
      const typeMap = {
        'ручной': 'ручной',
        'электро': 'электро',
        'измерительный': 'измерительный',
        'режущий': 'режущий',
        'ударный': 'ударный',
        'зажимной': 'зажимной',
        'строительный': 'строительный'
      };
      
      const normalizedType = Object.keys(typeMap).find(key => 
        result.type.toLowerCase().includes(key)
      ) || 'ручной';
      
      // Валидация и нормализация данных
      const confidence = Math.min(0.95, Math.max(0.7, parseFloat(result.confidence) || 0.85));
      
      return {
        name: result.name.trim().replace(/^[^а-яА-ЯёЁ0-9]+|[^а-яА-ЯёЁ0-9]+$/g, ''),
        type: normalizedType,
        confidence: confidence,
        details: {
          features: Array.isArray(result.details?.features) && result.details.features.length > 0 
            ? result.details.features 
            : ["Распознано через qwen-vl-plus"],
          materials: Array.isArray(result.details?.materials) && result.details.materials.length > 0 
            ? result.details.materials 
            : ["Сталь", "Пластик"],
          usage: Array.isArray(result.details?.usage) && result.details.usage.length > 0 
            ? result.details.usage 
            : ["Универсальное применение"],
          precision: result.details?.precision || "Средняя точность"
        }
      };
    }
  } catch (e) {
    console.warn('⚠️ JSON парсинг не удался:', e.message);
  }
  
  // Резервный парсер
  return fallbackParser(text);
}

// Резервный парсер по ключевым словам
function fallbackParser(text) {
  const lower = text.toLowerCase();
  
  // Определяем тип по ключевым словам
  let type = 'ручной';
  if (/(электр|дрель|шуруповерт|болгарка|перфоратор|лобзик|фрезер|шлифовальн)/.test(lower)) type = 'электро';
  else if (/(рулетка|линейка|уровень|угол|метр|калибр|штангенциркуль|угольник)/.test(lower)) type = 'измерительный';
  else if (/(нож|ножницы|пила|болгар|лобзик|резак|напильник|стеклорез|секатор)/.test(lower)) type = 'режущий';
  else if (/(молоток|кувалда|зубило|кирка|перфоратор|гвоздодер|кирочка)/.test(lower)) type = 'ударный';
  else if (/(плоскогубцы|тиски|струбцина|зажим|клещи|гаечный|хомут)/.test(lower)) type = 'зажимной';
  else if (/(строитель|бетон|кирпич|штукатур|маляр|плитка)/.test(lower)) type = 'строительный';
  
  // Извлекаем название
  let name = 'Инструмент';
  
  // Попытка извлечь название из структуры ответа
  const nameMatch = text.match(/"name"\s*:\s*"([^"]{3,80})"/i) || 
                    text.match(/названи[ея]\s*[:=]\s*["']?([^"'\n]{3,80})/i) ||
                    text.match(/(?:это|инструмент|предмет)\s+(.{3,50})\b/i);
  
  if (nameMatch) {
    name = nameMatch[1].trim();
    // Убираем лишние символы и префиксы
    name = name.replace(/^(это|на изображении|изображен|показан|инструмент)\s+/i, '');
    name = name.replace(/^[^а-яА-ЯёЁ0-9]+|[^а-яА-ЯёЁ0-9]+$/g, '');
  }
  
  // Извлекаем материалы
  const materials = [];
  if (/(сталь|металл|железо|алюминий|титан)/.test(lower)) materials.push('Сталь');
  if (/(пластик|полимер|нейлон|полиэтилен|поликарбонат)/.test(lower)) materials.push('Пластик');
  if (/(дерево|древесина|дсп|фанера)/.test(lower)) materials.push('Дерево');
  if (/(резина|силикон|эластомер|каучук)/.test(lower)) materials.push('Резина');
  if (materials.length === 0) materials.push('Сталь', 'Пластик');
  
  // Извлекаем назначение
  const usage = [];
  if (type === 'электро') usage.push('Электромонтажные работы', 'Сверление', 'Шлифовка');
  else if (type === 'ударный') usage.push('Демонтаж', 'Забивание гвоздей', 'Разрушение');
  else if (type === 'режущий') usage.push('Резка материалов', 'Распиловка', 'Обрезка');
  else if (type === 'измерительный') usage.push('Измерение размеров', 'Разметка', 'Контроль');
  else if (type === 'зажимной') usage.push('Фиксация деталей', 'Зажим', 'Удержание');
  else if (type === 'строительный') usage.push('Строительные работы', 'Монтаж', 'Сборка');
  else usage.push('Универсальное применение');
  
  // Определяем точность
  let precision = "Средняя точность";
  if (/(высокая|точно|детально|полностью)/.test(lower)) precision = "Высокая точность";
  else if (/(низкая|примерно|частично|приблизительно)/.test(lower)) precision = "Низкая точность";
  
  // Уверенность
  let confidence = 0.75;
  const confMatch = text.match(/уверенность|уверенно|точность|точно.*?([0-9.]+)/i);
  if (confMatch) {
    confidence = Math.min(0.95, Math.max(0.7, parseFloat(confMatch[1]) || 0.75));
  }
  
  return {
    name: name,
    type: type,
    confidence: confidence,
    details: {
      features: ["Распознано через резервный парсер"],
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
    type: "ручной",
    confidence: 0.65,
    details: {
      features: [reason],
      materials: ["Сталь", "Пластик"],
      usage: ["Универсальное применение"],
      precision: "Базовая точность"
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
  console.log(`║  🔑 API Key: ${DASHSCOPE_API_KEY ? '✓ Установлен' : '✗ ОТСУТСТВУЕТ'}     ║`);
  console.log(`║  🤖 Модель: qwen-vl-plus (мультимодальный анализ)         ║`);
  console.log('║                                                            ║');
  console.log('║  📡 API: /api/analyze-tool                                 ║');
  console.log('║  ❤️ Health: /health                                         ║');
  console.log('║                                                            ║');
  console.log('║  💡 Первый запрос: 3-8 сек | Последующие: 2-5 сек         ║');
  console.log('║  ⚠️ Таймаут: 25 сек                                        ║');
  console.log('║                                                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
});