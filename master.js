// master.js
(() => {
    'use strict';

    const CFG = {
        rounds: 10,
        limitSec: 10,
        sampleCount: 100,
        penaltyScore: 0,
    };

    const byId = (id) => document.getElementById(id);
    const fmt = (n) => (Number.isFinite(n) ? n.toFixed(2) : '-');
    const clamp01 = (x) => Math.min(1, Math.max(0, x));

    let running = false;
    let round = 0;
    let cpuWord = '';
    let scores = [];
    let deadlineMs = 0;
    let timerId = null;
    let locked = false;

    const clearTimer = () => {
        if (!timerId) return;
        clearInterval(timerId);
        timerId = null;
    };

    const avgScore = () => (scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : NaN);

    const wordOk = (w) => Boolean(w) && window.Scoring.measure(w, w).ok;
    const pickRandom = () => window.Scoring.pickWords(1)[0] || '';

    const nextCpuWord = (userWord) => {
        if (!wordOk(userWord)) return pickRandom();
        let candidates = [];
        try {
            candidates = window.Scoring.pickWords(CFG.sampleCount, new Set([userWord]));
        } catch {
            return pickRandom();
        }
        return window.Scoring.farthestFrom(userWord, candidates)?.word || pickRandom();
    };

    const ui = {
        startBtn: null,
        startArea: null,
        status: null,
        round: null,
        roundTotal: null,
        cpuWord: null,
        timeLeft: null,
        userWord: null,
        submitBtn: null,
        lastScore: null,
        avgScore: null,
        log: null,
        chat: null,
        timerRing: null,
        innerPanel: null,
        ringCirc: 1,
    };

    const setHidden = (el, hidden) => {
        if (!el) return;
        el.classList.toggle('hidden', Boolean(hidden));
    };

    const setPlaying = (playing) => {
        ui.userWord.disabled = !playing;
        ui.submitBtn.disabled = !playing;
        ui.startBtn.disabled = playing;
    };

    const setStatus = (t) => {
        const text = t || '';
        ui.status.textContent = text;
        setHidden(ui.status, !text);
    };

    const log = (line) => {
        ui.log.textContent += `${line}\n`;
    };

    const initRing = () => {
        if (!ui.timerRing) return;
        const r = ui.timerRing.r.baseVal.value;
        ui.ringCirc = 2 * Math.PI * r;
        ui.timerRing.style.strokeDasharray = String(ui.ringCirc);
        ui.timerRing.style.strokeDashoffset = String(ui.ringCirc);
    };

    const setRingProgressUsed = (used01) => {
        if (!ui.timerRing) return;
        const used = clamp01(used01);
        ui.timerRing.style.strokeDashoffset = String(ui.ringCirc * (1 - used));
    };

    const appendChatCpuOnly = (cpu) => {
        if (!ui.chat) return;

        const turn = document.createElement('div');
        turn.className = 'chatTurn';

        const cpuLine = document.createElement('div');
        cpuLine.className = 'chatMsg cpu';
        cpuLine.textContent = String(cpu || '-');

        turn.append(cpuLine);
        ui.chat.append(turn);
        ui.chat.scrollTop = ui.chat.scrollHeight;
    };

    const appendChatTurn = ({ cpu, cpuScore, includeCpu, user, userScore, note }) => {
        if (!ui.chat) return;

        const turn = document.createElement('div');
        turn.className = 'chatTurn';

        const userLine = document.createElement('div');
        userLine.className = 'chatMsg user';
        userLine.textContent = `${user} (score = ${fmt(userScore)})`;

        turn.append(userLine);

        if (includeCpu) {
            const cpuLine = document.createElement('div');
            cpuLine.className = 'chatMsg cpu';
            cpuLine.textContent = `${cpu} (score = ${fmt(cpuScore)})`;
            turn.append(cpuLine);
        }

        if (note) {
            const noteEl = document.createElement('div');
            noteEl.className = 'chatNote';
            noteEl.textContent = note;
            turn.append(noteEl);
        }

        ui.chat.append(turn);
        ui.chat.scrollTop = ui.chat.scrollHeight;
    };

    const updateTime = () => {
        const now = Date.now();
        const msLeft = Math.max(0, deadlineMs - now);
        const secLeft = Math.max(0, Math.ceil(msLeft / 1000));
        ui.timeLeft.textContent = String(secLeft);

        const used = 1 - msLeft / (CFG.limitSec * 1000);
        setRingProgressUsed(used);

        if (secLeft <= 0) submit(true);
    };

    const endGame = () => {
        running = false;
        clearTimer();
        setPlaying(false);
        setRingProgressUsed(1);
        setStatus(`ゲーム終了: 平均スコア ${fmt(avgScore())}`);
        log(`--- END (avg=${fmt(avgScore())}) ---`);
    };

    const startRound = () => {
        round += 1;
        locked = false;

        ui.round.textContent = String(round);
        ui.cpuWord.textContent = cpuWord || '-';
        ui.userWord.value = '';
        ui.timeLeft.textContent = String(CFG.limitSec);
        setRingProgressUsed(0);
        setStatus('');
        setPlaying(true);

        deadlineMs = Date.now() + CFG.limitSec * 1000;
        clearTimer();
        timerId = setInterval(updateTime, 100);
        updateTime();
        ui.userWord.focus();
    };

    const submit = (timedOut) => {
        if (!running || locked) return;
        locked = true;

        clearTimer();
        setPlaying(false);

        const cpuShown = cpuWord;
        const userWord = ui.userWord.value.trim();
        let score = 0;
        let note = '';

        if (timedOut || !userWord) {
            note = 'timeout';
        } else if (!wordOk(cpuShown)) {
            note = 'cpu word missing';
        } else if (!wordOk(userWord)) {
            note = 'unknown user word';
        } else {
            const m = window.Scoring.score(cpuShown, userWord);
            if (m.ok && Number.isFinite(m.score)) score = m.score;
            else note = 'score error';
        }

        scores.push(score);
        ui.lastScore.textContent = fmt(score);
        ui.avgScore.textContent = fmt(avgScore());

        const userShown = timedOut || !userWord ? '(no answer)' : userWord;
        const extra = note ? ` (${note})` : '';
        log(`#${round} CPU=${cpuShown} USER=${userShown} score=${fmt(score)}${extra}`);

        let cpuReply = '';
        let cpuScore = 0;
        const includeCpu = round < CFG.rounds;
        if (includeCpu) {
            cpuReply = nextCpuWord(userWord);
            if (!timedOut && userWord && wordOk(userWord) && wordOk(cpuReply)) {
                const m = window.Scoring.score(userWord, cpuReply);
                if (m.ok && Number.isFinite(m.score)) cpuScore = m.score;
                else cpuScore = 0;
            } else {
                cpuScore = 0;
            }
        }

        appendChatTurn({
            cpu: cpuReply || '-',
            cpuScore,
            includeCpu,
            user: userShown,
            userScore: score,
            note: note ? (note === 'timeout' ? '時間切れ' : note) : '',
        });

        if (round >= CFG.rounds) return endGame();
        cpuWord = cpuReply;
        startRound();
    };

    const startGame = async () => {
        if (running) return;

        ui.log.textContent = '';
        ui.chat.textContent = '';
        ui.round.textContent = '-';
        ui.cpuWord.textContent = '-';
        ui.timeLeft.textContent = '-';
        ui.lastScore.textContent = '-';
        ui.avgScore.textContent = '-';
        setRingProgressUsed(0);

        setPlaying(false);
        ui.startBtn.disabled = true;
        setStatus('データ読み込み中...');

        try {
            await window.Scoring.ensureReady();
        } catch (err) {
            console.error(err);
            setStatus('読み込みに失敗しました。ローカルサーバーで開いてください。');
            log(String(err));
            ui.startBtn.disabled = false;
            setHidden(ui.startBtn, false);
            return;
        }
        if (!window.Scoring.getWordToPick().length) {
            setStatus('word_to_pick が空です');
            ui.startBtn.disabled = false;
            setHidden(ui.startBtn, false);
            return;
        }

        // After dictionary load: hide Start button and show inner controls.
        setHidden(ui.startBtn, true);
        setHidden(ui.innerPanel, false);

        running = true;
        round = 0;
        scores = [];
        cpuWord = pickRandom();

        log('--- START ---');
        appendChatCpuOnly(cpuWord);
        startRound();
    };

    window.addEventListener('DOMContentLoaded', () => {
        Object.assign(ui, {
            startBtn: byId('startBtn'),
            startArea: byId('startArea'),
            status: byId('status'),
            round: byId('round'),
            roundTotal: byId('roundTotal'),
            cpuWord: byId('cpuWord'),
            timeLeft: byId('timeLeft'),
            userWord: byId('userWord'),
            submitBtn: byId('submitBtn'),
            lastScore: byId('lastScore'),
            avgScore: byId('avgScore'),
            log: byId('log'),
            chat: byId('chat'),
            timerRing: byId('timerRing'),
            innerPanel: byId('innerPanel'),
        });

        // Match title width to how-to box width (kept stable by the sizer).
        const titleBox = byId('titleBox');
        const howtoBox = byId('howtoBox');
        const howtoSizer = byId('howtoSizer');
        const howtoDetails = document.querySelector('details.howto');
        const syncHeaderWidths = () => {
            if (!titleBox || !howtoBox || !howtoSizer) return;

            // Lock width based on the designated sizer line so it won't change on toggle.
            const sizerW = howtoSizer.getBoundingClientRect().width;
            const cs = window.getComputedStyle(howtoBox);
            const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            const boxW = Math.ceil(sizerW + pad);

            if (Number.isFinite(boxW) && boxW > 0) {
                howtoBox.style.width = `${boxW}px`;
                titleBox.style.width = `${boxW}px`;
            }
        };
        syncHeaderWidths();
        window.addEventListener('resize', syncHeaderWidths);
        howtoDetails?.addEventListener('toggle', () => requestAnimationFrame(syncHeaderWidths));

        ui.roundTotal.textContent = String(CFG.rounds);
        initRing();

        ui.startBtn.addEventListener('click', startGame);
        ui.submitBtn.addEventListener('click', () => submit(false));
        ui.userWord.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit(false);
        });

        // Initial state: show Start button in ring; hide inner controls.
        setHidden(ui.startBtn, false);
        setHidden(ui.innerPanel, true);
        setPlaying(false);
        setStatus('Start を押してください');
    });
})();
