#!/usr/bin/env python3
"""Build only public website files, then validate their crawl and link contracts."""

import argparse
from collections import deque
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import shutil
import tempfile
from urllib.parse import unquote, urljoin, urlsplit
from urllib.robotparser import RobotFileParser
import xml.etree.ElementTree as ET

REPO = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((Path(__file__).with_name("manifest.json")).read_text())
OUTPUT = REPO / ".output" / "website"


class Page(HTMLParser):
    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.tags = []
        self.ids = set()
        self.duplicate_ids = set()
        self.titles = []
        self.schemas = []
        self._capture = None
        self._parts = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        self.tags.append((tag, attrs))
        if "id" in attrs:
            if attrs["id"] in self.ids:
                self.duplicate_ids.add(attrs["id"])
            self.ids.add(attrs["id"])
        if tag == "title" or (
            tag == "script" and attrs.get("type") == "application/ld+json"
        ):
            self._capture = tag
            self._parts = []

    def handle_data(self, data):
        if self._capture:
            self._parts.append(data)

    def handle_endtag(self, tag):
        if tag == self._capture:
            value = "".join(self._parts).strip()
            if tag == "title":
                self.titles.append(value)
            else:
                schema = json.loads(value)
                if not isinstance(schema, dict):
                    raise ValueError("JSON-LD must be an object")
                if "@graph" in schema and (
                    not isinstance(schema["@graph"], list)
                    or not all(isinstance(n, dict) for n in schema["@graph"])
                ):
                    raise ValueError("JSON-LD graph must contain objects")
                self.schemas.append(schema)
            self._capture = None

    def attrs(self, tag):
        return [attrs for name, attrs in self.tags if name == tag]

    def meta(self, key):
        return [
            a.get("content")
            for a in self.attrs("meta")
            if a.get("name", a.get("property")) == key
        ]


def path_for(directory, url):
    path = urlsplit(url).path
    return directory / (
        unquote(path).lstrip("/") + ("index.html" if path.endswith("/") else "")
    )


def audit(directory):
    """Return findings; no network or external service is needed."""
    origin = MANIFEST["origin"]
    errors = []
    pages = {}
    canonical_urls = {origin + p["url"] for p in MANIFEST["pages"] if p["indexable"]}
    expected_urls = set()
    title_owners = {}
    description_owners = {}
    inbound = {url: set() for url in canonical_urls}
    outgoing = {url: set() for url in canonical_urls}
    external = set()
    robot = RobotFileParser()
    robot_lines = (directory / "robots.txt").read_text().splitlines()
    robot.parse(robot_lines)

    def require(condition, message):
        if not condition:
            errors.append(message)

    # This small public site has no crawl exclusions. Rejecting new exclusions also avoids
    # RobotFileParser's first-match behavior differing from Google's longest-match behavior.
    require(
        not any(re.match(r"\s*Disallow:\s*[^#\s]", line, re.I) for line in robot_lines),
        "robots: public pages and checkout noindex discovery must stay crawlable",
    )

    for entry in MANIFEST["pages"]:
        canonical = origin + entry["url"]
        for route in [entry["url"], *entry["aliases"]]:
            expected_urls.add(route)
            file = path_for(directory, route)
            if not file.is_file():
                errors.append(f"{route}: missing HTML")
                continue
            try:
                page = Page(file.read_text())
            except (ValueError, OSError) as exc:
                errors.append(f"{route}: invalid HTML/JSON-LD: {exc}")
                continue
            pages[route] = page
            require(
                len(page.titles) == 1 and bool(page.titles[0]),
                f"{route}: needs one nonempty title",
            )
            require(len(page.attrs("h1")) == 1, f"{route}: needs one H1")
            require(
                not page.duplicate_ids, f"{route}: duplicate IDs: {page.duplicate_ids}"
            )
            require(
                any(a.get("lang") for a in page.attrs("html")),
                f"{route}: missing language",
            )
            if not entry["indexable"]:
                require(
                    "noindex" in ",".join(page.meta("robots")),
                    f"{route}: checkout must be noindex",
                )
                require(
                    robot.can_fetch("Googlebot", origin + route),
                    f"{route}: robots blocks noindex discovery",
                )
                continue
            require(
                robot.can_fetch("Googlebot", origin + route),
                f"{route}: blocked by robots",
            )
            require(
                "noindex" not in ",".join(page.meta("robots")),
                f"{route}: indexable page has noindex",
            )
            require(len(page.attrs("main")) == 1, f"{route}: needs a main landmark")
            canonicals = [
                a.get("href") for a in page.attrs("link") if a.get("rel") == "canonical"
            ]
            require(
                canonicals == [canonical], f"{route}: canonical must be {canonical}"
            )
            require(
                page.meta("og:url") == [canonical],
                f"{route}: og:url must match canonical",
            )
            require(
                len(page.meta("description")) == 1
                and bool(page.meta("description")[0]),
                f"{route}: needs one description",
            )
            require(bool(page.schemas), f"{route}: missing structured data")
            if route == entry["url"]:
                for value, owners, label in [
                    (next(iter(page.titles), ""), title_owners, "title"),
                    (
                        next(iter(page.meta("description")), ""),
                        description_owners,
                        "description",
                    ),
                ]:
                    require(
                        value not in owners,
                        f"{route}: duplicate {label} with {owners.get(value)}",
                    )
                    owners[value] = route
            nodes = [
                node
                for schema in page.schemas
                for node in schema.get("@graph", [schema])
            ]
            page_nodes = [
                node for node in nodes if node.get("@id") == canonical + "#webpage"
            ]
            require(len(page_nodes) == 1, f"{route}: missing unique page entity")
            if page_nodes:
                node = page_nodes[0]
                require(
                    node.get("url") == canonical,
                    f"{route}: page entity URL differs from canonical",
                )
                require(
                    node.get("isPartOf") == {"@id": origin + "/#website"},
                    f"{route}: missing website relationship",
                )
                require(
                    node.get("about") == {"@id": origin + "/#app"},
                    f"{route}: missing app relationship",
                )
            for alias in entry["aliases"]:
                alias_file = path_for(directory, alias)
                if alias_file.exists():
                    require(
                        file.read_bytes() == alias_file.read_bytes(),
                        f"{route}: alias content differs: {alias}",
                    )

    for file in directory.rglob("*.html"):
        route = "/" + file.relative_to(directory).as_posix()
        if route.endswith("/index.html"):
            route = route.removesuffix("index.html")
        require(route in expected_urls, f"{route}: unexpected public HTML")

    sitemap = ET.parse(directory / "sitemap.xml")
    locations = [e.text for e in sitemap.findall(".//{*}loc")]
    require(len(locations) == len(set(locations)), "sitemap: duplicate URLs")
    require(
        set(locations) == canonical_urls,
        "sitemap: must contain exactly the indexable canonical URLs",
    )

    for route, page in pages.items():
        base = origin + route
        owner = next(p for p in MANIFEST["pages"] if route in [p["url"], *p["aliases"]])
        owner_url = origin + owner["url"]
        for tag, attrs in page.tags:
            values = []
            if tag in ["a", "link"] and attrs.get("href"):
                values.append(attrs["href"])
            if tag in ["img", "script"] and attrs.get("src"):
                values.append(attrs["src"])
            if tag in ["img", "source"] and attrs.get("srcset"):
                values.extend(
                    candidate.strip().split()[0]
                    for candidate in attrs["srcset"].split(",")
                )
            if tag == "meta" and attrs.get("property") == "og:image":
                values.append(attrs["content"])
            if tag == "img":
                require("alt" in attrs, f"{route}: image missing alt")
                require(
                    bool(attrs.get("width")) and bool(attrs.get("height")),
                    f"{route}: image missing dimensions",
                )
            for value in values:
                target = urlsplit(urljoin(base, value))
                if target.scheme not in ["http", "https"]:
                    continue
                if target.netloc != urlsplit(origin).netloc:
                    if tag == "a":
                        external.add(urljoin(base, value))
                        require(
                            target.scheme == "https",
                            f"{route}: insecure outbound link: {value}",
                        )
                        if attrs.get("target") == "_blank":
                            require(
                                "noopener" in attrs.get("rel", "").split(),
                                f"{route}: new-tab link missing noopener",
                            )
                    continue
                target_file = path_for(directory, target.path)
                require(target_file.is_file(), f"{route}: broken {tag} target: {value}")
                if target.fragment and target.path in pages:
                    require(
                        unquote(target.fragment) in pages[target.path].ids,
                        f"{route}: broken fragment: {value}",
                    )
                if tag == "a" and target.path in pages and owner["indexable"]:
                    target_url = origin + target.path
                    if not value.startswith("#"):
                        require(
                            target_url in canonical_urls,
                            f"{route}: internal link uses noncanonical URL: {value}",
                        )
                    if owner_url != target_url and target_url in canonical_urls:
                        inbound[target_url].add(owner_url)
                        outgoing[owner_url].add(target_url)

    # Font/CSS resources are part of the crawlable public artifact too.
    for file in directory.rglob("*.css"):
        for value in re.findall(r'url\(["\']?([^"\')]+)', file.read_text()):
            if not value.startswith("data:"):
                require(
                    (file.parent / value).is_file(),
                    f"{file}: missing CSS resource: {value}",
                )
    seen = {origin + "/"}
    queue = deque(seen)
    while queue:
        for target in outgoing[queue.popleft()] - seen:
            seen.add(target)
            queue.append(target)
    require(seen == canonical_urls, f"orphan pages: {sorted(canonical_urls - seen)}")
    return {
        "errors": errors,
        "canonical_pages": len(canonical_urls),
        "html_routes": len(pages),
        "inbound_pages": {
            url: len(sources) for url, sources in sorted(inbound.items())
        },
        "outbound_links": sorted(external),
    }


def build():
    OUTPUT.parent.mkdir(exist_ok=True)
    if OUTPUT.is_symlink():
        raise ValueError("Refusing a symlink at the generated website directory")
    with tempfile.TemporaryDirectory(prefix="website-", dir=OUTPUT.parent) as temporary:
        stage = Path(temporary)
        for entry in MANIFEST["pages"]:
            for route in [entry["url"], *entry["aliases"]]:
                target = path_for(stage, route)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(REPO / entry["source"], target)
        for entry in MANIFEST["assets"]:
            target = stage / entry["target"]
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / entry["source"], target)
        report = audit(stage)
        if report["errors"]:
            raise ValueError("\n".join(report["errors"]))
        if OUTPUT.exists():
            shutil.rmtree(OUTPUT)
        shutil.copytree(stage, OUTPUT)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "check"])
    parser.add_argument(
        "--directory",
        type=Path,
        default=OUTPUT,
        help="Directory to check (build always uses .output/website)",
    )
    args = parser.parse_args()
    result = build() if args.command == "build" else audit(args.directory)
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result["errors"]))
