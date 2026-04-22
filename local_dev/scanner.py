"""Scrape public market detail pages from the Luxembourg PMP portal."""

import re
import time
import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "fr-LU,fr;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


def _clean_text(text: str) -> str:
    """Normalize whitespace."""
    return re.sub(r"\s+", " ", text).strip()


def _follow_redirect(url: str, timeout: int = 15) -> str:
    """Follow redirect URL and return the final URL."""
    try:
        resp = SESSION.head(url, allow_redirects=True, timeout=timeout)
        return resp.url
    except Exception:
        return url


def scrape_market(url: str) -> dict:
    """
    Fetch and parse a market detail page.

    Returns a dict with:
        resolved_url, description, full_content, title (optional override)
    """
    result = {"resolved_url": url, "description": None, "full_content": None}

    # Follow redirect if it's a tracking link
    if "links.comgouv.lu" in url:
        url = _follow_redirect(url)
        result["resolved_url"] = url

    try:
        resp = SESSION.get(url, timeout=20, allow_redirects=True)
        resp.raise_for_status()
        result["resolved_url"] = resp.url
    except requests.RequestException as exc:
        result["error"] = str(exc)
        return result

    soup = BeautifulSoup(resp.text, "lxml")

    # Remove scripts/styles
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()

    # --- Luxembourg PMP portal (pmp.b2g.etat.lu) ---
    # The page renders a detail view with labeled fields
    main = soup.find("main") or soup.find(id="content") or soup.find(class_=re.compile(r"content|main", re.I))

    if main is None:
        main = soup.body or soup

    full_text = _clean_text(main.get_text(separator="\n"))

    # Try to extract a short description (first meaningful paragraph)
    description = ""
    # Look for "Objet" or "Description" field
    for label_pattern in [
        r"(?:objet|description|intitul[eé]|nature).*?[:：]\s*(.+?)(?:\n|$)",
        r"(?:short description|marché|contract).*?[:：]\s*(.+?)(?:\n|$)",
    ]:
        m = re.search(label_pattern, full_text, re.IGNORECASE)
        if m:
            description = _clean_text(m.group(1))
            break

    # Fallback: first non-trivial paragraph
    if not description:
        for p in main.find_all(["p", "div"], recursive=False):
            txt = _clean_text(p.get_text())
            if len(txt) > 80:
                description = txt[:600]
                break

    # Title override from page
    page_title = ""
    h1 = soup.find("h1")
    if h1:
        page_title = _clean_text(h1.get_text())

    result["description"] = description or full_text[:600]
    result["full_content"] = full_text[:8000]
    if page_title:
        result["page_title"] = page_title

    return result


def scrape_markets_batch(markets: list[dict]) -> list[dict]:
    """Scrape a list of markets sequentially with a small delay to be polite."""
    results = []
    for m in markets:
        url = m.get("resolved_url") or m.get("original_url", "")
        if not url:
            results.append({"error": "No URL"})
            continue
        data = scrape_market(url)
        results.append(data)
        time.sleep(1)
    return results
