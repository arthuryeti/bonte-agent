import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertAllowedWebsiteUrl, isPublicWebsiteAddress, extractListingIdentity, verifyListingPage, buildVerifiedListingMappings, type WebsiteReader } from "../src/workflows/crm-listing-links.js";

const property = { id: 42, reference: "A-42" };
describe("verified listing link sources", () => {
  it("requires allowed HTTPS public hostnames and rejects credential, private or off-host URLs", () => {
    const allowed = ["listings.bonte.test"];
    assert.equal(assertAllowedWebsiteUrl("https://listings.bonte.test/A-42", allowed).hostname, allowed[0]);
    for (const url of ["http://listings.bonte.test/A-42", "https://evil.test/A-42", "https://listings.bonte.test.evil.test/A-42", "https://user:pass@listings.bonte.test/A-42", "https://127.0.0.1/A-42", "https://localhost/A-42", "https://listings.bonte.test:8443/A-42"]) assert.throws(() => assertAllowedWebsiteUrl(url, allowed));
    for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "2001:db8::1", "2001::1", "2002:7f00:1::"]) assert.equal(isPublicWebsiteAddress(address), false, address);
    assert.equal(isPublicWebsiteAddress("8.8.8.8"), true);
    assert.equal(isPublicWebsiteAddress("2606:4700:4700::1111"), true);
  });

  it("requires explicit exact identity evidence and rejects misleading nearby references", () => {
    assert.equal(verifyListingPage('<meta content="A-42" name="property-reference">', property).verified, true);
    assert.equal(verifyListingPage("<p>Referência: <strong>A-42</strong></p>", property).verified, true);
    assert.equal(verifyListingPage("<p>REF: A-42</p>", property).verified, true);
    assert.equal(verifyListingPage('<meta name="casafari-property-id" content="42">', property).verified, true);
    for (const html of ["<h1>Beautiful A-42</h1>", "<p>Reference: A-420</p>", "<p>Reference: a-42</p>", '<meta name="property-reference" content="A-42"><meta name="casafari-property-id" content="43">', "<p>Reference: A-42 Reference: A-43</p>", '<script>const fake = \'<meta name="property-reference" content="A-42">\';</script>']) assert.equal(verifyListingPage(html, property).verified, false, html);
    assert.deepEqual(extractListingIdentity("<p>Ref: A-42</p>").references, ["A-42"]);
  });

  it("verifies JSON feed destinations and withholds mismatches or off-host redirects", async () => {
    const allowedHosts = ["listings.bonte.test"];
    const sourceUrl = "https://listings.bonte.test/feed.json";
    const read: WebsiteReader = async (url) => {
      if (url === sourceUrl) return { url, body: JSON.stringify([{ reference: "A-42", url: "https://listings.bonte.test/good" }, { reference: "A-42", url: "https://listings.bonte.test/wrong" }, { reference: "A-42", url: "https://listings.bonte.test/redirect" }]) };
      if (url.endsWith("good")) return { url, body: "<p>Reference: A-42</p>" };
      if (url.endsWith("wrong")) return { url, body: "<p>Reference: A-43</p>" };
      return { url: "https://other.test/property", body: "<p>Reference: A-42</p>" };
    };
    const result = await buildVerifiedListingMappings({ sourceUrl, allowedHosts }, [property], read);
    assert.equal(result.mappings.length, 1);
    assert.equal(result.mappings[0].url, "https://listings.bonte.test/good");
    assert.equal(result.rejected.length, 2);
  });

  it("walks bounded sitemap indexes and verifies canonical destination identity", async () => {
    const allowedHosts = ["listings.bonte.test"], sourceUrl = "https://listings.bonte.test/sitemap.xml";
    const read: WebsiteReader = async (url) => {
      if (url === sourceUrl) return { url, body: "<sitemapindex><sitemap><loc>https://listings.bonte.test/properties.xml</loc></sitemap></sitemapindex>" };
      if (url.endsWith("properties.xml")) return { url, body: "<urlset><url><loc>https://listings.bonte.test/old-path</loc></url></urlset>" };
      if (url.endsWith("old-path")) return { url, body: '<link rel="canonical" href="/canonical"><p>Reference: A-42</p>' };
      return { url, body: '<meta name="property-reference" content="A-43">' };
    };
    const result = await buildVerifiedListingMappings({ sourceUrl, allowedHosts }, [property], read);
    assert.equal(result.mappings.length, 0);
    assert.match(result.rejected[0].reason, /Canonical destination/);
    assert.equal(result.coverage.sourceDocuments, 2);
  });
});
