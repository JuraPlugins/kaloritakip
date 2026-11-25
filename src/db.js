const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'diet.db'));

// Veritabanı tablolarını oluştur
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    jid TEXT PRIMARY KEY,
    name TEXT,
    target_calories INTEGER DEFAULT 1800,
    target_weight REAL DEFAULT 70.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT,
    weight REAL,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT,
    food_name TEXT,
    calories INTEGER,
    protein REAL DEFAULT 0,
    carbs REAL DEFAULT 0,
    fat REAL DEFAULT 0,
    comment TEXT,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS water (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT,
    glasses INTEGER DEFAULT 1,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS daily_duels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE,
    winner_jid TEXT,
    winner_name TEXT,
    score_details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function findUserByName(name) {
  if (!name) return null;
  const trimmed = name.trim().toLowerCase();
  const all = db.prepare('SELECT * FROM users WHERE jid IS NOT NULL').all();
  let match = all.find(u => u.name && u.name.toLowerCase() === trimmed);
  if (match) return match;
  match = all.find(u => u.name && u.name.toLowerCase().includes(trimmed));
  return match || null;
}

function resetDayForUser(jid, date = getTodayStr()) {
  const mealDel = db.prepare('DELETE FROM meals WHERE user_jid = ? AND date = ?').run(jid, date);
  const waterDel = db.prepare('DELETE FROM water WHERE user_jid = ? AND date = ?').run(jid, date);
  const weightDel = db.prepare('DELETE FROM weights WHERE user_jid = ? AND date = ?').run(jid, date);
  return {
    mealsDeleted: mealDel.changes,
    waterDeleted: waterDel.changes,
    weightDeleted: weightDel.changes
  };
}

function deleteLastMeal(jid) {
  const lastMeal = db.prepare('SELECT * FROM meals WHERE user_jid = ? ORDER BY id DESC LIMIT 1').get(jid);
  if (lastMeal) {
    db.prepare('DELETE FROM meals WHERE id = ?').run(lastMeal.id);
    return lastMeal;
  }
  return null;
}

function wipeAllData() {
  db.exec(`
    DELETE FROM users;
    DELETE FROM meals;
    DELETE FROM weights;
    DELETE FROM water;
    DELETE FROM daily_duels;
  `);
}

function getTodayStr() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

function ensureUser(jid, name = 'Kullanıcı') {
  const existing = db.prepare('SELECT * FROM users WHERE jid = ?').get(jid);
  if (!existing) {
    db.prepare('INSERT INTO users (jid, name) VALUES (?, ?)').run(jid, name);
    return db.prepare('SELECT * FROM users WHERE jid = ?').get(jid);
  }
  if (name && name !== 'Kullanıcı' && existing.name !== name) {
    db.prepare('UPDATE users SET name = ? WHERE jid = ?').run(name, jid);
    existing.name = name;
  }
  return existing;
}

function setUserTarget(jid, type, val) {
  ensureUser(jid);
  if (type === 'kalori' || type === 'calorie') {
    db.prepare('UPDATE users SET target_calories = ? WHERE jid = ?').run(parseInt(val), jid);
  } else if (type === 'kilo' || type === 'weight') {
    db.prepare('UPDATE users SET target_weight = ? WHERE jid = ?').run(parseFloat(val), jid);
  }
}

function logWeight(jid, weight) {
  ensureUser(jid);
  const today = getTodayStr();
  
  // Önceki son kiloyu al (bugünden farklı veya önceki kayıt)
  const prevRecord = db.prepare(`
    SELECT weight FROM weights 
    WHERE user_jid = ? AND date < ? 
    ORDER BY date DESC, id DESC LIMIT 1
  `).get(jid, today);

  // Bugün zaten kilo girilmiş mi? Varsa güncelle, yoksa ekle
  const todayEntry = db.prepare('SELECT id FROM weights WHERE user_jid = ? AND date = ?').get(jid, today);
  if (todayEntry) {
    db.prepare('UPDATE weights SET weight = ? WHERE id = ?').run(weight, todayEntry.id);
  } else {
    db.prepare('INSERT INTO weights (user_jid, weight, date) VALUES (?, ?, ?)').run(jid, weight, today);
  }

  const diff = prevRecord ? (weight - prevRecord.weight).toFixed(1) : null;
  return {
    weight,
    diff,
    prevWeight: prevRecord ? prevRecord.weight : null
  };
}

function getLatestWeight(jid) {
  return db.prepare('SELECT weight, date FROM weights WHERE user_jid = ? ORDER BY date DESC, id DESC LIMIT 1').get(jid);
}

function logMeal(jid, mealData) {
  ensureUser(jid);
  const today = getTodayStr();
  db.prepare(`
    INSERT INTO meals (user_jid, food_name, calories, protein, carbs, fat, comment, date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    jid,
    mealData.food_name || 'Öğün',
    parseInt(mealData.calories) || 0,
    parseFloat(mealData.protein) || 0,
    parseFloat(mealData.carbs) || 0,
    parseFloat(mealData.fat) || 0,
    mealData.comment || '',
    today
  );

  // Günlük toplamı hesapla
  const dailyTotal = db.prepare(`
    SELECT SUM(calories) as total_cal, SUM(protein) as total_prot, SUM(carbs) as total_carbs, SUM(fat) as total_fat
    FROM meals WHERE user_jid = ? AND date = ?
  `).get(jid, today);

  return dailyTotal;
}

function logWater(jid, count = 1) {
  ensureUser(jid);
  const today = getTodayStr();
  db.prepare('INSERT INTO water (user_jid, glasses, date) VALUES (?, ?, ?)').run(jid, count, today);

  const total = db.prepare('SELECT SUM(glasses) as total_glasses FROM water WHERE user_jid = ? AND date = ?').get(jid, today);
  return total.total_glasses || 0;
}

function getDailySummary(date = getTodayStr()) {
  const users = db.prepare('SELECT * FROM users').all();
  return users.map(user => {
    const mealSum = db.prepare(`
      SELECT SUM(calories) as total_cal, COUNT(*) as meal_count,
             SUM(protein) as total_prot, SUM(carbs) as total_carbs, SUM(fat) as total_fat
      FROM meals WHERE user_jid = ? AND date = ?
    `).get(user.jid, date);

    const waterSum = db.prepare(`
      SELECT SUM(glasses) as total_glasses FROM water WHERE user_jid = ? AND date = ?
    `).get(user.jid, date);

    const weightEntry = db.prepare(`
      SELECT weight FROM weights WHERE user_jid = ? AND date = ?
    `).get(user.jid, date);

    const latestWeight = weightEntry ? weightEntry.weight : (getLatestWeight(user.jid)?.weight || null);

    return {
      user,
      totalCalories: mealSum.total_cal || 0,
      mealCount: mealSum.meal_count || 0,
      totalProtein: (mealSum.total_prot || 0).toFixed(0),
      totalCarbs: (mealSum.total_carbs || 0).toFixed(0),
      totalFat: (mealSum.total_fat || 0).toFixed(0),
      waterGlasses: waterSum.total_glasses || 0,
      waterMl: (waterSum.total_glasses || 0) * 250,
      currentWeight: latestWeight
    };
  });
}

function calculateBattleScore(date = getTodayStr()) {
  const summary = getDailySummary(date);
  if (!summary || summary.length === 0) return null;

  const results = summary.map(item => {
    let score = 0;
    const breakdown = [];

    // 1. Su puanı (Her bardak 10 puan, 8 bardak ve üstü +25 bonus)
    const waterScore = Math.min(item.waterGlasses * 10, 100);
    score += waterScore;
    if (waterScore > 0) breakdown.push(`💧 Su: +${waterScore}p`);
    if (item.waterGlasses >= 8) {
      score += 25;
      breakdown.push(`🌊 2L Su Bonusu: +25p`);
    }

    // 2. Öğün kaydetme disiplini (Her öğün 10 puan, max 30)
    const mealScore = Math.min(item.mealCount * 10, 30);
    score += mealScore;
    if (mealScore > 0) breakdown.push(`🥗 Öğün Kaydı: +${mealScore}p`);

    // 3. Kalori disiplini
    const target = item.user.target_calories || 1800;
    if (item.totalCalories > 0) {
      if (item.totalCalories <= target) {
        score += 60;
        breakdown.push(`🎯 Hedef Kaloride Kalma: +60p`);
      } else {
        const over = item.totalCalories - target;
        const penalty = Math.min(Math.round(over / 10), 60);
        score -= penalty;
        breakdown.push(`⚠️ Kalori Aşımı (-${penalty}p)`);
      }
    }

    // 4. Kilo tartı kontrolü
    const todayWeight = db.prepare('SELECT weight FROM weights WHERE user_jid = ? AND date = ?').get(item.user.jid, date);
    if (todayWeight) {
      score += 30;
      breakdown.push(`⚖️ Sabah Tartılma: +30p`);
    }

    return {
      ...item,
      totalScore: Math.max(score, 0),
      breakdown
    };
  });

  // Puana göre sırala
  results.sort((a, b) => b.totalScore - a.totalScore);

  const isTie = results.length >= 2 && results[0].totalScore === results[1].totalScore;
  const winner = isTie ? null : results[0];
  const runnerUp = isTie ? null : (results[1] || null);

  return {
    date,
    results,
    isTie,
    winner,
    runnerUp
  };
}

function recordDailyDuel(date, winnerJid, winnerName, scoreDetails = '') {
  db.prepare(`
    INSERT OR REPLACE INTO daily_duels (date, winner_jid, winner_name, score_details)
    VALUES (?, ?, ?, ?)
  `).run(date, winnerJid, winnerName, scoreDetails);
}

function getMonthlyLeaderboard(monthStr) {
  if (!monthStr) {
    const now = new Date();
    monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const users = db.prepare('SELECT * FROM users').all();
  const pattern = `${monthStr}%`;

  const leaderboard = users.map(user => {
    // Aylık toplam galibiyet
    const winRow = db.prepare(`
      SELECT COUNT(*) as wins FROM daily_duels 
      WHERE winner_jid = ? AND date LIKE ?
    `).get(user.jid, pattern);

    // Aylık toplam su (bardak)
    const waterRow = db.prepare(`
      SELECT SUM(glasses) as total_glasses FROM water 
      WHERE user_jid = ? AND date LIKE ?
    `).get(user.jid, pattern);

    // Aylık ortalama kalori
    const calRow = db.prepare(`
      SELECT AVG(day_cal) as avg_cal FROM (
        SELECT SUM(calories) as day_cal FROM meals 
        WHERE user_jid = ? AND date LIKE ?
        GROUP BY date
      )
    `).get(user.jid, pattern);

    // Ay başı ve ay sonu kilo farkı
    const firstWeight = db.prepare(`
      SELECT weight FROM weights 
      WHERE user_jid = ? AND date LIKE ?
      ORDER BY date ASC, id ASC LIMIT 1
    `).get(user.jid, pattern);

    const latestWeight = db.prepare(`
      SELECT weight FROM weights 
      WHERE user_jid = ? AND date LIKE ?
      ORDER BY date DESC, id DESC LIMIT 1
    `).get(user.jid, pattern);

    let weightDiff = null;
    if (firstWeight && latestWeight && firstWeight.weight !== latestWeight.weight) {
      weightDiff = (latestWeight.weight - firstWeight.weight).toFixed(1);
    }

    return {
      user,
      wins: winRow?.wins || 0,
      totalWaterLiters: (((waterRow?.total_glasses || 0) * 250) / 1000).toFixed(1),
      avgCalories: Math.round(calRow?.avg_cal || 0),
      firstWeight: firstWeight?.weight || null,
      latestWeight: latestWeight?.weight || null,
      weightDiff
    };
  });

  // Galibiyet sayısına göre sırala
  leaderboard.sort((a, b) => b.wins - a.wins);
  return { monthStr, leaderboard };
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = {
  db,
  ensureUser,
  setUserTarget,
  logWeight,
  getLatestWeight,
  logMeal,
  logWater,
  getDailySummary,
  calculateBattleScore,
  recordDailyDuel,
  getMonthlyLeaderboard,
  findUserByName,
  resetDayForUser,
  deleteLastMeal,
  wipeAllData,
  getSetting,
  setSetting,
  getTodayStr
};
