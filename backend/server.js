const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const app = express();
const PORT = 3000;

const DASHSCOPE_API_KEY = 'sk-6a17b9c2e73a4f8fa0a7191190863b42';

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

app.post('/api/analyze-tool', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }
    
    console.log('🔄 Отправка запроса к DashScope API...');
    
    const response = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-vl-plus',
        input: {
          messages: [{
            role: 'user',
            content: [
              { image: image.split(',')[1] },
              { 
                text: 'Проанализируй это изображение инструмента. Ответь строго в формате JSON: {"name":"...","type":"ручной/электро/измерительный/режущий/ударный/зажимной","confidence":0.x,"details":{"features":[],"materials":[],"usage":[],"precision":"..."}}'
              }
            ]
          }]
        }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('API Error:', data);
      return res.status(response.status).json({ 
        error: data.message || data.code || 'API error'
      });
    }

    const content = data.output.choices[0].message.content[0].text;
    const cleaned = content.replace(/```json\n?|\n?```/g, '').trim();
    
    res.json(JSON.parse(cleaned));
    
  } catch (error) {
    console.error('❌ Server error:', error);
    res.status(500).json({ 
      error: error.message || 'Internal server error',
      fallback: {
        name: "Инструмент (резервный режим)",
        type: "ручной",
        confidence: 0.85,
        details: {
          features: ["Распознано в резервном режиме"],
          materials: ["Сталь", "Пластик"],
          usage: ["Универсальное применение"],
          precision: "Средняя точность"
        }
      }
    });
  }
});

app.listen(PORT, () => {
  console.log('\n✅ ToolManager AI Backend запущен!');
  console.log(`🌐 Сервер: http://localhost:${PORT}`);
  console.log(`📡 API: http://localhost:${PORT}/api/analyze-tool`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health\n`);
});
