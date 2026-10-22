"""Failure-injection checks for the publication boundary and crawl validator."""

import shutil
from pathlib import Path
import tempfile
import unittest

import importlib.util

# Avoid shadowing Python's built-in site module.
spec = importlib.util.spec_from_file_location(
    "website", Path(__file__).with_name("site.py")
)
website = importlib.util.module_from_spec(spec)
spec.loader.exec_module(website)


class WebsiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        website.build()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "site"
        shutil.copytree(website.OUTPUT, self.root)
        self.addCleanup(self.temporary.cleanup)

    def edit(self, file, old, new):
        path = self.root / file
        text = path.read_text()
        self.assertIn(old, text)
        path.write_text(text.replace(old, new))

    def errors(self):
        return "\n".join(website.audit(self.root)["errors"])

    def test_build_contains_only_manifest_files_and_preserves_aliases(self):
        self.assertEqual(self.errors(), "")
        expected = {asset["target"] for asset in website.MANIFEST["assets"]}
        for page in website.MANIFEST["pages"]:
            for route in [page["url"], *page["aliases"]]:
                expected.add(
                    str(website.path_for(self.root, route).relative_to(self.root))
                )
        actual = {
            str(p.relative_to(self.root)) for p in self.root.rglob("*") if p.is_file()
        }
        self.assertEqual(actual, expected)
        self.assertNotIn("plans", {p.parts[0] for p in map(Path, actual)})

    def test_broken_fragment_fails(self):
        self.edit("index.html", "#how-it-works", "#missing-section")
        self.assertIn("broken fragment", self.errors())

    def test_broken_asset_fails(self):
        (self.root / "assets/still-logo.png").unlink()
        self.assertIn("broken link target", self.errors())

    def test_noncanonical_internal_link_fails(self):
        self.edit("guides.html", 'href="/setup/"', 'href="/setup.html"')
        self.assertIn("internal link uses noncanonical URL", self.errors())

    def test_alias_drift_fails(self):
        with (self.root / "privacy/index.html").open("a") as file:
            file.write("<!-- accidental drift -->")
        self.assertIn("alias content differs", self.errors())

    def test_checkout_noindex_remains_crawlable(self):
        with (self.root / "robots.txt").open("a") as file:
            file.write("\nDisallow: /qa/\n")
        self.assertIn("checkout noindex discovery must stay crawlable", self.errors())

    def test_checkout_cannot_enter_sitemap(self):
        self.edit(
            "sitemap.xml",
            "</urlset>",
            "<url><loc>https://stillapp.fit/qa/success.html</loc></url></urlset>",
        )
        self.assertIn("sitemap: must contain exactly", self.errors())

    def test_invalid_structured_data_fails(self):
        self.edit(
            "guides.html", '"@context": "https://schema.org",', '"@context": invalid,'
        )
        self.assertIn("invalid HTML/JSON-LD", self.errors())

    def test_missing_title_is_a_finding(self):
        self.edit("guides.html", "<title>", "<removed-title>")
        self.assertIn("needs one nonempty title", self.errors())

    def test_unlisted_html_fails(self):
        (self.root / "internal-plan.html").write_text("<h1>Private plan</h1>")
        self.assertIn("unexpected public HTML", self.errors())


if __name__ == "__main__":
    unittest.main()
