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
    {"id": "world", "name": "海外の新商品", "feeds": [
        {"q": "gin distillery new release", "lang": "en"},
        {"q": "new gin launch brand",       "lang": "en"},
    ]},
    {"id": "japan", "name": "日本のクラフトジン", "feeds": [
        {"q": "クラフトジン",          "lang": "ja"},
        {"q": "ジン 蒸留所 新発売",    "lang": "ja"},
    ]},
    {"id": "trend", "name": "バー・業界トレンド", "feeds": [
        {"q": "gin cocktail bar trend", "lang": "en"},
        {"q": "ジン カクテル バー",      "lang": "ja"},
    ]},
    {"id": "award", "name": "受賞・コンペ", "feeds": [
        {"q": "gin awards winner", "lang": "en"},
        {"q": "World Gin Awards",  "lang": "en"},
    ]},
]

MAX_PER_FEED = 20            # 1検索あたりの最大取得件数
UA = "Mozilla/5.0 (compatible; GinNewsBot/1.0)"  # アクセス時の名乗り
_translation_cache = {}      # 翻訳結果の使い回し


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

    # 重複（同じタイトル）を除去
    seen = set()
    unique = []
    for a in collected:
        key = a["title"].strip()
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
    for cat in CATEGORIES:
        print(f"取得中: {cat['name']} …", file=sys.stderr)
        result["categories"][cat["id"]] = build_category(cat)
        print(f"  → {len(result['categories'][cat['id']])}件", file=sys.stderr)

    with open("news.json", "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)

    total = sum(len(v) for v in result["categories"].values())
    print(f"完了: 合計 {total}件を news.json に保存しました", file=sys.stderr)


if __name__ == "__main__":
    main()
