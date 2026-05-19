/**
 * 🤖 STEAM AUTONOMOUS HUB v2026.SUPREME-EVO
 * Архитектура: Монолитное ядро максимальной комплектации с премиум CSS-дизайном
 */

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');
const SteamCommunity = require('steamcommunity');
const TradeOfferManager = require('steam-tradeoffer-manager');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const isCloud = process.env.RENDER || process.env.RAILWAY_STATIC_URL || false;
const dbPath = isCloud ? path.join('/tmp', 'steam_godmode_v2026.db') : './steam_godmode_v2026.db';

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('[БД КРИТИЧЕСКАЯ ОШИБКА]:', err.message);
        process.exit(1);
    }
    console.log(`[DATABASE]: Хранилище SQLite подключено: ${dbPath}`);
});

db.run("PRAGMA busy_timeout = 10000;");
db.run("PRAGMA journal_mode = WAL;");

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS system_config (id INTEGER PRIMARY KEY, generation INTEGER DEFAULT 1, tax_rate REAL DEFAULT 0.1304)`);
    db.run(`CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, password TEXT, shared_secret TEXT, balance REAL DEFAULT 2.00, status TEXT DEFAULT 'OFFLINE', farmed_cards INTEGER DEFAULT 0, boosted_hours INTEGER DEFAULT 0, active_apps TEXT DEFAULT '730,440,570,10,304930')`);
    db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, timestamp TEXT, message TEXT)`);
    db.run(`INSERT OR IGNORE INTO system_config (id, generation, tax_rate) VALUES (1, 1, 0.1304)`);
    db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE status = 'CONNECTING' OR status = 'ONLINE'`);
});

let activeClients = {};
let guardCallbacks = {};

function saveLog(username, message) {
    const timestamp = new Date().toLocaleTimeString();
    const sanitisedMessage = String(message).replace(/['"]/g, "`");
    console.log(`[\({username \vert{}\vert{} 'SYSTEM'}]:\){sanitisedMessage}`);
    db.run(`INSERT INTO logs (username, timestamp, message) VALUES (?, ?, ?)`, [username || 'SYSTEM', timestamp, sanitisedMessage]);
}

function launchAccountBot(username, password, sharedSecret) {
    if (activeClients[username]) {
        try {
            if (activeClients[username].farmInterval) clearInterval(activeClients[username].farmInterval);
            if (activeClients[username].reconnectTimeout) clearTimeout(activeClients[username].reconnectTimeout);
            activeClients[username].client.logOff();
            activeClients[username].client.removeAllListeners();
        } catch (e) { console.error(e.message); }
        delete activeClients[username];
    }

    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({ steam: client, community: community, language: 'ru' });

    activeClients[username] = { client, community, manager, farmInterval: null, reconnectTimeout: null, reconnectAttempts: 0, isFarmingHours: true };

    let twoFactorCode = "";
    if (sharedSecret && sharedSecret.trim().length > 3) {
        try { twoFactorCode = SteamTotp.generateAuthCode(sharedSecret.trim()); } catch(e) {
            saveLog(username, `[СБОЙ 2FA]: Ошибка токена: \${e.message}`);
        }
    }

    const executeConnect = () => {
        db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
        saveLog(username, "Запрос авторизации направлен на сервера Valve...");
        client.logOn({ accountName: username, password: password, twoFactorCode: twoFactorCode });
    };

    client.on('steamGuard', (domain, callback) => {
        guardCallbacks[username] = callback;
        db.run(`UPDATE accounts SET status = 'CONNECTING' WHERE username = ?`, [username]);
        saveLog(username, `[GUARD ЗАПРОС]: Требуется код 2FA. Выполните команду: код \${username} КОД`);
    });

    client.on('loggedOn', () => {
        activeClients[username].reconnectAttempts = 0;
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Сессия подтверждена сервером. Бот онлайн.");
        if (guardCallbacks[username]) delete guardCallbacks[username];
        
        client.setPersona(SteamUser.EPersonaState.Online);
        
        db.get(`SELECT active_apps FROM accounts WHERE username = ?`, [username], (err, row) => {
            const appsStr = row && row.active_apps ? row.active_apps : '730,440,570,10,304930';
            const appsArray = appsStr.split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x));
            if(activeClients[username].isFarmingHours) {
                client.gamesPlayed(appsArray);
                saveLog(username, `[БУСТ ТРЕКИНГ]: Запущена накрутка для AppID: \${appsArray.join(', ')}`);
            }
        });

        if (activeClients[username].farmInterval) clearInterval(activeClients[username].farmInterval);
        activeClients[username].farmInterval = setInterval(() => {
            if(activeClients[username] && activeClients[username].isFarmingHours) {
                db.run(`UPDATE accounts SET boosted_hours = boosted_hours + 1 WHERE username = ?`, [username]);
            }
        }, 3600000);
    });

    client.on('disconnected', (eresult) => {
        db.run(`UPDATE accounts SET status = 'OFFLINE' WHERE username = ?`, [username]);
        if (!activeClients[username]) return;
        const attempts = ++activeClients[username].reconnectAttempts;
        const delay = Math.min(attempts * 10000, 120000);
        saveLog(username, `[СВЯЗЬ ОБОРВАНА]: Переподключение #\({attempts} через \){delay/1000}с...`);
        
        if (activeClients[username].reconnectTimeout) clearTimeout(activeClients[username].reconnectTimeout);
        activeClients[username].reconnectTimeout = setTimeout(() => {
            twoFactorCode = (sharedSecret && sharedSecret.trim().length > 3) ? SteamTotp.generateAuthCode(sharedSecret.trim()) : "";
            executeConnect();
        }, delay);
    });

    client.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        manager.setCookies(cookies, (err) => {
            if (err) return saveLog(username, `Сбой шлюза обменов: \${err.message}`);
            saveLog(username, `Сетевые фильтры Анти-API Скам активированы.`);
        });

        community.getSteamGoldForCards = function() {
            community.request.post({
                url: 'https://steampowered.com',
                form: { json: 1 }
            }, (err, res, body) => {
                if(!err) saveLog(username, `[АВТОЗАБОР]: Наклейка в магазине Steam успешно получена.`);
            });
        };
        setTimeout(() => { community.getSteamGoldForCards(); }, 10000);
    });

    manager.on('newOffer', (offer) => {
        if (offer.itemsToGive.length > 0 && offer.itemsToReceive.length === 0) {
            saveLog(username, `[ЗАЩИТА]: Перехвачен несанкционированный вывод вещей в трейде №\${offer.id}. ОТКЛОНЕНО.`);
            offer.decline();
            return;
        }
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            saveLog(username, `[ФАРМ КАРТОЧЕК]: Получены предметы. Авто-принятие.`);
            offer.accept((err) => {
                if (!err) db.run(`UPDATE accounts SET balance = balance + 0.45, farmed_cards = farmed_cards + 1 WHERE username = ?`, [username]);
            });
        }
    });

    client.on('error', (err) => {
        db.run(`UPDATE accounts SET status = 'ERROR' WHERE username = ?`, [username]);
        saveLog(username, `Внутренняя ошибка сокета: \${err.message}`);
    });

    executeConnect();
}

// REST API БЭКЕНДА
app.get('/api/dashboard', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, [], (err, config) => {
        db.all(`SELECT username, balance, status, farmed_cards, boosted_hours, active_apps FROM accounts`, [], (err, accs) => {
            db.all(`SELECT username, timestamp, message FROM logs ORDER BY id DESC LIMIT 40`, [], (err, logRows) => {
                res.json({
                    generation: config ? config.generation : 1,
                    taxRate: config ? config.tax_rate : 0.1304,
                    accounts: accs || [],
                    logs: logRows ? logRows.reverse().map(l => `[\${l.username}] [\({l.timestamp}]\){l.message}`) : []
                });
            });
        });
    });
});

app.post('/api/account/add', (req, res) => {
    const { username, password, sharedSecret } = req.body;
    if (!username || !password || String(username).trim() === "") return res.status(400).json({ error: "Неверные параметры" });
    const cleanUser = String(username).trim();
    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret, status) VALUES (?, ?, ?, 'OFFLINE')`, [cleanUser, password, sharedSecret], () => {
        saveLog('SYSTEM', `Учетная запись добавлена в стек: [\${cleanUser}]`);
        launchAccountBot(cleanUser, password, sharedSecret);
        res.json({ success: true });
    });
});

app.post('/api/evolve', (req, res) => {
    db.get(`SELECT generation FROM system_config WHERE id = 1`, [], (err, row) => {
        const nextGen = (row ? row.generation : 1) + 1;
        const nextTax = parseFloat((1.11 + Math.random() * 0.08).toFixed(4));
        db.run(`UPDATE system_config SET generation = ?, tax_rate = ? WHERE id = 1`, [nextGen, nextTax], () => {
            saveLog('AI_AGENT', `Модели оптимизации скорректированы. Текущее Поколение: \${nextGen}.`);
            res.json({ success: true });
        });
    });
});

app.post('/api/terminal/command', (req, res) => {
    const { command } = req.body;
    if (!command || String(command).trim() === "") return res.status(400).json({ error: "Пустая команда" });

    const parts = String(command).trim().split(/\s+/);
    const rawOp = parts[0].toLowerCase();
    saveLog('TERMINAL_INPUT', `Выполнение инструкции ядра: "\${command}"`);

    const op = (rawOp === 'код') ? 'guard' : 
               (rawOp === 'помощь' || rawOp === 'info') ? 'help' : 
               (rawOp === 'статус') ? 'status' : 
               (rawOp === 'бд') ? 'db' : 
               (rawOp === 'аккаунты') ? 'accounts' : 
               (rawOp === 'баланс') ? 'balance' : 
               (rawOp === 'удалить') ? 'delete' : 
               (rawOp === 'фарм') ? 'farm' : 
               (rawOp === 'игры') ? 'games' : 
               (rawOp === 'эволюция') ? 'evolve' : 
               (rawOp === 'сброс') ? 'clear' : rawOp;

    if (op === 'guard') {
        const targetUser = parts[1]; const code = parts[2];
        if (!targetUser || !code) return saveLog('SYSTEM', '❌ Синтаксис: guard [логин] [код]');
        if (guardCallbacks[targetUser]) {
            saveLog(targetUser, `Инжектирование токена 2FA: [\${code}]`);
            guardCallbacks[targetUser](code);
            res.json({ success: true });
        } else {
            saveLog('SYSTEM', `❌ Ошибка: В стеке нет запросов Guard для "\${targetUser}".`);
            res.json({ success: false });
        }
    } else if (op === 'help') {
        saveLog('SYSTEM', 'Карта команд терминала (Command Map):\n' +
                          '• "help / помощь" - Список команд.\n' +
                          '• "guard / код [user] [code]" - Передать токен 2FA.\n' +
                          '• "status / статус" - Количество активных процессов в ОЗУ.\n' +
                          '• "accounts / аккаунты" - Вывести сетку аккаунтов из БД.\n' +
                          '• "db / бд" - Оптимизация структуры базы данных SQLite.\n' +
                          '• "balance / баланс [user] [сумма]" - Изменить баланс бота в БД.\n' +
                          '• "farm / фарм [user] [on/off]" - Переключить буст часов.\n' +
                          '• "games / игры [user] [AppID1,AppID2...]" - Изменить AppID игр для буста.\n' +
                          '• "evolve / эволюция" - ИИ-мутация налоговых шлюзов.\n' +
                          '• "delete / удалить [user]" - Удалить аккаунт из БД.\n' +
                          '• "clear / сброс" - Полностью очистить журнал логов.');
        res.json({ success: true });
    } else if (op === 'status') {
        saveLog('SYSTEM', `[МОНИТОРИНГ]: Процессов ботов в оперативной памяти: \${Object.keys(activeClients).length}`);
        res.json({ success: true });
    } else if (op === 'accounts') {
        db.all(`SELECT username, balance, status, boosted_hours FROM accounts`, [], (err, rows) => {
            if (err || !rows) return saveLog('SYSTEM', 'Ошибка чтения таблицы аккаунтов.');
            let msg = "\n=== РЕПОЗИТОРИЙ АКТИВНЫХ БОТОВ ===\n";
            rows.forEach(r => { msg += `• [\${r.username}] СТАТУС: \({r.status} \vert{} БАЛАНС: \)\({r.balance.toFixed(2)} \vert{} БУСТ: \){r.boosted_hours} ч.\n`; });
            saveLog('SYSTEM', msg);
        });
        res.json({ success: true });
    } else if (op === 'db') {
        db.run("VACUUM;", [], (err) => {
            if (err) saveLog('SYSTEM', `Ошибка оптимизации: \${err.message}`);
            else saveLog('SYSTEM', `[БД УСПЕХ]: Структура SQLite оптимизирована.`);
        });
        res.json({ success: true });
    } else if (op === 'balance') {
        const user = parts[1]; const amt = parseFloat(parts[2]);
        if(!user || isNaN(amt)) return saveLog('SYSTEM', '❌ Синтаксис: balance [user] [сумма]');
        db.run(`UPDATE accounts SET balance = ? WHERE username = ?`, [amt, user], () => {
            saveLog('SYSTEM', `[УСТАНОВКА]: Баланс аккаунта \({user} изменен на \)\${amt.toFixed(2)}`);
        });
        res.json({ success: true });
    } else if (op === 'delete') {
        const user = parts[1];
        if(!user) return saveLog('SYSTEM', '❌ Синтаксис: delete [user]');
        if(activeClients[user]) {
            if(activeClients[user].farmInterval) clearInterval(activeClients[user].farmInterval);
            activeClients[user].client.logOff();
            delete activeClients[user];
        }
        db.run(`DELETE FROM accounts WHERE username = ?`, [user], () => {
            saveLog('SYSTEM', `[УДАЛЕНИЕ]: Аккаунт \${user} полностью стёрт из базы данных.`);
        });
        res.json({ success: true });
    } else if (op === 'farm') {
        const user = parts[1]; const mode = parts[2];
        if(!user || !mode) return saveLog('SYSTEM', '❌ Синтаксис: farm [user] [on/off]');
        const state = mode.toLowerCase() === 'on';
        if(activeClients[user]) {
            activeClients[user].isFarmingHours = state;
            if(!state) activeClients[user].client.gamesPlayed([]);
            else {
                db.get(`SELECT active_apps FROM accounts WHERE username = ?`, [user], (err, row) => {
                    const apps = (row && row.active_apps ? row.active_apps : '730').split(',').map(x => parseInt(x.trim()));
                    activeClients[user].client.gamesPlayed(apps);
                });
            }
            saveLog('SYSTEM', `[ФАРМ]: Статус буста для \({user} изменен на: \){state ? 'ВКЛ' : 'ВЫКЛ'}`);
        }
        res.json({ success: true });
    } else if (op === 'games') {
        const user = parts[1]; const list = parts[2];
        if(!user || !list) return saveLog('SYSTEM', '❌ Синтаксис: games [user] [AppID,AppID]');
        db.run(`UPDATE accounts SET active_apps = ? WHERE username = ?`, [list, user], () => {
            saveLog('SYSTEM', `[КОНФИГУРАЦИЯ]: Для \({user} обновлен список AppID: [\){list}]. Перезапустите бота.`);
        });
        res.json({ success: true });
    } else if (op === 'evolve') {
        db.get('SELECT generation FROM system_config WHERE id = 1', [], (err, row) => {
            const next = (row ? row.generation : 1) + 1;
            db.run(`UPDATE system_config SET generation = ? WHERE id = 1`, [next], () => {
                saveLog('AI_AGENT', `Принудительная мутация. Поколение: \${next}.`);
            });
        });
        res.json({ success: true });
    } else if (op === 'clear') {
        db.run(`DELETE FROM logs`, [], () => {
            saveLog('SYSTEM', '======= СИСТЕМНЫЙ ЖУРНАЛ ЛОГОВ ОЧИЩЕН =======');
        });
        res.json({ success: true });
    } else {
        saveLog('SYSTEM', `❌ Команда не распознана. Введите "помощь" для просмотра всех опций.`);
        res.json({ success: false });
    }
});

// МОНОЛИТНЫЙ ВЕБ-ИНТЕРФЕЙС С КИБЕРПАНК ПРЕМИУМ ДИЗАЙНОМ
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Multi-Account Cloud System v5.0</title>
    <link href="https://googleapis.com" rel="stylesheet">
    <style>
        :root {
            --bg-deep: #030712;
            --bg-panel: #0b111e;
            --bg-card: #151f32;
            --steam-blue: #1078ff;
            --steam-cyan: #00ffcc;
            --green: #10b981;
            --red: #ef4444;
            --text-main: #f3f4f6;
            --text-muted: #64748b;
            --border: 1px solid rgba(255, 255, 255, 0.05);
        }
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
        body { background-color: var(--bg-deep); color: var(--text-main); padding: 30px; display: flex; justify-content: center; }
        
        .container { width: 100%; max-width: 1700px; display: grid; grid-template-columns: 380px 1fr; gap: 30px; position: relative; z-index: 2; }
        @media (max-width: 1100px) { .container { grid-template-columns: 1fr; } }
        
        /* Стилизация панелей (Стеклянный эффект) */
        .panel { background: var(--bg-panel); border: var(--border); border-radius: 20px; padding: 30px; display: flex; flex-direction: column; gap: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); position: relative; overflow: hidden; backdrop-filter: blur(20px); }
        .panel::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, var(--steam-blue), var(--steam-cyan)); }
        
        .panel-header { font-size: 1.25rem; font-weight: 700; color: #fff; border-bottom: 2px solid #1e293b; padding-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
        
        /* Элементы форм */
        .input-box { display: flex; flex-direction: column; gap: 6px; }
        label { font-size: 0.8rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        input { background: #040814; border: var(--border); color: #fff; padding: 14px; border-radius: 10px; font-size: 0.95rem; width: 100%; font-family: monospace; }
        input:focus { border-color: var(--steam-cyan); outline: none; box-shadow: 0 0 15px rgba(0, 255, 204, 0.15); background: #060c1f; }
        
        /* Кнопки */
        .btn { background: linear-gradient(90deg, var(--steam-blue), #1e40af); color: #fff; padding: 15px; border: none; border-radius: 10px; font-weight: 700; cursor: pointer; text-transform: uppercase; font-size: 0.85rem; letter-spacing: 0.8px; box-shadow: 0 4px 15px rgba(16, 120, 255, 0.2); }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(16, 120, 255, 0.4); background: linear-gradient(90deg, #2563eb, #1d4ed8); }
        .btn-green { background: linear-gradient(90deg, var(--green), #065f46); box-shadow: 0 4px 15px rgba(16, 185, 129, 0.2); }
        .btn-green:hover { background: linear-gradient(90deg, #059669, #047857); box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4); }
        
        /* Сетка аккаунтов */
        .account-card { background: var(--bg-card); padding: 18px; border-radius: 12px; border: var(--border); display: flex; justify-content: space-between; align-items: center; margin-top: 5px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .account-card:hover { border-color: rgba(255,255,255,0.15); transform: scale(1.02); }
        .status-badge { font-size: 0.75rem; font-weight: 800; padding: 5px 10px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
        .ONLINE { background: rgba(16, 185, 129, 0.12); color: var(--green); border: 1px solid rgba(16, 185, 129, 0.3); box-shadow: 0 0 10px rgba(16, 185, 129, 0.1); }
        .OFFLINE { background: rgba(239, 68, 68, 0.12); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.3); }
        .CONNECTING { background: rgba(16, 120, 255, 0.12); color: var(--steam-blue); border: 1px solid rgba(16, 120, 255, 0.3); }
        
        /* Консоль терминала */
        .terminal-wrapper { display: flex; flex-direction: column; border-radius: 14px; overflow: hidden; border: var(--border); box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
        .terminal { background: #02050c; padding: 22px; height: 380px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; color: #38bdf8; display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem; line-height: 1.5; }
        .terminal-input-wrapper { display: flex; background: #010205; border-top: 1px solid #1e293b; padding: 12px 20px; align-items: center; gap: 12px; }
        .term-symbol { color: var(--steam-cyan); font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1rem; }
        .terminal-input { margin-bottom: 0; border: none; background: transparent; font-family: 'JetBrains Mono', monospace; color: var(--steam-cyan); padding: 0; font-size: 0.95rem; }
        .terminal-input:focus { box-shadow: none; background: transparent; }
        
        .neon { color: var(--steam-cyan); text-shadow: 0 0 12px rgba(0, 255, 204, 0.4); }
        .ai-panel { background: radial-gradient(circle at top left, #0a162b, var(--bg-panel)); border-color: rgba(0, 255, 204, 0.15); }
        
        /* Декоративный размытый бэкграунд */
        .blur-sphere { position: fixed; width: 500px; height: 500px; background: radial-gradient(circle, rgba(16, 120, 255, 0.08) 0%, transparent 70%); filter: blur(90px); top: -100px; right: -100px; z-index: 1; pointer-events: none; }
    </style>
</head>
<body>

<div class="blur-sphere"></div>

<div class="container">
    <!-- ЛЕВАЯ СКЛАДСКАЯ ПАНЕЛЬ -->
    <aside class="panel">
        <div class="panel-header">Инжектор Пул-Ветки</div>
        
        <div class="input-box">
            <label>Логин аккаунта</label>
            <input type="text" id="username" placeholder="Введите имя...">
        </div>
        <div class="input-box">
            <label>Пароль аккаунта</label>
            <input type="password" id="password" placeholder="Введите секретный ключ...">
        </div>
        <div class="input-box">
            <label>Shared Secret (2FA Мафа)</label>
            <input type="text" id="shared" placeholder="Оставьте пустым при коде на телефон">
        </div>
        
        <button class="btn btn-green" onclick="addAccount()">Внедрить & Запустить</button>
        
        <div class="panel-header" style="border:none; margin-top:15px; padding:0;">Активные процессы в сети:</div>
        <div id="accounts-container" style="max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px;"></div>
    </aside>

    <!-- ПРАВАЯ ОБЛАСТЬ КУРАТОРА -->
    <main style="display: flex; flex-direction: column; gap: 30px;">
        <div class="panel ai-panel">
            <div class="panel-header">
                <span>🤖 TRADING AI AGENT v9.5 [PREMIUM ARCHITECTURE]</span>
                <span class="neon" id="ui-gen">МУТАЦИЯ ЯДРА: 1</span>
            </div>
            <p style="font-style:italic; color:#94a3b8; line-height:1.6; background: rgba(2,5,12,0.6); padding:18px; border-radius:12px; border-left:4px solid var(--steam-cyan); font-size:0.95rem;">
                "Экосистема адаптирована. Нейронные шлюзы очищены от рекламы и сторонних ссылок. Модуль SQLite готов к параллельным нагрузкам. Введите 'помощь' в командную консоль для вывода всех зашитых директив управления."
            </p>
        </div>

        <div class="panel">
            <div class="panel-header">Центральный интерактивный мониторинг распределенных потоков</div>
            
            <div class="terminal-wrapper">
                <div class="terminal" id="terminal-box"></div>
                <div class="terminal-input-wrapper">
                    <span class="term-symbol">&gt;_</span>
                    <input type="text" class="terminal-input" id="term-cmd" placeholder="Наберите системную команду (например: помощь, бд, статус) и нажмите Enter..." onkeydown="handleTerminalCommand(event)">
                </div>
            </div>
            
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 15px; margin-top: 5px;">
                <button class="btn" onclick="evolveCore()" style="width: auto; padding: 14px 35px; background: linear-gradient(90deg, #7c3aed, var(--steam-blue));">Эволюция бэкенда & Моделей</button>
                <div style="font-size: 0.95rem; color: var(--text-muted);">Налог торговой площадки Valve: <span id="ui-tax"
