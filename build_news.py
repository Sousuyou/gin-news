#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ジン最新ニュースの製造スクリプト
--------------------------------
GoogleニュースのRSSから記事を取得し、英語タイトルを日本語に翻訳して
news.json を出力する。GitHubの自動機能（Actions）から定期的に実行される。
サーバー側で動くため、中継サービス（CORSプロキシ）は一切不要。
標準ライブラリだけで動く（追加インストール不要）。
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

# =========================================================
# カテゴリ設定（検索ワードを変えれば集まるニュースが変わる）
#   q   : Googleニュースの検索キーワード
#   lang: ja=日本語/日本、en=英語/アメリカ
# =========================================================
CATEGORIES = [
    {"id": "overseas", "name": "海外記事", "feeds": [
        {"q": '"new gin" launch OR release', "lang": "en"},
        {"q": "craft gin distillery bottling", "lang": "en"},
        {"q": '"gin awards" winner OR gold', "lang": "en"},
        {"q": "gin cocktail bar trend", "lang": "en"},
        {"q": "gin new expression flavour", "lang": "en"},
    ]},
    {"id": "japan", "name": "日本のクラフトジン", "feeds": [
        {"q": "クラフトジン",          "lang": "ja"},
        {"q": "ジン 蒸留所 新発売",    "lang": "ja"},
        {"q": "ジャパニーズジン 新商品", "lang": "ja"},
        {"q": "ジン 受賞 金賞",        "lang": "ja"},
    ]},
    {"id": "newdistillery", "name": "新蒸留所/オープン", "feeds": [
        {"q": "new gin distillery opens", "lang": "en"},
        {"q": "ジン 蒸留所 オープン OR 新設", "lang": "ja"},
    ]},
    {"id": "event", "name": "イベント・限定品", "feeds": [
        {"q": "gin limited edition release", "lang": "en"},
        {"q": "ジン 限定 数量",        "lang": "ja"},
        {"q": "クラフトジン フェア OR イベント OR フェス", "lang": "ja"},
    ]},
]

MAX_PER_FEED = 20            # 1検索あたりの最大取得件数
UA = "Mozilla/5.0 (compatible; GinNewsBot/1.0)"  # アクセス時の名乗り
_translation_cache = {}      # 翻訳結果の使い回し

# 主要なジンのブランド名（タイトルに「gin」が無くても、これを含めばジン記事として採用）
GIN_BRANDS = [
    "hendrick", "tanqueray", "beefeater", "bombay", "four pillars", "monkey 47",
    "botanist", "roku", "sipsmith", "plymouth", "gordon", "aviation", "citadelle",
    "gin mare", "brockmans", "empress", "ki no bi", "kinobi", "nikka coffey",
    "sakurao", "drumshanbo", "gunpowder", "malfy", "hayman", "opihr",
    "whitley neill", "st. george", "st george", "桜尾", "季の美",
]
_RE_GIN_EN = re.compile(r"\bgins?\b", re.I)
# 「ジン」が酒以外（ゲーム・アニメ・人名・時計ブランド等）を指す記事を除外するブロックリスト
_RE_NOISE = re.compile(
    r"原神|攻略|ガチャ|声優|コスプレ|VTuber|フィギュア|同人|アニメ|genshin"
    r"|腕時計|ウォッチ|クロノグラフ|Spezialuhren",  # 時計ブランド「Sinn(ジン)」等のすり抜け対策
    re.I,
)


def is_gin_relevant(text):
    """タイトルがジン関連か判定（他スピリッツ・ゲーム/人名等のノイズを除外）。"""
    if _RE_NOISE.search(text):                        # 酒以外の「ジン」を除外
        return False
    low = text.lower()
    if any(b in low for b in GIN_BRANDS):
        return True
    if _RE_GIN_EN.search(text):                       # 英語：gin/gins を独立語で含む
        return True
    if "ジン" in text and "ジンジャー" not in text and "エンジン" not in text:  # 日本語
        return True
    return False


def norm_title(t):
    """重複判定用にタイトルを正規化（空白・記号のゆれを吸収）。"""
    t = re.sub(r"[\s　]+", "", t)
    t = re.sub(r"[「」『』【】（）()\"'’‘“”!！?？・,，.。\-—–~〜]", "", t)
    return t.lower()


def http_get(url, timeout=25):
    """指定URLの中身を文字列で取得する"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read().decode("utf-8", errors="replace")


def google_news_url(q, lang):
    """GoogleニュースのRSS URLを組み立てる"""
    base = "https://news.google.com/rss/search?q=" + urllib.parse.quote(q)
    if lang == "ja":
        return base + "&hl=ja&gl=JP&ceid=JP:ja"
    return base + "&hl=en-US&gl=US&ceid=US:en"


def has_japanese(s):
    """日本語が含まれているか（含まれていれば翻訳不要）"""
    return bool(re.search(r"[぀-ヿ㐀-鿿]", s))


def translate_to_ja(text):
    """英語の文字列を日本語に翻訳する（失敗したら None）"""
    if text in _translation_cache:
        return _translation_cache[text]
    api = ("https://translate.googleapis.com/translate_a/single"
           "?client=gtx&sl=auto&tl=ja&dt=t&q=" + urllib.parse.quote(text))
    for attempt in range(2):  # 失敗したら一度だけ再試行
        try:
            raw = http_get(api, timeout=15)
            data = json.loads(raw)
            ja = "".join(seg[0] for seg in data[0] if seg and seg[0])
            if ja:
                _translation_cache[text] = ja
                return ja
        except Exception:
            time.sleep(1)
    return None


def parse_feed(xml_text, cat_name):
    """RSSのXMLを記事リストに変換する"""
    articles = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return articles
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        # 発信元の取得（<source>優先、無ければ「タイトル - 発信元」から分離）
        source_el = item.find("source")
        source = (source_el.text or "").strip() if source_el is not None else ""
        clean_title = title
        if " - " in title:
            head, tail = title.rsplit(" - ", 1)
            if not source:
                source = tail
            clean_title = head
        # 日付
        date_iso = None
        pub = item.findtext("pubDate")
        if pub:
            try:
                date_iso = parsedate_to_datetime(pub).astimezone(timezone.utc).isoformat()
            except Exception:
                date_iso = None
        articles.append({
            "title": clean_title,
            "originalTitle": None,
            "link": link,
            "source": source or "ニュース",
            "date": date_iso,
        })
    return articles


def build_category(cat):
    """1カテゴリ分のニュースを取得・翻訳・整理する"""
    collected = []
    for feed in cat["feeds"]:
        try:
            xml_text = http_get(google_news_url(feed["q"], feed["lang"]))
        except Exception as e:
            print(f"  取得失敗 [{feed['q']}]: {e}", file=sys.stderr)
            continue
        items = parse_feed(xml_text, cat["name"])[:MAX_PER_FEED]
        collected.extend(items)

    # ノイズ除去（ジンに無関係な他スピリッツ等の記事を除外）
    collected = [a for a in collected if is_gin_relevant(a["title"])]

    # 重複除去（タイトルを正規化し、表記ゆれも吸収）
    seen = set()
    unique = []
    for a in collected:
        key = norm_title(a["title"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(a)

    # 英語タイトルを日本語に翻訳
    for a in unique:
        if not has_japanese(a["title"]):
            ja = translate_to_ja(a["title"])
            if ja and ja != a["title"]:
                a["originalTitle"] = a["title"]  # 原題を残す
                a["title"] = ja

    # 新しい順に並べ替え（日付なしは後ろ）
    unique.sort(key=lambda a: a["date"] or "", reverse=True)
    return unique


def main():
    result = {
        "updated": datetime.now(timezone.utc).isoformat(),
        "categories": {},
    }
    global_seen = set()  # カテゴリ横断の重複除去用
    for cat in CATEGORIES:
        print(f"取得中: {cat['name']} …", file=sys.stderr)
        arts = build_category(cat)
        # 既に他カテゴリで出た記事は落とす（先に出たカテゴリを優先）
        kept = []
        for a in arts:
            k = norm_title(a["title"])
            if k in global_seen:
                continue
            global_seen.add(k)
            kept.append(a)
        result["categories"][cat["id"]] = kept
        print(f"  → {len(kept)}件", file=sys.stderr)

    with open("news.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    total = sum(len(v) for v in result["categories"].values())
    print(f"完了: 合計 {total}件を news.json に保存しました", file=sys.stderr)


if __name__ == "__main__":
    main()
