require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELS = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-pro-preview'];

async function generateWithFallback(options) {
  let lastError;
  for (const model of MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        ...options
      });
      return response.text;
    } catch (err) {
      lastError = err;
      if (err.status === 503 || err.status === 404 || err.message?.includes('503') || err.message?.includes('404')) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw e;
  }
}

async function analyzeMealText(text) {
  const prompt = `
Sen tatlı, esprili, samimi ve motive edici bir çift diyetisyeni ve kalori takip asistanısın.
Kullanıcı bir WhatsApp grubunda yediği yemeği bildirdi:
"${text}"

Görevlerin:
1. Bu yemekteki yiyecekleri analiz et, porsiyonu ve tahmini toplam kalori (kcal), protein (g), karbonhidrat (g), yağ (g) değerlerini çıkar.
2. Kullanıcıya özel, motive edici, sevimli ve kısa 1-2 cümlelik Türkçe bir yorum (comment) yaz.

Yanıtını kesinlikle şu JSON formatında ver (başka hiçbir metin veya markdown ekleme):
{
  "food_name": "Kısa yemek adı (örn: Izgara Tavuk ve Bulgur Pilavı)",
  "calories": 450,
  "protein": 35,
  "carbs": 40,
  "fat": 12,
  "comment": "Motive edici tatlı yorum..."
}
`;

  const raw = await generateWithFallback({
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.3
    }
  });

  return parseJsonSafe(raw);
}

async function analyzeMealImage(imageBuffer, caption = '') {
  const base64Image = imageBuffer.toString('base64');
  const prompt = `
Sen tatlı, esprili, samimi ve motive edici bir çift diyetisyeni ve kalori takip asistanısın.
Kullanıcı tabağının/yemeğinin fotoğrafını gönderdi.
Varsa ek açıklaması: "${caption}"

Görevlerin:
1. Fotoğraftaki yiyecekleri tespit et.
2. Porsiyon büyüklüğünü tahmin ederek toplam kalori (kcal), protein (g), karbonhidrat (g) ve yağ (g) değerlerini hesapla.
3. Sevgililer grubuna uygun, tatlı, esprili ve motive edici 1-2 cümlelik Türkçe bir yorum yaz.

Yanıtını kesinlikle şu JSON formatında ver (başka hiçbir metin veya markdown ekleme):
{
  "food_name": "Fotoğraftan tanınan yemek adı",
  "calories": 520,
  "protein": 28,
  "carbs": 50,
  "fat": 18,
  "comment": "Tabağın çok renkli görünüyor! Protein dengesi harika... Afiyet bal şeker olsun! 🥑"
}
`;

  const raw = await generateWithFallback({
    contents: [
      { text: prompt },
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64Image
        }
      }
    ],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.3
    }
  });

  return parseJsonSafe(raw);
}

async function generateCoupleMotivation(summaryList) {
  const prompt = `
Sen bir çiftin (sevgili) kilo verme ve sağlık koçusun.
Günün sonu geldi ve ikisinin günlük kalori, su ve kilo verileri şöyle:
${JSON.stringify(summaryList, null, 2)}

Bu iki sevgili için WhatsApp grubuna atılacak çok tatlı, esprili, motive edici ve birbirlerine sarılmalarını sağlayacak 3-4 cümlelik Türkçe bir gün sonu değerlendirmesi yaz.
Kim hedefine daha yakınsa tatlı bir takılma yapabilirsin, ikisini de tebrik et.
Emoji bol olsun.

Yanıtını şu JSON formatında ver:
{
  "message": "Mesaj metni..."
}
`;

  const raw = await generateWithFallback({
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.7
    }
  });

  const parsed = parseJsonSafe(raw);
  return parsed.message;
}

async function generateBattleRoast(battleData) {
  const prompt = `
Sen bir çiftin hem boks spikeri gibi enerjik hem de çok sevimli bir aşk koçusun!
Bugün çiftimiz arasında kıyasıya bir diyet ve sağlık kapışması yaşandı.

Sonuçlar ve Puanlar:
${JSON.stringify(battleData, null, 2)}

Görevlerin:
1. Günü kazanan kişiyi coşkuyla ŞAMPİYON ilan et! Neden kazandığını (su, kalori veya tartı disiplini) belirt.
2. Kaybedene tatlı ve esprili bir dille takıl. Tatlı bir ceza belirle (örneğin: "Yarın kahvaltıyı sen hazırlıyorsun!", "10 dakika omuz masajı borçlandın!", "Bulaşıkları yıkama sırası sende!" vb.).
3. İkisinin birbirine sarılmasını sağlayacak sevgi dolu bir kapanış yap.
4. Emojileri bol ve enerjik kullan. 3-4 paragraf olsun.

Yanıtını kesinlikle şu JSON formatında ver:
{
  "commentary": "Spiker metni...",
  "punishment": "Kaybedenin tatlı cezası..."
}
`;

  try {
    const raw = await generateWithFallback({
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.8
      }
    });
    return parseJsonSafe(raw);
  } catch (err) {
    return {
      commentary: "Bugün ikiniz de efsane bir mücadele verdiniz! Şampiyonluk kıl payı belirlendi. Yarın kapışma kaldığı yerden devam edecek! 🏆🔥",
      punishment: "Kaybeden taraf bu akşam sevgi dolu bir kahve ısmarlamalı! ☕"
    };
  }
}

async function getDietTip() {
  const prompt = `
Birlikte forma girmeye çalışan sevgililer için 2 cümlelik pratik, bilimsel ve tatlı bir sağlıklı yaşam/diyet tavsiyesi ver. Bol emojili ve motive edici olsun.
Yanıtını şu JSON formatında ver:
{
  "tip": "Tavsiye metni..."
}
`;
  try {
    const raw = await generateWithFallback({
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0.7 }
    });
    return parseJsonSafe(raw).tip;
  } catch (e) {
    return "💡 Günün Tavsiyesi: Birlikte yemek yerken porsiyonlarınızı paylaşmayı değil, salatayı çoğaltmayı deneyin! Akşam yemeğinden sonra yapacağınız 20 dakikalık el ele yürüyüş sindirimi iki kat hızlandırır. 🚶‍♂️🚶‍♀️💚";
  }
}

module.exports = {
  analyzeMealText,
  analyzeMealImage,
  generateCoupleMotivation,
  generateBattleRoast,
  getDietTip
};
