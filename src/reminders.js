const cron = require('node-cron');
const db = require('./db');
const gemini = require('./gemini');

function setupReminders(sock) {
  // 1. Sabah 08:30 - Tartı ve Kahvaltı Hatırlatması
  cron.schedule('30 8 * * *', async () => {
    const groupId = db.getSetting('active_group_jid');
    if (!groupId) return;

    const message = `🌅 *GÜNAYDIN ÇİFTLER! SABAH TARTI & KAHVALTI VAKTİ ⚖️🍳*\n\n` +
      `Güne taze ve hafif bir başlangıç yapıyoruz!\n` +
      `1️⃣ Aç karnına tartılıp güncel kilonuzu yazın 👉 \`kilo 68.5\`\n` +
      `2️⃣ Güne enerjik başlamak için ne yediniz? Kahvaltınızı fotoğraflayın veya yazın 👉 \`kahvaltı: 2 haşlanmış yumurta, peynir, domates\`\n\n` +
      `Bugünün ilk puanlarını kapma yarışı başladı! 🏃‍♂️🏃‍♀️`;
    try {
      await sock.sendMessage(groupId, { text: message });
    } catch (err) {
      console.error('Sabah hatırlatıcısı gönderilemedi:', err.message);
    }
  });

  // 2. Öğlen 12:30 - Öğle Yemeği & Su Hatırlatması
  cron.schedule('30 12 * * *', async () => {
    const groupId = db.getSetting('active_group_jid');
    if (!groupId) return;

    const message = `🥗 *ÖĞLE YEMEĞİ & SU MOLASI! 🍽️🥤*\n\n` +
      `Tabağınız hazır mı? Yemeğe başlamadan önce:\n` +
      `• Bir büyük bardak su için (\`+1 su\` yazın).\n` +
      `• Tabağınızın fotoğrafını çekip gruba atın veya yazın (\`öğle: ...\`).\n\n` +
      `Bakalım öğlen kim daha dengeli ve temiz beslenecek? 🥑✨`;
    try {
      await sock.sendMessage(groupId, { text: message });
    } catch (err) {
      console.error('Öğle hatırlatıcısı gönderilemedi:', err.message);
    }
  });

  // 3. İkindi 15:30 - İkindi Su & Ara Öğün Hatırlatması
  cron.schedule('30 15 * * *', async () => {
    const groupId = db.getSetting('active_group_jid');
    if (!groupId) return;

    const message = `⚡ *İKİNDİ ENERJİ & SU HATIRLATMASI! 💧*\n\n` +
      `Metabolizma hızını düşürmüyoruz! Hemen 1 bardak su için ve gruba \`+1 su\` yazın.\n` +
      `Bir avuç çiğ kuruyemiş, yeşil çay veya meyve molası verdiyseniz bildirmeyi unutmayın! 🍏`;
    try {
      await sock.sendMessage(groupId, { text: message });
    } catch (err) {
      console.error('İkindi hatırlatıcısı gönderilemedi:', err.message);
    }
  });

  // 4. Akşam 19:15 - Akşam Yemeği Hatırlatması
  cron.schedule('15 19 * * *', async () => {
    const groupId = db.getSetting('active_group_jid');
    if (!groupId) return;

    const message = `🍲 *AKŞAM YEMEĞİ ZAMANI! 🍽️*\n\n` +
      `Akşam masası kuruldu mu? Tabağınızı fazla karbonhidrata boğmadan dengeli tutun!\n` +
      `Akşam yemeğinizin fotoğrafını atın veya yazın 👉 \`akşam: tavuklu salata, çorba\`\n\n` +
      `🏆 Saat 22:30'da BÜYÜK GÜN SONU KAPIŞMASI var, puanlarınızı son ana bırakmayın! 🔥`;
    try {
      await sock.sendMessage(groupId, { text: message });
    } catch (err) {
      console.error('Akşam yemeği hatırlatıcısı gönderilemedi:', err.message);
    }
  });

  // 5. Gece 21:15 - Son Su Kontrolü
  cron.schedule('15 21 * * *', async () => {
    const groupId = db.getSetting('active_group_jid');
    if (!groupId) return;

    const message = `💧 *GÜNÜN SON SU KONTROLÜ! 🚰*\n\n` +
      `Yatmadan önce günlük 2 litre (8 bardak) su hedefine ulaştınız mı?\n` +
      `Eksik bardakları tamamlayıp gruba \`+1 su\` yazın, kapışma puanınıza ekleyin! 🎯`;
    try {
      await sock.sendMessage(groupId, { text: message });
    } catch (err) {
      console.error('Gece su hatırlatıcısı gönderilemedi:', err.message);
    }
  });

  // 6. Gece 22:30 - BÜYÜK GÜN SONU KAPIŞMASI, KAZANAN İLANI & CEZA
  cron.schedule('30 22 * * *', async () => {
    const groupId = db.getSetting('active_group_jid');
    if (!groupId) return;

    try {
      const battle = db.calculateBattleScore();
      if (!battle || battle.results.length === 0) return;

      let msg = `🥊 *BÜYÜK GÜN SONU KAPIŞMASI & SKOR TABLOSU* 🥊\n───────────────────────────\n`;

      battle.results.forEach((item, idx) => {
        const medal = idx === 0 ? '🥇' : '🥈';
        const name = item.user.name || item.user.jid.split('@')[0];
        const target = item.user.target_calories || 1800;

        msg += `${medal} *${name}* ➔ *${item.totalScore} PUAN*\n`;
        msg += `   • Kalori: ${item.totalCalories} / ${target} kcal\n`;
        msg += `   • Su: ${item.waterGlasses} bardak (${item.waterMl} ml)\n`;
        msg += `   • Detay: ${item.breakdown.join(', ')}\n\n`;
      });

      // Galip belirleme ve veritabanına kaydetme
      let roast = null;
      try {
        roast = await gemini.generateBattleRoast(battle);
      } catch (err) {
        console.error('Gemini roast hatası:', err);
      }

      if (battle.isTie) {
        msg += `🤝 *BUGÜN BERABERLİK!* İkiniz de eşit puanla günü tamamladınız!\n\n`;
      } else if (battle.winner) {
        const winnerName = battle.winner.user.name || battle.winner.user.jid.split('@')[0];
        const runnerName = battle.runnerUp?.user.name || 'Rakip';

        // Galibiyeti DB'ye kaydet
        db.recordDailyDuel(battle.date, battle.winner.user.jid, winnerName, `${battle.winner.totalScore} - ${battle.runnerUp?.totalScore || 0}`);

        msg += `🏆 *GÜNÜN ŞAMPİYONU:* *${winnerName.toUpperCase()}* 🎉👏\n\n`;
        if (roast) {
          msg += `🎙️ *Spiker Masasından Yorum:* \n${roast.commentary}\n\n`;
          msg += `😈 *${runnerName} İçin Günün Cezası:* \n${roast.punishment}\n`;
        }
      }

      msg += `───────────────────────────\n📅 Aylık genel durumu görmek için: \`!skor\`\nTatlı rüyalar şampiyonlar! ✨💖`;

      await sock.sendMessage(groupId, { text: msg });
    } catch (err) {
      console.error('Gün sonu kapışması gönderilemedi:', err.message);
    }
  });

  console.log('⏰ Hatırlatıcılar aktif: 08:30 Sabah/Kahvaltı, 12:30 Öğle, 15:30 İkindi, 19:15 Akşam, 21:15 Su, 22:30 Kapışma!');
}

module.exports = { setupReminders };
