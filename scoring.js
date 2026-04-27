// scoring.js
(() => {
    'use strict';

    const state = {
        vectors: null,
        wordToPick: [],
        scoreCdf: null,
        ready: false,
        readyPromise: null,
    };

    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

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
                let vectors = null;
                try {
                    const [v0, v1, v2, wordToPick] = await Promise.all([
                        fetchJson('./json/vectors_0.json'),
                        fetchJson('./json/vectors_1.json'),
                        fetchJson('./json/vectors_2.json'),
                        fetchJson('./json/word_to_pick.json'),
                    ]);
                    vectors = Object.assign({}, v0, v1, v2);
                    state.vectors = vectors;
                    state.wordToPick = Array.isArray(wordToPick)
                        ? wordToPick.filter((w) => Boolean(vectors[w]))
                        : [];
                } catch {
                    // Backward compatibility: allow single-file vectors.json.
                    const [vAll, wordToPick] = await Promise.all([
                        fetchJson('./json/vectors.json'),
                        fetchJson('./json/word_to_pick.json'),
                    ]);
                    vectors = vAll;
                    state.vectors = vectors;
                    state.wordToPick = Array.isArray(wordToPick)
                        ? wordToPick.filter((w) => Boolean(vectors[w]))
                        : [];
                }

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

    // 戻り値: { ok, distance, cosine, reason }
    function measure(wordA, wordB) {
        if (!state.vectors) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'not_ready' };
        }
        const vecA = state.vectors[wordA];
        if (!Array.isArray(vecA)) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'missing_a' };
        }
        const vecB = state.vectors[wordB];
        if (!Array.isArray(vecB)) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'missing_b' };
        }
        if (vecA.length !== vecB.length) {
            return { ok: false, distance: NaN, cosine: NaN, reason: 'dim_mismatch' };
        }

        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            const a = Number(vecA[i]);
            const b = Number(vecB[i]);
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
        return percentile * 200;
    }

    // Score: 0..200 (percentile of global distance distribution).
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

    // ランダムに重複なしで選ぶ（count=1でも配列を返す）
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
