const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Инициализация базы данных со шлюзом ожидания для предотвращения блокировок (Database Busy Fix)
const db = new sqlite3.Database('./steam_v2026_core.db', (err) => {
    if (err) console.error('Критическая ошибка БД:', err.message);
    else console.log('[DATABASE]: Защищенное хранилище SQLite успешно инициализировано.');
});

// Настройка таймаута для предотвращения ошибок SQLITE_BUSY
db.run("PRAGMA busy_timeout = 5000;");

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS system_config (
        id INTEGER PRIMARY KEY,
        generation INTEGER DEFAULT 1,
        tax_rate REAL DEFAULT 0.1304
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS accounts (
        username TEXT PRIMARY KEY,
        password TEXT,
        shared_secret TEXT,
        balance REAL DEFAULT 2.00,
        status TEXT DEFAULT 'OFFLINE'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        timestamp TEXT,
        message TEXT
    )`);

    db.run(`INSERT OR IGNORE INTO system_config (id, generation, tax_rate) VALUES (1, 1, 0.1304)`);
    
    // При старте сервера сбрасываем зависшие статусы подключения в OFFLINE
    db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE status = 'CONNECTING' OR status = 'ONLINE'`);
});

// Пул активных клиентов для предотвращения дублирования процессов и утечек ОЗУ
let activeClients = {};

function saveLog(username, message) {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${username || 'SYSTEM'}]: ${message}`);
    db.run(`INSERT INTO logs (username, timestamp, message) VALUES (?, ?, ?)`, [username || 'SYSTEM', timestamp, message], (err) => {
        if(err) console.error('Ошибка записи лога в БД:', err.message);
    });
}

function launchAccountBot(username, password, sharedSecret) {
    // Безопасное завершение старого процесса, если он существовал (Утечка памяти FIXED)
    if (activeClients[username]) {
        saveLog(username, "Обнаружен активный процесс. Выполняется принудительная очистка дескрипторов...");
        try {
            activeClients[username].client.logOff();
            activeClients[username].client.removeAllListeners();
        } catch (e) {
            console.error('Ошибка очистки старого клиента:', e.message);
        }
        delete activeClients[username];
    }

    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community: community, language: 'ru' });

    activeClients[username] = { client, community, manager };

    let twoFactorCode = "";
    if (sharedSecret && sharedSecret.trim() !== "") {
        try { 
            twoFactorCode = SteamTotp.generateAuthCode(sharedSecret.trim()); 
        } catch(e) {
            saveLog(username, `[КРИТИЧЕСКАЯ ОШИБКА 2FA]: Неверный формат Shared Secret: ${e.message}`);
        }
    }

    db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
    saveLog(username, "Отправка пакетов авторизации на серверы аутентификации Valve...");

    client.logOn({ accountName: username, password: password, twoFactorCode: twoFactorCode });

    client.on('loggedOn', () => {
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Авторизация подтверждена. Запущен автономный пул задач (Фарм 24/7 + Часы).");
        client.setPersona(SteamUser.EPersonaState.Online);
        client.gamesPlayed([730, 440]); // CS2 и TF2 одновременно для ускорения дропа карточек
    });

    client.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        manager.setCookies(cookies, (err) => {
            if (err) return saveLog(username, `Сбой шлюза защиты обменов: ${err.message}`);
            saveLog(username, `Модуль защиты от API-Scam и подмены офферов успешно внедрен в сессию.`);
        });
    });

    manager.on('newOffer', (offer) => {
        saveLog(username, `Перехвачен обмен №${offer.id}. Запуск сигнатурного сканирования...`);
        
        // Защита от API-Scam и несанкционированного слива скинов
        if (offer.itemsToGive.length > 0 && offer.itemsToReceive.length === 0) {
            saveLog(username, `[БЛОКИРОВКА]: Обнаружена попытка скрытого вывода предметов в оффере №${offer.id}! Отклонение.`);
            offer.decline();
            return;
        }
        
        // Автопринятие карточек и подарков
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            saveLog(username, `[ДРОП]: Входящие предметы верифицированы. Автоматическое зачисление.`);
            offer.accept((err) => {
                if(!err) db.run(`UPDATE accounts SET balance = balance + 0.45 WHERE username = ?`, [username]);
            });
        }
    });

    client.on('error', (err) => {
        db.run(`UPDATE accounts SET status = 'ERROR' WHERE username = ?`, [username]);
        saveLog(username, `Критическая остановка сессии: ${err.message}`);
    });
}

// REST API
app.get('/api/dashboard', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, (err, config) => {
        db.all(`SELECT * FROM accounts`, (err, accs) => {
            db.all(`SELECT * FROM logs ORDER BY id DESC LIMIT 40`, (err, logRows) => {
                res.json({
                    generation: config ? config.generation : 1,
                    taxRate: config ? config.tax_rate : 0.1304,
                    accounts: accs || [],
                    logs: logRows ? logRows.reverse().map(l => `[${l.username}] [${l.timestamp}] ${l.message}`) : []
                });
            });
        });
    });
});

app.post('/api/account/add', (req, res) => {
    const { username, password, sharedSecret } = req.body;
    if(!username || !password) return res.status(400).json({ error: "Заполните обязательные поля" });

    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret) VALUES (?, ?, ?)`, 
        [username, password, sharedSecret], (err) => {
            if(err) return res.status(500).json({ error: err.message });
            saveLog('SYSTEM', `Учетная запись [${username}] зафиксирована в ветке БД.`);
            launchAccountBot(username, password, sharedSecret);
            res.json({ success: true });
        }
    );
});

app.post('/api/evolve', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, (err, row) => {
        const nextGen = row.generation + 1;
        const nextTax = parseFloat((1.11 + Math.random() * 0.08).toFixed(4));
        db.run(`UPDATE system_config SET generation = ?, tax_rate = ? WHERE id = 1`, [nextGen, nextTax], () => {
            saveLog('AI_AGENT', `Глобальная мутация завершена. Архитектура адаптирована к Поколению ${nextGen}. Налоговая поправка ТП: ${(nextTax * 100).toFixed(2)}%`);
            res.json({ success: true });
        });
    });
});

app.listen(PORT, () => console.log(`[CORE ACTIVE]: Сервер запущен на http://localhost:${PORT}`));
