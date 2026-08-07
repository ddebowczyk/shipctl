import assert from "node:assert/strict";
import { test } from "node:test";

import { getPlainMarkdownRenderer, isMarkdownFile } from "../src/markdownRenderer.ts";

// Characterization of the plain renderer. The syntax-highlighting path needs a
// shiki highlighter and a browser, but the renderer's configuration — link
// handling, linkification, typography, HTML safety — is the part a markdown-it
// upgrade can silently change, and all of it is reachable here.

const render = (source: string) => getPlainMarkdownRenderer().render(source);

test("external links open in a new window and drop the opener", () => {
  const html = render("[Pierre](https://pierre.co)");
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.match(html, /href="https:\/\/pierre\.co"/);
});

test("autolinked URLs get the same treatment as explicit links", () => {
  const html = render("<https://pierre.co>");
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("bare URLs and domains are linkified", () => {
  assert.match(render("see https://pierre.co for details"), /<a [^>]*href="https:\/\/pierre\.co"/);
  // Bare domains without a scheme: markdown-it 15 turns this off by default,
  // so the renderer has to ask for it back.
  assert.match(render("see pierre.co for details"), /<a [^>]*href="http:\/\/pierre\.co"/);
});

test("email addresses are linkified as mailto", () => {
  assert.match(render("mail me@example.com please"), /href="mailto:me@example\.com"/);
});

test("raw HTML in markdown is not passed through", () => {
  const html = render("<script>alert(1)</script>\n\nplain");
  assert.ok(!html.includes("<script>"), "raw HTML reached the output");
  assert.match(html, /&lt;script&gt;/);
});

test("typographic replacement is on", () => {
  assert.match(render('"quoted"'), /[“”]/);
  assert.match(render("a -- b"), /–/);
  assert.match(render("etc..."), /…/);
});

test("core markdown constructs still render", () => {
  assert.match(render("# Title"), /<h1>Title<\/h1>/);
  assert.match(render("- one\n- two"), /<ul>[\s\S]*<li>one<\/li>/);
  assert.match(render("`code`"), /<code>code<\/code>/);
  assert.match(render("```js\nlet x = 1;\n```"), /<pre><code class="language-js">/);
  assert.match(render("**bold**"), /<strong>bold<\/strong>/);
});

test("the plain renderer is reused rather than rebuilt", () => {
  assert.equal(getPlainMarkdownRenderer(), getPlainMarkdownRenderer());
});

test("markdown files are recognised by extension, case-insensitively", () => {
  for (const path of ["a/README.md", "b/notes.MARKDOWN", "C.Md"]) {
    assert.equal(isMarkdownFile(path), true, path);
  }
  for (const path of ["a/README.txt", "b/md", "c/markdown", "d.mdx"]) {
    assert.equal(isMarkdownFile(path), false, path);
  }
});
