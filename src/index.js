require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCodeImg = require('qrcode');
const http = require('http');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const gemini = require('./gemini');
const { setupReminders } = require('./reminders');

const authDir = path.join(__dirname, '..', 'auth_info_baileys');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

let remindersInitialized = false;
let latestQR = null;
let isConnected = false;

const groupCache = new Map();

function cleanJid(jid) {
  if (!jid) return null;
  return jid.replace(/:.*@/, '@');
}

function normalizeText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}

function unwrapMessage(m) {
  if (!m || !m.message) return { message: null, type: null, text: '' };
  let msg = m.message;
  if (msg.ephemeralMessage) msg = msg.ephemeralMessage.message;
  if (msg.viewOnceMessage) msg = msg.viewOnceMessage.message;
  if (msg.viewOnceMessageV2) msg = msg.viewOnceMessageV2.message;
  if (msg.documentWithCaptionMessage) msg = msg.documentWithCaptionMessage.message;

  const type = Object.keys(msg)[0];
  let text = '';
  if (type === 'conversation') text = msg.conversation;
  else if (type === 'extendedTextMessage') text = msg.extendedTextMessage?.text;
  else if (type === 'imageMessage') text = msg.imageMessage?.caption;
  else if (type === 'videoMessage') text = msg.videoMessage?.caption;

  return { message: msg, type, text: (text || '').trim() };
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  const phoneNumber = process.env.BOT_PHONE_NUMBER?.replace(/[^0-9]/g, '');
  const usePairingCode = process.env.USE_PAIRING_CODE === 'true';

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: !usePairingCode,
    auth: state,
    browser: Browsers.macOS('Desktop'),
    syncFullHistory: false
  });

  // Telefon numarasıyla eşleştirme kodu (Pairing Code)
  if (usePairingCode && !sock.authState.creds.registered && phoneNumber) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('\n======================================================');
        console.log(`👉 WHATSAPP EŞLEŞTİRME KODUNUZ:  ${code}`);
        console.log('======================================================');
        console.log('1. Telefonunuzda WhatsApp uygulamasını açın.');
        console.log('2. Ayarlar -> Bağlı Cihazlar -> Cihaz Bağla seçeneğine dokunun.');
        console.log('3. "Telefon Numarasıyla Bağla" seçeneğine tıklayın ve bu kodu girin!\n');
      } catch (err) {
        console.error('Pairing code alınırken hata oluştu:', err);
      }
    }, 4000);
  }

  // Kimlik ve bağlantı durumu güncellemesi
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      if (!usePairingCode) {
        console.log('\n📱 Lütfen aşağıdaki QR kodu WhatsApp ile taratın:');
        qrcode.generate(qr, { small: true });
        const qrPath = path.join(__dirname, '..', 'qr.png');
        QRCodeImg.toFile(qrPath, qr, { width: 350 }).catch(() => {});
        console.log('🖼️ Ayrıca QR kod "qr.png" olarak kaydedildi! İsterseniz klasördeki resmi açıp da taratabilirsiniz.\n');
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(`Bağlantı kapandı (Kod: ${statusCode || 'bilinmiyor'}).`);

      if (isLoggedOut) {
        console.log('Oturum kapatıldı. Yeniden bağlanmak için auth klasörü temizleniyor...');
        try {
          fs.rmSync(authDir, { recursive: true, force: true });
        } catch (_) {}
      }

      console.log('Otomatik yeniden bağlanılıyor (2 sn)...');
      setTimeout(startBot, 2000);
    } else if (connection === 'open') {
      isConnected = true;
      latestQR = null;
      console.log('\n✅ WhatsApp Bağlantısı Başarıyla Kuruldu!');
      console.log('Bot aktif ve mesajları dinliyor... 🚀\n');

      if (!remindersInitialized) {
        setupReminders(sock);
        remindersInitialized = true;
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Gelen mesajları dinleme
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const m of messages) {
      const { message, type: messageType, text } = unwrapMessage(m);
      if (!message) continue;

      const remoteJid = m.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');

      // Doğru ve temiz JID tespiti
      let rawSender = m.key.participant;
      if (m.key.fromMe || !rawSender) {
        rawSender = sock.user?.lid || sock.user?.id || m.key.participant;
      }
      const senderJid = cleanJid(rawSender);
      const senderName = m.pushName || (m.key.fromMe ? (sock.user?.name || 'Oğuzhan') : 'Arkadaş');

      // Botun kendi attığı otomatik yanıt mesajlarına tekrar cevap vermesini engelle
      if (m.key.fromMe) {
        const isBotResponse =
          text.includes('KALORİ & KİLO TAKİP BOTU') ||
          text.includes('GÜNCEL DURUM RAPORU') ||
          text.includes('Kilonuz Kaydedildi') ||
          text.includes('Öğün:') ||
          text.includes('Su Kaydedildi') ||
          text.includes('Koçunuz') ||
          text.includes('inceleniyor ve kalori');
        if (isBotResponse) continue;
      }

      // SADECE "Hayatımı Düzene Sokuyorum" GRUBU FİLTRESİ
      // 1. Özel sohbetleri tamamen yok say:
      if (!isGroup) {
        continue;
      }

      // 2. Grup adını kontrol et:
      let groupSubject = groupCache.get(remoteJid);
      if (!groupSubject) {
        try {
          const meta = await sock.groupMetadata(remoteJid);
          groupSubject = meta.subject;
          groupCache.set(remoteJid, groupSubject);
        } catch (e) {
          // Metadata çekilemediyse kayıtlı jid ile eşleşiyor mu kontrol et
          const savedJid = db.getSetting('active_group_jid');
          if (savedJid === remoteJid) {
            groupSubject = 'Hayatımı Düzene Sokuyorum';
          }
        }
      }

      const normalizedSubject = normalizeText(groupSubject);
      const isTargetGroup = normalizedSubject.includes('hayatimi duzene sokuyorum');

      if (!isTargetGroup) {
        // Hedef grup dışındaki diğer tüm grupları tamamen yok say
        continue;
      }

      console.log(`📩 [${groupSubject}] ${senderName}: ${text || `[${messageType}]`}`);

      // Hedef grubu hatırla
      db.setSetting('active_group_jid', remoteJid);

      // Kullanıcıyı veritabanında güvenceye al
      db.ensureUser(senderJid, senderName);

      try {
        const cleanCmd = normalizeText(text.replace(/^[!\/]/, ''));

        // 1. KOMUTLAR: yardım / !yardım / komutlar / help
        if (cleanCmd === 'yardim' || cleanCmd === 'komutlar' || cleanCmd === 'komut' || cleanCmd === 'help') {
          const helpMsg = `🤖 *HAYATIMI DÜZENE SOKUYORUM BOTU* 📋\n───────────────────────────\n` +
            `🥗 *Yemek & Kalori Takibi:*\n` +
            `  • *Fotoğraf göndererek:* Tabağın fotoğrafını çekip atın (Gemini otomatik kalori/makro çıkarır).\n` +
            `  • *Yazarak:* \`yedim: 1 porsiyon menemen, 2 dilim ekmek\` veya \`kahvaltı: ...\` / \`öğle: ...\` / \`akşam: ...\`\n\n` +
            `⚖️ *Kilo & Tartı:*\n` +
            `  • \`kilo 68.5\` veya \`tartı 68.5\` (Önceki tartıya göre farkı ve motivasyonu söyler)\n\n` +
            `💧 *Su Takibi:*\n` +
            `  • \`su\` veya \`+1 su\` (1 bardak / 250ml ekler)\n` +
            `  • \`+2 su\` (2 bardak ekler)\n\n` +
            `🥊 *Canlı Kapışma & Düello:*\n` +
            `  • \`kapışma\` veya \`vs\` (Bugün kim kaç puanda, kim önde canlı görün!)\n` +
            `  • \`skor\` veya \`aylık\` (Aylık kupa tablosu ve galibiyet sayıları)\n\n` +
            `📊 *Genel Rapor & Tavsiye:*\n` +
            `  • \`durum\` veya \`özet\` (Bugünkü toplam kalori, su ve makro raporu)\n` +
            `  • \`tavsiye\` (Gemini'den günün aşk & sağlıklı yaşam tüyosu)\n` +
            `  • \`!kacamak baklava\` (Kaçamak itirafı ve tatlı ceza çarkı! 🍩)\n` +
            `  • \`!hedef kalori 1600 [isim]\` veya \`!hedef kilo 60 [isim]\`\n\n` +
            `🗑️ *Hata Düzeltme & Silme:*\n` +
            `  • \`!günüsil\` (Kendi bugünkü tüm yemek/su kayıtlarını sıfırlar)\n` +
            `  • \`!günüsil Oğuzhan\` (İsmi belirtilen kişinin bugünkü verilerini sıfırlar)\n` +
            `  • \`!sonsil\` (Sadece son girilen yanlış öğünü siler)\n` +
            `───────────────────────────\n` +
            `⏰ *Otomatik Hatırlatıcılar:*\n` +
            `08:30 Sabah Tartı & Kahvaltı | 12:30 Öğle | 15:30 İkindi Su | 19:15 Akşam | 21:15 Son Su | 22:30 BÜYÜK GÜN SONU KAPIŞMASI! 🏆`;
          await sock.sendMessage(remoteJid, { text: helpMsg }, { quoted: m });
          continue;
        }

        // CANLI KAPIŞMA: kapışma / kapisma / vs / duello
        if (cleanCmd === 'kapisma' || cleanCmd === 'vs' || cleanCmd === 'duello') {
          const battle = db.calculateBattleScore();
          if (!battle || battle.results.length === 0) {
            await sock.sendMessage(remoteJid, { text: 'Henüz bugün için bir veri girilmedi. İlk puanı kapmak için su için veya öğün girin! 🏃‍♂️' }, { quoted: m });
            continue;
          }

          let battleMsg = `🥊 *CANLI GÜNLÜK KAPIŞMA DURUMU* 🥊\n───────────────────────────\n`;
          battle.results.forEach((item, idx) => {
            const medal = idx === 0 ? '👑 LİDER' : '🥈 TAKİPTE';
            const name = item.user.name || item.user.jid.split('@')[0];
            const target = item.user.target_calories || 1800;

            battleMsg += `${medal}: *${name}* ➔ *${item.totalScore} Puan*\n`;
            battleMsg += `  • Kalori: ${item.totalCalories} / ${target} kcal\n`;
            battleMsg += `  • Su: ${item.waterGlasses} bardak (${item.waterMl} ml)\n`;
            if (item.breakdown.length > 0) {
              battleMsg += `  • Puanlar: ${item.breakdown.join(' | ')}\n`;
            }
            battleMsg += `\n`;
          });

          if (battle.isTie) {
            battleMsg += `⚖️ *Şu an durum berabere!* Akşam 22:30'a kadar her su ve temiz öğün kazananı değiştirebilir! 🔥`;
          } else if (battle.winner) {
            const leaderName = battle.winner.user.name || battle.winner.user.jid.split('@')[0];
            const diff = battle.winner.totalScore - (battle.runnerUp?.totalScore || 0);
            battleMsg += `🔥 *${leaderName}* şu an *+${diff} puan* farkla önde gidiyor! Büyük final saat 22:30'da! 🏆`;
          }

          await sock.sendMessage(remoteJid, { text: battleMsg }, { quoted: m });
          continue;
        }

        // AYLIK SKOR TABLOSU: skor / aylık / liderlik
        if (cleanCmd === 'skor' || cleanCmd === 'aylik' || cleanCmd === 'liderlik' || cleanCmd === 'tablo') {
          const data = db.getMonthlyLeaderboard();
          let scoreMsg = `🏆 *AYLIK ŞAMPİYONLUK LİGİ (${data.monthStr})* 🌟\n───────────────────────────\n`;

          data.leaderboard.forEach((item, idx) => {
            const icon = idx === 0 ? '🥇' : '🥈';
            const name = item.user.name || item.user.jid.split('@')[0];
            const weightChange = item.weightDiff !== null
              ? (parseFloat(item.weightDiff) < 0 ? `📉 ${Math.abs(item.weightDiff)} kg verildi!` : `📈 +${item.weightDiff} kg`)
              : 'Veri yok';

            scoreMsg += `${icon} *${name}*\n`;
            scoreMsg += `   🏆 Galibiyet: *${item.wins} Gün Kazandı*\n`;
            scoreMsg += `   💧 Toplam Su: *${item.totalWaterLiters} Litre*\n`;
            scoreMsg += `   🔥 Günlük Ort. Kalori: *${item.avgCalories} kcal*\n`;
            scoreMsg += `   ⚖️ Ay İçi Kilo Değişimi: *${weightChange}*\n\n`;
          });

          scoreMsg += `───────────────────────────\nAy sonu şampiyonuna büyük bir ödül borçlusunuz! Mücadeleye devam! 💖✨`;
          await sock.sendMessage(remoteJid, { text: scoreMsg }, { quoted: m });
          continue;
        }

        // GÜNÜN TAVSİYESİ: tavsiye
        if (cleanCmd === 'tavsiye' || cleanCmd === 'ipucu') {
          await sock.sendMessage(remoteJid, { text: '💡 Sağlık ve aşk tavsiyesi hazırlanıyor...' }, { quoted: m });
          const tip = await gemini.getDietTip();
          await sock.sendMessage(remoteJid, { text: tip }, { quoted: m });
          continue;
        }

        // KAÇAMAK İTİRAFI: !kacamak [yiyecek]
        const cheatMatch = text.match(/^(?:!|\/)?kacamak\s*(.*)/i);
        if (cheatMatch) {
          const item = cheatMatch[1] || 'tatlı bir şeyler';
          const punishments = [
            'Sevgiline 15 dakika sırt/omuz masajı yapma cezası! 💆',
            'Yarın sabah erken kalkıp mükemmel ve fit bir kahvaltı hazırlama cezası! 🍳',
            'Günün bulaşıklarını tek başına yıkama cezası! 🍽️',
            'Hemen şimdi 30 jumping jack veya 20 squat yapma cezası! 🏋️',
            'Sevgilini öpüp 3 tane en sevdiğin huyunu söyleme tatlı cezası! 🥰'
          ];
          const randomPunishment = punishments[Math.floor(Math.random() * punishments.length)];
          const reply = `🚨 *KAÇAMAK ALARMI VERİLDİ!* 🚨\n\n@${senderName} *"${item}"* kaçamağı yaptı!\n\n😈 *Ceza Çarkı Döndü:* \n👉 ${randomPunishment}\n\nAfiyet olsun ama cezanı ödemeyi unutma! 😂`;
          await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          continue;
        }

        // DURUM / ÖZET RAPORU: durum / özet / rapor
        if (cleanCmd === 'durum' || cleanCmd === 'ozet' || cleanCmd === 'rapor') {
          const summary = db.getDailySummary();
          let summaryText = `📊 *GÜNCEL DURUM RAPORU* 🌟\n───────────────────\n`;
          summary.forEach(item => {
            const name = item.user.name || item.user.jid.split('@')[0];
            const calTarget = item.user.target_calories || 1800;
            const remaining = calTarget - item.totalCalories;
            const weightText = item.currentWeight ? `${item.currentWeight} kg` : 'Girilmedi';

            summaryText += `👤 *${name}*\n`;
            summaryText += `  • Alınan: *${item.totalCalories}* / ${calTarget} kcal (${remaining > 0 ? remaining + ' kcal kaldı' : Math.abs(remaining) + ' kcal aşıldı!'})\n`;
            summaryText += `  • Makrolar: ${item.totalProtein}g Protein | ${item.totalCarbs}g Karb | ${item.totalFat}g Yağ\n`;
            summaryText += `  • Su: *${item.waterGlasses} bardak* (${item.waterMl} ml)\n`;
            summaryText += `  • Kilo: *${weightText}*\n\n`;
          });
          summaryText += `Harika gidiyorsunuz, pes etmek yok! 💪🔥`;
          await sock.sendMessage(remoteJid, { text: summaryText }, { quoted: m });
          continue;
        }

        // TÜMÜNÜ SIFIRLA: !tumunusil / !sifirla
        if (cleanCmd === 'tumunusil' || cleanCmd === 'sifirla') {
          db.wipeAllData();
          await sock.sendMessage(remoteJid, { text: '🧹 *Tüm Veritabanı Sıfırlandı!*\n\nTüm kullanıcılar, yemekler, kilolar ve lig geçmişi silindi. Artık sadece bu grupta mesaj atanlar sıfırdan kaydedilecek! 🚀' }, { quoted: m });
          continue;
        }

        // GÜNÜ SİL (Hatalı girişleri sıfırlama): !günüsil [isim] / günüsil [isim]
        const resetMatch = text.match(/^(?:!|\/)?g[uü]n[uü]sil\s*(.*)/i);
        if (resetMatch) {
          const targetName = resetMatch[1]?.trim();
          let targetUser = null;
          if (targetName) {
            targetUser = db.findUserByName(targetName);
            if (!targetUser) {
              await sock.sendMessage(remoteJid, { text: `⚠️ "${targetName}" adında bir kullanıcı bulunamadı.` }, { quoted: m });
              continue;
            }
          } else {
            targetUser = db.ensureUser(senderJid, senderName);
          }

          const delRes = db.resetDayForUser(targetUser.jid);
          const reply = `🗑️ *Bugünün Verileri Sıfırlandı!*\n\n` +
            `👤 *Kişi:* ${targetUser.name}\n` +
            `• Silinen Öğün: ${delRes.mealsDeleted} adet\n` +
            `• Silinen Su Kaydı: ${delRes.waterDeleted} adet\n` +
            `• Silinen Kilo Kaydı: ${delRes.weightDeleted} adet\n\n` +
            `Bugün için tertemiz bir sayfa açıldı! ✨`;
          await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          continue;
        }

        // SON ÖĞÜNÜ SİL: !sonsil / sonsil
        if (cleanCmd === 'sonsil' || cleanCmd === 'sonogunsil') {
          const user = db.ensureUser(senderJid, senderName);
          const deleted = db.deleteLastMeal(user.jid);
          if (deleted) {
            await sock.sendMessage(remoteJid, { text: `🗑️ ${user.name} için son girilen öğün silindi: *${deleted.food_name}* (${deleted.calories} kcal).` }, { quoted: m });
          } else {
            await sock.sendMessage(remoteJid, { text: `Silinecek bir öğün bulunamadı.` }, { quoted: m });
          }
          continue;
        }

        // 3. KOMUT: Hedef Ayarlama (!hedef kalori 1800 [isim] / hedef kilo 65)
        const targetMatch = text.match(/^(?:!|\/)?hedef\s+(kalori|kilo)\s+([0-9]+(?:[\.,][0-9]+)?)(?:\s+(.*))?/i);
        if (targetMatch) {
          const type = targetMatch[1].toLowerCase();
          const val = targetMatch[2].replace(',', '.');
          const specifiedName = targetMatch[3]?.trim();

          let targetUser = null;
          if (specifiedName) {
            targetUser = db.findUserByName(specifiedName);
          }
          if (!targetUser) {
            targetUser = db.ensureUser(senderJid, senderName);
          }

          db.setUserTarget(targetUser.jid, type, val);
          const reply = `🎯 *Hedef Güncellendi!*\n\n${targetUser.name} için yeni ${type} hedefi: *${val}* olarak ayarlandı.`;
          await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          continue;
        }

        // 4. KİLO GİRİŞİ: "kilo 68.5", "!kilo 68.5", "tartı 68.5"
        const weightMatch = text.match(/^(?:!|\/)?(?:kilo|tarti|tartı)[\s:]*([0-9]+(?:[\.,][0-9]+)?)/i);
        if (weightMatch) {
          const user = db.ensureUser(senderJid, senderName);
          const weight = parseFloat(weightMatch[1].replace(',', '.'));
          const result = db.logWeight(user.jid, weight);

          let diffMsg = '';
          if (result.diff !== null) {
            const diffNum = parseFloat(result.diff);
            if (diffNum < 0) {
              diffMsg = `\n📉 Önceki tartıya (${result.prevWeight} kg) göre: *${Math.abs(diffNum)} kg verdin!* 🎉 Süpersin!`;
            } else if (diffNum > 0) {
              diffMsg = `\n📈 Önceki tartıya (${result.prevWeight} kg) göre: *+${diffNum} kg*. Moral bozmak yok, ödem olabilir, su içmeye devam! 💧`;
            } else {
              diffMsg = `\n⚖️ Önceki tartı ile aynı kilodasın. Sabırla devam! 👊`;
            }
          }

          const reply = `⚖️ *Kilonuz Kaydedildi!*\n\n👤 *Kişi:* ${user.name}\nBugünkü kilonuz: *${weight} kg*${diffMsg}`;
          await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          continue;
        }

        // 5. SU GİRİŞİ: "+1 su", "su", "+2 su", "!su", "su 2"
        const waterMatch = text.match(/^\+?([1-9])?\s*su\b/i) || text.match(/^su\s*\+?([1-9])?\b/i) || text.match(/^!su/i);
        if (waterMatch) {
          const user = db.ensureUser(senderJid, senderName);
          const count = parseInt(waterMatch[1] || '1');
          const totalGlasses = db.logWater(user.jid, count);
          const totalMl = totalGlasses * 250;

          const reply = `💧 *Su Kaydedildi!*\n\n+${count} bardak su eklendi. ${user.name} bugün toplam: *${totalGlasses} bardak* (${totalMl} ml) su içti! 🥤`;
          await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          continue;
        }

        // 6. FOTOĞRAF İLE YEMEK ANALİZİ (Otomatik algılama)
        if (messageType === 'imageMessage' || message.imageMessage) {
          const user = db.ensureUser(senderJid, senderName);
          console.log(`📸 Yemek fotoğrafı algılandı, analiz ediliyor... (${user.name})`);
          await sock.sendMessage(remoteJid, { text: `🔍 Fotoğraf inceleniyor, ${user.name} için besin değerleri hesaplanıyor... ⏳` }, { quoted: m });
          try {
            const buffer = await downloadMediaMessage(m, 'buffer', {});
            const analysis = await gemini.analyzeMealImage(buffer, text);
            const totals = db.logMeal(user.jid, analysis);

            const target = user.target_calories || 1800;
            const remaining = target - totals.total_cal;

            let reply = `🥗 *Öğün:* ${analysis.food_name}\n`;
            reply += `👤 *Kişi:* ${user.name}\n`;
            reply += `🔥 *Kalori:* ~${analysis.calories} kcal\n`;
            reply += `🥩 *Protein:* ${analysis.protein}g | 🍞 *Karb:* ${analysis.carbs}g | 🥑 *Yağ:* ${analysis.fat}g\n\n`;
            reply += `📊 *${user.name} İçin Bugün:* ${totals.total_cal} / ${target} kcal (${remaining > 0 ? remaining + ' kcal kaldı' : 'Hedef aşıldı!'})\n\n`;
            reply += `💬 *Koç:* ${analysis.comment}`;

            await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          } catch (imgErr) {
            console.error('Görsel analiz hatası:', imgErr);
            await sock.sendMessage(remoteJid, { text: '⚠️ Fotoğraf analiz edilirken bir sorun oluştu. Lütfen tekrar deneyin.' }, { quoted: m });
          }
          continue;
        }

        // 7. METİN İLE YEMEK GİRİŞİ: "yedim: ...", "kahvaltı: ...", "!kalori ..."
        const mealPrefixes = /^(?:yedim|yemek|kahvalti|kahvaltı|öğle|ogle|akşam|aksam|ara\s*öğün|ara|!kalori|!yemek)[\s:]+(.+)/i;
        const textMealMatch = text.match(mealPrefixes);

        if (textMealMatch) {
          const user = db.ensureUser(senderJid, senderName);
          const mealDesc = textMealMatch[1];
          await sock.sendMessage(remoteJid, { text: `🥗 Menü inceleniyor ve ${user.name} için kalori hesaplanıyor... ⏳` }, { quoted: m });

          try {
            const analysis = await gemini.analyzeMealText(mealDesc);
            const totals = db.logMeal(user.jid, analysis);

            const target = user.target_calories || 1800;
            const remaining = target - totals.total_cal;

            let reply = `🥗 *Öğün:* ${analysis.food_name}\n`;
            reply += `👤 *Kişi:* ${user.name}\n`;
            reply += `🔥 *Kalori:* ~${analysis.calories} kcal\n`;
            reply += `🥩 *Protein:* ${analysis.protein}g | 🍞 *Karb:* ${analysis.carbs}g | 🥑 *Yağ:* ${analysis.fat}g\n\n`;
            reply += `📊 *${user.name} İçin Bugün:* ${totals.total_cal} / ${target} kcal (${remaining > 0 ? remaining + ' kcal kaldı' : 'Hedef aşıldı!'})\n\n`;
            reply += `💬 *Koç:* ${analysis.comment}`;

            await sock.sendMessage(remoteJid, { text: reply }, { quoted: m });
          } catch (mealErr) {
            console.error('Yemek analiz hatası:', mealErr);
            await sock.sendMessage(remoteJid, { text: '⚠️ Yemek bilgisi hesaplanırken bir hata oluştu. Lütfen tekrar deneyin.' }, { quoted: m });
          }
          continue;
        }

      } catch (err) {
        console.error('Mesaj işleme hatası:', err);
      }
    }
  });

  return sock;
}

// Çökmeleri önle (Node.js sürecinin kapanmasını engelle)
process.on('uncaughtException', (err) => {
  console.error('🛡️ Hata yakalandı (Çökme engellendi):', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('🛡️ Promise reddi yakalandı (Çökme engellendi):', reason);
});

// Bulut sunucuları (Render, Koyeb vb.) için web sunucusu (QR'ı webde gösterir ve uyumayı engeller)
const PORT = process.env.PORT || 3000;
http.createServer(async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

  if (isConnected) {
    res.end(`
      <div style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;max-width:600px;margin:auto;">
        <h1 style="color:#25D366;font-size:32px;margin-bottom:10px;">✅ WhatsApp Botu 7/24 Aktif!</h1>
        <p style="font-size:18px;color:#333;line-height:1.6;">
          <b>"Hayatımı Düzene Sokuyorum"</b> grubu için mesajları dinliyor ve hatırlatıcılar devrede.
        </p>
        <div style="background:#e8f5e9;padding:15px;border-radius:10px;margin-top:20px;color:#2e7d32;">
          Render üzerinde kesintisiz çalışıyor. 🚀
        </div>
      </div>
    `);
  } else if (latestQR) {
    try {
      const qrDataUrl = await QRCodeImg.toDataURL(latestQR, { width: 320 });
      res.end(`
        <div style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:40px;max-width:600px;margin:auto;">
          <h2 style="color:#128C7E;">🥗 WhatsApp Diyet & Kapışma Botu</h2>
          <p style="font-size:16px;color:#555;">Telefonunuzdan WhatsApp ➔ Bağlı Cihazlar ➔ Cihaz Bağla diyerek aşağıdaki kodu taratın:</p>
          <div style="margin:20px 0;">
            <img src="${qrDataUrl}" style="border:5px solid #25D366;border-radius:15px;box-shadow:0 8px 24px rgba(0,0,0,0.12);" />
          </div>
          <p style="color:#888;font-size:13px;">Sayfa 20 saniyede bir otomatik yenilenir.</p>
          <meta http-equiv="refresh" content="20">
        </div>
      `);
    } catch (_) {
      res.end('QR hazırlanıyor, lütfen 5 saniye sonra sayfayı yenileyin...');
    }
  } else {
    res.end(`
      <div style="font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:50px;max-width:600px;margin:auto;">
        <h2 style="color:#333;">⏳ WhatsApp Botu Başlatılıyor...</h2>
        <p style="color:#666;">Lütfen birkaç saniye bekleyin, sayfa otomatik yenilenecek.</p>
        <meta http-equiv="refresh" content="6">
      </div>
    `);
  }
}).listen(PORT, () => {
  console.log(`🌐 Web sağlık servisi ${PORT} portunda dinlemede.`);

  // Render Free Tier Uyku Önleyici (Keep-Alive Self-Ping)
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (renderUrl) {
    console.log(`📡 Render uyku önleyici otomatik ping aktif: ${renderUrl}`);
    setInterval(async () => {
      try {
        await fetch(renderUrl);
        console.log('💓 Keep-alive ping gönderildi (Render uyanık tutuluyor).');
      } catch (_) {}
    }, 8 * 60 * 1000); // 8 dakikada bir kendi kendine ping atarak uyumayı engeller
  }
});

// Botu başlat
startBot().catch(err => console.error('Başlatma hatası:', err));
