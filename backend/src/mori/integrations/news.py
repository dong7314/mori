from datetime import UTC, datetime
from html.parser import HTMLParser
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, uuid5

from pydantic import ValidationError

from mori.errors import ApiError
from mori.integrations.models import NewsBriefing
from mori.integrations.providers import read_provider
from mori.integrations.schemas import NewsArticle


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def plain(value, limit):
    parser = PlainText()
    parser.feed(value if isinstance(value, str) else "")
    return " ".join(" ".join(parser.parts).split())[:limit]


async def fetch_articles(settings, topic, *, transport=None):
    if not settings.searxng_base_url:
        raise ApiError(503, "NEWS_NOT_CONFIGURED", "뉴스 검색 연결이 설정되지 않았습니다.")
    data = await read_provider(
        settings.searxng_base_url + "/search",
        params={"q": topic, "categories": "news", "format": "json", "language": "ko-KR"},
        transport=transport,
    )
    if not isinstance(data, dict) or not isinstance(data.get("results"), list):
        raise ApiError(502, "INVALID_NEWS_RESPONSE", "기사 목록을 확인하지 못했습니다.")
    if not data["results"] and data.get("unresponsive_engines"):
        raise ApiError(502, "NEWS_SEARCH_FAILED", "뉴스 검색 제공자의 응답을 받지 못했습니다.")
    articles, seen = [], set()
    for item in data["results"][:100]:
        if not isinstance(item, dict):
            continue
        try:
            url = item["url"]
            published = item.get("publishedDate")
            if isinstance(published, str):
                try:
                    parsed = datetime.fromisoformat(published)
                    published = parsed if parsed.tzinfo else None
                except ValueError:
                    published = None
            else:
                published = None
            article = NewsArticle(
                id=uuid5(NAMESPACE_URL, url),
                title=plain(item.get("title"), 300),
                summary=plain(item.get("content"), 2000),
                url=url,
                source=(urlsplit(url).hostname or "")[:255],
                published_at=published,
            )
        except (KeyError, TypeError, ValueError, ValidationError):
            continue
        if article.url not in seen:
            articles.append(article)
            seen.add(article.url)
        if len(articles) == 20:
            break
    return articles


def store_briefing(session, feature, articles, now=None):
    row = session.get(NewsBriefing, feature.id)
    if row is None:
        row = NewsBriefing(feature_id=feature.id, generation=0)
        session.add(row)
    row.feature_revision = feature.revision
    row.articles = [article.model_dump(mode="json") for article in articles]
    row.status = "ready"
    row.collected_at = now or datetime.now(UTC)
    row.error_code = None
    session.flush()
    return row
