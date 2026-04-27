import json
import unicodedata

import MeCab
from gensim.models import KeyedVectors


def has_bad_char(s: str) -> bool:
    for ch in s:
        if ch.isdigit():
            return True
        if "A" <= ch <= "z":
            return True
        cat0 = unicodedata.category(ch)[0]
        if cat0 in ("P", "S"):
            return True
    return False


def is_single_hiragana(s: str) -> bool:
    if len(s) != 1:
        return False
    o = ord(s)
    return 0x3041 <= o <= 0x3096


def main() -> None:
    tagger = MeCab.Tagger()

    model_path = "./model/entity_vector.model.bin"
    model = KeyedVectors.load_word2vec_format(model_path, binary=True)

    words = model.index_to_key[:300000]

    vectors_parts: list[dict[str, list[float]]] = [{}, {}, {}]
    seen: set[str] = set()
    word_to_pick: list[str] = []
    vec_count = 0
    print("pick words")
    for w in words:
        key = w
        if key.startswith("[") and key.endswith("]"):
            key = key[1:-1]
        if key in seen:
            continue
        if is_single_hiragana(key):
            continue
        if has_bad_char(key):
            continue

        parsed = tagger.parse(w).splitlines()
        if not parsed or parsed[0] == "EOS":
            continue

        found_noun = False
        for elem in parsed:
            if elem == "EOS":
                break
            tmp = elem.split("\t")
            if len(tmp) < 2:
                continue
            elem_info = tmp[1].split(",")
            if elem_info and elem_info[0] == "名詞":
                found_noun = True
                break

        if not found_noun:
            continue

        vec = [round(float(v), 5) for v in model[w].tolist()]
        vectors_parts[vec_count % 3][key] = vec
        seen.add(key)
        vec_count += 1

        if 3 <= len(key) <= 8:
            word_to_pick.append(key)
    print("json dump")
    for i, part in enumerate(vectors_parts):
        with open(f"./json/vectors_{i}.json", "w", encoding="utf-8") as f:
            json.dump(part, f, ensure_ascii=False, separators=(",", ":"))

    with open("./json/word_to_pick.json", "w", encoding="utf-8") as f:
        json.dump(word_to_pick, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
