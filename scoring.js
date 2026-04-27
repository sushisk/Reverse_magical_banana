// scoring.js
(() => {
    'use strict';

    const state = {
        vectors: null, // legacy single-file mode
        vectorsParts: null, // [obj, obj, obj] for split files
        wordToPick: [],
        scoreCdf: null,
        ready: false,
        readyPromise: null,
    };

    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

    const CACHE_DB = 'reverse_magical_banana_cache';
    const CACHE_STORE = 'kv';
    const CACHE_VERSION = 1;

    function makeXorshift32(seed) {
        let x = seed | 0;
        return () => {
            x |= 0;
            x ^= x << 13;
            x ^= x >>> 17;
            x ^= x << 5;
            return (x >>> 0) / 4294967296;
        };
    }

    function openCacheDb() {
        if (!('indexedDB' in window)) return Promise.resolve(null);
        return new Promise((resolve) => {
            const req = indexedDB.open(CACHE_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
        });
    }

    function idbGet(db, key) {
        return new Promise((resolve) => {
            const tx = db.transaction(CACHE_STORE, 'readonly');
            const store = tx.objectStore(CACHE_STORE);
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
        });
    }

    function idbSet(db, key, value) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CACHE_STORE, 'readwrite');
            const store = tx.objectStore(CACHE_STORE);
            const req = store.put(value, key);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error || new Error('idb put failed'));
        });
    }

    async function loadVectorsFromCache() {
        const db = await openCacheDb();
        if (!db) return null;
        try {
            const meta = await idbGet(db, 'meta');
            if (!meta || meta.version !== CACHE_VERSION) return null;

            const [v0, v1, v2, wordToPick] = await Promise.all([
                idbGet(db, 'vectors_0'),
                idbGet(db, 'vectors_1'),
                idbGet(db, 'vectors_2'),
                idbGet(db, 'word_to_pick'),
            ]);

            if (!v0 || !v1 || !v2) return null;
            if (!Array.isArray(wordToPick)) return null;
            return { v0, v1, v2, wordToPick };
        } finally {
            db.close();
        }
    }

    async function saveVectorsToCache({ v0, v1, v2, wordToPick }) {
        const db = await openCacheDb();
        if (!db) return;
        try {
            await idbSet(db, 'meta', { version: CACHE_VERSION, savedAt: Date.now() });
            await idbSet(db, 'vectors_0', v0);
            await idbSet(db, 'vectors_1', v1);
            await idbSet(db, 'vectors_2', v2);
            await idbSet(db, 'word_to_pick', wordToPick);
        } catch {
            // Best-effort cache. Quota errors are ignored.
        } finally {
            db.close();
        }
    }

    async function fetchJson(path) {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) {
            throw new Error(`Failed to load ${path} (HTTP ${res.status})`);
        }
        return res.json();
    }

    async function ensureReady() {
        if (state.ready) return;
        if (!state.readyPromise) {
            state.readyPromise = (async () => {
                const cached = await loadVectorsFromCache();
                if (cached) {
                    state.vectors = null;
                    state.vectorsParts = [cached.v0, cached.v1, cached.v2];
                    state.wordToPick = cached.wordToPick;
                } else {
                try {
                    const [v0, v1, v2, wordToPick] = await Promise.all([
                        fetchJson('./json/vectors_0.json'),
                        fetchJson('./json/vectors_1.json'),
                        fetchJson('./json/vectors_2.json'),
                        fetchJson('./json/word_to_pick.json'),
                    ]);
                    state.vectors = null;
                    state.vectorsParts = [v0, v1, v2];
                    state.wordToPick = Array.isArray(wordToPick) ? wordToPick : [];
                    queueMicrotask(() => {
                        void saveVectorsToCache({ v0, v1, v2, wordToPick: state.wordToPick });
                    });
                } catch {
                    // Backward compatibility: allow single-file vectors.json.
                    const [vAll, wordToPick] = await Promise.all([
                        fetchJson('./json/vectors.json'),
                        fetchJson('./json/word_to_pick.json'),
                    ]);
                    state.vectors = vAll;
                    state.vectorsParts = null;
                    state.wordToPick = Array.isArray(wordToPick) ? wordToPick : [];
                }
                }

                // Filter to words that actually exist in the loaded vectors.
                state.wordToPick = state.wordToPick.filter((w) => Boolean(getVec(w)));

                // Build a deterministic global distance CDF for score normalization.
                // Raw cosine-distance tends to cluster; mapping to a percentile gives more readable scores.
                const list = state.wordToPick;
                const n = list.length;
                const pairs = Math.min(4000, Math.max(0, n * 2));
                if (n >= 2 && pairs >= 200) {
                    const rng = makeXorshift32(0x6d626e61); // "mbna"
                    const dists = [];
                    for (let k = 0; k < pairs; k++) {
                        const i = Math.floor(rng() * n);
                        let j = Math.floor(rng() * n);
                        if (j === i) j = (j + 1) % n;
                        const a = list[i];
                        const b = list[j];
                        const m = measure(a, b);
                        if (m.ok && Number.isFinite(m.distance)) dists.push(m.distance);
                    }
                    dists.sort((a, b) => a - b);
                    state.scoreCdf = dists.length ? dists : null;
                } else {
                    state.scoreCdf = null;
                }

                state.ready = true;
            })();
        }
        return state.readyPromise;
    }

    function getVec(word) {
        const parts = state.vectorsParts;
        if (parts) {
            for (const p of parts) {
                const v = p[word];
                if (Array.isArray(v)) return v;
            }
            return null;
        }
        const all = state.vectors;
        if (!all) return null;
        const v = all[word];
        return Array.isArray(v) ? v : null;
    }

    // Returns: { ok, distance, cosine, reason }
    function measure(wordA, wordB) {
        if (!state.vectors && !state.vectorsParts) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'not_ready' };
        }
        const vecA = getVec(wordA);
        if (!vecA) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'missing_a' };
        }
        const vecB = getVec(wordB);
        if (!vecB) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'missing_b' };
        }
        if (vecA.length !== vecB.length) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'dim_mismatch' };
        }

        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = vecA[i];
            const b = vecB[i];
            dot += a * b;
            normA += a * a;
            normB += b * b;
        }
        const magA = Math.sqrt(normA);
        const magB = Math.sqrt(normB);
        const cosineRaw = (magA === 0 || magB === 0) ? 0 : dot / (magA * magB);
        const cosine = clamp(cosineRaw, -1, 1);
        const distance = (1 - cosine) * 100;
        return { ok: true, distance, cosine, reason: '' };
    }

    function scoreFromDistance(distance) {
        const cdf = state.scoreCdf;
        if (!cdf || !Number.isFinite(distance)) return distance;

        let lo = 0;
        let hi = cdf.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cdf[mid] <= distance) lo = mid + 1;
            else hi = mid;
        }
        const percentile = lo / cdf.length;
        return percentile * 100;
    }

    // Score: 0..100 (percentile of global distance distribution).
    function score(wordA, wordB) {
        const m = measure(wordA, wordB);
        if (!m.ok) return { ok: false, score: NaN, distance: NaN, cosine: NaN, reason: m.reason };
        const s = scoreFromDistance(m.distance);
        return { ok: true, score: s, distance: m.distance, cosine: m.cosine, reason: '' };
    }

    function getWordToPick() {
        return state.wordToPick.slice();
    }

    function normalizeExclude(exclude) {
        if (!exclude) return null;
        if (exclude instanceof Set) return exclude;
        if (Array.isArray(exclude)) return new Set(exclude);
        return null;
    }

    function pickWords(count, exclude) {
        const list = state.wordToPick;
        if (!list.length) return [];

        const target = Math.min(Math.max(0, count | 0), list.length);
        const excludeSet = normalizeExclude(exclude);
        const picked = new Set();
        let guard = 0;
        while (picked.size < target && guard < target * 100) {
            guard++;
            const w = list[Math.floor(Math.random() * list.length)];
            if (excludeSet && excludeSet.has(w)) continue;
            if (picked.has(w)) continue;
            picked.add(w);
        }

        if (picked.size === 0 && target > 0) {
            throw new Error('pickWords failed: no candidates available (exclude may cover all words)');
        }
        return Array.from(picked);
    }

    function farthestFrom(userWord, candidates) {
        if (!measure(userWord, userWord).ok) return null;
        if (!Array.isArray(candidates) || !candidates.length) return null;

        let bestWord = '';
        let bestDist = -Infinity;
        for (const w of candidates) {
            const m = measure(w, userWord);
            if (!m.ok) continue;
            const d = m.distance;
            if (d > bestDist) {
                bestDist = d;
                bestWord = w;
            }
        }
        if (!bestWord) return null;
        return { word: bestWord, distance: bestDist };
    }

    window.Scoring = {
        ensureReady,
        measure,
        score,
        getWordToPick,
        pickWords,
        farthestFrom,
    };
})();
