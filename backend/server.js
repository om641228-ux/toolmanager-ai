const express = require('express');
const cors = require('cors');
const Replicate = require('replicate'); // ← Добавляем библиотеку

const app = express();
const PORT = process.env.PORT || 3000;

// Создаем экземпляр с токеном из переменной окружения
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'LLaVA backend running' });
});

app.post('/api/analyze-tool', async (req, res) => {
  try {
    console.log('🔍 Запрос к LLaVA...');
    
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    // Конвертируем base64 в изображение (можно сохранить во временный файл)
    const base64Image = image.split(',')[1];
    
    // Создаем временный файл или используем URL
    // Для простоты используем прямой вызов
    const input = {
      image: `data:image/jpeg;base64,${base64Image}`,
      prompt: "USER: <image>\nПроанализируй это изображение инструмента. Ответь в формате:\nназвание | тип | материалы | уверенность 0.9 | особенности | применение | точность.\nASSISTANT:"
    };
    
    console.log('🚀 Отправка запроса...');
    
    // Используем метод predict вместо stream для простоты
    const output = await replicate.run(
      "yorickvp/llava-13b:80537f9eead1a5bfa72d5ac6ea6414379be41d4d4f6679fd776e9535d1eb58bb",
      { input }
    );
    
    console.log('📄 Ответ:', output);
    
    // Парсим результат
    const parsed = parseResponse(output);
    res.json(parsed);
    
  } catch (error) {
    console.error('❌ Ошибка:', error);
    res.status(500).json({ 
      error: error.message,
      fallback: getFallbackTool('Ошибка обработки')
    });
  }
});

// Функции парсинга (как в предыдущем коде)
function parseResponse(output) {
  const text = Array.isArray(output) ? output.join('') : output;
  const parts = text.split('|').map(p => p.trim());
  
  return {
    name: parts[0] || 'Инструмент',
    type: 'ручной', // определите тип по тексту
    confidence: 0.85,
    details: {
      features: [parts[1] || 'Распознано через LLaVA'],
      materials: [parts[2] || 'Сталь, Пластик'],
      usage: [parts[3] || 'Универсальное применение'],
      precision: 'Хорошая точность'
    }
  };
}

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

app.listen(PORT, () => {
  console.log('\n✅ LLaVA Backend запущен!');
  console.log(`🌐 Порт: ${PORT}`);
  console.log(`🔑 Replicate: ${replicate.auth ? '✓' : '✗'}`);
});