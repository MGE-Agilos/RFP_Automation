"""Parse .msg email files and extract public market links with metadata."""

import re
import base64
from pathlib import Path

import extract_msg


# Redirect link pattern in comgouv.lu newsletters
_REDIRECT_RE = re.compile(
    r"http[s]?://links\.comgouv\.lu/lnk/[^\s<>\"')]+",
    re.IGNORECASE,
)

# Market entry pattern in the email body:
# <Title> (URL)
# Service : Authority · Date limite : DD/MM/YYYY · Publié : DD/MM/YYYY
_ENTRY_RE = re.compile(
    r"([\w\s\d\'\-\,\.\(\)\/À-ÿ:]+?)\s*"      # title
    r"<(http[^\s>]+)>\s*\n"                      # url in angle brackets
    r"Service\s*:\s*([^\n·]+?)(?:\s*·|\s*$)"    # authority
    r".*?Date limite\s*:\s*(\d{2}/\d{2}/\d{4})"  # deadline
    r".*?Publié\s*:\s*(\d{2}/\d{2}/\d{4})",     # published
    re.DOTALL | re.IGNORECASE,
)

# Section headers in the email body
_SECTION_RE = re.compile(
    r"^(Travaux|Services|Fournitures)\s*$",
    re.MULTILINE | re.IGNORECASE,
)


def _decode_redirect_url(redirect_url: str) -> str:
    """Extract the real target URL from a comgouv.lu redirect link."""
    # Strip tracking suffix ?b=N
    url = redirect_url.split("?")[0] if "?" in redirect_url else redirect_url
    # The last path segment is base64-encoded target URL
    segment = url.rstrip("/").rsplit("/", 1)[-1]
    # Add padding
    pad = 4 - len(segment) % 4
    if pad != 4:
        segment += "=" * pad
    try:
        decoded = base64.b64decode(segment).decode("utf-8")
        if decoded.startswith("http"):
            return decoded
    except Exception:
        pass
    return redirect_url


def _detect_category(text_before: str) -> str:
    """Return the market category based on the section header preceding the entry."""
    for match in _SECTION_RE.finditer(text_before):
        last = match.group(1)
    try:
        return last.capitalize()
    except UnboundLocalError:
        return "Services"


def parse_msg_file(filepath: str | Path) -> dict:
    """
    Parse a .msg email file.

    Returns:
        {
            "subject": str,
            "markets": [
                {
                    "title": str,
                    "original_url": str,
                    "resolved_url": str,
                    "category": str,
                    "deadline": str,
                    "published_date": str,
                    "contracting_authority": str,
                }
            ]
        }
    """
    filepath = str(filepath)
    msg = extract_msg.Message(filepath)
    body: str = msg.body or ""

    subject = msg.subject or ""

    markets = []

    # --- Strategy 1: structured regex on the plain-text body ---
    # Find all redirect URLs grouped with their surrounding text
    all_redirect_urls = _REDIRECT_RE.findall(body)

    # Split body into lines for structured parsing
    lines = body.splitlines()
    current_category = "Services"
    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # Detect section headers
        if _SECTION_RE.match(line):
            current_category = line.capitalize()
            i += 1
            continue

        # Look for a title + URL on consecutive lines
        # Pattern: title line ends with a redirect URL in angle brackets
        url_match = re.search(r"<(http[s]?://links\.comgouv\.lu[^\s<>]+)>", line)
        if url_match:
            # The title is everything before the URL on this line
            title = line[: url_match.start()].strip()
            if not title and i > 0:
                title = lines[i - 1].strip()
            title = re.sub(r"<[^>]+>", "", title).strip()

            original_url = url_match.group(1).split("?")[0]  # strip ?b=N
            resolved_url = _decode_redirect_url(original_url)

            # Look ahead for Service / Date limite line
            authority = ""
            deadline = ""
            published = ""
            for j in range(i + 1, min(i + 4, len(lines))):
                meta = lines[j]
                if "Service" in meta:
                    m = re.search(r"Service\s*:\s*(.+?)(?:\s*·|$)", meta)
                    if m:
                        authority = m.group(1).strip()
                if "Date limite" in meta:
                    m = re.search(r"Date limite\s*:\s*(\d{2}/\d{2}/\d{4})", meta)
                    if m:
                        deadline = m.group(1)
                if "Publié" in meta:
                    m = re.search(r"Publié\s*:\s*(\d{2}/\d{2}/\d{4})", meta)
                    if m:
                        published = m.group(1)

            if title and resolved_url:
                markets.append(
                    {
                        "title": title,
                        "original_url": original_url,
                        "resolved_url": resolved_url,
                        "category": current_category,
                        "deadline": deadline,
                        "published_date": published,
                        "contracting_authority": authority,
                    }
                )
        i += 1

    # --- Strategy 2: fallback — just collect all redirect URLs ---
    if not markets:
        for url in all_redirect_urls:
            original = url.split("?")[0]
            resolved = _decode_redirect_url(original)
            # Skip the main portal homepage link
            if "marches.public.lu" in resolved and "id=" not in resolved:
                continue
            markets.append(
                {
                    "title": "Marché public (détails à scraper)",
                    "original_url": original,
                    "resolved_url": resolved,
                    "category": "Services",
                    "deadline": "",
                    "published_date": "",
                    "contracting_authority": "",
                }
            )

    # Deduplicate by resolved_url
    seen = set()
    unique = []
    for m in markets:
        key = m["resolved_url"]
        if key not in seen and "id=" in key:
            seen.add(key)
            unique.append(m)

    return {"subject": subject, "markets": unique}
