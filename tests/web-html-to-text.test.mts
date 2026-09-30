// Test harness for the html-to-text conversion used by the web extension.
//
// extensions/web/index.ts converts fetched HTML to readable text via
// `convert` from html-to-text. The converter function `htmlToReadable` is not
// exported, so this file replicates its exact options (kept in sync manually)
// and asserts the output properties that must survive dependency upgrades.
//
// Run: node tests/web-html-to-text.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { convert as htmlToText } from "html-to-text";

// Mirrors htmlToReadable in extensions/web/index.ts
function htmlToReadable(html: string, baseUrl?: string): string {
	return htmlToText(html, {
		wordwrap: false,
		selectors: [
			{ selector: "script", format: "skip" },
			{ selector: "style", format: "skip" },
			{ selector: "noscript", format: "skip" },
			{ selector: "nav", format: "skip" },
			{ selector: "footer", format: "skip" },
			{ selector: "form", format: "skip" },
			{ selector: "svg", format: "skip" },
			{ selector: "img", format: "skip" },
			{ selector: "a", options: { baseUrl, ignoreHref: false, hideLinkHrefIfSameAsText: true } },
		],
	}).trim();
}

test("skipped elements contribute no text", () => {
	const html = `
		<html><body>
			<script>var x = "script-noise";</script>
			<style>.css { color: red; }</style>
			<nav>nav-noise</nav>
			<form>form-noise</form>
			<footer>footer-noise</footer>
			<main><p>real content</p></main>
		</body></html>
	`;
	const out = htmlToReadable(html);
	assert.match(out, /real content/);
	assert.doesNotMatch(out, /script-noise|css|nav-noise|form-noise|footer-noise/);
});

test("links keep their text and render the href once", () => {
	const html = `<p>see <a href="https://example.com/page">the docs</a></p>`;
	const out = htmlToReadable(html, "https://example.com");
	assert.match(out, /the docs/);
	assert.match(out, /https:\/\/example\.com\/page/);
	assert.equal(out.match(/https:\/\/example\.com\/page/g)?.length, 1);
});

test("hideLinkHrefIfSameAsText suppresses href equal to link text", () => {
	const html = `<p>visit <a href="https://example.com">https://example.com</a></p>`;
	const out = htmlToReadable(html, "https://example.com");
	assert.match(out, /https:\/\/example\.com/);
	assert.equal(out.match(/https:\/\/example\.com/g)?.length, 1);
});

test("HTML entities are decoded", () => {
	const html = `<p>Fish &amp; Chips &lt;3</p>`;
	const out = htmlToReadable(html);
	assert.match(out, /Fish & Chips <3/);
});

test("wordwrap false keeps sentences on one line", () => {
	const long =
		"This is a deliberately long sentence with many words in it so that any " +
		"word wrapping at the default eighty columns would split it across lines.";
	const html = `<p>${long}</p>`;
	const out = htmlToReadable(html);
	assert.ok(out.includes(long), `sentence not intact:\n${out}`);
});