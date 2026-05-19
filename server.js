/**
 * 🤖 STEAM AUTONOMOUS HUB v2026.FULL-TERMINAL
 * Архитектура: Монолитное ядро с расширенной картой команд и модулей
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
    console.log(`[DATABASE]: Хранилище SQLite успешно подключено: ${dbPath}`);
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
    console.log(`[${username || 'SYSTEM'}]: ${sanitisedMessage}`);
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
            saveLog(username, `[СБОЙ 2FA]: Ошибка токена: ${e.message}`);
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
        saveLog(username, `[GUARD ЗАПРОС]: Требуется код 2FA. Выполните: guard ${username} КОД`);
    });

    client.on('loggedOn', () => {
        activeClients[username].reconnectAttempts = 0;
        db.run(`UPDATE accounts SET status = 'ONLINE' WHERE username = ?`, [username]);
        saveLog(username, "Сессия успешно подтверждена. Бот онлайн.");
        if (guardCallbacks[username]) delete guardCallbacks[username];
        
        client.setPersona(SteamUser.EPersonaState.Online);
        
        db.get(`SELECT active_apps FROM accounts WHERE username = ?`, [username], (err, row) => {
            const appsStr = row && row.active_apps ? row.active_apps : '730,440,570,10,304930';
            const appsArray = appsStr.split(',').map(x => parseInt(x.trim())).filter(x => !isNaN(x));
            if(activeClients[username].isFarmingHours) {
                client.gamesPlayed(appsArray);
                saveLog(username, `[ДВИЖОК ЧАСОВ]: Накрутка запущена для AppID: ${appsArray.join(', ')}`);
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
        saveLog(username, `[СВЯЗЬ ОБОРВАНА]: Код: ${eresult}. Переподключение #${attempts} через ${delay/1000}с...`);
        
        if (activeClients[username].reconnectTimeout) clearTimeout(activeClients[username].reconnectTimeout);
        activeClients[username].reconnectTimeout = setTimeout(() => {
            twoFactorCode = (sharedSecret && sharedSecret.trim().length > 3) ? SteamTotp.generateAuthCode(sharedSecret.trim()) : "";
            executeConnect();
        }, delay);
    });

    client.on('webSession', (sessionID, cookies) => {
        community.setCookies(cookies);
        manager.setCookies(cookies, (err) => {
            if (err) return saveLog(username, `Сбой шлюза обменов: ${err.message}`);
            saveLog(username, `Сетевые фильтры Анти-API Скам развернуты.`);
        });
    });

    manager.on('newOffer', (offer) => {
        if (offer.itemsToGive.length > 0 && offer.itemsToReceive.length === 0) {
            saveLog(username, `[ЗАЩИТА]: Перехвачен несанкционированный вывод вещей в трейде №${offer.id}. ОТКЛОНЕНО.`);
            offer.decline();
            return;
        }
        if (offer.itemsToGive.length === 0 && offer.itemsToReceive.length > 0) {
            saveLog(username, `[ФАРМ КАРТОЧЕК]: Получены подарочные предметы. Авто-принятие.`);
            offer.accept((err) => {
                if (!err) db.run(`UPDATE accounts SET balance = balance + 0.45, farmed_cards = farmed_cards + 1 WHERE username = ?`, [username]);
            });
        }
    });

    client.on('error', (err) => {
        db.run(`UPDATE accounts SET status = 'ERROR' WHERE username = ?`, [username]);
        saveLog(username, `Внутренняя ошибка сокета: ${err.message}`);
    });

    executeConnect();
}

// RESTFUL BACKEND API
app.get('/api/dashboard', (req, res) => {
    db.get(`SELECT * FROM system_config WHERE id = 1`, [], (err, config) => {
        db.all(`SELECT username, balance, status, farmed_cards, boosted_hours, active_apps FROM accounts`, [], (err, accs) => {
            db.all(`SELECT username, timestamp, message FROM logs ORDER BY id DESC LIMIT 40`, [], (err, logRows) => {
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
    if (!username || !password || String(username).trim() === "") return res.status(400).json({ error: "Неверные параметры" });
    const cleanUser = String(username).trim();
    db.run(`INSERT OR REPLACE INTO accounts (username, password, shared_secret, status) VALUES (?, ?, ?, 'OFFLINE')`, [cleanUser, password, sharedSecret], () => {
        saveLog('SYSTEM', `Учетная запись добавлена в стек: [${cleanUser}]`);
        launchAccountBot(cleanUser, password, sharedSecret);
        res.json({ success: true });
    });
});

app.post('/api/evolve', (req, res) => {
    db.get(`SELECT generation FROM system_config WHERE id = 1`, [], (err, row) => {
        const nextGen = (row ? row.generation : 1) + 1;
        const nextTax = parseFloat((1.11 + Math.random() * 0.08).toFixed(4));
        db.run(`UPDATE system_config SET generation = ?, tax_rate = ? WHERE id = 1`, [nextGen, nextTax], () => {
            saveLog('AI_AGENT', `Модели оптимизации скорректированы. Текущее Поколение: ${nextGen}.`);
            res.json({ success: true });
        });
    });
});

// РАСШИРЕННЫЙ МУЛЬТИЯЗЫЧНЫЙ ТЕРМИНАЛ КОМАНД С ПОДДЕРЖКОЙ УСТАНОВОК
app.post('/api/terminal/command', (req, res) => {
    const { command } = req.body;
    if (!command || String(command).trim() === "") return res.status(400).json({ error: "Пустая команда" });

    const parts = String(command).trim().split(/\s+/);
    const rawOp = parts[0].toLowerCase();
    saveLog('TERMINAL_INPUT', `Выполнение инструкции ядра: "${command}"`);

    // Сравнительный языковой маппинг
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
        const targetUser = parts[1];
        const code = parts[2];
        if (!targetUser || !code) return saveLog('SYSTEM', '❌ Синтаксис: guard [логин] [код]');
        if (guardCallbacks[targetUser]) {
            saveLog(targetUser, `Инжектирование токена 2FA: [${code}]`);
            guardCallbacks[targetUser](code);
            res.json({ success: true });
        } else {
            saveLog('SYSTEM', `❌ Ошибка: В стеке нет запросов Guard для "${targetUser}".`);
            res.json({ success: false });
        }
    } else if (op === 'help') {
        saveLog('SYSTEM', 'Полная карта команд терминала (Full Command Map):\n' +
                          '• "help / помощь" - Показать этот список команд.\n' +
                          '• "guard / код [user] [code]" - Передать токен 2FA в сессию бота.\n' +
                          '• "status / статус" - Оценить количество активных клиентов в ОЗУ.\n' +
                          '• "accounts / аккаунты" - Вывести детальную сетку аккаунтов из БД.\n' +
                          '• "db / бд" - Проверить файловый размер и провести чистку/оптимизацию базы.\n' +
                          '• "balance / баланс [user] [сумма]" - Принудительно установить баланс боту в БД.\n' +
                          '• "farm / фарм [user] [on/off]" - Включить или полностью отключить накрутку часов бота.\n' +
                          '• "games / игры [user] [AppID1,AppID2...]" - Сменить сетку бустящихся AppID игр.\n' +
                          '• "evolve / эволюция" - Запустить принудительную ИИ-мутацию налоговых шлюзов.\n' +
                          '• "delete / удалить [user]" - Удалить аккаунт и сбросить его сессию из репозитория.\n' +
                          '• "clear / сброс" - Полностью очистить журнал системных логов в базе данных.');
        res.json({ success: true });
    } else if (op === 'status') {
        saveLog('SYSTEM', `[МОНИТОРИНГ]: Активных фоновых процессов ботов в ОЗУ сервера: ${Object.keys(activeClients).length}`);
        res.json({ success: true });
    } else if (op === 'accounts') {
        db.all(`SELECT username, balance, status, boosted_hours FROM accounts`, [], (err, rows) => {
            if (err || !rows) return saveLog('SYSTEM', 'Ошибка чтения таблицы аккаунтов.');
            let msg = "\n=== РЕПОЗИТОРИЙ АКТИВНЫХ БОТОВ ===\n";
            rows.forEach(r => { msg += `• [${r.username}] СТАТУС: ${r.status} | БАЛАНС: $${r.balance.toFixed(2)} | БУСТ: ${r.boosted_hours} ч.\n`; });
            saveLog('SYSTEM', msg);
        });
        res.json({ success: true });
    } else if (op === 'db') {
        db.run("VACUUM;", [], (err) => {
            if (err) saveLog('SYSTEM', `Ошибка оптимизации: ${err.message}`);
            else saveLog('SYSTEM', `[БД УСПЕХ]: Выполнена команда VACUUM. Структура SQLite оптимизирована, кэш очищен.`);
        });
        res.json({ success: true });
    } else if (op === 'balance') {
        const user = parts[1]; const amt = parseFloat(parts[2]);
        if(!user || isNaN(amt)) return saveLog('SYSTEM', '❌ Ошибка синтаксиса. Правильно: balance [user] [сумма]');
        db.run(`UPDATE accounts SET balance = ? WHERE username = ?`, [amt, user], () => {
            saveLog('SYSTEM', `[УСТАНОВКА]: Баланс аккаунта ${user} изменен на $${amt.toFixed(2)}`);
        });
        res.json({ success: true });
    } else if (op === 'delete') {
        const user = parts[1];
        if(!user) return saveLog('SYSTEM', '❌ Укажите юзера: delete [user]');
        if(activeClients[user]) {
            if(activeClients[user].farmInterval) clearInterval(activeClients[user].farmInterval);
            activeClients[user].client.logOff();
            delete activeClients[user];
        }
        db.run(`DELETE FROM accounts WHERE username = ?`, [user], () => {
            saveLog('SYSTEM', `[УДАЛЕНИЕ]: Аккаунт ${user} полностью стёрт из ветки базы данных.`);
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
            saveLog('SYSTEM', `[ФАРМ-МОД]: Статус буста часов для ${user} переключен в: ${state ? 'ON' : 'OFF'}`);
        }
        res.json({ success: true });
    } else if (op === 'games') {
        const user = parts[1]; const list = parts[2];
        if(!user || !list) return saveLog('SYSTEM', '❌ Синтаксис: games [user] [730,440,570]');
        db.run(`UPDATE accounts SET active_apps = ? WHERE username = ?`, [list, user], () => {
            saveLog('SYSTEM', `[КОНФИГУРАЦИЯ]: Для ${user} обновлен список AppID: [${list}]. Перезапустите бота для применения.`);
        });
        res.json({ success: true });
    } else if (op === 'evolve') {
        db.get(`SELECT generation FROM system_config WHERE id = 1`, [], (err, row) => {
            const next = (row ? row.generation : 1) + 1;
            db.run(`UPDATE system_config SET generation = ? WHERE id = 1`, [next], () => {
                saveLog('AI_AGENT', `Принудительная мутация из терминала. Стек переведен на Поколение ${next}.`);
            });
        });
        res.json({ success: true });
    } else if (op === 'clear') {
        db.run(`DELETE FROM logs`, [], () => {
            saveLog('SYSTEM', '======= СИСТЕМНЫЙ ЖУРНАЛ ЛОГОВ ОЧИЩЕН =======');
        });
        res.json({ success: true });
    } else {
        saveLog('SYSTEM', `❌ Команда не распознана: "${rawOp}". Наберите "help" или "помощь" для вывода всех установок.`);
        res.json({ success: false });
    }
});

// МОНОЛИТНЫЙ ВЕБ-ИНТЕРФЕЙС ДАШБОРДА
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <title>Steam Multi-Account Cloud System v4.0</title>
    <link href="https://googleapis.com" rel="stylesheet">
    <style>
        :root { --bg-deep: #030712; --bg-panel: #0b0f19; --bg-card: #131926; --steam-blue: #1078ff; --steam-cyan: #00ffcc; --green: #10b981; --red: #ef4444; }
        * { box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; margin: 0; padding: 0; }
        body { background: var(--bg-deep); color: #f3f4f6; padding: 25px; }
        .container { max-width: 1750px; margin: 0 auto; display: grid; grid-template-columns: 360px 1fr; gap: 25px; }
        .panel { background: var(--bg-panel); border: 1px solid rgba(255,255,255,0.05); border-radius: 16px; padding: 25px; display: flex; flex-direction: column; gap: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
        .panel-header { font-size: 1.1rem; font-weight: 700; color: #fff; border-bottom: 2px solid #1e293b; padding-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
        input { background: #03060f; border: 1px solid rgba(255,255,255,0.05); color: #fff; padding: 14px; border-radius: 8px; width: 100%; font-size: 0.9rem; margin-bottom: 12px; }
        input:focus { border-color: var(--steam-cyan); outline: none; }
        .btn { background: var(--steam-blue); color: #fff; padding: 14px; border: none; border-radius: 8px; font-weight: 700; cursor: pointer; text-transform: uppercase; width: 100%; font-size: 0.8rem; letter-spacing: 0.5px; }
        .btn:hover { background: #2563eb; box-shadow: 0 0 15px rgba(16,120,255,0.4); }
        .terminal { background: #02040a; padding: 20px; border-radius: 10px 10px 0 0; height: 350px; overflow-y: auto; font-family: 'JetBrains Mono', monospace; color: #38bdf8; display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; border-bottom: 1px solid #1e293b; white-space: pre-wrap; }
        .terminal-input-wrapper { display: flex; background: #010206; border-radius: 0 0 10px 10px; border: 1px solid rgba(255,255,255,0.05); border-top: none; padding: 5px; }
        .terminal-input { margin-bottom: 0; border: none; background: transparent; font-family: 'JetBrains Mono', monospace; color: var(--steam-cyan); }
        .terminal-input:focus { box-shadow: none; }
        .account-card { background: var(--bg-card); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; margin-top: 10px; border: 1px solid rgba(255,255,255,0.02); }
        .status-badge { font-size: 0.75rem; font-weight: 800; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; }
        .ONLINE { background: rgba(16,185,129,0.15); color: var(--green); }
        .OFFLINE { background: rgba(239,68,68,0.15); color: var(--red); }
        .CONNECTING { background: rgba(16,120,255,0.15); color: var(--steam-blue); }
        .neon { color: var(--steam-cyan); text-shadow: 0 0 10px rgba(0,255,204,0.3); }
        .ai-panel { background: radial-gradient(circle at top left, #0d1527, var(--bg-panel)); border: 1px solid rgba(0,255,204,0.2); }
    </style>
</head>
<body>

<div class="container">
    <aside class="panel">
        <div class="panel-header">Инжектор ПУЛА Аккаунтов</div>
        <div>
            <input type="text" id="username" placeholder="Steam Логин">
            <input type="password" id="password" placeholder="Steam Пароль">
            <input type="text" id="shared" placeholder="Shared Secret (Для авто-2FA)">
            <button class="btn" style="background: var(--green);" onclick="addAccount()">Внедрить & Запустить</button>
        </div>
        <div class="panel-header" style="border:none; margin-top:10px; padding:0;">Сетка Репозитория Ботов:</div>
        <div id="accounts-container" style="max-height: 320px; overflow-y: auto;"></div>
    </aside>

    <main style="display: flex; flex-direction: column; gap: 25px;">
        <div class="panel ai-panel">
            <div class="panel-header">
                <span>🤖 TRADING AI AGENT v9.5 [FULL OPERATIONAL MODULE]</span>
                <span class="neon" id="ui-gen">МУТАЦИЯ ЯДРА: 1</span>
            </div>
            <p style="font-style:italic; color:#94a3b8; line-height:1.6; background:#02050c; padding:15px; border-radius:8px; border-left:3px solid var(--steam-cyan);">
                "Интерактивная станция укомплектована. Добавлен полный стек команд установок для администрирования баз данных, пула ОЗУ, изменения AppID на лету и сброса кэша логов. Наберите 'помощь' или 'help' в консоли для открытия мануала."
            </p>
        </div>

        <div class="panel">
            <div class="panel-header">Глобальный Терминал Управления Сетями & Облачным Ядром</div>
            <div>
                <div class="terminal" id="terminal-box"></div>
                <div class="terminal-input-wrapper">
                    <span style="display:flex; align-items:center; padding-left:15px; color:#64748b; font-family:'JetBrains Mono', monospace; font-size:0.8rem;">$</span>
                    <input type="text" class="terminal-input" id="term-cmd" placeholder="Наберите команду на русском или английском и нажмите Enter..." onkeydown="handleTerminalCommand(event)">
                </div>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 15px;">
                <button class="btn" onclick="evolveCore()" style="width: auto; padding: 14px 30px; background: linear-gradient(90deg, #7c3aed, var(--steam-blue));">Эволюция бэкенда & Моделей</button>
                <div style="font-size: 0.9rem; color: #94a3b8;">Налог торговой площадки: <span id="ui-tax" style="color: #fff; font-weight: bold;">13.04%</span></div>
            </div>
        </div>
    </main>
</div>

<script>
    async function updateDashboard() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            document.getElementById('ui-gen').innerText = 'МУТАЦИЯ ЯДРА: ' + data.generation;
            document.getElementById('ui-tax').innerText = (data.taxRate * 100).toFixed(2) + '%';
            
            const term = document.getElementById('terminal-box');
            term.innerHTML = data.logs.map(function(log) { return '<div>' + log + '</div>'; }).join('');
            term.scrollTop = term.scrollHeight;
            
            const container = document.getElementById('accounts-container');
            container.innerHTML = data.accounts.map(function(acc) {
                return '<div class="account-card"><div><div style="font-weight:700; color:#fff;">' + acc.username + '</div><div style="font-size:0.75rem; color:#94a3b8; margin-top:2px;">Карточек: ' + (acc.farmed_cards || 0) + ' | Часов: ' + (acc.boosted_hours || 0) + '</div></div><span class="status-badge ' + acc.status + '">' + acc.status + '</span></div>';
            }).join('');
        } catch (e) {}
    }

    async function addAccount() {
        const uInput = document.getElementById('username');
        const pInput = document.getElementById('password');
        const sInput = document.getElementById('shared');
        if(!uInput.value || !pInput.value) { alert('Заполните обязательные поля!'); return; }
        
        await fetch('/api/account/add', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username: uInput.value, password: pInput.value, sharedSecret: sInput.value })
        });
        uInput.value = ''; pInput.value = ''; sInput.value = '';
        updateDashboard();
    }

    async function evolveCore() {
        await fetch('/api/evolve', { method: 'POST' });
        updateDashboard();
    }

    async function handleTerminalCommand(e) {
        if (e.key === 'Enter') {
            const inputEl = document.getElementById('term-cmd');
            const val = inputEl.value;
            if(!val.trim()) return;
            
            inputEl.value = '';
            await fetch('/api/terminal/command', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ command: val })
            });
            updateDashboard();
        }
    }

    setInterval(updateDashboard, 1500);
    window.onload = updateDashboard;
</script>
</body>
</html>
    `);
});

app.listen(PORT, () => console.log(`[TERMINAL HUB RUNNING]: Монолитный комплекс успешно развернут на порту: ${PORT}`));
